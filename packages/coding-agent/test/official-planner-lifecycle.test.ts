import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TextContent } from "@greppleai/grip-ai";
import { afterEach, expect, it } from "vitest";
import {
	emptyOfficialCatalog,
	mergeOfficialReleases,
	packageOfficialExtension,
} from "../../../scripts/official-extensions.ts";
import type { Extension } from "../src/core/extensions/types.ts";
import { officialJson } from "../src/core/official-artifact.ts";
import { OFFICIAL_CATALOG_URL } from "../src/core/official-catalog.ts";
import { officialVersionDirectory } from "../src/core/official-state.ts";
import type { Skill } from "../src/core/skills.ts";

interface PlannerCatalogEntry {
	id: string;
}

interface PlannerCatalogResult {
	extensions: PlannerCatalogEntry[];
}

interface PlannerPreparedResult {
	content: TextContent[];
}

interface PlannerProcessResult {
	browsed: PlannerCatalogResult | null;
	prepared: PlannerPreparedResult | null;
	requests: string[];
	packages: string[];
	extensions: Pick<Extension, "path" | "sourceInfo">[];
	skills: Pick<Skill, "name" | "sourceInfo">[];
	tools: string[];
}

type PlannerOperation = "install" | "reload" | "restart" | "uninstall" | "unselected" | "missing";

