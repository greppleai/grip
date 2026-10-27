import { OFFICIAL_LIMITS, OFFICIAL_REPOSITORY, type OfficialCatalog, type OfficialRelease, officialObject, parseOfficialCatalog } from "../packages/coding-agent/src/core/official-catalog.ts";
import { decodeOfficialArtifact, officialJson } from "../packages/coding-agent/src/core/official-artifact.ts";
import { emptyOfficialCatalog, mergeOfficialReleases, type OfficialPackageResult } from "./official-extensions.ts";

export interface OfficialPublisher {
	readCatalog(): Promise<OfficialCatalog>;
	readArtifact(release: OfficialRelease): Promise<Uint8Array | null>;
	publishArtifact(result: OfficialPackageResult): Promise<void>;
	publishCatalog(catalog: OfficialCatalog): Promise<void>;
}

/** The workflow serializes all official publications, not just releases of the same ID. */
export async function publishOfficialExtension(result: OfficialPackageResult, publisher: OfficialPublisher): Promise<void> {
	decodeOfficialArtifact(result.bytes, result.release);
	const previous = await publisher.readCatalog();
	const existing = previous.extensions.find((entry) => entry.id === result.release.manifest.grip.official.id)?.releases.find((release) => release.manifest.version === result.release.manifest.version);
	if (existing && existing.sourceCommit !== result.release.sourceCommit) throw new Error("Cannot move a published extension version to another source commit");
	const catalog = mergeOfficialReleases(previous, [result.release]);
	let published = await publisher.readArtifact(result.release);
	if (published === null) {
		await publisher.publishArtifact(result);
		published = await publisher.readArtifact(result.release);
	}
	if (published === null) throw new Error("Artifact publication did not produce a downloadable asset");
	decodeOfficialArtifact(published, result.release);
	// Never advertise bytes until a successful independent read/validation.
	await publisher.publishCatalog(catalog);
}

interface GitHubAsset {
	id: number;
	name: string;
}
interface GitHubRelease {
	id: number;
	assets: GitHubAsset[];
}

function githubRelease(value: unknown): GitHubRelease {
	const release = officialObject(value, "GitHub release");
	if (!Number.isSafeInteger(release.id) || Number(release.id) <= 0 || !Array.isArray(release.assets)) throw new Error("Invalid GitHub release response");
	return { id: Number(release.id), assets: release.assets.map((value) => {
		const asset = officialObject(value, "GitHub asset");
		if (!Number.isSafeInteger(asset.id) || Number(asset.id) <= 0 || typeof asset.name !== "string") throw new Error("Invalid GitHub asset response");
		return { id: Number(asset.id), name: asset.name };
	}) };
}

/** Repository and API roots are fixed; no catalog-supplied URL receives a token. */
export class GitHubOfficialPublisher implements OfficialPublisher {
	private readonly token: string;
	constructor(token: string) { if (!token) throw new Error("Missing GitHub publication token"); this.token = token; }

