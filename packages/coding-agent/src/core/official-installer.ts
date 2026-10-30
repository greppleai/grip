import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { decodeOfficialArtifact, officialJson } from "./official-artifact.ts";
import {
	OFFICIAL_CATALOG_URL,
	OFFICIAL_LIMITS,
	type OfficialCatalog,
	type OfficialRelease,
	type OfficialUpdatePolicy,
	officialObject,
	parseOfficialCatalog,
	parseOfficialRelease,
	parseOfficialUpdatePolicy,
	selectOfficialRelease,
	validateOfficialId,
	validateOfficialVersion,
} from "./official-catalog.ts";
import { OfficialFileStore, officialMissing } from "./official-files.ts";
import {
	type OfficialInstallationState,
	type OfficialInstalledVersion,
	officialVersionDirectory,
	parseOfficialState,
} from "./official-state.ts";
import { OfficialExtensionError, OfficialTransport } from "./official-transport.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { OfficialPackageInfo } from "./source-info.ts";

export interface OfficialOperationOptions {
	offline: boolean;
	signal: AbortSignal | null;
	timeoutMs: number;
	catalogMaxAgeMs: number;
	refresh: boolean;
	/** Synchronous observation only; observer failures never change transaction outcomes. */
	onProgress: ((event: OfficialProgressEvent) => void) | null;
}
export interface OfficialInstallerOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	gripVersion: string;
}
export type OfficialProgressPhase =
	| "downloading"
	| "verifying"
	| "staged"
	| "journaled"
	| "promoted"
	| "membership"
	| "activated"
	| "remove-journaled"
	| "removed-membership"
	| "removed";

export interface OfficialProgressEvent {
	phase: OfficialProgressPhase;
	id: string;
}

export interface OfficialInstallerDependencies {
	transport: OfficialTransport;
	now: () => number;
	onProgress: (event: OfficialProgressEvent) => Promise<void>;
}
export interface OfficialCatalogResult {
	catalog: OfficialCatalog;
	fetchedAt: number;
	stale: boolean;
	error: OfficialExtensionError | null;
}
export interface OfficialInstallation {
	path: string;
	installed: OfficialInstalledVersion;
	release: OfficialRelease;
}
export interface OfficialStartupOptions {
	policy: Partial<OfficialUpdatePolicy>;
	offline: boolean;
	noExtensions: boolean;
	signal: AbortSignal | null;
}
export interface OfficialStartupDiagnostic {
	source: string;
	code: string;
	message: string;
}
export interface OfficialStartupResult {
	updated: OfficialPackageInfo[];
	diagnostics: OfficialStartupDiagnostic[];
}
type OfficialCatalogLookup = () => Promise<OfficialCatalogResult>;
interface InstallationContext {
	files: OfficialFileStore;
	id: string;
	base: string;
	checkLease: () => void;
	progress: (phase: OfficialProgressPhase) => Promise<void>;
}

/** Storage/transport service consumed by DefaultPackageManager; no parallel extension runtime. */
export class OfficialExtensionInstaller {
	private readonly options: OfficialInstallerOptions;
	private readonly dependencies: OfficialInstallerDependencies;

	constructor(options: OfficialInstallerOptions, dependencies: Partial<OfficialInstallerDependencies> = {}) {
		validateOfficialVersion(options.gripVersion);
		this.options = options;
		this.dependencies = {
			transport: dependencies.transport ?? new OfficialTransport(),
			now: dependencies.now ?? Date.now,
			onProgress: dependencies.onProgress ?? (async () => {}),
		};
	}

	private operationOptions(options: Partial<OfficialOperationOptions>): OfficialOperationOptions {
		const policy = parseOfficialUpdatePolicy({
			requestTimeoutMs: options.timeoutMs,
			catalogMaxAgeMs: options.catalogMaxAgeMs,
		});
		return {
			offline: options.offline === true || process.env.GRIP_OFFLINE === "1" || process.env.GRIP_OFFLINE === "true",
			signal: options.signal ?? null,
			timeoutMs: policy.requestTimeoutMs,
			catalogMaxAgeMs: policy.catalogMaxAgeMs,
			refresh: options.refresh ?? false,
			onProgress: options.onProgress ?? null,
		};
	}

