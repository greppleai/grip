import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGitSourceIdentity, parseGitUrl } from "../utils/git.ts";
import type { ConfiguredPackage, InstalledSourceScope, PackageManager } from "./package-manager.ts";
import type { SourceScope } from "./source-info.ts";

export interface OfficialExtensionTarget {
	source: string;
	revision: string;
}

export interface OfficialExtension {
	id: string;
	name: string;
	description: string;
	repository: string;
	npmNames: readonly string[];
	gitPackages: readonly string[];
	commands: readonly string[];
	tools: readonly string[];
	target: OfficialExtensionTarget | null;
	unavailableReason: string | null;
}

/** Reviewed metadata only. Never resolve a moving branch or latest version while browsing. */
export const OFFICIAL_EXTENSIONS: readonly OfficialExtension[] = [
	{
		id: "planner",
		name: "Planner",
		description: "File-backed plans and iterative build loops, owned by a separately installed extension.",
		repository: "https://github.com/greppleai/grip/tree/961291825e61a44b9075ef3bf9a53f54a903998d/extensions/planner",
		npmNames: ["@greppleai/planner"],
		gitPackages: ["github.com/greppleai/planner", "github.com/greppleai/grip#path=extensions/planner"],
		commands: ["planner"],
		tools: [
			"planner_prepare",
			"planner_step_prepare",
			"planner_progress_prepare",
			"planner_handoff_prepare",
			"planner_start",
			"planner_done",
		],
		target: {
			source: "git:github.com/greppleai/grip@961291825e61a44b9075ef3bf9a53f54a903998d#path=extensions/planner",
			revision: "961291825e61a44b9075ef3bf9a53f54a903998d",
		},
		unavailableReason: null,
	},
];

export interface CatalogRuntimeOwner {
	path: string;
	source: string;
	scope: SourceScope;
	commands: readonly string[];
	tools: readonly string[];
}

export type CatalogSourceKind = "npm" | "git" | "local";

export interface CatalogInstallation {
	source: string;
	scope: InstalledSourceScope;
	kind: CatalogSourceKind;
	root: string | null;
	version: string | null;
	installed: boolean;
	filtered: boolean;
}

export interface OfficialExtensionState {
	installations: CatalogInstallation[];
	loadedOwners: CatalogRuntimeOwner[];
	conflict: string | null;
}

interface CatalogPackageMetadata {
	root: string | null;
	name: string | null;
	version: string | null;
}

function readPackageMetadata(path: string | undefined): CatalogPackageMetadata {
	const result: CatalogPackageMetadata = { root: null, name: null, version: null };
	if (!path) return result;
	try {
		if (!statSync(path).isDirectory()) return result;
		result.root = realpathSync(path);
		const value: unknown = JSON.parse(readFileSync(join(result.root, "package.json"), "utf8"));
		if (typeof value !== "object" || value === null) return result;
		if ("name" in value && typeof value.name === "string") result.name = value.name;
		if ("version" in value && typeof value.version === "string") result.version = value.version;
	} catch {
		// Missing/malformed metadata is not evidence of package identity or version.
	}
	return result;
}

