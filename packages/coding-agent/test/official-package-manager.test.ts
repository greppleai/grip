import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { encodeOfficialArtifact, officialJson, officialSha256 } from "../src/core/official-artifact.ts";
import {
	OFFICIAL_CATALOG_URL,
	OFFICIAL_REPOSITORY,
	type OfficialCatalog,
	type OfficialRelease,
	type OfficialResources,
	parseOfficialManifest,
} from "../src/core/official-catalog.ts";
import { OfficialTransport } from "../src/core/official-transport.ts";
import { DefaultPackageManager, type ProgressEvent } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

const directories: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(
	entrySource = 'throw new Error("Must not execute during management or resolution"); export default () => {};',
	resourceFiles: Record<string, string> = {},
	resources: Pick<OfficialResources, "skills" | "rules" | "prompts" | "themes"> = {
		skills: [],
		rules: [],
		prompts: [],
		themes: [],
	},
) {
	const agentDir = await mkdtemp(join(tmpdir(), "grip-official-package-"));
	directories.push(agentDir);
	const settings = SettingsManager.inMemory();
	const artifacts = new Map<string, Buffer>();
	const catalog: OfficialCatalog = {
		schemaVersion: 1,
		repository: OFFICIAL_REPOSITORY,
		extensions: [{ id: "fixture", releases: [] }],
	};
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url === OFFICIAL_CATALOG_URL) return new Response(officialJson(catalog));
		const bytes = artifacts.get(url);
		if (!bytes) throw new Error(`Unexpected fixture request: ${url}`);
		return new Response(new Uint8Array(bytes));
	});
	const manager = new DefaultPackageManager({
		cwd: agentDir,
		agentDir,
		settingsManager: settings,
		officialDependencies: { transport: new OfficialTransport(fetcher) },
	});
	function publish(version: string) {
		const manifest = parseOfficialManifest(
			{
				name: "official-fixture",
				version,
				description: "Fixture",
				type: "module",
				engines: { grip: ">=0.1.0 <1" },
				grip: { official: { id: "fixture", displayName: "Fixture" }, extensions: ["entry.js"], ...resources },
			},
			"fixture",
		);
		const files = [
			{ path: "package.json", base64: Buffer.from(officialJson(manifest)).toString("base64") },
			{
				path: "entry.js",
				base64: Buffer.from(entrySource).toString("base64"),
			},
			...Object.entries(resourceFiles).map(([path, content]) => ({
				path,
				base64: Buffer.from(content).toString("base64"),
			})),
		];
		const bytes = encodeOfficialArtifact({ schemaVersion: 1, manifest, files });
		const release: OfficialRelease = {
			manifest,
			sourceCommit: "a".repeat(40),
			tag: `extension-fixture-v${version}`,
			artifact: {
				url: `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/extension-fixture-v${version}/fixture-${version}.json.gz`,
				size: bytes.length,
				sha256: officialSha256(bytes),
			},
		};
		catalog.extensions[0].releases.push(release);
		artifacts.set(release.artifact.url, bytes);
	}
	publish("1.0.0");
	return { agentDir, settings, manager, fetcher, publish };
}

