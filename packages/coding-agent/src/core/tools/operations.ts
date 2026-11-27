import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream, type Stats, type WriteStream } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	realpath as fsRealpath,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@greppleai/grip-agent-core";
import WebSocket, { type RawData } from "ws";
import { DAEMON_WEBSOCKET_PROTOCOL } from "../../daemon/config.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";

import type { PortablePathFlavor } from "../portable-path.ts";
import {
	DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
	decodeCanonicalBase64,
	hashRemoteWorkspaceJson,
	parseRemoteWorkspaceToolResult,
	type RemoteWorkspaceClientMessage,
	type RemoteWorkspaceMethod,
} from "../remote-workspace-protocol/contract.ts";
import { GuestSharedClientTransport } from "../remote-workspace-protocol/guest-shared-client.ts";
import {
	RemoteWorkspaceClientProtocol,
	RemoteWorkspaceDisconnectedError,
	type RemoteWorkspaceProtocolCloseReason,
	RemoteWorkspaceRequestError,
	RemoteWorkspaceTerminationError,
	RemoteWorkspaceTransportError,
} from "../remote-workspace-protocol/session.ts";
import type { WorkspaceIdentity } from "../workspace-identity.ts";

export type ToolAccessMode = "exists" | "read" | "write" | "readwrite";
export type WorkspaceToolExecutionTarget = "local" | "remote" | "unavailable";
export type RemoteWorkspaceToolExecutionTarget = Exclude<WorkspaceToolExecutionTarget, "local">;
type RemoteToolTransportProtocol = "ws";

export interface ToolFileStat {
	isDirectory: () => boolean;
	isFile: () => boolean;
}

export interface ToolExecOptions {
	cwd?: string;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

export interface ToolExecResult {
	exitCode: number | null;
}

export interface ToolMkdirOptions {
	recursive?: boolean;
}

export interface ToolGlobOptions {
	ignore: string[];
	limit: number;
}

export interface ToolGrepOptions {
	pattern: string;
	path: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	limit: number;
}

export interface ToolGrepMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

export interface ToolGrepResult {
	isDirectory: boolean;
	matches: ToolGrepMatch[];
}

export type ToolBackendInfo =
	| { type: "local"; cwd: string }
	| { type: "remote"; cwd: string; configured: false }
	| {
			type: "remote";
			cwd: string;
			url: string;
			protocol: "ws";
			configured: true;
			workspace: WorkspaceIdentity;
	  };

// grip-ignore noNearIdenticalDataStructures: Remote backend invocations require host-normalized execution options, while public host invocations accept omitted options and apply defaults.
export interface WorkspaceToolRemoteInvocation {
	toolCallId: string;
	arguments: unknown;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	executionOptions: WorkspaceToolExecutionOptions;
}

export interface GripSessionEnvironment {
	GRIP_SESSION_ID?: string;
	GRIP_SESSION_FILE?: string;
	GRIP_PROVIDER?: string;
	GRIP_MODEL?: string;
	GRIP_REASONING_LEVEL?: string;
}

export const GRIP_SESSION_ENVIRONMENT_NAMES = Object.freeze([
	"GRIP_SESSION_ID",
	"GRIP_SESSION_FILE",
	"GRIP_PROVIDER",
	"GRIP_MODEL",
	"GRIP_REASONING_LEVEL",
] as const);

export interface WorkspaceToolExecutionOptions {
	imageAutoResize?: boolean;
	shellCommandPrefix?: string;
	sessionEnvironment?: GripSessionEnvironment;
	/** Per-invocation guest working directory; the daemon workspace root remains unchanged. */
	cwd?: string;
}

interface NormalizedRemoteWorkspaceUrl {
	url: string;
	protocol: "ws";
}

export interface DeferredRemoteToolOperationsConnectOptions extends RemoteToolOperationsConnectOptions {
	expectedCwd?: string;
	/** Known host mount source; only supplied for a sandbox started by this Grip process. */
	hostWorkspaceRoot?: string;
}

type SharedExpectedRevision = { sha256: string } | { absent: true };

export type BorrowedToolOperations = Omit<ToolOperations, "dispose">;

export function borrowToolOperations(operations: ToolOperations): BorrowedToolOperations {
	const boundMethods = new Map<PropertyKey, unknown>();
	return new Proxy(operations, {
		get(target, property, receiver) {
			if (property === "dispose") return undefined;
			const value = Reflect.get(target, property, receiver) as unknown;
			if (typeof value !== "function") return value;
			let bound = boundMethods.get(property);
			if (!bound) {
				bound = value.bind(target);
				boundMethods.set(property, bound);
			}
			return bound;
		},
		has(target, property) {
			return property === "dispose" ? false : Reflect.has(target, property);
		},
	}) as BorrowedToolOperations;
}

export interface ToolOperations {
	cwd: string;
	exec(command: string, options: ToolExecOptions): Promise<ToolExecResult>;
	access(path: string, mode?: ToolAccessMode): Promise<void>;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string | Buffer): Promise<void>;
	/** Backend-owned disposable storage, when supported and allowed by backend policy. */
	getTemporaryDirectory?(): Promise<string>;
	readResource?(path: string): Promise<Buffer>;
	uploadFile?(sourcePath: string, destinationPath: string): Promise<void>;
	downloadFile?(sourcePath: string, destinationPath: string): Promise<void>;
	mkdir(path: string, options?: ToolMkdirOptions): Promise<void>;
	stat(path: string): Promise<ToolFileStat>;
	readdir(path: string): Promise<string[]>;
	glob?(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]>;
	grep?(options: ToolGrepOptions): Promise<ToolGrepResult>;
	detectImageMimeType?(path: string): Promise<string | null | undefined>;
	/** Map an existing guest workspace directory to its verified host mount counterpart, when known. */
	mapWorkspaceDirectoryToHost?(guestPath: string): Promise<string>;
	getBackendInfo?(): ToolBackendInfo;
	resolveWorkspaceToolExecution?(name: string, parameterSchema: unknown): WorkspaceToolExecutionTarget;
	executeWorkspaceTool?(name: string, invocation: WorkspaceToolRemoteInvocation): Promise<AgentToolResult<unknown>>;
	onWorkspaceToolCatalogChanged?(listener: () => void | Promise<void>): () => void;
	dispose?(): Promise<void>;
}