function managedSourceKind(entry: OfficialExtension, source: string): CatalogSourceKind | null {
	const npm = /^npm:(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/.exec(source);
	if (npm && entry.npmNames.includes(npm[1])) return "npm";
	const git = parseGitUrl(source);
	if (!git) return null;
	return entry.gitPackages.includes(getGitSourceIdentity(git)) ? "git" : null;
}

function findInstallationOwner(
	path: string,
	roots: ReadonlyMap<string, CatalogInstallation>,
): CatalogInstallation | null {
	try {
		let current = realpathSync(path);
		while (true) {
			const match = roots.get(current);
			if (match) return match;
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	} catch {
		return null;
	}
}

function collectCatalogInstallations(
	entry: OfficialExtension,
	configured: readonly ConfiguredPackage[],
): CatalogInstallation[] {
	const installations: CatalogInstallation[] = [];
	const names = new Set(entry.npmNames);
	for (const pkg of configured) {
		const managedKind = managedSourceKind(entry, pkg.source);
		const local = !pkg.source.startsWith("npm:") && !parseGitUrl(pkg.source);
		if (!managedKind && !local) continue;
		const metadata = readPackageMetadata(pkg.installedPath);
		// A manifest name may identify a local copy, but never authorize an unrelated managed source.
		const installed = metadata.name !== null && names.has(metadata.name);
		if (!managedKind && !installed) continue;
		installations.push({
			source: pkg.source,
			scope: pkg.scope,
			kind: managedKind ?? "local",
			root: metadata.root,
			version: installed ? metadata.version : null,
			installed,
			filtered: pkg.filtered,
		});
	}
	return installations;
}

/** Reads only local metadata. Does not load code, resolve packages or use the network. */
export function inspectOfficialExtension(
	entry: OfficialExtension,
	configured: readonly ConfiguredPackage[],
	owners: readonly CatalogRuntimeOwner[],
): OfficialExtensionState {
	const installations = collectCatalogInstallations(entry, configured);
	const roots = new Map<string, CatalogInstallation>();
	for (const pkg of installations) {
		if (pkg.root !== null) roots.set(pkg.root, pkg);
	}
	const commands = new Set(entry.commands);
	const tools = new Set(entry.tools);
	const loadedOwners: CatalogRuntimeOwner[] = [];
	let unmanaged = false;
	for (const owner of owners) {
		const pkg = findInstallationOwner(owner.path, roots);
		const reserved = owner.commands.some((name) => commands.has(name)) || owner.tools.some((name) => tools.has(name));
		if (!reserved && !pkg && !managedSourceKind(entry, owner.source)) continue;
		loadedOwners.push(owner);
		if (!pkg || pkg.scope !== owner.scope) unmanaged = true;
	}
	let conflict: string | null = null;
	if (installations.length > 1 || loadedOwners.length > 1) {
		conflict = "Multiple extension owners found. Resolve duplicate sources/scopes manually before making changes.";
	} else if (unmanaged) {
		conflict =
			"An unmanaged or unknown runtime owns this extension. Resolve its source before installing another copy.";
	}
	return { installations, loadedOwners, conflict };
}

/** Fail closed even if catalog metadata accidentally names a moving or unrelated target. */
export function getOfficialExtensionTarget(entry: OfficialExtension): OfficialExtensionTarget | null {
	if (!entry.target || entry.unavailableReason) return null;
	const kind = managedSourceKind(entry, entry.target.source);
	if (kind === "git") {
		const git = parseGitUrl(entry.target.source);
		return git?.ref === entry.target.revision && /^[a-f0-9]{40}$/i.test(entry.target.revision) ? entry.target : null;
	}
	if (kind === "npm") {
		const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
		return exactVersion.test(entry.target.revision) && entry.target.source.endsWith(`@${entry.target.revision}`)
			? entry.target
			: null;
	}
	return null;
}

export type OfficialExtensionActionKind = "install" | "upgrade" | "remove";

export interface OfficialExtensionAction {
	kind: OfficialExtensionActionKind;
	source: string;
	scope: InstalledSourceScope;
}

function requireMutableInstallation(state: OfficialExtensionState, scope: InstalledSourceScope): CatalogInstallation {
	const existing = state.installations[0];
	if (!existing || existing.scope !== scope)
		throw new Error("The selected installation no longer exists in this scope.");
	if (state.loadedOwners.length > 0) {
		throw new Error(
			"Loaded extension activity cannot be verified. Stop its workflow and exit Grip before changing its package.",
		);
	}
	return existing;
}

function requireSameManagedPackage(
	entry: OfficialExtension,
	existing: CatalogInstallation | undefined,
	target: OfficialExtensionTarget,
): void {
	if (!existing) return;
	if (existing.kind !== managedSourceKind(entry, target.source)) {
		throw new Error(
			"Changing package source kinds is not an upgrade. Manage this installation explicitly outside the catalog.",
		);
	}
	const existingGit = parseGitUrl(existing.source);
	const targetGit = parseGitUrl(target.source);
	if (existingGit && targetGit && getGitSourceIdentity(existingGit) !== getGitSourceIdentity(targetGit)) {
		throw new Error(
			"Changing Git repository or selected package is not an upgrade. Manage this installation explicitly outside the catalog.",
		);
	}
}

export function getOfficialExtensionAction(
	entry: OfficialExtension,
	state: OfficialExtensionState,
	kind: OfficialExtensionActionKind,
	scope: InstalledSourceScope,
): OfficialExtensionAction {
	if (state.conflict) throw new Error(state.conflict);
	const existing = state.installations[0];
	if (kind === "install") {
		if (existing || state.loadedOwners.length > 0)
			throw new Error("An owner already exists; a second install is refused.");
	} else {
		const mutable = requireMutableInstallation(state, scope);
		if (kind === "remove") return { kind, source: mutable.source, scope };
		if (mutable.kind === "local")
			throw new Error("Local sources are unmanaged; update their files outside the catalog.");
	}
	const target = getOfficialExtensionTarget(entry);
	if (!target) throw new Error(entry.unavailableReason ?? "No reviewed exact installation target is available.");
	requireSameManagedPackage(entry, existing, target);
	if (existing?.source === target.source) throw new Error("This source is already configured at the approved target.");
	return { kind, source: target.source, scope };
}

export interface OfficialExtensionActionHost {
	packages: Pick<PackageManager, "installAndPersist" | "removeAndPersist">;
	readState: () => OfficialExtensionState;
	isIdle: () => boolean;
	projectAvailable: () => boolean;
	/** Session identity and host cwd, captured independently of mutable package settings. */
	contextKey: () => string;
	/** Complete package settings for both scopes, including exact resource filters. */
	configurationKey: () => string;
	confirm: (action: OfficialExtensionAction, warning: string) => Promise<boolean>;
	runOperation: (operation: () => Promise<void>) => Promise<void>;
}

export type OfficialExtensionActionResult = "cancelled" | "changed";

/** One controller per open catalog; dialogs never grant authority over later state changes. */
export class OfficialExtensionActions {
	private busy = false;
	private readonly host: OfficialExtensionActionHost;

	constructor(host: OfficialExtensionActionHost) {
		this.host = host;
	}

	async run(
		entry: OfficialExtension,
		kind: OfficialExtensionActionKind,
		scope: InstalledSourceScope,
	): Promise<OfficialExtensionActionResult> {
		if (this.busy) throw new Error("A catalog operation is already in progress.");
		this.busy = true;
		try {
			if (!this.host.isIdle()) throw new Error("Wait for session activity and queued messages to finish.");
			if (scope === "project" && !this.host.projectAvailable())
				throw new Error("No host project scope is available.");
			const contextKey = this.host.contextKey();
			const configurationKey = this.host.configurationKey();
			const before = this.host.readState();
			const beforeKey = JSON.stringify(before);
			const action = getOfficialExtensionAction(entry, before, kind, scope);
			const git = parseGitUrl(action.source);
			const warning =
				kind === "remove"
					? "Managed npm/git package files may be deleted. Local source files and saved .planner data are preserved."
					: git?.subdirectory
						? "Extensions have full host access. Dependency lifecycle scripts are skipped for Git subdirectory installations. Official does not mean sandboxed or guaranteed safe."
						: "Extensions have full host access. Dependency lifecycle scripts may execute. Official does not mean sandboxed or guaranteed safe.";
			if (!(await this.host.confirm(action, warning))) return "cancelled";
			const revalidate = () => {
				if (!this.host.isIdle()) throw new Error("Session activity changed; no package operation was started.");
				if (contextKey !== this.host.contextKey())
					throw new Error("Session or host project changed; reopen the catalog.");
				if (scope === "project" && !this.host.projectAvailable())
					throw new Error("Host project scope changed; reopen the catalog.");
				if (configurationKey !== this.host.configurationKey())
					throw new Error("Package settings changed; reopen the catalog before retrying.");
				const after = this.host.readState();
				if (beforeKey !== JSON.stringify(after))
					throw new Error("Extension state changed; reopen the catalog before retrying.");
				getOfficialExtensionAction(entry, after, kind, scope);
			};
			revalidate();
			await this.host.runOperation(async () => {
				revalidate();
				const options = { local: scope === "project" };
				if (kind === "remove") {
					const removed = await this.host.packages.removeAndPersist(action.source, options);
					if (!removed)
						throw new Error(
							"Package files may have changed, but its settings entry was not removed. Refresh before retrying.",
						);
				} else {
					await this.host.packages.installAndPersist(action.source, options);
				}
			});
			return "changed";
		} finally {
			this.busy = false;
		}
	}
}
