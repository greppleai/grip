import type { InstalledExtension } from "../../core/extension-inventory.ts";
import type { OfficialCatalogView } from "../../core/official-catalog-view.ts";
import type {
	OfficialOperationOptions,
	OfficialProgressEvent,
	OfficialProgressPhase,
} from "../../core/official-installer.ts";
import { OfficialExtensionError } from "../../core/official-transport.ts";
import type { ConfiguredPackageTarget, PackageManager } from "../../core/package-manager.ts";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import { parseGitUrl } from "../../utils/git.ts";

export type ExtensionManagerList = "installed" | "catalog";
export type ExtensionManagerPage = ExtensionManagerList | "detail" | "confirm";
export type ExtensionManagerActivityKind = "inventory" | "catalog" | "install" | "remove";
export type ExtensionManagerTarget = { kind: "installed"; identity: string } | { kind: "catalog"; id: string };
export type ExtensionManagerAction = { kind: "install"; id: string } | { kind: "remove"; identity: string };

export interface ExtensionManagerActivity {
	kind: ExtensionManagerActivityKind;
	phase: OfficialProgressPhase | null;
	cancelable: boolean;
	cancelRequested: boolean;
}

export interface ExtensionManagerState {
	page: ExtensionManagerPage;
	origin: ExtensionManagerList;
	target: ExtensionManagerTarget | null;
	confirmation: ExtensionManagerAction | null;
	inventory: InstalledExtension[];
	inventoryReady: boolean;
	inventoryError: string | null;
	catalog: OfficialCatalogView | null;
	activity: ExtensionManagerActivity | null;
	notice: string | null;
	/** Conservative reconciliation requirement, not a claim that running factories changed. */
	reloadRequired: boolean;
}

export interface ExtensionManagerOptions {
	packageManager: Pick<PackageManager, "getOfficialCatalog" | "installAndPersist" | "removeAndPersist">;
	resourceLoader: Pick<ResourceLoader, "getExtensionInventory">;
	onChange: () => void;
}

function detachedCatalog(catalog: OfficialCatalogView): OfficialCatalogView {
	// structuredClone(Error) drops custom properties, including the actionable error code.
	const copy: OfficialCatalogView = structuredClone({ ...catalog, error: null });
	if (catalog.error) copy.error = new OfficialExtensionError(catalog.error.code, catalog.error.message);
	return copy;
}

/** Management state only: no transport, filesystem, installation or reload implementation. */
export class ExtensionManagerController {
	private readonly options: ExtensionManagerOptions;
	private readonly state: ExtensionManagerState = {
		page: "installed",
		origin: "installed",
		target: null,
		confirmation: null,
		inventory: [],
		inventoryReady: false,
		inventoryError: null,
		catalog: null,
		activity: null,
		notice: null,
		reloadRequired: false,
	};
	private disposed = false;
	private abort: AbortController | null = null;
	private pending: Promise<void> = Promise.resolve();

	constructor(options: ExtensionManagerOptions) {
		this.options = options;
	}

	getState(): ExtensionManagerState {
		const snapshot: ExtensionManagerState = structuredClone({ ...this.state, catalog: null });
		if (this.state.catalog) snapshot.catalog = detachedCatalog(this.state.catalog);
		return snapshot;
	}

	private changed(): void {
		if (this.disposed) return;
		try {
			this.options.onChange();
		} catch {
			// A detached presentation observer must not invalidate a management operation.
		}
	}

	private async readInventory(): Promise<void> {
		try {
			const inventory = await this.options.resourceLoader.getExtensionInventory();
			if (this.disposed) return;
			// Keep local discovery in the resource loader; this manager lists remote packages only.
			this.state.inventory = structuredClone(
				inventory.filter(
					(row) =>
						row.source.startsWith("official:") ||
						row.source.startsWith("npm:") ||
						parseGitUrl(row.source) !== null,
				),
			);
			this.state.inventoryReady = true;
			this.state.inventoryError = null;
		} catch (error) {
			if (this.disposed) return;
			this.state.inventoryError = error instanceof Error ? error.message : String(error);
		}
	}

	private async run(
		kind: ExtensionManagerActivityKind,
		cancelable: boolean,
		action: (signal: AbortSignal) => Promise<void>,
	): Promise<void> {
		if (this.disposed || this.state.activity) return;
		const abort = new AbortController();
		this.abort = abort;
		this.state.activity = { kind, phase: null, cancelable, cancelRequested: false };
		this.state.notice = null;
		// Assign before notifying: a synchronous close must wait for this operation too.
		this.pending = Promise.resolve().then(async () => {
			try {
				if (!this.disposed) await action(abort.signal);
			} catch (error) {
				if (!this.disposed) this.state.notice = error instanceof Error ? error.message : String(error);
			} finally {
				if (!this.disposed) {
					this.abort = null;
					this.state.activity = null;
					this.changed();
				}
			}
		});
		this.changed();
		await this.pending;
	}

	async initialize(): Promise<void> {
		await this.run("inventory", false, () => this.readInventory());
	}

