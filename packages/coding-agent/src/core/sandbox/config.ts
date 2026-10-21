import { createServer } from "node:net";
import type { SandboxSettings } from "../settings-manager.ts";

export const DEFAULT_SANDBOX_WORKSPACE_MOUNT = "/workspace";
export const DEFAULT_SANDBOX_DAEMON_PORT = 8787;
export const DEFAULT_SANDBOX_LIMA_BINARY = "limactl";
export const DEFAULT_SANDBOX_LIMA_TEMPLATE = "template:docker-rootful";
export const SANDBOX_LABEL_PREFIX = "ai.greppleai.grip";

export type SandboxCleanupBehavior = "stop" | "remove";

export type SandboxConfig = Required<SandboxSettings>;

export type SandboxConfigOverrides = SandboxSettings;

export interface SandboxEnvironment {
	GRIP_SANDBOX_LIMA?: string;
	GRIP_SANDBOX_GUEST_BINARY?: string;
	GRIP_SANDBOX_LIMA_TEMPLATE?: string;
	GRIP_SANDBOX_LIMA_INSTANCE_PREFIX?: string;
	GRIP_SANDBOX_WORKSPACE_MOUNT?: string;
	GRIP_SANDBOX_DAEMON_PORT?: string;
	GRIP_SANDBOX_DAEMON_HOST_BIND?: string;
	GRIP_SANDBOX_CLEANUP?: string;
}

export interface SandboxStartOptions extends SandboxConfigOverrides {
	workspaceRoot: string;
	sessionId?: string;
	name?: string;
	update?: boolean;
}

export interface SandboxListOptions {
	workspaceRoot: string;
	allWorkspaces?: boolean;
}

export interface SandboxStopOptions {
	workspaceRoot: string;
	target?: string;
	currentContainerId?: string;
}

export interface SandboxContainer {
	id: string;
	name: string;
	image: string;
	status: string;
	state: string | undefined;
	createdAt: string | undefined;
	workspaceRoot: string | undefined;
	workspaceMountPath: string | undefined;
	daemonPort: number | undefined;
	daemonEndpoint: string | undefined;
	labels: Record<string, string>;
}

export interface SandboxStartResult {
	containerId: string;
	containerName: string;
	workspaceRoot: string;
	workspaceMountPath: string;
	daemonUrl: string;
	daemonUrlRedacted: string;
	token: string;
	labels: Record<string, string>;
}

export type SandboxStopResult =
	| { status: "stopped"; container: SandboxContainer }
	| { status: "removed"; container: SandboxContainer }
	| { status: "already-stopped"; container: SandboxContainer }
	| { status: "not-found"; message: string };

export interface SandboxService {
	resolveConfig(overrides?: SandboxConfigOverrides): SandboxConfig;
	start(options: SandboxStartOptions): Promise<SandboxStartResult>;
	list(options: SandboxListOptions): Promise<SandboxContainer[]>;
	stop(options: SandboxStopOptions): Promise<SandboxStopResult>;
}

export interface SandboxCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface SandboxCommandOptions {
	env?: Record<string, string>;
}

export interface SandboxRunner {
	run(command: string, args: string[], options?: SandboxCommandOptions): Promise<SandboxCommandResult>;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(value: string | number | undefined, settingName: string): number | undefined {
	if (value === undefined) return undefined;
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) throw new Error(`Invalid ${settingName}: expected a decimal integer`);
	const parsed = Number(text);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`Invalid ${settingName}: expected a port from 1 to 65535`);
	}
	return parsed;
}

function parseCleanup(value: string | undefined, settingName: string): SandboxCleanupBehavior | undefined {
	if (value === undefined) return undefined;
	if (value === "stop" || value === "remove") return value;
	throw new Error(`Invalid ${settingName}: expected stop or remove`);
}

export function redactSecrets(value: string): string {
	return value
		.replace(/(GRIP_DAEMON_TOKEN=)[^\s,;]+/g, "$1[REDACTED]")
		.replace(/(PI_DAEMON_TOKEN=)[^\s,;]+/g, "$1[REDACTED]")
		.replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/([?&]token=)[^\s&]+/gi, "$1[REDACTED]");
}

export function resolveSandboxConfig(
	settings: SandboxSettings | undefined,
	env: SandboxEnvironment = {},
	overrides: SandboxConfigOverrides = {},
): SandboxConfig {
	return {
		limaBinary:
			nonEmpty(overrides.limaBinary) ??
			nonEmpty(env.GRIP_SANDBOX_LIMA) ??
			nonEmpty(settings?.limaBinary) ??
			DEFAULT_SANDBOX_LIMA_BINARY,
		limaTemplate:
			nonEmpty(overrides.limaTemplate) ??
			nonEmpty(env.GRIP_SANDBOX_LIMA_TEMPLATE) ??
			nonEmpty(settings?.limaTemplate) ??
			DEFAULT_SANDBOX_LIMA_TEMPLATE,
		limaInstanceNamePrefix:
			nonEmpty(overrides.limaInstanceNamePrefix) ??
			nonEmpty(env.GRIP_SANDBOX_LIMA_INSTANCE_PREFIX) ??
			nonEmpty(settings?.limaInstanceNamePrefix) ??
			"grip-sandbox",
		workspaceMountPath:
			nonEmpty(overrides.workspaceMountPath) ??
			nonEmpty(env.GRIP_SANDBOX_WORKSPACE_MOUNT) ??
			nonEmpty(settings?.workspaceMountPath) ??
			DEFAULT_SANDBOX_WORKSPACE_MOUNT,
		daemonPort:
			overrides.daemonPort ??
			parsePositiveInteger(env.GRIP_SANDBOX_DAEMON_PORT, "GRIP_SANDBOX_DAEMON_PORT") ??
			parsePositiveInteger(settings?.daemonPort, "sandbox.daemonPort") ??
			DEFAULT_SANDBOX_DAEMON_PORT,
		daemonHostBind:
			nonEmpty(overrides.daemonHostBind) ??
			nonEmpty(env.GRIP_SANDBOX_DAEMON_HOST_BIND) ??
			nonEmpty(settings?.daemonHostBind) ??
			"127.0.0.1",
		cleanup:
			overrides.cleanup ??
			parseCleanup(env.GRIP_SANDBOX_CLEANUP, "GRIP_SANDBOX_CLEANUP") ??
			parseCleanup(settings?.cleanup, "sandbox.cleanup") ??
			"stop",
	};
}

export async function allocateSandboxDaemonPort(host: string, preferredPort: number): Promise<number> {
	const reserve = (port: number): Promise<number | undefined> =>
		new Promise((resolvePort) => {
			const server = createServer();
			server.unref();
			server.once("error", () => resolvePort(undefined));
			server.listen({ host, port, exclusive: true }, () => {
				const address = server.address();
				const selectedPort = typeof address === "object" && address ? address.port : undefined;
				server.close(() => resolvePort(selectedPort));
			});
		});
	const preferred = await reserve(preferredPort);
	if (preferred !== undefined) return preferred;
	const fallback = await reserve(0);
	if (fallback === undefined) throw new Error(`Unable to allocate a sandbox daemon port on ${host}`);
	return fallback;
}
