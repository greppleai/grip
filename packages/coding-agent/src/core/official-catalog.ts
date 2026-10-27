import { compare, prerelease, satisfies, valid, validRange } from "semver";

export const OFFICIAL_REPOSITORY = "greppleai/grip";
export const OFFICIAL_CATALOG_URL =
	"https://github.com/greppleai/grip/releases/download/official-catalog-v1/catalog.json";
export const OFFICIAL_LIMITS = {
	catalogBytes: 2 * 1024 * 1024,
	artifactBytes: 32 * 1024 * 1024,
	expandedBytes: 128 * 1024 * 1024,
	files: 4096,
} as const;

export interface OfficialSource {
	type: "official";
	id: string;
}

export interface OfficialEngines {
	grip: string;
}

export interface OfficialMetadata {
	id: string;
	displayName: string;
}

export interface OfficialResources {
	official: OfficialMetadata;
	extensions: [string];
	skills: string[];
	rules: string[];
	prompts: string[];
	themes: string[];
}

/** Canonical package.json subset. Catalog entries are generated, never edited separately. */
export interface OfficialManifest {
	name: string;
	version: string;
	description: string;
	type: "module";
	engines: OfficialEngines;
	grip: OfficialResources;
}

export interface OfficialArtifact {
	url: string;
	size: number;
	sha256: string;
}

export interface OfficialRelease {
	manifest: OfficialManifest;
	sourceCommit: string;
	tag: string;
	artifact: OfficialArtifact;
}

export interface OfficialCatalogEntry {
	id: string;
	releases: OfficialRelease[];
}

export interface OfficialCatalog {
	schemaVersion: 1;
	repository: typeof OFFICIAL_REPOSITORY;
	extensions: OfficialCatalogEntry[];
}

export interface OfficialUpdatePolicy {
	autoUpdate: boolean;
	catalogMaxAgeMs: number;
	requestTimeoutMs: number;
	startupBudgetMs: number;
}

