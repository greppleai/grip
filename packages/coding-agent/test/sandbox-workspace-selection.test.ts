import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseSandboxUserCommand, type SandboxStartUserCommand } from "../src/core/sandbox/command.ts";
import type { SandboxService, SandboxStartOptions, SandboxStartResult } from "../src/core/sandbox/config.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ActiveSandboxSession {
	getSessionId(): string;
}

interface StartSandboxContext {
	activeSession: ActiveSandboxSession;
	sessionSandboxStates: Map<string, unknown>;
	showSandboxStartupLoader(): undefined;
	hideSandboxStartupLoader(): void;
	activateStartedSandbox(service: SandboxService, workspaceRoot: string, result: SandboxStartResult): Promise<unknown>;
	refreshUiAfterBackendChange(): void;
	updateToolBackendStatus(): void;
	formatToolBackendStatus(): string;
	showStatus(): void;
}

interface SandboxStarter {
	startSandboxBackend(
		this: StartSandboxContext,
		command: SandboxStartUserCommand,
		service: SandboxService,
		workspaceRoot: string,
		sessionKey: string,
	): Promise<SandboxStartResult>;
}

it("parses explicit workspace paths, including spaces, and rejects missing values", () => {
	expect(parseSandboxUserCommand('/sandbox start --name shared --workspace "/host/other project"')).toEqual({
		subcommand: "start",
		name: "shared",
		workspace: "/host/other project",
	});
	expect(parseSandboxUserCommand("/sandbox start --workspace ../other --name shared --update")).toEqual({
		subcommand: "start",
		name: "shared",
		workspace: "../other",
		update: true,
	});
	for (const suffix of ["--workspace", "--workspace --name shared", '--workspace ""']) {
		expect(() => parseSandboxUserCommand(`/sandbox start ${suffix}`)).toThrow("Usage:");
	}
});

it.each([
	["/host/other", "/host/other"],
	["../other", "/host/other"],
	[undefined, "/host/current"],
	["$HOME/Documents", join(homedir(), "Documents")],
	[`\${HOME}/Documents`, join(homedir(), "Documents")],
	["~/Documents", join(homedir(), "Documents")],
	["$HOME", homedir()],
	[`\${HOME}`, homedir()],
	["~", homedir()],
	["$HOME/Documents with spaces", join(homedir(), "Documents with spaces")],
	["$HOMELESS/Documents", "/host/current/$HOMELESS/Documents"],
	["nested/$HOME", "/host/current/nested/$HOME"],
	["$(whoami)", "/host/current/$(whoami)"],
])("routes workspace %s independently of the host session cwd", async (workspace, expectedRoot) => {
	const result: SandboxStartResult = {
		containerId: "shared",
		containerName: "shared",
		workspaceRoot: expectedRoot,
		workspaceMountPath: "/workspace/other",
		daemonUrl: "grip+ws://127.0.0.1:8787/grip/workspace?root=%2Fworkspace%2Fother",
		daemonUrlRedacted: "ws://127.0.0.1:8787/grip/workspace",
		token: "test-token",
		labels: {},
	};
	const start = vi.fn(async (_options: SandboxStartOptions) => result);
	const service: SandboxService = {
		start,
		resolveConfig: vi.fn(),
		list: vi.fn(),
		stop: vi.fn(),
	};
	const context: StartSandboxContext = {
		activeSession: { getSessionId: () => "session" },
		sessionSandboxStates: new Map(),
		showSandboxStartupLoader: () => undefined,
		hideSandboxStartupLoader: vi.fn(),
		activateStartedSandbox: vi.fn(async () => ({})),
		refreshUiAfterBackendChange: vi.fn(),
		updateToolBackendStatus: vi.fn(),
		formatToolBackendStatus: () => "remote",
		showStatus: vi.fn(),
	};
	const command: SandboxStartUserCommand = { subcommand: "start", name: "shared" };
	if (workspace !== undefined) command.workspace = workspace;
	const prototype = InteractiveMode.prototype as unknown as SandboxStarter;
	await prototype.startSandboxBackend.call(context, command, service, "/host/current", "session");
	expect(start).toHaveBeenCalledWith({ workspaceRoot: expectedRoot, name: "shared", sessionId: "session" });
	expect(context.activateStartedSandbox).toHaveBeenCalledWith(service, expectedRoot, result);
	expect(context.sessionSandboxStates.get("session")).toMatchObject({
		hostWorkspaceRoot: expectedRoot,
		expectedCwd: "/workspace/other",
	});
});