	private async request(path: string, method = "GET", body: Uint8Array | null = null, contentType = "application/json"): Promise<Uint8Array | null> {
		const upload = path.startsWith("/upload/");
		const url = upload ? `https://uploads.github.com/repos/${OFFICIAL_REPOSITORY}/${path.slice(8)}` : `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/${path}`;
		const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": contentType };
		if (path.includes("releases/assets/") && method === "GET") headers.Accept = "application/octet-stream";
		const options: RequestInit = { method, headers, signal: AbortSignal.timeout(30000) };
		if (body) options.body = new Uint8Array(body);
		const response = await fetch(url, options);
		if (response.status === 404 && method === "GET") return null;
		if (!response.ok) throw new Error(`GitHub official publication ${method} failed: HTTP ${response.status}`);
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader) {
			try {
				for (;;) {
					const result = await reader.read();
					if (result.done) break;
					size += result.value.length;
					if (size > OFFICIAL_LIMITS.artifactBytes) throw new Error("Oversized GitHub publication response");
					chunks.push(result.value);
				}
			} finally { await reader.cancel(); }
		}
		return Buffer.concat(chunks);
	}

	private async release(tag: string): Promise<GitHubRelease | null> {
		const bytes = await this.request(`releases/tags/${encodeURIComponent(tag)}`);
		return bytes === null ? null : githubRelease(JSON.parse(Buffer.from(bytes).toString("utf8")));
	}

	private async ensureRelease(tag: string, sourceCommit: string): Promise<GitHubRelease> {
		const existing = await this.release(tag);
		if (existing) return existing;
		const body = Buffer.from(JSON.stringify({ tag_name: tag, target_commitish: sourceCommit, name: tag, body: "Published official Grip extension artifacts.", make_latest: "false" }));
		const bytes = await this.request("releases", "POST", body);
		if (bytes === null) throw new Error("Missing created release response");
		return githubRelease(JSON.parse(Buffer.from(bytes).toString("utf8")));
	}

	private async asset(release: GitHubRelease, name: string): Promise<Uint8Array | null> {
		const asset = release.assets.find((asset) => asset.name === name);
		if (!asset) return null;
		const bytes = await this.request(`releases/assets/${asset.id}`);
		if (bytes === null) throw new Error(`Previously listed release asset disappeared: ${name}`);
		return bytes;
	}

	async readCatalog(): Promise<OfficialCatalog> {
		const release = await this.release("official-catalog-v1");
		if (!release) return emptyOfficialCatalog();
		let bytes = await this.asset(release, "catalog.json");
		if (bytes === null) bytes = await this.asset(release, "catalog.backup.json");
		if (bytes === null) {
			if (release.assets.length === 0) return emptyOfficialCatalog();
			throw new Error("Catalog release exists without a recoverable catalog");
		}
		if (bytes.length > OFFICIAL_LIMITS.catalogBytes) throw new Error("Oversized official catalog");
		return parseOfficialCatalog(JSON.parse(Buffer.from(bytes).toString("utf8")));
	}

	async readArtifact(release: OfficialRelease): Promise<Uint8Array | null> {
		const remote = await this.release(release.tag);
		return remote ? this.asset(remote, `${release.manifest.grip.official.id}-${release.manifest.version}.json.gz`) : null;
	}

	private async upload(release: GitHubRelease, name: string, bytes: Uint8Array, replace: boolean): Promise<void> {
		const existing = release.assets.find((asset) => asset.name === name);
		if (existing) {
			if (!replace) throw new Error(`Refusing to overwrite immutable release asset: ${name}`);
			await this.request(`releases/assets/${existing.id}`, "DELETE");
		}
		await this.request(`/upload/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, "POST", bytes, "application/octet-stream");
	}

	async publishArtifact(result: OfficialPackageResult): Promise<void> {
		const release = await this.ensureRelease(result.release.tag, result.release.sourceCommit);
		await this.upload(release, `${result.release.manifest.grip.official.id}-${result.release.manifest.version}.json.gz`, result.bytes, false);
	}

	async publishCatalog(catalog: OfficialCatalog): Promise<void> {
		const bytes = Buffer.from(`${officialJson(parseOfficialCatalog(catalog))}\n`);
		if (bytes.length > OFFICIAL_LIMITS.catalogBytes) throw new Error("Oversized official catalog");
		let release = await this.ensureRelease("official-catalog-v1", "main");
		// Repair a missing primary before replacing the only recoverable backup.
		if (!release.assets.some((asset) => asset.name === "catalog.json")) {
			const backup = await this.asset(release, "catalog.backup.json");
			if (backup !== null) {
				if (backup.length > OFFICIAL_LIMITS.catalogBytes) throw new Error("Oversized official catalog backup");
				parseOfficialCatalog(JSON.parse(Buffer.from(backup).toString("utf8")));
				await this.upload(release, "catalog.json", backup, false);
				release = (await this.release("official-catalog-v1"))!;
				const restored = await this.asset(release, "catalog.json");
				if (!restored || !Buffer.from(restored).equals(backup)) throw new Error("Catalog primary restoration failed");
			}
		}
		// A durable complete backup prevents losing historical versions if replacement fails.
		await this.upload(release, "catalog.backup.json", bytes, true);
		const verified = await this.asset((await this.release("official-catalog-v1"))!, "catalog.backup.json");
		if (!verified || !Buffer.from(verified).equals(bytes)) throw new Error("Catalog backup verification failed");
		await this.upload(release, "catalog.json", bytes, true);
	}
}