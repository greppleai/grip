import { describe, expect, it, vi } from "vitest";
import type { InstalledExtension } from "../src/core/extension-inventory.ts";
import type { OfficialCatalogView } from "../src/core/official-catalog-view.ts";
import type { OfficialOperationOptions } from "../src/core/official-installer.ts";
import { OfficialExtensionError } from "../src/core/official-transport.ts";
import type { PackageManager } from "../src/core/package-manager.ts";
import { ExtensionManagerController } from "../src/modes/interactive/extension-manager.ts";
import { GIT_EXTENSION_URL, gitExtensionReview } from "./fixtures/git-extension-review.ts";

function installation(source = "official:fixture", managed = true): InstalledExtension {
	return {
		identity: JSON.stringify(["user", source]),
		source,
		scope: "user",
		configured: true,
		installedPath: "/managed/fixture",
		version: "1.0.0",
		status: "loaded",
		removal: managed ? { source, scope: "user" } : null,
		entries: [],
		errors: [],
	};
}

function catalog(): OfficialCatalogView {
	return {
		fetchedAt: 100,
		stale: false,
		error: null,
		offline: false,
		extensions: [
			{
				id: "fixture",
				compatibleVersion: "1.0.0",
				unavailableReason: null,
				manifest: {
					name: "fixture",
					version: "1.0.0",
					description: "Fixture extension",
					type: "module",
					engines: { grip: "*" },
					grip: {
						official: { id: "fixture", displayName: "Fixture" },
						extensions: ["index.js"],
						skills: [],
						rules: [],
						prompts: [],
						themes: [],
					},
				},
			},
		],
	};
}

function harness(rows: InstalledExtension[] = []) {
	const getExtensionInventory = vi.fn(async () => rows);
	const getOfficialCatalog = vi.fn<PackageManager["getOfficialCatalog"]>(async () => catalog());
	const installAndPersist = vi.fn<PackageManager["installAndPersist"]>(async () => {});
	const removeAndPersist = vi.fn<PackageManager["removeAndPersist"]>(async () => true);
	const prepareGitExtension = vi.fn<PackageManager["prepareGitExtension"]>(async (_source, options) =>
		gitExtensionReview(options.scope),
	);
	const installPreparedGitExtension = vi.fn<PackageManager["installPreparedGitExtension"]>(
		async () => `${GIT_EXTENSION_URL}@${"a".repeat(40)}`,
	);
	const discardGitExtension = vi.fn<PackageManager["discardGitExtension"]>();
	const onChange = vi.fn();
	const manager = new ExtensionManagerController({
		resourceLoader: { getExtensionInventory },
		packageManager: {
			getOfficialCatalog,
			installAndPersist,
			removeAndPersist,
			prepareGitExtension,
			installPreparedGitExtension,
			discardGitExtension,
		},
		onChange,
	});
	return {
		manager,
		getExtensionInventory,
		getOfficialCatalog,
		installAndPersist,
		removeAndPersist,
		onChange,
		prepareGitExtension,
		installPreparedGitExtension,
		discardGitExtension,
	};
}