describe("official mutation controls through the canonical manager", () => {
	it("reports per-operation phases without leaking observers into later operations", async () => {
		const h = await harness();
		const progress = vi.fn();
		const lifecycle: ProgressEvent[] = [];
		h.manager.setProgressCallback((event) => lifecycle.push(event));
		await h.manager.installAndPersist("official:fixture", { official: { onProgress: progress } });
		expect(progress.mock.calls.map(([event]) => event.phase)).toEqual([
			"downloading",
			"verifying",
			"staged",
			"journaled",
			"promoted",
			"membership",
			"activated",
		]);
		for (const [event] of progress.mock.calls) expect(event.id).toBe("fixture");
		progress.mockClear();
		await h.manager.removeAndPersist("official:fixture", { official: { onProgress: progress } });
		expect(progress.mock.calls.map(([event]) => event.phase)).toEqual([
			"remove-journaled",
			"removed-membership",
			"removed",
		]);
		progress.mockClear();
		await h.manager.installAndPersist("official:fixture");
		expect(progress).not.toHaveBeenCalled();
		expect(lifecycle.map((event) => event.type)).toEqual([
			"start",
			"complete",
			"start",
			"complete",
			"start",
			"complete",
		]);
	});
	it("rejects pre-canceled installs and removals without changing membership or retained files", async () => {
		const h = await harness();
		const controller = new AbortController();
		controller.abort();
		await expect(
			h.manager.installAndPersist("official:fixture", { official: { signal: controller.signal } }),
		).rejects.toThrow();
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.settings.getPackages()).toEqual([]);
		await h.manager.installAndPersist("official:fixture");
		const path = await h.manager.getInstalledPath("official:fixture", "user");
		await expect(
			h.manager.removeAndPersist("official:fixture", { official: { signal: controller.signal } }),
		).rejects.toThrow();
		expect(h.settings.getPackages()).toEqual(["official:fixture"]);
		expect(await h.manager.getInstalledPath("official:fixture", "user")).toBe(path);
		expect(await readFile(join(path!, "entry.js"), "utf8")).toContain("Must not execute");
	});
	it("forwards cancellation to an in-flight artifact request and permits retry", async () => {
		const h = await harness();
		await h.manager.getOfficialCatalog();
		const controller = new AbortController();
		h.fetcher.mockImplementationOnce(async (_input, init) => {
			controller.abort();
			expect(init?.signal?.aborted).toBe(true);
			throw controller.signal.reason;
		});
		await expect(
			h.manager.installAndPersist("official:fixture", { official: { signal: controller.signal } }),
		).rejects.toMatchObject({ code: "canceled" });
		expect(h.settings.getPackages()).toEqual([]);
		expect(await h.manager.getInstalledPath("official:fixture", "user")).toBeUndefined();
		await h.manager.installAndPersist("official:fixture");
		expect(h.settings.getPackages()).toEqual(["official:fixture"]);
	});
	it.each(["downloading", "verifying", "staged", "journaled", "promoted"])(
		"cancels at %s before membership and recovers cleanly for retry",
		async (phase) => {
			const h = await harness();
			const controller = new AbortController();
			await expect(
				h.manager.installAndPersist("official:fixture", {
					official: {
						signal: controller.signal,
						onProgress: (event) => {
							if (event.phase === phase) controller.abort();
						},
					},
				}),
			).rejects.toThrow();
			expect(h.settings.getPackages()).toEqual([]);
			expect(await h.manager.getInstalledPath("official:fixture", "user")).toBeUndefined();
			await h.manager.installAndPersist("official:fixture");
			expect((await h.manager.listConfiguredPackages())[0].version).toBe("1.0.0");
		},
	);
	it("keeps cancellation after committed membership recoverable instead of claiming rollback", async () => {
		const h = await harness();
		const install = new AbortController();
		await expect(
			h.manager.installAndPersist("official:fixture", {
				official: {
					signal: install.signal,
					onProgress: (event) => {
						if (event.phase === "membership") install.abort();
					},
				},
			}),
		).rejects.toThrow();
		expect(h.settings.getPackages()).toEqual(["official:fixture"]);
		const path = await h.manager.getInstalledPath("official:fixture", "user");
		expect(path).toBeTruthy();
		const remove = new AbortController();
		await expect(
			h.manager.removeAndPersist("official:fixture", {
				official: {
					signal: remove.signal,
					onProgress: (event) => {
						if (event.phase === "removed-membership") remove.abort();
					},
				},
			}),
		).rejects.toThrow();
		expect(h.settings.getPackages()).toEqual([]);
		expect(await h.manager.getInstalledPath("official:fixture", "user")).toBeUndefined();
		expect(await readFile(join(path!, "entry.js"), "utf8")).toContain("Must not execute");
	});
	it("cancels removal before membership while preserving configuration, data and manual files", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		const manual = join(h.agentDir, "manual.js");
		const data = join(h.agentDir, "fixture-data.json");
		await writeFile(manual, "manual source");
		await writeFile(data, "user data");
		h.settings.setPackages([{ source: "official:fixture", extensions: [] }, manual]);
		const packages = h.settings.getPackages();
		const controller = new AbortController();
		await expect(
			h.manager.removeAndPersist("official:fixture", {
				official: {
					signal: controller.signal,
					onProgress: (event) => {
						if (event.phase === "remove-journaled") controller.abort();
					},
				},
			}),
		).rejects.toThrow();
		expect(h.settings.getPackages()).toEqual(packages);
		expect(await h.manager.getInstalledPath("official:fixture", "user")).toBeTruthy();
		await h.manager.removeAndPersist("official:fixture");
		expect(h.settings.getPackages()).toEqual([manual]);
		expect(await readFile(manual, "utf8")).toBe("manual source");
		expect(await readFile(data, "utf8")).toBe("user data");
	});
	it("isolates presentation observer errors while preserving the injected transaction seam", async () => {
		const h = await harness();
		const observer = vi.fn(() => {
			throw new Error("Disposed view");
		});
		await h.manager.installAndPersist("official:fixture", { official: { onProgress: observer } });
		expect(observer).toHaveBeenCalledTimes(7);
		expect(h.settings.getPackages()).toEqual(["official:fixture"]);
		await h.manager.removeAndPersist("official:fixture");
		const manager = new DefaultPackageManager({
			cwd: h.agentDir,
			agentDir: h.agentDir,
			settingsManager: h.settings,
			officialDependencies: {
				transport: new OfficialTransport(h.fetcher),
				onProgress: async (event) => {
					if (event.phase === "promoted") throw new Error("Injected interruption");
				},
			},
		});
		await expect(manager.installAndPersist("official:fixture")).rejects.toThrow();
		expect(h.settings.getPackages()).toEqual([]);
	});
	it("honors explicit offline management and cannot override environment-offline", async () => {
		const h = await harness();
		await h.manager.getOfficialCatalog();
		await expect(
			h.manager.installAndPersist("official:fixture", { official: { offline: true } }),
		).rejects.toMatchObject({ code: "offline" });
		vi.stubEnv("GRIP_OFFLINE", "yes");
		await expect(
			h.manager.installAndPersist("official:fixture", { official: { offline: false } }),
		).rejects.toMatchObject({ code: "offline" });
		expect(h.fetcher).toHaveBeenCalledTimes(1);
		expect(h.settings.getPackages()).toEqual([]);
	});
});

