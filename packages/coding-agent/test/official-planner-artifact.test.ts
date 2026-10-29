import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocompleteItem } from "@greppleai/grip-tui";
import { createJiti } from "jiti/static";
import * as typebox from "typebox";
import { afterEach, expect, test } from "vitest";
import { packageOfficialExtension } from "../../../scripts/official-extensions.ts";
import { decodeOfficialArtifact, type OfficialArtifactFile } from "../src/core/official-artifact.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";

interface PlannerCommand {
	description: string;
	getArgumentCompletions(prefix: string): AutocompleteItem[];
	handler(args: string, context: unknown): Promise<void>;
}

interface PlannerTool {
	name: string;
}

interface PlannerAPI {
	registerCommand(name: string, command: PlannerCommand): void;
	registerTool(tool: PlannerTool): void;
	on(event: string, handler: unknown): void;
}

type PlannerFactory = (api: PlannerAPI) => void;

const directories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const plannerRoot = join(repositoryRoot, "extensions", "planner");
const sourceCommit = "a".repeat(40);

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "grip-planner-artifact-"));
	directories.push(directory);
	return directory;
}

function artifactText(files: OfficialArtifactFile[], path: string): string {
	const file = files.find((candidate) => candidate.path === path);
	expect(file, `artifact should contain ${path}`).toBeDefined();
	return Buffer.from(file!.base64, "base64").toString("utf8");
}

test("packages the actual planner reproducibly and loads its standalone artifact without mutating plans", async () => {
	const first = await packageOfficialExtension(plannerRoot, sourceCommit);
	const second = await packageOfficialExtension(plannerRoot, sourceCommit);

	expect(first.bytes.equals(second.bytes)).toBe(true);
	expect(first.bytes.readUInt32LE(4)).toBe(0);
	expect(first.release.manifest).toMatchObject({
		name: "@grip-extensions/planner",
		version: "1.0.0",
		engines: { grip: ">=0.2.1 <0.3.0" },
		grip: {
			official: { id: "planner", displayName: "Planner" },
			extensions: ["extensions/index.js"],
			skills: ["skills/planner/SKILL.md"],
		},
	});
	expect(JSON.parse(await readFile(join(plannerRoot, "package.json"), "utf8")).license).toBe("MIT");

	const artifact = decodeOfficialArtifact(first.bytes, first.release);
	expect(artifact.files.map((file) => file.path)).toEqual([
		"LICENSE",
		"README.md",
		"THIRD-PARTY-NOTICES.txt",
		"extensions/index.js",
		"package.json",
		"skills/planner/SKILL.md",
	]);
	expect(JSON.parse(artifactText(artifact.files, "package.json"))).toEqual(first.release.manifest);
	for (const path of ["LICENSE", "README.md", "skills/planner/SKILL.md"])
		expect(artifactText(artifact.files, path)).toBe(await readFile(join(plannerRoot, path), "utf8"));
	const notices = artifactText(artifact.files, "THIRD-PARTY-NOTICES.txt");
	expect(notices).toContain("yaml@2.9.1 (ISC)");
	expect(notices).toContain("Copyright Eemeli Aro");

	const target = await temporary();
	for (const file of artifact.files) {
		const path = join(target, file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, Buffer.from(file.base64, "base64"));
	}
	const workspace = join(target, "workspace");
	await mkdir(workspace);

	const commands = new Map<string, PlannerCommand>();
	const tools = new Map<string, PlannerTool>();
	const events: string[] = [];
	const api: PlannerAPI = {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		on(event) {
			events.push(event);
		},
	};
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		virtualModules: {
			typebox,
			"@greppleai/grip": { withFileMutationQueue },
		},
	});
	const registerPlanner = await jiti.import<PlannerFactory>(join(target, "extensions", "index.js"), {
		default: true,
	});
	registerPlanner(api);

	expect(
		commands
			.get("planner")
			?.getArgumentCompletions("")
			.map((item) => item.value),
	).toEqual(["prepare", "build", "resume", "stop", "status", "list", "cancel"]);
	expect([...tools.keys()]).toEqual([
		"planner_prepare",
		"planner_step_prepare",
		"planner_progress_prepare",
		"planner_handoff_prepare",
		"planner_start",
		"planner_done",
	]);
	expect(events).toEqual(["agent_end", "session_start", "session_shutdown"]);
	expect(await readdir(workspace)).toEqual([]);
});