async function selectCatalog(manager: ExtensionManagerController): Promise<void> {
	await manager.initialize();
	await manager.openCatalog();
	manager.showDetail({ kind: "catalog", id: "fixture" });
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("extension manager controller", () => {
	it("starts from inventory, not catalog discovery, and retains missing/failed/disabled/unmanaged remote provenance", async () => {
		const rows = [installation(), installation("npm:third-party"), installation("npm:unmanaged", false)];
		rows[0].status = "disabled";
		rows[1].status = "failed";
		rows[1].errors = ["Factory failed"];
		rows[2].status = "missing";
		rows[2].version = null;
		const h = harness(rows);
		await h.manager.initialize();
		expect(h.manager.getState()).toMatchObject({
			page: "installed",
			inventoryReady: true,
			inventory: rows,
			catalog: null,
			activity: null,
		});
		expect(h.getOfficialCatalog).not.toHaveBeenCalled();
		const detached = h.manager.getState();
		detached.inventory[2].removal = { source: "official:fixture", scope: "user" };
		detached.inventory[1].errors.push("forged");
		expect(h.manager.getState().inventory).toEqual(rows);
		rows[0].version = "forged";
		expect(h.manager.getState().inventory[0].version).toBe("1.0.0");
	});

	it.each([
		"official:fixture",
		"npm:@acme/fixture@1.0.0",
		"git:github.com/acme/fixture",
		"git:git@github.com:acme/fixture.git",
		"https://example.com/acme/fixture.git",
		"ssh://git@example.com/acme/fixture.git",
	])("lists remote source %s without exposing or changing local inventory", async (source) => {
		const localSources = [
			"auto",
			"/manual/local.ts",
			"./local-package",
			"../local-package",
			"~/local-package",
			"C:\\local\\fixture",
			"relative/path",
			"<inline>",
			"unclassified",
		];
		const locals = localSources.map((local) => installation(local, false));
		const remote = installation(source);
		const rows = [...locals, remote];
		const h = harness(rows);
		await h.manager.initialize();
		expect(h.manager.getState().inventory).toEqual([remote]);
		for (const local of locals) {
			h.manager.showDetail({ kind: "installed", identity: local.identity });
			expect(h.manager.getState().page).toBe("installed");
		}
		h.manager.showDetail({ kind: "installed", identity: remote.identity });
		expect(h.manager.getState()).toMatchObject({ page: "detail", target: { identity: remote.identity } });
		rows.push(installation("./new-local-package"));
		await h.manager.initialize();
		expect(h.manager.getState().inventory).toEqual([remote]);
		expect(await h.getExtensionInventory()).toBe(rows);
		expect(rows.map((row) => row.source)).toEqual([...localSources, source, "./new-local-package"]);
		expect(h.getOfficialCatalog).not.toHaveBeenCalled();
		await h.manager.dispose();
	});

	it("supports an empty installed list/catalog and navigates back without fabricating entries", async () => {
		const h = harness();
		h.getOfficialCatalog.mockResolvedValue({ ...catalog(), extensions: [] });
		await h.manager.initialize();
		expect(h.manager.back()).toBe(true);
		await h.manager.openCatalog();
		h.manager.showDetail({ kind: "catalog", id: "absent" });
		expect(h.manager.getState()).toMatchObject({ page: "catalog", inventory: [], catalog: { extensions: [] } });
		expect(h.manager.back()).toBe(false);
		expect(h.manager.getState().page).toBe("installed");
		expect(h.installAndPersist).not.toHaveBeenCalled();
	});

	it("reuses catalog metadata until explicit refresh and retains offline/stale/typed error states", async () => {
		const h = harness();
		const result = catalog();
		result.offline = true;
		result.stale = true;
		result.error = new OfficialExtensionError("network", "Check network", { cause: () => "not cloneable" });
		h.getOfficialCatalog.mockResolvedValue(result);
		await selectCatalog(h.manager);
		expect(h.manager.getState().catalog).toEqual({
			...result,
			error: new OfficialExtensionError("network", "Check network"),
		});
		expect(h.manager.getState().catalog?.error?.code).toBe("network");
		const detached = h.manager.getState().catalog;
		if (detached?.error) detached.error.message = "forged";
		expect(h.manager.getState().catalog?.error?.message).toBe("Check network");
		h.manager.back();
		await h.manager.openCatalog();
		expect(h.getOfficialCatalog).toHaveBeenCalledTimes(1);
		await h.manager.openCatalog(true);
		expect(h.getOfficialCatalog.mock.calls[1][0]).toMatchObject({ refresh: true, signal: expect.any(AbortSignal) });
		result.extensions[0].compatibleVersion = "forged";
		expect(h.manager.getState().catalog?.extensions[0].compatibleVersion).toBe("1.0.0");
	});

	it("requires a separate install confirmation and returns through detail/catalog/installed", async () => {
		const h = harness();
		await selectCatalog(h.manager);
		h.manager.requestInstall();
		expect(h.manager.getState()).toMatchObject({ page: "confirm", confirmation: { kind: "install", id: "fixture" } });
		await h.manager.initialize(); // Does not confirm the pending action.
		expect(h.installAndPersist).not.toHaveBeenCalled();
		h.manager.back();
		expect(h.manager.getState()).toMatchObject({ page: "detail", confirmation: null });
		h.manager.back();
		expect(h.manager.getState().page).toBe("catalog");
		h.manager.back();
		expect(h.manager.getState().page).toBe("installed");
	});

	it("installs through the canonical manager, refreshes inventory and only marks reload pending", async () => {
		const h = harness();
		await selectCatalog(h.manager);
		h.manager.requestInstall();
		h.installAndPersist.mockImplementation(async (_source, options) => {
			options?.official?.onProgress?.({ phase: "downloading", id: "fixture" });
			expect(h.manager.getState().activity).toMatchObject({
				kind: "install",
				phase: "downloading",
				cancelable: true,
			});
			h.getExtensionInventory.mockResolvedValue([installation()]);
		});
		expect(await h.manager.confirm()).toEqual({ kind: "install", id: "fixture" });
		expect(h.installAndPersist).toHaveBeenCalledExactlyOnceWith("official:fixture", {
			official: { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
		});
		expect(h.getExtensionInventory).toHaveBeenCalledTimes(2);
		expect(h.manager.getState()).toMatchObject({
			page: "detail",
			reloadRequired: true,
			activity: null,
			inventory: [installation()],
		});
		expect(h.manager.getState().notice).toContain("running extensions have not been replaced");
		h.manager.requestInstall();
		expect(h.manager.getState().page).toBe("detail");
		expect(await h.manager.dispose()).toBe(true);
	});

	it("does not offer incompatible/unpublished releases or re-install a known installation", async () => {
		for (const rows of [[], [installation()]]) {
			const h = harness(rows);
			const result = catalog();
			if (rows.length === 0) {
				result.extensions[0].compatibleVersion = null;
				result.extensions[0].unavailableReason = "No compatible stable release";
			}
			h.getOfficialCatalog.mockResolvedValue(result);
			await selectCatalog(h.manager);
			h.manager.requestInstall();
			await h.manager.confirm();
			expect(h.installAndPersist).not.toHaveBeenCalled();
			expect(h.manager.getState().page).toBe("detail");
		}
	});

	it("allows repairing a missing configured installation with confirmation", async () => {
		const row = installation();
		row.installedPath = null;
		row.status = "missing";
		const h = harness([row]);
		await selectCatalog(h.manager);
		h.manager.requestInstall();
		await h.manager.confirm();
		expect(h.installAndPersist).toHaveBeenCalledTimes(1);
	});

	it("ignores local targets without granting removal ownership through catalog matches", async () => {
		const manual = installation("/manual/fixture.js", false);
		const h = harness([manual]);
		await h.manager.initialize();
		expect(h.manager.getState().inventory).toEqual([]);
		h.manager.showDetail({ kind: "installed", identity: manual.identity });
		expect(h.manager.getState().page).toBe("installed");
		h.manager.requestRemove();
		await h.manager.confirm();
		await h.manager.openCatalog();
		h.manager.showDetail({ kind: "catalog", id: "fixture" });
		h.manager.requestRemove();
		await h.manager.confirm();
		expect(h.removeAndPersist).not.toHaveBeenCalled();
		expect(h.manager.getState().confirmation).toBeNull();
	});

	it("confirms owned removal with the correct scope, without promising npm cancellation", async () => {
		const row = installation("npm:third-party");
		row.scope = "project";
		row.removal = { source: row.source, scope: "project" };
		const h = harness([row]);
		await h.manager.initialize();
		h.manager.showDetail({ kind: "installed", identity: row.identity });
		h.manager.requestRemove();
		expect(h.removeAndPersist).not.toHaveBeenCalled();
		h.removeAndPersist.mockImplementation(async () => {
			expect(h.manager.getState().activity?.cancelable).toBe(false);
			h.manager.cancel();
			expect(h.manager.getState().activity?.cancelRequested).toBe(false);
			return true;
		});
		await h.manager.confirm();
		expect(h.removeAndPersist).toHaveBeenCalledExactlyOnceWith(row.source, {
			local: true,
			official: { signal: expect.any(AbortSignal), onProgress: expect.any(Function) },
		});
	});

	it("uses installed ownership for uninstall from catalog detail", async () => {
		const h = harness([installation()]);
		await selectCatalog(h.manager);
		h.manager.requestRemove();
		await h.manager.confirm();
		expect(h.removeAndPersist.mock.calls[0][0]).toBe("official:fixture");
	});

	it("refreshes authoritative inventory after pre/post-commit failure rather than claiming rollback", async () => {
		for (const committed of [false, true]) {
			const h = harness();
			await selectCatalog(h.manager);
			h.manager.requestInstall();
			h.installAndPersist.mockImplementation(async () => {
				if (committed) h.getExtensionInventory.mockResolvedValue([installation()]);
				throw new OfficialExtensionError("canceled", "Operation canceled");
			});
			expect(await h.manager.confirm()).toBeNull();
			expect(h.manager.getState().inventory).toEqual(committed ? [installation()] : []);
			expect(h.manager.getState().notice).toContain("does not guarantee rollback");
			expect(h.manager.getState().reloadRequired).toBe(true);
			expect(h.getExtensionInventory).toHaveBeenCalledTimes(2);
		}
	});

	it("keeps mutations mounted through cancel/back and suppresses overlapping actions", async () => {
		const h = harness();
		const mutation = deferred<void>();
		const entered = deferred<Partial<OfficialOperationOptions>>();
		h.installAndPersist.mockImplementation(async (_source, options) => {
			entered.resolve(options?.official ?? {});
			await mutation.promise;
		});
		await selectCatalog(h.manager);
		h.manager.requestInstall();
		const operation = h.manager.confirm();
		const controls = await entered.promise;
		expect(h.manager.back()).toBe(false);
		expect(controls.signal?.aborted).toBe(true);
		expect(h.manager.getState().activity?.cancelRequested).toBe(true);
		await h.manager.confirm();
		await h.manager.openCatalog(true);
		h.manager.showDetail({ kind: "catalog", id: "fixture" });
		expect(h.installAndPersist).toHaveBeenCalledTimes(1);
		expect(h.getOfficialCatalog).toHaveBeenCalledTimes(1);
		mutation.reject(new Error("Canceled"));
		await operation;
		expect(h.manager.getState()).toMatchObject({ page: "detail", activity: null });
	});

	it("waits for mutation settlement on dispose, aborts and rejects stale progress/result callbacks", async () => {
		const h = harness();
		const mutation = deferred<void>();
		const entered = deferred<Partial<OfficialOperationOptions>>();
		h.installAndPersist.mockImplementation(async (_source, options) => {
			entered.resolve(options?.official ?? {});
			await mutation.promise;
		});
		await selectCatalog(h.manager);
		h.manager.requestInstall();
		const operation = h.manager.confirm();
		const controls = await entered.promise;
		const snapshot = h.manager.getState();
		const notifications = h.onChange.mock.calls.length;
		const closing = h.manager.dispose();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		expect(controls.signal?.aborted).toBe(true);
		controls.onProgress?.({ id: "fixture", phase: "membership" });
		mutation.resolve();
		expect(await operation).toBeNull();
		expect(await closing).toBe(true);
		await h.manager.initialize();
		await h.manager.openCatalog(true);
		h.manager.requestInstall();
		expect(h.manager.back()).toBe(false);
		expect(h.onChange).toHaveBeenCalledTimes(notifications);
		expect(h.manager.getState()).toEqual(snapshot);
		expect(h.getExtensionInventory).toHaveBeenCalledTimes(1);
	});

	it("ignores late inventory and catalog completions after disposal", async () => {
		const h = harness();
		const inventory = deferred<InstalledExtension[]>();
		h.getExtensionInventory.mockReturnValue(inventory.promise);
		const initialization = h.manager.initialize();
		await Promise.resolve();
		const closing = h.manager.dispose();
		const notifications = h.onChange.mock.calls.length;
		inventory.resolve([installation()]);
		await initialization;
		expect(await closing).toBe(false);
		expect(h.manager.getState().inventory).toEqual([]);
		expect(h.onChange).toHaveBeenCalledTimes(notifications);

		const other = harness();
		await other.manager.initialize();
		const discovery = deferred<OfficialCatalogView>();
		other.getOfficialCatalog.mockReturnValue(discovery.promise);
		const opening = other.manager.openCatalog();
		await Promise.resolve();
		const disposed = other.manager.dispose();
		discovery.resolve(catalog());
		await opening;
		await disposed;
		expect(other.manager.getState().catalog).toBeNull();
	});

	it("fails closed on unknown inventory and allows retry without losing existing rows", async () => {
		const h = harness([installation()]);
		h.getExtensionInventory.mockRejectedValueOnce(new Error("Settings unavailable"));
		await selectCatalog(h.manager);
		h.manager.requestInstall();
		h.manager.requestRemove();
		expect(h.manager.getState()).toMatchObject({
			inventoryReady: false,
			inventoryError: "Settings unavailable",
			confirmation: null,
		});
		await h.manager.initialize();
		h.manager.requestRemove();
		expect(h.manager.getState().page).toBe("confirm");
		h.getExtensionInventory.mockRejectedValueOnce(new Error("Inventory refresh failed"));
		await h.manager.confirm();
		expect(h.manager.getState()).toMatchObject({
			inventoryError: "Inventory refresh failed",
			inventory: [installation()],
		});
		h.manager.requestRemove();
		expect(h.manager.getState().confirmation).toBeNull();
	});

	it("handles discovery exceptions, cancellation and retry while preserving cached catalog", async () => {
		const h = harness();
		await h.manager.initialize();
		h.getOfficialCatalog.mockRejectedValueOnce(new Error("Catalog unavailable"));
		await h.manager.openCatalog();
		expect(h.manager.getState()).toMatchObject({ page: "catalog", notice: "Catalog unavailable", activity: null });
		await h.manager.openCatalog(true);
		const discovery = deferred<OfficialCatalogView>();
		h.getOfficialCatalog.mockReturnValueOnce(discovery.promise);
		const refresh = h.manager.openCatalog(true);
		await Promise.resolve();
		h.manager.back();
		expect(h.getOfficialCatalog.mock.calls[2][0]?.signal?.aborted).toBe(true);
		discovery.reject(new Error("Discovery canceled"));
		await refresh;
		expect(h.manager.getState().catalog).toEqual(catalog());
		expect(h.manager.getState().activity).toBeNull();
	});

	it("does not let a synchronous close or throwing observer start an orphaned mutation", async () => {
		const h = harness();
		await selectCatalog(h.manager);
		h.manager.requestInstall();
		let closing: Promise<boolean> | null = null;
		h.onChange.mockImplementation(() => {
			closing = h.manager.dispose();
			throw new Error("Detached UI");
		});
		await h.manager.confirm();
		expect(await closing).toBe(false);
		expect(h.installAndPersist).not.toHaveBeenCalled();
	});
});

describe("Git extension manager controller", () => {
	it.each([
		"npm:extension",
		"./extension",
		"http://example.com/repo",
		"git@example.com:repo",
		"https://token@example.com/repo",
	])("rejects unsupported input %s without preparing", async (source) => {
		const h = harness();
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(source);
		await h.manager.prepareGit("user");
		expect(h.manager.getState().page).toBe("git-input");
		expect(h.manager.getState().notice).toMatch(/HTTPS or SSH|credentials/);
		expect(h.prepareGitExtension).not.toHaveBeenCalled();
		expect(h.installAndPersist).not.toHaveBeenCalled();
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
		expect(await h.manager.dispose()).toBe(false);
	});

	it.each(["user", "project"] as const)(
		"prepares %s scope and requires a separate explicit approval",
		async (scope) => {
			const h = harness();
			await h.manager.initialize();
			h.manager.openGitInput();
			h.manager.requestGitPreparation(` ${GIT_EXTENSION_URL}@main `);
			expect(h.prepareGitExtension).not.toHaveBeenCalled();
			expect(h.manager.getState().page).toBe("git-scope");
			await h.manager.prepareGit(scope);
			expect(h.prepareGitExtension).toHaveBeenCalledWith(`${GIT_EXTENSION_URL}@main`, {
				scope,
				signal: expect.any(AbortSignal),
			});
			expect(h.manager.getState().gitPreparation).toEqual(gitExtensionReview(scope));
			expect(h.manager.getState().page).toBe("git-review");
			expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
			expect(h.manager.getState().reloadRequired).toBe(false);
			expect(h.manager.back()).toBe(false);
			expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
			expect(h.manager.getState().gitPreparation).toBeNull();
			expect(await h.manager.approveGit()).toBe(false);
			expect(await h.manager.dispose()).toBe(false);
		},
	);

	it("retains actionable preparation errors without selecting or running code", async () => {
		const h = harness();
		h.prepareGitExtension.mockRejectedValue(new Error("No concrete grip.extensions entries"));
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		await h.manager.prepareGit("user");
		expect(h.manager.getState()).toMatchObject({
			page: "git-scope",
			notice: "No concrete grip.extensions entries",
			gitPreparation: null,
			reloadRequired: false,
		});
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
		expect(await h.manager.dispose()).toBe(false);
	});

	it("aborts preparation, awaits its late result and discards it exactly once", async () => {
		const h = harness();
		const pending = deferred<ReturnType<typeof gitExtensionReview>>();
		h.prepareGitExtension.mockReturnValue(pending.promise);
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		const preparing = h.manager.prepareGit("project");
		await vi.waitFor(() => expect(h.prepareGitExtension).toHaveBeenCalledOnce());
		expect(h.manager.back()).toBe(false);
		expect(h.prepareGitExtension.mock.calls[0][1].signal.aborted).toBe(true);
		expect(h.manager.getState().activity?.cancelRequested).toBe(true);
		await h.manager.prepareGit("project");
		expect(h.discardGitExtension).not.toHaveBeenCalled();
		pending.resolve(gitExtensionReview("project"));
		await preparing;
		expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
		expect(h.manager.getState()).toMatchObject({
			page: "git-input",
			gitPreparation: null,
			activity: null,
			reloadRequired: false,
		});
		expect(h.manager.getState().notice).toContain("No code was approved");
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
		await h.manager.dispose();
	});

	it("waits for in-flight preparation on disposal and suppresses its late review", async () => {
		const h = harness();
		const pending = deferred<ReturnType<typeof gitExtensionReview>>();
		h.prepareGitExtension.mockReturnValue(pending.promise);
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		const preparing = h.manager.prepareGit("user");
		await vi.waitFor(() => expect(h.prepareGitExtension).toHaveBeenCalledOnce());
		const closing = h.manager.dispose();
		const count = h.onChange.mock.calls.length;
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		pending.resolve(gitExtensionReview());
		await preparing;
		expect(await closing).toBe(false);
		expect(h.onChange).toHaveBeenCalledTimes(count);
		expect(h.manager.getState().gitPreparation).toBeNull();
		expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
	});

	it("discards completed reviews on close without installing", async () => {
		const h = harness();
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		await h.manager.prepareGit("user");
		expect(await h.manager.dispose()).toBe(false);
		await h.manager.dispose();
		expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
	});

	it("settles approval once, ignores cancellation and duplicate approval, then refreshes inventory", async () => {
		const h = harness();
		const install = deferred<string>();
		const inventory = deferred<InstalledExtension[]>();
		h.installPreparedGitExtension.mockReturnValue(install.promise);
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		await h.manager.prepareGit("user");
		h.getExtensionInventory.mockReturnValueOnce(inventory.promise);
		const approving = h.manager.approveGit();
		await vi.waitFor(() => expect(h.installPreparedGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture"));
		expect(await h.manager.approveGit()).toBe(false);
		expect(h.manager.back()).toBe(false);
		expect(h.manager.getState().activity).toMatchObject({
			kind: "git-install",
			cancelable: false,
			cancelRequested: false,
		});
		expect(h.discardGitExtension).not.toHaveBeenCalled();
		install.resolve(`${GIT_EXTENSION_URL}@${"a".repeat(40)}`);
		await vi.waitFor(() => expect(h.getExtensionInventory).toHaveBeenCalledTimes(2));
		expect(h.manager.getState().activity?.kind).toBe("git-install");
		inventory.resolve([]);
		expect(await approving).toBe(true);
		expect(h.manager.getState().notice).toContain("Activation is pending");
		expect(h.manager.getState().reloadRequired).toBe(true);
		expect(h.installAndPersist).not.toHaveBeenCalled();
		expect(await h.manager.dispose()).toBe(true);
	});

	it.each(["Dependency scripts failed", "Files installed, but package selection could not be verified"])(
		"reconciles inventory after approved failure: %s",
		async (message) => {
			const h = harness();
			h.installPreparedGitExtension.mockRejectedValue(new Error(message));
			await h.manager.initialize();
			h.manager.openGitInput();
			h.manager.requestGitPreparation(GIT_EXTENSION_URL);
			await h.manager.prepareGit("user");
			expect(await h.manager.approveGit()).toBe(false);
			expect(h.getExtensionInventory).toHaveBeenCalledTimes(2);
			expect(h.manager.getState()).toMatchObject({
				page: "installed",
				gitPreparation: null,
				reloadRequired: true,
				activity: null,
			});
			expect(h.manager.getState().notice).toContain(message);
			expect(h.manager.getState().notice).toContain("Review inventory/settings");
			expect(h.discardGitExtension).not.toHaveBeenCalled();
			expect(await h.manager.dispose()).toBe(true);
		},
	);

	it("does not close as a successful install if inventory reconciliation fails", async () => {
		const h = harness();
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		await h.manager.prepareGit("user");
		h.getExtensionInventory.mockRejectedValueOnce(new Error("Cannot read settings"));
		expect(await h.manager.approveGit()).toBe(false);
		expect(h.manager.getState().inventoryError).toBe("Cannot read settings");
		expect(h.manager.getState().reloadRequired).toBe(true);
		await h.manager.dispose();
	});

	it("discards an unused approval if a synchronous close prevents installation from starting", async () => {
		const h = harness();
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		await h.manager.prepareGit("user");
		let closing: Promise<boolean> | null = null;
		h.onChange.mockImplementation(() => {
			closing = h.manager.dispose();
		});
		expect(await h.manager.approveGit()).toBe(false);
		expect(await closing).toBe(false);
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
		expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
	});

	it("awaits uncancelable approved installation on disposal without discarding its checkout", async () => {
		const h = harness();
		const pending = deferred<string>();
		h.installPreparedGitExtension.mockReturnValue(pending.promise);
		await h.manager.initialize();
		h.manager.openGitInput();
		h.manager.requestGitPreparation(GIT_EXTENSION_URL);
		await h.manager.prepareGit("user");
		const approving = h.manager.approveGit();
		await vi.waitFor(() => expect(h.installPreparedGitExtension).toHaveBeenCalledOnce());
		const closing = h.manager.dispose();
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(h.discardGitExtension).not.toHaveBeenCalled();
		pending.resolve("pinned source");
		expect(await approving).toBe(false);
		expect(await closing).toBe(true);
		expect(h.getExtensionInventory).toHaveBeenCalledOnce();
	});
});
