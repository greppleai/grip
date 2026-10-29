import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
	prepareOfficialVersions,
	publishAutomaticOfficialExtensions,
} from "../../../scripts/automatic-official-extensions.ts";
import {
	emptyOfficialCatalog,
	type OfficialPackageResult,
	packageOfficialRepository,
} from "../../../scripts/official-extensions.ts";
import type { OfficialPublisher } from "../../../scripts/publish-official-extension.ts";
import type { OfficialCatalog, OfficialRelease } from "../src/core/official-catalog.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	}).trim();
}

class MemoryPublisher implements OfficialPublisher {
	catalog = emptyOfficialCatalog();
	artifacts = new Map<string, Uint8Array>();
	uploads = 0;
	failCatalog = false;
	failAfterBackup = false;
	catalogPublications = 0;
	async readCatalog(): Promise<OfficialCatalog> {
		return structuredClone(this.catalog);
	}
	async readArtifact(release: OfficialRelease): Promise<Uint8Array | null> {
		return this.artifacts.get(release.tag) ?? null;
	}
	async publishArtifact(result: OfficialPackageResult): Promise<void> {
		this.uploads++;
		this.artifacts.set(result.release.tag, result.bytes);
	}
	async publishCatalog(catalog: OfficialCatalog): Promise<void> {
		this.catalogPublications++;
		if (this.failCatalog) throw new Error("catalog unavailable");
		this.catalog = structuredClone(catalog);
		if (this.failAfterBackup) throw new Error("primary replacement interrupted");
	}
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "grip-official-auto-"));
	directories.push(directory);
	const root = join(directory, "checkout");
	const remote = join(directory, "remote.git");
	await mkdir(root);
	git(root, "init", "--bare", remote);
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.invalid");
	git(root, "config", "core.hooksPath", "/dev/null");
	git(root, "remote", "add", "origin", remote);
	await mkdir(join(root, "extensions"));
	await writeFile(join(root, "extensions", "README.md"), "Official source");
	async function add(id: string, version = "1.0.0") {
		const path = join(root, "extensions", id);
		await mkdir(path);
		await writeFile(
			join(path, "package.json"),
			`${JSON.stringify(
				{
					name: id,
					version,
					type: "module",
					description: "Automatic publication fixture",
					engines: { grip: ">=0.2.1 <1" },
					grip: { official: { id, displayName: id }, extensions: ["index.ts"] },
				},
				null,
				2,
			)}\n`,
		);
		await writeFile(join(path, "LICENSE"), "MIT fixture notice");
		await writeFile(join(path, "index.ts"), "export default () => {};\n");
	}
	function commit() {
		git(root, "add", "--", "extensions");
		git(root, "commit", "-m", "fixture source");
		git(root, "push", "origin", "HEAD:refs/heads/main");
		return git(root, "rev-parse", "HEAD");
	}
	await add("alpha");
	commit();
	return { root, remote, add, commit, publisher: new MemoryPublisher() };
}

it("bootstraps the catalog, tags the source manifest, and does not bump or upload artifacts on an identical rerun", async () => {
	const { root, remote, publisher } = await fixture();
	const before = git(root, "rev-parse", "HEAD");
	await publishAutomaticOfficialExtensions(root, publisher);
	const release = publisher.catalog.extensions[0].releases[0];
	expect(release.manifest.version).toBe("1.0.0");
	expect(release.sourceCommit).toBe(before);
	expect(git(remote, "rev-parse", "refs/tags/extension-alpha-v1.0.0")).toBe(before);
	await publishAutomaticOfficialExtensions(root, publisher);
	expect(publisher.uploads).toBe(1);
	expect(git(root, "rev-parse", "HEAD")).toBe(before);
});

it("bumps only changed published extensions, including non-bundled source changes, and publishes directly", async () => {
	const { root, remote, publisher, add, commit } = await fixture();
	await add("beta", "1.0.9");
	commit();
	await publishAutomaticOfficialExtensions(root, publisher);
	await writeFile(join(root, "extensions", "beta", "notes.md"), "Changed source not in bundle");
	commit();
	await publishAutomaticOfficialExtensions(root, publisher);
	const head = git(root, "rev-parse", "HEAD");
	const beta = publisher.catalog.extensions.find((entry) => entry.id === "beta")!;
	expect(beta.releases.map((release) => release.manifest.version)).toEqual(["1.0.10", "1.0.9"]);
	expect(beta.releases.find((release) => release.manifest.version === "1.0.10")?.sourceCommit).toBe(head);
	expect(git(remote, "rev-parse", "refs/heads/main")).toBe(head);
	expect(git(remote, "rev-parse", "refs/tags/extension-beta-v1.0.10")).toBe(head);
	expect(JSON.parse(git(root, "show", "extension-beta-v1.0.10:extensions/beta/package.json")).version).toBe("1.0.10");
	expect(publisher.catalog.extensions.find((entry) => entry.id === "alpha")?.releases).toHaveLength(1);
	expect(git(root, "status", "--porcelain")).toBe("");
	await publishAutomaticOfficialExtensions(root, publisher);
	expect(publisher.uploads).toBe(3);
});

