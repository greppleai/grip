import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	cleanupWindowsBinarySelfUpdateLeftovers,
	getBinaryReleaseAssetName,
	updateBinaryExecutable,
} from "../src/utils/binary-self-update.ts";

const ASSET = "grip-linux-x64";
const NEW_BINARY = "#!/bin/sh\necho new grip\n";

interface ReleaseFixture {
	files: Map<string, string>;
	requests: string[];
}

let server: Server;
let baseUrl: string;
let release: ReleaseFixture;
let tempDir: string;

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function publish(path: string, binary: string, checksum = sha256(binary)): void {
	release.files.set(`${path}/${ASSET}`, binary);
	release.files.set(`${path}/${ASSET}.sha256`, `${checksum}  ${ASSET}\n`);
}

function createExecutable(name = "grip"): string {
	const path = join(tempDir, name);
	writeFileSync(path, "#!/bin/sh\necho old grip\n", { mode: 0o755 });
	return path;
}

beforeEach(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "grip-binary-update-"));
	release = { files: new Map(), requests: [] };
	server = createServer((request, response) => {
		const path = request.url ?? "";
		release.requests.push(path);
		const body = release.files.get(path);
		if (body === undefined) {
			response.writeHead(404).end("not found");
			return;
		}
		response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(tempDir, { recursive: true, force: true });
});

describe("getBinaryReleaseAssetName", () => {
	test("maps platforms to release assets", () => {
		expect(getBinaryReleaseAssetName("linux", "x64")).toBe("grip-linux-x64");
		expect(getBinaryReleaseAssetName("darwin", "arm64")).toBe("grip-darwin-arm64");
		expect(getBinaryReleaseAssetName("win32", "x64")).toBe("grip-windows-x64.exe");
		expect(getBinaryReleaseAssetName("freebsd", "x64")).toBeUndefined();
		expect(getBinaryReleaseAssetName("linux", "ia32")).toBeUndefined();
	});
});

describe("updateBinaryExecutable", () => {
	test("replaces the executable with the verified versioned release", async () => {
		const executablePath = createExecutable();
		publish("/releases/download/v1.2.3", NEW_BINARY);

		const result = await updateBinaryExecutable({
			version: "1.2.3",
			executablePath,
			platform: "linux",
			arch: "x64",
			releaseBaseUrl: baseUrl,
		});

		expect(result.assetUrl).toBe(`${baseUrl}/download/v1.2.3/${ASSET}`);
		expect(readFileSync(executablePath, "utf-8")).toBe(NEW_BINARY);
		expect(statSync(executablePath).mode & 0o777).toBe(0o755);
		expect(readdirSync(tempDir)).toEqual(["grip"]);
	});

	test("uses the latest release when no version is known", async () => {
		const executablePath = createExecutable();
		publish("/releases/latest/download", NEW_BINARY);

		await updateBinaryExecutable({ executablePath, platform: "linux", arch: "x64", releaseBaseUrl: baseUrl });

		expect(readFileSync(executablePath, "utf-8")).toBe(NEW_BINARY);
	});

	test("replaces the symlink target instead of the symlink", async () => {
		const realExecutable = createExecutable("grip-real");
		const link = join(tempDir, "grip");
		symlinkSync(realExecutable, link);
		publish("/releases/download/v1.2.3", NEW_BINARY);

		const result = await updateBinaryExecutable({
			version: "1.2.3",
			executablePath: link,
			platform: "linux",
			arch: "x64",
			releaseBaseUrl: baseUrl,
		});

		expect(result.executablePath).toBe(realExecutable);
		expect(readFileSync(realExecutable, "utf-8")).toBe(NEW_BINARY);
	});

	test("keeps the current executable when the checksum does not match", async () => {
		const executablePath = createExecutable();
		const original = readFileSync(executablePath, "utf-8");
		publish("/releases/download/v1.2.3", NEW_BINARY, sha256("something else"));

		await expect(
			updateBinaryExecutable({
				version: "1.2.3",
				executablePath,
				platform: "linux",
				arch: "x64",
				releaseBaseUrl: baseUrl,
			}),
		).rejects.toThrow("SHA-256 mismatch");

		expect(readFileSync(executablePath, "utf-8")).toBe(original);
		expect(readdirSync(tempDir)).toEqual(["grip"]);
	});

	test("reports unpublished releases", async () => {
		const executablePath = createExecutable();

		await expect(
			updateBinaryExecutable({
				version: "9.9.9",
				executablePath,
				platform: "linux",
				arch: "x64",
				releaseBaseUrl: baseUrl,
			}),
		).rejects.toThrow("HTTP 404");
		expect(readdirSync(tempDir)).toEqual(["grip"]);
	});

	test("rejects non-HTTPS release URLs", async () => {
		const executablePath = createExecutable();

		await expect(
			updateBinaryExecutable({
				executablePath,
				platform: "linux",
				arch: "x64",
				releaseBaseUrl: "http://example.com",
			}),
		).rejects.toThrow("must be HTTPS");
		expect(release.requests).toEqual([]);
	});

	test("moves the running executable aside on Windows and cleans it up later", async () => {
		const executablePath = createExecutable("grip.exe");
		const windowsAsset = "grip-windows-x64.exe";
		release.files.set(`/releases/download/v1.2.3/${windowsAsset}`, NEW_BINARY);
		release.files.set(`/releases/download/v1.2.3/${windowsAsset}.sha256`, `${sha256(NEW_BINARY)} *${windowsAsset}\n`);

		await updateBinaryExecutable({
			version: "1.2.3",
			executablePath,
			platform: "win32",
			arch: "x64",
			releaseBaseUrl: baseUrl,
		});

		expect(readFileSync(executablePath, "utf-8")).toBe(NEW_BINARY);
		writeFileSync(join(tempDir, "grip.exe.grip-previous-stale"), "old");
		await cleanupWindowsBinarySelfUpdateLeftovers(executablePath);
		expect(readdirSync(tempDir)).toEqual(["grip.exe"]);
	});
});