	async openCatalog(refresh = false): Promise<void> {
		if (this.disposed || this.state.activity) return;
		this.state.page = "catalog";
		this.state.target = null;
		this.state.confirmation = null;
		if (this.state.catalog && !refresh) {
			this.changed();
			return;
		}
		await this.run("catalog", true, async (signal) => {
			const catalog = await this.options.packageManager.getOfficialCatalog({ signal, refresh });
			if (!this.disposed) this.state.catalog = detachedCatalog(catalog);
		});
	}

	showDetail(target: ExtensionManagerTarget): void {
		if (this.disposed || this.state.activity) return;
		const exists =
			target.kind === "installed"
				? this.state.inventory.some((row) => row.identity === target.identity)
				: this.state.catalog?.extensions.some((row) => row.id === target.id);
		if (!exists) return;
		this.state.origin = this.state.page === "catalog" ? "catalog" : "installed";
		this.state.target = structuredClone(target);
		this.state.confirmation = null;
		this.state.page = "detail";
		this.changed();
	}

	private catalogInstallation(id: string): InstalledExtension | undefined {
		return this.state.inventory.find(
			(row) => row.source === `official:${id}` && row.scope === "user" && row.configured,
		);
	}

	private installation(): InstalledExtension | undefined {
		const target = this.state.target;
		if (!target) return undefined;
		return target.kind === "installed"
			? this.state.inventory.find((row) => row.identity === target.identity)
			: this.catalogInstallation(target.id);
	}

	requestInstall(): void {
		if (this.disposed || this.state.activity || this.state.page !== "detail") return;
		const target = this.state.target;
		if (!this.state.inventoryReady || this.state.inventoryError || target?.kind !== "catalog") return;
		const item = this.state.catalog?.extensions.find((row) => row.id === target.id);
		if (!item?.compatibleVersion || this.catalogInstallation(target.id)?.installedPath) return;
		this.state.confirmation = { kind: "install", id: target.id };
		this.state.page = "confirm";
		this.changed();
	}

	requestRemove(): void {
		if (this.disposed || this.state.activity || this.state.page !== "detail") return;
		if (!this.state.inventoryReady || this.state.inventoryError) return;
		const row = this.installation();
		if (!row?.removal) return;
		this.state.confirmation = { kind: "remove", identity: row.identity };
		this.state.page = "confirm";
		this.changed();
	}

	private async applyMutation(
		action: ExtensionManagerAction,
		removal: ConfiguredPackageTarget | null | undefined,
		official: Partial<OfficialOperationOptions>,
	): Promise<void> {
		if (action.kind === "install") {
			await this.options.packageManager.installAndPersist(`official:${action.id}`, { official });
		} else if (removal) {
			await this.options.packageManager.removeAndPersist(removal.source, {
				local: removal.scope === "project",
				official,
			});
		}
	}

	async confirm(): Promise<void> {
		if (this.disposed || this.state.activity || this.state.page !== "confirm") return;
		const action = this.state.confirmation;
		if (!action || !this.state.inventoryReady || this.state.inventoryError) return;
		const removal =
			action.kind === "remove"
				? this.state.inventory.find((row) => row.identity === action.identity)?.removal
				: null;
		if (action.kind === "remove" && !removal) return;
		this.state.confirmation = null;
		this.state.page = "detail";
		const official = action.kind === "install" || removal?.source.startsWith("official:") === true;
		await this.run(action.kind, official, async (signal) => {
			// Even a rejected/canceled mutation may have committed membership. Never claim rollback.
			this.state.reloadRequired = true;
			const onProgress = (event: OfficialProgressEvent) => {
				if (this.disposed || !this.state.activity) return;
				this.state.activity.phase = event.phase;
				this.changed();
			};
			try {
				await this.applyMutation(action, removal, { signal, onProgress });
				if (!this.disposed)
					this.state.notice =
						"Saved. Reload/restart to reconcile the runtime; running extensions have not been replaced.";
			} catch (error) {
				if (!this.disposed) {
					const message = error instanceof Error ? error.message : String(error);
					this.state.notice = `${message}. Review inventory: cancellation or failure does not guarantee rollback.`;
				}
			} finally {
				// Do not reuse the operation's aborted signal for authoritative reconciliation.
				if (!this.disposed) await this.readInventory();
			}
		});
	}

	cancel(): void {
		if (this.disposed || !this.state.activity?.cancelable) return;
		this.state.activity.cancelRequested = true;
		this.abort?.abort();
		this.changed();
	}

	/** True asks the host to close; busy mutations stay mounted until they settle. */
	back(): boolean {
		if (this.disposed) return false;
		if (this.state.activity) {
			if (this.state.activity.kind === "inventory") return true;
			this.cancel();
			return false;
		}
		if (this.state.page === "installed") return true;
		if (this.state.page === "confirm") {
			this.state.confirmation = null;
			this.state.page = "detail";
		} else if (this.state.page === "detail") {
			this.state.page = this.state.origin;
			this.state.target = null;
		} else {
			this.state.page = "installed";
		}
		this.changed();
		return false;
	}

	/** Host must await settlement before considering reload; no callbacks survive disposal. */
	async dispose(): Promise<boolean> {
		this.disposed = true;
		this.abort?.abort();
		await this.pending;
		return this.state.reloadRequired;
	}
}