const execute = promisify(execFile);
const directories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const plannerRoot = join(repositoryRoot, "extensions", "planner");

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("installs the packaged planner through isolated process lifecycles without implicit network installation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "grip-official-planner-lifecycle-"));
	directories.push(directory);
	// A source-only checkout catches accidental reliance on workspace dist artifacts.
	const checkout = join(directory, "source-checkout");
	for (const name of ["ai", "agent", "tui", "coding-agent"]) {
		const source = join(repositoryRoot, "packages", name);
		const target = join(checkout, "packages", name);
		await mkdir(target, { recursive: true });
		await cp(join(source, "src"), join(target, "src"), { recursive: true });
		await cp(join(source, "package.json"), join(target, "package.json"));
		await symlink(join(source, "node_modules"), join(target, "node_modules"), "dir");
	}
	const fixtures = join(checkout, "packages/coding-agent/test/fixtures");
	await mkdir(fixtures, { recursive: true });
	for (const name of ["official-planner-process.mjs", "source-loader.mjs"]) {
		await cp(join(repositoryRoot, "packages/coding-agent/test/fixtures", name), join(fixtures, name));
	}
	await symlink(join(repositoryRoot, "node_modules"), join(checkout, "node_modules"), "dir");
	const processFixture = join(fixtures, "official-planner-process.mjs");
	const sourceLoader = join(fixtures, "source-loader.mjs");
	const agentDir = join(directory, "agent");
	const workspace = join(directory, "backend-workspace");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
	await writeFile(join(agentDir, "user-data.json"), '{"keep":"agent data"}');

	const packaged = await packageOfficialExtension(plannerRoot, "a".repeat(40));
	const catalog = mergeOfficialReleases(emptyOfficialCatalog(), [packaged.release]);
	let now = Date.now();
	async function run(operation: PlannerOperation, offline = false) {
		now += 60_001;
		await writeFile(
			join(agentDir, "planner-fixture.json"),
			officialJson({
				now,
				catalog,
				artifacts: [[packaged.release.artifact.url, packaged.bytes.toString("base64")]],
			}),
		);
		await execute(process.execPath, ["--import", sourceLoader, processFixture, agentDir, workspace, operation], {
			cwd: agentDir,
			timeout: 60000,
			env: {
				...process.env,
				GRIP_OFFLINE: offline ? "1" : "",
				GRIP_MODEL_CATALOG_URL: "",
				GRIP_EMBEDDED_ASSET_DIR: "",
			},
		}).catch((error: unknown) => {
			throw new Error(`Planner lifecycle ${operation} failed`, { cause: error });
		});
		return JSON.parse(await readFile(join(agentDir, "planner-result.json"), "utf8")) as PlannerProcessResult;
	}

	const missingBeforeInstall = await run("missing");
	expect(missingBeforeInstall.requests).toEqual([]);
	expect(missingBeforeInstall.packages).toEqual(["official:planner"]);
	expect(missingBeforeInstall.extensions).toEqual([]);
	const initiallyUnselected = await run("unselected");
	expect(initiallyUnselected.requests).toEqual([]);
	expect(initiallyUnselected.extensions).toEqual([]);

	const installed = await run("install");
	expect(installed.requests).toEqual([OFFICIAL_CATALOG_URL, packaged.release.artifact.url]);
	expect(installed.browsed?.extensions.map((extension) => extension.id)).toEqual(["planner"]);
	expect(installed.packages).toEqual(["official:planner"]);
	expect(installed.extensions).toEqual([
		expect.objectContaining({
			sourceInfo: expect.objectContaining({
				source: "official:planner",
				official: { id: "planner", version: "1.0.0" },
			}),
		}),
	]);
	expect(installed.skills).toEqual([
		expect.objectContaining({ name: "planner", sourceInfo: expect.objectContaining({ source: "official:planner" }) }),
	]);
	expect(installed.tools).toEqual([
		"planner_prepare",
		"planner_step_prepare",
		"planner_progress_prepare",
		"planner_handoff_prepare",
		"planner_start",
		"planner_done",
	]);
	const preparedText = installed.prepared?.content.find((part) => part.type === "text")?.text;
	expect(preparedText).toContain("Prepared");
	const plan = join(workspace, ".planner", "lifecycle-plan", "INDEX.md");
	expect(await readFile(plan, "utf8")).toContain("Lifecycle Plan");
	await expect(readFile(join(agentDir, ".planner", "lifecycle-plan", "INDEX.md"), "utf8")).rejects.toMatchObject({
		code: "ENOENT",
	});

	const authoredPlan = `---
name: Lifecycle Plan
description: Verify packaged planner lifecycle
status: Pending
---
# Lifecycle plan

Keep planner data in the backend workspace.
`;
	await writeFile(plan, authoredPlan);
	const reloaded = await run("reload");
	expect(reloaded.requests).toEqual([]);
	expect(reloaded.extensions).toHaveLength(1);
	expect(reloaded.tools).toHaveLength(6);
	expect(await readFile(plan, "utf8")).toBe(authoredPlan);

	const offline = await run("restart", true);
	expect(offline.requests).toEqual([]);
	expect(offline.extensions).toHaveLength(1);
	expect(offline.skills.map((skill) => skill.name)).toEqual(["planner"]);
	expect(offline.tools).toHaveLength(6);

	const retained = join(
		agentDir,
		"official",
		"planner",
		officialVersionDirectory("1.0.0", packaged.release.artifact.sha256),
		"extensions",
		"index.js",
	);
	const retainedCode = await readFile(retained, "utf8");
	const uninstalled = await run("uninstall");
	expect(uninstalled.requests).toEqual([]);
	expect(uninstalled.packages).toEqual([]);
	expect(uninstalled.extensions).toEqual([]);
	expect(uninstalled.tools).toEqual([]);
	expect(uninstalled.skills).toEqual([]);
	expect(await readFile(plan, "utf8")).toBe(authoredPlan);
	expect(await readFile(join(agentDir, "user-data.json"), "utf8")).toBe('{"keep":"agent data"}');
	expect(await readFile(retained, "utf8")).toBe(retainedCode);

	const unselected = await run("unselected");
	expect(unselected.requests).toEqual([]);
	expect(unselected.extensions).toEqual([]);
	expect(unselected.tools).toEqual([]);
	const missing = await run("missing");
	expect(missing.requests).toEqual([]);
	expect(missing.packages).toEqual(["official:planner"]);
	expect(missing.extensions).toEqual([]);
	expect(missing.tools).toEqual([]);
}, 300000);
