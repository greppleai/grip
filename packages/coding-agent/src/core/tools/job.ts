/**
 * Job Tool - Delegate bounded tasks to isolated sessions
 *
 * Runs each task in a fresh embedded AgentSession using an injected runner.
 * Supports single, parallel, and sequential chain modes.
 */

import * as os from "node:os";
import type { AgentTool, AgentToolResult } from "@greppleai/grip-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@greppleai/grip-ai";
import { Container, Markdown, Spacer, Text } from "@greppleai/grip-tui";
import { type Static, Type } from "typebox";
import { getMarkdownTheme, type Theme, type ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolOperations } from "./operations.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = 16;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_RETAINED_MESSAGE_CHARS = 64 * 1024;
const MAX_RETAINED_TASK_CHARS = 256 * 1024;
const MAX_RETAINED_TASK_MESSAGES = 100;
const MAX_RETAINED_TASK_DESCRIPTION_CHARS = 16 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

type JobUsageDisplayMetrics = Omit<JobUsageStats, "contextTokens" | "turns"> & Partial<Pick<JobUsageStats, "turns">>;

function formatUsageStats(usage: JobUsageDisplayMetrics): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

type JobToolThemeForeground = (color: ThemeColor, text: string) => string;

function shortenJobToolPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatBashToolCall(args: Record<string, unknown>, themeFg: JobToolThemeForeground): string {
	const command = (args.command as string) || "...";
	const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
	return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
}

function formatReadToolCall(args: Record<string, unknown>, themeFg: JobToolThemeForeground): string {
	const rawPath = (args.file_path || args.path || "...") as string;
	const filePath = shortenJobToolPath(rawPath);
	const offset = args.offset as number | undefined;
	const limit = args.limit as number | undefined;
	let text = themeFg("accent", filePath);
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ?? 1;
		const endLine = limit !== undefined ? startLine + limit - 1 : "";
		text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
	}
	return themeFg("muted", "read ") + text;
}

function formatWriteToolCall(args: Record<string, unknown>, themeFg: JobToolThemeForeground): string {
	const rawPath = (args.file_path || args.path || "...") as string;
	const filePath = shortenJobToolPath(rawPath);
	const content = (args.content || "") as string;
	const lines = content.split("\n").length;
	let text = themeFg("muted", "write ") + themeFg("accent", filePath);
	if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
	return text;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: JobToolThemeForeground): string {
	switch (toolName) {
		case "bash":
			return formatBashToolCall(args, themeFg);
		case "read":
			return formatReadToolCall(args, themeFg);
		case "write":
			return formatWriteToolCall(args, themeFg);
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenJobToolPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenJobToolPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenJobToolPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenJobToolPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export interface JobUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";
export type JobMode = "single" | "parallel" | "chain";

export type JobExecutionBackend = "local" | "remote" | "unknown";

export interface JobExecutionContext {
	cwd: string;
	backend: JobExecutionBackend;
	model?: string;
	tools: string[];
	preloadedSkills: string[];
}

export interface JobResult {
	status: JobStatus;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: JobUsageStats;
	model?: string;
	/** Recorded from the child after its session and tools have been initialized. */
	execution?: JobExecutionContext;
	stopReason?: string;
	errorMessage?: string;
	responseFormat?: string;
	step?: number;
}
export interface JobDetails {
	mode: JobMode;
	results: JobResult[];
}

interface PresentationSegment {
	displayItemCount: number;
	assistantOutput?: string;
}

interface JobPresentationState {
	displayItems: DisplayItem[];
	assistantOutputs: string[];
	segments: PresentationSegment[];
}

interface RetainedJobMessageState {
	presentation: JobPresentationState;
	retainedChars: number;
	retainedSizes: number[];
}

const presentationCache = new WeakMap<Message[], JobPresentationState>();

function appendPresentationMessage(state: JobPresentationState, message: Message): void {
	const segment: PresentationSegment = { displayItemCount: 0 };
	if (message.role === "assistant") {
		const textParts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text") {
				state.displayItems.push({ type: "text", text: part.text });
				textParts.push(part.text);
				segment.displayItemCount++;
			} else if (part.type === "toolCall") {
				state.displayItems.push({ type: "toolCall", name: part.name, args: part.arguments });
				segment.displayItemCount++;
			}
		}
		if (textParts.length > 0) {
			segment.assistantOutput = textParts.join("\n");
			state.assistantOutputs.push(segment.assistantOutput);
		}
	}
	state.segments.push(segment);
}