describe("official packages through the canonical manager", () => {
	it("installs, lists, resolves, updates and removes without executing bundled code", async () => {
		const h = await harness();
		const events: ProgressEvent[] = [];
		h.manager.setProgressCallback((event) => events.push(event));
		await h.manager.installAndPersist("official:fixture");
		expect(h.settings.getPackages()).toEqual(["official:fixture"]);
		const path = await h.manager.getInstalledPath("official:fixture", "user");
		expect(path).toBeTruthy();
		expect(await h.manager.listConfiguredPackages()).toEqual([
			{
				source: "official:fixture",
				scope: "user",
				filtered: false,
				identity: "official:fixture",
				managed: true,
				installedPath: path,
				version: "1.0.0",
				error: null,
			},
		]);
		const resolved = await h.manager.resolve();
		expect(resolved.extensions).toEqual([
			{
				path: join(path!, "entry.js"),
				enabled: true,
				metadata: {
					source: "official:fixture",
					scope: "user",
					origin: "package",
					baseDir: path,
					official: { id: "fixture", version: "1.0.0" },
				},
			},
		]);
		h.publish("1.1.0");
		await h.manager.update("official:fixture");
		const updated = await h.manager.getInstalledPath("official:fixture", "user");
		expect(updated).not.toBe(path);
		expect((await h.manager.listConfiguredPackages())[0].version).toBe("1.1.0");
		expect(await h.manager.removeAndPersist("official:fixture")).toBe(true);
		expect(await h.manager.removeAndPersist("official:fixture")).toBe(false);
		expect(await h.manager.getInstalledPath("official:fixture", "user")).toBeUndefined();
		expect((await h.manager.resolve()).extensions).toEqual([]);
		expect(await readFile(join(path!, "entry.js"), "utf8")).toContain("Must not execute");
		expect(events.filter((event) => event.type === "complete").map((event) => event.action)).toEqual([
			"install",
			"update",
			"remove",
			"remove",
		]);
	});
	it("keeps missing configuration visible and never implicitly installs it on resolve", async () => {
		const h = await harness();
		h.settings.setPackages(["official:fixture"]);
		expect((await h.manager.listConfiguredPackages())[0]).toMatchObject({
			source: "official:fixture",
			version: null,
			error: null,
		});
		expect((await h.manager.resolve()).extensions).toEqual([]);
		expect(h.fetcher).not.toHaveBeenCalled();
	});
	it("rejects project and temporary sources and guards synchronous membership helpers", async () => {
		const h = await harness();
		await expect(h.manager.installAndPersist("official:fixture", { local: true })).rejects.toThrow(
			"global installation only",
		);
		await expect(h.manager.removeAndPersist("official:fixture", { local: true })).rejects.toThrow(
			"global installation only",
		);
		await expect(h.manager.getInstalledPath("official:fixture", "project")).rejects.toThrow(
			"global installation only",
		);
		await expect(h.manager.resolveExtensionSources(["official:fixture"], { temporary: true })).rejects.toThrow(
			"global installation only",
		);
		expect(() => h.manager.addSourceToSettings("official:fixture")).toThrow("transactional");
		expect(() => h.manager.removeSourceFromSettings("official:fixture")).toThrow("transactional");
		expect(h.fetcher).not.toHaveBeenCalled();
	});
	it("applies filters without discovering undeclared resources, and offline updates do not fetch", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		h.settings.setPackages([{ source: "official:fixture", extensions: [], skills: ["**"] }]);
		const resources = await h.manager.resolve();
		expect(resources.extensions[0].enabled).toBe(false);
		expect(resources.skills).toEqual([]);
		const requests = h.fetcher.mock.calls.length;
		vi.stubEnv("GRIP_OFFLINE", "yes");
		await h.manager.update("official:fixture");
		expect(h.fetcher).toHaveBeenCalledTimes(requests);
	});
	it("retains corrupt and invalid-scope records in list diagnostics instead of hiding them", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		const path = await h.manager.getInstalledPath("official:fixture", "user");
		await writeFile(join(path!, "entry.js"), "modified");
		h.settings.setProjectPackages(["official:fixture"]);
		const listed = await h.manager.listConfiguredPackages();
		expect(listed).toHaveLength(2);
		expect(listed[0].error).toBeTruthy();
		expect(listed[0].installedPath).toBeUndefined();
		expect(listed[1].error).toContain("global installation only");
	});
	it("isolates invalid configured scopes and malformed identities before deduplication", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		h.settings.setPackages(["official:../bad", "official:fixture"]);
		h.settings.setProjectPackages(["official:fixture"]);
		const resolved = await h.manager.resolve();
		expect(resolved.extensions).toHaveLength(1);
		expect(resolved.extensions[0].metadata.scope).toBe("user");
		expect(resolved.diagnostics).toHaveLength(2);
		expect(resolved.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "official:fixture",
					scope: "project",
					error: expect.stringContaining("global installation only"),
				}),
				expect.objectContaining({ source: "official:../bad", scope: "user" }),
			]),
		);
	});
	it("isolates corrupt selections while resolving unrelated local resources", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		const path = await h.manager.getInstalledPath("official:fixture", "user");
		await writeFile(join(path!, "entry.js"), "modified");
		const local = join(h.agentDir, "manual.js");
		await writeFile(local, "export default () => {};");
		h.settings.setPackages(["official:fixture", local]);
		const resolved = await h.manager.resolve();
		expect(resolved.extensions.map((entry) => entry.path)).toEqual([local]);
		expect(resolved.diagnostics).toEqual([{ source: "official:fixture", scope: "user", error: expect.any(String) }]);
		expect(h.settings.getPackages()).toContain("official:fixture");
	});
	it("loads verified factories once per reload through the shared runtime and honors disabled package filters", async () => {
		const markerDir = await mkdtemp(join(tmpdir(), "grip-official-executions-"));
		directories.push(markerDir);
		const marker = join(markerDir, "executions");
		const h = await harness(
			`import { appendFileSync } from "node:fs"; export default () => appendFileSync(${JSON.stringify(marker)}, "loaded\\n");`,
		);
		await h.manager.installAndPersist("official:fixture");
		const loader = new DefaultResourceLoader({ cwd: h.agentDir, agentDir: h.agentDir, settingsManager: h.settings });
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(1);
		expect(loader.getExtensions().extensions[0].sourceInfo).toMatchObject({
			source: "official:fixture",
			scope: "user",
			origin: "package",
			official: { id: "fixture", version: "1.0.0" },
		});
		expect(await readFile(marker, "utf8")).toBe("loaded\n");
		await loader.reload();
		expect(await readFile(marker, "utf8")).toBe("loaded\nloaded\n");
		h.settings.setPackages([{ source: "official:fixture", extensions: [] }]);
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(await readFile(marker, "utf8")).toBe("loaded\nloaded\n");
		expect((await h.manager.listConfiguredPackages())[0].version).toBe("1.0.0");
		expect(h.fetcher).toHaveBeenCalledTimes(2);
	});
	it("reports configured resolution failures while loading unrelated factories on initial load and reload", async () => {
		const h = await harness("export default () => {};");
		await h.manager.installAndPersist("official:fixture");
		h.settings.setPackages(["official:../bad", "official:fixture"]);
		h.settings.setProjectPackages(["official:fixture"]);
		const loader = new DefaultResourceLoader({ cwd: h.agentDir, agentDir: h.agentDir, settingsManager: h.settings });
		await loader.reload();
		expect(loader.getExtensions().extensions).toHaveLength(1);
		expect(loader.getExtensions().errors).toHaveLength(2);
		expect(loader.getExtensions().errors).toContainEqual({
			path: "official:fixture",
			error: expect.stringContaining("project:"),
			sourceInfo: { path: "official:fixture", source: "official:fixture", scope: "project", origin: "package" },
		});
		const path = await h.manager.getInstalledPath("official:fixture", "user");
		await writeFile(join(path!, "entry.js"), "modified");
		const local = join(h.agentDir, "safe.js");
		await writeFile(local, "export default () => {};");
		h.settings.setPackages(["official:fixture", local]);
		h.settings.setProjectPackages([]);
		await loader.reload();
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([local]);
		expect(loader.getExtensions().errors).toEqual([
			{
				path: "official:fixture",
				error: expect.stringContaining("user:"),
				sourceInfo: { path: "official:fixture", source: "official:fixture", scope: "user", origin: "package" },
			},
		]);
	});
	it("does not execute selected official factories under noExtensions, while management stays available", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		const loader = new DefaultResourceLoader({
			cwd: h.agentDir,
			agentDir: h.agentDir,
			settingsManager: h.settings,
			noExtensions: true,
		});
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(loader.getExtensions().errors).toEqual([]);
		expect((await h.manager.listConfiguredPackages())[0].version).toBe("1.0.0");
		await h.manager.removeAndPersist("official:fixture");
		await loader.reload();
		expect(loader.getExtensions().extensions).toEqual([]);
		expect(h.settings.getPackages()).toEqual([]);
	});
	it("exposes verified import failure provenance before loader overrides without claiming versions for missing selections", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		h.settings.setPackages(["official:fixture", "official:missing"]);
		const override = vi.fn((base: LoadExtensionsResult) => {
			expect(base.errors[0].sourceInfo).toMatchObject({
				source: "official:fixture",
				scope: "user",
				origin: "package",
				official: { id: "fixture", version: "1.0.0" },
			});
			return base;
		});
		const loader = new DefaultResourceLoader({
			cwd: h.agentDir,
			agentDir: h.agentDir,
			settingsManager: h.settings,
			extensionsOverride: override,
		});
		await loader.reload();
		expect(override).toHaveBeenCalledTimes(1);
		const errors = loader.getExtensions().errors;
		expect(errors).toHaveLength(2);
		expect(errors[0].sourceInfo.path).toBe(
			join((await h.manager.getInstalledPath("official:fixture", "user"))!, "entry.js"),
		);
		expect(errors[1].sourceInfo).toMatchObject({
			path: "official:missing",
			source: "official:missing",
			scope: "user",
			origin: "package",
		});
		expect(errors[1].sourceInfo.official).toBeUndefined();
		expect(h.fetcher).toHaveBeenCalledTimes(2);
	});
	it.each([false, true])(
		"loads only declared resources and honors their filters with noExtensions=%s",
		async (noExtensions) => {
			const theme = await readFile(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8");
			const h = await harness(
				"export default () => {};",
				{
					"skills/declared/SKILL.md": "---\nname: fixture-skill\ndescription: Fixture skill\n---\nSkill body",
					"skills/hidden/SKILL.md": "---\nname: hidden-skill\ndescription: Undeclared\n---\nMust not discover",
					"rules/declared/RULES.md": "---\nname: fixture-rule\ndescription: Fixture rule\n---\nRule body",
					"prompts/fixture-prompt.md": "---\ndescription: Fixture prompt\n---\nPrompt body",
					"themes/fixture.json": theme,
				},
				{
					skills: ["skills/declared/SKILL.md"],
					rules: ["rules/declared/RULES.md"],
					prompts: ["prompts/fixture-prompt.md"],
					themes: ["themes/fixture.json"],
				},
			);
			await h.manager.installAndPersist("official:fixture");
			const loader = new DefaultResourceLoader({
				cwd: h.agentDir,
				agentDir: h.agentDir,
				settingsManager: h.settings,
				noExtensions,
			});
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions).toHaveLength(noExtensions ? 0 : 1);
			expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["fixture-skill"]);
			expect(loader.getRules().rules.map((rule) => rule.name)).toEqual(["fixture-rule"]);
			expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual(["fixture-prompt"]);
			expect(loader.getThemes().themes).toHaveLength(1);
			for (const resource of [
				...loader.getSkills().skills,
				...loader.getRules().rules,
				...loader.getPrompts().prompts,
				...loader.getThemes().themes,
			]) {
				expect(resource.sourceInfo).toMatchObject({
					source: "official:fixture",
					scope: "user",
					origin: "package",
					official: { id: "fixture", version: "1.0.0" },
				});
			}
			h.settings.setPackages([
				{ source: "official:fixture", extensions: [], skills: [], rules: [], prompts: [], themes: [] },
			]);
			await loader.reload();
			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getRules().rules).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
			expect((await loader.getExtensionInventory())[0]).toMatchObject({ status: "disabled", version: "1.0.0" });
			expect(h.fetcher).toHaveBeenCalledTimes(2);
		},
	);
	it.each(["embedded", "print", "json", "rpc"] as const)(
		"uses selected official factories through shared %s initialization and reload",
		async (mode) => {
			const markerDir = await mkdtemp(join(tmpdir(), "grip-official-mode-"));
			directories.push(markerDir);
			const marker = join(markerDir, "executions");
			const h = await harness(
				`import { appendFileSync } from "node:fs"; export default (grip) => { appendFileSync(${JSON.stringify(marker)}, "loaded\\n"); grip.registerCommand("official-fixture", { description: "Fixture command", handler: async () => {} }); };`,
			);
			await h.manager.installAndPersist("official:fixture");
			vi.stubEnv("GRIP_MODEL_CATALOG_URL", "");
			vi.stubGlobal("fetch", h.fetcher);
			const agent = await GripAgent.create({
				mode,
				cwd: h.agentDir,
				agentDir: h.agentDir,
				hooks: false,
				noTools: "all",
				authStorage: AuthStorage.inMemory(),
				settingsManager: h.settings,
				sessionManager: new InMemorySessionManager(h.agentDir),
			});
			try {
				const session = await agent.createAgentSession();
				expect(session.resourceLoader.getExtensions().errors).toEqual([]);
				expect(session.resourceLoader.getExtensions().extensions[0].commands.has("official-fixture")).toBe(true);
				expect((await session.resourceLoader.getExtensionInventory())[0]).toMatchObject({
					status: "loaded",
					version: "1.0.0",
					scope: "user",
				});
				expect(await readFile(marker, "utf8")).toBe("loaded\n");
				await session.reload();
				expect(await readFile(marker, "utf8")).toBe("loaded\nloaded\n");
				await h.manager.removeAndPersist("official:fixture");
				await session.reload();
				expect(session.resourceLoader.getExtensions().extensions).toEqual([]);
				expect(await session.resourceLoader.getExtensionInventory()).toEqual([]);
				expect(await readFile(marker, "utf8")).toBe("loaded\nloaded\n");
				expect(h.fetcher).toHaveBeenCalledTimes(2);
			} finally {
				await agent.dispose();
			}
		},
	);
});

