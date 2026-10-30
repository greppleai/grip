import { fork } from "node:child_process";
import { once } from "node:events";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { OfficialPackageResult } from "../../../scripts/official-extensions.ts";
import { encodeOfficialArtifact, officialJson, officialSha256 } from "../src/core/official-artifact.ts";
import {
	OFFICIAL_CATALOG_URL,
	OFFICIAL_REPOSITORY,
	type OfficialCatalog,
	type OfficialManifest,
	type OfficialRelease,
	parseOfficialManifest,
} from "../src/core/official-catalog.ts";
import { OfficialFileStore } from "../src/core/official-files.ts";
import { OfficialExtensionInstaller, type OfficialInstallerDependencies } from "../src/core/official-installer.ts";
import { readOfficialState } from "../src/core/official-state.ts";
import { OfficialTransport } from "../src/core/official-transport.ts";
import { InMemorySettingsStorage, SettingsManager, type SettingsScope } from "../src/core/settings-manager.ts";

interface InstallerHarness {
	agentDir: string;
	settings: SettingsManager;
	fixture: OfficialPackageResult;
	catalog: OfficialCatalog;
	artifacts: Map<string, Buffer>;
	fetcher: Mock<typeof fetch>;
	installer: OfficialExtensionInstaller;
}

const directories: string[] = [];
async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "grip-official-install-"));
	directories.push(path);
	return path;
}
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function artifact(id = "fixture", version = "1.0.0", range = ">=0.1.0 <1"): OfficialPackageResult {
	const manifest: OfficialManifest = parseOfficialManifest(
		{
			name: `official-${id}`,
			version,
			description: "Fixture",
			type: "module",
			engines: { grip: range },
			grip: { official: { id, displayName: id }, extensions: ["src/entry.js"], skills: ["skill.md"] },
		},
		id,
	);
	const files = [
		{ path: "package.json", base64: Buffer.from(officialJson(manifest)).toString("base64") },
		{
			path: "src/entry.js",
			base64: Buffer.from(
				'throw new Error("Downloaded code must not execute during installation"); export default () => {};',
			).toString("base64"),
		},
		{ path: "src/asset.txt", base64: Buffer.from("fixture asset").toString("base64") },
		{ path: "skill.md", base64: Buffer.from("Fixture skill").toString("base64") },
	];
	const bytes = encodeOfficialArtifact({ schemaVersion: 1, manifest, files });
	const release: OfficialRelease = {
		manifest,
		sourceCommit: "a".repeat(40),
		tag: `extension-${id}-v${version}`,
		artifact: {
			url: `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/extension-${id}-v${version}/${id}-${version}.json.gz`,
			size: bytes.length,
			sha256: officialSha256(bytes),
		},
	};
	return { bytes, release };
}

async function harness(dependencies: Partial<OfficialInstallerDependencies> = {}): Promise<InstallerHarness> {
	const agentDir = await temporary();
	const settings = SettingsManager.inMemory({
		packages: ["npm:untouched", { source: "./manual", extensions: ["entry.ts"] }],
	});
	const fixture = artifact();
	const catalog: OfficialCatalog = {
		schemaVersion: 1,
		repository: OFFICIAL_REPOSITORY,
		extensions: [{ id: "fixture", releases: [fixture.release] }],
	};
	const artifacts = new Map([[fixture.release.artifact.url, fixture.bytes]]);
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url === OFFICIAL_CATALOG_URL) return new Response(officialJson(catalog));
		const bytes = artifacts.get(url);
		if (!bytes) throw new Error(`Unexpected fixture request: ${url}`);
		return new Response(new Uint8Array(bytes));
	});
	const transport = new OfficialTransport(fetcher);
	const installer = new OfficialExtensionInstaller(
		{ agentDir, settingsManager: settings, gripVersion: "0.1.8" },
		{ ...dependencies, transport },
	);
	return { agentDir, settings, fixture, catalog, artifacts, fetcher, installer };
}

function addVersion(server: InstallerHarness, version: string): OfficialPackageResult {
	const next = artifact("fixture", version);
	server.catalog.extensions[0].releases.push(next.release);
	server.artifacts.set(next.release.artifact.url, next.bytes);
	return next;
}

