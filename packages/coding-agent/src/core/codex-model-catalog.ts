import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@greppleai/grip-ai";

const CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";
const NPM_VERSION_URL = "https://registry.npmjs.org/@openai%2Fcodex/latest";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
type CodexModel = Model<"openai-codex-responses">;
interface CacheRecord {
	schemaVersion: 1;
	fetchedAt: number;
	models: CodexModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSemver(value: unknown): value is string {
	return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function cachePathFor(cacheDir: string, accountId: string): string {
	return join(cacheDir, `${createHash("sha256").update(accountId).digest("hex")}.json`);
}

type ListedModelRow = Record<string, unknown> & {
	slug: string;
	display_name: string;
	input_modalities: string[];
	context_window: number;
};

function isListedModelRow(row: Record<string, unknown>): row is ListedModelRow {
	const { slug, display_name: name, input_modalities: modalities, context_window: contextWindow } = row;
	return (
		typeof slug === "string" &&
		/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(slug) &&
		typeof name === "string" &&
		Boolean(name.trim()) &&
		name.length <= 256 &&
		Array.isArray(modalities) &&
		modalities.includes("text") &&
		modalities.every((modality) => typeof modality === "string") &&
		Number.isSafeInteger(contextWindow) &&
		(contextWindow as number) > 0
	);
}

function parseListedModel(row: Record<string, unknown>): CodexModel {
	const levels = row.supported_reasoning_levels;
	if (
		!isListedModelRow(row) ||
		!Array.isArray(levels) ||
		levels.some((level) => !isRecord(level) || typeof level.effort !== "string" || !level.effort)
	) {
		throw new Error("Invalid Codex model catalog entry");
	}
	const thinkingLevelMap: NonNullable<CodexModel["thinkingLevelMap"]> = {};
	for (const level of levels as Array<{ effort: string }>) {
		if (REASONING_LEVELS.has(level.effort)) {
			thinkingLevelMap[level.effort as keyof typeof thinkingLevelMap] = level.effort;
		}
	}
	return {
		id: row.slug,
		name: row.display_name,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: levels.length > 0,
		...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
		// The catalog may advertise additional modalities that Grip cannot send yet.
		input: [...new Set(row.input_modalities.filter((modality) => modality === "text" || modality === "image"))],
		// ChatGPT subscription requests are not billed per token; the endpoint publishes no prices.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: row.context_window,
		// Codex does not publish an output limit in this response.
		maxTokens: Math.min(row.context_window, 128000),
	};
}

function parseModels(payload: unknown): CodexModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.models)) throw new Error("Invalid Codex model catalog response");
	const result: CodexModel[] = [];
	const slugs = new Set<string>();
	for (const row of payload.models) {
		if (!isRecord(row) || (row.visibility !== "list" && row.visibility !== "hide" && row.visibility !== "none")) {
			throw new Error("Invalid Codex model catalog entry");
		}
		if (row.visibility !== "list") continue;
		const model = parseListedModel(row);
		if (slugs.has(model.id)) throw new Error("Duplicate Codex model slug");
		slugs.add(model.id);
		result.push(model);
	}
	if (result.length === 0) throw new Error("Codex model catalog has no listed models");
	return result;
}

async function readCache(path: string): Promise<CacheRecord | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== 1 ||
			!Number.isFinite(parsed.fetchedAt) ||
			!Array.isArray(parsed.models) ||
			!parsed.models.length
		)
			return undefined;
		for (const model of parsed.models) {
			if (!isRecord(model)) return undefined;
			const cost = model.cost;
			if (
				model.provider !== "openai-codex" ||
				model.api !== "openai-codex-responses" ||
				model.baseUrl !== "https://chatgpt.com/backend-api" ||
				typeof model.id !== "string" ||
				typeof model.name !== "string" ||
				!Number.isSafeInteger(model.contextWindow) ||
				(model.contextWindow as number) <= 0 ||
				!Number.isSafeInteger(model.maxTokens) ||
				(model.maxTokens as number) <= 0 ||
				typeof model.reasoning !== "boolean" ||
				!Array.isArray(model.input) ||
				model.input.some((m) => m !== "text" && m !== "image") ||
				!isRecord(cost) ||
				cost.input !== 0 ||
				cost.output !== 0 ||
				cost.cacheRead !== 0 ||
				cost.cacheWrite !== 0
			)
				return undefined;
		}
		return parsed as unknown as CacheRecord;
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