export function officialObject(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Invalid official ${label}: expected object`);
	}
	return value as Record<string, unknown>;
}

export function officialText(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() !== value || !value || /[\x00-\x1f\x7f]/.test(value)) {
		throw new Error(`Invalid official ${label}`);
	}
	return value;
}

export function validateOfficialId(value: unknown): string {
	const id = officialText(value, "extension ID");
	if (
		!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) ||
		id.length > 64 ||
		/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id)
	) {
		throw new Error(`Invalid official extension ID: ${id}`);
	}
	return id;
}

export function parseOfficialSource(source: string): OfficialSource | null {
	if (!source.startsWith("official:")) return null;
	return { type: "official", id: validateOfficialId(source.slice("official:".length)) };
}

export function assertOfficialScope(scope: string): void {
	if (scope !== "user")
		throw new Error("Official extensions support global installation only (no project or temporary scope)");
}

/** No absolute paths, globs, encodings, Windows aliases, or traversal segments. */
export function validateOfficialRelativePath(value: unknown): string {
	const path = officialText(value, "relative path");
	if (
		path.length > 240 ||
		path
			.split("/")
			.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					/[\\:*?"<>|%]/.test(part) ||
					/[. ]$/.test(part) ||
					/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
			)
	)
		throw new Error(`Invalid official relative path: ${path}`);
	return path;
}

export function validateOfficialVersion(value: unknown): string {
	const version = officialText(value, "semantic version");
	if (valid(version) !== version || version.includes("+"))
		throw new Error(`Invalid official semantic version: ${version}`);
	return version;
}

export function validateOfficialDigest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid official SHA-256 digest");
	return value;
}

export function parseOfficialManifest(value: unknown, expectedId: string): OfficialManifest {
	const pkg = officialObject(value, "manifest");
	const grip = officialObject(pkg.grip, "grip manifest");
	const metadata = officialObject(grip.official, "metadata");
	const engines = officialObject(pkg.engines, "engines");
	const id = validateOfficialId(metadata.id);
	if (id !== validateOfficialId(expectedId))
		throw new Error("Official manifest ID does not match directory/catalog ID");
	const range = officialText(engines.grip, "Grip version range");
	if (validRange(range) === null) throw new Error(`Invalid official Grip version range: ${range}`);
	if (pkg.type !== "module") throw new Error("Official extensions must use type: module");
	if (!Array.isArray(grip.extensions) || grip.extensions.length !== 1)
		throw new Error("Official extensions require one entry point");
	const entry = validateOfficialRelativePath(grip.extensions[0]);
	if (!/\.(?:ts|js|mjs)$/.test(entry)) throw new Error("Invalid official extension entry point");
	const resources: OfficialResources = {
		official: { id, displayName: officialText(metadata.displayName, "display name") },
		extensions: [entry],
		skills: [],
		rules: [],
		prompts: [],
		themes: [],
	};
	for (const key of ["skills", "rules", "prompts", "themes"] as const) {
		if (grip[key] === undefined) continue;
		if (!Array.isArray(grip[key])) throw new Error(`Invalid official ${key}`);
		resources[key] = grip[key].map(validateOfficialRelativePath);
	}
	return {
		name: officialText(pkg.name, "package name"),
		version: validateOfficialVersion(pkg.version),
		description: officialText(pkg.description, "description"),
		type: "module",
		engines: { grip: range },
		grip: resources,
	};
}

export function officialReleaseTag(id: string, version: string): string {
	return `extension-${validateOfficialId(id)}-v${validateOfficialVersion(version)}`;
}

/** URL equality, not a hostname suffix check, rejects credentials, query, escapes and traversal. */
export function validateOfficialArtifactUrl(value: unknown, id: string, version: string): string {
	const expected = `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${officialReleaseTag(id, version)}/${id}-${version}.json.gz`;
	if (value !== expected) throw new Error("Untrusted official artifact URL");
	return expected;
}

export function parseOfficialRelease(value: unknown, id: string): OfficialRelease {
	const release = officialObject(value, "release");
	const manifest = parseOfficialManifest(release.manifest, id);
	const tag = officialReleaseTag(id, manifest.version);
	if (release.tag !== tag) throw new Error("Invalid official release tag");
	if (typeof release.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(release.sourceCommit))
		throw new Error("Invalid official immutable source commit");
	const artifact = officialObject(release.artifact, "artifact");
	if (
		typeof artifact.size !== "number" ||
		!Number.isSafeInteger(artifact.size) ||
		artifact.size <= 0 ||
		artifact.size > OFFICIAL_LIMITS.artifactBytes
	) {
		throw new Error("Invalid official artifact size");
	}
	return {
		manifest,
		tag,
		sourceCommit: release.sourceCommit,
		artifact: {
			url: validateOfficialArtifactUrl(artifact.url, id, manifest.version),
			size: artifact.size,
			sha256: validateOfficialDigest(artifact.sha256),
		},
	};
}

export function parseOfficialCatalog(value: unknown): OfficialCatalog {
	const catalog = officialObject(value, "catalog");
	if (catalog.schemaVersion !== 1) throw new Error("Unsupported official catalog schema");
	if (catalog.repository !== OFFICIAL_REPOSITORY) throw new Error("Untrusted official catalog repository");
	if (!Array.isArray(catalog.extensions)) throw new Error("Invalid official catalog extensions");
	const ids = new Set<string>();
	const extensions = catalog.extensions.map((value) => {
		const entry = officialObject(value, "catalog entry");
		const id = validateOfficialId(entry.id);
		if (ids.has(id)) throw new Error(`Duplicate official extension ID: ${id}`);
		ids.add(id);
		if (!Array.isArray(entry.releases)) throw new Error("Invalid official releases");
		const versions = new Set<string>();
		const releases = entry.releases.map((value) => {
			const release = parseOfficialRelease(value, id);
			if (versions.has(release.manifest.version)) throw new Error(`Duplicate official release: ${id}`);
			versions.add(release.manifest.version);
			return release;
		});
		return { id, releases };
	});
	return { schemaVersion: 1, repository: OFFICIAL_REPOSITORY, extensions };
}

export function selectOfficialRelease(
	entry: OfficialCatalogEntry,
	gripVersion: string,
	installedVersion: string | null = null,
): OfficialRelease | null {
	validateOfficialVersion(gripVersion);
	if (installedVersion !== null) validateOfficialVersion(installedVersion);
	let selected: OfficialRelease | null = null;
	for (const release of entry.releases) {
		const version = release.manifest.version;
		if (prerelease(version) !== null || !satisfies(gripVersion, release.manifest.engines.grip)) continue;
		if (installedVersion !== null && compare(version, installedVersion) <= 0) continue;
		if (selected === null || compare(version, selected.manifest.version) > 0) selected = release;
	}
	return selected;
}

export function parseOfficialUpdatePolicy(value: unknown = {}): OfficialUpdatePolicy {
	const policy = officialObject(value, "update policy");
	if (policy.autoUpdate !== undefined && typeof policy.autoUpdate !== "boolean")
		throw new Error("Invalid official autoUpdate setting");
	const result: OfficialUpdatePolicy = {
		autoUpdate: policy.autoUpdate !== false,
		catalogMaxAgeMs: 21600000,
		requestTimeoutMs: 3000,
		startupBudgetMs: 8000,
	};
	const bounds = { catalogMaxAgeMs: 86400000, requestTimeoutMs: 30000, startupBudgetMs: 60000 };
	for (const key of ["catalogMaxAgeMs", "requestTimeoutMs", "startupBudgetMs"] as const) {
		const setting = policy[key];
		if (setting === undefined) continue;
		if (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting < 1 || setting > bounds[key])
			throw new Error(`Invalid official ${key} setting`);
		result[key] = setting;
	}
	return result;
}