it("plans unchanged-version PRs without reusing a published artifact version", async () => {
	const { root, publisher, commit } = await fixture();
	await publishAutomaticOfficialExtensions(root, publisher);
	await writeFile(join(root, "extensions", "alpha", "index.ts"), "export default () => 'new';\n");
	commit();
	const head = git(root, "rev-parse", "HEAD");
	const changes = await prepareOfficialVersions(root, publisher.catalog);
	expect(changes.map((change) => change.version)).toEqual(["1.0.1"]);
	const output = join(directories.at(-1)!, "packaged");
	const catalog = await packageOfficialRepository(root, output, head, publisher.catalog);
	expect(catalog.extensions[0].releases).toHaveLength(2);
	expect(git(root, "rev-parse", "HEAD")).toBe(head);
	expect(git(root, "tag", "--list")).not.toContain("1.0.1");
});

it("recovers partial publication without another version commit, tag or artifact upload", async () => {
	const { root, publisher, commit } = await fixture();
	await publishAutomaticOfficialExtensions(root, publisher);
	await writeFile(join(root, "extensions", "alpha", "index.ts"), "export default () => 'new';\n");
	commit();
	publisher.failCatalog = true;
	await expect(publishAutomaticOfficialExtensions(root, publisher)).rejects.toThrow("catalog unavailable");
	const head = git(root, "rev-parse", "HEAD");
	expect(JSON.parse(await readFile(join(root, "extensions", "alpha", "package.json"), "utf8")).version).toBe("1.0.1");
	publisher.failCatalog = false;
	await publishAutomaticOfficialExtensions(root, publisher);
	expect(git(root, "rev-parse", "HEAD")).toBe(head);
	expect(publisher.uploads).toBe(2);
	expect(publisher.catalog.extensions[0].releases).toHaveLength(2);
});

it("does not overwrite a pending tag if newer source arrives before catalog recovery", async () => {
	const { root, publisher, commit } = await fixture();
	publisher.failCatalog = true;
	await expect(publishAutomaticOfficialExtensions(root, publisher)).rejects.toThrow("catalog unavailable");
	const tagged = git(root, "rev-parse", "extension-alpha-v1.0.0");
	await writeFile(join(root, "extensions", "alpha", "index.ts"), "export default () => 'new';\n");
	commit();
	publisher.failCatalog = false;
	await expect(publishAutomaticOfficialExtensions(root, publisher)).rejects.toThrow(/Pending official tag/);
	expect(git(root, "rev-parse", "extension-alpha-v1.0.0")).toBe(tagged);
	expect(publisher.uploads).toBe(1);
});

it("rejects an atomic branch/tag push when main advanced and leaves discovery unchanged", async () => {
	const { root, remote, publisher } = await fixture();
	const head = git(root, "rev-parse", "HEAD");
	const tree = git(root, "rev-parse", "HEAD^{tree}");
	const advanced = git(root, "commit-tree", tree, "-p", head, "-m", "concurrent main push");
	git(root, "push", "origin", `${advanced}:refs/heads/main`);
	await expect(publishAutomaticOfficialExtensions(root, publisher)).rejects.toThrow();
	expect(publisher.uploads).toBe(0);
	expect(publisher.catalog.extensions).toEqual([]);
	expect(git(remote, "tag", "--list")).toBe("");
});

it("keeps explicit higher versions and rejects downgrades, prereleases and dirty publication checkouts", async () => {
	const { root, publisher, commit } = await fixture();
	await publishAutomaticOfficialExtensions(root, publisher);
	const path = join(root, "extensions", "alpha", "package.json");
	const pkg = JSON.parse(await readFile(path, "utf8"));
	pkg.version = "2.0.0";
	await writeFile(path, JSON.stringify(pkg));
	commit();
	await publishAutomaticOfficialExtensions(root, publisher);
	expect(publisher.catalog.extensions[0].releases.map((release) => release.manifest.version)).toContain("2.0.0");
	for (const version of ["1.0.0", "2.0.1-beta.1"]) {
		pkg.version = version;
		await writeFile(path, JSON.stringify(pkg));
		await expect(prepareOfficialVersions(root, publisher.catalog)).rejects.toThrow();
	}
	await expect(publishAutomaticOfficialExtensions(root, publisher)).rejects.toThrow(/clean checkout/);
});