function removeOldestPresentationMessage(state: JobPresentationState): void {
	const segment = state.segments.shift();
	if (!segment) return;
	if (segment.displayItemCount > 0) state.displayItems.splice(0, segment.displayItemCount);
	if (segment.assistantOutput !== undefined) state.assistantOutputs.shift();
}

function getPresentationState(messages: Message[]): JobPresentationState {
	const cached = presentationCache.get(messages);
	if (cached) return cached;
	const state: JobPresentationState = { displayItems: [], assistantOutputs: [], segments: [] };
	for (const message of messages) appendPresentationMessage(state, message);
	presentationCache.set(messages, state);
	return state;
}

function getFinalOutput(messages: Message[]): string {
	return getPresentationState(messages).assistantOutputs.at(-1) ?? "";
}

function isFailedResult(result: JobResult): boolean {
	return result.status === "failed";
}

function getResultOutput(result: JobResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function formatJobExecution(result: JobResult): string | undefined {
	if (!result.execution) return undefined;
	return `Execution: ${JSON.stringify({ ...result.execution, model: result.execution.model ?? "unavailable" })}`;
}

function prependJobExecution(result: JobResult, output: string): string {
	const execution = formatJobExecution(result);
	return execution ? `${execution}\n\n${output}` : output;
}

function formatChainExecution(results: JobResult[]): string {
	return results
		.map((result) => {
			const execution = formatJobExecution(result);
			return execution ? `Step ${result.step}: ${execution}` : undefined;
		})
		.filter((execution) => execution !== undefined)
		.join("\n");
}
function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	return getPresentationState(messages).displayItems;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
function truncateRetainedTask(task: string): string {
	if (task.length <= MAX_RETAINED_TASK_DESCRIPTION_CHARS) return task;
	return `${task.slice(0, MAX_RETAINED_TASK_DESCRIPTION_CHARS)}\n\n[Task truncated in retained details]`;
}

function truncateRetainedText(text: string): string {
	if (text.length <= MAX_RETAINED_MESSAGE_CHARS) return text;
	return `${text.slice(0, MAX_RETAINED_MESSAGE_CHARS)}\n\n[Retained output truncated: ${text.length - MAX_RETAINED_MESSAGE_CHARS} characters omitted.]`;
}

function compactRetainedMessage(message: Message): Message | undefined {
	if (JSON.stringify(message).length <= MAX_RETAINED_MESSAGE_CHARS) return message;
	if (message.role === "assistant") {
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return {
			...message,
			errorMessage: message.errorMessage ? truncateRetainedText(message.errorMessage) : undefined,
			content: [{ type: "text", text: truncateRetainedText(text || "[Oversized assistant event omitted]") }],
		};
	}
	if (message.role === "toolResult") {
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return {
			...message,
			toolCallId: message.toolCallId.slice(0, 1024),
			toolName: message.toolName.slice(0, 1024),
			details: undefined,
			content: [{ type: "text", text: truncateRetainedText(text || "[Oversized tool result omitted]") }],
		};
	}
	return undefined;
}
function retainJobMessage(result: JobResult, state: RetainedJobMessageState, message: Message): void {
	const retainedMessage = compactRetainedMessage(message);
	if (!retainedMessage) return;

	const retainedSize = JSON.stringify(retainedMessage).length;
	result.messages.push(retainedMessage);
	appendPresentationMessage(state.presentation, retainedMessage);
	state.retainedSizes.push(retainedSize);
	state.retainedChars += retainedSize;
	while (
		result.messages.length > MAX_RETAINED_TASK_MESSAGES ||
		(state.retainedChars > MAX_RETAINED_TASK_CHARS && result.messages.length > 1)
	) {
		result.messages.shift();
		removeOldestPresentationMessage(state.presentation);
		state.retainedChars -= state.retainedSizes.shift() ?? 0;
	}
}

function recordJobAssistantMessage(result: JobResult, message: AssistantMessage): void {
	result.usage.turns++;
	const usage = message.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	result.errorMessage = message.errorMessage;
}

type OnUpdateCallback = (partial: AgentToolResult<JobDetails>) => void;

export interface JobRunRequest {
	cwd: string;
	toolOperations?: ToolOperations;
	prompt: string;
	/** Human-readable delegated task, without wrapper markup. */
	task: string;
	model?: string;
	tools?: string[];
	skills?: string[];
	/** Include load_skill with default tools; explicit per-task tool lists remain authoritative. */
	includeDefaultSkillTool?: boolean;
	signal?: AbortSignal;
	onMessage: (message: Message) => void;
}

export interface JobRunOutcome {
	exitCode: number;
	stderr: string;
	execution?: JobExecutionContext;
}

export type JobRunner = (request: JobRunRequest) => Promise<JobRunOutcome>;

interface JobTaskSpec {
	task: string;
	responseFormat?: string;
	tools?: string[];
	skills?: string[];
	cwd?: string;
	toolOperations?: ToolOperations;
}

function finalizeJobRun(result: JobResult, outcome: JobRunOutcome, aborted: boolean): JobResult {
	result.exitCode = outcome.exitCode;
	result.stderr = outcome.stderr;
	result.execution = outcome.execution;
	if (outcome.execution?.model) result.model = outcome.execution.model;
	if (aborted) {
		result.status = "failed";
		result.stopReason = "aborted";
		result.errorMessage ??= outcome.stderr || "Job was aborted";
		return result;
	}
	result.status =
		outcome.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
			? "failed"
			: "completed";
	return result;
}
async function invokeJobRunner(runner: JobRunner, request: JobRunRequest): Promise<JobRunOutcome> {
	try {
		return await runner(request);
	} catch (error) {
		if (!request.signal?.aborted) throw error;
		return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
	}
}

export function formatJobTaskPrompt(task: string, responseFormat?: string): string {
	const sections = [`<task>\n${task}\n</task>`];
	if (responseFormat?.trim()) {
		sections.push(`<response-format>\n${responseFormat}\n</response-format>`);
	}
	return sections.join("\n\n");
}

async function runSingleJob(
	defaultCwd: string,
	spec: JobTaskSpec,
	model: string | undefined,
	runner: JobRunner,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: JobResult[]) => JobDetails,
): Promise<JobResult> {
	const currentResult: JobResult = {
		status: "running",
		task: truncateRetainedTask(spec.task),
		responseFormat: spec.responseFormat,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};
	if (signal?.aborted) {
		currentResult.status = "failed";
		currentResult.exitCode = 1;
		currentResult.stderr = "Job was aborted";
		currentResult.stopReason = "aborted";
		currentResult.errorMessage = "Job was aborted";
		return currentResult;
	}
	const retainedMessageState: RetainedJobMessageState = {
		presentation: getPresentationState(currentResult.messages),
		retainedChars: 0,
		retainedSizes: [],
	};
	const emitUpdate = (): void => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};
	const onMessage = (message: Message): void => {
		retainJobMessage(currentResult, retainedMessageState, message);
		if (message.role === "assistant") recordJobAssistantMessage(currentResult, message);
		emitUpdate();
	};

	emitUpdate();
	const outcome = await invokeJobRunner(runner, {
		cwd: spec.cwd ?? defaultCwd,
		toolOperations: spec.toolOperations,
		prompt: formatJobTaskPrompt(spec.task, spec.responseFormat),
		task: spec.task,
		model,
		tools: spec.tools,
		skills: spec.skills,
		includeDefaultSkillTool: spec.tools === undefined,
		signal,
		onMessage,
	});
	return finalizeJobRun(currentResult, outcome, signal?.aborted === true);
}