describe("installed extension inventory through the resource loader", () => {
	it("preserves failed official factory provenance without executing on inventory reads", async () => {
		const markerDir = await mkdtemp(join(tmpdir(), "grip-inventory-execution-"));
		directories.push(markerDir);
		const marker = join(markerDir, "executions");
		const h = await harness(
			`import { appendFileSync } from "node:fs"; export default () => { appendFileSync(${JSON.stringify(marker)}, "loaded\\n"); throw new Error("Fixture factory failed"); };`,
		);
		await h.manager.installAndPersist("official:fixture");
		const loader = new DefaultResourceLoader({ cwd: h.agentDir, agentDir: h.agentDir, settingsManager: h.settings });
		await loader.reload();
		const inventory = await loader.getExtensionInventory();
		expect(inventory).toHaveLength(1);
		expect(inventory[0]).toMatchObject({
			source: "official:fixture",
			scope: "user",
			configured: true,
			version: "1.0.0",
			status: "failed",
			removal: { source: "official:fixture", scope: "user" },
		});
		expect(inventory[0].entries).toHaveLength(1);
		expect(inventory[0].entries[0].status).toBe("failed");
		const failure = inventory[0].entries[0];
		expect(failure.sourceInfo).toMatchObject({
			path: failure.path,
			source: "official:fixture",
			scope: "user",
			origin: "package",
			official: { id: "fixture", version: "1.0.0" },
		});
		expect(failure.errors.join("\n")).toContain("Fixture factory failed");
		expect(loader.getExtensions().errors[0].sourceInfo).toEqual(failure.sourceInfo);
		const requests = h.fetcher.mock.calls.length;
		inventory[0].entries.length = 0;
		expect((await loader.getExtensionInventory())[0].entries).toHaveLength(1);
		expect(await readFile(marker, "utf8")).toBe("loaded\n");
		expect(h.fetcher).toHaveBeenCalledTimes(requests);
		await h.manager.removeAndPersist("official:fixture");
		const running = await loader.getExtensionInventory();
		expect(running[0]).toMatchObject({ configured: false, removal: null, version: "1.0.0" });
		expect(running[0].entries).toHaveLength(1);
		await loader.reload();
		expect(await loader.getExtensionInventory()).toEqual([]);
	});
	it("keeps disabled, missing and invalid project selections separate while protecting manual files", async () => {
		const h = await harness();
		await h.manager.installAndPersist("official:fixture");
		h.settings.setPackages(["official:fixture", "official:missing"]);
		h.settings.setProjectPackages(["official:fixture"]);
		const manual = join(h.agentDir, "extensions", "manual.ts");
		await mkdir(join(h.agentDir, "extensions"));
		await writeFile(manual, 'throw new Error("Must not load manual discovery under noExtensions");');
		const loader = new DefaultResourceLoader({
			cwd: h.agentDir,
			agentDir: h.agentDir,
			settingsManager: h.settings,
			noExtensions: true,
		});
		await loader.reload();
		const rows = await loader.getExtensionInventory();
		const official = rows.find((row) => row.source === "official:fixture" && row.scope === "user")!;
		expect(official).toMatchObject({ status: "disabled", version: "1.0.0", errors: [], removal: { scope: "user" } });
		expect(official.entries[0].status).toBe("disabled");
		expect(rows.find((row) => row.source === "official:missing")).toMatchObject({
			status: "missing",
			version: null,
			entries: [],
		});
		expect(rows.find((row) => row.source === "official:fixture" && row.scope === "project")).toMatchObject({
			status: "failed",
			removal: null,
		});
		const manualRow = rows.find((row) => row.entries.some((entry) => entry.path === manual))!;
		expect(manualRow).toMatchObject({ configured: false, version: null, removal: null, status: "disabled" });
		await h.manager.removeAndPersist("official:fixture");
		expect(await readFile(manual, "utf8")).toContain("Must not load manual");
		expect(h.fetcher).toHaveBeenCalledTimes(2);
	});
	it("retains filtered factories and offers third-party uninstall at the actual configured scope, never local files", async () => {
		const h = await harness("export default () => {};");
		await h.manager.installAndPersist("official:fixture");
		h.settings.setPackages([{ source: "official:fixture", extensions: [] }]);
		const npmRoot = join(h.agentDir, ".grip", "npm", "node_modules", "fixture-third-party");
		await mkdir(npmRoot, { recursive: true });
		await writeFile(
			join(npmRoot, "package.json"),
			JSON.stringify({
				name: "fixture-third-party",
				version: "2.0.0",
				grip: { extensions: ["entry.js", "second.js"] },
			}),
		);
		await writeFile(join(npmRoot, "entry.js"), "export default () => {};");
		await writeFile(join(npmRoot, "second.js"), "export default () => {};");
		const local = join(h.agentDir, "local.js");
		await writeFile(local, "export default () => {};");
		h.settings.setProjectPackages(["npm:fixture-third-party", local]);
		const loader = new DefaultResourceLoader({ cwd: h.agentDir, agentDir: h.agentDir, settingsManager: h.settings });
		await loader.reload();
		const rows = await loader.getExtensionInventory();
		expect(rows.find((row) => row.source === "official:fixture")).toMatchObject({ status: "disabled" });
		const npm = rows.find((row) => row.source === "npm:fixture-third-party")!;
		expect(npm).toMatchObject({
			status: "loaded",
			version: "2.0.0",
			removal: { source: "npm:fixture-third-party", scope: "project" },
		});
		expect(npm.entries).toHaveLength(2);
		expect(rows.find((row) => row.source === local)).toMatchObject({ version: null, removal: null });
		expect(await readFile(local, "utf8")).toContain("export default");
		expect(h.fetcher).toHaveBeenCalledTimes(2);
	});
});