it("repairs discovery from a recovered backup even when no new version is needed", async () => {
	const { root, publisher } = await fixture();
	publisher.failAfterBackup = true;
	await expect(publishAutomaticOfficialExtensions(root, publisher)).rejects.toThrow("primary replacement interrupted");
	const head = git(root, "rev-parse", "HEAD");
	publisher.failAfterBackup = false;
	await publishAutomaticOfficialExtensions(root, publisher);
	expect(publisher.catalogPublications).toBe(2);
	expect(publisher.uploads).toBe(1);
	expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

it("reuses the tagged source commit when a failed release is retried after unrelated main changes", async () => {
	const { root, publisher, commit } = await fixture();
	publisher.failCatalog = true;
	await expect(publishAutomaticOfficialExtensions(root, publisher)).rejects.toThrow("catalog unavailable");
	const tagged = git(root, "rev-parse", "extension-alpha-v1.0.0");
	await writeFile(join(root, "extensions", "README.md"), "Unrelated repository documentation");
	commit();
	publisher.failCatalog = false;
	await publishAutomaticOfficialExtensions(root, publisher);
	expect(publisher.catalog.extensions[0].releases[0].sourceCommit).toBe(tagged);
	expect(publisher.uploads).toBe(1);
	expect(git(root, "rev-parse", "HEAD")).not.toBe(tagged);
});

it("bumps for changed bundled dependency bytes even when the extension directory is unchanged", async () => {
	const { root, publisher, commit } = await fixture();
	const dependency = join(root, "node_modules", "fixture-dep");
	await mkdir(dependency, { recursive: true });
	await writeFile(join(root, ".gitignore"), "node_modules/\n");
	git(root, "add", "--", ".gitignore");
	await writeFile(
		join(dependency, "package.json"),
		JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js", license: "MIT" }),
	);
	await writeFile(join(dependency, "LICENSE"), "MIT fixture dependency");
	await writeFile(join(dependency, "index.js"), "module.exports = 'old';");
	await writeFile(
		join(root, "extensions", "alpha", "index.ts"),
		'import value from "fixture-dep"; export default () => value;',
	);
	commit();
	await publishAutomaticOfficialExtensions(root, publisher);
	await writeFile(join(dependency, "index.js"), "module.exports = 'new';");
	await writeFile(join(root, "package-lock.json"), "Updated pinned dependency fixture");
	git(root, "add", "--", "package-lock.json");
	commit();
	await publishAutomaticOfficialExtensions(root, publisher);
	expect(publisher.catalog.extensions[0].releases.map((release) => release.manifest.version)).toEqual([
		"1.0.0",
		"1.0.1",
	]);
});

it("bumps multiple changed extensions in one shared source commit", async () => {
	const { root, publisher, add, commit } = await fixture();
	await add("beta");
	commit();
	await publishAutomaticOfficialExtensions(root, publisher);
	for (const id of ["alpha", "beta"])
		await writeFile(join(root, "extensions", id, "index.ts"), "export default () => 'new';");
	commit();
	await publishAutomaticOfficialExtensions(root, publisher);
	const head = git(root, "rev-parse", "HEAD");
	for (const extension of publisher.catalog.extensions) {
		expect(git(root, "rev-parse", `extension-${extension.id}-v1.0.1`)).toBe(head);
		expect(extension.releases).toContainEqual(
			expect.objectContaining({
				sourceCommit: head,
				manifest: expect.objectContaining({ version: "1.0.1" }),
			}),
		);
	}
});

it("rejects automatic CLI publication outside the official main push or dispatch context", () => {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	for (const overrides of [
		{ GITHUB_ACTIONS: "false" },
		{ GITHUB_REPOSITORY: "fixture/fork" },
		{ GITHUB_REF: "refs/tags/extension-alpha-v1.0.0" },
		{ GITHUB_EVENT_NAME: "pull_request" },
	]) {
		const result = spawnSync(process.execPath, ["scripts/official-extensions-cli.mjs", "publish-main"], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GH_TOKEN: "fixture-not-a-real-token",
				GITHUB_ACTIONS: "true",
				GITHUB_REPOSITORY: "greppleai/grip",
				GITHUB_REF: "refs/heads/main",
				GITHUB_EVENT_NAME: "push",
				...overrides,
			},
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Automatic publication is restricted to the official main workflow");
	}
});