const TaskItem = Type.Object({
	task: Type.String({ description: "A bounded job with a concrete deliverable" }),
	responseFormat: Type.Optional(Type.String({ description: "Requested response content and structure" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for this job" })),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Skills to force-preload from the parent catalog before the first job turn; unknown names fail the job",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the job session" })),
});
const ChainItem = Type.Object({
	...TaskItem.properties,
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
});
export const jobParamsSchema = Type.Object({
	...TaskItem.properties,
	task: Type.Optional(Type.String({ description: "A bounded job to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Independent jobs for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential jobs", maxItems: MAX_CHAIN_STEPS })),
});
export type JobToolInput = Static<typeof jobParamsSchema>;

export interface JobToolOptions {
	runner?: JobRunner;
	/** Host-controlled globally selected job model; not exposed to the delegated model. */
	getConfiguredModel?: () => string | undefined;
}

interface JobModeSelection {
	mode: JobMode;
	hasChain: boolean;
	hasTasks: boolean;
	hasSingle: boolean;
	modeCount: number;
}

type JobDetailsBuilder = (results: JobResult[]) => JobDetails;
type JobDetailsFactory = (mode: JobMode) => JobDetailsBuilder;

interface JobExecutionEnvironment {
	workspaceCwd: string;
	workspaceOperations: ToolOperations;
	model: string | undefined;
	runner: JobRunner;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: JobDetailsFactory;
}

interface JobToolExecutionResult extends AgentToolResult<JobDetails> {
	isError?: boolean;
}

function inheritedJobModelName(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function selectJobMode(params: JobToolInput): JobModeSelection {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.task);
	return {
		mode: hasChain ? "chain" : hasTasks ? "parallel" : "single",
		hasChain,
		hasTasks,
		hasSingle,
		modeCount: Number(hasChain) + Number(hasTasks) + Number(hasSingle),
	};
}

function createJobDetailsFactory(): JobDetailsFactory {
	return (mode) => (results) => ({ mode, results });
}

function validateJobRequest(
	selection: JobModeSelection,
	makeDetails: JobDetailsFactory,
): JobToolExecutionResult | undefined {
	if (selection.modeCount !== 1) {
		return {
			content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode." }],
			details: makeDetails("single")([]),
			isError: true,
		};
	}
	return undefined;
}

function createChainUpdate(
	onUpdate: OnUpdateCallback | undefined,
	results: JobResult[],
	makeDetails: JobDetailsFactory,
): OnUpdateCallback | undefined {
	if (!onUpdate) return undefined;
	return (partial) => {
		const currentResult = partial.details?.results[0];
		if (!currentResult) return;
		onUpdate({
			content: partial.content,
			details: makeDetails("chain")([...results, currentResult]),
		});
	};
}

async function executeJobChain(
	params: JobToolInput,
	environment: JobExecutionEnvironment,
): Promise<JobToolExecutionResult> {
	const chain = params.chain ?? [];
	if (chain.length > MAX_CHAIN_STEPS) {
		return {
			content: [{ type: "text", text: `Too many chain steps (${chain.length}). Max is ${MAX_CHAIN_STEPS}.` }],
			details: environment.makeDetails("chain")([]),
		};
	}
	const results: JobResult[] = [];
	let previousOutput = "";
	for (let index = 0; index < chain.length; index++) {
		const step = chain[index];
		const result = await runSingleJob(
			environment.workspaceCwd,
			{
				...step,
				task: step.task.replace(/\{previous\}/g, previousOutput),
				toolOperations: environment.workspaceOperations,
			},
			environment.model,
			environment.runner,
			index + 1,
			environment.signal,
			createChainUpdate(environment.onUpdate, results, environment.makeDetails),
			environment.makeDetails("chain"),
		);
		results.push(result);
		if (isFailedResult(result)) {
			const message = `Chain stopped at step ${index + 1}: ${getResultOutput(result)}`;
			const execution = formatChainExecution(results);
			return {
				content: [{ type: "text", text: execution ? `${execution}\n\n${message}` : message }],
				details: environment.makeDetails("chain")(results),
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}
	const execution = formatChainExecution(results);
	const output = getFinalOutput(results[results.length - 1].messages) || "(no output)";
	return {
		content: [{ type: "text", text: execution ? `${execution}\n\n${output}` : output }],
		details: environment.makeDetails("chain")(results),
	};
}

function createQueuedJobResult(task: JobTaskSpec, model: string | undefined): JobResult {
	return {
		status: "queued",
		task: truncateRetainedTask(task.task),
		responseFormat: task.responseFormat,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
	};
}

function emitParallelJobUpdate(
	onUpdate: OnUpdateCallback | undefined,
	results: JobResult[],
	makeDetails: JobDetailsFactory,
): void {
	if (!onUpdate) return;
	const running = results.filter((result) => result.status === "running" || result.status === "queued").length;
	const done = results.length - running;
	onUpdate({
		content: [{ type: "text", text: `Parallel: ${done}/${results.length} done, ${running} running...` }],
		details: makeDetails("parallel")([...results]),
	});
}

function formatParallelJobSummary(result: JobResult, index: number): string {
	const output = prependJobExecution(result, truncateParallelOutput(getResultOutput(result)));
	const status = isFailedResult(result)
		? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
		: "completed";
	return `### Job ${index + 1} ${status}\n\n${output}`;
}

async function executeParallelJobs(
	params: JobToolInput,
	environment: JobExecutionEnvironment,
): Promise<JobToolExecutionResult> {
	const tasks = params.tasks ?? [];
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
			details: environment.makeDetails("parallel")([]),
		};
	}
	const currentResults = tasks.map((task) => createQueuedJobResult(task, environment.model));
	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
		const result = await runSingleJob(
			environment.workspaceCwd,
			{ ...task, toolOperations: environment.workspaceOperations },
			environment.model,
			environment.runner,
			undefined,
			environment.signal,
			(partial) => {
				const currentResult = partial.details?.results[0];
				if (!currentResult) return;
				currentResults[index] = currentResult;
				emitParallelJobUpdate(environment.onUpdate, currentResults, environment.makeDetails);
			},
			environment.makeDetails("parallel"),
		);
		currentResults[index] = result;
		emitParallelJobUpdate(environment.onUpdate, currentResults, environment.makeDetails);
		return result;
	});
	const successCount = results.filter((result) => !isFailedResult(result)).length;
	const summaries = results.map(formatParallelJobSummary);
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: environment.makeDetails("parallel")(results),
	};
}

