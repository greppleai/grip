import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshCodexModelCatalog } from "../src/core/codex-model-catalog.ts";

const dirs: string[] = [];
async function cacheDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "codex-model-catalog-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function response(body: unknown, ok = true): Response {
	return new Response(JSON.stringify(body), {
		status: ok ? 200 : 500,
		headers: { "content-type": "application/json" },
	});
}
const catalog = {
	models: [
		{
			slug: "gpt-new",
			display_name: "GPT New",
			visibility: "list",
			input_modalities: ["text", "image"],
			context_window: 200000,
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
		},
		{
			slug: "hidden",
			display_name: "Hidden",
			visibility: "hide",
			input_modalities: ["text"],
			context_window: 1000,
			supported_reasoning_levels: [],
		},
	],
};

describe("refreshCodexModelCatalog", () => {
	it("fetches latest version without credentials and maps visible models", async () => {
		const dir = await cacheDir();
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetcher: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			return url.includes("registry.npmjs.org") ? response({ version: "1.2.3" }) : response(catalog);
		};
		const result = await refreshCodexModelCatalog({
			accessToken: "secret-token",
			accountId: "acct-a",
			cacheDir: dir,
			fetch: fetcher,
			now: () => 1000,
		});
		expect(calls).toHaveLength(2);
		expect(calls[0].init?.headers).toBeUndefined();
		expect(calls[1].url).toContain("client_version=1.2.3");
		expect(calls[1].init?.headers).toEqual({ Authorization: "Bearer secret-token", "ChatGPT-Account-ID": "acct-a" });
		expect(result.fromCache).toBe(false);
		expect(result.models).toHaveLength(1);
		expect(result.models[0]).toMatchObject({
			id: "gpt-new",
			name: "GPT New",
			api: "openai-codex-responses",
			provider: "openai-codex",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
			maxTokens: 128000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(result.models[0].thinkingLevelMap).toEqual({ low: "low", high: "high" });
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		const path = join(dir, files[0]);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readFile(path, "utf8")).not.toContain("secret-token");
	});

	it("uses fresh account-scoped cache without network and isolates accounts", async () => {
		const dir = await cacheDir();
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			return response(catalog);
		};
		await refreshCodexModelCatalog({
			accessToken: "token",
			accountId: "one",
			cacheDir: dir,
			clientVersion: "1.0.0",
			fetch: fetcher,
			now: () => 1000,
		});
		const fresh = await refreshCodexModelCatalog({
			accessToken: "other",
			accountId: "one",
			cacheDir: dir,
			fetch: fetcher,
			now: () => 2000,
		});
		const other = await refreshCodexModelCatalog({
			accessToken: "token",
			accountId: "two",
			cacheDir: dir,
			clientVersion: "1.0.0",
			fetch: fetcher,
			now: () => 2000,
		});
		expect(fresh.fromCache).toBe(true);
		expect(other.fromCache).toBe(false);
		expect(calls).toBe(2);
	});

	it("force refreshes and returns last good models on failure without leaking tokens", async () => {
		const dir = await cacheDir();
		await refreshCodexModelCatalog({
			accessToken: "secret",
			accountId: "acct",
			cacheDir: dir,
			clientVersion: "1.0.0",
			fetch: async () => response(catalog),
			now: () => 1000,
		});
		const failed = await refreshCodexModelCatalog({
			accessToken: "secret",
			accountId: "acct",
			cacheDir: dir,
			force: true,
			clientVersion: "1.0.0",
			fetch: async () => response({}, false),
			now: () => 2000,
		});
		expect(failed.fromCache).toBe(true);
		expect(failed.models[0].id).toBe("gpt-new");
		expect(failed.error?.message).not.toContain("secret");
	});

	it("rejects malformed catalogs and preserves the last good snapshot", async () => {
		const dir = await cacheDir();
		const options = { accessToken: "secret", accountId: "acct", cacheDir: dir, clientVersion: "1.0.0" };
		await refreshCodexModelCatalog({ ...options, fetch: async () => response(catalog), now: () => 1000 });
		const failed = await refreshCodexModelCatalog({
			...options,
			force: true,
			fetch: async () =>
				response({
					models: [
						{
							slug: "gpt-corrupt",
							display_name: "Broken",
							visibility: "list",
							input_modalities: ["text"],
							context_window: null,
							supported_reasoning_levels: [],
						},
					],
				}),
			now: () => 2000,
		});
		expect(failed.error).toBeDefined();
		expect(failed.models.map((model) => model.id)).toEqual(["gpt-new"]);
	});

	it.each([
		["network", "Codex client version lookup failed (network or timeout)"],
		["http", "Codex client version lookup failed (HTTP 500)"],
		["json", "Codex client version metadata is not valid JSON"],
		["version", "Invalid Codex client version; check CODEX_CLIENT_VERSION or npm metadata"],
	])("identifies version lookup failures: %s", async (failure, message) => {
		const result = await refreshCodexModelCatalog({
			accessToken: "secret-token",
			accountId: "acct",
			cacheDir: await cacheDir(),
			clientVersion: "",
			fetch: async () => {
				if (failure === "network") throw new Error("request contained secret-token");
				if (failure === "http") return response({}, false);
				if (failure === "json") return new Response("secret-token");
				return response({ version: "secret-token" });
			},
		});
		expect(result.error?.message).toBe(message);
		expect(result.models).toEqual([]);
		expect(result.fromCache).toBe(false);
	});

	it.each([
		["network", "Codex model catalog request failed (network or timeout)"],
		["http", "Codex model catalog request failed (HTTP 500)"],
		["json", "Codex model catalog response is not valid JSON"],
		["schema", "Codex model catalog validation failed"],
	])("identifies catalog failures and preserves cached models: %s", async (failure, message) => {
		const options = {
			accessToken: "secret-token",
			accountId: "acct",
			cacheDir: await cacheDir(),
			clientVersion: "1.2.3",
		};
		await refreshCodexModelCatalog({ ...options, fetch: async () => response(catalog) });
		const result = await refreshCodexModelCatalog({
			...options,
			force: true,
			fetch: async () => {
				if (failure === "network") throw new Error("request contained secret-token");
				if (failure === "http") return response({}, false);
				if (failure === "json") return new Response("secret-token");
				return response({ models: [{ slug: "secret-token", visibility: "list" }] });
			},
		});
		expect(result.error?.message).toBe(message);
		expect(result.models[0].id).toBe("gpt-new");
		expect(result.fromCache).toBe(true);
	});

	it("keeps freshly fetched models when the cache cannot be written", async () => {
		const path = join(await cacheDir(), "not-a-directory");
		await writeFile(path, "occupied");
		const result = await refreshCodexModelCatalog({
			accessToken: "secret-token",
			accountId: "acct",
			cacheDir: path,
			clientVersion: "1.2.3",
			fetch: async () => response(catalog),
		});
		expect(result.models[0].id).toBe("gpt-new");
		expect(result.fromCache).toBe(false);
		expect(result.error?.message).toBe("Codex model catalog refreshed but could not be cached");
	});

	it("accepts additional catalog modalities without advertising unsupported input", async () => {
		const dir = await cacheDir();
		const result = await refreshCodexModelCatalog({
			accessToken: "secret-token",
			accountId: "acct",
			cacheDir: dir,
			clientVersion: "1.2.3",
			fetch: async () =>
				response({
					models: [
						{ ...catalog.models[0], input_modalities: ["text", "image", "audio", "video", "image"] },
						{ ...catalog.models[0], slug: "text-audio", input_modalities: ["text", "audio"] },
					],
				}),
		});
		expect(result.error).toBeUndefined();
		expect(result.fromCache).toBe(false);
		expect(result.models.map((model) => model.input)).toEqual([["text", "image"], ["text"]]);
		const cached = await refreshCodexModelCatalog({
			accessToken: "secret-token",
			accountId: "acct",
			cacheDir: dir,
			fetch: async () => {
				throw new Error("fresh cache must not use network");
			},
		});
		expect(cached.error).toBeUndefined();
		expect(cached.fromCache).toBe(true);
		expect(cached.models).toEqual(result.models);
	});

	it.each([{ modalities: ["text", 42] }, { modalities: ["audio"] }, { modalities: [] }])(
		"still rejects invalid or unsupported-only modalities: $modalities",
		async ({ modalities }) => {
			const result = await refreshCodexModelCatalog({
				accessToken: "secret-token",
				accountId: "acct",
				cacheDir: await cacheDir(),
				clientVersion: "1.2.3",
				fetch: async () => response({ models: [{ ...catalog.models[0], input_modalities: modalities }] }),
			});
			expect(result.error?.message).toBe("Codex model catalog validation failed");
			expect(result.models).toEqual([]);
		},
	);
});
