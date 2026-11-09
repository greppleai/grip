import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import * as typebox from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import { executeHostCli } from "../../../extensions/host-cli/execute.ts";
import { authorize, parsePolicy, readPolicy } from "../../../extensions/host-cli/policy.ts";
import { packageOfficialExtension } from "../../../scripts/official-extensions.ts";
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
	vi.unstubAllEnvs();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temporaryDirectory() {
	const path = await mkdtemp(join(tmpdir(), "grip-host-cli-"));
	directories.push(path);
	return path;
}

test("allows combinations, reordering and repetition of flags after an exact prefix", () => {
	const command = parsePolicy(`version: 1
commands:
  - name: git
    allow:
      - args: [status, --short]
        flags: [--branch]
      - args: [diff]
        flags: [--cached, --check]
      - args: [show, [HEAD, main]]
        flags: [-v]
      - args: [version]
        flags: []
`)[0];
	for (const args of [
		["status", "--short"],
		["status", "--short", "--branch"],
		["diff"],
		["diff", "--cached"],
		["diff", "--check"],
		["diff", "--cached", "--check"],
		["diff", "--check", "--cached", "--check"],
		["show", "HEAD", "-v", "-v"],
		["show", "main"],
		["version"],
		["diff", ...Array<string>(63).fill("--check")],
	]) {
		expect(authorize(command, args)).toEqual(args);
		expect(authorize(command, args)).not.toBe(args);
	}
	for (const args of [
		[],
		["status"],
		["status", "--branch", "--short"],
		["--cached", "diff"],
		["diff", "--raw"],
		["diff", "--cached=true"],
		["diff", "--cached --check"],
		["diff", "--", "--cached"],
		["diff", "HEAD"],
		["diff", "--check", "true"],
		["diff", "--check\0"],
		["diff", ...Array<string>(64).fill("--check")],
		["show", "other"],
		["show", "HEAD", "-vv"],
		["version", "--check"],
	]) {
		expect(() => authorize(command, args)).toThrow(/Denied/);
	}
});

test.each([
	{ args: ["diff"] },
	{ flags: ["--check"] },
	{ args: "diff", flags: [] },
	{ args: ["diff"], flags: "--check" },
	{ args: ["diff"], flags: [true] },
	{ args: ["diff"], flags: ["--check=true"] },
	{ args: ["diff"], flags: ["--"] },
	{ args: ["diff"], flags: ["HEAD"] },
	{ args: ["diff"], flags: ["--check\n"] },
	{ args: ["diff"], flags: [{ text: true }] },
	{ args: Array(65).fill("diff"), flags: [] },
	{ args: ["diff"], flags: Array(257).fill("--check") },
	{ args: ["diff"], flags: [], unknown: true },
])("rejects malformed flag rules: %j", (rule) => {
	expect(() => parsePolicy(JSON.stringify({ version: 1, commands: [{ name: "git", allow: [rule] }] }))).toThrow();
});

test.each(["*", "--*"])("matches explicitly granted flag wildcard %s", (wildcard) => {
	const command = parsePolicy(`version: 1
commands:
  - name: git
    allow:
      - args: [diff]
        flags: ["${wildcard}", -v]
`)[0];
	for (const args of [
		["diff"],
		["diff", "--cached", "--check", "--cached"],
		["diff", "--format=json"],
		["diff", "--output=path with spaces"],
		["diff", "-v", "--check"],
		["diff", `--${"x".repeat(4094)}`],
	]) {
		expect(authorize(command, args)).toEqual(args);
	}
	for (const arg of ["-q", "-vv", "-ojson"]) {
		if (wildcard === "*") expect(authorize(command, ["diff", arg])).toEqual(["diff", arg]);
		else expect(() => authorize(command, ["diff", arg])).toThrow(/Denied/);
	}
	for (const args of [
		[],
		["status", "--cached"],
		["--cached", "diff"],
		["diff", "HEAD"],
		["diff", "*"],
		["diff", "--*"],
		["diff", "--format", "json"],
		["diff", "-"],
		["diff", "--"],
		["diff", "---check"],
		["diff", "--check\0"],
		["diff", "--check\n"],
		["diff", "--check\t"],
		["diff", `--${"x".repeat(4095)}`],
		["diff", ...Array<string>(64).fill("--check")],
	]) {
		expect(() => authorize(command, args)).toThrow(/Denied/);
	}
});