async function executeSingleJob(
	params: JobToolInput,
	environment: JobExecutionEnvironment,
): Promise<JobToolExecutionResult> {
	const result = await runSingleJob(
		environment.workspaceCwd,
		{
			task: params.task ?? "",
			responseFormat: params.responseFormat,
			tools: params.tools,
			skills: params.skills,
			cwd: params.cwd,
			toolOperations: environment.workspaceOperations,
		},
		environment.model,
		environment.runner,
		undefined,
		environment.signal,
		environment.onUpdate,
		environment.makeDetails("single"),
	);
	if (isFailedResult(result)) {
		return {
			content: [
				{
					type: "text",
					text: prependJobExecution(result, `Job ${result.stopReason || "failed"}: ${getResultOutput(result)}`),
				},
			],
			details: environment.makeDetails("single")([result]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: prependJobExecution(result, getFinalOutput(result.messages) || "(no output)") }],
		details: environment.makeDetails("single")([result]),
	};
}

function executeSelectedJobMode(
	params: JobToolInput,
	selection: JobModeSelection,
	environment: JobExecutionEnvironment,
): Promise<JobToolExecutionResult> {
	if (selection.hasChain) return executeJobChain(params, environment);
	if (selection.hasTasks) return executeParallelJobs(params, environment);
	return executeSingleJob(params, environment);
}

