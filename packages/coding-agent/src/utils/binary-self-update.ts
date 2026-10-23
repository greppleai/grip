import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, constants, lstat, mkdtemp, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const DEFAULT_RELEASE_BASE_URL = "https://github.com/greppleai/grip/releases";
const TEMP_DIR_PREFIX = ".grip-update.";
const WINDOWS_PREVIOUS_SUFFIX = ".grip-previous-";
const CHECKSUM_TIMEOUT_MS = 30_000;
const BINARY_TIMEOUT_MS = 10 * 60_000;

export interface BinarySelfUpdateOptions {
	/** Release version without the `v` prefix. Uses the latest release when omitted. */
	version?: string;
	/** Executable to replace. Defaults to `process.execPath`. */
	executablePath?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	/** Release base URL. Defaults to `GRIP_RELEASE_BASE_URL` or the GitHub releases URL. */
	releaseBaseUrl?: string;
	userAgent?: string;
	fetch?: typeof fetch;
}

export interface BinarySelfUpdateResult {
	executablePath: string;
	assetUrl: string;
}

export function getBinaryReleaseAssetName(platform: NodeJS.Platform, arch: string): string | undefined {
	const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : "";
	const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : "";
	if (!os || !cpu) return undefined;
	return `grip-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

function resolveReleaseBaseUrl(override: string | undefined): string {
	const base = (override ?? process.env.GRIP_RELEASE_BASE_URL ?? DEFAULT_RELEASE_BASE_URL).replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new Error(`Invalid release URL: ${base}`);
	}
	const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if (url.protocol !== "https:" && !loopback) {
		throw new Error("Release URL must be HTTPS (or loopback for tests)");
	}
	if (url.search || url.hash || base.includes("..")) throw new Error(`Invalid release URL: ${base}`);
	return base;
}

function getReleaseDownloadUrl(base: string, version: string | undefined): string {
	if (!version) return `${base}/latest/download`;
	const tag = version.startsWith("v") ? version : `v${version}`;
	if (!/^v\d[0-9A-Za-z.+-]*$/.test(tag)) throw new Error(`Invalid release version: ${version}`);
	return `${base}/download/${tag}`;
}

function parseChecksum(content: string, asset: string): string {
	for (const line of content.split(/\r?\n/)) {
		const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
		if (match && match[2] === asset) return match[1].toLowerCase();
	}
	throw new Error(`Missing or invalid SHA-256 checksum for ${asset}`);
}

async function fetchOk(fetchImpl: typeof fetch, url: string, userAgent: string, timeoutMs: number): Promise<Response> {
	const response = await fetchImpl(url, {
		headers: { "User-Agent": userAgent },
		redirect: "follow",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		const hint = response.status === 404 ? " (is this release published for your platform yet?)" : "";
		throw new Error(`Download failed: ${url} returned HTTP ${response.status}${hint}`);
	}
	return response;
}

async function downloadToFile(response: Response, path: string): Promise<string> {
	if (!response.body) throw new Error(`Download returned an empty body: ${response.url}`);
	const hash = createHash("sha256");
	const hasher = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	await pipeline(
		Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
		hasher,
		createWriteStream(path, { mode: 0o700 }),
	);
	return hash.digest("hex");
}

async function resolveExecutableTarget(executablePath: string): Promise<string> {
	const target = await realpath(executablePath);
	const info = await stat(target);
	if (!info.isFile()) throw new Error(`Refusing to replace non-file executable: ${target}`);
	try {
		await access(dirname(target), constants.W_OK);
	} catch {
		throw new Error(
			`Cannot write to ${dirname(target)}. Rerun the Grip installer with a writable GRIP_INSTALL_DIR or update with elevated permissions.`,
		);
	}
	return target;
}

async function replaceExecutable(source: string, target: string, platform: NodeJS.Platform): Promise<void> {
	if (platform !== "win32") {
		await rename(source, target);
		return;
	}
	// Windows cannot overwrite a running executable, but it can rename it. Move the current
	// binary aside, then move the verified one into place; cleanup happens on a later start.
	const previous = `${target}${WINDOWS_PREVIOUS_SUFFIX}${randomUUID()}`;
	await rename(target, previous);
	try {
		await rename(source, target);
	} catch (error) {
		await rename(previous, target);
		throw error;
	}
	await rm(previous, { force: true }).catch(() => {});
}

/**
 * Download the release executable for this platform, verify its SHA-256 checksum, and atomically
 * replace the running executable. Mirrors install.sh / install.ps1.
 */
export async function updateBinaryExecutable(options: BinarySelfUpdateOptions = {}): Promise<BinarySelfUpdateResult> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const asset = getBinaryReleaseAssetName(platform, arch);
	if (!asset) throw new Error(`No Grip binary release is available for ${platform}-${arch}`);

	const fetchImpl = options.fetch ?? fetch;
	const userAgent = options.userAgent ?? "grip-self-update";
	const downloadUrl = getReleaseDownloadUrl(resolveReleaseBaseUrl(options.releaseBaseUrl), options.version);
	const assetUrl = `${downloadUrl}/${asset}`;
	const target = await resolveExecutableTarget(options.executablePath ?? process.execPath);

	// Download next to the target so the final rename stays on one filesystem.
	const work = await mkdtemp(join(dirname(target), TEMP_DIR_PREFIX));
	try {
		const checksumResponse = await fetchOk(fetchImpl, `${assetUrl}.sha256`, userAgent, CHECKSUM_TIMEOUT_MS);
		const expected = parseChecksum(await checksumResponse.text(), asset);
		const downloaded = join(work, asset);
		const actual = await downloadToFile(await fetchOk(fetchImpl, assetUrl, userAgent, BINARY_TIMEOUT_MS), downloaded);
		if (actual !== expected) throw new Error(`SHA-256 mismatch for ${asset}; update aborted`);
		await chmod(downloaded, 0o755);
		await replaceExecutable(downloaded, target, platform);
	} finally {
		await rm(work, { recursive: true, force: true }).catch(() => {});
	}
	return { executablePath: target, assetUrl };
}

/** Remove executables that a Windows binary update moved aside while they were still running. */
export async function cleanupWindowsBinarySelfUpdateLeftovers(
	executablePath: string = process.execPath,
): Promise<void> {
	try {
		const target = await realpath(executablePath);
		const dir = dirname(target);
		const previousPrefix = `${basename(target)}${WINDOWS_PREVIOUS_SUFFIX}`;
		for (const entry of await readdir(dir)) {
			if (!entry.startsWith(previousPrefix)) continue;
			const path = join(dir, entry);
			if (!(await lstat(path)).isFile()) continue;
			await rm(path, { force: true }).catch(() => {});
		}
	} catch {
		// Best effort: the directory may be read-only or another process may still be running the old file.
	}
}
