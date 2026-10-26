import type { AgentTool, AgentToolResult } from "@greppleai/grip-agent-core";
import { Container, Text, truncateToWidth } from "@greppleai/grip-tui";
import { type Static, Type } from "typebox";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { getShellEnv } from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	GRIP_SESSION_ENVIRONMENT_NAMES,
	type GripSessionEnvironment,
	LocalToolOperations,
	type ToolBackendInfo,
	type ToolOperations,
} from "./operations.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { formatBackendIcon, getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	host: Type.Optional(
		Type.Boolean({
			description:
				"Run on the host instead of the active tool backend; requires a mapped sandbox and fresh user approval",
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				"Required with host: true: explain why host execution is necessary and its side effects (unverified agent text)",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional; host commands default to 120 seconds)" }),
	),
	output_mode: Type.Optional(
		Type.Union([Type.Literal("always"), Type.Literal("on_fail"), Type.Literal("never")], {
			description:
				"Output sent to the model for ordinary (non-host) commands: on_fail (recommended for pass/fail checks) includes stdout/stderr only if the command fails; always (runtime default) includes it on success and failure; never omits it even on failure. The UI and session history retain ordinary command output. Host output is withheld regardless of this setting.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Create tool operations using grip's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want grip's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export interface LocalBashOperationsOptions {
	cwd?: string;
	shellPath?: string;
}

export function createLocalBashOperations(options?: LocalBashOperationsOptions): ToolOperations {
	return new LocalToolOperations(options?.cwd ?? process.cwd(), { shellPath: options?.shellPath });
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export type BashSessionEnvironment = GripSessionEnvironment;

export function getBashSessionEnvironment(ctx: ExtensionContext | undefined): BashSessionEnvironment {
	if (!ctx?.session) return {};
	const environment: BashSessionEnvironment = {
		GRIP_SESSION_ID: ctx.session.getSessionId(),
	};
	if (ctx.thinkingLevel) environment.GRIP_REASONING_LEVEL = ctx.thinkingLevel;
	const sessionFile = ctx.session.getSessionReference();
	if (sessionFile) environment.GRIP_SESSION_FILE = sessionFile;
	if (ctx.model) {
		environment.GRIP_PROVIDER = ctx.model.provider;
		environment.GRIP_MODEL = ctx.model.id;
	}
	return environment;
}

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	for (const name of GRIP_SESSION_ENVIRONMENT_NAMES) delete env[name];
	if (exposeSessionEnvironment) Object.assign(env, getBashSessionEnvironment(ctx));
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Expose current grip session metadata as GRIP_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBackendSuffix(backendInfo: ToolBackendInfo | undefined): string {
	if (!backendInfo) return "";
	if (backendInfo.type === "local") return theme.fg("muted", ` [local ${backendInfo.cwd}]`);
	return backendInfo.configured
		? theme.fg("muted", ` [remote ${backendInfo.url}:${backendInfo.cwd}]`)
		: theme.fg("warning", ` [remote not configured ${backendInfo.cwd}]`);
}

function formatBashCall(args: Partial<BashToolInput> | undefined, backendInfo?: ToolBackendInfo): string {
	const command = str(args?.command);
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return (
		formatBackendIcon(backendInfo, theme) +
		(args?.host ? theme.fg("warning", "[host] ") : "") +
		theme.fg("toolTitle", theme.bold("$ ")) +
		theme.fg("accent", theme.bold(commandDisplay))
	);
}

function getBashDisplayOutput(
	result: AgentToolResult<BashToolDetails | undefined>,
	showImages: boolean,
	isPartial: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (isPartial || !truncation?.truncated || !fullOutputPath || !output.endsWith("]")) return output;
	const footerStart = output.lastIndexOf("\n\n[");
	if (footerStart === -1 || !output.slice(footerStart).includes(fullOutputPath)) return output;
	return output.slice(0, footerStart).trimEnd();
}

function addBashOutput(
	component: BashResultRenderComponent,
	state: BashResultRenderState,
	output: string,
	options: ToolRenderResultOptions,
): void {
	if (!output) return;
	const styledOutput = output
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	if (options.expanded) {
		component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		return;
	}
	component.addChild({
		render: (width: number) => {
			if (state.cachedLines === undefined || state.cachedWidth !== width) {
				const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
				state.cachedLines = preview.visualLines;
				state.cachedSkipped = preview.skippedCount;
				state.cachedWidth = width;
			}
			return ["", ...(state.cachedLines ?? [])];
		},
		invalidate: () => {
			state.cachedWidth = undefined;
			state.cachedLines = undefined;
			state.cachedSkipped = undefined;
		},
	});
}

function addBashOutputWarnings(
	component: BashResultRenderComponent,
	truncation: TruncationResult | undefined,
	fullOutputPath: string | undefined,
): void {
	if (!truncation?.truncated && !fullOutputPath) return;
	const warnings: string[] = [];
	if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
	if (truncation?.truncated) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
		} else {
			warnings.push(
				`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
			);
		}
	}
	component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: AgentToolResult<BashToolDetails | undefined>,
	options: ToolRenderResultOptions,
	isError: boolean,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
	backendInfo: ToolBackendInfo | undefined,
	bashArgs: Partial<BashToolInput> | undefined,
): void {
	const state = component.state;
	component.clear();
	const output = getBashDisplayOutput(result, showImages, options.isPartial);
	addBashOutput(component, state, output, options);
	addBashOutputWarnings(component, result.details?.truncation, result.details?.fullOutputPath);
	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(
			new Text(
				`\n${theme.fg(options.isPartial ? "muted" : isError ? "error" : "success", `${label} ${formatDuration(endTime - startedAt)}`)}${bashArgs?.timeout !== undefined ? theme.fg("muted", ` (timeout ${bashArgs.timeout}s)`) : ""}${formatBackendSuffix(backendInfo)}`,
				0,
				0,
			),
		);
	}
	component.addChild({
		render: (width) => {
			if (width < 1) return [];
			let hint = theme.fg("muted", `model output: ${bashArgs?.output_mode ?? "always"}`);
			if (!options.expanded && output && state.cachedSkipped) {
				const expandKey = keyText("app.tools.expand");
				hint +=
					theme.fg("dim", " · ") +
					theme.fg("warning", `${state.cachedSkipped} lines hidden`) +
					(expandKey ? theme.fg("accent", ` · ${expandKey} to expand`) : "");
			}
			return ["", truncateToWidth(hint, width, "...")];
		},
		invalidate: () => {},
	});
}

function appendBashStatus(text: string, status: string): string {
	return `${text ? `${text}\n\n` : ""}${status}`;
}

function throwBashExecutionError(error: unknown, outputText: string): never {
	if (error instanceof Error && error.message === "aborted") {
		throw new Error(appendBashStatus(outputText, "Command aborted"));
	}
	if (error instanceof Error && error.message.startsWith("timeout:")) {
		const timeoutSeconds = error.message.split(":")[1];
		throw new Error(appendBashStatus(outputText, `Command timed out after ${timeoutSeconds} seconds`));
	}
	throw error;
}

async function executeApprovedHostBash(
	command: string,
	description: string | undefined,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AgentToolResult<BashToolDetails | undefined>> {
	if (typeof description !== "string" || !description.trim()) {
		throw new Error("Host bash requires a non-empty description of purpose and side effects");
	}
	if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
		throw new Error("Host bash requires a non-empty command");
	}
	if (!ctx?.isSandbox()) throw new Error("Host bash requires an active Grip sandbox");
	const result = await ctx.execHostCommand(command, {
		question: `Run this shell command on the host? Unverified agent description: ${description}`,
		signal,
		approvalTimeoutMs: 60_000,
		timeout: timeout ?? 120,
	});
	// Host stdout/stderr may contain secrets. Never stream them to the model or
	// persist them in the tool result (including the host-side fullOutputPath).
	if ((result.cancelled || result.exitCode !== 0) && ctx.hasUI && result.output.trim()) {
		ctx.ui.notify(`Host command output:\n${result.output.trim()}`, "error");
	}
	if (result.cancelled) throw new Error("Host command was cancelled or timed out; output withheld");
	if (result.exitCode !== 0) {
		throw new Error(`Host command failed (exit code ${result.exitCode ?? "unknown"}); output withheld`);
	}
	return { content: [{ type: "text", text: "Host command succeeded; output withheld" }], details: undefined };
}

export type BashToolDefinition = ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState>;

export function createBashToolDefinition(operations: ToolOperations, options?: BashToolOptions): BashToolDefinition {
	const ops = operations;
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the active tool backend. Set host: true ONLY if the user specifically requests host execution: this requires a non-empty description, a mapped Grip sandbox, and fresh user approval (60-second deadline). Host output is withheld from model results. For ordinary commands the model receives stdout and stderr by default; output_mode can omit them from model context while retaining UI and session output. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: [
			"For Bash tests, builds, linters, and other pass/fail checks, explicitly set output_mode: on_fail when the exit status is sufficient on success; failure output remains visible. Use always (the runtime default) when successful output or warnings must be inspected, including project-required full logs. Do not use always merely to report passing-test counts. Use never only if even failure output is unnecessary.",
			"Use bash with host: true only when the user specifically requests execution on the host. Supply a non-empty description explaining why host access is needed and the side effects. Review the exact command and mapped host cwd in the mandatory per-call approval; never use host: true as a fallback when sandbox commands fail. Host output is withheld from the model regardless of output_mode.",
		],
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout, host, description }: BashToolInput,
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			if (host === true) return executeApprovedHostBash(command, description, timeout, signal, ctx);
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, ops.cwd, spawnHook, exposeSessionEnvironment, ctx);
			const output = new OutputAccumulator({ tempFilePrefix: "grip-bash" });
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: OutputSnapshot, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, {
						cwd: spawnContext.cwd,
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					throwBashExecutionError(err, text);
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendBashStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args, ops.getBackendInfo?.()));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.isError,
				context.showImages,
				state.startedAt,
				state.endedAt,
				ops.getBackendInfo?.(),
				context.args as Partial<BashToolInput> | undefined,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(operations: ToolOperations, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(operations, options));
}
