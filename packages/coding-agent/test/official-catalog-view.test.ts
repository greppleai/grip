import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { officialJson } from "../src/core/official-artifact.ts";
import {
	OFFICIAL_CATALOG_URL,
	OFFICIAL_REPOSITORY,
	type OfficialCatalog,
	type OfficialRelease,
	parseOfficialRelease,
} from "../src/core/official-catalog.ts";
import { describeOfficialCatalog } from "../src/core/official-catalog-view.ts";
import { OfficialTransport } from "../src/core/official-transport.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function release(version: string, grip = "*"): OfficialRelease {
	return parseOfficialRelease(
		{
			manifest: {
				name: "official-fixture",
				version,
				description: `Fixture ${version}`,
				type: "module",
				engines: { grip },
				grip: { official: { id: "fixture", displayName: `Fixture ${version}` }, extensions: ["entry.js"] },
			},
			sourceCommit: "a".repeat(40),
			tag: `extension-fixture-v${version}`,
			artifact: {
				url: `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/extension-fixture-v${version}/fixture-${version}.json.gz`,
				size: 1,
				sha256: "a".repeat(64),
			},
		},
		"fixture",
	);
}

async function harness() {
	vi.stubEnv("GRIP_OFFLINE", "0");
	const agentDir = await mkdtemp(join(tmpdir(), "grip-catalog-view-"));
	directories.push(agentDir);
	const settings = SettingsManager.inMemory({
		officialExtensions: { autoUpdate: false, catalogMaxAgeMs: 20, requestTimeoutMs: 50 },
	});
	const catalog: OfficialCatalog = {
		schemaVersion: 1,
		repository: OFFICIAL_REPOSITORY,
		extensions: [{ id: "fixture", releases: [release("1.0.0")] }],
	};
	let now = 100;
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		expect(String(input)).toBe(OFFICIAL_CATALOG_URL);
		return new Response(officialJson(catalog));
	});
	const manager = new DefaultPackageManager({
		cwd: agentDir,
		agentDir,
		settingsManager: settings,
		officialDependencies: { transport: new OfficialTransport(fetcher), now: () => now },
	});
	return {
		agentDir,
		settings,
		catalog,
		fetcher,
		manager,
		advance: () => {
			now += 21;
		},
	};
}

describe("official catalog browsing", () => {
	it("selects compatible stable metadata rather than the newest incompatible or prerelease metadata", () => {
		const catalog: OfficialCatalog = {
			schemaVersion: 1,
			repository: OFFICIAL_REPOSITORY,
			extensions: [
				{
					id: "fixture",
					releases: [release("2.0.0", ">=99"), release("1.1.0"), release("3.0.0-beta.1"), release("1.0.0")],
				},
			],
		};
		const view = describeOfficialCatalog({
			result: { catalog, fetchedAt: 100, stale: false, error: null },
			gripVersion: VERSION,
			offline: false,
		});
		expect(view.extensions[0]).toMatchObject({
			id: "fixture",
			manifest: {
				version: "1.1.0",
				description: "Fixture 1.1.0",
				grip: { official: { displayName: "Fixture 1.1.0" } },
			},
			compatibleVersion: "1.1.0",
			unavailableReason: null,
		});
		view.extensions[0].manifest!.grip.extensions[0] = "modified.js";
		expect(catalog.extensions[0].releases[1].manifest.grip.extensions).toEqual(["entry.js"]);
	});

	it("retains incompatible, prerelease-only, and unpublished entries without inventing installable versions", () => {
		for (const releases of [[release("2.0.0", ">=99"), release("1.0.0", ">=98")], [release("3.0.0-beta.1")], []]) {
			const view = describeOfficialCatalog({
				result: {
					catalog: {
						schemaVersion: 1,
						repository: OFFICIAL_REPOSITORY,
						extensions: [{ id: "fixture", releases }],
					},
					fetchedAt: 100,
					stale: false,
					error: null,
				},
				gripVersion: VERSION,
				offline: false,
			});
			expect(view.extensions[0].compatibleVersion).toBeNull();
			expect(view.extensions[0].manifest?.version ?? null).toBe(releases.length === 2 ? "2.0.0" : null);
			expect(view.extensions[0].unavailableReason).toContain(
				releases.length === 2 ? `Grip ${VERSION}` : "No published stable release",
			);
		}
	});

	it("browses with no installed extensions despite auto-update opt-out and a latched disabled startup", async () => {
		const h = await harness();
		await h.manager.startupOfficialUpdates(true);
		const view = await h.manager.getOfficialCatalog();
		expect(view.extensions[0].compatibleVersion).toBe("1.0.0");
		expect(h.fetcher).toHaveBeenCalledTimes(1);
		expect(h.settings.getPackages()).toEqual([]);
		expect(await readdir(join(h.agentDir, "official"))).toEqual(["catalog.json"]);
	});

	it("supports an intentionally empty production catalog", async () => {
		const h = await harness();
		h.catalog.extensions = [];
		expect(await h.manager.getOfficialCatalog()).toMatchObject({
			extensions: [],
			stale: false,
			error: null,
			offline: false,
		});
	});

	it("uses configured freshness, offline cache, and explicit refresh without allowing an offline override", async () => {
		const h = await harness();
		await h.manager.getOfficialCatalog();
		h.catalog.extensions[0].releases.push(release("1.1.0"));
		expect((await h.manager.getOfficialCatalog()).extensions[0].compatibleVersion).toBe("1.0.0");
		h.advance();
		vi.stubEnv("GRIP_OFFLINE", "yes");
		expect(await h.manager.getOfficialCatalog({ offline: false, refresh: true })).toMatchObject({
			stale: true,
			offline: true,
			error: null,
		});
		expect(h.fetcher).toHaveBeenCalledTimes(1);
		vi.stubEnv("GRIP_OFFLINE", "0");
		expect((await h.manager.getOfficialCatalog()).extensions[0].compatibleVersion).toBe("1.1.0");
		expect(h.fetcher).toHaveBeenCalledTimes(2);
		await h.manager.getOfficialCatalog({ refresh: true });
		expect(h.fetcher).toHaveBeenCalledTimes(3);
	});

	it("preserves cached metadata and actionable failure details when refresh fails", async () => {
		const h = await harness();
		await h.manager.getOfficialCatalog();
		h.fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
		const view = await h.manager.getOfficialCatalog({ refresh: true });
		expect(view.extensions[0].compatibleVersion).toBe("1.0.0");
		expect(view.stale).toBe(true);
		expect(view.error).toMatchObject({ code: "http", message: "Official download returned HTTP 503" });
	});

	it("rejects offline discovery without cache and canceled discovery before any request", async () => {
		const h = await harness();
		await expect(h.manager.getOfficialCatalog({ offline: true })).rejects.toMatchObject({ code: "offline" });
		const controller = new AbortController();
		controller.abort(new Error("Canceled catalog browsing"));
		await expect(h.manager.getOfficialCatalog({ signal: controller.signal })).rejects.toThrow(
			"Canceled catalog browsing",
		);
		expect(h.fetcher).not.toHaveBeenCalled();
	});

	it("honors the configured request timeout without requiring transport cooperation", async () => {
		const h = await harness();
		h.fetcher.mockImplementation(() => new Promise<Response>(() => {}));
		await expect(h.manager.getOfficialCatalog()).rejects.toMatchObject({
			code: "canceled",
			message: "Official download canceled or timed out",
		});
		expect(h.fetcher).toHaveBeenCalledTimes(1);
	});
});
