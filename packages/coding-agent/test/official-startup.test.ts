import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@greppleai/grip-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { GripAgent, type GripAgentAppMode, isFatalGripAgentDiagnostic } from "../src/core/grip-agent.ts";
import { encodeOfficialArtifact, officialJson, officialSha256 } from "../src/core/official-artifact.ts";
import {
	OFFICIAL_CATALOG_URL,
	OFFICIAL_REPOSITORY,
	type OfficialCatalog,
	type OfficialRelease,
	type OfficialUpdatePolicy,
	officialObject,
	parseOfficialManifest,
	parseOfficialUpdatePolicy,
} from "../src/core/official-catalog.ts";
import { OfficialFileStore } from "../src/core/official-files.ts";
import { OfficialExtensionInstaller, type OfficialProgressPhase } from "../src/core/official-installer.ts";
import { OfficialTransport } from "../src/core/official-transport.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}),
	);
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function harness(
	coreRange = ">=0.1.0 <1",
	factoryCode: (id: string, version: string) => string = () =>
		'throw new Error("Startup updates must not execute code"); export default () => {};',
	policy: Partial<OfficialUpdatePolicy> = {},
) {
	const agentDir = await mkdtemp(join(tmpdir(), "grip-official-startup-"));
	directories.push(agentDir);
	const settings = SettingsManager.inMemory({ packages: ["npm:untouched", "./manual"], officialExtensions: policy });
	const clock = { now: 1_000_000 };
	const catalog: OfficialCatalog = { schemaVersion: 1, repository: OFFICIAL_REPOSITORY, extensions: [] };
	const artifacts = new Map<string, Buffer>();
	function publish(id: string, version: string, range = coreRange) {
		const manifest = parseOfficialManifest(
			{
				name: `official-${id}`,
				version,
				description: "Startup fixture",
				type: "module",
				engines: { grip: range },
				grip: { official: { id, displayName: id }, extensions: ["entry.js"] },
			},
			id,
		);
		const bytes = encodeOfficialArtifact({
			schemaVersion: 1,
			manifest,
			files: [
				{ path: "package.json", base64: Buffer.from(officialJson(manifest)).toString("base64") },
				{
					path: "entry.js",
					base64: Buffer.from(factoryCode(id, version)).toString("base64"),
				},
			],
		});
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
		let entry = catalog.extensions.find((entry) => entry.id === id);
		if (!entry) {
			entry = { id, releases: [] };
			catalog.extensions.push(entry);
		}
		entry.releases.push(release);
		artifacts.set(release.artifact.url, bytes);
		return release;
	}
	publish("alpha", "1.0.0");
	publish("beta", "1.0.0");
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = String(input);
		if (url === OFFICIAL_CATALOG_URL) return new Response(officialJson(catalog));
		const bytes = artifacts.get(url);
		if (!bytes) throw new Error(`Unexpected fixture request: ${url}`);
		return new Response(new Uint8Array(bytes));
	});
	const dependencies = { now: () => clock.now, transport: new OfficialTransport(fetcher) };
	const installer = new OfficialExtensionInstaller(
		{ agentDir, settingsManager: settings, gripVersion: "0.1.8" },
		dependencies,
	);
	const alpha = await installer.install("alpha");
	const beta = await installer.install("beta");
	fetcher.mockClear();
	return { agentDir, settings, clock, catalog, artifacts, publish, fetcher, dependencies, installer, alpha, beta };
}

async function runtimeHarness(policy: Partial<OfficialUpdatePolicy> = {}) {
	vi.stubEnv("GRIP_MODEL_CATALOG_URL", "");
	vi.stubEnv("GRIP_OFFLINE", "");
	const directory = await mkdtemp(join(tmpdir(), "grip-official-startup-marker-"));
	directories.push(directory);
	const marker = join(directory, "executions");
	const h = await harness(
		undefined,
		(id, version) => `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`import:${id}@${version}\n`)});
export default (grip) => {
  appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`factory:${id}@${version}\n`)});
  grip.registerCommand(${JSON.stringify(`${id}-fixture`)}, { description: "Fixture", handler: async () => {} });
};`,
		policy,
	);
	h.settings.setPackages(["official:alpha", "official:beta"]);
	await h.settings.flush();
	vi.stubGlobal("fetch", h.fetcher);
	return { ...h, marker };
}