	private async cachedCatalog(
		files: OfficialFileStore,
		operation: OfficialOperationOptions,
	): Promise<OfficialCatalogResult | null> {
		let cached: OfficialCatalogResult | null = null;
		try {
			const raw = JSON.parse(
				(await files.read("official/catalog.json", OFFICIAL_LIMITS.catalogBytes + 1024)).toString("utf8"),
			);
			if (
				raw.schemaVersion === 1 &&
				Number.isSafeInteger(raw.fetchedAt) &&
				raw.fetchedAt >= 0 &&
				raw.fetchedAt <= this.dependencies.now()
			) {
				const catalog = parseOfficialCatalog(raw.catalog);
				if (Buffer.byteLength(officialJson(catalog)) > OFFICIAL_LIMITS.catalogBytes)
					throw new Error("Oversized cached catalog");
				cached = {
					catalog,
					fetchedAt: raw.fetchedAt,
					stale: this.dependencies.now() - raw.fetchedAt >= operation.catalogMaxAgeMs,
					error: null,
				};
			}
		} catch (error) {
			if (error instanceof OfficialExtensionError && error.code === "filesystem") throw error;
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				!(error instanceof OfficialExtensionError) &&
				!officialMissing(error)
			)
				throw error;
		}
		return cached;
	}

	async catalog(options: Partial<OfficialOperationOptions> = {}): Promise<OfficialCatalogResult> {
		const operation = this.operationOptions(options);
		operation.signal?.throwIfAborted();
		const files = await OfficialFileStore.create(this.options.agentDir);
		const cached = await this.cachedCatalog(files, operation);
		if (cached && (operation.offline || (!operation.refresh && !cached.stale))) return cached;
		if (operation.offline)
			throw new OfficialExtensionError("offline", "No valid cached official catalog is available offline");
		try {
			const bytes = await this.dependencies.transport.download(
				OFFICIAL_CATALOG_URL,
				OFFICIAL_LIMITS.catalogBytes,
				operation,
			);
			const catalog = parseOfficialCatalog(JSON.parse(bytes.toString("utf8")));
			const fetchedAt = this.dependencies.now();
			operation.signal?.throwIfAborted();
			await files.atomicWrite(
				"official/catalog.json",
				Buffer.from(officialJson({ schemaVersion: 1, fetchedAt, catalog })),
			);
			return { catalog, fetchedAt, stale: false, error: null };
		} catch (error) {
			const failure =
				error instanceof OfficialExtensionError
					? error
					: new OfficialExtensionError("catalog", "Official catalog validation failed", { cause: error });
			if (!cached || operation.signal?.aborted) throw failure;
			return { ...cached, stale: true, error: failure };
		}
	}

	private async withInstallation<T>(
		id: string,
		operation: OfficialOperationOptions,
		task: (context: InstallationContext) => Promise<T>,
	): Promise<T> {
		validateOfficialId(id);
		operation.signal?.throwIfAborted();
		const files = await OfficialFileStore.create(this.options.agentDir);
		const base = `official/${id}`;
		const root = await files.directory(base);
		let compromised: Error | null = null;
		let release: (() => Promise<void>) | null = null;
		const deadline = Date.now() + 5000;
		while (!release) {
			operation.signal?.throwIfAborted();
			await files.check(`${base}.lock`);
			try {
				release = await lockfile.lock(root, {
					stale: 10000,
					update: 2000,
					retries: 0,
					onCompromised: (error) => {
						compromised = error;
					},
				});
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED"))
					throw error;
				if (Date.now() >= deadline)
					throw new OfficialExtensionError("locked", "Official extension is busy in another process");
				await sleep(20, undefined, { signal: operation.signal ?? undefined });
			}
		}
		const context: InstallationContext = {
			files,
			id,
			base,
			checkLease: () => {
				operation.signal?.throwIfAborted();
				if (compromised)
					throw new OfficialExtensionError("locked", "Official installation lock was lost", {
						cause: compromised,
					});
			},
			progress: async (phase) => {
				try {
					operation.onProgress?.({ phase, id });
				} catch {
					// A disposed or failing presentation observer cannot invalidate a commit.
				}
				await this.dependencies.onProgress({ phase, id });
			},
		};
		let succeeded = false;
		try {
			context.checkLease();
			const result = await task(context);
			succeeded = true;
			return result;
		} finally {
			await release().catch((error: unknown) => {
				if (succeeded && !compromised) throw error;
			});
		}
	}

	private async state(context: InstallationContext): Promise<OfficialInstallationState> {
		try {
			return parseOfficialState(
				JSON.parse((await context.files.read(`${context.base}/state.json`, 65536)).toString("utf8")),
				context.id,
			);
		} catch (error) {
			if (!officialMissing(error))
				throw new OfficialExtensionError("state", "Official installation state is corrupt or unsafe", {
					cause: error,
				});
			return { schemaVersion: 1, id: context.id, active: null, pending: null, failure: null };
		}
	}

	private async saveState(context: InstallationContext, state: OfficialInstallationState): Promise<void> {
		context.checkLease();
		await context.files.atomicWrite(
			`${context.base}/state.json`,
			Buffer.from(officialJson(parseOfficialState(state, context.id))),
		);
	}

	private async version(
		context: InstallationContext,
		installed: OfficialInstalledVersion,
	): Promise<OfficialInstallation> {
		const release = parseOfficialRelease(
			JSON.parse(
				(
					await context.files.read(
						`${context.base}/releases/${installed.sha256}.json`,
						OFFICIAL_LIMITS.catalogBytes,
					)
				).toString("utf8"),
			),
			context.id,
		);
		if (release.manifest.version !== installed.version || release.artifact.sha256 !== installed.sha256)
			throw new OfficialExtensionError("integrity", "Official version receipt mismatch");
		const bytes = await context.files.read(
			`${context.base}/archives/${installed.sha256}.gz`,
			OFFICIAL_LIMITS.artifactBytes,
		);
		const artifact = decodeOfficialArtifact(bytes, release);
		const directory = `${context.base}/${installed.directory}`;
		const expected = new Set(artifact.files.map((file) => file.path));
		const directories = new Set<string>();
		for (const path of expected) {
			const parts = path.split("/");
			for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join("/"));
		}
		const visit = async (relative: string): Promise<void> => {
			context.checkLease();
			const path = relative ? `${directory}/${relative}` : directory;
			const handle = await opendir(await context.files.check(path));
			for await (const entry of handle) {
				context.checkLease();
				const child = relative ? `${relative}/${entry.name}` : entry.name;
				await context.files.check(`${directory}/${child}`);
				if (entry.isDirectory() && directories.has(child)) await visit(child);
				else if (!entry.isFile() || !expected.has(child))
					throw new OfficialExtensionError("integrity", "Unexpected official version content");
			}
		};
		await visit("");
		for (const file of artifact.files) {
			context.checkLease();
			const expectedBytes = Buffer.from(file.base64, "base64");
			if (!(await context.files.read(`${directory}/${file.path}`, expectedBytes.length)).equals(expectedBytes))
				throw new OfficialExtensionError("integrity", "Official installed file differs from its verified artifact");
		}
		context.checkLease();
		return { path: join(context.files.root, directory), installed, release };
	}

	private async recover(context: InstallationContext): Promise<OfficialInstallationState> {
		const state = await this.state(context);
		const desired = await this.options.settingsManager.hasOfficialPackageReferences(context.id);
		if (state.pending) {
			const pending = state.pending;
			if (pending.operation === "install" && pending.target && desired) {
				try {
					await this.version(context, pending.target);
					state.active = pending.target;
					state.failure = null;
				} catch {
					state.failure = {
						code: "recovery",
						message: "Interrupted official installation could not be validated",
						at: this.dependencies.now(),
					};
					context.checkLease();
				}
			}
			if (!desired) state.active = null;
			state.pending = null;
			await this.saveState(context, state);
		} else if (!desired && state.active) {
			state.active = null;
			await this.saveState(context, state);
		}
		return state;
	}

	private compatibleInstallation(id: string, installation: OfficialInstallation | null): OfficialInstallation | null {
		return installation && selectOfficialRelease({ id, releases: [installation.release] }, this.options.gripVersion)
			? installation
			: null;
	}

	async active(id: string, options: Partial<OfficialOperationOptions> = {}): Promise<OfficialInstallation | null> {
		return this.withInstallation(id, this.operationOptions(options), async (context) => {
			const state = await this.recover(context);
			if (!state.active) return null;
			const installation = await this.version(context, state.active);
			if (!this.compatibleInstallation(id, installation)) {
				throw new OfficialExtensionError(
					"incompatible",
					`Installed official extension ${id} does not support Grip ${this.options.gripVersion}`,
				);
			}
			return installation;
		});
	}

	async install(id: string, options: Partial<OfficialOperationOptions> = {}): Promise<OfficialInstallation> {
		const operation = this.operationOptions(options);
		return this.withInstallation(id, operation, async (context) => {
			const state = await this.recover(context);
			if (state.active && !(await this.options.settingsManager.officialPackageMembership(id, null))) {
				const installed = this.compatibleInstallation(id, await this.version(context, state.active));
				if (installed) {
					// Reuse verified shared code when selecting it in another profile, including offline.
					await this.options.settingsManager.officialPackageMembership(id, true);
					await context.progress("membership");
					context.checkLease();
					return installed;
				}
			}
			return this.installLocked(context, state, false, operation, null);
		});
	}

	async update(id: string, options: Partial<OfficialOperationOptions> = {}): Promise<OfficialInstallation | null> {
		const operation = this.operationOptions(options);
		return this.withInstallation(id, operation, async (context) => {
			const state = await this.recover(context);
			if (!(await this.options.settingsManager.officialPackageMembership(id, null))) return null;
			return this.installLocked(context, state, true, operation, null);
		});
	}
	/** One bounded batch; the runtime owner is responsible for invoking it only before its first load. */
	async startupUpdates(ids: string[], options: Partial<OfficialStartupOptions> = {}): Promise<OfficialStartupResult> {
		const result: OfficialStartupResult = { updated: [], diagnostics: [] };
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const policy = parseOfficialUpdatePolicy(options.policy);
			const operation = this.operationOptions({
				offline: options.offline,
				signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
				timeoutMs: policy.requestTimeoutMs,
				catalogMaxAgeMs: policy.catalogMaxAgeMs,
			});
			if (!policy.autoUpdate || options.noExtensions || operation.offline || ids.length === 0) return result;
			timer = setTimeout(
				() => controller.abort(new OfficialExtensionError("timeout", "Official startup update budget expired")),
				policy.startupBudgetMs,
			);
			return await this.startupBatch(ids, operation, controller);
		} catch (error) {
			result.diagnostics.push({
				source: "official",
				code: error instanceof OfficialExtensionError ? error.code : "settings",
				message:
					"Official startup updates could not run. Check official update settings and installed extension diagnostics.",
			});
		} finally {
			clearTimeout(timer);
		}
		return result;
	}

	private async startupBatch(
		ids: string[],
		operation: OfficialOperationOptions,
		controller: AbortController,
	): Promise<OfficialStartupResult> {
		const result: OfficialStartupResult = { updated: [], diagnostics: [] };
		let catalog: Promise<OfficialCatalogResult> | null = null;
		const lookup: OfficialCatalogLookup = () => (catalog ??= this.startupCatalog(operation, controller));
		for (const id of new Set(ids)) {
			let source = "official";
			try {
				source = `official:${validateOfficialId(id)}`;
				operation.signal?.throwIfAborted();
				const updated = await this.startupUpdateOne(id, operation, lookup);
				if (updated) result.updated.push({ id, version: updated.installed.version });
			} catch (error) {
				const code = error instanceof OfficialExtensionError ? error.code : "startup";
				const command = source === "official" ? "grip list" : `grip update ${source}`;
				result.diagnostics.push({
					source,
					code,
					message: `Could not automatically update ${source} (${code}). Existing files were retained; run ${command} to review or retry.`,
				});
				if (operation.signal?.aborted) break;
			}
		}
		return result;
	}

	private async startupCatalogAttempt(files: OfficialFileStore): Promise<number | null> {
		let bytes: Buffer;
		try {
			bytes = await files.read("official/.startup/catalog-attempt.json", 1024);
		} catch (error) {
			if (officialMissing(error)) return null;
			throw error;
		}
		try {
			const receipt = officialObject(JSON.parse(bytes.toString("utf8")), "startup catalog receipt");
			if (
				receipt.schemaVersion === 1 &&
				typeof receipt.attemptedAt === "number" &&
				Number.isSafeInteger(receipt.attemptedAt) &&
				receipt.attemptedAt >= 0 &&
				receipt.attemptedAt <= this.dependencies.now()
			)
				return receipt.attemptedAt;
		} catch {
			// Invalid cache metadata is not authority; a bounded catalog request can repair it.
		}
		return null;
	}

	private async startupCatalog(
		operation: OfficialOperationOptions,
		controller: AbortController,
	): Promise<OfficialCatalogResult> {
		operation.signal?.throwIfAborted();
		const files = await OfficialFileStore.create(this.options.agentDir);
		const root = await files.directory("official/.startup");
		await files.check("official/.startup.lock");
		const release = await lockfile
			.lock(root, {
				stale: 10000,
				update: 2000,
				retries: 0,
				onCompromised: (error) =>
					controller.abort(
						new OfficialExtensionError("locked", "Official startup catalog lock was lost", { cause: error }),
					),
			})
			.catch((error: unknown) => {
				throw new OfficialExtensionError("locked", "Official startup catalog is busy", { cause: error });
			});
		try {
			operation.signal?.throwIfAborted();
			const cached = await this.cachedCatalog(files, operation);
			if (cached && !cached.stale) return cached;
			const now = this.dependencies.now();
			const attemptedAt = await this.startupCatalogAttempt(files);
			if (attemptedAt !== null && now - attemptedAt < 60000)
				throw new OfficialExtensionError("backoff", "Official catalog retry is deferred after a recent attempt");
			operation.signal?.throwIfAborted();
			await files.atomicWrite(
				"official/.startup/catalog-attempt.json",
				Buffer.from(officialJson({ schemaVersion: 1, attemptedAt: now })),
			);
			operation.signal?.throwIfAborted();
			const discovery = await this.catalog(operation);
			if (discovery.error) throw discovery.error;
			return discovery;
		} finally {
			await release();
		}
	}

	private async startupUpdateOne(
		id: string,
		operation: OfficialOperationOptions,
		lookup: OfficialCatalogLookup,
	): Promise<OfficialInstallation | null> {
		return this.withInstallation(id, operation, async (context) => {
			const state = await this.recover(context);
			if (!state.active || !(await this.options.settingsManager.hasOfficialPackageReferences(id))) return null;
			const previous = state.active.version;
			const installed = await this.installLocked(context, state, true, operation, lookup);
			return installed.installed.version === previous ? null : installed;
		});
	}

	private async stageVersion(
		context: InstallationContext,
		state: OfficialInstallationState,
		release: OfficialRelease,
		bytes: Buffer,
	): Promise<OfficialInstalledVersion> {
		const artifact = decodeOfficialArtifact(bytes, release);
		context.checkLease();
		const installed: OfficialInstalledVersion = {
			version: release.manifest.version,
			sha256: release.artifact.sha256,
			directory: officialVersionDirectory(release.manifest.version, release.artifact.sha256),
		};
		const staging = `${context.base}/staging/${randomUUID()}`;
		await context.files.directory(staging);
		for (const file of artifact.files) {
			context.checkLease();
			await context.files.writeNew(`${staging}/${file.path}`, Buffer.from(file.base64, "base64"));
		}
		await context.files.atomicWrite(`${context.base}/archives/${installed.sha256}.gz`, bytes, true);
		await context.files.atomicWrite(
			`${context.base}/releases/${installed.sha256}.json`,
			Buffer.from(officialJson(release)),
			true,
		);
		await context.progress("staged");
		state.pending = { operation: "install", target: installed };
		await this.saveState(context, state);
		await context.progress("journaled");
		try {
			await this.version(context, installed);
		} catch (error) {
			if (!officialMissing(error)) throw error;
			context.checkLease();
			await context.files.promote(staging, `${context.base}/${installed.directory}`);
		}
		await this.version(context, installed);
		await context.progress("promoted");
		return installed;
	}

	private async installLocked(
		context: InstallationContext,
		state: OfficialInstallationState,
		updateOnly: boolean,
		operation: OfficialOperationOptions,
		lookup: OfficialCatalogLookup | null,
	): Promise<OfficialInstallation> {
		const current = state.active ? await this.version(context, state.active) : null;
		const compatibleCurrent = this.compatibleInstallation(context.id, current);
		if (operation.offline && compatibleCurrent) return compatibleCurrent;
		try {
			const discovery = await (lookup ? lookup() : this.catalog(operation));
			const entry = discovery.catalog.extensions.find((entry) => entry.id === context.id);
			const release = entry
				? selectOfficialRelease(entry, this.options.gripVersion, current?.installed.version ?? null)
				: null;
			if (!release) {
				if (compatibleCurrent) return compatibleCurrent;
				throw new OfficialExtensionError(
					"incompatible",
					"No compatible stable official extension release is available",
				);
			}
			if (operation.offline)
				throw new OfficialExtensionError("offline", "Official installation needs an artifact download");
			await context.progress("downloading");
			context.checkLease();
			const bytes = await this.dependencies.transport.download(
				release.artifact.url,
				OFFICIAL_LIMITS.artifactBytes,
				operation,
			);
			await context.progress("verifying");
			context.checkLease();
			const installed = await this.stageVersion(context, state, release, bytes);
			context.checkLease();
			if (updateOnly) {
				if (!(await this.options.settingsManager.hasOfficialPackageReferences(context.id)))
					throw new OfficialExtensionError("removed", "Official extension was removed during update");
			} else await this.options.settingsManager.officialPackageMembership(context.id, true);
			await context.progress("membership");
			context.checkLease();
			state.active = installed;
			state.pending = null;
			state.failure = null;
			await this.saveState(context, state);
			await context.progress("activated");
			return { path: join(context.files.root, context.base, installed.directory), installed, release };
		} catch (error) {
			throw await this.installFailure(context, error);
		}
	}

	private async installFailure(context: InstallationContext, error: unknown): Promise<OfficialExtensionError> {
		const failure =
			error instanceof OfficialExtensionError
				? error
				: new OfficialExtensionError("install", "Official installation failed", { cause: error });
		try {
			// Record against the last committed journal, never an uncommitted in-memory promotion.
			const state = await this.state(context);
			state.failure = {
				code: failure.code,
				message: failure.message
					.replace(/[\x00-\x1f\x7f]/g, " ")
					.trim()
					.slice(0, 2048),
				at: this.dependencies.now(),
			};
			await this.saveState(context, state);
		} catch {
			/* Preserve the last atomic state if persistence or confinement failed. */
		}
		return failure;
	}

	async remove(id: string, options: Partial<OfficialOperationOptions> = {}): Promise<void> {
		return this.withInstallation(id, this.operationOptions(options), async (context) => {
			let state: OfficialInstallationState;
			try {
				state = await this.recover(context);
			} catch (error) {
				// Missing/corrupt state grants no ownership. Membership can still be explicitly removed.
				if (!(error instanceof OfficialExtensionError && error.code === "state")) throw error;
				await this.options.settingsManager.officialPackageMembership(id, false);
				return;
			}
			state.pending = { operation: "remove", target: null };
			await this.saveState(context, state);
			await context.progress("remove-journaled");
			context.checkLease();
			await this.options.settingsManager.officialPackageMembership(id, false);
			await context.progress("removed-membership");
			if (!(await this.options.settingsManager.hasOfficialPackageReferences(id))) state.active = null;
			state.pending = null;
			state.failure = null;
			await this.saveState(context, state);
			// Versions/archives are retained: another process may still lazy-import their code.
			// No user data, unmanaged sources, or other extension IDs are deleted.
			await context.progress("removed");
		});
	}
}