test.each(["--safe-*", "-*"])("rejects unsupported wildcard %s", (wildcard) => {
	expect(() =>
		parsePolicy(`version: 1\ncommands: [{name: git, allow: [{args: [diff], flags: ["${wildcard}"]}]}]`),
	).toThrow();
});

test("wildcards in exact templates remain literal", () => {
	const command = parsePolicy('version: 1\ncommands: [{name: git, allow: [[diff, "*"], [status, "--*"]]}]')[0];
	expect(authorize(command, ["diff", "*"])).toEqual(["diff", "*"]);
	expect(authorize(command, ["status", "--*"])).toEqual(["status", "--*"]);
	expect(() => authorize(command, ["diff", "--check"])).toThrow(/Denied/);
	expect(() => authorize(command, ["status", "--short"])).toThrow(/Denied/);
});

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

test("Git example permits arbitrary commit messages and non-force pushes but denies force variants and config overrides", () => {
	const command = parsePolicy(`version: 1
commands:
  - name: git
    timeoutMs: 120000
    allow:
      - [commit, -m, {text: true}]
      - [push, origin, HEAD:refs/heads/main]
`)[0];
	expect(authorize(command, ["commit", "-m", "Update files"])).toEqual(["commit", "-m", "Update files"]);
	expect(authorize(command, ["commit", "-m", "Fix issue"])).toHaveLength(3);
	for (const message of [
		"",
		"Any commit message",
		"subject\n\nbody\twith unicode: café",
		"--force-with-lease",
		"$(touch unexpected); git push --force",
		"x".repeat(65536),
	]) {
		expect(authorize(command, ["commit", "-m", message])).toEqual(["commit", "-m", message]);
	}
	for (const args of [
		["commit", "-m"],
		["commit", "-m", "message", "--amend"],
		["commit", "-m", "nul\0message"],
		["commit", "-m", "x".repeat(65537)],
	]) {
		expect(() => authorize(command, args)).toThrow(/Denied/);
	}
	const push = ["push", "origin", "HEAD:refs/heads/main"];
	expect(authorize(command, push)).toEqual(push);
	for (const args of [
		["status"],
		["commit", "--amend", "-m", "Update files"],
		["push"],
		["push", "origin"],
		["push", "origin", "+HEAD:refs/heads/main"],
		["push", "origin", "HEAD:refs/heads/other"],
		["-c", "alias.publish=push --force", "publish"],
		["-C", "/tmp/other", ...push],
	])
		expect(() => authorize(command, args)).toThrow(/Denied/);
	for (const flag of [
		"-f",
		"--force",
		"--force-with-lease",
		"--force-with-lease=refs/heads/main",
		"--mirror",
		"--delete",
	]) {
		expect(() => authorize(command, ["push", flag, ...push.slice(1)])).toThrow(/Denied/);
		expect(() => authorize(command, [...push, flag])).toThrow(/Denied/);
	}
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
	source.replace("[json, wide]", "{text: false}"),
	source.replace("[json, wide]", '{text: "true"}'),
	source.replace("[json, wide]", "{text: null}"),
	source.replace("[json, wide]", "{text: true, pattern: .*}"),
	source.replace("[json, wide]", "[json, {text: true}]"),
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

test.each([false, true])("host CLI availability follows sandbox attachment (initially %s)", async (initialSandbox) => {
	const directory = await temporaryDirectory();
	await writeFile(join(directory, "host-cli.yaml"), source, { mode: 0o600 });
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		virtualModules: { "@greppleai/grip": { getAgentDir: () => directory, truncateHead }, typebox },
	});
	const factory = await jiti.import<ExtensionFactory>(join(extensionRoot, "index.ts"), { default: true });
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools: ToolDefinition[] = [];
	let active = ["bash", "kubectl", "read"];
	const setActiveTools = vi.fn((names: string[]) => {
		active = names;
	});
	await factory({
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => active,
		setActiveTools,
	} as unknown as ExtensionAPI);
	let sandbox = initialSandbox;
	const ctx = { isSandbox: () => sandbox } as unknown as ExtensionContext;
	await handlers.get("session_start")!({}, ctx);
	expect(active).toEqual(initialSandbox ? ["bash", "kubectl", "read"] : ["bash", "read"]);

	for (const event of ["before_agent_start", "turn_start"]) {
		sandbox = false;
		await handlers.get(event)!({}, ctx);
		expect(active).toEqual(["bash", "read"]);
		const updateCount = setActiveTools.mock.calls.length;
		await handlers.get(event)!({}, ctx);
		expect(setActiveTools).toHaveBeenCalledTimes(updateCount);
		await expect(tools[0].execute("detached", { args: [] }, undefined, undefined, ctx)).rejects.toThrow(/sandbox/);

		active.push("other-extension");
		sandbox = true;
		await handlers.get(event)!({}, ctx);
		expect(active).toEqual(["bash", "read", "other-extension", "kubectl"]);
		await handlers.get(event)!({}, ctx);
		expect(active).toEqual(["bash", "read", "other-extension", "kubectl"]);
		active = ["bash", "read", "kubectl"];
	}

	sandbox = false;
	await handlers.get("session_start")!({}, ctx);
	expect(active).toEqual(["bash", "read"]);
});

