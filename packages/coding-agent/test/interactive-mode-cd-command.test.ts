import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PathCommand = "/cd" | "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleCdCommand(this: CdCommandContext, text: string): Promise<void>;
};

interface CdCommandActiveSession {
	getCwd: () => string;
}

interface CdCommandSession {
	isIdle: boolean;
	isBashRunning: boolean;
	supportsDirectoryChange: () => boolean;
	getToolBackendInfo?: () => unknown;
	changeSandboxWorkingDirectory?: (target: string) => Promise<string>;
}

interface CdCommandSwitchResult {
	cancelled: boolean;
}

interface CdCommandRuntimeHost {
	changeDirectory: (cwd: string) => Promise<CdCommandSwitchResult>;
}

interface CdCommandContext {
	activeSandboxBackendConnected?: boolean;
	activeSession: CdCommandActiveSession;
	session: CdCommandSession;
	runtimeHost: CdCommandRuntimeHost;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
	renderCurrentSessionState: () => void;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	updateToolBackendStatus: () => void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createContext(cwd: string): CdCommandContext {
	return {
		activeSession: {
			getCwd: () => cwd,
		},
		session: {
			isIdle: true,
			isBashRunning: false,
			supportsDirectoryChange: () => true,
		},
		runtimeHost: { changeDirectory: vi.fn(async () => ({ cancelled: false })) },
		getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		renderCurrentSessionState: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		updateToolBackendStatus: vi.fn(),
	};
}

describe("InteractiveMode /cd", () => {
	it("reopens the current session with the selected working directory", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cd-command-"));
		tempDirectories.push(cwd);
		mkdirSync(join(cwd, "next"));
		const context = createContext(cwd);

		await interactiveModePrototype.handleCdCommand.call(context, "/cd next");

		expect(context.runtimeHost.changeDirectory).toHaveBeenCalledWith(realpathSync(join(cwd, "next")));
		expect(context.renderCurrentSessionState).toHaveBeenCalledOnce();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("reports a missing directory without switching sessions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cd-command-"));
		tempDirectories.push(cwd);
		const context = createContext(cwd);

		await interactiveModePrototype.handleCdCommand.call(context, "/cd missing");

		expect(context.showError).toHaveBeenCalledWith("Directory not found: missing");
		expect(context.runtimeHost.changeDirectory).not.toHaveBeenCalled();
	});
	it("changes the guest cwd in-place without changing the host session or its mount", async () => {
		const context = Object.setPrototypeOf(createContext("/host/project"), InteractiveMode.prototype);
		context.activeSandboxBackendConnected = true;
		context.session.supportsDirectoryChange = () => false;
		context.session.getToolBackendInfo = () => ({
			type: "remote",
			configured: true,
			workspace: { root: "/workspace" },
		});
		context.session.changeSandboxWorkingDirectory = vi.fn(async () => "/workspace/subdirectory");

		await interactiveModePrototype.handleCdCommand.call(context, "/cd subdirectory");
		expect(context.session.changeSandboxWorkingDirectory).toHaveBeenCalledWith("subdirectory");
		expect(context.runtimeHost.changeDirectory).not.toHaveBeenCalled();
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(context.activeSession.getCwd()).toBe("/host/project");
		expect(context.showStatus).toHaveBeenCalledWith("Working directory: /workspace/subdirectory");
		expect(context.updateToolBackendStatus).toHaveBeenCalledOnce();

		await interactiveModePrototype.handleCdCommand.call(context, "/cd");
		expect(context.session.changeSandboxWorkingDirectory).toHaveBeenLastCalledWith("/workspace");
	});

	it("explains guest directory failures without exposing the protocol error", async () => {
		const context = Object.setPrototypeOf(createContext("/host/project"), InteractiveMode.prototype);
		context.activeSandboxBackendConnected = true;
		context.session.supportsDirectoryChange = () => false;
		context.session.getToolBackendInfo = () => ({
			type: "remote",
			configured: true,
			workspace: { root: "/workspace" },
		});
		context.session.changeSandboxWorkingDirectory = vi.fn(async () => {
			throw new Error("Remote workspace request handler failed");
		});
		await interactiveModePrototype.handleCdCommand.call(context, "/cd /workspace/planner");
		expect(context.showError).toHaveBeenCalledWith(
			"Directory unavailable in sandbox: /workspace/planner (it must exist within the mounted workspace /workspace)",
		);
		expect(context.updateToolBackendStatus).not.toHaveBeenCalled();
	});
});
