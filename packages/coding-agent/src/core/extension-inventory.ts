import { resolve } from "node:path";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import type {
	ConfiguredPackage,
	ConfiguredPackageTarget,
	PackageResolutionDiagnostic,
	ResolvedResource,
} from "./package-manager.ts";
import { createSourceInfo, createSyntheticSourceInfo, type SourceInfo, type SourceScope } from "./source-info.ts";

export type ExtensionInventoryStatus = "missing" | "not-loaded" | "disabled" | "loaded" | "failed";

export interface ExtensionInventoryEntry {
	path: string;
	sourceInfo: SourceInfo;
	status: ExtensionInventoryStatus;
	errors: string[];
}

/** A package selection or an unmanaged entry, never an inference of filesystem ownership. */
export interface InstalledExtension {
	identity: string;
	source: string;
	scope: SourceScope;
	configured: boolean;
	installedPath: string | null;
	version: string | null;
	status: ExtensionInventoryStatus;
	removal: ConfiguredPackageTarget | null;
	entries: ExtensionInventoryEntry[];
	errors: string[];
}

export interface ExtensionInventoryInput {
	configuredPackages: ConfiguredPackage[];
	resources: ResolvedResource[];
	diagnostics: PackageResolutionDiagnostic[];
	result: LoadExtensionsResult;
	noExtensions: boolean;
}

function pathKey(path: string): string {
	return path.startsWith("<") ? path : resolve(path);
}

function sourceKey(source: string, scope: SourceScope): string {
	return JSON.stringify([scope, source]);
}

class ExtensionInventoryBuilder {
	private rows = new Map<string, InstalledExtension>();
	private configuredBySource = new Map<string, InstalledExtension>();
	private entriesByPath = new Map<string, ExtensionInventoryEntry>();

	private getRow(identity: string, source: string, scope: SourceScope): InstalledExtension {
		let row = this.rows.get(identity);
		if (!row) {
			row = {
				identity,
				source,
				scope,
				configured: false,
				installedPath: null,
				version: null,
				status: "not-loaded",
				removal: null,
				entries: [],
				errors: [],
			};
			this.rows.set(identity, row);
		}
		return row;
	}

	private addConfigured(pkg: ConfiguredPackage): void {
		const row = this.getRow(sourceKey(pkg.identity ?? pkg.source, pkg.scope), pkg.source, pkg.scope);
		row.configured = true;
		row.installedPath = pkg.installedPath ?? null;
		row.version = pkg.version;
		row.status = pkg.error ? "failed" : pkg.installedPath ? "not-loaded" : "missing";
		row.removal = pkg.managed ? { source: pkg.source, scope: pkg.scope } : null;
		if (pkg.error && !row.errors.includes(pkg.error)) row.errors.push(pkg.error);
		this.configuredBySource.set(sourceKey(pkg.source, pkg.scope), row);
	}

	private addEntry(path: string, info: SourceInfo, status: ExtensionInventoryStatus): ExtensionInventoryEntry {
		const key = pathKey(path);
		const existing = this.entriesByPath.get(key);
		if (existing) {
			if (status === "loaded") existing.status = status;
			return existing;
		}
		const packageRow =
			info.origin === "package" ? this.configuredBySource.get(sourceKey(info.source, info.scope)) : undefined;
		const identity = packageRow?.identity ?? sourceKey(info.origin === "package" ? info.source : key, info.scope);
		const row = packageRow ?? this.getRow(identity, info.source, info.scope);
		if (!row.configured) row.version = info.official?.version ?? null;
		const entry: ExtensionInventoryEntry = { path, sourceInfo: info, status, errors: [] };
		this.entriesByPath.set(key, entry);
		row.entries.push(entry);
		return entry;
	}

	private addDiagnostic(diagnostic: PackageResolutionDiagnostic): void {
		const row =
			this.configuredBySource.get(sourceKey(diagnostic.source, diagnostic.scope)) ??
			this.getRow(sourceKey(diagnostic.source, diagnostic.scope), diagnostic.source, diagnostic.scope);
		if (!row.errors.includes(diagnostic.error)) row.errors.push(diagnostic.error);
	}

	private finish(): InstalledExtension[] {
		for (const row of this.rows.values()) {
			if (row.status === "missing" && row.entries.length === 0) continue;
			if (row.errors.length > 0 || row.entries.some((entry) => entry.status === "failed")) row.status = "failed";
			else if (row.entries.some((entry) => entry.status === "loaded")) row.status = "loaded";
			else if (row.entries.length > 0 && row.entries.every((entry) => entry.status === "disabled"))
				row.status = "disabled";
		}
		return structuredClone([...this.rows.values()]);
	}

	build(input: ExtensionInventoryInput): InstalledExtension[] {
		for (const pkg of input.configuredPackages) this.addConfigured(pkg);
		for (const resource of input.resources) {
			const disabled = !resource.enabled || (input.noExtensions && resource.metadata.scope !== "temporary");
			this.addEntry(
				resource.path,
				createSourceInfo(resource.path, resource.metadata),
				disabled ? "disabled" : "not-loaded",
			);
		}
		for (const extension of input.result.extensions) {
			const info = extension.sourceInfo ?? createSyntheticSourceInfo(extension.path, { source: "unclassified" });
			this.addEntry(extension.path, info, "loaded");
		}
		const resolutionErrors = new Set<string>();
		for (const diagnostic of input.diagnostics) {
			this.addDiagnostic(diagnostic);
			resolutionErrors.add(JSON.stringify([diagnostic.source, `${diagnostic.scope}: ${diagnostic.error}`]));
		}
		for (const error of input.result.errors) {
			if (resolutionErrors.has(JSON.stringify([error.path, error.error]))) continue;
			const entry =
				this.entriesByPath.get(pathKey(error.path)) ?? this.addEntry(error.path, error.sourceInfo, "failed");
			entry.status = "failed";
			entry.errors.push(error.error);
		}
		return this.finish();
	}
}

/** Combines the last resolution/load snapshot and current configuration without importing code or installing anything. */
export function createExtensionInventory(input: ExtensionInventoryInput): InstalledExtension[] {
	return new ExtensionInventoryBuilder().build(input);
}
