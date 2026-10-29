import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createJiti } from "jiti/static";
import * as typebox from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	emptyOfficialCatalog,
	mergeOfficialReleases,
	type OfficialPackageResult,
	packageOfficialExtension,
	packageOfficialRepository,
} from "../../../scripts/official-extensions.ts";
import {
	GitHubOfficialPublisher,
	type OfficialPublisher,
	publishOfficialExtension,
} from "../../../scripts/publish-official-extension.ts";
import {
	decodeOfficialArtifact,
	encodeOfficialArtifact,
	officialJson,
	officialSha256,
	parseOfficialArtifact,
} from "../src/core/official-artifact.ts";
import { OFFICIAL_LIMITS, type OfficialCatalog, type OfficialRelease } from "../src/core/official-catalog.ts";

interface FixtureAPI {
	record(value: string[]): void;
}
interface MockAsset {
	id: number;
	name: string;
	bytes: Uint8Array;
}
interface MockRelease {
	id: number;
	assets: MockAsset[];
}

class MockGitHub {
	releases = new Map<string, MockRelease>();
	sequence = 1;
	failCatalog = true;
	failBackup = false;
	creations: Record<string, unknown>[] = [];

	response(value: unknown, status = 200): Response {
		return new Response(JSON.stringify(value), { status });
	}

	async fetch(input: string, options: RequestInit): Promise<Response> {
		const url = new URL(input);
		const method = options.method ?? "GET";
		if (url.pathname.endsWith("/releases") && method === "POST") {
			const body = JSON.parse(Buffer.from(options.body as Uint8Array).toString("utf8"));
			this.creations.push(body);
			const release: MockRelease = { id: this.sequence++, assets: [] };
			this.releases.set(body.tag_name, release);
			return this.response(release);
		}
		if (url.pathname.includes("/releases/tags/")) {
			const release = this.releases.get(decodeURIComponent(url.pathname.split("/tags/")[1]));
			return this.response(release ?? {}, release ? 200 : 404);
		}
		if (url.hostname === "uploads.github.com") return this.upload(url, options);
		return this.asset(url, method);
	}

	upload(url: URL, options: RequestInit): Response {
		const releaseId = Number(url.pathname.split("/").at(-2));
		const release = [...this.releases.values()].find((release) => release.id === releaseId);
		if (!release) return this.response({}, 404);
		const name = url.searchParams.get("name");
		if (!name) return this.response({}, 400);
		if (name === "catalog.json" && this.failCatalog) return this.response({}, 503);
		if (name === "catalog.backup.json" && this.failBackup) return this.response({}, 503);
		release.assets.push({ id: this.sequence++, name, bytes: options.body as Uint8Array });
		return this.response({});
	}

	asset(url: URL, method: string): Response {
		const id = Number(url.pathname.split("/").at(-1));
		for (const release of this.releases.values()) {
			const index = release.assets.findIndex((asset) => asset.id === id);
			if (index < 0) continue;
			if (method === "DELETE") {
				release.assets.splice(index, 1);
				return this.response({});
			}
			return new Response(new Uint8Array(release.assets[index].bytes));
		}
		return this.response({}, 404);
	}
}

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "grip-official-package-"));
	directories.push(path);
	return path;
}

async function fixture(): Promise<string> {
	const root = join(await temporary(), "fixture");
	await mkdir(join(root, "node_modules", "fixture-dep"), { recursive: true });
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({
			name: "fixture",
			version: "1.0.0",
			type: "module",
			description: "Fixture only",
			engines: { grip: ">=0.1.0 <1" },
			files: ["asset.txt"],
			grip: { official: { id: "fixture", displayName: "Fixture" }, extensions: ["entry.ts"], skills: ["skill.md"] },
		}),
	);
	await writeFile(
		join(root, "entry.ts"),
		`import dependency from "fixture-dep";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
export default function(api) { api.record([dependency(), Type.String().type, readFileSync(new URL("./asset.txt", import.meta.url), "utf8")]); }`,
	);
	await writeFile(join(root, "asset.txt"), "asset payload");
	await writeFile(join(root, "skill.md"), "---\nname: fixture\ndescription: Fixture\n---\nFixture skill.");
	await writeFile(join(root, "LICENSE"), "MIT fixture license");
	await writeFile(
		join(root, "node_modules", "fixture-dep", "package.json"),
		JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.cjs", license: "MIT" }),
	);
	await writeFile(
		join(root, "node_modules", "fixture-dep", "index.cjs"),
		`const path = require("node:path"); const { Type } = require("typebox"); module.exports = () => path.basename("/bundled/dependency") + ":" + Type.String().type;`,
	);
	await writeFile(join(root, "node_modules", "fixture-dep", "LICENSE"), "MIT dependency notice");
	return root;
}

const commit = "a".repeat(40);