async function createRuntime(
	agentDir: string,
	settingsManager: SettingsManager,
	mode: GripAgentAppMode = "embedded",
	noExtensions = false,
): Promise<GripAgent> {
	return GripAgent.create({
		cwd: agentDir,
		agentDir,
		mode,
		settingsManager,
		noTools: "all",
		hooks: false,
		authStorage: AuthStorage.inMemory(),
		sessionManager: new InMemorySessionManager(agentDir),
		resourceLoaderOptions: { noExtensions, noContextFiles: true },
	});
}

async function processHarness() {
	const h = await harness();
	h.clock.now += 21_600_001;
	h.publish("alpha", "1.1.0");
	h.publish("beta", "1.1.0");
	await writeFile(join(h.agentDir, "settings.json"), officialJson(h.settings.getGlobalSettings()));
	await writeFile(
		join(h.agentDir, "startup-fixture.json"),
		officialJson({
			now: h.clock.now,
			catalog: h.catalog,
			artifacts: [...h.artifacts].map(([url, bytes]) => [url, bytes.toString("base64")]),
		}),
	);
	const persistedSettings = SettingsManager.create(h.agentDir, h.agentDir);
	const inspector = new OfficialExtensionInstaller(
		{ agentDir: h.agentDir, settingsManager: persistedSettings, gripVersion: "0.1.8" },
		h.dependencies,
	);
	return { ...h, persistedSettings, inspector };
}

function startInstallerChild(
	agentDir: string,
	ids: string[],
	holdPhase: OfficialProgressPhase | null = null,
	remove = false,
) {
	const child = fork(
		fileURLToPath(new URL("./fixtures/official-startup-process.mjs", import.meta.url)),
		[agentDir, remove ? "remove" : "startup", ids.join(","), holdPhase ?? ""],
		{
			execArgv: [],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: { ...process.env, GRIP_OFFLINE: "", GRIP_EMBEDDED_ASSET_DIR: "" },
		},
	);
	children.push(child);
	const events: Record<string, unknown>[] = [];
	let stderr = "";
	child.stderr?.on("data", (bytes: Buffer) => {
		stderr += bytes.toString();
	});
	child.on("message", (message: unknown) => {
		events.push(officialObject(message, "child fixture event"));
	});
	async function waitFor(type: string, phase: OfficialProgressPhase | null = null, id: string | null = null) {
		const signal = AbortSignal.timeout(6000);
		let nextEvent = 0;
		function findNext() {
			for (; nextEvent < events.length; nextEvent++) {
				const event = events[nextEvent];
				if (event.type === type && (phase === null || event.phase === phase) && (id === null || event.id === id))
					return event;
			}
			return undefined;
		}
		while (true) {
			const event = findNext();
			if (event) return event;
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`Child exited before ${type}: ${stderr}`);
			try {
				await once(child, "message", { signal });
			} catch (cause) {
				throw new Error(`Child did not reach ${type}: ${stderr}`, { cause });
			}
		}
	}
	return { child, events, waitFor };
}

