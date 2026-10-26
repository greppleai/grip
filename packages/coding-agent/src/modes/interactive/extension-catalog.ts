import { readFileSync } from "node:fs";
import type { Extension } from "../../core/extensions/types.ts";
import {
	type CatalogRuntimeOwner,
	getOfficialExtensionAction,
	inspectOfficialExtension,
	OFFICIAL_EXTENSIONS,
	type OfficialExtension,
	type OfficialExtensionAction,
	type OfficialExtensionActionHost,
	type OfficialExtensionActionKind,
	OfficialExtensionActions,
	type OfficialExtensionState,
} from "../../core/official-extensions.ts";
import type { InstalledSourceScope, PackageManager } from "../../core/package-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { type ExtensionCatalogChoice, officialExtensionChoice } from "./components/extension-catalog.ts";

export interface ExtensionCatalogHost extends Omit<OfficialExtensionActionHost, "readState" | "confirm"> {
	packages: Pick<
		PackageManager,
		"listConfiguredPackages" | "getInstalledPath" | "installAndPersist" | "removeAndPersist"
	>;
	hostCwd: string;
	settingsPath: (scope: InstalledSourceScope) => string;
	runtimeOwners: () => readonly CatalogRuntimeOwner[];
	choose: (title: string, choices: readonly ExtensionCatalogChoice[]) => Promise<string | undefined>;
	/** Existing reload lifecycle owns its success/failure diagnostics, not this catalog. */
	reload: () => Promise<void>;
	notify: (message: string, error: boolean) => void;
}

/** Keep every owner, including duplicate, disabled/lazy and inline-factory registrations. */
export function catalogRuntimeOwners(extensions: readonly Extension[]): CatalogRuntimeOwner[] {
	return extensions.map((extension) => ({
		path: extension.resolvedPath,
		source: extension.sourceInfo.source,
		scope: extension.sourceInfo.scope,
		commands: Array.from(extension.commands.keys()),
		tools: Array.from(extension.tools.keys()),
	}));
}

function readCatalogSettings(file: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		value = {};
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Host settings must contain a JSON object. Repair them and use /reload.");
	return value as Record<string, unknown>;
}

/** No reload, locks, writes or network access; refuse stale cached package/filter settings. */
export function catalogConfigurationKey(settings: SettingsManager): string {
	const snapshots = [];
	for (const scope of ["global", "project"] as const) {
		const file = settings.getFilePath(scope);
		if (!file)
			throw new Error("Catalog package actions require file-backed host settings. Use the package CLI instead.");
		if (settings.getLoadError(scope))
			throw new Error("Host settings could not be loaded. Repair them and use /reload.");
		const persisted = readCatalogSettings(file);
		const cached = scope === "global" ? settings.getGlobalSettings() : settings.getProjectSettings();
		const packages = "packages" in persisted ? persisted.packages : [];
		if (JSON.stringify(cached.packages ?? []) !== JSON.stringify(packages))
			throw new Error("Persisted package settings differ from this session. Use /reload before catalog actions.");
		snapshots.push({ file, cached, persisted });
	}
	return JSON.stringify(snapshots);
}

export interface CatalogTerminalHost {
	stop: () => void;
	start: () => void;
	requestRender: () => void;
	isShuttingDown: () => boolean;
}

