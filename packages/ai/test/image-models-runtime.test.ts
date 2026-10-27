import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getImageModel, getImageModels, getImageProviders, refreshImageModels } from "../src/image-models.ts";

const roots: string[] = [];
function cachePath(): string {
	const root = mkdtempSync(join(tmpdir(), "grip-image-catalog-"));
	roots.push(root);
	return join(root, "catalog.json");
}
function response(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function model(id: string) {
	return {
		id,
		name: id,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
		pricing: { prompt: "0.000002", completion: "0.000003" },
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime image model catalog", () => {
	it("fetches OpenRouter image models, transforms metadata, and populates existing getters", async () => {
		const path = cachePath();
		let requestSignal: AbortSignal | null | undefined;
		const result = await refreshImageModels({
			cachePath: path,
			force: true,
			now: () => 100,
			fetch: async (_url, init) => {
				requestSignal = init?.signal;
				return response({ data: [model("runtime/image"), model("runtime/image")] });
			},
		});
		expect(requestSignal).toBeInstanceOf(AbortSignal);
		expect(result).toHaveLength(1);
		expect(getImageModel("openrouter", "runtime/image")).toMatchObject({
			api: "openrouter-images",
			provider: "openrouter",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 2, output: 3 },
		});
		expect(getImageModels("openrouter").map((entry) => entry.id)).toContain("runtime/image");
		expect(getImageProviders()).toContain("openrouter");
		expect(JSON.parse(readFileSync(path, "utf8")).models).toHaveLength(1);
	});

	it("honors TTL and force refresh", async () => {
		const path = cachePath();
		let calls = 0;
		const fetch = async () => {
			calls++;
			return response({ data: [model(`runtime/${calls}`)] });
		};
		await refreshImageModels({ cachePath: path, fetch, now: () => 100 });
		await refreshImageModels({ cachePath: path, fetch, now: () => 101, ttlMs: 50 });
		expect(calls).toBe(1);
		await refreshImageModels({ cachePath: path, fetch, now: () => 102, force: true });
		expect(calls).toBe(2);
	});

	it("rejects empty or failed refreshes without replacing the last-good catalog", async () => {
		const path = cachePath();
		await refreshImageModels({
			cachePath: path,
			force: true,
			fetch: async () => response({ data: [model("runtime/good")] }),
		});
		const cached = readFileSync(path, "utf8");
		await expect(
			refreshImageModels({ cachePath: path, force: true, fetch: async () => response({ data: [] }) }),
		).rejects.toThrow("no image models");
		await expect(
			refreshImageModels({ cachePath: path, force: true, fetch: async () => response({}, 503) }),
		).rejects.toThrow("HTTP 503");
		expect(getImageModel("openrouter", "runtime/good")?.id).toBe("runtime/good");
		expect(readFileSync(path, "utf8")).toBe(cached);
	});
});