const expired = 21_600_001;
describe("bounded official startup update batches", () => {
	it("accepts a lock removed after lstat but still propagates other realpath failures", async () => {
		const h = await harness();
		const files = await OfficialFileStore.create(h.agentDir);
		const lock = join(h.agentDir, "official/alpha.lock");
		await mkdir(lock);
		const original = fsPromises.realpath;
		const resolving = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path) => {
			if (path === lock) await rm(lock, { recursive: true });
			return original(path);
		});
		syncBuiltinESMExports();
		await expect(files.check("official/alpha.lock")).resolves.toBe(lock);
		expect(resolving).toHaveBeenCalledWith(lock);
		await mkdir(lock);
		const denied = Object.assign(new Error("Injected realpath denial"), { code: "EACCES" });
		resolving.mockImplementation(async (path) => {
			if (path === lock) throw denied;
			return original(path);
		});
		await expect(files.check("official/alpha.lock")).rejects.toBe(denied);
	});
	it("uses a fresh catalog and does not download, rewrite or execute unchanged installations", async () => {
		const h = await harness();
		h.publish("alpha", "1.1.0");
		const path = join(h.agentDir, "official/alpha/state.json");
		const before = await readFile(path, "utf8");
		const writes = vi.spyOn(OfficialFileStore.prototype, "atomicWrite");
		const promotions = vi.spyOn(OfficialFileStore.prototype, "promote");
		expect(await h.installer.startupUpdates(["alpha", "beta"])).toEqual({ updated: [], diagnostics: [] });
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe(before);
		expect(writes).not.toHaveBeenCalled();
		expect(promotions).not.toHaveBeenCalled();
	});
	it("fetches one stale catalog, selects only newer compatible stable releases and retains old immutable trees", async () => {
		const h = await harness();
		h.clock.now += expired;
		h.publish("alpha", "0.9.0");
		h.publish("alpha", "1.1.0");
		h.publish("alpha", "1.2.0-beta.1");
		h.publish("alpha", "1.3.0", ">=1");
		h.publish("beta", "1.1.0");
		expect(await h.installer.startupUpdates(["alpha", "alpha", "beta"])).toEqual({
			updated: [
				{ id: "alpha", version: "1.1.0" },
				{ id: "beta", version: "1.1.0" },
			],
			diagnostics: [],
		});
		expect(h.fetcher).toHaveBeenCalledTimes(3);
		expect(await readFile(join(h.alpha.path, "entry.js"), "utf8")).toContain("must not execute");
		expect(await readFile(join(h.beta.path, "entry.js"), "utf8")).toContain("must not execute");
		expect(h.settings.getPackages()).toContain("npm:untouched");
	});
	it("isolates checksum failure while updating another extension and retaining a verified fallback", async () => {
		const h = await harness();
		h.clock.now += expired;
		const broken = h.publish("alpha", "1.1.0");
		h.artifacts.set(broken.artifact.url, Buffer.from("broken"));
		h.publish("beta", "1.1.0");
		const result = await h.installer.startupUpdates(["alpha", "beta"]);
		expect(result.updated).toEqual([{ id: "beta", version: "1.1.0" }]);
		expect(result.diagnostics).toEqual([
			{
				source: "official:alpha",
				code: "install",
				message: expect.stringContaining("grip update official:alpha"),
			},
		]);
		expect((await h.installer.active("alpha"))?.installed.version).toBe("1.0.0");
		expect((await h.installer.active("beta"))?.installed.version).toBe("1.1.0");
	});
	it.each(["offline", "environment", "disabled", "opt-out", "empty"] as const)(
		"performs no network or state mutation for %s",
		async (reason) => {
			const h = await harness();
			h.clock.now += expired;
			h.publish("alpha", "1.1.0");
			if (reason === "environment") vi.stubEnv("GRIP_OFFLINE", "1");
			const before = await readFile(join(h.agentDir, "official/alpha/state.json"), "utf8");
			expect(
				await h.installer.startupUpdates(reason === "empty" ? [] : ["alpha"], {
					offline: reason === "offline",
					noExtensions: reason === "disabled",
					policy: parseOfficialUpdatePolicy({ autoUpdate: reason !== "opt-out" }),
				}),
			).toEqual({ updated: [], diagnostics: [] });
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(await readFile(join(h.agentDir, "official/alpha/state.json"), "utf8")).toBe(before);
		},
	);
	it("never installs a missing selected entry or revives removed membership from a stale ID snapshot", async () => {
		const h = await harness();
		h.clock.now += expired;
		h.publish("alpha", "1.1.0");
		h.publish("missing", "1.0.0");
		await h.installer.remove("alpha");
		await h.settings.officialPackageMembership("missing", true);
		expect(await h.installer.startupUpdates(["alpha", "missing", "unselected"])).toEqual({
			updated: [],
			diagnostics: [],
		});
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(await h.installer.active("alpha")).toBeNull();
		expect(await h.installer.active("missing")).toBeNull();
		expect(h.settings.getPackages()).not.toContain("official:alpha");
	});
	it("persists retry backoff across installer instances after a rate limit and retries after its cooldown", async () => {
		const h = await harness();
		h.clock.now += expired;
		h.fetcher.mockResolvedValueOnce(new Response(null, { status: 429 }));
		expect((await h.installer.startupUpdates(["alpha", "beta"])).diagnostics).toHaveLength(2);
		expect(h.fetcher).toHaveBeenCalledTimes(1);
		const next = new OfficialExtensionInstaller(
			{ agentDir: h.agentDir, settingsManager: h.settings, gripVersion: "0.1.8" },
			h.dependencies,
		);
		expect((await next.startupUpdates(["alpha"])).diagnostics[0].code).toBe("backoff");
		expect(h.fetcher).toHaveBeenCalledTimes(1);
		h.clock.now += 60_000;
		h.publish("alpha", "1.1.0");
		expect((await next.startupUpdates(["alpha"])).updated).toEqual([{ id: "alpha", version: "1.1.0" }]);
		expect(h.fetcher).toHaveBeenCalledTimes(3);
	});
	it("bounds signal-ignoring network work by the whole-batch budget without late activation", async () => {
		const h = await harness();
		h.clock.now += expired;
		const started = Promise.withResolvers<void>();
		h.fetcher.mockImplementationOnce(() => {
			started.resolve();
			return new Promise<Response>(() => {});
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const pending = h.installer.startupUpdates(["alpha", "beta"], {
				policy: parseOfficialUpdatePolicy({ startupBudgetMs: 30, requestTimeoutMs: 1000 }),
			});
			await started.promise;
			await vi.advanceTimersByTimeAsync(30);
			const result = await pending;
			expect(result.updated).toEqual([]);
			expect(result.diagnostics).toHaveLength(1);
			expect(h.fetcher).toHaveBeenCalledTimes(1);
			expect((await h.installer.active("alpha"))?.installed.version).toBe("1.0.0");
			expect((await h.installer.active("beta"))?.installed.version).toBe("1.0.0");
		} finally {
			vi.useRealTimers();
		}
	});
	it("cooperates across concurrent installer instances without duplicate catalog or artifact downloads", async () => {
		const h = await harness();
		h.clock.now += expired;
		h.publish("alpha", "1.1.0");
		h.publish("beta", "1.1.0");
		const second = new OfficialExtensionInstaller(
			{ agentDir: h.agentDir, settingsManager: h.settings, gripVersion: "0.1.8" },
			h.dependencies,
		);
		const results = await Promise.all([
			h.installer.startupUpdates(["alpha", "beta"]),
			second.startupUpdates(["alpha", "beta"]),
		]);
		expect(results.flatMap((result) => result.updated)).toHaveLength(2);
		expect(h.fetcher).toHaveBeenCalledTimes(3);
		expect((await h.installer.active("alpha"))?.installed.version).toBe("1.1.0");
		expect((await h.installer.active("beta"))?.installed.version).toBe("1.1.0");
	});
	it("can repair an installed version incompatible with a new core without first treating it as loadable", async () => {
		const h = await harness(">=0.1 <0.2");
		h.clock.now += expired;
		h.publish("alpha", "1.1.0", ">=0.2 <1");
		const upgraded = new OfficialExtensionInstaller(
			{ agentDir: h.agentDir, settingsManager: h.settings, gripVersion: "0.2.0" },
			h.dependencies,
		);
		await expect(upgraded.active("alpha")).rejects.toMatchObject({ code: "incompatible" });
		expect((await upgraded.startupUpdates(["alpha"])).updated).toEqual([{ id: "alpha", version: "1.1.0" }]);
		expect((await upgraded.active("alpha"))?.installed.version).toBe("1.1.0");
	});
	it("does not activate an artifact whose signal-ignoring response arrives after the startup deadline", async () => {
		const h = await harness();
		h.clock.now += expired;
		const next = h.publish("alpha", "1.1.0");
		const started = Promise.withResolvers<void>();
		const delivery = Promise.withResolvers<Response>();
		h.fetcher.mockImplementation(async (input) => {
			if (String(input) === OFFICIAL_CATALOG_URL) return new Response(officialJson(h.catalog));
			if (String(input) !== next.artifact.url) throw new Error("Unexpected fixture request");
			started.resolve();
			return delivery.promise;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const pending = h.installer.startupUpdates(["alpha"], {
				policy: parseOfficialUpdatePolicy({ startupBudgetMs: 200, requestTimeoutMs: 1000 }),
			});
			await started.promise;
			await vi.advanceTimersByTimeAsync(200);
			const result = await pending;
			expect(result.updated).toEqual([]);
			expect(result.diagnostics).toHaveLength(1);
			expect(h.fetcher).toHaveBeenCalledTimes(2);
			delivery.resolve(new Response(new Uint8Array(h.artifacts.get(next.artifact.url)!)));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect((await h.installer.active("alpha"))?.installed.version).toBe("1.0.0");
		} finally {
			vi.useRealTimers();
		}
	});
	it("handles external cancellation before work without fetching or changing activation", async () => {
		const h = await harness();
		h.clock.now += expired;
		const controller = new AbortController();
		controller.abort();
		const result = await h.installer.startupUpdates(["alpha"], { signal: controller.signal });
		expect(result.updated).toEqual([]);
		expect(result.diagnostics).toHaveLength(1);
		expect(h.fetcher).not.toHaveBeenCalled();
		expect((await h.installer.active("alpha"))?.installed.version).toBe("1.0.0");
	});
	it("does not resurrect membership removed between promotion and activation", async () => {
		const h = await harness();
		h.clock.now += expired;
		h.publish("alpha", "1.1.0");
		const racing = new OfficialExtensionInstaller(
			{ agentDir: h.agentDir, settingsManager: h.settings, gripVersion: "0.1.8" },
			{
				...h.dependencies,
				onProgress: async (event) => {
					if (event.id === "alpha" && event.phase === "promoted")
						await h.settings.officialPackageMembership("alpha", false);
				},
			},
		);
		const result = await racing.startupUpdates(["alpha"]);
		expect(result.updated).toEqual([]);
		expect(result.diagnostics[0].code).toBe("removed");
		expect(await racing.active("alpha")).toBeNull();
		expect(h.settings.getPackages()).not.toContain("official:alpha");
		expect(await readFile(join(h.alpha.path, "entry.js"), "utf8")).toContain("must not execute");
	});
	it("reports catalog retry-metadata disk failures nonfatally without touching verified installed code", async () => {
		const h = await harness();
		h.clock.now += expired;
		const atomicWrite = OfficialFileStore.prototype.atomicWrite;
		vi.spyOn(OfficialFileStore.prototype, "atomicWrite").mockImplementation(async function (
			this: OfficialFileStore,
			path,
			bytes,
			immutable,
		) {
			if (path === "official/.startup/catalog-attempt.json") throw new Error("Injected disk failure");
			return atomicWrite.call(this, path, bytes, immutable);
		});
		const result = await h.installer.startupUpdates(["alpha", "beta"]);
		expect(result.updated).toEqual([]);
		expect(result.diagnostics).toHaveLength(2);
		expect(h.fetcher).not.toHaveBeenCalled();
		expect((await h.installer.active("alpha"))?.installed.version).toBe("1.0.0");
		expect((await h.installer.active("beta"))?.installed.version).toBe("1.0.0");
	});
});

