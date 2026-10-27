import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	OFFICIAL_LIMITS,
	type OfficialManifest,
	type OfficialRelease,
	officialObject,
	parseOfficialManifest,
	validateOfficialRelativePath,
} from "./official-catalog.ts";

export interface OfficialArtifactFile {
	path: string;
	base64: string;
}

export interface OfficialArtifactContents {
	schemaVersion: 1;
	manifest: OfficialManifest;
	files: OfficialArtifactFile[];
}

/** Canonical JSON: object keys sort by UTF-16 code units, array order is significant. */
export function officialJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(officialJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${officialJson(object[key])}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Invalid official JSON value");
	return encoded;
}

export function officialSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function parseOfficialArtifact(value: unknown, id: string): OfficialArtifactContents {
	const artifact = officialObject(value, "artifact envelope");
	if (artifact.schemaVersion !== 1) throw new Error("Unsupported official artifact schema");
	const manifest = parseOfficialManifest(artifact.manifest, id);
	if (!Array.isArray(artifact.files) || artifact.files.length > OFFICIAL_LIMITS.files)
		throw new Error("Invalid official artifact file count");
	const names = new Set<string>();
	const paths = new Set<string>();
	let size = 0;
	const files = artifact.files.map((value) => {
		const file = officialObject(value, "artifact file");
		if (Object.keys(file).some((key) => key !== "path" && key !== "base64"))
			throw new Error("Unsupported official artifact file metadata (links/modes are forbidden)");
		const path = validateOfficialRelativePath(file.path);
		// Case and Unicode normalization must not turn distinct records into the same target.
		const key = path.normalize("NFC").toLowerCase();
		if (names.has(key)) throw new Error(`Duplicate official artifact path: ${path}`);
		names.add(key);
		paths.add(path);
		if (
			typeof file.base64 !== "string" ||
			file.base64.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)
		)
			throw new Error("Invalid official artifact base64");
		const bytes = Buffer.from(file.base64, "base64");
		if (bytes.toString("base64") !== file.base64) throw new Error("Noncanonical official artifact base64");
		size += bytes.length;
		if (size > OFFICIAL_LIMITS.expandedBytes) throw new Error("Official artifact exceeds expanded size limit");
		return { path, base64: file.base64 };
	});
	for (const name of names) {
		const parts = name.split("/");
		for (let length = 1; length < parts.length; length++) {
			if (names.has(parts.slice(0, length).join("/"))) throw new Error("Official artifact file/directory collision");
		}
	}
	const packageFile = files.find((file) => file.path === "package.json");
	if (
		!packageFile ||
		officialJson(JSON.parse(Buffer.from(packageFile.base64, "base64").toString("utf8"))) !== officialJson(manifest)
	)
		throw new Error("Official artifact package.json must match generated manifest");
	if (!paths.has(manifest.grip.extensions[0])) throw new Error("Missing official artifact entry point");
	for (const resource of [
		...manifest.grip.skills,
		...manifest.grip.rules,
		...manifest.grip.prompts,
		...manifest.grip.themes,
	]) {
		if (!paths.has(resource)) throw new Error(`Missing official artifact resource: ${resource}`);
	}
	return { schemaVersion: 1, manifest, files };
}

export function encodeOfficialArtifact(value: OfficialArtifactContents): Buffer {
	const artifact = parseOfficialArtifact(value, value.manifest.grip.official.id);
	artifact.files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const json = Buffer.from(officialJson(artifact));
	if (json.length > OFFICIAL_LIMITS.expandedBytes)
		throw new Error("Official artifact envelope exceeds expanded size limit");
	const bytes = gzipSync(json, { level: 9 });
	if (bytes.length > OFFICIAL_LIMITS.artifactBytes) throw new Error("Official artifact exceeds compressed size limit");
	return bytes;
}

/** Validate before writing any files; callers still enforce filesystem confinement/no symlinks. */
export function decodeOfficialArtifact(bytes: Uint8Array, release: OfficialRelease): OfficialArtifactContents {
	if (
		bytes.length > OFFICIAL_LIMITS.artifactBytes ||
		bytes.length !== release.artifact.size ||
		officialSha256(bytes) !== release.artifact.sha256
	)
		throw new Error("Official artifact size/digest mismatch");
	const json = gunzipSync(bytes, { maxOutputLength: OFFICIAL_LIMITS.expandedBytes });
	const artifact = parseOfficialArtifact(JSON.parse(json.toString("utf8")), release.manifest.grip.official.id);
	if (officialJson(artifact.manifest) !== officialJson(release.manifest))
		throw new Error("Official artifact release manifest mismatch");
	return artifact;
}