describe("official reproducible artifacts", () => {
	it("bundles dependencies/resources/assets and loads outside the checkout with standalone virtual modules", async () => {
		const root = await fixture();
		const first = await packageOfficialExtension(root, commit);
		const second = await packageOfficialExtension(root, commit);
		expect(first.bytes.equals(second.bytes)).toBe(true);
		expect(first.bytes.readUInt32LE(4)).toBe(0); // gzip timestamp must not depend on build time.
		const otherRoot = await fixture();
		expect((await packageOfficialExtension(otherRoot, commit)).bytes.equals(first.bytes)).toBe(true);
		const unpacked = decodeOfficialArtifact(first.bytes, first.release);
		expect(unpacked.manifest.grip.extensions).toEqual(["entry.js"]);
		expect(unpacked.manifest.grip.skills).toEqual(["skill.md"]);
		const target = await temporary();
		for (const file of unpacked.files) {
			await mkdir(dirname(join(target, file.path)), { recursive: true });
			await writeFile(join(target, file.path), Buffer.from(file.base64, "base64"));
		}
		expect(await readFile(join(target, "THIRD-PARTY-NOTICES.txt"), "utf8")).toContain("MIT dependency notice");
		// Same jiti/static virtual-module path and tryNative=false used by the compiled loader.
		const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false, virtualModules: { typebox } });
		const factory = await jiti.import<(api: FixtureAPI) => void>(join(target, "entry.js"), {
			default: true,
		});
		const record = vi.fn();
		factory({ record });
		expect(record).toHaveBeenCalledWith(["dependency:string", "string", "asset payload"]);
		const nodeLoader = createJiti(import.meta.url, {
			moduleCache: false,
			alias: { typebox: fileURLToPath(import.meta.resolve("typebox")) },
		});
		const nodeFactory = await nodeLoader.import<(api: FixtureAPI) => void>(join(target, "entry.js"), {
			default: true,
		});
		nodeFactory({ record });
		expect(record).toHaveBeenCalledTimes(2);
	});

	it("supports an empty production catalog and retains published compatible history", async () => {
		const root = await temporary();
		await mkdir(join(root, "extensions"));
		await writeFile(join(root, "extensions", "README.md"), "Authoring conventions");
		const output = join(root, "out");
		expect(await packageOfficialRepository(root, output, commit, emptyOfficialCatalog())).toEqual(
			emptyOfficialCatalog(),
		);
		const first = await packageOfficialExtension(await fixture(), commit);
		const previous = mergeOfficialReleases(emptyOfficialCatalog(), [first.release]);
		expect(await packageOfficialRepository(root, output, commit, previous)).toEqual(previous);
		const next = structuredClone(first.release);
		next.manifest.version = "2.0.0";
		next.manifest.engines.grip = ">=1";
		next.tag = "extension-fixture-v2.0.0";
		next.artifact.url = next.artifact.url.replaceAll("1.0.0", "2.0.0");
		expect(mergeOfficialReleases(previous, [next]).extensions[0].releases).toHaveLength(2);
		expect(() => mergeOfficialReleases(previous, [first.release, first.release])).toThrow(/Duplicate/);
		const changed = structuredClone(first.release);
		changed.artifact.sha256 = "c".repeat(64);
		expect(() => mergeOfficialReleases(previous, [changed])).toThrow(/reuse/);
		const rebuilt = { ...first.release, sourceCommit: "c".repeat(40) };
		expect(mergeOfficialReleases(previous, [rebuilt])).toEqual(previous);
	});

	it.each(["unresolved", "native", "computed", "unsupported-subpath"])(
		"rejects %s runtime imports rather than installing dependencies",
		async (kind) => {
			const root = await fixture();
			const source =
				kind === "unresolved"
					? 'import missing from "never-installed"; export default missing;'
					: kind === "native"
						? 'import native from "./binding.node"; export default native;'
						: kind === "computed"
							? "export default () => import(process.env.RUNTIME_MODULE);"
							: 'import invalid from "@greppleai/grip/not-a-virtual-module"; export default invalid;';
			await writeFile(join(root, "entry.ts"), source);
			await expect(packageOfficialExtension(root, commit)).rejects.toThrow();
		},
	);

	it("rejects symlinks, unsafe asset paths, missing entrypoints and malformed manifests", async () => {
		const root = await fixture();
		await rm(join(root, "asset.txt"));
		await symlink(join(root, "LICENSE"), join(root, "asset.txt"));
		await expect(packageOfficialExtension(root, commit)).rejects.toThrow(/Symlink/);
		await rm(join(root, "asset.txt"));
		await writeFile(join(root, "asset.txt"), "asset");
		const path = join(root, "package.json");
		const pkg = JSON.parse(await readFile(path, "utf8"));
		pkg.files = ["../secret"];
		await writeFile(path, JSON.stringify(pkg));
		await expect(packageOfficialExtension(root, commit)).rejects.toThrow(/path/);
		pkg.files = [];
		pkg.engines.grip = "invalid";
		await writeFile(path, JSON.stringify(pkg));
		await expect(packageOfficialExtension(root, commit)).rejects.toThrow(/range/);
		pkg.engines.grip = ">=0.1";
		await writeFile(path, JSON.stringify(pkg));
		await rm(join(root, "entry.ts"));
		await expect(packageOfficialExtension(root, commit)).rejects.toThrow();
	});

	it("rejects absent dependency licenses", async () => {
		const root = await fixture();
		await rm(join(root, "node_modules", "fixture-dep", "LICENSE"));
		await expect(packageOfficialExtension(root, commit)).rejects.toThrow(/license review/);
	});

	it("validates envelope integrity, manifests, schemas, collisions and base64 before extraction", async () => {
		const result = await packageOfficialExtension(await fixture(), commit);
		const envelope = decodeOfficialArtifact(result.bytes, result.release);
		expect(encodeOfficialArtifact(envelope).equals(result.bytes)).toBe(true);
		for (const path of ["../entry.js", "/entry.js", "ENTRY.js", "entry.js/nested"]) {
			const invalid = structuredClone(envelope);
			invalid.files.push({ path, base64: "" });
			expect(() => parseOfficialArtifact(invalid, "fixture")).toThrow();
		}
		const badBase64 = structuredClone(envelope);
		badBase64.files[0].base64 = "AB==";
		expect(() => parseOfficialArtifact(badBase64, "fixture")).toThrow(/base64/);
		expect(() => parseOfficialArtifact({ ...envelope, schemaVersion: 2 }, "fixture")).toThrow(/schema/);
		expect(() =>
			parseOfficialArtifact(
				{ ...envelope, files: envelope.files.filter((file) => file.path !== "package.json") },
				"fixture",
			),
		).toThrow(/package.json/);
		expect(() =>
			parseOfficialArtifact(
				{ ...envelope, files: [...envelope.files, { path: "link", base64: "", symlink: "/etc" }] },
				"fixture",
			),
		).toThrow(/metadata/);
		expect(() => decodeOfficialArtifact(Buffer.from("wrong"), result.release)).toThrow(/digest/);
		const changed = structuredClone(envelope);
		changed.manifest.description = "Changed";
		const bytes = gzipSync(Buffer.from(officialJson(changed)));
		expect(() =>
			decodeOfficialArtifact(bytes, {
				...result.release,
				artifact: { ...result.release.artifact, size: bytes.length, sha256: officialSha256(bytes) },
			}),
		).toThrow(/manifest/);
	});

	it("enforces compressed/file-count/decompression bounds", async () => {
		const result = await packageOfficialExtension(await fixture(), commit);
		const envelope = decodeOfficialArtifact(result.bytes, result.release);
		expect(() =>
			parseOfficialArtifact(
				{ ...envelope, files: Array.from({ length: OFFICIAL_LIMITS.files + 1 }, () => envelope.files[0]) },
				"fixture",
			),
		).toThrow(/count/);
		expect(() => decodeOfficialArtifact(Buffer.alloc(OFFICIAL_LIMITS.artifactBytes + 1), result.release)).toThrow(
			/size/,
		);
		const bomb = gzipSync(Buffer.alloc(OFFICIAL_LIMITS.expandedBytes + 1, 32));
		const release = {
			...result.release,
			artifact: { ...result.release.artifact, size: bomb.length, sha256: officialSha256(bomb) },
		};
		expect(() => decodeOfficialArtifact(bomb, release)).toThrow();
	});

	it("packages an existing JS entry without executing its top-level code", async () => {
		const root = await fixture();
		const path = join(root, "package.json");
		const pkg = JSON.parse(await readFile(path, "utf8"));
		pkg.grip.extensions = ["entry.js"];
		await writeFile(path, JSON.stringify(pkg));
		await writeFile(
			join(root, "entry.js"),
			'throw new Error("Must not run while packaging"); export default () => {};',
		);
		expect((await packageOfficialExtension(root, commit)).release.manifest.grip.extensions).toEqual(["entry.js"]);
	});
});

