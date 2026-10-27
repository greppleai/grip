import type * as fsModule from "node:fs";
import type * as osModule from "node:os";
import type * as pathModule from "node:path";
import type { ImagesModel, KnownImagesProvider, ModelInputModality } from "./types.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
type NodeFs = Pick<typeof fsModule, "mkdirSync" | "readFileSync" | "renameSync" | "writeFileSync">;
type NodeOs = Pick<typeof osModule, "homedir">;
type NodePath = Pick<typeof pathModule, "dirname" | "join">;
function builtin<T>(name: string): T | undefined {
	return typeof process === "undefined" ? undefined : (process.getBuiltinModule?.(name) as T | undefined);
}
function defaultCachePath(): string | undefined {
	const os = builtin<NodeOs>("os");
	const path = builtin<NodePath>("path");
	if (!os || !path) return undefined;
	return path.join(
		process.env.GRIP_CODING_AGENT_DIR || path.join(os.homedir(), ".grip", "agent"),
		"image-models.json",
	);
}
type ImageModel = ImagesModel<"openrouter-images">;
type CatalogCache = { fetchedAt: number; models: ImageModel[] };

const imageModelRegistry = new Map<string, Map<string, ImageModel>>();
let cacheLoaded = false;
let fetchedAt = 0;
let fetchedCachePath: string | undefined;
let refreshInProgress: Promise<ImageModel[]> | undefined;

function replaceModels(models: ImageModel[]): void {
	const providerModels = new Map<string, ImageModel>();
	for (const model of models) providerModels.set(model.id, model);
	imageModelRegistry.set("openrouter", providerModels);
}

function validModel(value: unknown): value is ImageModel {
	if (!value || typeof value !== "object") return false;
	const model = value as Partial<ImageModel>;
	return (
		typeof model.id === "string" &&
		model.id.length > 0 &&
		typeof model.name === "string" &&
		model.api === "openrouter-images" &&
		model.provider === "openrouter" &&
		typeof model.baseUrl === "string" &&
		Array.isArray(model.input) &&
		Array.isArray(model.output) &&
		model.output.includes("image") &&
		!!model.cost &&
		typeof model.cost.input === "number" &&
		typeof model.cost.output === "number" &&
		typeof model.cost.cacheRead === "number" &&
		typeof model.cost.cacheWrite === "number"
	);
}

function loadCache(path: string | undefined): void {
	if (!path || (cacheLoaded && path === defaultCachePath())) return;
	try {
		const fs = builtin<NodeFs>("fs");
		if (!fs) return;
		const cache = JSON.parse(fs.readFileSync(path, "utf8")) as Partial<CatalogCache>;
		if (
			typeof cache.fetchedAt === "number" &&
			Array.isArray(cache.models) &&
			cache.models.length > 0 &&
			cache.models.every(validModel)
		) {
			replaceModels(cache.models);
			fetchedAt = cache.fetchedAt;
			fetchedCachePath = path;
		}
	} catch {
		// A missing or invalid cache is not a usable catalog.
	}
	if (path === defaultCachePath()) cacheLoaded = true;
}

interface OpenRouterArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

interface OpenRouterPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

interface OpenRouterModelRecord {
	id: string;
	name: string;
	architecture?: OpenRouterArchitecture;
	pricing?: OpenRouterPricing;
}

async function fetchModels(fetchImpl: typeof fetch): Promise<ImageModel[]> {
	const response = await fetchImpl(`${OPENROUTER_BASE_URL}/models?output_modalities=image`, {
		signal: AbortSignal.timeout(8000),
	});
	if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);
	const data = (await response.json()) as { data?: OpenRouterModelRecord[] };
	if (!Array.isArray(data.data)) throw new Error("OpenRouter response did not contain model metadata");
	const models: ImageModel[] = [];
	for (const model of data.data) {
		if (!model || typeof model.id !== "string" || typeof model.name !== "string") continue;
		const modalities = (values: string[] | undefined) =>
			Array.from(
				new Set(
					(values ?? []).filter((value): value is ModelInputModality => value === "text" || value === "image"),
				),
			);
		const input = modalities(model.architecture?.input_modalities);
		const output = modalities(model.architecture?.output_modalities);
		if (!output.includes("image")) continue;
		if (input.length === 0) input.push("text");
		const price = (value: string | undefined) => {
			const parsed = Number.parseFloat(value || "0");
			return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
		};
		models.push({
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: OPENROUTER_BASE_URL,
			input,
			output,
			cost: {
				input: price(model.pricing?.prompt),
				output: price(model.pricing?.completion),
				cacheRead: price(model.pricing?.input_cache_read),
				cacheWrite: price(model.pricing?.input_cache_write),
			},
		});
	}
	const unique = Array.from(new Map(models.map((model) => [model.id, model])).values()).sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	if (unique.length === 0) throw new Error("OpenRouter returned no image models");
	return unique;
}

export interface RefreshImageModelsOptions {
	cachePath?: string;
	ttlMs?: number;
	force?: boolean;
	fetch?: typeof fetch;
	now?: () => number;
}

/** Fetches and caches OpenRouter image metadata; failed refreshes leave the last-good catalog intact. */
export async function refreshImageModels(options: RefreshImageModelsOptions = {}): Promise<ImageModel[]> {
	const path = options.cachePath ?? defaultCachePath();
	loadCache(path);
	const now = (options.now ?? Date.now)();
	if (
		!options.force &&
		fetchedCachePath === path &&
		imageModelRegistry.has("openrouter") &&
		now - fetchedAt < (options.ttlMs ?? DEFAULT_TTL_MS)
	) {
		return getImageModels("openrouter");
	}
	if (refreshInProgress) return refreshInProgress;
	refreshInProgress = (async () => {
		const models = await fetchModels(options.fetch ?? fetch);
		const cache: CatalogCache = { fetchedAt: now, models };
		if (path) {
			const fs = builtin<NodeFs>("fs");
			const nodePath = builtin<NodePath>("path");
			if (fs && nodePath) {
				fs.mkdirSync(nodePath.dirname(path), { recursive: true });
				const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
				fs.writeFileSync(temporaryPath, JSON.stringify(cache), "utf8");
				fs.renameSync(temporaryPath, path);
			}
		}
		replaceModels(models);
		fetchedAt = now;
		fetchedCachePath = path;
		if (path === defaultCachePath()) cacheLoaded = true;
		return models;
	})().finally(() => {
		refreshInProgress = undefined;
	});
	return refreshInProgress;
}

function ensureDefaultCacheLoaded(): void {
	if (!cacheLoaded && !imageModelRegistry.has("openrouter")) loadCache(defaultCachePath());
}

export function getImageModel<TProvider extends KnownImagesProvider>(
	provider: TProvider,
	modelId: string,
): ImagesModel<"openrouter-images"> {
	ensureDefaultCacheLoaded();
	return imageModelRegistry.get(provider)?.get(modelId) as ImagesModel<"openrouter-images">;
}

export function getImageProviders(): KnownImagesProvider[] {
	ensureDefaultCacheLoaded();
	return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

export function getImageModels<TProvider extends KnownImagesProvider>(
	provider: TProvider,
): ImagesModel<"openrouter-images">[] {
	ensureDefaultCacheLoaded();
	const models = imageModelRegistry.get(provider);
	return models ? Array.from(models.values()) : [];
}