class FailingStorage extends InMemorySettingsStorage {
	fail = false;
	override withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		super.withLock(scope, (current) => {
			const next = fn(current);
			if (this.fail && next !== undefined) throw new Error("Injected settings disk failure");
			return next;
		});
	}
}

describe("official download trust and limits", () => {
	it.each([
		"https://evil.example/payload",
		"http://release-assets.githubusercontent.com/a",
		"https://github.com.evil.example/a",
		"https://user:secret@objects.githubusercontent.com/a",
		"https://github.com/other/repo/releases/download/a/b",
	])("rejects redirected origin %s", async (destination) => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response(null, { status: 302, headers: { location: destination } }),
		);
		await expect(
			new OfficialTransport(fetcher).download(OFFICIAL_CATALOG_URL, 100, { signal: null, timeoutMs: 1000 }),
		).rejects.toMatchObject({ code: "origin" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("permits a bounded GitHub delivery redirect without forwarding credentials", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://release-assets.githubusercontent.com/a?signature=fixture" },
				}),
			)
			.mockResolvedValueOnce(new Response("ok"));
		expect(
			(
				await new OfficialTransport(fetcher).download(OFFICIAL_CATALOG_URL, 2, { signal: null, timeoutMs: 1000 })
			).toString(),
		).toBe("ok");
		expect(fetcher.mock.calls[1][1]).toMatchObject({
			redirect: "manual",
			headers: { Accept: "application/octet-stream" },
		});
	});
	it("enforces streamed bytes even without Content-Length, and rejects large advertised sizes", async () => {
		for (const headers of [
			new Headers(),
			new Headers({ "content-length": "9999" }),
			new Headers({ "content-length": "0" }),
		]) {
			const transport = new OfficialTransport(async () => new Response("oversized", { headers }));
			await expect(
				transport.download(OFFICIAL_CATALOG_URL, 2, { signal: null, timeoutMs: 1000 }),
			).rejects.toMatchObject({ code: "size" });
		}
	});
	it("bounds ignored cancellation and a stalled response body", async () => {
		const ignored = new OfficialTransport(() => new Promise(() => {}));
		await expect(ignored.download(OFFICIAL_CATALOG_URL, 10, { signal: null, timeoutMs: 10 })).rejects.toMatchObject({
			code: "canceled",
		});
		const body = new OfficialTransport(async () => new Response(new ReadableStream({ start() {} })));
		await expect(body.download(OFFICIAL_CATALOG_URL, 10, { signal: null, timeoutMs: 10 })).rejects.toMatchObject({
			code: "canceled",
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			ignored.download(OFFICIAL_CATALOG_URL, 10, { signal: controller.signal, timeoutMs: 1000 }),
		).rejects.toMatchObject({ code: "canceled" });
	});
});