class MemoryPublisher implements OfficialPublisher {
	catalog = emptyOfficialCatalog();
	artifact: Uint8Array | null = null;
	uploads = 0;
	failCatalog = false;
	failArtifact = false;
	async readCatalog(): Promise<OfficialCatalog> {
		return structuredClone(this.catalog);
	}
	async readArtifact(_release: OfficialRelease): Promise<Uint8Array | null> {
		return this.artifact;
	}
	async publishArtifact(result: OfficialPackageResult): Promise<void> {
		this.uploads++;
		if (this.failArtifact) throw new Error("upload failed");
		this.artifact = result.bytes;
	}
	async publishCatalog(catalog: OfficialCatalog): Promise<void> {
		if (this.failCatalog) throw new Error("catalog failed");
		this.catalog = structuredClone(catalog);
	}
}

describe("official publication ordering and retry", () => {
	it("never advertises missing bytes and retries partial publication without overwriting artifacts", async () => {
		const result = await packageOfficialExtension(await fixture(), commit);
		const remote = new MemoryPublisher();
		remote.failArtifact = true;
		await expect(publishOfficialExtension(result, remote)).rejects.toThrow(/upload/);
		expect(remote.catalog.extensions).toEqual([]);
		remote.failArtifact = false;
		remote.failCatalog = true;
		await expect(publishOfficialExtension(result, remote)).rejects.toThrow(/catalog/);
		expect(remote.catalog.extensions).toEqual([]);
		expect(remote.artifact).not.toBeNull();
		remote.failCatalog = false;
		await publishOfficialExtension(result, remote);
		await publishOfficialExtension(result, remote);
		expect(remote.uploads).toBe(2);
		expect(remote.catalog.extensions[0].releases).toHaveLength(1);
		remote.artifact = Buffer.from("corrupt");
		await expect(publishOfficialExtension(result, remote)).rejects.toThrow(/digest/);
		expect(remote.uploads).toBe(2);
		const moved = { ...result, release: { ...result.release, sourceCommit: "c".repeat(40) } };
		await expect(publishOfficialExtension(moved, remote)).rejects.toThrow(/source commit/);
	});

	it("checks real API backup recovery, immutable artifacts and latest=false using mocked HTTP", async () => {
		const result = await packageOfficialExtension(await fixture(), commit);
		const api = new MockGitHub();
		vi.stubGlobal("fetch", vi.fn(api.fetch.bind(api)));
		const publisher = new GitHubOfficialPublisher("fixture-token");
		await expect(publishOfficialExtension(result, publisher)).rejects.toThrow(/503/);
		expect((await publisher.readCatalog()).extensions[0].releases).toHaveLength(1);
		api.failCatalog = false;
		await publishOfficialExtension(result, publisher);
		expect((await publisher.readCatalog()).extensions[0].releases).toHaveLength(1);
		expect(api.creations.every((body) => body.make_latest === "false")).toBe(true);
		await expect(publisher.publishArtifact(result)).rejects.toThrow(/immutable/);
	});

	it("preserves catalog history across consecutive primary and backup replacement failures", async () => {
		const first = await packageOfficialExtension(await fixture(), commit);
		const api = new MockGitHub();
		vi.stubGlobal("fetch", vi.fn(api.fetch.bind(api)));
		const publisher = new GitHubOfficialPublisher("fixture-token");
		await expect(publishOfficialExtension(first, publisher)).rejects.toThrow(/503/);
		const previous = await publisher.readCatalog();
		expect(previous.extensions[0].releases).toHaveLength(1);

		const root = await fixture();
		const path = join(root, "package.json");
		const manifest = JSON.parse(await readFile(path, "utf8"));
		manifest.version = "1.1.0";
		await writeFile(path, JSON.stringify(manifest));
		const next = await packageOfficialExtension(root, "b".repeat(40));
		api.failBackup = true;
		// If primary restoration also fails, do not touch the only surviving backup.
		await expect(publishOfficialExtension(next, publisher)).rejects.toThrow(/503/);
		expect(await publisher.readCatalog()).toEqual(previous);
		api.failCatalog = false;
		// A failed backup replacement now leaves the restored primary available.
		await expect(publishOfficialExtension(next, publisher)).rejects.toThrow(/503/);
		expect(await publisher.readCatalog()).toEqual(previous);
		api.failBackup = false;
		await publishOfficialExtension(next, publisher);
		expect(
			(await publisher.readCatalog()).extensions[0].releases.map((release) => release.manifest.version).sort(),
		).toEqual(["1.0.0", "1.1.0"]);
	});

	it("keeps official publication isolated from core tags and npm releases", async () => {
		const root = fileURLToPath(new URL("../../../", import.meta.url));
		const workflow = await readFile(join(root, ".github/workflows/publish-official-extension.yml"), "utf8");
		expect(workflow).toContain("extension-*-v*");
		expect(workflow).toContain("branches: [main]");
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain("publish-main");
		expect(workflow).toContain("needs.validate.outputs.commit");
		expect(workflow).toContain("needs: validate");
		expect(workflow).toContain("group: publish-official-catalog-v1");
		expect(workflow).toContain("cancel-in-progress: false");
		expect(workflow).not.toMatch(/npm (?:publish|run (?:build|release))/);
		const core = await readFile(join(root, ".github/workflows/build-binaries.yml"), "utf8");
		expect(core).toContain("- 'v*'");
		expect(core).not.toContain("extension-*-v*");
	});
});