export async function loadCachedCodexModelCatalog(accountId: string, cacheDir: string): Promise<CodexModel[]> {
	return (await readCache(cachePathFor(cacheDir, accountId)))?.models ?? [];
}

interface CodexCatalogOptions {
	accessToken: string;
	accountId: string;
	cacheDir: string;
	force?: boolean;
	fetch?: typeof fetch;
	now?: () => number;
	clientVersion?: string;
}

interface CodexCatalogResult {
	models: CodexModel[];
	fromCache: boolean;
	error?: Error;
}

async function resolveClientVersion(options: CodexCatalogOptions, fetcher: typeof fetch): Promise<string> {
	let version = options.clientVersion ?? process.env.CODEX_CLIENT_VERSION;
	if (!version) {
		let response: Response;
		try {
			response = await fetcher(NPM_VERSION_URL, { method: "GET", signal: AbortSignal.timeout(10_000) });
		} catch {
			throw new CodexCatalogError("Codex client version lookup failed (network or timeout)");
		}
		if (!response.ok) throw new CodexCatalogError(`Codex client version lookup failed (HTTP ${response.status})`);
		let metadata: unknown;
		try {
			metadata = await response.json();
		} catch {
			throw new CodexCatalogError("Codex client version metadata is not valid JSON");
		}
		version = isRecord(metadata) ? (metadata.version as string) : undefined;
	}
	if (!validSemver(version))
		throw new CodexCatalogError("Invalid Codex client version; check CODEX_CLIENT_VERSION or npm metadata");
	return version.split(/[+-]/)[0] as string;
}

// Only errors created here contain messages safe to surface to the user.
class CodexCatalogError extends Error {}

/** Fetch the authenticated, account-specific Codex catalog; never cache credentials. */
export async function refreshCodexModelCatalog(options: CodexCatalogOptions): Promise<CodexCatalogResult> {
	const fetcher = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const cachePath = cachePathFor(options.cacheDir, options.accountId);
	const cached = await readCache(cachePath);
	if (!options.force && cached && now() - cached.fetchedAt >= 0 && now() - cached.fetchedAt < CACHE_TTL_MS) {
		return { models: cached.models, fromCache: true };
	}
	let failureMessage = "Unable to resolve Codex client version";
	let models: CodexModel[];
	try {
		const version = await resolveClientVersion(options, fetcher);
		failureMessage = "Codex model catalog request failed (network or timeout)";
		const response = await fetcher(`${CATALOG_URL}?client_version=${encodeURIComponent(version)}`, {
			method: "GET",
			signal: AbortSignal.timeout(10_000),
			headers: { Authorization: `Bearer ${options.accessToken}`, "ChatGPT-Account-ID": options.accountId },
		});
		if (!response.ok) throw new CodexCatalogError(`Codex model catalog request failed (HTTP ${response.status})`);
		failureMessage = "Codex model catalog response is not valid JSON";
		const payload: unknown = await response.json();
		failureMessage = "Codex model catalog validation failed";
		models = parseModels(payload);
	} catch (error) {
		// Never surface raw errors: they can include request headers, tokens, or response bodies.
		const message = error instanceof CodexCatalogError ? error.message : failureMessage;
		return { models: cached?.models ?? [], fromCache: Boolean(cached), error: new Error(message) };
	}
	try {
		await writeCache(cachePath, { schemaVersion: 1, fetchedAt: now(), models });
	} catch {
		// Persistence failure must not discard a successfully fetched catalog.
		return { models, fromCache: false, error: new Error("Codex model catalog refreshed but could not be cached") };
	}
	return { models, fromCache: false };
}