/** Release terminal ownership for the existing installer's inherited asynchronous output. */
export async function runCatalogPackageOperation(
	host: CatalogTerminalHost,
	operation: () => Promise<void>,
): Promise<void> {
	if (host.isShuttingDown()) throw new Error("Grip is shutting down; no package operation was started.");
	try {
		host.stop();
		if (host.isShuttingDown()) throw new Error("Grip is shutting down; no package operation was started.");
		await operation();
	} finally {
		if (!host.isShuttingDown()) {
			host.start();
			host.requestRender();
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Interactive-only flow. Browsing reads local metadata; only confirmed actions invoke packages. */
export class OfficialExtensionCatalog {
	private readonly host: ExtensionCatalogHost;
	private readonly entries: ReadonlyMap<string, OfficialExtension>;
	private open = false;

	constructor(host: ExtensionCatalogHost, entries: readonly OfficialExtension[] = OFFICIAL_EXTENSIONS) {
		this.host = host;
		this.entries = new Map(entries.map((entry) => [entry.id, entry]));
	}

	private readState(entry: OfficialExtension): OfficialExtensionState {
		return inspectOfficialExtension(entry, this.host.packages.listConfiguredPackages(), this.host.runtimeOwners());
	}

	async show(): Promise<void> {
		if (this.open) {
			this.host.notify("The extension catalog is already open.", true);
			return;
		}
		this.open = true;
		try {
			while (true) {
				// Metadata/state must be refreshed after each action, including partial failures.
				const choices = Array.from(this.entries.values(), (entry) =>
					officialExtensionChoice(entry, this.readState(entry)),
				);
				const selected = await this.host.choose(
					"Official extensions — optional, never installed automatically",
					choices,
				);
				if (selected === undefined) return;
				const entry = this.entries.get(selected);
				if (!entry) return;
				await this.showEntry(entry);
			}
		} catch (error) {
			this.host.notify(`Extension catalog failed: ${errorMessage(error)}`, true);
		} finally {
			this.open = false;
		}
	}

	private async showEntry(entry: OfficialExtension): Promise<void> {
		const state = this.readState(entry);
		const details = officialExtensionChoice(entry, state).details;
		const back: ExtensionCatalogChoice = {
			value: "back",
			label: "Back",
			description: "No changes",
			details: [...details],
		};
		const choices: ExtensionCatalogChoice[] = [back];
		const scope = state.installations[0]?.scope ?? "user";
		const kinds: OfficialExtensionActionKind[] =
			state.installations.length || state.loadedOwners.length ? ["upgrade", "remove"] : ["install"];
		for (const kind of kinds) {
			try {
				const action = getOfficialExtensionAction(entry, state, kind, scope);
				choices.push({ value: kind, label: `${kind} — ${scope}`, description: action.source, details });
			} catch (error) {
				back.details = [...back.details, `${kind} unavailable: ${errorMessage(error)}`];
			}
		}
		const selected = await this.host.choose(entry.name, choices);
		if (selected !== "install" && selected !== "upgrade" && selected !== "remove") return;
		if (!choices.some((choice) => choice.value === selected)) return;
		const selectedScope = selected === "install" ? await this.chooseScope() : scope;
		if (!selectedScope) return;
		const actions = new OfficialExtensionActions({
			packages: this.host.packages,
			readState: () => this.readState(entry),
			isIdle: () => this.host.isIdle(),
			projectAvailable: () => this.host.projectAvailable(),
			contextKey: () => this.host.contextKey(),
			configurationKey: () => this.host.configurationKey(),
			confirm: (action, warning) => this.confirm(entry, action, warning),
			runOperation: (operation) => this.host.runOperation(operation),
		});
		try {
			const result = await actions.run(entry, selected, selectedScope);
			if (result === "changed") {
				this.host.notify("Package action completed. Runtime resources are unchanged until you reload.", false);
				await this.offerReload(entry);
			}
		} catch (error) {
			this.host.notify(
				`Package action failed: ${errorMessage(error)} Files or settings may already have changed; inspect refreshed state before retrying.`,
				true,
			);
		}
	}

	private async chooseScope(): Promise<InstalledSourceScope | undefined> {
		const choices: ExtensionCatalogChoice[] = [
			{ value: "cancel", label: "Cancel", description: "No changes", details: [] },
		];
		const scopes: InstalledSourceScope[] = ["user"];
		if (this.host.projectAvailable()) scopes.push("project");
		for (const scope of scopes) {
			choices.push({
				value: scope,
				label: scope === "user" ? "User" : "Project (extension host)",
				description: this.host.settingsPath(scope),
				details: [
					`Host project: ${this.host.hostCwd}`,
					`Host settings: ${this.host.settingsPath(scope)}`,
					"Remote tool workspaces do not determine this installation path.",
				],
			});
		}
		const selected = await this.host.choose("Install scope", choices);
		if (selected === "user") return selected;
		if (selected === "project" && this.host.projectAvailable()) return selected;
		return undefined;
	}

	private async confirm(entry: OfficialExtension, action: OfficialExtensionAction, warning: string): Promise<boolean> {
		const details = [
			`Repository: ${entry.repository}`,
			`Exact source: ${action.source}`,
			`Scope: ${action.scope}`,
			`Host project: ${this.host.hostCwd}`,
			`Host settings: ${this.host.settingsPath(action.scope)}`,
			`Host package: ${this.host.packages.getInstalledPath(action.source, action.scope) ?? "unresolved"}`,
			warning,
			"Once started, package operations cannot be cancelled or rolled back here. No automatic reload.",
		];
		const selected = await this.host.choose(`Confirm ${action.kind}: ${entry.name}`, [
			{ value: "cancel", label: "Cancel", description: "No changes", details },
			{ value: "proceed", label: `Confirm ${action.kind}`, description: action.source, details },
		]);
		return selected === "proceed";
	}

	private async offerReload(entry: OfficialExtension): Promise<void> {
		const contextKey = this.host.contextKey();
		const configurationKey = this.host.configurationKey();
		const state = JSON.stringify(this.readState(entry));
		const details = [
			"Package changes succeeded independently of reload.",
			"Reload affects all extensions and resources. Existing reload diagnostics report its outcome.",
		];
		const selected = await this.host.choose("Reload resources?", [
			{ value: "later", label: "Later", description: "Keep current runtime", details },
			{ value: "now", label: "Reload now", description: "Use existing reload lifecycle", details },
		]);
		if (selected !== "now") return;
		if (
			!this.host.isIdle() ||
			contextKey !== this.host.contextKey() ||
			configurationKey !== this.host.configurationKey()
		) {
			this.host.notify(
				"Session activity, context or package settings changed; reload was deferred. Use /reload when idle.",
				true,
			);
			return;
		}
		const current = this.readState(entry);
		if (state !== JSON.stringify(current) || current.conflict) {
			this.host.notify(
				"Extension ownership changed; reload was deferred. Resolve conflicts and use /reload explicitly.",
				true,
			);
			return;
		}
		try {
			await this.host.reload();
		} catch (error) {
			this.host.notify(`Package changes remain in place; reload failed: ${errorMessage(error)}`, true);
		}
	}
}
