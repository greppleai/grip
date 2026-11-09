import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import * as typebox from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import { authorize, parsePolicy, readPolicy } from "../../../extensions/host-cli/policy.ts";
import { packageOfficialExtension } from "../../../scripts/official-extensions.ts";
import type { ExecResult } from "../src/core/exec.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "../src/core/extensions/types.ts";
import { decodeOfficialArtifact } from "../src/core/official-artifact.ts";
import { truncateHead } from "../src/core/tools/truncate.ts";

const directories: string[] = [];
const extensionRoot = fileURLToPath(new URL("../../../extensions/host-cli/", import.meta.url));
const source = `version: 1
commands:
  - name: kubectl
    timeoutMs: 5000
    allow:
      - [get, [pods, deployments], --namespace, [staging, production]]
      - [get, pods, --namespace, staging, -o, [json, wide]]
`;

afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temporaryDirectory() {
	const path = await mkdtemp(join(tmpdir(), "grip-host-cli-"));
	directories.push(path);
	return path;
}

test("matches only complete exact argv templates and copies authorized input", () => {
	const command = parsePolicy(source)[0];
	const input = ["get", "pods", "--namespace", "staging"];
	expect(authorize(command, input)).toEqual(input);
	expect(authorize(command, input)).not.toBe(input);
	expect(authorize(command, ["get", "deployments", "--namespace", "production"])).toHaveLength(4);
	expect(authorize(command, [...input, "-o", "json"])).toHaveLength(6);
	const noArgs = parsePolicy("version: 1\ncommands: [{name: status, allow: [[]]}]")[0];
	expect(authorize(noArgs, [])).toEqual([]);
});

test.each([
	["delete", "pods", "--namespace", "staging"],
	["exec", "pods", "--namespace", "staging"],
	["get", "secrets", "--namespace", "staging"],
	["get", "pods", "--namespace", "other"],
	["get", "pods", "--namespace=staging"],
	["get", "pods", "--namespace", "staging", "--raw=/api"],
	["get", "pods", "--namespace", "staging", "--kubeconfig", "/tmp/evil"],
	["get", "pods", "--namespace", "staging", "--server=https://evil"],
	["get", "pods", "--namespace", "staging", "-f", "/tmp/evil"],
	["get", "pods", "--namespace", "staging", "--namespace", "production"],
	["get", "pods", "--namespace", "staging", "--", "sh"],
	["get", "pods", "--namespace", "staging; touch /tmp/pwned"],
	["get", "pods", "--namespace", "$(id)"],
	["get", "pods", "--namespace", "staging", "|", "sh"],
	["get pods --namespace staging"],
	["--namespace", "staging", "get", "pods"],
	["get", "pods"],
	[],
])("denies unlisted argv: %j", (...args) => {
	expect(() => authorize(parsePolicy(source)[0], args)).toThrow(/Denied/);
});

test.each([
	"",
	"version: 2\ncommands: []",
	"version: 1\ncommands: {}",
	"version: 1\ncommands: []\nunknown: true",
	"version: 1\nversion: 1\ncommands: []",
	"version: 1\ncommands: []\n---\nversion: 1",
	"version: 1\ncommands: &commands [*commands]",
	source.replace("name: kubectl", "name: kubectl\n    executable: /usr/local/bin/kubectl"),
	source.replace("name: kubectl", "name: bash"),
	source.replace("name: kubectl", "name: ../kubectl"),
	source.replace("timeoutMs: 5000", "timeoutMs: 0"),
	source.replace("timeoutMs: 5000", "timeoutMs: 120001"),
	source.replace("timeoutMs: 5000", "timeoutMs: 1.5"),
	source.replace("timeoutMs: 5000", "timeuotMs: 5000"),
	source.replace("[json, wide]", "[]"),
	source.replace("[json, wide]", "[true]"),
	source.replace("[json, wide]", "{pattern: .*}"),
])("rejects malformed or ambiguous policy %#", (yaml) => {
	expect(() => parsePolicy(yaml)).toThrow();
});

test("rejects duplicate tools, oversized templates, invalid runtime input; no policy grants nothing", async () => {
	const command = { name: "kubectl", allow: [["get"]] };
	expect(() => parsePolicy(JSON.stringify({ version: 1, commands: [command, command] }))).toThrow(/duplicate/);
	expect(() =>
		parsePolicy(JSON.stringify({ version: 1, commands: [{ ...command, allow: [Array(65).fill("get")] }] })),
	).toThrow();
	expect(() => authorize(parsePolicy(source)[0], "get pods")).toThrow();
	expect(() => authorize(parsePolicy(source)[0], [1])).toThrow();
	expect(parsePolicy("version: 1\ncommands: []")).toEqual([]);
	expect(await readPolicy(join(await temporaryDirectory(), "missing.yaml"))).toEqual([]);
});

