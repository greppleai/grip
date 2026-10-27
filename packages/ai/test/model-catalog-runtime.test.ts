import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	getModel,
	getProviders,
	loadCachedModelCatalog,
	refreshModelCatalog,
	resetModelCatalog,
} from "../src/models.ts";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	resetModelCatalog();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("generates a catalog on first use, caches it, and replaces it on a forced refresh", async () => {
	const root = mkdtempSync(join(tmpdir(), "grip-model-catalog-"));
	roots.push(root);
	const cachePath = join(root, "model-catalog.json");
	let modelId = "vendor/first";
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		if (String(input).includes("openrouter.ai")) {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: modelId,
							name: modelId,
							supported_parameters: ["tools"],
							pricing: {},
							top_provider: { max_completion_tokens: null },
						},
					],
				}),
			);
		}
		if (String(input).includes("models.dev")) return new Response("{}", { status: 503 });
		return new Response(JSON.stringify({ data: [] }));
	});
	vi.stubGlobal("fetch", fetchMock);
	const first = await refreshModelCatalog({ cachePath });
	expect(first.updated).toBe(true);
	expect(getModel("openrouter", "vendor/first").id).toBe("vendor/first");
	expect(getModel("openrouter", "vendor/first").maxTokens).toBe(4096);
	expect(JSON.parse(readFileSync(cachePath, "utf8")).models.openrouter["vendor/first"].id).toBe("vendor/first");
	resetModelCatalog();
	expect(getProviders()).toEqual([]);
	loadCachedModelCatalog({ cachePath });
	expect(getModel("openrouter", "vendor/first").id).toBe("vendor/first");
	modelId = "vendor/second";
	await refreshModelCatalog({ cachePath, force: true });
	expect(getModel("openrouter", "vendor/second").id).toBe("vendor/second");
	expect(getModel("openrouter", "vendor/first")).toBeUndefined();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 503 })),
	);
	await expect(refreshModelCatalog({ cachePath, force: true })).rejects.toThrow("all upstream sources");
	expect(getModel("openrouter", "vendor/second").id).toBe("vendor/second");
});

it("refuses to cache fallback-only results when all sources fail", async () => {
	const root = mkdtempSync(join(tmpdir(), "grip-model-catalog-"));
	roots.push(root);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("unavailable", { status: 503 })),
	);
	await expect(refreshModelCatalog({ cachePath: join(root, "catalog.json") })).rejects.toThrow("all upstream sources");
	expect(getProviders()).toEqual([]);
});
