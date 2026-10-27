import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshOpenRouterModelCatalog } from "../src/core/openrouter-model-catalog.ts";

const dirs: string[] = [];
async function makeCacheDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "openrouter-model-catalog-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const accountOnly = {
	data: [
		{
			id: "private/model-new",
			name: "Account Model",
			supported_parameters: ["tools", "reasoning"],
			pricing: {
				prompt: "0.000002",
				completion: "0.000004",
				input_cache_read: "0.000001",
				input_cache_write: "0.000003",
			},
			architecture: { modality: "text+image->text" },
			context_length: 128000,
			top_provider: { max_completion_tokens: 8192 },
		},
		{ id: "provider/no-tools", name: "No Tools", supported_parameters: [] },
	],
};
describe("refreshOpenRouterModelCatalog", () => {
	it("normalizes account-only models and caches complete metadata privately", async () => {
		const cacheDir = await makeCacheDir();
		let request: { url: string; init?: RequestInit } | undefined;
		const result = await refreshOpenRouterModelCatalog({
			apiKey: "private-api-key",
			cacheDir,
			now: () => 1000,
			fetch: async (input, init) => {
				request = { url: String(input), init };
				return response(accountOnly);
			},
		});
		expect(request?.url).toBe("https://openrouter.ai/api/v1/models/user");
		expect(request?.init?.headers).toEqual({ Authorization: "Bearer private-api-key" });
		expect(result.ids).toEqual(["private/model-new", "provider/no-tools"]);
		expect(result.models).toEqual([
			{
				id: "private/model-new",
				name: "Account Model",
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				provider: "openrouter",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		]);
		const [file] = await readdir(cacheDir);
		const path = join(cacheDir, file);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const stored = JSON.parse(await readFile(path, "utf8"));
		expect(stored.schemaVersion).toBe(2);
		expect(JSON.stringify(stored)).not.toContain("private-api-key");
		const cached = await refreshOpenRouterModelCatalog({
			apiKey: "private-api-key",
			cacheDir,
			now: () => 2000,
			fetch: async () => {
				throw new Error("must use cache");
			},
		});
		expect(cached).toMatchObject({ ids: result.ids, models: result.models, fromCache: true });
	});
	it("migrates v1 IDs-only caches by refetching online and serves IDs only offline", async () => {
		const cacheDir = await makeCacheDir();
		const apiKey = "legacy-key";
		const path = join(cacheDir, `${createHash("sha256").update(apiKey).digest("hex")}.json`);
		await writeFile(path, JSON.stringify({ schemaVersion: 1, fetchedAt: 1000, ids: ["old/model"] }));
		const offline = await refreshOpenRouterModelCatalog({ apiKey, cacheDir, offline: true, now: () => 2000 });
		expect(offline).toEqual({ ids: ["old/model"], models: [], fromCache: true });
		const refreshed = await refreshOpenRouterModelCatalog({
			apiKey,
			cacheDir,
			now: () => 2000,
			fetch: async () => response(accountOnly),
		});
		expect(refreshed.fromCache).toBe(false);
		expect(refreshed.models).toHaveLength(1);
		expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(2);
	});
	it("preserves last good metadata on network and malformed-response failures", async () => {
		const cacheDir = await makeCacheDir();
		const fetcher: typeof fetch = async () => response(accountOnly);
		const good = await refreshOpenRouterModelCatalog({ apiKey: "secret", cacheDir, fetch: fetcher, now: () => 1000 });
		const failed = await refreshOpenRouterModelCatalog({
			apiKey: "secret",
			cacheDir,
			force: true,
			now: () => 2000,
			fetch: async () => {
				throw new Error("secret leaked");
			},
		});
		const invalid = await refreshOpenRouterModelCatalog({
			apiKey: "secret",
			cacheDir,
			force: true,
			fetch: async () =>
				response({
					data: [
						{ id: "x", name: "X" },
						{ id: "x", name: "duplicate" },
					],
				}),
		});
		expect(failed).toMatchObject({ ids: good.ids, models: good.models, fromCache: true });
		expect(failed.error?.message).not.toContain("secret");
		expect(invalid).toMatchObject({ ids: good.ids, models: good.models, fromCache: true });
		expect(invalid.error).toBeInstanceOf(Error);
	});
	it("accepts nullable completion limits returned by OpenRouter", async () => {
		const cacheDir = await makeCacheDir();
		const result = await refreshOpenRouterModelCatalog({
			apiKey: "dummy-key",
			cacheDir,
			fetch: async () =>
				response({
					data: [
						{
							id: "provider/nullable",
							name: "Nullable",
							supported_parameters: ["tools"],
							pricing: {},
							top_provider: { max_completion_tokens: null },
						},
					],
				}),
		});
		expect(result.error).toBeUndefined();
		expect(result.models[0].maxTokens).toBe(4096);
	});
});