test.skipIf(process.platform === "win32")(
	"packaged tools execute allowed argv without any approval UI or approved-host API",
	async () => {
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
		const api = { registerTool: (tool: ToolDefinition) => tools.push(tool), on: vi.fn() } as unknown as ExtensionAPI;
		await factory(api);
		expect(tools).toHaveLength(0);
		const policyPath = join(directory, "host-cli.yaml");
		await writeFile(policyPath, source, { mode: 0o600 });
		await factory(api);
		expect(tools.map((tool) => tool.name)).toEqual(["kubectl"]);
		const tool = tools[0];
		expect(tool.description).toContain("without approval");
		const bin = join(directory, "bin");
		await mkdir(bin);
		const fixturePath = join(bin, "kubectl");
		const fixture = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = fs.existsSync("mode") ? fs.readFileSync("mode", "utf8") : "";
if (mode === "failure") { console.error("forbidden"); process.exit(7); }
if (mode === "large") { process.stdout.write("row\\n".repeat(3000)); }
else { console.log("\\x1b[31mpods\\x1b[0m"); console.error("warning"); }
`;
		await writeFile(fixturePath, fixture, { mode: 0o755 });
		vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
		const approval = vi.fn(() => {
			throw new Error("Approval must not be requested");
		});
		const mapping = vi.fn(async () => directory);
		const operations = {
			cwd: "/workspace",
			mapWorkspaceDirectoryToHost: mapping,
		} as unknown as ExtensionContext["toolOperations"];
		const ctx = {
			isSandbox: () => true,
			hasUI: false,
			toolOperations: operations,
			execHostProcess: approval,
			execHostCommand: approval,
			ui: { select: approval, confirm: approval },
		} as unknown as ExtensionContext;
		const args = ["get", "pods", "--namespace", "staging"];
		const controller = new AbortController();
		const run = () => tool.execute("1", { args }, controller.signal, undefined, ctx);
		const result = await run();
		expect(result.content).toEqual([{ type: "text", text: "pods\n\nwarning" }]);
		expect(mapping).toHaveBeenCalledWith("/workspace");
		const callsPath = join(directory, "calls");
		const firstCalls = await readFile(callsPath, "utf8");
		expect(firstCalls).toBe(`${JSON.stringify(args)}\n`);
		await expect(tool.execute("2", { args: [...args, "--raw=/api"] }, undefined, undefined, ctx)).rejects.toThrow(
			/Denied/,
		);
		await expect(
			tool.execute("3", { args }, undefined, undefined, { ...ctx, isSandbox: () => false }),
		).rejects.toThrow(/sandbox/);
		await expect(
			tool.execute("4", { args }, undefined, undefined, {
				...ctx,
				toolOperations: {} as ExtensionContext["toolOperations"],
			}),
		).rejects.toThrow(/mapping/);
		mapping.mockRejectedValueOnce(new Error("No verified host mapping"));
		await expect(run()).rejects.toThrow(/mapping/);
		expect(await readFile(callsPath, "utf8")).toBe(firstCalls);
		await writeFile(join(directory, "mode"), "failure");
		await expect(run()).rejects.toThrow(/exit 7/);
		await writeFile(join(directory, "mode"), "large");
		const large = await run();
		expect(large.details).toEqual({ exitCode: 0, truncated: true });
		expect(JSON.stringify(large)).toContain("not saved");
		expect(JSON.stringify(large).length).toBeLessThan(51000);
		await writeFile(join(directory, "mode"), "");
		await writeFile(policyPath, `${source}      - [commit, -m, {text: true}]\n`);
		const message = "subject\n\n$(touch unexpected); --force-with-lease";
		const textArgs = ["commit", "-m", message];
		await tool.execute("5", { args: textArgs }, undefined, undefined, ctx);
		expect((await readFile(callsPath, "utf8")).endsWith(`${JSON.stringify(textArgs)}\n`)).toBe(true);
		await expect(readFile(join(directory, "unexpected"))).rejects.toThrow();
		await writeFile(policyPath, `${source}      - args: [version]\n        flags: [--client, --short]\n`);
		const flagArgs = ["version", "--short", "--client", "--short"];
		await tool.execute("6", { args: flagArgs }, undefined, undefined, ctx);
		expect((await readFile(callsPath, "utf8")).endsWith(`${JSON.stringify(flagArgs)}\n`)).toBe(true);
		const beforeRevoke = await readFile(callsPath, "utf8");
		await expect(tool.execute("7", { args: [...flagArgs, "--unknown"] }, undefined, undefined, ctx)).rejects.toThrow(
			/Denied/,
		);
		expect(await readFile(callsPath, "utf8")).toBe(beforeRevoke);
		await writeFile(policyPath, "version: 1\ncommands: []");
		await expect(run()).rejects.toThrow(/no longer allowed/);
		await writeFile(policyPath, "invalid: yaml");
		await expect(run()).rejects.toThrow();
		await rm(policyPath);
		await expect(run()).rejects.toThrow(/no longer allowed/);
		await writeFile(policyPath, source);
		controller.abort();
		await expect(run()).rejects.toThrow(/cancelled/);
		expect(await readFile(callsPath, "utf8")).toBe(beforeRevoke);
		expect(approval).not.toHaveBeenCalled();
		expect(await readFile(join(directory, "installed", "README.md"), "utf8")).toContain("RBAC");
	},
);

test("host runner preserves argv without a shell and reports missing executables", async () => {
	const cwd = await temporaryDirectory();
	const literal = "$(touch unexpected); | > unexpected";
	const result = await executeHostCli(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal], {
		cwd,
		signal: undefined,
		timeoutMs: 5000,
	});
	expect(result).toEqual({ stdout: literal, stderr: "", code: 0, killed: false });
	await expect(readFile(join(cwd, "unexpected"))).rejects.toThrow();
	const missing = await executeHostCli(join(cwd, "missing"), [], { cwd, signal: undefined, timeoutMs: 5000 });
	expect(missing.code).toBeNull();
	expect(missing.stderr).toContain("ENOENT");
});

test("host runner enforces timeout, cancellation, and output capture bounds", async () => {
	const cwd = await temporaryDirectory();
	const timed = await executeHostCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		cwd,
		signal: undefined,
		timeoutMs: 50,
	});
	expect(timed.code).toBeNull();
	expect(timed.killed).toBe(true);
	const controller = new AbortController();
	const running = executeHostCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		cwd,
		signal: controller.signal,
		timeoutMs: 5000,
	});
	controller.abort();
	expect((await running).killed).toBe(true);
	const overflow = await executeHostCli(
		process.execPath,
		["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
		{ cwd, signal: undefined, timeoutMs: 5000 },
	);
	expect(overflow.code).toBeNull();
	expect(overflow.stdout.length).toBeLessThanOrEqual(1024 * 1024);
	expect(overflow.stderr).toContain("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
});