function truncateJobCallTask(task: string, maxCharacters: number): string {
	return task.length > maxCharacters ? `${task.slice(0, maxCharacters)}...` : task;
}

function renderJobChainCall(args: JobToolInput, theme: Theme): Text {
	const chain = args.chain ?? [];
	let text = theme.fg("toolTitle", theme.bold("job ")) + theme.fg("accent", `chain (${chain.length} steps)`);
	for (let index = 0; index < Math.min(chain.length, 3); index++) {
		const step = chain[index];
		const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
		const preview = truncateJobCallTask(cleanTask, 40);
		text += `\n  ${theme.fg("accent", `Step ${index + 1}`)}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (chain.length > 3) text += `\n  ${theme.fg("muted", `... +${chain.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderParallelJobCall(args: JobToolInput, theme: Theme): Text {
	const tasks = args.tasks ?? [];
	let text = theme.fg("toolTitle", theme.bold("job ")) + theme.fg("accent", `parallel (${tasks.length} tasks)`);
	for (const [index, task] of tasks.slice(0, 3).entries()) {
		const preview = truncateJobCallTask(task.task, 40);
		text += `\n  ${theme.fg("accent", `Job ${index + 1}`)}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderSingleJobCall(args: JobToolInput, theme: Theme): Text {
	const preview = args.task ? truncateJobCallTask(args.task, 60) : "...";
	const text = `${theme.fg("toolTitle", theme.bold("job"))}\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

interface JobStatusCounts {
	completed: number;
	failed: number;
	active: number;
}

function renderJobStatusIcon(status: JobStatus, theme: Theme): string {
	if (status === "queued") return theme.fg("muted", "[queued]");
	if (status === "running") return theme.fg("warning", "[running]");
	if (status === "failed") return theme.fg("error", "[failed]");
	return theme.fg("success", "[done]");
}

function renderJobModel(model: string | undefined, theme: Theme): string {
	return theme.fg("muted", ` [${model ?? "model pending"}]`);
}

function renderJobContextUsage(result: JobResult, theme: Theme): string {
	const tokens = result.usage.contextTokens;
	if (tokens <= 0 && result.status !== "running") return "";
	return ` ${theme.fg("dim", `ctx:${tokens > 0 ? formatTokens(tokens) : "?"}`)}`;
}

function renderJobUsage(result: JobResult, theme: Theme): string {
	const usage = formatUsageStats(result.usage);
	return renderJobContextUsage(result, theme) + (usage ? ` ${theme.fg("dim", usage)}` : "");
}

function renderJobDisplayItems(items: DisplayItem[], expanded: boolean, theme: Theme, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = skipped > 0 ? theme.fg("muted", `... ${skipped} earlier items\n`) : "";
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
			continue;
		}
		text += `${theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
	}
	return text.trimEnd();
}

function aggregateJobUsage(results: JobResult[]): JobUsageDisplayMetrics {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
}

function renderTotalJobUsage(results: JobResult[], theme: Theme): string {
	const usage = formatUsageStats(aggregateJobUsage(results));
	return usage ? ` ${theme.fg("dim", `Total: ${usage}`)}` : "";
}

function countJobStatuses(results: JobResult[]): JobStatusCounts {
	const counts: JobStatusCounts = { completed: 0, failed: 0, active: 0 };
	for (const result of results) {
		if (result.status === "completed") counts.completed++;
		else if (result.status === "failed") counts.failed++;
		else counts.active++;
	}
	return counts;
}

function appendJobToolCalls(container: Container, items: DisplayItem[], theme: Theme): void {
	for (const item of items) {
		if (item.type !== "toolCall") continue;
		container.addChild(
			new Text(theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
		);
	}
}

function appendJobMarkdown(container: Container, output: string): void {
	if (!output) return;
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
}

function appendExpandedBatchResult(container: Container, result: JobResult, heading: string, theme: Theme): void {
	container.addChild(new Spacer(1));
	container.addChild(new Text(`${heading}${renderJobUsage(result, theme)}`, 0, 0));
	container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", result.task), 0, 0));
	if (result.responseFormat) {
		container.addChild(
			new Text(theme.fg("muted", "Response format: ") + theme.fg("dim", result.responseFormat), 0, 0),
		);
	}
	const execution = formatJobExecution(result);
	if (execution) container.addChild(new Text(theme.fg("dim", execution), 0, 0));
	appendJobToolCalls(container, getDisplayItems(result.messages), theme);
	appendJobMarkdown(container, getFinalOutput(result.messages));
}

function renderExpandedSingleJob(result: JobResult, theme: Theme): Container {
	const container = new Container();
	const failed = isFailedResult(result);
	let header = `${renderJobStatusIcon(result.status, theme)} ${theme.fg("toolTitle", theme.bold("Job"))}${renderJobModel(result.model, theme)}${renderJobUsage(result, theme)}`;
	if (failed && result.stopReason) header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (failed && result.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
	if (result.responseFormat) {
		container.addChild(
			new Text(theme.fg("muted", "Response format: ") + theme.fg("dim", result.responseFormat), 0, 0),
		);
	}
	const execution = formatJobExecution(result);
	if (execution) container.addChild(new Text(theme.fg("dim", execution), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
	const displayItems = getDisplayItems(result.messages);
	const finalOutput = getFinalOutput(result.messages);
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(
			new Text(theme.fg("muted", result.status === "running" ? "(running...)" : "(no output)"), 0, 0),
		);
	} else {
		appendJobToolCalls(container, displayItems, theme);
		appendJobMarkdown(container, finalOutput);
	}
	return container;
}

function renderCollapsedSingleJob(result: JobResult, theme: Theme): Text {
	const failed = isFailedResult(result);
	const displayItems = getDisplayItems(result.messages);
	let text = `${renderJobStatusIcon(result.status, theme)} ${theme.fg("toolTitle", theme.bold("Job"))}${renderJobModel(result.model, theme)}${renderJobUsage(result, theme)}`;
	if (failed && result.stopReason) text += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	if (failed && result.errorMessage) text += `\n${theme.fg("error", `Error: ${result.errorMessage}`)}`;
	else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", result.status === "running" ? "(running...)" : "(no output)")}`;
	} else {
		text += `\n${renderJobDisplayItems(displayItems, false, theme, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	return new Text(text, 0, 0);
}

function renderSingleJobResult(result: JobResult, expanded: boolean, theme: Theme): Text | Container {
	return expanded ? renderExpandedSingleJob(result, theme) : renderCollapsedSingleJob(result, theme);
}

function renderExpandedJobChain(results: JobResult[], counts: JobStatusCounts, icon: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(
		new Text(
			icon +
				" " +
				theme.fg("toolTitle", theme.bold("chain ")) +
				theme.fg("accent", `${counts.completed}/${results.length} steps`) +
				renderTotalJobUsage(results, theme),
			0,
			0,
		),
	);
	for (const result of results) {
		const heading = `${theme.fg("muted", `─── Step ${result.step}`)}${renderJobModel(result.model, theme)} ${renderJobStatusIcon(result.status, theme)}`;
		appendExpandedBatchResult(container, result, heading, theme);
	}
	return container;
}

function renderCollapsedJobChain(results: JobResult[], counts: JobStatusCounts, icon: string, theme: Theme): Text {
	let text =
		icon +
		" " +
		theme.fg("toolTitle", theme.bold("chain ")) +
		theme.fg("accent", `${counts.completed}/${results.length} steps`) +
		renderTotalJobUsage(results, theme);
	for (const result of results) {
		const items = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", `─── Step ${result.step}`)}${renderJobModel(result.model, theme)} ${renderJobStatusIcon(result.status, theme)}${renderJobUsage(result, theme)}`;
		if (items.length === 0) {
			const empty =
				result.status === "running" || result.status === "queued" ? `(${result.status}...)` : "(no output)";
			text += `\n${theme.fg("muted", empty)}`;
		} else text += `\n${renderJobDisplayItems(items, false, theme, 5)}`;
	}
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderJobChain(results: JobResult[], expanded: boolean, theme: Theme): Text | Container {
	const counts = countJobStatuses(results);
	const icon =
		counts.active > 0
			? theme.fg("warning", "[running]")
			: counts.failed > 0
				? theme.fg("error", "[failed]")
				: theme.fg("success", "[done]");
	return expanded
		? renderExpandedJobChain(results, counts, icon, theme)
		: renderCollapsedJobChain(results, counts, icon, theme);
}

function parallelJobStatus(counts: JobStatusCounts, total: number): string {
	return counts.active > 0
		? `${counts.completed + counts.failed}/${total} done, ${counts.active} running`
		: `${counts.completed}/${total} tasks`;
}

function renderExpandedParallelJobs(results: JobResult[], icon: string, status: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}${renderTotalJobUsage(results, theme)}`,
			0,
			0,
		),
	);
	for (const [index, result] of results.entries()) {
		const heading = `${theme.fg("muted", "─── ")}${theme.fg("accent", `Job ${index + 1}`)}${renderJobModel(result.model, theme)} ${renderJobStatusIcon(result.status, theme)}`;
		appendExpandedBatchResult(container, result, heading, theme);
	}
	return container;
}

function renderCollapsedParallelJobs(
	results: JobResult[],
	expanded: boolean,
	icon: string,
	status: string,
	theme: Theme,
): Text {
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}${renderTotalJobUsage(results, theme)}`;
	for (const [index, result] of results.entries()) {
		const items = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", `Job ${index + 1}`)}${renderJobModel(result.model, theme)} ${renderJobStatusIcon(result.status, theme)}${renderJobUsage(result, theme)}`;
		if (items.length === 0) {
			const empty =
				result.status === "running" || result.status === "queued" ? `(${result.status}...)` : "(no output)";
			text += `\n${theme.fg("muted", empty)}`;
		} else text += `\n${renderJobDisplayItems(items, expanded, theme, 5)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallelJobs(results: JobResult[], expanded: boolean, theme: Theme): Text | Container {
	const counts = countJobStatuses(results);
	const icon =
		counts.active > 0
			? theme.fg("warning", "[running]")
			: counts.failed > 0
				? theme.fg("warning", "[partial]")
				: theme.fg("success", "[done]");
	const status = parallelJobStatus(counts, results.length);
	return expanded && counts.active === 0
		? renderExpandedParallelJobs(results, icon, status, theme)
		: renderCollapsedParallelJobs(results, expanded, icon, status, theme);
}

function renderJobFallback(result: AgentToolResult<JobDetails>): Text {
	const content = result.content[0];
	return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
}

function renderJobResult(result: AgentToolResult<JobDetails>, expanded: boolean, theme: Theme): Text | Container {
	const details = result.details;
	if (!details || details.results.length === 0) return renderJobFallback(result);
	if (details.mode === "single" && details.results.length === 1) {
		return renderSingleJobResult(details.results[0], expanded, theme);
	}
	if (details.mode === "chain") return renderJobChain(details.results, expanded, theme);
	if (details.mode === "parallel") return renderParallelJobs(details.results, expanded, theme);
	return renderJobFallback(result);
}

export function createJobToolDefinition(
	options: JobToolOptions = {},
): ToolDefinition<typeof jobParamsSchema, JobDetails> {
	const runner = options.runner;
	return {
		name: "job",
		label: "Job",
		description:
			"Delegate a bounded job to an isolated session. Specify the outcome; intermediate steps needn't enter the parent conversation, but its result does.",
		promptSnippet: "Delegate a bounded job to an isolated session",
		parameters: jobParamsSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const selection = selectJobMode(params);
			const workspaceOperations = ctx.toolOperations;
			const makeDetails = createJobDetailsFactory();
			if (!workspaceOperations) {
				return {
					content: [{ type: "text", text: "Jobs require explicit workspace tool operations." }],
					details: makeDetails(selection.mode)([]),
					isError: true,
				};
			}
			const backendInfo = workspaceOperations.getBackendInfo?.();
			if (backendInfo?.type === "remote" && !backendInfo.configured) {
				return {
					content: [{ type: "text", text: "Jobs cannot run with an unconfigured remote backend." }],
					details: makeDetails(selection.mode)([]),
					isError: true,
				};
			}
			const validationError = validateJobRequest(selection, makeDetails);
			if (validationError) return validationError;
			if (!runner) {
				return {
					content: [{ type: "text", text: "Job runner is not configured for this session." }],
					details: makeDetails(selection.mode)([]),
					isError: true,
				};
			}
			const model =
				options.getConfiguredModel?.()?.trim() ||
				process.env.GRIP_DEFAULT_JOB_MODEL?.trim() ||
				inheritedJobModelName(ctx.model);
			return executeSelectedJobMode(params, selection, {
				workspaceCwd: workspaceOperations.cwd ?? ctx.cwd,
				workspaceOperations,
				model,
				runner,
				signal,
				onUpdate,
				makeDetails,
			});
		},

		renderCall(args, theme, _context) {
			if (args.chain && args.chain.length > 0) return renderJobChainCall(args, theme);
			if (args.tasks && args.tasks.length > 0) return renderParallelJobCall(args, theme);
			return renderSingleJobCall(args, theme);
		},

		renderResult(result, { expanded }, theme, _context) {
			return renderJobResult(result, expanded, theme);
		},
	};
}
export function createJobTool(options?: JobToolOptions): AgentTool<typeof jobParamsSchema, JobDetails> {
	return wrapToolDefinition(createJobToolDefinition(options));
}