test("host policy file rejects symlinks, oversized files, non-files and unsafe Unix permissions", async () => {
	const directory = await temporaryDirectory();
	const policy = join(directory, "policy.yaml");
	await writeFile(policy, source, { mode: 0o600 });
	expect(await readPolicy(policy)).toHaveLength(1);
	await writeFile(policy, " ".repeat(256 * 1024 + 1));
	await expect(readPolicy(policy)).rejects.toThrow(/256 KiB/);
	await writeFile(policy, source);
	await expect(readPolicy(directory)).rejects.toThrow(/regular file/);
	if (process.platform !== "win32") {
		await chmod(policy, 0o666);
		await expect(readPolicy(policy)).rejects.toThrow(/writable/);
		await chmod(policy, 0o600);
		await symlink(policy, join(directory, "link.yaml"));
		await expect(readPolicy(join(directory, "link.yaml"))).rejects.toThrow();
	}
});

test("deterministic official artifact loads outside checkout and proxies only authorized host argv", async () => {
	const first = await packageOfficialExtension(extensionRoot, "a".repeat(40));
	const second = await packageOfficialExtension(extensionRoot, "a".repeat(40));
	expect(first.bytes.equals(second.bytes)).toBe(true);
	const artifact = decodeOfficialArtifact(first.bytes, first.release);
	expect(first.release.manifest.grip.official.id).toBe("host-cli");
	const notices = artifact.files.find((file) => file.path === "THIRD-PARTY-NOTICES.txt")!;
	expect(Buffer.from(notices.base64, "base64").toString()).toContain("yaml");
	const directory = await temporaryDirectory();
	for (const file of artifact.files) {
		const path = join(directory, "installed", file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, Buffer.from(file.base64, "base64"));
	}
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		virtualModules: { "@greppleai/grip": { getAgentDir: () => directory, truncateHead }, typebox },
	});
	const factory = await jiti.import<ExtensionFactory>(join(directory, "installed", "index.js"), { default: true });
	const tools: ToolDefinition[] = [];
	const api = { registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI;
	await factory(api);
	expect(tools).toHaveLength(0);
	const policyPath = join(directory, "host-cli.yaml");
	await writeFile(policyPath, source, { mode: 0o600 });
	await factory(api);
	expect(tools.map((tool) => tool.name)).toEqual(["kubectl"]);
	const tool = tools[0];
	const exec = vi
		.fn<ExtensionContext["execHostProcess"]>()
		.mockResolvedValue({ stdout: "\x1b[31mpods\x1b[0m", stderr: "warning", code: 0, killed: false });
	const ctx = { isSandbox: () => true, execHostProcess: exec } as unknown as ExtensionContext;
	const args = ["get", "pods", "--namespace", "staging"];
	const controller = new AbortController();
	const run = () => tool.execute("1", { args }, controller.signal, undefined, ctx);
	const result = await run();
	expect(result.content).toEqual([{ type: "text", text: "pods\nwarning" }]);
	expect(exec).toHaveBeenCalledExactlyOnceWith("kubectl", args, {
		question: expect.stringContaining("Output will be returned to the agent"),
		signal: controller.signal,
		timeout: 5000,
	});
	await expect(tool.execute("2", { args: [...args, "--raw=/api"] }, undefined, undefined, ctx)).rejects.toThrow(
		/Denied/,
	);
	expect(exec).toHaveBeenCalledTimes(1);
	await expect(tool.execute("3", { args }, undefined, undefined, { ...ctx, isSandbox: () => false })).rejects.toThrow(
		/sandbox/,
	);
	expect(exec).toHaveBeenCalledTimes(1);
	for (const failure of [
		new Error("Approval denied"),
		new Error("No verified host mapping"),
		new Error("Approval expired"),
	]) {
		exec.mockRejectedValueOnce(failure);
		await expect(run()).rejects.toThrow(failure.message);
	}
	for (const failure of [
		{ stdout: "", stderr: "forbidden", code: 1, killed: false },
		{ stdout: "", stderr: "spawn failed", code: null, killed: false },
		{ stdout: "", stderr: "timeout", code: null, killed: true },
	] satisfies ExecResult[]) {
		exec.mockResolvedValueOnce(failure);
		await expect(run()).rejects.toThrow(/failed/);
	}
	exec.mockResolvedValueOnce({ stdout: "row\n".repeat(3000), stderr: "", code: 0, killed: false });
	const large = await run();
	expect(large.details).toEqual({ exitCode: 0, truncated: true });
	expect(JSON.stringify(large)).toContain("not saved");
	expect(JSON.stringify(large).length).toBeLessThan(51000);
	const beforeRevoke = exec.mock.calls.length;
	await writeFile(policyPath, "version: 1\ncommands: []");
	await expect(run()).rejects.toThrow(/no longer allowed/);
	await writeFile(policyPath, "invalid: yaml");
	await expect(run()).rejects.toThrow();
	await rm(policyPath);
	await expect(run()).rejects.toThrow(/no longer allowed/);
	await writeFile(policyPath, source);
	controller.abort();
	await expect(run()).rejects.toThrow(/cancelled/);
	expect(exec).toHaveBeenCalledTimes(beforeRevoke);
	expect(await readFile(join(directory, "installed", "README.md"), "utf8")).toContain("RBAC");
});