describe("official updates before shared initial resource loading", () => {
	it.each(["embedded", "interactive", "print", "json", "rpc"] as const)(
		"updates before the first module import and factory in %s",
		async (mode) => {
			const h = await runtimeHarness();
			h.publish("alpha", "1.1.0");
			h.publish("beta", "1.1.0");
			const phase = vi.spyOn(OfficialExtensionInstaller.prototype, "startupUpdates");
			const agent = await createRuntime(h.agentDir, h.settings, mode);
			try {
				await agent.createAgentSession();
				expect(phase).toHaveBeenCalledTimes(1);
				expect(h.fetcher).toHaveBeenCalledTimes(3);
				expect(await readFile(h.marker, "utf8")).toBe(
					"import:alpha@1.1.0\nfactory:alpha@1.1.0\nimport:beta@1.1.0\nfactory:beta@1.1.0\n",
				);
				expect(agent.resourceLoader.getExtensions().errors).toEqual([]);
				expect(
					agent.resourceLoader.getExtensions().extensions.map((extension) => [...extension.commands.keys()]),
				).toEqual([["alpha-fixture"], ["beta-fixture"]]);
				expect((await agent.resourceLoader.getExtensionInventory()).map((row) => row.version)).toEqual([
					"1.1.0",
					"1.1.0",
				]);
			} finally {
				await agent.dispose();
			}
		},
	);
	it("does not repeat updates on reload, inventory, replacement, fork, cwd change or another same-root runtime", async () => {
		const h = await runtimeHarness();
		h.publish("alpha", "1.1.0");
		const phase = vi.spyOn(OfficialExtensionInstaller.prototype, "startupUpdates");
		const agent = await createRuntime(h.agentDir, h.settings);
		const second = await createRuntime(h.agentDir, h.settings);
		try {
			await agent.createAgentSession();
			h.publish("alpha", "1.2.0");
			await agent.session.reload();
			await agent.resourceLoader.getExtensionInventory();
			await agent.newSession();
			const entry = agent.session.session.appendMessage({
				role: "user",
				content: "fork fixture",
				timestamp: Date.now(),
			});
			await agent.fork(entry, { position: "at" });
			await agent.switchSession("in-memory-replacement");
			await agent.changeDirectory(h.agentDir);
			await second.createAgentSession();
			expect(phase).toHaveBeenCalledTimes(1);
			expect(h.fetcher).toHaveBeenCalledTimes(2);
			expect((await h.installer.active("alpha"))?.installed.version).toBe("1.1.0");
			expect(await readFile(h.marker, "utf8")).not.toContain("@1.2.0");
		} finally {
			await agent.dispose();
			await second.dispose();
		}
	});
	it.each(["offline", "opt-out", "disabled"] as const)(
		"does not request updates or rewrite installations when %s",
		async (reason) => {
			const h = await runtimeHarness({ autoUpdate: reason !== "opt-out" });
			h.publish("alpha", "1.1.0");
			if (reason === "offline") vi.stubEnv("GRIP_OFFLINE", "1");
			const before = await readFile(join(h.agentDir, "official/alpha/state.json"), "utf8");
			const writes = vi.spyOn(OfficialFileStore.prototype, "atomicWrite");
			const agent = await createRuntime(h.agentDir, h.settings, "embedded", reason === "disabled");
			try {
				await agent.createAgentSession();
				expect(h.fetcher).not.toHaveBeenCalled();
				expect(writes).not.toHaveBeenCalled();
				expect(await readFile(join(h.agentDir, "official/alpha/state.json"), "utf8")).toBe(before);
				if (reason === "disabled") expect(agent.resourceLoader.getExtensions().extensions).toEqual([]);
				else expect(await readFile(h.marker, "utf8")).toContain("factory:alpha@1.0.0");
			} finally {
				await agent.dispose();
			}
		},
	);
	it("continues with a verified prior factory and actionable nonfatal diagnostics when an independent update fails", async () => {
		const h = await runtimeHarness();
		const broken = h.publish("alpha", "1.1.0");
		h.artifacts.set(broken.artifact.url, Buffer.from("broken"));
		h.publish("beta", "1.1.0");
		const agent = await createRuntime(h.agentDir, h.settings, "rpc");
		try {
			await agent.createAgentSession();
			expect(agent.diagnostics).toContainEqual({
				type: "warning",
				fatal: false,
				message: expect.stringContaining("grip update official:alpha"),
			});
			expect(agent.diagnostics.some(isFatalGripAgentDiagnostic)).toBe(false);
			expect(agent.resourceLoader.getExtensions().errors).toEqual([]);
			expect(await readFile(h.marker, "utf8")).toBe(
				"import:alpha@1.0.0\nfactory:alpha@1.0.0\nimport:beta@1.1.0\nfactory:beta@1.1.0\n",
			);
		} finally {
			await agent.dispose();
		}
	});
	it("treats malformed configured update policy as nonfatal rather than fetching or preventing initial factories", async () => {
		const h = await runtimeHarness({ startupBudgetMs: Infinity });
		const agent = await createRuntime(h.agentDir, h.settings);
		try {
			await agent.createAgentSession();
			expect(agent.diagnostics).toContainEqual({
				type: "warning",
				fatal: false,
				message: expect.stringContaining("official update settings"),
			});
			expect(agent.diagnostics.some(isFatalGripAgentDiagnostic)).toBe(false);
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(await readFile(h.marker, "utf8")).toContain("factory:alpha@1.0.0");
		} finally {
			await agent.dispose();
		}
	});
	it("shares one pending phase between concurrent same-root initializations", async () => {
		const h = await runtimeHarness();
		h.publish("alpha", "1.1.0");
		h.publish("beta", "1.1.0");
		const phase = vi.spyOn(OfficialExtensionInstaller.prototype, "startupUpdates");
		const first = await createRuntime(h.agentDir, h.settings);
		const second = await createRuntime(h.agentDir, h.settings);
		try {
			await Promise.all([first.createAgentSession(), second.createAgentSession()]);
			expect(phase).toHaveBeenCalledTimes(1);
			expect(h.fetcher).toHaveBeenCalledTimes(3);
			expect(await readFile(h.marker, "utf8")).not.toContain("@1.0.0");
			expect(first.resourceLoader.getExtensions().errors).toEqual([]);
			expect(second.resourceLoader.getExtensions().errors).toEqual([]);
		} finally {
			await first.dispose();
			await second.dispose();
		}
	});
	it("leaves initialization and update policy of host-supplied loaders with the host", async () => {
		const h = await runtimeHarness();
		h.publish("alpha", "1.1.0");
		const loader = new DefaultResourceLoader({ cwd: h.agentDir, agentDir: h.agentDir, settingsManager: h.settings });
		await loader.reload();
		const phase = vi.spyOn(OfficialExtensionInstaller.prototype, "startupUpdates");
		const agent = await GripAgent.create({
			cwd: h.agentDir,
			agentDir: h.agentDir,
			settingsManager: h.settings,
			resourceLoader: loader,
			authStorage: AuthStorage.inMemory(),
			sessionManager: new InMemorySessionManager(h.agentDir),
			noTools: "all",
			hooks: false,
		});
		try {
			await agent.createAgentSession();
			expect(phase).not.toHaveBeenCalled();
			expect(h.fetcher).not.toHaveBeenCalled();
			expect((await h.installer.active("alpha"))?.installed.version).toBe("1.0.0");
		} finally {
			await agent.dispose();
		}
	});
	it.each([false, true])(
		"uses persisted global policy (%s), not the opposite project override",
		async (autoUpdate) => {
			const h = await runtimeHarness();
			h.publish("alpha", "1.1.0");
			await mkdir(join(h.agentDir, ".grip"));
			await writeFile(
				join(h.agentDir, "settings.json"),
				JSON.stringify({ packages: ["official:alpha", "official:beta"], officialExtensions: { autoUpdate } }),
			);
			await writeFile(
				join(h.agentDir, ".grip/settings.json"),
				JSON.stringify({ officialExtensions: { autoUpdate: !autoUpdate } }),
			);
			const settings = SettingsManager.create(h.agentDir, h.agentDir);
			const agent = await createRuntime(h.agentDir, settings);
			try {
				await agent.createAgentSession();
				expect(settings.getGlobalSettings().officialExtensions?.autoUpdate).toBe(autoUpdate);
				expect(settings.getProjectSettings().officialExtensions?.autoUpdate).toBe(!autoUpdate);
				expect(h.fetcher).toHaveBeenCalledTimes(autoUpdate ? 2 : 0);
				expect((await agent.resourceLoader.getExtensionInventory())[0].version).toBe(
					autoUpdate ? "1.1.0" : "1.0.0",
				);
			} finally {
				await agent.dispose();
			}
		},
	);
	it.each(["offline", "disabled"] as const)(
		"does not schedule a late phase when a later runtime clears %s",
		async (reason) => {
			const h = await runtimeHarness();
			h.publish("alpha", "1.1.0");
			if (reason === "offline") vi.stubEnv("GRIP_OFFLINE", "1");
			const phase = vi.spyOn(OfficialExtensionInstaller.prototype, "startupUpdates");
			const first = await createRuntime(h.agentDir, h.settings, "embedded", reason === "disabled");
			let second: GripAgent | undefined;
			try {
				await first.createAgentSession();
				vi.stubEnv("GRIP_OFFLINE", "");
				second = await createRuntime(h.agentDir, h.settings);
				await second.createAgentSession();
				expect(phase).not.toHaveBeenCalled();
				expect(h.fetcher).not.toHaveBeenCalled();
				expect((await second.resourceLoader.getExtensionInventory())[0].version).toBe("1.0.0");
			} finally {
				await first.dispose();
				await second?.dispose();
			}
		},
	);
	it("isolates startup guards, installed versions and network discovery by configured agent directory", async () => {
		const h = await runtimeHarness();
		h.publish("alpha", "1.1.0");
		const first = await createRuntime(h.agentDir, h.settings);
		let second: GripAgent | undefined;
		try {
			await first.createAgentSession();
			const other = await runtimeHarness();
			other.publish("alpha", "1.2.0");
			second = await createRuntime(other.agentDir, other.settings);
			await second.createAgentSession();
			expect(h.fetcher).toHaveBeenCalledTimes(2);
			expect(other.fetcher).toHaveBeenCalledTimes(2);
			expect((await first.resourceLoader.getExtensionInventory())[0].version).toBe("1.1.0");
			expect((await second.resourceLoader.getExtensionInventory())[0].version).toBe("1.2.0");
		} finally {
			await first.dispose();
			await second?.dispose();
		}
	});
	it("does not repeat startup updates or managed factories when the real job tool creates an embedded child", async () => {
		const h = await runtimeHarness();
		h.publish("alpha", "1.1.0");
		vi.stubEnv("GRIP_DEFAULT_JOB_MODEL", "");
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("job", { task: "Return a fixture answer", tools: [] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child fixture answer"),
			fauxAssistantMessage("parent fixture done"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		let childFactories = 0;
		const phase = vi.spyOn(OfficialExtensionInstaller.prototype, "startupUpdates");
		const agent = await GripAgent.create({
			cwd: h.agentDir,
			agentDir: h.agentDir,
			settingsManager: h.settings,
			authStorage,
			model: faux.getModel(),
			tools: ["job"],
			hooks: false,
			sessionManager: new InMemorySessionManager(h.agentDir),
			resourceLoaderOptions: {
				noContextFiles: true,
				extensionFactories: [
					(grip) => {
						grip.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models,
						});
						grip.registerJobFactory(() => {
							childFactories++;
						});
					},
				],
			},
		});
		try {
			await agent.createAgentSession();
			await agent.session.bindExtensions({});
			const before = await readFile(h.marker, "utf8");
			h.publish("alpha", "1.2.0");
			await agent.session.prompt("Delegate the fixture task using job");
			expect(faux.state.callCount).toBe(3);
			expect(childFactories).toBe(1);
			expect(agent.session.messages).toContainEqual(
				expect.objectContaining({
					role: "toolResult",
					toolName: "job",
					isError: false,
					content: [
						expect.objectContaining({ type: "text", text: expect.stringContaining("child fixture answer") }),
					],
				}),
			);
			expect(phase).toHaveBeenCalledTimes(1);
			expect(h.fetcher).toHaveBeenCalledTimes(2);
			expect(await readFile(h.marker, "utf8")).toBe(before);
			expect((await h.installer.active("alpha"))?.installed.version).toBe("1.1.0");
		} finally {
			await agent.dispose();
			faux.unregister();
		}
	});
});

describe("independent-process official startup transactions", () => {
	it("updates independent selections concurrently without duplicate downloads, lost membership or replacing retained versions", async () => {
		const h = await processHarness();
		const first = startInstallerChild(h.agentDir, ["alpha", "beta"], "promoted");
		const second = startInstallerChild(h.agentDir, ["beta", "alpha"]);
		await Promise.all([first.waitFor("ready"), second.waitFor("ready")]);
		first.child.send("start");
		await first.waitFor("paused", "promoted", "alpha");
		second.child.send("start");
		await second.waitFor("progress", "activated", "beta");
		first.child.send("release");
		const results = await Promise.all([first.waitFor("result"), second.waitFor("result")]);
		expect(results.map((event) => event.result)).toEqual([
			{ updated: [{ id: "alpha", version: "1.1.0" }], diagnostics: [] },
			{ updated: [{ id: "beta", version: "1.1.0" }], diagnostics: [] },
		]);
		const requests = [...first.events, ...second.events].filter((event) => event.type === "request");
		expect(requests).toHaveLength(3);
		expect(requests.filter((event) => event.url === OFFICIAL_CATALOG_URL)).toHaveLength(1);
		expect((await h.inspector.active("alpha"))?.installed.version).toBe("1.1.0");
		expect((await h.inspector.active("beta"))?.installed.version).toBe("1.1.0");
		expect(await readFile(join(h.alpha.path, "entry.js"), "utf8")).toContain("must not execute");
		expect(await readFile(join(h.beta.path, "entry.js"), "utf8")).toContain("must not execute");
		await h.persistedSettings.reload();
		expect(h.persistedSettings.getPackages()).toEqual(h.settings.getPackages());
	});
	it("leaves an installation removed when another process uninstalls after an in-flight startup promotion", async () => {
		const h = await processHarness();
		const startup = startInstallerChild(h.agentDir, ["alpha"], "promoted");
		const removal = startInstallerChild(h.agentDir, ["alpha"], null, true);
		await Promise.all([startup.waitFor("ready"), removal.waitFor("ready")]);
		startup.child.send("start");
		await startup.waitFor("paused", "promoted", "alpha");
		removal.child.send("start");
		await removal.waitFor("started");
		startup.child.send("release");
		await Promise.all([startup.waitFor("result"), removal.waitFor("result")]);
		expect(await h.inspector.active("alpha")).toBeNull();
		expect(await h.persistedSettings.officialPackageMembership("alpha", null)).toBe(false);
		expect((await h.inspector.startupUpdates(["alpha"])).updated).toEqual([]);
		expect((await h.inspector.active("beta"))?.installed.version).toBe("1.0.0");
		expect(await readFile(join(h.alpha.path, "entry.js"), "utf8")).toContain("must not execute");
		await h.persistedSettings.reload();
		expect(h.persistedSettings.getPackages()).toEqual(["npm:untouched", "./manual", "official:beta"]);
	});
	it("does not download or reactivate a selection removed while another startup process is running", async () => {
		const h = await processHarness();
		const removal = startInstallerChild(h.agentDir, ["alpha"], "removed-membership", true);
		const startup = startInstallerChild(h.agentDir, ["beta", "alpha"]);
		await Promise.all([removal.waitFor("ready"), startup.waitFor("ready")]);
		removal.child.send("start");
		await removal.waitFor("paused", "removed-membership", "alpha");
		startup.child.send("start");
		await startup.waitFor("progress", "activated", "beta");
		removal.child.send("release");
		await removal.waitFor("result");
		expect((await startup.waitFor("result")).result).toEqual({
			updated: [{ id: "beta", version: "1.1.0" }],
			diagnostics: [],
		});
		expect(startup.events.filter((event) => event.type === "request")).toHaveLength(2);
		expect(await h.inspector.active("alpha")).toBeNull();
		expect(await h.persistedSettings.officialPackageMembership("alpha", null)).toBe(false);
		expect((await h.inspector.active("beta"))?.installed.version).toBe("1.1.0");
		expect(await readFile(join(h.alpha.path, "entry.js"), "utf8")).toContain("must not execute");
	});
});