describe("official transactional installation", () => {
	it.each(["remove-journaled", "removed-membership"])(
		"recovers interrupted profile removal at %s without deactivating another profile's code",
		async (phase) => {
			let interrupt = false;
			const server = await harness({
				onProgress: async ({ phase: current }) => {
					if (interrupt && current === phase) throw new Error("crash");
				},
			});
			await server.installer.install("fixture");
			server.settings.setModelProfile("work", []);
			server.settings.useProfile("work");
			interrupt = true;
			await expect(server.installer.remove("fixture")).rejects.toThrow();
			interrupt = false;
			expect((await server.installer.active("fixture"))?.installed.version).toBe("1.0.0");
			expect(server.settings.getGlobalSettings().packages).toContain("official:fixture");
			expect(await server.settings.officialPackageMembership("fixture", null)).toBe(phase === "remove-journaled");
		},
	);

	it("never selects incompatible or corrupt shared code for another profile", async () => {
		const server = await harness();
		const installed = await server.installer.install("fixture");
		server.settings.setModelProfile("work", []);
		server.settings.useProfile("work");
		server.settings.setPackages([]);
		const incompatible = new OfficialExtensionInstaller(
			{ agentDir: server.agentDir, settingsManager: server.settings, gripVersion: "2.0.0" },
			{ transport: new OfficialTransport(server.fetcher) },
		);
		await expect(incompatible.install("fixture", { offline: true })).rejects.toMatchObject({ code: "incompatible" });
		expect(server.settings.getPackages()).toEqual([]);
		await writeFile(join(installed.path, "src/entry.js"), "corrupt");
		await expect(server.installer.install("fixture", { offline: true })).rejects.toMatchObject({ code: "integrity" });
		expect(server.settings.getPackages()).toEqual([]);
		expect(server.settings.getGlobalSettings().packages).toContain("official:fixture");
	});

	it("installs without executing factories, is idempotent, and retains immutable code on uninstall", async () => {
		const server = await harness();
		const installed = await server.installer.install("fixture");
		expect(await readFile(join(installed.path, "src/asset.txt"), "utf8")).toBe("fixture asset");
		expect(server.settings.getPackages()).toContain("official:fixture");
		expect((await server.installer.install("fixture")).path).toBe(installed.path);
		expect(server.fetcher).toHaveBeenCalledTimes(2);
		await writeFile(join(server.agentDir, "user-config.json"), "user data");
		await server.installer.remove("fixture");
		await server.installer.remove("fixture");
		expect(await server.installer.active("fixture")).toBeNull();
		expect(await server.installer.update("fixture")).toBeNull();
		expect(server.settings.getPackages()).toEqual([
			"npm:untouched",
			{ source: "./manual", extensions: ["entry.ts"] },
		]);
		expect(await readFile(join(installed.path, "src/asset.txt"), "utf8")).toBe("fixture asset");
		expect(await readFile(join(server.agentDir, "user-config.json"), "utf8")).toBe("user data");
	});
	it("updates only to newer compatible stable versions and retains old versions", async () => {
		const server = await harness();
		const first = await server.installer.install("fixture");
		const second = addVersion(server, "1.1.0");
		const incompatible = artifact("fixture", "2.0.0", ">=99");
		server.catalog.extensions[0].releases.push(incompatible.release);
		const updated = await server.installer.update("fixture", { refresh: true });
		expect(updated?.installed.sha256).toBe(second.release.artifact.sha256);
		expect(await readFile(join(first.path, "src/asset.txt"), "utf8")).toBe("fixture asset");
		expect((await server.installer.update("fixture"))?.path).toBe(updated?.path);
	});
	it("rejects incompatible retained code after a core change while permitting a compatible update", async () => {
		const server = await harness();
		const original = artifact("fixture", "1.0.0", ">=0.1.0 <0.2.0");
		server.catalog.extensions[0].releases = [original.release];
		server.artifacts.set(original.release.artifact.url, original.bytes);
		const retained = await server.installer.install("fixture");
		const upgraded = new OfficialExtensionInstaller(
			{ agentDir: server.agentDir, settingsManager: server.settings, gripVersion: "0.2.0" },
			{ transport: new OfficialTransport(server.fetcher) },
		);
		const requests = server.fetcher.mock.calls.length;
		await expect(upgraded.active("fixture")).rejects.toMatchObject({ code: "incompatible" });
		expect(server.fetcher).toHaveBeenCalledTimes(requests);
		expect(await readFile(join(retained.path, "src/asset.txt"), "utf8")).toBe("fixture asset");
		const compatible = artifact("fixture", "1.1.0", ">=0.2.0 <0.3.0");
		server.catalog.extensions[0].releases.push(compatible.release);
		server.artifacts.set(compatible.release.artifact.url, compatible.bytes);
		expect((await upgraded.update("fixture", { refresh: true }))?.installed.version).toBe("1.1.0");
		expect((await upgraded.active("fixture"))?.installed.version).toBe("1.1.0");
		// A downgraded core must not execute the now-incompatible selected version or silently downgrade it.
		await expect(server.installer.active("fixture")).rejects.toMatchObject({ code: "incompatible" });
		expect(await server.settings.officialPackageMembership("fixture", null)).toBe(true);
	});
	it("rejects incompatible, corrupt and offline first installs without adding desired membership", async () => {
		const server = await harness();
		server.catalog.extensions[0].releases[0].manifest.engines.grip = ">=99";
		await expect(server.installer.install("fixture")).rejects.toMatchObject({ code: "incompatible" });
		expect(await server.settings.officialPackageMembership("fixture", null)).toBe(false);
		await expect(server.installer.install("other", { offline: true })).rejects.toMatchObject({
			code: "incompatible",
		});
		const broken = await harness();
		broken.artifacts.set(broken.fixture.release.artifact.url, Buffer.from("corrupt"));
		await expect(broken.installer.install("fixture")).rejects.toThrow();
		expect(await broken.settings.officialPackageMembership("fixture", null)).toBe(false);
		const fresh = await harness();
		await expect(fresh.installer.install("fixture", { offline: true })).rejects.toMatchObject({ code: "offline" });
		expect(fresh.fetcher).not.toHaveBeenCalled();
	});
	it.each(["../../../../escape", "/absolute-escape", "C:/escape", "src/../escape", "src\\escape"])(
		"rejects signed malformed archive path %s before any extraction",
		async (path) => {
			const server = await harness();
			const bytes = gzipSync(
				officialJson({
					schemaVersion: 1,
					manifest: server.fixture.release.manifest,
					files: [{ path, base64: "ZXZpbA==" }],
				}),
			);
			server.fixture.release.artifact.size = bytes.length;
			server.fixture.release.artifact.sha256 = officialSha256(bytes);
			server.artifacts.set(server.fixture.release.artifact.url, bytes);
			await expect(server.installer.install("fixture")).rejects.toThrow();
			expect(await server.settings.officialPackageMembership("fixture", null)).toBe(false);
			expect(await server.installer.active("fixture")).toBeNull();
			await expect(readFile(join(server.agentDir, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
	it.each(["symlink", "hardlink"])("rejects archive %s metadata without creating links", async (type) => {
		const server = await harness();
		const bytes = gzipSync(
			officialJson({
				schemaVersion: 1,
				manifest: server.fixture.release.manifest,
				files: [{ path: "src/link", base64: "", type, linkname: "../../outside" }],
			}),
		);
		server.fixture.release.artifact.size = bytes.length;
		server.fixture.release.artifact.sha256 = officialSha256(bytes);
		server.artifacts.set(server.fixture.release.artifact.url, bytes);
		await expect(server.installer.install("fixture")).rejects.toThrow();
		expect(await server.settings.officialPackageMembership("fixture", null)).toBe(false);
	});
	it("preserves the committed version and membership after a bad update artifact", async () => {
		const server = await harness();
		const previous = await server.installer.install("fixture");
		const next = addVersion(server, "1.1.0");
		server.artifacts.set(next.release.artifact.url, Buffer.from("bad digest"));
		await expect(server.installer.update("fixture", { refresh: true })).rejects.toThrow();
		expect((await server.installer.active("fixture"))?.path).toBe(previous.path);
		expect(await server.settings.officialPackageMembership("fixture", null)).toBe(true);
	});
	it("does not poison a valid catalog cache with invalid discovery and rejects corrupt caches offline", async () => {
		const server = await harness();
		const valid = await server.installer.catalog();
		const path = join(server.agentDir, "official/catalog.json");
		const saved = await readFile(path, "utf8");
		server.fetcher.mockResolvedValue(new Response("not JSON"));
		const fallback = await server.installer.catalog({ refresh: true });
		expect(fallback.catalog).toEqual(valid.catalog);
		expect(fallback.error?.code).toBe("catalog");
		expect(await readFile(path, "utf8")).toBe(saved);
		await writeFile(path, "corrupt cache");
		await expect(server.installer.catalog({ offline: true })).rejects.toMatchObject({ code: "offline" });
	});
	it("uses last valid cached catalog and installation on network errors and offline operation", async () => {
		let now = 1000;
		const server = await harness({ now: () => now });
		const installed = await server.installer.install("fixture");
		now += 86400000;
		server.fetcher.mockRejectedValue(new Error("offline"));
		const catalog = await server.installer.catalog();
		expect(catalog.stale).toBe(true);
		expect(catalog.error?.code).toBe("network");
		expect((await server.installer.install("fixture", { offline: true })).path).toBe(installed.path);
		vi.stubEnv("GRIP_OFFLINE", "1");
		const calls = server.fetcher.mock.calls.length;
		expect((await server.installer.catalog({ refresh: true })).stale).toBe(true);
		expect(server.fetcher).toHaveBeenCalledTimes(calls);
	});
	it.each(["staged", "journaled", "promoted", "membership", "activated"])(
		"recovers initial-install interruption at %s using persisted membership",
		async (phase) => {
			let interrupted = false;
			const server = await harness({
				onProgress: async ({ phase: current }) => {
					if (current === phase && !interrupted) {
						interrupted = true;
						throw new Error("crash");
					}
				},
			});
			await expect(server.installer.install("fixture")).rejects.toThrow();
			const desired = await server.settings.officialPackageMembership("fixture", null);
			expect(desired).toBe(phase === "membership" || phase === "activated");
			expect((await server.installer.active("fixture")) !== null).toBe(desired);
			expect((await server.installer.install("fixture")).installed.version).toBe("1.0.0");
		},
	);
	it.each(["journaled", "promoted", "membership"])(
		"retains/reconciles the last version after interrupted update at %s",
		async (phase) => {
			let interrupt = false;
			const server = await harness({
				onProgress: async ({ phase: current }) => {
					if (interrupt && current === phase) throw new Error("crash");
				},
			});
			const previous = await server.installer.install("fixture");
			addVersion(server, "1.1.0");
			interrupt = true;
			await expect(server.installer.update("fixture", { refresh: true })).rejects.toThrow();
			interrupt = false;
			const active = await server.installer.active("fixture");
			expect(active?.installed.version).toBe(phase === "journaled" ? "1.0.0" : "1.1.0");
			expect(await readFile(join(previous.path, "src/asset.txt"), "utf8")).toBe("fixture asset");
		},
	);
	it.each(["remove-journaled", "removed-membership"])(
		"recovers interrupted remove at %s and never reinstalls absent membership",
		async (phase) => {
			let interrupt = false;
			const server = await harness({
				onProgress: async ({ phase: current }) => {
					if (interrupt && current === phase) throw new Error("crash");
				},
			});
			await server.installer.install("fixture");
			interrupt = true;
			await expect(server.installer.remove("fixture")).rejects.toThrow();
			interrupt = false;
			expect((await server.installer.active("fixture")) !== null).toBe(phase === "remove-journaled");
			await server.installer.remove("fixture");
			expect(await server.installer.update("fixture")).toBeNull();
		},
	);
	it("does not activate when settings persistence fails and recovers on explicit retry", async () => {
		const server = await harness();
		const storage = new FailingStorage();
		const settings = SettingsManager.fromStorage(storage);
		const installer = new OfficialExtensionInstaller(
			{ agentDir: server.agentDir, settingsManager: settings, gripVersion: "0.1.8" },
			{ transport: new OfficialTransport(server.fetcher) },
		);
		storage.fail = true;
		await expect(installer.install("fixture")).rejects.toThrow();
		expect(await settings.officialPackageMembership("fixture", null)).toBe(false);
		storage.fail = false;
		expect(await installer.active("fixture")).toBeNull();
		expect((await installer.install("fixture")).installed.version).toBe("1.0.0");
	});
	it("preserves the pending journal when final state persistence fails", async () => {
		const server = await harness();
		const original = OfficialFileStore.prototype.atomicWrite;
		let failed = false;
		vi.spyOn(OfficialFileStore.prototype, "atomicWrite").mockImplementation(async function (
			this: OfficialFileStore,
			path,
			bytes,
			immutable,
		) {
			if (!failed && path.endsWith("/state.json") && JSON.parse(Buffer.from(bytes).toString()).active !== null) {
				failed = true;
				throw new Error("disk failure");
			}
			return original.call(this, path, bytes, immutable);
		});
		await expect(server.installer.install("fixture")).rejects.toThrow();
		const state = await readOfficialState(server.agentDir, "fixture");
		expect(state.state?.active).toBeNull();
		expect(state.state?.pending?.operation).toBe("install");
		expect((await server.installer.active("fixture"))?.installed.version).toBe("1.0.0");
	});
	it("keeps two IDs independent under concurrent installs and serializes update versus removal", async () => {
		const server = await harness();
		const other = artifact("other");
		server.catalog.extensions.push({ id: "other", releases: [other.release] });
		server.artifacts.set(other.release.artifact.url, other.bytes);
		await Promise.all([server.installer.install("fixture"), server.installer.install("other")]);
		addVersion(server, "1.1.0");
		await Promise.all([server.installer.update("fixture", { refresh: true }), server.installer.remove("fixture")]);
		expect(await server.installer.active("fixture")).toBeNull();
		expect((await server.installer.active("other"))?.installed.version).toBe("1.0.0");
		await Promise.all([server.installer.install("fixture"), server.installer.install("fixture")]);
		expect(server.settings.getPackages().filter((entry) => entry === "official:fixture")).toHaveLength(1);
	});
	it("rejects symlink parents, linked files and modified files", async () => {
		const server = await harness();
		const outside = await temporary();
		await mkdir(join(server.agentDir, "official"));
		await symlink(outside, join(server.agentDir, "official", "fixture"), "dir");
		await expect(server.installer.install("fixture")).rejects.toMatchObject({ code: "filesystem" });
		await rm(join(server.agentDir, "official", "fixture"));
		const installed = await server.installer.install("fixture");
		const entry = join(installed.path, "src/entry.js");
		await rename(entry, join(outside, "entry.js"));
		await symlink(join(outside, "entry.js"), entry);
		await expect(server.installer.active("fixture")).rejects.toMatchObject({ code: "filesystem" });
		await rm(entry);
		await link(join(outside, "entry.js"), entry);
		await expect(server.installer.active("fixture")).rejects.toMatchObject({ code: "filesystem" });
		await rm(entry);
		await writeFile(entry, "modified");
		await expect(server.installer.active("fixture")).rejects.toMatchObject({ code: "integrity" });
	});
	it("rejects extra installed content and linked state without granting deletion rights", async () => {
		const server = await harness();
		const installed = await server.installer.install("fixture");
		const extra = join(installed.path, "extra.js");
		await writeFile(extra, "extra");
		await expect(server.installer.active("fixture")).rejects.toMatchObject({ code: "integrity" });
		await rm(extra);
		const state = join(server.agentDir, "official/fixture/state.json");
		const outside = join(await temporary(), "state.json");
		await rename(state, outside);
		await symlink(outside, state);
		await expect(server.installer.active("fixture")).rejects.toMatchObject({ code: "state" });
		await server.installer.remove("fixture");
		expect(await readFile(outside, "utf8")).toContain('"active"');
		expect(await server.settings.officialPackageMembership("fixture", null)).toBe(false);
	});
	it("pins the configured agent directory identity across replacement", async () => {
		const root = await temporary();
		const files = await OfficialFileStore.create(root);
		const moved = join(await temporary(), "moved");
		await rename(root, moved);
		await mkdir(root);
		await expect(files.writeNew("official/escape", Buffer.from("bad"))).rejects.toMatchObject({ code: "filesystem" });
		await expect(readFile(join(root, "official/escape"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("removes desired membership but never changes corrupt/unowned state or manual source files", async () => {
		const server = await harness();
		const installed = await server.installer.install("fixture");
		const path = join(server.agentDir, "official/fixture/state.json");
		await writeFile(path, "not state");
		await server.installer.remove("fixture");
		expect(await readFile(path, "utf8")).toBe("not state");
		expect(await readFile(join(installed.path, "src/asset.txt"), "utf8")).toBe("fixture asset");
		expect(await server.settings.officialPackageMembership("fixture", null)).toBe(false);
	});
	it("waits on another process's live lock, honors cancellation, then installs after release", async () => {
		const server = await harness();
		const root = join(server.agentDir, "official/fixture");
		await mkdir(root, { recursive: true });
		const child = fork(fileURLToPath(new URL("./fixtures/official-lock-holder.mjs", import.meta.url)), [root], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		try {
			await once(child, "message", { signal: AbortSignal.timeout(3000) });
			await expect(server.installer.install("fixture", { signal: AbortSignal.timeout(30) })).rejects.toThrow();
			expect(await server.settings.officialPackageMembership("fixture", null)).toBe(false);
			const exited = once(child, "exit", { signal: AbortSignal.timeout(3000) });
			child.send("release");
			await exited;
			expect((await server.installer.install("fixture")).installed.version).toBe("1.0.0");
		} finally {
			if (child.exitCode === null) child.kill();
		}
	});
	it("recovers a stale cross-process lock", async () => {
		const server = await harness();
		const path = join(server.agentDir, "official/fixture.lock");
		await mkdir(path, { recursive: true });
		const old = new Date(Date.now() - 60000);
		await utimes(path, old, old);
		expect((await server.installer.install("fixture")).installed.version).toBe("1.0.0");
	});
});

describe("conflict-safe official desired membership", () => {
	it("re-reads profile membership under lock and preserves other profiles and settings", async () => {
		const root = await temporary();
		await writeFile(
			join(root, "settings.json"),
			JSON.stringify({
				packages: ["official:fixture"],
				profiles: { work: { packages: [], theme: "dark" }, personal: { packages: [] } },
			}),
		);
		const first = SettingsManager.create(root, root);
		const second = SettingsManager.create(root, root);
		first.useProfile("work");
		second.useProfile("work");
		await first.officialPackageMembership("fixture", true);
		await second.officialPackageMembership("other", true);
		first.useProfile("personal");
		await first.officialPackageMembership("third", true);
		const fresh = SettingsManager.create(root, root);
		expect(fresh.getGlobalSettings().packages).toEqual(["official:fixture"]);
		expect(fresh.getProfile("work")).toEqual({ packages: ["official:fixture", "official:other"], theme: "dark" });
		expect(fresh.getProfile("personal")?.packages).toEqual(["official:third"]);
		await second.officialPackageMembership("fixture", false);
		expect(await second.officialPackageMembership("fixture", null)).toBe(false);
		expect(await second.hasOfficialPackageReferences("fixture")).toBe(true);
	});

	it("captures the profile before awaiting queued writes", async () => {
		const settings = SettingsManager.inMemory({ profiles: { work: { packages: [] }, personal: { packages: [] } } });
		settings.useProfile("work");
		const pending = settings.officialPackageMembership("fixture", true);
		settings.useProfile("personal");
		await pending;
		expect(settings.getPackages()).toEqual([]);
		expect(settings.getProfile("work")?.packages).toEqual(["official:fixture"]);
		expect(await settings.hasOfficialPackageReferences("fixture")).toBe(true);
	});

	it("re-reads persisted packages across stale managers, preserves filters and unrelated settings", async () => {
		const root = await temporary();
		const first = SettingsManager.create(root, root);
		const second = SettingsManager.create(root, root);
		first.setPackages(["npm:manual", { source: "official:fixture", extensions: ["!entry.js"] }]);
		first.setTheme("dark");
		await first.flush();
		await Promise.all([
			first.officialPackageMembership("other", true),
			second.officialPackageMembership("third", true),
		]);
		await second.officialPackageMembership("fixture", true);
		const persisted = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
		expect(persisted.packages).toEqual([
			"npm:manual",
			{ source: "official:fixture", extensions: ["!entry.js"] },
			"official:other",
			"official:third",
		]);
		expect(persisted.theme).toBe("dark");
		await first.officialPackageMembership("other", false);
		await second.officialPackageMembership("fixture", false);
		expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8")).packages).toEqual([
			"npm:manual",
			"official:third",
		]);
	});
	it("preserves intentional settings symlinks and coordinates writes through the canonical target", async () => {
		const root = await temporary();
		const canonical = await temporary();
		const target = join(canonical, "settings.json");
		const alias = join(root, "settings.json");
		await writeFile(target, JSON.stringify({ packages: ["npm:manual"], theme: "dark" }));
		await symlink(target, alias);
		const first = SettingsManager.create(root, root);
		const second = SettingsManager.create(canonical, canonical);
		await Promise.all([
			first.officialPackageMembership("fixture", true),
			second.officialPackageMembership("other", true),
		]);
		expect((await lstat(alias)).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
			packages: ["npm:manual", "official:fixture", "official:other"],
			theme: "dark",
		});
	});
	it("refuses malformed persisted settings rather than replacing them", async () => {
		const root = await temporary();
		const settings = SettingsManager.create(root, root);
		for (const content of ["{", '{"packages":{}}', '{"packages":[null]}']) {
			await writeFile(join(root, "settings.json"), content);
			await expect(settings.officialPackageMembership("fixture", true)).rejects.toThrow();
			expect(await readFile(join(root, "settings.json"), "utf8")).toBe(content);
		}
	});
});
