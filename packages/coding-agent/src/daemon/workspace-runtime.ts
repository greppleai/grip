import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir as fsMkdir, link, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@greppleai/grip-agent-core";
import {
	hashRemoteWorkspaceJson,
	type RemoteWorkspaceCapability,
	type RemoteWorkspaceCatalog,
	type RemoteWorkspaceIdentity,
	type RemoteWorkspaceMethod,
	type RemoteWorkspaceOperationKind,
} from "../core/remote-workspace-protocol/contract.ts";
import {
	RemoteWorkspaceRequestError,
	type RemoteWorkspaceServerHandler,
	type RemoteWorkspaceServerRequestContext,
	type RemoteWorkspaceTypedRequest,
} from "../core/remote-workspace-protocol/session.ts";
import { withFileMutationQueue } from "../core/tools/file-mutation-queue.ts";
import {
	GRIP_SESSION_ENVIRONMENT_NAMES,
	LocalToolOperations,
	type ToolAccessMode,
	type ToolBackendInfo,
	type ToolExecOptions,
	type ToolExecResult,
	type ToolFileStat,
	type ToolGlobOptions,
	type ToolGrepMatch,
	type ToolGrepOptions,
	type ToolGrepResult,
	type ToolMkdirOptions,
	type ToolOperations,
	type WorkspaceToolExecutionOptions,
} from "../core/tools/operations.ts";
import { WorkspaceToolHost, type WorkspaceToolName } from "../core/tools/workspace-tool-host.ts";
import { getToolPath } from "../utils/tools-manager.ts";
import type { DaemonConfiguration } from "./config.ts";

const PRIMITIVE_OPERATIONS: RemoteWorkspaceMethod[] = [
	"workspace.access",
	"workspace.read",
	"workspace.write",
	"workspace.mkdir",
	"workspace.stat",
	"workspace.readdir",
	"workspace.glob",
	"workspace.grep",
	"workspace.detect_image_mime",
	"workspace.exec",
];

const SECRET_ENVIRONMENT_SUFFIX = /_(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS)$/iu;
const BASELINE_ENVIRONMENT =
	process.platform === "win32"
		? ["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "USER", "USERNAME"]
		: ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "COLORTERM", "NO_COLOR", "TMPDIR"];

function isSecretEnvironmentName(name: string): boolean {
	const upper = name.toUpperCase();
	return (
		upper === "GRIP_DAEMON_TOKEN" ||
		upper === "PI_DAEMON_TOKEN" ||
		upper === "GRIP_REMOTE_TOKEN" ||
		upper.startsWith("GRIP_DAEMON_TLS_") ||
		upper.startsWith("PI_DAEMON_TLS_") ||
		SECRET_ENVIRONMENT_SUFFIX.test(upper)
	);
}
process.platform === "win32"
	? ["PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP"]
	: ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function portableToolResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	const clone = JSON.parse(JSON.stringify(result)) as AgentToolResult<unknown>;
	const details = clone.details;
	if (!details || typeof details !== "object" || !("fullOutputPath" in details)) return clone;
	const fullOutputPath = (details as { fullOutputPath?: unknown }).fullOutputPath;
	if (typeof fullOutputPath !== "string") return clone;
	delete (details as { fullOutputPath?: unknown }).fullOutputPath;
	for (const content of clone.content) {
		if (content.type === "text") {
			content.text = content.text.replaceAll(fullOutputPath, "[remote full output is not transferable]");
		}
	}
	return clone;
}

function operationKind(name: string): RemoteWorkspaceOperationKind {
	switch (name) {
		case "read":
		case "read_image":
		case "grep":
		case "find":
		case "ls":
			return "read";
		case "edit":
		case "write":
			return "mutation";
		case "bash":
			return "process";
	}
	throw new Error(`Unknown daemon tool: ${name}`);
}