export interface LocalToolOperationsOptions {
	shellPath?: string;
}

function workspaceRootsEqual(left: string, right: string, pathFlavor: PortablePathFlavor): boolean {
	if (pathFlavor === "windows") return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
	return posix.normalize(left) === posix.normalize(right);
}

function accessModeToFsMode(mode: ToolAccessMode | undefined): number {
	switch (mode) {
		case "read":
			return constants.R_OK;
		case "write":
			return constants.W_OK;
		case "readwrite":
			return constants.R_OK | constants.W_OK;
		case "exists":
		case undefined:
			return constants.F_OK;
	}
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

// Cancellation signals the detached group; completion is reported only after bounded cleanup.

function terminateLingeringProcessGroup(child: ChildProcess): void {
	if (!child.pid || process.platform === "win32") return;
	try {
		process.kill(-child.pid, 0);
		killProcessTree(child.pid);
	} catch {}
}

function processGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function signalProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function stopChildExecution(child: ChildProcess, result: Promise<number | null>): Promise<void> {
	const pid = child.pid;
	if (!pid) return;
	let exited = false;
	void result.then(
		() => {
			exited = true;
		},
		() => {
			exited = true;
		},
	);
	const windows = process.platform === "win32";
	if (windows) {
		// Kill the tree while taskkill can still find its parent. Shell exit alone proves nothing.
		await new Promise<void>((resolve, reject) => {
			execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 5000, windowsHide: true }, (error) => {
				if (error) {
					reject(
						new RemoteWorkspaceTerminationError("Windows subprocess tree termination could not be confirmed"),
					);
				} else resolve();
			});
		});
	} else {
		signalProcessGroup(pid);
	}
	// Fixed grace and forced-exit budgets, independent of output/progress.
	for (const forced of windows ? [false] : [false, true]) {
		if (forced) killProcessTree(pid);
		const deadline = performance.now() + 5000;
		while (performance.now() < deadline) {
			if (exited && (windows || !processGroupAlive(pid))) return;
			await delay(50);
		}
	}
	throw new RemoteWorkspaceTerminationError("Subprocess termination could not be confirmed");
}

async function copyFileStream(sourcePath: string, destinationPath: string): Promise<void> {
	await pipeline(createReadStream(sourcePath), createWriteStream(destinationPath));
}

function writeStreamChunk(stream: WriteStream, chunk: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			stream.off("error", onError);
			reject(error);
		};
		stream.once("error", onError);
		stream.write(chunk, (error) => {
			stream.off("error", onError);
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function endWriteStream(stream: WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			stream.off("error", onError);
			reject(error);
		};
		stream.once("error", onError);
		stream.end(() => {
			stream.off("error", onError);
			resolve();
		});
	});
}

export class LocalToolOperations implements ToolOperations {
	cwd: string;
	private shellPath: string | undefined;

	constructor(cwd: string, options: LocalToolOperationsOptions = {}) {
		this.cwd = cwd;
		this.shellPath = options.shellPath;
	}

	setShellPath(shellPath: string | undefined): void {
		this.shellPath = shellPath;
	}

