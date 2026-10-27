import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@greppleai/grip-ai";

const CATALOG_URL = "https://openrouter.ai/api/v1/models/user";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type OpenRouterModel = Model<"openai-completions">;
interface CacheRecord {
	schemaVersion: 2;
	fetchedAt: number;
	ids: string[];
	models: OpenRouterModel[];
}
interface LegacyCacheRecord {
	schemaVersion: 1;
	fetchedAt: number;
	ids: string[];
}
interface RefreshOptions {
	apiKey: string;
	cacheDir: string;
	force?: boolean;
	offline?: boolean;
	fetch?: typeof fetch;
	now?: () => number;
}
interface RefreshResult {
	ids: string[];
	models: OpenRouterModel[];
	fromCache: boolean;
	error?: Error;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cachePathFor(cacheDir: string, apiKey: string): string {
	return join(cacheDir, `${createHash("sha256").update(apiKey).digest("hex")}.json`);
}
interface ParsedCatalog {
	ids: string[];
	models: OpenRouterModel[];
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validates and normalizes an untrusted provider catalog in one bounded pass.
function parseCatalog(payload: unknown): ParsedCatalog {
	if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Invalid OpenRouter model catalog response");
	const ids: string[] = [];
	const models: OpenRouterModel[] = [];
	const seen = new Set<string>();
	for (const row of payload.data) {
		if (
			!isRecord(row) ||
			typeof row.id !== "string" ||
			!row.id.trim() ||
			row.id !== row.id.trim() ||
			typeof row.name !== "string" ||
			!row.name.trim()
		) {
			throw new Error("Invalid OpenRouter model catalog entry");
		}
		if (seen.has(row.id)) throw new Error("Duplicate OpenRouter model ID");
		seen.add(row.id);
		ids.push(row.id);
		if (
			row.supported_parameters !== undefined &&
			(!Array.isArray(row.supported_parameters) || row.supported_parameters.some((item) => typeof item !== "string"))
		)
			throw new Error("Invalid OpenRouter supported_parameters");
		if (row.pricing !== undefined) {
			if (!isRecord(row.pricing)) throw new Error("Invalid OpenRouter pricing");
			const prices = [
				row.pricing.prompt,
				row.pricing.completion,
				row.pricing.input_cache_read,
				row.pricing.input_cache_write,
			];
			if (prices.some((price) => price != null && typeof price !== "string" && typeof price !== "number"))
				throw new Error("Invalid OpenRouter pricing");
		}
		if (
			row.architecture != null &&
			(!isRecord(row.architecture) ||
				(row.architecture.modality != null && typeof row.architecture.modality !== "string"))
		)
			throw new Error("Invalid OpenRouter architecture");
		if (
			row.top_provider != null &&
			(!isRecord(row.top_provider) ||
				(row.top_provider.max_completion_tokens != null &&
					(typeof row.top_provider.max_completion_tokens !== "number" ||
						!Number.isFinite(row.top_provider.max_completion_tokens))))
		)
			throw new Error("Invalid OpenRouter top_provider");
		if (
			row.context_length != null &&
			(typeof row.context_length !== "number" || !Number.isFinite(row.context_length))
		)
			throw new Error("Invalid OpenRouter context_length");
		if (!Array.isArray(row.supported_parameters) || !row.supported_parameters.includes("tools")) continue;
		const price = isRecord(row.pricing) ? row.pricing : {};
		const parsePrice = (field: string): number => {
			const raw = price[field];
			if (raw == null) return 0;
			if (typeof raw !== "string" && typeof raw !== "number") throw new Error("Invalid OpenRouter pricing");
			const value = Number(raw) * 1_000_000;
			if (!Number.isFinite(value)) throw new Error("Invalid OpenRouter pricing");
			return value;
		};
		const modality =
			isRecord(row.architecture) && typeof row.architecture.modality === "string" ? row.architecture.modality : "";
		const top = isRecord(row.top_provider) ? row.top_provider : {};
		models.push({
			id: row.id,
			name: row.name,
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			provider: "openrouter",
			reasoning: row.supported_parameters.includes("reasoning"),
			input: modality.includes("image") ? ["text", "image"] : ["text"],
			cost: {
				input: parsePrice("prompt"),
				output: parsePrice("completion"),
				cacheRead: parsePrice("input_cache_read"),
				cacheWrite: parsePrice("input_cache_write"),
			},
			contextWindow: typeof row.context_length === "number" && row.context_length ? row.context_length : 4096,
			maxTokens:
				typeof top.max_completion_tokens === "number" && top.max_completion_tokens
					? top.max_completion_tokens
					: 4096,
		});
	}
	return { ids, models };
}
function validCachedCost(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return ["input", "output", "cacheRead", "cacheWrite"].every(
		(field) => typeof value[field] === "number" && Number.isFinite(value[field]),
	);
}
function validCachedModel(model: unknown): model is OpenRouterModel {
	if (!isRecord(model)) return false;
	return (
		typeof model.id === "string" &&
		model.id.length > 0 &&
		typeof model.name === "string" &&
		model.name.length > 0 &&
		model.api === "openai-completions" &&
		model.provider === "openrouter" &&
		model.baseUrl === "https://openrouter.ai/api/v1" &&
		typeof model.reasoning === "boolean" &&
		Array.isArray(model.input) &&
		model.input.includes("text") &&
		model.input.every((value) => value === "text" || value === "image") &&
		validCachedCost(model.cost) &&
		typeof model.contextWindow === "number" &&
		Number.isFinite(model.contextWindow) &&
		model.contextWindow > 0 &&
		typeof model.maxTokens === "number" &&
		Number.isFinite(model.maxTokens) &&
		model.maxTokens > 0
	);
}
function parseCachedModels(value: unknown): OpenRouterModel[] | undefined {
	return Array.isArray(value) && value.every(validCachedModel) ? value : undefined;
}
async function readCache(path: string): Promise<CacheRecord | LegacyCacheRecord | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(value) || !Number.isFinite(value.fetchedAt) || !Array.isArray(value.ids)) return undefined;
		const ids = parseCatalog({ data: value.ids.map((id) => ({ id, name: id })) }).ids;
		if (value.schemaVersion === 1) return { schemaVersion: 1, fetchedAt: value.fetchedAt as number, ids };
		const models = value.schemaVersion === 2 ? parseCachedModels(value.models) : undefined;
		const knownIds = new Set(ids);
		if (!models || models.some((model) => !knownIds.has(model.id))) return undefined;
		return { schemaVersion: 2, fetchedAt: value.fetchedAt as number, ids, models };
	} catch {
		return undefined;
	}
}
async function writeCache(path: string, value: CacheRecord): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
		await chmod(temp, 0o600);
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
	}
}
/** Refresh authenticated per-key OpenRouter IDs and tool-capable model metadata; credentials are never cached. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Coordinates cache, offline, and refresh fallback behavior.
export async function refreshOpenRouterModelCatalog(options: RefreshOptions): Promise<RefreshResult> {
	const now = options.now ?? Date.now;
	const path = cachePathFor(options.cacheDir, options.apiKey);
	const cached = await readCache(path);
	const fresh = cached && now() - cached.fetchedAt >= 0 && now() - cached.fetchedAt < CACHE_TTL_MS;
	if (options.offline)
		return cached
			? { ids: cached.ids, models: cached.schemaVersion === 2 ? cached.models : [], fromCache: true }
			: { ids: [], models: [], fromCache: false, error: new Error("No cached OpenRouter model catalog available") };
	if (!options.force && fresh && cached?.schemaVersion === 2)
		return { ids: cached.ids, models: cached.models, fromCache: true };
	try {
		const response = await (options.fetch ?? globalThis.fetch)(CATALOG_URL, {
			method: "GET",
			signal: AbortSignal.timeout(10_000),
			headers: { Authorization: `Bearer ${options.apiKey}` },
		});
		if (!response.ok) throw new Error(`OpenRouter model catalog request failed (HTTP ${response.status})`);
		const { ids, models } = parseCatalog(await response.json());
		await writeCache(path, { schemaVersion: 2, fetchedAt: now(), ids, models });
		return { ids, models, fromCache: false };
	} catch (error) {
		const message =
			error instanceof Error && /^OpenRouter model catalog request failed \(HTTP \d+\)$/.test(error.message)
				? error.message
				: "Unable to refresh OpenRouter model catalog";
		return {
			ids: cached?.ids ?? [],
			models: cached?.schemaVersion === 2 ? cached.models : [],
			fromCache: Boolean(cached),
			error: new Error(message),
		};
	}
}
