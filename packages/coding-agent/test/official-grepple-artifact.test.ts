import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { afterEach, expect, test } from "vitest";
import { packageOfficialExtension } from "../../../scripts/official-extensions.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/core/extensions/types.ts";
import { decodeOfficialArtifact, type OfficialArtifactFile } from "../src/core/official-artifact.ts";
import { loadSkills } from "../src/core/skills.ts";

const directories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const greppleRoot = join(repositoryRoot, "extensions", "grepple");

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function artifactText(files: OfficialArtifactFile[], path: string): string {
	const file = files.find((candidate) => candidate.path === path);
	expect(file, `artifact should contain ${path}`).toBeDefined();
	return Buffer.from(file!.base64, "base64").toString("utf8");
}

function harness() {
	const handlers = new Map<string, unknown>();
	const commands: string[] = [];
	const factories: ExtensionFactory[] = [];
	let active = ["read", "grep", "edit", "write", "grepple", "other"];
	const api = {
		on: ((event: string, handler: unknown) => {
			handlers.set(event, handler);
		}) as ExtensionAPI["on"],
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerJobFactory: (factory: ExtensionFactory) => {
			factories.push(factory);
		},
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => {
			active = tools;
		},
	} satisfies Pick<
		ExtensionAPI,
		"on" | "registerCommand" | "registerJobFactory" | "getActiveTools" | "setActiveTools"
	>;
	return { api: api as unknown as ExtensionAPI, handlers, commands, factories, active: () => active };
}

test("packages and loads the actual Grepple artifact with parent and job hooks", async () => {
	const first = await packageOfficialExtension(greppleRoot, "a".repeat(40));
	const second = await packageOfficialExtension(greppleRoot, "a".repeat(40));
	expect(first.bytes.equals(second.bytes)).toBe(true);
	expect(first.bytes.readUInt32LE(4)).toBe(0);
	const sourcePackage = JSON.parse(await readFile(join(greppleRoot, "package.json"), "utf8"));
	expect(sourcePackage.license).toBe("MIT");
	expect(sourcePackage.engines.grip).toMatch(/^>=0\.3\.0 <\d+\.\d+\.\d+$/);
	expect(first.release.manifest).toMatchObject({
		name: "@grip-extensions/grepple",
		version: sourcePackage.version,
		engines: sourcePackage.engines,
		grip: { official: { id: "grepple", displayName: "Grepple" }, extensions: ["index.js"] },
	});
	const artifact = decodeOfficialArtifact(first.bytes, first.release);
	expect(artifact.files.map((file) => file.path)).toEqual([
		"LICENSE",
		"README.md",
		"THIRD-PARTY-NOTICES.txt",
		"index.js",
		"package.json",
	]);
	expect(artifactText(artifact.files, "THIRD-PARTY-NOTICES.txt")).toBe("");
	expect(JSON.parse(artifactText(artifact.files, "package.json"))).toEqual(first.release.manifest);
	for (const path of ["LICENSE", "README.md"]) {
		expect(artifactText(artifact.files, path)).toBe(await readFile(join(greppleRoot, path), "utf8"));
	}

	const target = await mkdtemp(join(tmpdir(), "grip-grepple-artifact-"));
	directories.push(target);
	for (const file of artifact.files) {
		const path = join(target, file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, Buffer.from(file.base64, "base64"));
	}
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		virtualModules: { "@greppleai/grip": { getAgentDir: () => target } },
	});
	const factory = await jiti.import<ExtensionFactory>(join(target, "index.js"), { default: true });
	const parent = harness();
	await factory(parent.api);
	expect(parent.commands).toEqual(["grepple-install"]);
	expect(parent.factories).toHaveLength(1);
	const child = harness();
	await parent.factories[0](child.api);
	expect(child.commands).toEqual([]);
	expect(child.factories).toEqual([]);

	let backendCalls = 0;
	const context = {
		cwd: target,
		isSandbox: () => false,
		getToolBackendInfo: () => ({ type: "local", cwd: target }),
		ui: { notify: () => {} } as unknown as ExtensionContext["ui"],
		execToolBackend: async (command: string) => {
			backendCalls++;
			if (command.includes("setup grip")) {
				const directory = join(target, "skills", "grepple-test");
				await mkdir(directory, { recursive: true });
				await writeFile(
					join(directory, "SKILL.md"),
					"---\nname: grepple-test\ndescription: Test Grepple workflow\n---\nUse Grepple.\n",
				);
			}
			return {
				exitCode: 0,
				cancelled: false,
				truncated: false,
				output: JSON.stringify({ blocked: true, reason: "Use Grepple" }),
			};
		},
	} satisfies Pick<ExtensionContext, "cwd" | "execToolBackend" | "isSandbox" | "getToolBackendInfo" | "ui">;
	const extensionContext = context as unknown as ExtensionContext;
	for (const instance of [parent, child]) {
		expect([...instance.handlers.keys()]).toEqual([
			"session_start",
			"before_agent_start",
			"tool_call",
			...(instance === parent ? ["resources_discover"] : []),
		]);
		const start = instance.handlers.get("session_start") as ExtensionHandler<SessionStartEvent>;
		await start({ type: "session_start", reason: "startup" }, extensionContext);
		expect(instance.active()).toEqual(["bash", "other"]);
		if (instance === parent) {
			expect(loadSkills({ cwd: target, agentDir: target, skillPaths: [], includeDefaults: true }).skills).toEqual(
				[],
			);
			const discover = instance.handlers.get("resources_discover") as ExtensionHandler<
				ResourcesDiscoverEvent,
				ResourcesDiscoverResult
			>;
			const discovered = await discover(
				{ type: "resources_discover", reason: "startup", cwd: target },
				extensionContext,
			);
			expect(discovered).toEqual({ skillPaths: [join(target, "skills")] });
			const loaded = loadSkills({
				cwd: target,
				agentDir: target,
				skillPaths: discovered?.skillPaths ?? [],
				includeDefaults: false,
			});
			expect(loaded.diagnostics).toEqual([]);
			expect(loaded.skills.map((skill) => skill.name)).toEqual(["grepple-test"]);
			expect(
				await discover({ type: "resources_discover", reason: "reload", cwd: target }, extensionContext),
			).toEqual({ skillPaths: [join(target, "skills")] });
		}
		const prompt = instance.handlers.get("before_agent_start") as ExtensionHandler<
			BeforeAgentStartEvent,
			BeforeAgentStartEventResult
		>;
		const result = await prompt(
			{
				type: "before_agent_start",
				prompt: "",
				systemPrompt: "Base",
				systemPromptOptions: { cwd: target, selectedTools: ["bash"] },
			},
			extensionContext,
		);
		expect(result?.systemPrompt).toContain("### Grepple repository workflow");
		const call = instance.handlers.get("tool_call") as ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
		expect(
			await call(
				{ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "rg needle ." } },
				extensionContext,
			),
		).toEqual({ block: true, reason: "Use Grepple" });
		expect(
			await call(
				{
					type: "tool_call",
					toolCallId: "2",
					toolName: "edit",
					input: { path: "file", oldText: "a", newText: "b" },
				},
				extensionContext,
			),
		).toMatchObject({ block: true });
	}
	expect(backendCalls).toBe(4);
});