async function cliHarness() {
	const h = await harness();
	vi.stubEnv(ENV_AGENT_DIR, h.agentDir);
	vi.spyOn(process, "cwd").mockReturnValue(h.agentDir);
	vi.stubGlobal("fetch", h.fetcher);
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	process.exitCode = undefined;
	return { ...h, log, error };
}

describe("official package CLI acceptance with injected fetch transport", () => {
	it("installs, lists, updates and uninstalls through file-backed settings without executing factories", async () => {
		const h = await cliHarness();
		expect(await handlePackageCommand(["install", "official:fixture"])).toBe(true);
		const settings = SettingsManager.create(h.agentDir, h.agentDir);
		expect(settings.getPackages()).toEqual(["official:fixture"]);
		await handlePackageCommand(["list"]);
		expect(h.log.mock.calls.flat().join("\n")).toContain("v1.0.0");
		h.publish("1.1.0");
		await handlePackageCommand(["update", "--extension", "official:fixture"]);
		await handlePackageCommand(["list"]);
		expect(h.log.mock.calls.flat().join("\n")).toContain("v1.1.0");
		const manager = new DefaultPackageManager({ cwd: h.agentDir, agentDir: h.agentDir, settingsManager: settings });
		const retained = await manager.getInstalledPath("official:fixture", "user");
		const requests = h.fetcher.mock.calls.length;
		vi.stubEnv("GRIP_OFFLINE", "1");
		await handlePackageCommand(["update", "official:fixture"]);
		await handlePackageCommand(["uninstall", "official:fixture"]);
		await settings.reload();
		expect(settings.getPackages()).toEqual([]);
		expect(await readFile(join(retained!, "entry.js"), "utf8")).toContain("Must not execute");
		await handlePackageCommand(["list"]);
		expect(h.log.mock.calls.flat().join("\n")).toContain("No packages installed.");
		expect(h.fetcher).toHaveBeenCalledTimes(requests);
		expect(h.error).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});
	it("reports missing and corrupt configured official packages without fetching or hiding the selection", async () => {
		const h = await cliHarness();
		const settings = SettingsManager.create(h.agentDir, h.agentDir);
		settings.setPackages(["official:fixture"]);
		await settings.flush();
		await handlePackageCommand(["list"]);
		expect(h.log.mock.calls.flat().join("\n")).toContain("Not installed");
		expect(h.fetcher).not.toHaveBeenCalled();
		await handlePackageCommand(["install", "official:fixture"]);
		await settings.reload();
		const manager = new DefaultPackageManager({ cwd: h.agentDir, agentDir: h.agentDir, settingsManager: settings });
		const installed = await manager.getInstalledPath("official:fixture", "user");
		await writeFile(join(installed!, "entry.js"), "modified");
		const requests = h.fetcher.mock.calls.length;
		h.log.mockClear();
		await handlePackageCommand(["list"]);
		expect(h.log.mock.calls.flat().join("\n")).toContain("official:fixture");
		expect(h.log.mock.calls.flat().join("\n")).not.toContain("v1.0.0");
		expect(h.log.mock.calls.flat().join("\n")).toContain(
			"Official installed file differs from its verified artifact",
		);
		expect(h.fetcher).toHaveBeenCalledTimes(requests);
		await handlePackageCommand(["remove", "official:fixture"]);
		await settings.reload();
		expect(settings.getPackages()).toEqual([]);
		expect(h.error).not.toHaveBeenCalled();
	});
	it.each(["install", "remove", "uninstall"])(
		"rejects project-local %s without fetching or changing membership",
		async (command) => {
			const h = await cliHarness();
			await handlePackageCommand([command, "official:fixture", "--local"]);
			expect(process.exitCode).toBe(1);
			expect(h.error.mock.calls.flat().join("\n")).toContain("global installation only");
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(SettingsManager.create(h.agentDir, h.agentDir).getPackages()).toEqual([]);
		},
	);
	it("reports invalid remote metadata without persisting a successful installation", async () => {
		const h = await cliHarness();
		h.fetcher.mockResolvedValue(new Response("{}"));
		await handlePackageCommand(["install", "official:fixture"]);
		expect(process.exitCode).toBe(1);
		expect(h.error).toHaveBeenCalled();
		expect(h.log.mock.calls.flat().join("\n")).not.toContain("Installed official:fixture");
		expect(SettingsManager.create(h.agentDir, h.agentDir).getPackages()).toEqual([]);
	});
	it.each(["install", "remove", "update", "list"])(
		"documents official source semantics in %s help without fetching",
		async (command) => {
			const h = await cliHarness();
			await handlePackageCommand([command, "--help"]);
			expect(h.log.mock.calls.flat().join("\n")).toContain("Official");
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(h.error).not.toHaveBeenCalled();
		},
	);
});
