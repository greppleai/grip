import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/sync-versions.js", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(range = ">=0.2.1 <0.3.0") {
	const directory = await mkdtemp(join(tmpdir(), "grip-sync-versions-"));
	directories.push(directory);
	const manifests = {
		"package.json": { name: "test-root", version: "0.2.5", workspaces: ["packages/*"] },
		"packages/coding-agent/package.json": { name: "@greppleai/grip", version: "0.2.5" },
		"extensions/planner/package.json": {
			name: "@grip-extensions/planner",
			version: "1.0.0",
			engines: { grip: range },
			grip: { official: { id: "planner" } },
		},
		"extensions/unofficial/package.json": {
			name: "unofficial",
			version: "2.0.0",
			engines: { grip: "^0.2.1" },
		},
	};
	for (const [path, manifest] of Object.entries(manifests)) {
		await mkdir(dirname(join(directory, path)), { recursive: true });
		await writeFile(join(directory, path), `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	return directory;
}

it.each([
	{ args: ["--set", "0.3.0"], target: "0.3.0", expected: ">=0.2.1 <0.4.0" },
	{ args: ["--bump", "minor"], target: "0.3.0", expected: ">=0.2.1 <0.4.0" },
	{ args: ["--set", "0.4.2"], target: "0.4.2", expected: ">=0.2.1 <0.5.0" },
	{ args: ["--set", "1.0.0"], target: "1.0.0", expected: ">=0.2.1 <2.0.0" },
	{ args: ["--set", "2.0.0"], target: "2.0.0", expected: ">=0.2.1 <3.0.0" },
])(
	"extends official extension ranges for $args without changing extension versions",
	async ({ args, target, expected }) => {
		const directory = await fixture();
		execFileSync(process.execPath, [script, ...args], { cwd: directory });
		const manifestPath = join(directory, "extensions/planner/package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		expect(manifest.engines.grip).toBe(expected);
		expect(satisfies(target, manifest.engines.grip)).toBe(true);
		expect(manifest.version).toBe("1.0.0");
		expect(JSON.parse(await readFile(join(directory, "packages/coding-agent/package.json"), "utf8")).version).toBe(
			target,
		);
		expect(JSON.parse(await readFile(join(directory, "extensions/unofficial/package.json"), "utf8"))).toEqual({
			name: "unofficial",
			version: "2.0.0",
			engines: { grip: "^0.2.1" },
		});
		const first = await readFile(manifestPath, "utf8");
		execFileSync(process.execPath, [script], { cwd: directory });
		expect(await readFile(manifestPath, "utf8")).toBe(first);
	},
);

it("preserves an already wider range during routine checks and patch releases", async () => {
	const directory = await fixture(">=0.2.1 <0.5.0");
	const manifestPath = join(directory, "extensions/planner/package.json");
	const before = await readFile(manifestPath, "utf8");
	for (const args of [[], ["--bump", "patch"], ["--set", "0.3.0"]]) {
		execFileSync(process.execPath, [script, ...args], { cwd: directory });
		expect(await readFile(manifestPath, "utf8")).toBe(before);
	}
});

it("syncs official extension ranges when workspace versions are already bumped", async () => {
	const directory = await fixture();
	await writeFile(
		join(directory, "packages/coding-agent/package.json"),
		JSON.stringify({ name: "@greppleai/grip", version: "0.3.0" }),
	);
	execFileSync(process.execPath, [script], { cwd: directory });
	expect(JSON.parse(await readFile(join(directory, "extensions/planner/package.json"), "utf8")).engines.grip).toBe(
		">=0.2.1 <0.4.0",
	);
});
