import type { SessionEntry } from "./types.ts";

export const USAGE_LEDGER_ENTRY_TYPE = "usage_ledger";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	catalogCost: number;
	requests: number;
}

export interface UsageLedger extends UsageTotals {
	version: 1;
	checkpointId: string;
	last: UsageTotals;
	/** Delegated job usage, separate from the parent provider totals. */
	jobs: UsageTotals;
}

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, catalogCost: 0, requests: 0 };
}

function isLedger(value: unknown): value is UsageLedger {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<UsageLedger>;
	return (
		data.version === 1 &&
		typeof data.checkpointId === "string" &&
		!!data.last &&
		[data, data.last].every(
			(item) =>
				Number.isFinite(item.input) &&
				Number.isFinite(item.output) &&
				Number.isFinite(item.cacheRead) &&
				Number.isFinite(item.cacheWrite) &&
				Number.isFinite(item.catalogCost) &&
				Number.isFinite(item.requests),
		)
	);
}

function addAssistantUsage(ledger: UsageLedger, entry: SessionEntry): void {
	if (entry.type !== "message" || entry.message.role !== "assistant" || entry.replayedFromId) return;
	const usage = entry.message.usage;
	if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost.total) return;
	ledger.input += usage.input;
	ledger.output += usage.output;
	ledger.cacheRead += usage.cacheRead;
	ledger.cacheWrite += usage.cacheWrite;
	ledger.catalogCost += usage.cost.total;
	ledger.requests++;
	ledger.last = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		catalogCost: usage.cost.total,
		requests: 1,
	};
	ledger.checkpointId = entry.id;
}

function addJobResultUsage(totals: UsageTotals, result: unknown): void {
	if (!result || typeof result !== "object" || !("usage" in result)) return;
	const usage = result.usage;
	if (!usage || typeof usage !== "object") return;
	const fields = usage as Record<string, unknown>;
	for (const [source, target] of [
		["input", "input"],
		["output", "output"],
		["cacheRead", "cacheRead"],
		["cacheWrite", "cacheWrite"],
		["cost", "catalogCost"],
		["turns", "requests"],
	] as const) {
		const value = fields[source];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) totals[target] += value;
	}
}

function addJobUsage(totals: UsageTotals, entry: SessionEntry): void {
	if (entry.type !== "message" || entry.replayedFromId || entry.message.role !== "toolResult") return;
	if (entry.message.toolName !== "job") return;
	const details: unknown = entry.message.details;
	if (!details || typeof details !== "object" || !("results" in details) || !Array.isArray(details.results)) return;
	for (const result of details.results as unknown[]) addJobResultUsage(totals, result);
}

/** Latest persisted parent checkpoint plus uncheckpointed responses and all recorded job results. */
export function readUsageLedger(entries: SessionEntry[]): UsageLedger {
	let checkpointIndex = -1;
	let prior: UsageLedger | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === USAGE_LEDGER_ENTRY_TYPE && isLedger(entry.data)) {
			prior = entry.data;
			checkpointIndex = index;
			break;
		}
	}
	const ledger: UsageLedger = {
		version: 1,
		checkpointId: prior?.checkpointId ?? "",
		input: prior?.input ?? 0,
		output: prior?.output ?? 0,
		cacheRead: prior?.cacheRead ?? 0,
		cacheWrite: prior?.cacheWrite ?? 0,
		catalogCost: prior?.catalogCost ?? 0,
		requests: prior?.requests ?? 0,
		last: prior?.last ?? emptyTotals(),
		jobs: emptyTotals(),
	};
	for (const entry of entries.slice(checkpointIndex + 1)) addAssistantUsage(ledger, entry);
	for (const entry of entries) addJobUsage(ledger.jobs, entry);
	return ledger;
}
