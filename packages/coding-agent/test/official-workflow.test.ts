import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
	emptyOfficialCatalog,
	mergeOfficialReleases,
	packageOfficialExtension,
} from "../../../scripts/official-extensions.ts";
import { officialJson } from "../src/core/official-artifact.ts";
import { OFFICIAL_CATALOG_URL, officialObject } from "../src/core/official-catalog.ts";
import { officialVersionDirectory } from "../src/core/official-state.ts";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("preserves independent bundled extensions, ownership and user data across real process restarts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "grip-official-workflow-"));
	directories.push(directory);
	const authorRoot = join(directory, "author");
	const agentDir = join(directory, "agent");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	const marker = join(agentDir, "factory-executions.log");
	const manualSource = 'export default api => api.registerCommand("manual-proof", { handler: async () => {} });';
	await writeFile(join(agentDir, "extensions", "manual.ts"), manualSource);
	await writeFile(join(agentDir, "user-data.json"), '{"preserve":true}');
	let autoUpdate = true;
	let now = Date.now();
	let catalog = emptyOfficialCatalog();
	const artifacts = new Map<string, Buffer>();
	async function publish(id: string, version: string, range = ">=0.1.0 <1") {
		const root = join(authorRoot, id);
		const dependency = join(root, "node_modules", "fixture-dep");
		await mkdir(dependency, { recursive: true });
		await writeFile(
			join(root, "package.json"),
			officialJson({
				name: `official-${id}`,
				version,
				description: "Workflow fixture",
				type: "module",
				engines: { grip: range },
				files: ["asset.txt"],
				dependencies: { "fixture-dep": "1.0.0" },
				grip: { official: { id, displayName: id }, extensions: ["entry.ts"] },
			}),
		);
		await writeFile(join(root, "LICENSE"), "MIT fixture notice");
		await writeFile(join(root, "asset.txt"), `${id}-asset`);
		await writeFile(
			join(dependency, "package.json"),
			officialJson({ name: "fixture-dep", version: "1.0.0", main: "index.cjs", license: "MIT" }),
		);
		await writeFile(join(dependency, "LICENSE"), "MIT bundled dependency notice");
		await writeFile(join(dependency, "index.cjs"), 'module.exports = () => "bundled-dependency";');
		await writeFile(
			join(root, "entry.ts"),
			`import dependency from "fixture-dep";
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.env.GRIP_WORKFLOW_MARKER, ${JSON.stringify(`import:${id}@${version}\n`)});
export default api => {
  const asset = readFileSync(new URL("./asset.txt", import.meta.url), "utf8");
  const description = ${JSON.stringify(version)} + ":" + dependency() + ":" + asset;
  appendFileSync(process.env.GRIP_WORKFLOW_MARKER, ${JSON.stringify(`factory:${id}@${version}\n`)});
  api.registerCommand(${JSON.stringify(`${id}-proof`)}, { description, handler: async () => {} });
};`,
		);
		const packaged = await packageOfficialExtension(root, "a".repeat(40));
		catalog = mergeOfficialReleases(catalog, [packaged.release]);
		artifacts.set(packaged.release.artifact.url, packaged.bytes);
		return packaged.release;
	}
	const alpha = await publish("alpha", "1.0.0");
	const beta = await publish("beta", "1.0.0");
	await publish("unselected", "1.0.0");
	// Remove all author-side dependencies before executing installed code.
	async function run(operation = "restart", offline = false) {
		await rm(authorRoot, { recursive: true, force: true });
		const settingsPath = join(agentDir, "settings.json");
		let settings: Record<string, unknown> = {};
		try {
			settings = officialObject(JSON.parse(await readFile(settingsPath, "utf8")), "settings");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		settings.theme = "light";
		settings.officialExtensions = { autoUpdate, catalogMaxAgeMs: 1 };
		await writeFile(settingsPath, officialJson(settings));
		now += 60_001;
		await writeFile(
			join(agentDir, "workflow-fixture.json"),
			officialJson({
				now,
				catalog,
				artifacts: [...artifacts].map(([url, bytes]) => [url, bytes.toString("base64")]),
			}),
		);
		await execute(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/official-workflow-process.mjs", import.meta.url)), agentDir, operation],
			{
				cwd: agentDir,
				timeout: 15000,
				env: {
					...process.env,
					GRIP_OFFLINE: offline ? "1" : "",
					GRIP_MODEL_CATALOG_URL: "",
					GRIP_EMBEDDED_ASSET_DIR: "",
					GRIP_WORKFLOW_MARKER: marker,
				},
			},
		);
		const result = officialObject(
			JSON.parse(await readFile(join(agentDir, "workflow-result.json"), "utf8")),
			"result",
		);
		expect(await readFile(join(agentDir, "extensions", "manual.ts"), "utf8")).toBe(manualSource);
		expect(await readFile(join(agentDir, "user-data.json"), "utf8")).toBe('{"preserve":true}');
		expect(officialObject(JSON.parse(await readFile(settingsPath, "utf8")), "persisted settings").theme).toBe(
			"light",
		);
		expect(await readFile(marker, "utf8")).not.toContain("unselected");
		return result;
	}
	const installed = await run("install");
	expect(installed.requests).toEqual([OFFICIAL_CATALOG_URL, alpha.artifact.url, beta.artifact.url]);
	expect(officialObject(installed.browsed, "browsed catalog").extensions).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: "alpha", compatibleVersion: "1.0.0" }),
			expect.objectContaining({ id: "beta", compatibleVersion: "1.0.0" }),
		]),
	);
	expect(installed.commands).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "alpha-proof", description: "1.0.0:bundled-dependency:alpha-asset" }),
			expect.objectContaining({ name: "beta-proof", description: "1.0.0:bundled-dependency:beta-asset" }),
			expect.objectContaining({ name: "manual-proof" }),
		]),
	);
	expect(installed.inventory).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				source: "official:alpha",
				version: "1.0.0",
				status: "loaded",
				removal: { source: "official:alpha", scope: "user" },
			}),
			expect.objectContaining({ source: "official:beta", version: "1.0.0", status: "loaded" }),
			expect.objectContaining({ removal: null, version: null, status: "loaded" }),
		]),
	);
	const retainedAlpha = join(
		agentDir,
		"official",
		"alpha",
		officialVersionDirectory("1.0.0", alpha.artifact.sha256),
		"entry.js",
	);
	const retainedAlphaBytes = await readFile(retainedAlpha);
	const newer = await publish("alpha", "1.1.0");
	const updated = await run();
	expect(updated.requests).toEqual([OFFICIAL_CATALOG_URL, newer.artifact.url]);
	expect(await readFile(retainedAlpha)).toEqual(retainedAlphaBytes);
	expect(updated.commands).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "alpha-proof", description: "1.1.0:bundled-dependency:alpha-asset" }),
			expect.objectContaining({ name: "beta-proof", description: "1.0.0:bundled-dependency:beta-asset" }),
		]),
	);
	expect(updated.inventory).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ source: "official:alpha", version: "1.1.0", status: "loaded" }),
			expect.objectContaining({ source: "official:beta", version: "1.0.0", status: "loaded" }),
		]),
	);
	const broken = await publish("alpha", "1.2.0");
	artifacts.set(broken.artifact.url, Buffer.alloc(broken.artifact.size, 0));
	await publish("beta", "2.0.0", ">=99");
	const fallback = await run();
	expect(fallback.requests).toEqual([OFFICIAL_CATALOG_URL, broken.artifact.url]);
	expect(fallback.diagnostics).toEqual(
		expect.arrayContaining([expect.objectContaining({ fatal: false, message: expect.stringContaining("alpha") })]),
	);
	const offline = await run("restart", true);
	expect(offline.requests).toEqual([]);
	for (const result of [fallback, offline]) {
		expect(result.commands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "alpha-proof", description: "1.1.0:bundled-dependency:alpha-asset" }),
				expect.objectContaining({ name: "beta-proof", description: "1.0.0:bundled-dependency:beta-asset" }),
			]),
		);
		expect(result.inventory).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "official:alpha", version: "1.1.0", status: "loaded" }),
				expect.objectContaining({ source: "official:beta", version: "1.0.0", status: "loaded" }),
			]),
		);
	}
	autoUpdate = false;
	await publish("alpha", "1.3.0");
	const optedOut = await run();
	expect(optedOut.requests).toEqual([]);
	expect(await readFile(marker, "utf8")).not.toMatch(/alpha@1\.[23]\.0|beta@2\.0\.0/);
	expect(optedOut.inventory).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ source: "official:alpha", version: "1.1.0", status: "loaded" }),
		]),
	);
	const removed = await run("remove");
	expect(removed.packages).toEqual(["official:beta"]);
	autoUpdate = true;
	const restarted = await run();
	expect(restarted.requests).toEqual([OFFICIAL_CATALOG_URL]);
	expect(restarted.packages).toEqual(["official:beta"]);
	expect(restarted.inventory).not.toEqual(
		expect.arrayContaining([expect.objectContaining({ source: "official:alpha" })]),
	);
	expect(restarted.commands).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "beta-proof", description: "1.0.0:bundled-dependency:beta-asset" }),
			expect.objectContaining({ name: "manual-proof" }),
		]),
	);
	expect(restarted.commands).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "alpha-proof" })]));
}, 90000);