	async exec(command: string, options: ToolExecOptions): Promise<ToolExecResult> {
		const timeoutMs = resolveTimeoutMs(options.timeout);
		const cwd = options.cwd ?? this.cwd;
		const { shell, args } = getShellConfig(this.shellPath);
		try {
			await fsAccess(cwd, constants.F_OK);
		} catch {
			throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
		}
		if (options.signal?.aborted) throw new Error("aborted");
		const child = spawn(shell, [...args, command], {
			cwd,
			detached: process.platform !== "win32",
			env: options.env ?? getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid) trackDetachedChildPid(child.pid);
		child.stdout?.on("data", options.onData);
		child.stderr?.on("data", options.onData);
		const result = waitForChildProcess(child);
		let termination: Promise<void> | null = null;
		let rejectTermination: (error: unknown) => void = () => undefined;
		const failure = new Promise<never>((_resolve, reject) => {
			rejectTermination = reject;
		});
		const stop = () => {
			termination ??= stopChildExecution(child, result);
			void termination.catch(rejectTermination);
		};
		let timedOut = false;
		const timeoutHandle =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						stop();
					}, timeoutMs);
		options.signal?.addEventListener("abort", stop, { once: true });
		if (options.signal?.aborted) stop();
		try {
			const code = await Promise.race([result, failure]);
			if (termination) await termination;
			else terminateLingeringProcessGroup(child);
			if (options.signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${options.timeout}`);
			return { exitCode: code };
		} finally {
			clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", stop);
			child.stdout?.off("data", options.onData);
			child.stderr?.off("data", options.onData);
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (child.pid && (child.exitCode !== null || child.signalCode !== null)) untrackDetachedChildPid(child.pid);
		}
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await fsAccess(path, accessModeToFsMode(mode));
	}

	async readFile(path: string): Promise<Buffer> {
		return fsReadFile(path);
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await fsWriteFile(path, content, typeof content === "string" ? "utf-8" : undefined);
	}

	async getTemporaryDirectory(): Promise<string> {
		return tmpdir();
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		await copyFileStream(sourcePath, destinationPath);
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		await copyFileStream(sourcePath, destinationPath);
	}

	async mkdir(path: string, options: ToolMkdirOptions = {}): Promise<void> {
		await fsMkdir(path, { recursive: options.recursive ?? false });
	}

	async stat(path: string): Promise<Stats> {
		return fsStat(path);
	}

	async readdir(path: string): Promise<string[]> {
		return fsReaddir(path);
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		return detectSupportedImageMimeTypeFromFile(path);
	}

	getBackendInfo(): ToolBackendInfo {
		return { type: "local", cwd: this.cwd };
	}
}

/** Bound local attachment work even when a filesystem operation or observer ignores cancellation. */
function awaitRemoteWork<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(new Error("Remote workspace attachment cancelled"));
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
		void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

export type RemoteWorkspaceConnectionStatus = "detached" | "connected" | "reconnecting" | "recovered" | "exhausted";
export type RemoteWorkspaceReconnectMode = "reset" | "if-disconnected";

export interface RemoteWorkspaceConnectionState {
	status: RemoteWorkspaceConnectionStatus;
	attempt: number;
	message: string;
}

export class DeferredRemoteToolOperations implements ToolOperations {
	cwd: string;
	private readonly expectedCwd: string;
	private workspaceRoot: string;
	private operations: RemoteToolOperations | undefined;
	private hostWorkspaceRoot: string | undefined;
	private remoteCatalogUnsubscribe: (() => void) | undefined;
	private readonly catalogListeners = new Set<() => void | Promise<void>>();
	private disposePromise: Promise<void> | undefined;
	private readonly onDisconnect: ((message: string) => void) | undefined;
	connectionState: RemoteWorkspaceConnectionState = {
		status: "detached",
		attempt: 0,
		message: "Remote workspace detached",
	};
	private connectionGeneration = 0;
	private reconnectController: AbortController | null = null;
	private attachmentController: AbortController | null = null;
	private recovery: Promise<void> | null = null;
	private reconnectFactory: ((signal: AbortSignal) => Promise<ToolBackendInfo>) | null = null;

	constructor(cwd: string, onDisconnect?: (message: string) => void) {
		this.cwd = cwd;
		this.expectedCwd = cwd;
		this.workspaceRoot = cwd;
		this.onDisconnect = onDisconnect;
	}

	async configureRemote(
		url: string,
		options: DeferredRemoteToolOperationsConnectOptions = {},
	): Promise<ToolBackendInfo> {
		this.cancelReconnect();
		const generation = this.connectionGeneration;
		const controller = new AbortController();
		this.attachmentController = controller;
		const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		const timer = setTimeout(() => controller.abort(), 45_000);
		const saved = { ...options, token: options.token ?? process.env.GRIP_REMOTE_TOKEN };
		try {
			const info = await this.connectRemote(url, { ...saved, signal }, generation, null);
			if (generation !== this.connectionGeneration || signal.aborted || this.disposePromise) {
				throw new Error("Remote workspace attachment cancelled");
			}
			this.reconnectFactory = (signal) => this.connectRemote(url, { ...saved, signal }, generation, info);
			this.connectionState = { status: "connected", attempt: 0, message: "Remote workspace connected" };
			return info;
		} finally {
			clearTimeout(timer);
			if (this.attachmentController === controller) this.attachmentController = null;
		}
	}

	private async connectRemote(
		url: string,
		options: DeferredRemoteToolOperationsConnectOptions,
		generation: number,
		expected: ToolBackendInfo | null,
	): Promise<ToolBackendInfo> {
		let attached: RemoteToolOperations | undefined;
		const next = await awaitRemoteWork(
			createRemoteToolOperations(url, {
				...options,
				onDisconnect: (message) => {
					if (attached && this.operations === attached && generation === this.connectionGeneration)
						this.connectionLost(message);
				},
			}).then((created) => {
				if (generation !== this.connectionGeneration || options.signal?.aborted || this.disposePromise) {
					void created.dispose().catch(() => undefined);
					throw new Error("Remote workspace attachment cancelled");
				}
				return created;
			}),
			options.signal,
		);
		attached = next;
		try {
			const actual = next.getBackendInfo();
			this.verifyIdentity(actual, expected);
			const expectedCwd = options.expectedCwd ?? this.expectedCwd;
			await awaitRemoteWork(this.verifyAttachment(next, expectedCwd, options), options.signal);
			const hostRoot = options.hostWorkspaceRoot
				? await awaitRemoteWork(fsRealpath(options.hostWorkspaceRoot), options.signal)
				: undefined;
			const cwd = expected ? this.cwd : expectedCwd;
			if (cwd !== expectedCwd) {
				const directory = await awaitRemoteWork(
					next.resolveWorkspaceDirectory(cwd, options.signal),
					options.signal,
				);
				if (!workspaceRootsEqual(directory, cwd, next.workspacePathFlavor)) {
					throw new Error("Remote workspace directory changed; explicit attachment required");
				}
			}
			if (generation !== this.connectionGeneration || options.signal?.aborted || this.disposePromise) {
				throw new Error("Remote workspace attachment cancelled");
			}
			if (next.isDisconnected()) throw new RemoteWorkspaceTransportError("Remote workspace lost during attachment");
			if (this.operations) next.restoreToolSchemas(this.operations);
			this.replaceOperations(next);
			this.cwd = cwd;
			this.workspaceRoot = expectedCwd;
			this.hostWorkspaceRoot = hostRoot;
			return actual;
		} catch (error) {
			void next.dispose().catch(() => undefined);
			throw error;
		}
	}

	private verifyIdentity(actual: ToolBackendInfo, expected: ToolBackendInfo | null): void {
		if (expected?.type !== "remote" || !expected.configured || actual.type !== "remote" || !actual.configured) return;
		if (
			actual.workspace.id !== expected.workspace.id ||
			actual.workspace.root !== expected.workspace.root ||
			actual.workspace.pathFlavor !== expected.workspace.pathFlavor
		) {
			throw new Error("Remote workspace identity changed; explicit attachment required");
		}
	}

	private async verifyAttachment(
		next: RemoteToolOperations,
		expectedCwd: string,
		options: DeferredRemoteToolOperationsConnectOptions,
	): Promise<void> {
		await next.verifyWorkspace(options.signal);
		if (workspaceRootsEqual(next.cwd, expectedCwd, next.workspacePathFlavor)) return;
		const paths = next.workspacePathFlavor === "windows" ? win32 : posix;
		const suffix = paths.relative(next.cwd, expectedCwd);
		if (
			!options.hostWorkspaceRoot ||
			!paths.isAbsolute(expectedCwd) ||
			suffix === ".." ||
			suffix.startsWith(`..${paths.sep}`) ||
			paths.isAbsolute(suffix)
		) {
			throw new Error("Remote daemon workspace root mismatch");
		}
		const directory = await next.resolveWorkspaceDirectory(expectedCwd, options.signal);
		if (!workspaceRootsEqual(directory, expectedCwd, next.workspacePathFlavor)) {
			throw new Error("Remote workspace directory mismatch");
		}
	}

	async reconnect(mode: RemoteWorkspaceReconnectMode): Promise<void> {
		const generation = this.connectionGeneration;
		if (!this.recovery) {
			if (mode === "if-disconnected" && !this.isDisconnected()) return;
			this.startReconnect(mode === "reset" ? "Sandbox connection reset requested" : "Sandbox connection lost");
		}
		await this.recovery;
		if (generation !== this.connectionGeneration || !this.reconnectFactory) {
			throw new RemoteWorkspaceDisconnectedError("Sandbox reconnection cancelled", "not_started");
		}
		if (this.isDisconnected()) {
			throw new RemoteWorkspaceDisconnectedError(this.connectionState.message, "not_started");
		}
	}

	private connectionLost(message: string): void {
		if (this.startReconnect(message)) this.onDisconnect?.(message);
	}

	private startReconnect(message: string): boolean {
		if (this.recovery || !this.reconnectFactory || this.disposePromise) return false;
		const controller = new AbortController();
		this.reconnectController = controller;
		this.connectionState = {
			status: "reconnecting",
			attempt: 0,
			message: "Remote workspace reconnecting; interrupted operations are not replayed",
		};
		// Publish the loop before invoking observers: concurrent failures must join it.
		this.recovery = Promise.resolve()
			.then(() => this.reconnectLoop(controller, message))
			.finally(() => {
				if (this.reconnectController === controller) {
					this.reconnectController = null;
					this.recovery = null;
				}
			});
		return true;
	}

	private async reconnectLoop(controller: AbortController, cause: string): Promise<void> {
		const timer = setTimeout(() => controller.abort(), 45_000);
		try {
			for (let attempt = 1; attempt <= 4; attempt++) {
				try {
					controller.signal.throwIfAborted();
					this.connectionState = { status: "reconnecting", attempt, message: "Remote workspace reconnecting" };
					await delay(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5), undefined, {
						signal: controller.signal,
					});
					await awaitRemoteWork(this.reconnectFactory!(controller.signal), controller.signal);
					if (controller.signal.aborted || this.reconnectController !== controller) return;
					await awaitRemoteWork(this.notifyCatalogListeners(), controller.signal);
					if (controller.signal.aborted || this.reconnectController !== controller) return;
					if (this.operations?.isDisconnected())
						throw new RemoteWorkspaceTransportError("Recovered connection lost");
					this.connectionState = {
						status: "recovered",
						attempt,
						message: "Remote workspace recovered; submit a new prompt",
					};
					return;
				} catch (error) {
					if (this.reconnectFailed(controller, cause, attempt, error)) return;
				}
			}
		} finally {
			clearTimeout(timer);
		}
	}

	private reconnectFailed(controller: AbortController, cause: string, attempt: number, error: unknown): boolean {
		if (this.reconnectController !== controller) return true;
		const retryable =
			error instanceof RemoteWorkspaceTransportError || error instanceof RemoteWorkspaceDisconnectedError;
		if (!controller.signal.aborted && retryable && attempt < 4) return false;
		const outcome = controller.signal.aborted ? "budget exhausted" : "failed";
		const detail = error instanceof Error ? error.message : "unknown failure";
		this.connectionState = { status: "exhausted", attempt, message: `${cause}; reconnection ${outcome}: ${detail}` };
		void this.operations?.dispose().catch(() => undefined);
		return true;
	}

	private cancelReconnect(): void {
		this.connectionGeneration++;
		this.attachmentController?.abort();
		this.attachmentController = null;
		this.reconnectController?.abort();
		this.reconnectController = null;
		this.recovery = null;
		this.reconnectFactory = null;
		this.connectionState = { status: "detached", attempt: 0, message: "Remote workspace detached" };
	}

	private async retryRead<T>(operation: (operations: RemoteToolOperations) => Promise<T>): Promise<T> {
		const generation = this.connectionGeneration;
		const previous = this.requireOperations();
		try {
			return await operation(previous);
		} catch (error) {
			if (!(error instanceof RemoteWorkspaceDisconnectedError) || !this.recovery) throw error;
			await this.recovery;
			if (generation !== this.connectionGeneration || this.isDisconnected() || this.operations === previous)
				throw error;
			return operation(this.requireOperations()); // One retry, only for explicitly listed pure reads.
		}
	}

	async clear(): Promise<void> {
		this.cancelReconnect();
		const previous = this.operations;
		this.remoteCatalogUnsubscribe?.();
		this.remoteCatalogUnsubscribe = undefined;
		this.operations = undefined;
		this.hostWorkspaceRoot = undefined;
		await previous?.dispose?.();
	}

	private requireOperations(): RemoteToolOperations {
		if (this.connectionState.status === "exhausted") {
			throw new RemoteWorkspaceDisconnectedError(this.connectionState.message, "not_started");
		}
		if (!this.operations) {
			throw new Error(
				"Remote backend is not configured. Configure it over RPC or with /sandbox before using tools.",
			);
		}
		return this.operations;
	}

	async exec(command: string, options: ToolExecOptions): Promise<ToolExecResult> {
		return this.requireOperations().exec(command, { ...options, cwd: options.cwd ?? this.cwd });
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await this.retryRead((operations) => operations.access(path, mode));
	}

	async readFile(path: string): Promise<Buffer> {
		return this.retryRead((operations) => operations.readFile(path));
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await this.requireOperations().writeFile(path, content);
	}

	async getTemporaryDirectory(): Promise<string> {
		return this.requireOperations().getTemporaryDirectory();
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		const operations = this.requireOperations();
		if (!operations.uploadFile) throw new Error("Remote backend does not support file upload");
		await operations.uploadFile(sourcePath, destinationPath);
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		const operations = this.requireOperations();
		if (!operations.downloadFile) throw new Error("Remote backend does not support file download");
		await operations.downloadFile(sourcePath, destinationPath);
	}

	async mkdir(path: string, options?: ToolMkdirOptions): Promise<void> {
		await this.requireOperations().mkdir(path, options);
	}

	async stat(path: string): Promise<ToolFileStat> {
		return this.retryRead((operations) => operations.stat(path));
	}

	async resolveWorkspaceDirectory(path: string): Promise<string> {
		return this.requireOperations().resolveWorkspaceDirectory(path);
	}

	async mapWorkspaceDirectoryToHost(guestPath: string): Promise<string> {
		const remote = this.requireOperations();
		const hostRoot = this.hostWorkspaceRoot;
		if (!hostRoot || remote.workspacePathFlavor !== "posix") {
			throw new Error("No verified host mount mapping is available for this sandbox");
		}
		const canonicalGuest = await remote.resolveWorkspaceDirectory(posix.resolve(this.cwd, guestPath));
		const suffix = posix.relative(this.workspaceRoot, canonicalGuest);
		if (suffix === ".." || suffix.startsWith("../") || posix.isAbsolute(suffix)) {
			throw new Error("Guest directory is outside the mounted workspace");
		}
		const hostPath = await fsRealpath(resolve(hostRoot, suffix));
		const hostRelative = relative(hostRoot, hostPath);
		if (hostRelative === ".." || hostRelative.startsWith(`..${sep}`) || isAbsolute(hostRelative)) {
			throw new Error("Host directory escapes the mounted workspace");
		}
		if (!(await fsStat(hostPath)).isDirectory()) throw new Error("Host working directory is not a directory");
		return hostPath;
	}

	async readdir(path: string): Promise<string[]> {
		return this.retryRead((operations) => operations.readdir(path));
	}

	async glob(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]> {
		return this.retryRead((operations) => operations.glob(pattern, cwd, options));
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		return this.retryRead((operations) => operations.grep(options));
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		return this.retryRead((operations) => operations.detectImageMimeType(path));
	}

	getBackendInfo(): ToolBackendInfo {
		const info = this.operations?.getBackendInfo();
		if (info?.type !== "remote" || !info.configured) return { type: "remote", cwd: this.cwd, configured: false };
		return { ...info, cwd: this.workspaceRoot, workspace: { ...info.workspace, root: this.workspaceRoot } };
	}

	isDisconnected(): boolean {
		return (
			this.connectionState.status === "reconnecting" ||
			this.connectionState.status === "exhausted" ||
			(this.operations?.isDisconnected() ?? false)
		);
	}

	resolveWorkspaceToolExecution(name: string, parameterSchema: unknown): RemoteWorkspaceToolExecutionTarget {
		return this.operations ? this.operations.resolveWorkspaceToolExecution(name, parameterSchema) : "unavailable";
	}

	executeWorkspaceTool(name: string, invocation: WorkspaceToolRemoteInvocation): Promise<AgentToolResult<unknown>> {
		const operations = this.requireOperations();
		const executionOptions = { ...invocation.executionOptions };
		if (this.cwd !== operations.cwd) executionOptions.cwd = this.cwd;
		return operations.executeWorkspaceTool(name, { ...invocation, executionOptions });
	}

	onWorkspaceToolCatalogChanged(listener: () => void | Promise<void>): () => void {
		this.catalogListeners.add(listener);
		return () => this.catalogListeners.delete(listener);
	}

	dispose(): Promise<void> {
		this.cancelReconnect();
		this.disposePromise ??= (async () => {
			this.remoteCatalogUnsubscribe?.();
			this.remoteCatalogUnsubscribe = undefined;
			const previous = this.operations;
			this.operations = undefined;
			this.hostWorkspaceRoot = undefined;
			await previous?.dispose?.();
		})();
		return this.disposePromise;
	}

	private async notifyCatalogListeners(): Promise<void> {
		await Promise.all([...this.catalogListeners].map((listener) => listener()));
	}

	private replaceOperations(next: RemoteToolOperations): void {
		if (this.disposePromise) throw new Error("Deferred remote backend is disposed");
		const previous = this.operations;
		this.remoteCatalogUnsubscribe?.();
		this.remoteCatalogUnsubscribe = undefined;
		this.operations = next;
		this.remoteCatalogUnsubscribe = next.onWorkspaceToolCatalogChanged(() => {
			if (this.operations !== next) return;
			return this.notifyCatalogListeners();
		});
		// Retirement must not delay publication or let a stale continuation overwrite a newer attachment.
		void previous?.dispose().catch(() => undefined);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`Invalid remote workspace ${label}`);
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Invalid remote workspace ${label}`);
	return value;
}

function normalizeRemoteUrl(url: string): NormalizedRemoteWorkspaceUrl {
	const parsed = new URL(url);
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new Error(`--remote supports ws:// and wss:// URLs, got ${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) throw new Error("Remote workspace URLs must not contain credentials");
	if (parsed.hash) throw new Error("Remote workspace URLs must not contain fragments");
	return { url: parsed.toString(), protocol: "ws" };
}

function websocketPayload(data: RawData): Uint8Array {
	if (Buffer.isBuffer(data)) return Uint8Array.from(data);
	if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
	return Uint8Array.from(new Uint8Array(data));
}

function websocketCloseCode(reason: RemoteWorkspaceProtocolCloseReason): number {
	switch (reason.code) {
		case "normal":
			return 1000;
		case "protocol_error":
			return 1002;
		case "invalid_payload":
			return 1007;
		case "policy_violation":
			return 1008;
		case "message_too_large":
			return 1009;
	}
}

export interface RemoteToolOperationsConnectOptions {
	token?: string;
	handshakeTimeoutMs?: number;
	onDisconnect?: (message: string) => void;
	signal?: AbortSignal;
}

export class RemoteToolOperations implements ToolOperations {
	readonly url: string;
	readonly protocol: RemoteToolTransportProtocol;
	cwd: string;
	workspacePathFlavor: PortablePathFlavor = "posix";
	private workspaceId = "";
	private readonly socket: WebSocket | GuestSharedClientTransport;
	private readonly isShared: boolean;
	private readonly client: RemoteWorkspaceClientProtocol;
	private readonly localToolSchemas = new Map<string, string>();
	private readonly catalogListeners = new Set<() => void | Promise<void>>();
	private disconnected = false;
	private disposePromise: Promise<void> | undefined;

	private constructor(
		url: string,
		protocol: RemoteToolTransportProtocol,
		socket: WebSocket | GuestSharedClientTransport,
		options: RemoteToolOperationsConnectOptions,
	) {
		this.url = url;
		this.protocol = protocol;
		this.socket = socket;
		this.isShared = socket instanceof GuestSharedClientTransport;
		this.cwd = "/";
		const transport =
			socket instanceof GuestSharedClientTransport
				? socket
				: {
						send: (message: RemoteWorkspaceClientMessage): Promise<void> =>
							new Promise((resolve, reject) => {
								if (socket.readyState !== WebSocket.OPEN) {
									reject(new Error("Remote workspace connection is not open"));
									return;
								}
								socket.send(JSON.stringify(message), { binary: false, compress: false }, (error) => {
									if (error) reject(error);
									else resolve();
								});
							}),
						close: (reason: RemoteWorkspaceProtocolCloseReason): Promise<void> => {
							if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
							return new Promise((resolve) => {
								socket.once("close", () => resolve());
								socket.close(websocketCloseCode(reason), reason.message);
							});
						},
					};
		this.client = new RemoteWorkspaceClientProtocol(transport, {
			requiredCapabilities: ["primitive_operations", "tool_updates"],
			optionalCapabilities: this.isShared
				? ["catalog_refresh", "artifacts"]
				: ["catalog_refresh", "file_transfer", "artifacts"],
			receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			localToolSchemas: this.localToolSchemas,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			onDisconnect: (message) => {
				this.disconnected = true;
				options.onDisconnect?.(message);
			},
			onCatalogRefreshed: async () => {
				await Promise.all([...this.catalogListeners].map((listener) => listener()));
			},
		});
		if (socket instanceof GuestSharedClientTransport) {
			socket.bind(this.client);
		} else {
			socket.on("message", (data, isBinary) => {
				if (isBinary) {
					void this.client.disconnect("Remote workspace sent an unexpected binary frame");
					return;
				}
				void this.client.receive(websocketPayload(data)).catch(() => undefined);
			});
			socket.on("close", () => void this.client.disconnect("Remote workspace connection closed"));
			socket.on("error", () => void this.client.disconnect("Remote workspace connection failed"));
		}
	}

	static async connect(url: string, options: RemoteToolOperationsConnectOptions = {}): Promise<RemoteToolOperations> {
		const normalized = normalizeRemoteUrl(url);
		const token = options.token ?? process.env.GRIP_REMOTE_TOKEN;
		if (options.signal?.aborted) throw new Error("Remote workspace attachment cancelled");
		const socket = await new Promise<WebSocket>((resolve, reject) => {
			const websocket = new WebSocket(normalized.url, DAEMON_WEBSOCKET_PROTOCOL, {
				perMessageDeflate: false,
				headers: token ? { authorization: `Bearer ${token}` } : {},
			});
			const timer = setTimeout(
				() => fail(new RemoteWorkspaceTransportError("Remote workspace connection timed out")),
				options.handshakeTimeoutMs ?? 5000,
			);
			const cleanup = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", aborted);
				websocket.off("open", onOpen);
				websocket.off("error", onError);
				websocket.off("unexpected-response", onResponse);
			};
			const fail = (error: Error) => {
				cleanup();
				websocket.terminate();
				reject(error);
			};
			const aborted = () => fail(new Error("Remote workspace attachment cancelled"));
			const onOpen = () => {
				cleanup();
				resolve(websocket);
			};
			const onError = () => fail(new RemoteWorkspaceTransportError("Remote workspace connection failed"));
			const onResponse = (_request: unknown, response: IncomingMessage) => {
				response.resume();
				const status = response.statusCode;
				fail(
					status === 401 || status === 403
						? new Error("Remote workspace authentication rejected")
						: new Error("Remote workspace upgrade rejected"),
				);
			};
			websocket.on("error", () => undefined);
			websocket.once("open", onOpen);
			websocket.once("error", onError);
			websocket.once("unexpected-response", onResponse);
			options.signal?.addEventListener("abort", aborted, { once: true });
			if (options.signal?.aborted) aborted();
		});
		const operations = new RemoteToolOperations(normalized.url, normalized.protocol, socket, options);
		const aborted = () => socket.terminate();
		options.signal?.addEventListener("abort", aborted, { once: true });
		try {
			if (options.signal?.aborted) throw new Error("Remote workspace attachment cancelled");
			const handshake = await operations.client.start();
			operations.cwd = handshake.workspace.root;
			operations.workspacePathFlavor = handshake.workspace.pathFlavor;
			operations.workspaceId = handshake.workspace.id;
			return operations;
		} catch (error) {
			socket.terminate();
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", aborted);
		}
	}

	static async connectGuestShared(
		url: string,
		root: string,
		token: string,
		options: RemoteToolOperationsConnectOptions = {},
	): Promise<RemoteToolOperations> {
		const socket = await GuestSharedClientTransport.attach(url, root, token, options.signal);
		const operations = new RemoteToolOperations(url, "ws", socket, options);
		try {
			const handshake = await operations.client.start();
			if (!workspaceRootsEqual(handshake.workspace.root, root, handshake.workspace.pathFlavor)) {
				throw new Error("Guest shared workspace root differs from daemon handshake");
			}
			operations.cwd = handshake.workspace.root;
			operations.workspacePathFlavor = handshake.workspace.pathFlavor;
			operations.workspaceId = handshake.workspace.id;
			return operations;
		} catch (error) {
			await socket.close({ code: "normal", message: "Shared guest attach failed" });
			throw error;
		}
	}

	resolveWorkspaceToolExecution(name: string, parameterSchema: unknown): RemoteWorkspaceToolExecutionTarget {
		const schemaHash = hashRemoteWorkspaceJson(parameterSchema);
		const catalogTool = this.client.handshake?.catalog.tools.find((tool) => tool.name === name);
		if (!catalogTool) return "unavailable";
		if (catalogTool.schemaHash !== schemaHash) {
			throw new Error(`Remote tool schema does not match the local canonical definition: ${name}`);
		}
		this.localToolSchemas.set(name, schemaHash);
		this.client.setLocalToolSchemas(this.localToolSchemas);
		return "remote";
	}

	async executeWorkspaceTool(
		name: string,
		invocation: WorkspaceToolRemoteInvocation,
	): Promise<AgentToolResult<unknown>> {
		const invoke = async () => {
			await this.client.waitForCatalogRefresh();
			const handshake = this.client.handshake;
			if (!handshake) throw new Error("Remote workspace protocol handshake is unavailable");
			const catalogTool = handshake.catalog.tools.find((tool) => tool.name === name);
			const schemaHash = this.localToolSchemas.get(name);
			if (!catalogTool || !schemaHash || catalogTool.schemaHash !== schemaHash) {
				throw new Error(`Remote tool is unavailable or has schema drift: ${name}`);
			}
			const expectedRevision = await this.revisionForTool(name, invocation);
			const result = requireRecord(
				await this.client.request(
					"tool.invoke",
					{
						generation: handshake.catalog.generation,
						catalogHash: handshake.catalogHash,
						toolName: name,
						schemaHash,
						argumentsPrepared: true,
						arguments: invocation.arguments,
						...(expectedRevision ? { expectedRevision } : {}),
						executionOptions: invocation.executionOptions,
					},
					{
						signal: invocation.signal,
						onUpdate: invocation.onUpdate
							? (update) =>
									invocation.onUpdate!(parseRemoteWorkspaceToolResult(update) as AgentToolResult<unknown>)
							: undefined,
					},
				),
				"tool result",
			);
			const toolResult = result;
			if (!Array.isArray(toolResult.content)) throw new Error("Invalid remote workspace tool result content");
			return {
				content: toolResult.content as AgentToolResult<unknown>["content"],
				details: toolResult.details,
				...(typeof toolResult.terminate === "boolean" ? { terminate: toolResult.terminate } : {}),
			};
		};
		try {
			return await invoke();
		} catch (error) {
			if (
				error instanceof RemoteWorkspaceRequestError &&
				error.code === "stale_generation" &&
				error.executionState === "not_started"
			) {
				return invoke();
			}
			throw error;
		}
	}

	onWorkspaceToolCatalogChanged(listener: () => void | Promise<void>): () => void {
		this.catalogListeners.add(listener);
		return () => this.catalogListeners.delete(listener);
	}

	async verifyWorkspace(signal?: AbortSignal): Promise<void> {
		const result = requireRecord(
			await this.client.request("workspace.stat", { path: this.cwd }, { signal }),
			"workspace stat",
		);
		if (result.kind !== "directory") throw new Error("Remote workspace is not a directory");
	}

	restoreToolSchemas(previous: RemoteToolOperations): void {
		for (const [name, hash] of previous.localToolSchemas) this.localToolSchemas.set(name, hash);
		this.client.setLocalToolSchemas(this.localToolSchemas);
	}

	private request(method: RemoteWorkspaceMethod, params: unknown) {
		return this.client.request(method, params);
	}

	private async revisionForTool(
		name: string,
		invocation: WorkspaceToolRemoteInvocation,
	): Promise<SharedExpectedRevision | undefined> {
		if (!this.isShared || (name !== "edit" && name !== "write")) return undefined;
		const path = requireString(
			requireRecord(invocation.arguments, "shared mutation arguments").path,
			"shared mutation path",
		);
		const cwd = invocation.executionOptions.cwd;
		const target = cwd ? (this.workspacePathFlavor === "windows" ? win32 : posix).resolve(cwd, path) : path;
		return this.sharedExpectedRevision(target, invocation.signal, name === "write");
	}

	/** Observe exact bytes for CAS, or a daemon-confirmed absent target for creation. */
	private async sharedExpectedRevision(
		path: string,
		signal?: AbortSignal,
		allowAbsent = true,
	): Promise<SharedExpectedRevision> {
		let read: unknown;
		try {
			read = await this.client.request("workspace.read", { path }, { signal });
		} catch (error) {
			if (!allowAbsent) throw error;
			// Do not infer absence from an error message: only a v2 server stat of the
			// same workspace and path may establish the expected-absent precondition.
			const stat = requireRecord(
				await this.client.request("workspace.stat", { path }, { signal }),
				"shared stat result",
			);
			if (stat.kind !== "absent") throw error;
			return { absent: true };
		}
		const result = requireRecord(read, "shared read result");
		const content = decodeCanonicalBase64(
			requireString(result.contentBase64, "shared read content"),
			Number.MAX_SAFE_INTEGER,
		);
		const sha256 = createHash("sha256").update(content).digest("hex");
		if (result.revision !== sha256) throw new Error("Shared daemon did not confirm the observed file revision");
		return { sha256 };
	}
	async exec(command: string, options: ToolExecOptions): Promise<ToolExecResult> {
		const result = requireRecord(
			await this.client.request(
				"workspace.exec",
				{ command, cwd: options.cwd ?? this.cwd },
				{
					signal: options.signal,
					timeoutMs: options.timeout === undefined ? undefined : Math.round(options.timeout * 1000),
					onUpdate: (update) => {
						const record = requireRecord(update, "exec update");
						options.onData(
							decodeCanonicalBase64(requireString(record.dataBase64, "exec update data"), 1024 * 1024),
						);
					},
				},
			),
			"exec result",
		);
		return { exitCode: typeof result.exitCode === "number" ? result.exitCode : null };
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await this.request("workspace.access", { path, ...(mode ? { mode } : {}) });
	}

	async readFile(path: string): Promise<Buffer> {
		const result = requireRecord(await this.request("workspace.read", { path }), "read result");
		return decodeCanonicalBase64(requireString(result.contentBase64, "read content"), Number.MAX_SAFE_INTEGER);
	}

	async getTemporaryDirectory(): Promise<string> {
		const result = requireRecord(await this.request("workspace.tmpdir", {}), "temporary directory result");
		return requireString(result.path, "temporary directory path");
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		const bytes = Buffer.from(content);
		const limits = this.client.handshake?.limits ?? DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS;
		const base64Length = Math.ceil(bytes.byteLength / 3) * 4;
		// Reserve space for the request envelope, escaped path and shared revision.
		const envelopeBytes = Buffer.byteLength(JSON.stringify(path)) + 1024;
		if (base64Length > limits.maxStringBytes || base64Length + envelopeBytes > limits.maxMessageBytes) {
			// The upload protocol has no revision precondition. Never bypass shared CAS.
			if (this.isShared) throw new Error("Large shared writes require revision-aware upload support");
			await this.uploadBytes(path, bytes);
			return;
		}
		const expectedRevision = this.isShared ? await this.sharedExpectedRevision(path) : undefined;
		await this.request("workspace.write", {
			path,
			contentBase64: bytes.toString("base64"),
			...(expectedRevision ? { expectedRevision } : {}),
		});
	}

	async readResource(path: string): Promise<Buffer> {
		if (!this.client.handshake?.catalog.operations.includes("resource.read")) {
			throw new Error("Remote workspace does not expose resource reads");
		}
		const result = requireRecord(await this.request("resource.read", { path }), "resource read result");
		return decodeCanonicalBase64(
			requireString(result.contentBase64, "resource read content"),
			Number.MAX_SAFE_INTEGER,
		);
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		if (this.isShared) throw new Error("Shared guest file transfers are unavailable");
		await this.uploadBytes(destinationPath, await fsReadFile(sourcePath));
	}

	private async uploadBytes(destinationPath: string, content: Buffer): Promise<void> {
		const sha256 = createHash("sha256").update(content).digest("hex");
		const handle = this.client.beginRequest("transfer.upload", {
			path: destinationPath,
			length: content.byteLength,
			sha256,
			overwrite: true,
		});
		// Attach a rejection handler immediately: the server may reject while chunks are sent.
		void handle.result.catch(() => {});
		try {
			const chunkBytes = this.client.handshake?.limits.maxTransferChunkBytes ?? 64 * 1024;
			for (let offset = 0; offset < content.byteLength; offset += chunkBytes) {
				await handle.sendTransferChunk(content.subarray(offset, Math.min(offset + chunkBytes, content.byteLength)));
			}
			await handle.finishTransfer(content.byteLength, sha256);
		} catch (error) {
			await handle.cancel().catch(() => {});
			throw error;
		}
		await handle.result;
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		if (this.isShared) throw new Error("Shared guest file transfers are unavailable");
		const stream = createWriteStream(destinationPath);
		try {
			await this.client.request(
				"transfer.download",
				{ path: sourcePath },
				{
					onTransferChunk: (chunk) => writeStreamChunk(stream, chunk),
				},
			);
			await endWriteStream(stream);
		} catch (error) {
			stream.destroy();
			throw error;
		}
	}

	async mkdir(path: string, options: ToolMkdirOptions = {}): Promise<void> {
		await this.request("workspace.mkdir", { path, recursive: options.recursive ?? false });
	}

	async stat(path: string): Promise<ToolFileStat> {
		const result = requireRecord(await this.request("workspace.stat", { path }), "stat result");
		if (result.kind === "absent") throw new Error(`Remote workspace path does not exist: ${path}`);
		return {
			isDirectory: () => result.kind === "directory",
			isFile: () => result.kind === "file",
		};
	}

	async resolveWorkspaceDirectory(path: string, signal?: AbortSignal): Promise<string> {
		const result = requireRecord(
			await this.client.request("workspace.stat", { path, workspaceOnly: true }, { signal }),
			"workspace directory result",
		);
		if (result.kind !== "directory") throw new Error(`Not a workspace directory: ${path}`);
		return requireString(result.canonicalPath, "workspace directory canonical path");
	}

	async readdir(path: string): Promise<string[]> {
		const result = requireRecord(await this.request("workspace.readdir", { path }), "readdir result");
		if (!Array.isArray(result.entries) || !result.entries.every((entry) => typeof entry === "string")) {
			throw new Error("Invalid remote workspace readdir entries");
		}
		return result.entries;
	}

	async glob(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]> {
		const result = requireRecord(
			await this.request("workspace.glob", { pattern, cwd, ignore: options.ignore, limit: options.limit }),
			"glob result",
		);
		if (!Array.isArray(result.matches) || !result.matches.every((entry) => typeof entry === "string")) {
			throw new Error("Invalid remote workspace glob matches");
		}
		return result.matches;
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		const result = requireRecord(await this.request("workspace.grep", options), "grep result");
		if (!Array.isArray(result.matches)) throw new Error("Invalid remote workspace grep matches");
		return {
			isDirectory: result.isDirectory === true,
			matches: result.matches.map((entry) => {
				const match = requireRecord(entry, "grep match");
				return {
					filePath: requireString(match.filePath, "grep file path"),
					lineNumber: typeof match.lineNumber === "number" ? match.lineNumber : 0,
					...(typeof match.lineText === "string" ? { lineText: match.lineText } : {}),
				};
			}),
		};
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		const result = requireRecord(await this.request("workspace.detect_image_mime", { path }), "image MIME result");
		return typeof result.mimeType === "string" ? result.mimeType : null;
	}

	getBackendInfo(): ToolBackendInfo {
		return {
			type: "remote",
			cwd: this.cwd,
			url: this.url,
			protocol: this.protocol,
			configured: true,
			workspace: { id: this.workspaceId, root: this.cwd, pathFlavor: this.workspacePathFlavor },
		};
	}
	isDisconnected(): boolean {
		return this.disconnected;
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.client.close().catch(() => {
			if (this.socket instanceof WebSocket) this.socket.terminate();
		});
		return this.disposePromise;
	}
}

export function createRemoteToolOperations(
	url: string,
	options?: RemoteToolOperationsConnectOptions,
): Promise<RemoteToolOperations> {
	if (url.startsWith("grip+ws:")) {
		const parsed = new URL(url.replace(/^grip\+/, ""));
		const root = parsed.searchParams.get("root");
		if (!root || !posix.isAbsolute(root) || parsed.searchParams.size !== 1 || !options?.token) {
			return Promise.reject(new Error("Invalid guest shared workspace attachment"));
		}
		parsed.search = "";
		return RemoteToolOperations.connectGuestShared(parsed.toString(), root, options.token, options);
	}
	return RemoteToolOperations.connect(url, options);
}