function runCommand(
	command: string,
	args: string[],
	environment: NodeJS.ProcessEnv,
	maxBufferedBytes: number,
): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: environment });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bufferedBytes = 0;
		let settled = false;
		const append = (target: Buffer[], chunk: Buffer) => {
			if (settled) return;
			bufferedBytes += chunk.byteLength;
			if (bufferedBytes > maxBufferedBytes) {
				settled = true;
				child.kill();
				reject(new Error(`${command} output exceeded the daemon buffered-output limit`));
				return;
			}
			target.push(Buffer.from(chunk));
		};
		child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0 || (command === "rg" && code === 1)) {
				resolvePromise(Buffer.concat(stdout));
				return;
			}
			reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with code ${code}`));
		});
	});
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nestedText(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const nested = record?.[key];
	return isUnknownRecord(nested) && typeof nested.text === "string" ? nested.text : undefined;
}

function parseDaemonGrepMatch(line: string): ToolGrepMatch | undefined {
	if (!line) return undefined;
	let event: unknown;
	try {
		event = JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
	const eventRecord = isUnknownRecord(event) ? event : undefined;
	if (eventRecord?.type !== "match") return undefined;
	const data = isUnknownRecord(eventRecord.data) ? eventRecord.data : undefined;
	const filePath = nestedText(data, "path");
	const lineNumber = data?.line_number;
	if (!filePath || typeof lineNumber !== "number") return undefined;
	const lineText = nestedText(data, "lines");
	return { filePath, lineNumber, ...(lineText === undefined ? {} : { lineText }) };
}

export class ConfinedDaemonToolOperations implements ToolOperations {
	readonly cwd: string;
	private readonly local: LocalToolOperations;
	private readonly allowedRoots: readonly string[];
	private readonly allowFullFilesystem: boolean;
	private readonly allowProcessExec: boolean;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly maxBufferedOutputBytes: number;

	constructor(configuration: DaemonConfiguration) {
		this.cwd = configuration.workspaceRoot;
		this.local = new LocalToolOperations(this.cwd);
		this.allowedRoots = Object.freeze([
			this.cwd,
			...(configuration.temporaryRoot ? [configuration.temporaryRoot] : []),
		]);
		this.allowProcessExec = configuration.allowProcessExec;
		this.maxBufferedOutputBytes = configuration.maxBufferedOutputBytes;
		const localeNames = Object.keys(process.env).filter((name) => /^LC_/iu.test(name));
		const names = new Set([...BASELINE_ENVIRONMENT, ...localeNames, ...configuration.forwardedEnvironment]);
		this.environment = {};
		for (const name of names) {
			if (isSecretEnvironmentName(name)) continue;
			const value = process.env[name];
			if (value !== undefined) this.environment[name] = value;
		}
		this.allowFullFilesystem = configuration.allowFullFilesystem;
	}

	createChildEnvironment(extra: Record<string, string> = {}): Record<string, string> {
		const environment: Record<string, string> = {};
		for (const [name, value] of Object.entries(this.environment)) {
			if (value !== undefined) environment[name] = value;
		}
		Object.assign(environment, extra);
		for (const name of Object.keys(environment)) {
			if (isSecretEnvironmentName(name)) delete environment[name];
		}
		return environment;
	}
	private isWithinAllowedRoot(candidate: string, root: string): boolean {
		const pathRelative = relative(root, candidate);
		return pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative);
	}

	private lexicalPath(path: string): string {
		const candidate = resolve(this.cwd, path);
		if (!this.allowFullFilesystem && !this.allowedRoots.some((root) => this.isWithinAllowedRoot(candidate, root))) {
			throw new Error(`Path escapes the daemon workspace and allowed temporary root: ${path}`);
		}
		return candidate;
	}

	private async existingPath(path: string): Promise<string> {
		const candidate = this.lexicalPath(path);
		const canonical = await realpath(candidate);
		return this.lexicalPath(canonical);
	}
	async resolveWorkingDirectory(path: string): Promise<string> {
		const directory = await this.existingPath(path);
		if (!this.isWithinAllowedRoot(directory, this.cwd)) {
			throw new Error(`Working directory is outside the mounted workspace: ${path}`);
		}
		if (!(await lstat(directory)).isDirectory()) throw new Error(`Not a directory: ${path}`);
		return directory;
	}

	private async existingWritablePath(candidate: string, path: string): Promise<string | undefined> {
		try {
			const stat = await lstat(candidate);
			if (stat.isSymbolicLink()) {
				try {
					this.lexicalPath(await realpath(candidate));
				} catch (error) {
					if (isMissingPath(error)) throw new Error(`Writable path uses a broken symbolic link: ${path}`);
					throw error;
				}
				throw new Error(`Writable path uses a symbolic link: ${path}`);
			}
			const canonical = await realpath(candidate);
			this.lexicalPath(canonical);
			return this.lexicalPath(canonical);
		} catch (error) {
			if (isMissingPath(error)) return undefined;
			throw error;
		}
	}

	private async ensureConfinedWritableParent(candidate: string, path: string): Promise<void> {
		let parent = resolve(candidate, "..");
		while (true) {
			try {
				const parentStat = await lstat(parent);
				if (parentStat.isSymbolicLink()) {
					this.lexicalPath(await realpath(parent));
					if (!this.allowFullFilesystem) throw new Error(`Writable parent uses a symbolic link: ${path}`);
					return;
				}
				const canonicalParent = await realpath(parent);
				this.lexicalPath(canonicalParent);
				return;
			} catch (error) {
				if (!isMissingPath(error)) throw error;
				const next = resolve(parent, "..");
				if (next === parent) throw new Error(`No confined parent exists for path: ${path}`);
				parent = next;
			}
		}
	}

	private async writablePath(path: string): Promise<string> {
		const candidate = this.lexicalPath(path);
		const existing = await this.existingWritablePath(candidate, path);
		if (existing) return existing;
		await this.ensureConfinedWritableParent(candidate, path);
		return candidate;
	}

	private async atomicWriteFile(path: string, content: string | Buffer, overwrite = true): Promise<void> {
		const target = await this.writablePath(path);
		const parent = resolve(target, "..");
		const temporary = resolve(parent, `.grip-remote-write-${process.pid}-${randomUUID()}-${basename(target)}.tmp`);
		this.lexicalPath(temporary);
		let wroteTemporary = false;
		try {
			const handle = await open(temporary, "wx", 0o600);
			wroteTemporary = true;
			try {
				await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
			} finally {
				await handle.close();
			}
			this.lexicalPath(await realpath(temporary));
			try {
				if ((await lstat(target)).isSymbolicLink()) throw new Error(`Writable path uses a symbolic link: ${path}`);
			} catch (error) {
				if (!isMissingPath(error)) throw error;
			}
			if (overwrite) {
				await rename(temporary, target);
				wroteTemporary = false;
			} else {
				await link(temporary, target);
				await rm(temporary, { force: true });
				wroteTemporary = false;
			}
			this.lexicalPath(await realpath(target));
		} finally {
			if (wroteTemporary) await rm(temporary, { force: true });
		}
	}

	async exec(command: string, options: ToolExecOptions): Promise<ToolExecResult> {
		if (!this.allowProcessExec) throw new Error("Process execution is disabled by daemon policy");
		const cwd = await this.existingPath(options.cwd ?? this.cwd);
		const environment = { ...this.environment };
		for (const name of GRIP_SESSION_ENVIRONMENT_NAMES) {
			const value = options.env?.[name];
			if (value !== undefined) environment[name] = value;
		}
		return this.local.exec(command, { ...options, cwd, env: environment });
	}

	async writeUpload(path: string, content: Buffer, overwrite: boolean): Promise<void> {
		await this.atomicWriteFile(path, content, overwrite);
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await this.local.access(await this.existingPath(path), mode);
	}

	async readFile(path: string): Promise<Buffer> {
		return this.local.readFile(await this.existingPath(path));
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await this.atomicWriteFile(path, content);
	}

	async mkdir(path: string, options?: ToolMkdirOptions): Promise<void> {
		if (this.allowFullFilesystem && options?.recursive) {
			try {
				if ((await lstat(await this.existingPath(path))).isDirectory()) return;
			} catch (error) {
				if (!isMissingPath(error)) throw error;
			}
		}
		await fsMkdir(await this.writablePath(path), options);
	}

	async stat(path: string): Promise<ToolFileStat> {
		return this.local.stat(await this.existingPath(path));
	}

	async readdir(path: string): Promise<string[]> {
		return this.local.readdir(await this.existingPath(path));
	}

	async glob(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]> {
		const searchRoot = await this.existingPath(cwd);
		const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(options.limit)];
		for (const ignored of options.ignore) args.push("--exclude", ignored);
		let effectivePattern = pattern;
		if (pattern.includes("/")) {
			args.push("--full-path");
			if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**")
				effectivePattern = `**/${pattern}`;
		}
		args.push("--", effectivePattern, searchRoot);
		const fd = getToolPath("fd");
		if (!fd) throw new Error("fd is not available; install fd (or fdfind) and ensure it is on PATH");
		const output = await runCommand(fd, args, this.environment, this.maxBufferedOutputBytes);
		const results: string[] = [];
		for (const entry of output.toString("utf8").split("\n")) {
			if (!entry) continue;
			try {
				results.push(await this.existingPath(entry));
			} catch {
				// Symlinks escaping the workspace are deliberately omitted.
			}
		}
		return results;
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		const searchPath = await this.existingPath(options.path);
		const isDirectory = (await this.local.stat(searchPath)).isDirectory();
		const args = ["--json", "--line-number", "--color=never", "--hidden"];
		if (options.ignoreCase) args.push("--ignore-case");
		if (options.literal) args.push("--fixed-strings");
		if (options.glob) args.push("--glob", options.glob);
		args.push("--", options.pattern, searchPath);
		const rg = getToolPath("rg");
		if (!rg) throw new Error("rg is not available; install ripgrep and ensure it is on PATH");
		const output = await runCommand(rg, args, this.environment, this.maxBufferedOutputBytes);
		const matches: ToolGrepMatch[] = [];
		for (const line of output.toString("utf8").split("\n")) {
			if (matches.length >= options.limit) continue;
			const match = parseDaemonGrepMatch(line);
			if (!match) continue;
			try {
				await this.existingPath(match.filePath);
			} catch {
				continue;
			}
			matches.push(match);
		}
		return { isDirectory, matches };
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		return this.local.detectImageMimeType(await this.existingPath(path));
	}

	getBackendInfo(): ToolBackendInfo {
		return { type: "local", cwd: this.cwd };
	}
}

export interface DaemonWorkspaceRuntime {
	readonly operations: ConfinedDaemonToolOperations;
	readonly host: WorkspaceToolHost;
	readonly catalog: RemoteWorkspaceCatalog;
	readonly capabilities: readonly RemoteWorkspaceCapability[];
	createHandler(workspace: RemoteWorkspaceIdentity, sharedMode?: boolean): RemoteWorkspaceServerHandler;
	retire(): Promise<void>;
	dispose(): Promise<void>;
}

type DaemonRequestInterruptionCode = "cancelled" | "deadline_exceeded";
type DaemonInterruptedExecutionState = "not_started" | "indeterminate";

function requestError(code: DaemonRequestInterruptionCode, message: string, state: DaemonInterruptedExecutionState) {
	return new RemoteWorkspaceRequestError({ code, message, executionState: state, retryable: false });
}
interface DaemonRequestRuntime {
	configuration: DaemonConfiguration;
	operations: ConfinedDaemonToolOperations;
	host: WorkspaceToolHost;
	workspace: RemoteWorkspaceIdentity;
	sharedMode: boolean;
}

function withDaemonWorkspace<T extends Record<string, unknown>>(result: T, workspace: RemoteWorkspaceIdentity) {
	return { ...result, workspace };
}

function marksToolSideEffect(kind: RemoteWorkspaceOperationKind, toolName: string, sharedMode: boolean): boolean {
	return kind !== "read" && !(sharedMode && (toolName === "edit" || toolName === "write"));
}

async function resolveDaemonToolExecutionOptions(
	options: WorkspaceToolExecutionOptions,
	runtime: DaemonRequestRuntime,
): Promise<WorkspaceToolExecutionOptions> {
	if (!options.cwd) return options;
	const cwd = await runtime.operations.resolveWorkingDirectory(options.cwd);
	return { ...options, cwd };
}

async function invokeDaemonTool(
	request: RemoteWorkspaceTypedRequest,
	params: Record<string, unknown>,
	context: RemoteWorkspaceServerRequestContext,
	runtime: DaemonRequestRuntime,
): Promise<AgentToolResult<unknown>> {
	const toolName = params.toolName as string;
	const kind = operationKind(toolName);
	if (marksToolSideEffect(kind, toolName, runtime.sharedMode)) context.markSideEffectStarted();
	let updateQueue = Promise.resolve();
	try {
		const executionOptions = await resolveDaemonToolExecutionOptions(
			params.executionOptions as WorkspaceToolExecutionOptions,
			runtime,
		);
		const result = await runtime.host.executePrepared(toolName, {
			toolCallId: request.id,
			arguments: params.arguments,
			signal: context.signal,
			executionOptions,
			onUpdate: (update) => {
				updateQueue = updateQueue.then(() => context.sendUpdate(portableToolResult(update)));
			},
		});
		await updateQueue;
		if (kind !== "read") context.markCommitted();
		return portableToolResult(result);
	} catch (error) {
		await updateQueue.catch(() => undefined);
		if (context.signal.aborted) {
			throw requestError(
				"cancelled",
				"Remote workspace tool invocation was cancelled",
				kind === "read" ? "not_started" : "indeterminate",
			);
		}
		if (error instanceof RemoteWorkspaceRequestError) throw error;
		throw new RemoteWorkspaceRequestError({
			code: "internal_error",
			message: error instanceof Error ? error.message.slice(0, 4096) : "Workspace tool failed",
			executionState: kind === "read" ? "not_started" : "indeterminate",
			retryable: false,
		});
	}
}

async function executeDaemonWorkspaceProcess(
	params: Record<string, unknown>,
	context: RemoteWorkspaceServerRequestContext,
	runtime: DaemonRequestRuntime,
): Promise<ToolExecResult> {
	context.markSideEffectStarted();
	let updateQueue = Promise.resolve();
	let pendingOutputBytes = 0;
	let outputLimitExceeded = false;
	const outputController = new AbortController();
	const signal = AbortSignal.any([context.signal, outputController.signal]);
	let result: ToolExecResult;
	try {
		result = await runtime.operations.exec(params.command as string, {
			cwd: params.cwd as string,
			signal,
			onData: (data) => {
				if (outputLimitExceeded) return;
				const chunk = Buffer.from(data);
				pendingOutputBytes += chunk.byteLength;
				if (pendingOutputBytes > runtime.configuration.maxBufferedOutputBytes) {
					outputLimitExceeded = true;
					outputController.abort();
					return;
				}
				updateQueue = updateQueue
					.then(() => context.sendUpdate({ dataBase64: chunk.toString("base64") }))
					.finally(() => {
						pendingOutputBytes -= chunk.byteLength;
					});
				// The process may run after an update fails; observe rejection until the final await.
				void updateQueue.catch(() => undefined);
			},
		});
	} catch (error) {
		if (outputLimitExceeded) throw new Error("Process output exceeded the daemon buffered-output limit");
		throw error;
	}
	await updateQueue;
	context.markCommitted();
	return result;
}

async function readDaemonResource(
	params: Record<string, unknown>,
	runtime: DaemonRequestRuntime,
): Promise<Record<string, unknown>> {
	const path = params.path as string;
	const resourcePath =
		path === "SANDBOX.md"
			? runtime.configuration.sandboxInstructionsPath
			: path === "AGENTS.md"
				? runtime.configuration.userAgentsPath
				: undefined;
	if (!resourcePath) {
		throw new RemoteWorkspaceRequestError({
			code: "not_available",
			message: "Requested daemon resource is not available",
			executionState: "not_started",
			retryable: false,
		});
	}
	return withDaemonWorkspace({ contentBase64: (await readFile(resourcePath)).toString("base64") }, runtime.workspace);
}

async function statDaemonWorkspace(
	path: string,
	runtime: DaemonRequestRuntime,
	workspaceOnly = false,
): Promise<unknown> {
	if (workspaceOnly) {
		const canonicalPath = await runtime.operations.resolveWorkingDirectory(path);
		return withDaemonWorkspace({ kind: "directory", canonicalPath }, runtime.workspace);
	}
	try {
		const value = await runtime.operations.stat(path);
		return withDaemonWorkspace(
			{ kind: value.isDirectory() ? "directory" : value.isFile() ? "file" : "other" },
			runtime.workspace,
		);
	} catch (error) {
		if (!runtime.sharedMode || !isMissingPath(error)) throw error;
		return withDaemonWorkspace({ kind: "absent" }, runtime.workspace);
	}
}

async function dispatchDaemonWorkspaceRequest(
	request: RemoteWorkspaceTypedRequest,
	context: RemoteWorkspaceServerRequestContext,
	runtime: DaemonRequestRuntime,
): Promise<unknown> {
	const params = request.params as Record<string, unknown>;
	switch (request.method) {
		case "tool.invoke":
			return invokeDaemonTool(request, params, context, runtime);
		case "workspace.access":
			await runtime.operations.access(params.path as string, params.mode as ToolAccessMode | undefined);
			return {};
		case "workspace.read":
			return withDaemonWorkspace(
				{ contentBase64: (await runtime.operations.readFile(params.path as string)).toString("base64") },
				runtime.workspace,
			);
		case "workspace.write":
			if (!runtime.sharedMode) context.markSideEffectStarted();
			await withFileMutationQueue(resolve(runtime.configuration.workspaceRoot, params.path as string), () =>
				runtime.operations.writeFile(params.path as string, Buffer.from(params.contentBase64 as string, "base64")),
			);
			context.markCommitted();
			return {};
		case "workspace.mkdir":
			if (!runtime.sharedMode) context.markSideEffectStarted();
			await withFileMutationQueue(resolve(runtime.configuration.workspaceRoot, params.path as string), () => {
				if (runtime.sharedMode) {
					if (context.signal.aborted)
						throw requestError(
							"cancelled",
							"Shared directory creation was cancelled before starting",
							"not_started",
						);
					context.markSideEffectStarted();
				}
				return runtime.operations.mkdir(params.path as string, { recursive: params.recursive === true });
			});
			context.markCommitted();
			return {};
		case "workspace.stat":
			return statDaemonWorkspace(params.path as string, runtime, params.workspaceOnly === true);
		case "workspace.readdir":
			return withDaemonWorkspace(
				{ entries: await runtime.operations.readdir(params.path as string) },
				runtime.workspace,
			);
		case "workspace.glob":
			return withDaemonWorkspace(
				{
					matches: await runtime.operations.glob(params.pattern as string, params.cwd as string, {
						ignore: params.ignore as string[],
						limit: params.limit as number,
					}),
				},
				runtime.workspace,
			);
		case "workspace.grep": {
			const result = await runtime.operations.grep(params as unknown as ToolGrepOptions);
			return withDaemonWorkspace(result as unknown as Record<string, unknown>, runtime.workspace);
		}
		case "workspace.detect_image_mime":
			return withDaemonWorkspace(
				{ mimeType: (await runtime.operations.detectImageMimeType(params.path as string)) ?? null },
				runtime.workspace,
			);
		case "workspace.exec":
			return executeDaemonWorkspaceProcess(params, context, runtime);
		case "resource.read":
			return readDaemonResource(params, runtime);
		default:
			throw new RemoteWorkspaceRequestError({
				code: "method_not_supported",
				message: `Workspace operation is not implemented: ${request.method}`,
				executionState: "not_started",
				retryable: false,
			});
	}
}

export function createDaemonWorkspaceRuntime(configuration: DaemonConfiguration): DaemonWorkspaceRuntime {
	const operations = new ConfinedDaemonToolOperations(configuration);
	const toolNames: WorkspaceToolName[] = ["read", "read_image", "edit", "write", "grep", "find", "ls"];
	if (configuration.allowProcessExec) toolNames.splice(2, 0, "bash");
	const host = new WorkspaceToolHost({
		cwd: configuration.workspaceRoot,
		operations,
		toolNames,
		disposeTimeoutMs: Math.min(configuration.shutdownTimeoutMs, 60_000),
	});
	const catalog: RemoteWorkspaceCatalog = {
		generation: 1,
		tools: host.getCatalog().map((entry) => ({
			name: entry.name,
			executionMode: operationKind(entry.name),
			parameterSchema: structuredClone(entry.parameters) as Record<string, unknown>,
			schemaHash: hashRemoteWorkspaceJson(entry.parameters),
			featureFlags: [],
		})),
		operations: [
			...PRIMITIVE_OPERATIONS.filter((method) => method !== "workspace.exec" || configuration.allowProcessExec),
			...(configuration.sandboxInstructionsPath || configuration.userAgentsPath ? (["resource.read"] as const) : []),
			"transfer.upload",
		],
	};
	const capabilities: RemoteWorkspaceCapability[] = [
		"catalog_refresh",
		"primitive_operations",
		"tool_updates",
		"file_transfer",
	];
	let activeRequests = 0;

	return {
		operations,
		host,
		catalog,
		capabilities,
		createHandler(workspace, sharedMode = false) {
			const uploads = new Map<
				RemoteWorkspaceServerRequestContext,
				{
					buffer: Buffer;
					offset: number;
					resolve: (value: unknown) => void;
					reject: (error: Error) => void;
				}
			>();
			const requestRuntime: DaemonRequestRuntime = {
				configuration,
				operations,
				host,
				workspace,
				sharedMode,
			};
			async function handleUpload(
				request: RemoteWorkspaceTypedRequest,
				context: RemoteWorkspaceServerRequestContext,
			) {
				if (sharedMode)
					throw new RemoteWorkspaceRequestError({
						code: "invalid_request",
						message: "Shared uploads are disabled until revision-safe commit is supported",
						executionState: "not_started",
						retryable: false,
					});
				const params = request.params as { path: string; length: number; sha256: string; overwrite: boolean };
				// Bound per-transfer allocation independently of peer-negotiated limits.
				if (
					params.length >
					Math.min(configuration.maxBufferedOutputBytes, configuration.protocolLimits.maxTransferBytes)
				) {
					throw new RemoteWorkspaceRequestError({
						code: "limit_exceeded",
						message: "Upload exceeds daemon memory limit",
						executionState: "not_started",
						retryable: false,
					});
				}
				let abort = () => {};
				try {
					return await new Promise((resolve, reject) => {
						const state = { buffer: Buffer.alloc(params.length), offset: 0, resolve, reject };
						uploads.set(context, state);
						abort = () => reject(requestError("cancelled", "Upload cancelled", "not_started"));
						context.signal.addEventListener("abort", abort, { once: true });
						if (context.signal.aborted) abort();
					});
				} finally {
					context.signal.removeEventListener("abort", abort);
					uploads.delete(context);
				}
			}
			return {
				validateToolArguments: (toolName, value) => host.validatePreparedArguments(toolName, value),
				async handleRequest(request, context) {
					if (activeRequests >= configuration.maxGlobalRequests) {
						throw new RemoteWorkspaceRequestError({
							code: "limit_exceeded",
							message: "Daemon global active request limit reached",
							executionState: "not_started",
							retryable: true,
						});
					}
					activeRequests++;
					try {
						if (request.method === "transfer.upload") {
							return await handleUpload(request, context);
						}
						return await dispatchDaemonWorkspaceRequest(request, context, requestRuntime);
					} finally {
						activeRequests--;
					}
				},
				async handleUploadChunk(_request, chunk, _sequence, context) {
					const state = uploads.get(context);
					if (!state || context.signal.aborted) throw new Error("Upload is no longer active");
					if (state.offset + chunk.length > state.buffer.length) throw new Error("Upload exceeds declared length");
					chunk.copy(state.buffer, state.offset);
					state.offset += chunk.length;
				},
				async handleUploadFinish(request, metadata, context) {
					if (sharedMode) throw new Error("Shared uploads are disabled");
					const state = uploads.get(context);
					if (!state || context.signal.aborted || state.offset !== state.buffer.length)
						throw new Error("Upload is no longer active");
					const params = request.params as { path: string; overwrite: boolean };
					try {
						await withFileMutationQueue(resolve(configuration.workspaceRoot, params.path), async () => {
							if (context.signal.aborted) throw requestError("cancelled", "Upload cancelled", "not_started");
							context.markSideEffectStarted();
							await operations.writeUpload(params.path, state.buffer, params.overwrite);
							context.markCommitted();
						});
					} catch (error) {
						state.reject(error instanceof Error ? error : new Error(String(error)));
						throw error;
					}
					// Let the protocol mark its verified incoming transfer finished first.
					setImmediate(() => state.resolve(metadata));
				},
			};
		},
		retire: async () => {
			await host.waitForIdle(configuration.shutdownTimeoutMs);
			await host.dispose();
		},
		dispose: async () => {
			await host.dispose();
		},
	};
}
