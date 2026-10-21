import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeImage } from "../src/utils/image-resize.ts";

describe("embedded image resize worker", () => {
	const assetDir = mkdtempSync(join(tmpdir(), "grip-image-worker-test-"));

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(assetDir, { recursive: true, force: true });
	});

	it("loads the worker from the extracted binary assets instead of the virtual executable path", async () => {
		writeFileSync(
			join(assetDir, "image-resize-worker.js"),
			`const { parentPort } = require("node:worker_threads");
parentPort.once("message", ({ inputBytes }) => {
  parentPort.postMessage({ result: {
    data: Buffer.from(inputBytes).toString("base64"), mimeType: "image/png",
    originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false
  } });
});`,
		);
		vi.stubEnv("GRIP_EMBEDDED_ASSET_DIR", assetDir);
		const input = Uint8Array.of(1, 2, 3);

		const result = await resizeImage(input, "image/png");

		expect(result?.data).toBe("AQID");
		expect(input).toEqual(Uint8Array.of(1, 2, 3));
	});
});
