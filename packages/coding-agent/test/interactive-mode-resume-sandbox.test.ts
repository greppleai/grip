import { describe, expect, it, vi } from "vitest";
import type { GripAgentSwitchSessionOptions } from "../src/core/grip-agent.ts";
import type { Session } from "../src/core/session/session.ts";
import { MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ResumeResult {
	cancelled: boolean;
}

type SwitchOutcome = "success" | "cancelled" | "failed" | "missing-cwd";

function createMode(connected: boolean, outcome: SwitchOutcome = "success") {
	const previous = { getCwd: () => "/project", getSessionId: () => "previous" };
	const next = { getCwd: () => "/project", getSessionId: () => "resumed" };
	const sandbox = {
		type: "daemon",
		url: "ws://sandbox",
		token: "secret",
		expectedCwd: "/guest",
		hostWorkspaceRoot: "/project",
		containerId: "vm",
	};
	const states = new Map([["/project\0previous", sandbox]]);
	const activateSandboxDaemon = vi.fn(async () => ({}));
	const session = { session: previous, activateSandboxDaemon };
	let mode: InteractiveMode;
	const switchSession = vi.fn(async (_path: string, options?: GripAgentSwitchSessionOptions) => {
		if (outcome === "cancelled") return { cancelled: true };
		if (outcome === "missing-cwd" && !options?.cwdOverride) {
			throw new MissingSessionCwdError({ sessionCwd: "/missing", fallbackCwd: "/project" });
		}
		await options?.setup?.(next as unknown as Session);
		if (outcome === "failed") throw new Error("failed before replacement");
		session.session = next;
		await (mode as unknown as { restoreCurrentSessionSandbox(): Promise<void> }).restoreCurrentSessionSandbox();
		return { cancelled: false };
	});
	mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: { session, switchSession },
		sessionSandboxStates: states,
		activeSandboxBackendConnected: connected,
		statusContainer: { clear: vi.fn() },
		renderCurrentSessionState: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		promptForMissingSessionCwd: vi.fn(async () => "/project"),
		handleFatalRuntimeError: vi.fn(() => ({ cancelled: true })),
	});
	const resume = () =>
		(mode as unknown as { handleResumeSession(path: string): Promise<ResumeResult> }).handleResumeSession(
			"/session.jsonl",
		);
	return { resume, states, sandbox, switchSession, activateSandboxDaemon, mode };
}

describe("/resume sandbox inheritance", () => {
	it("reattaches the connected sandbox before binding the resumed session", async () => {
		const { resume, states, sandbox, switchSession, activateSandboxDaemon, mode } = createMode(true);
		expect(await resume()).toEqual({ cancelled: false });
		expect(switchSession).toHaveBeenCalledOnce();
		expect(states.get("/project\0resumed")).toBe(sandbox);
		expect(activateSandboxDaemon).toHaveBeenCalledWith({
			url: "ws://sandbox",
			token: "secret",
			expectedCwd: "/guest",
			hostWorkspaceRoot: "/project",
		});
		expect((mode as unknown as { activeSandboxBackendConnected: boolean }).activeSandboxBackendConnected).toBe(true);
	});

	it("starts locally when disconnected even if the previous sandbox is remembered", async () => {
		const { resume, states, switchSession, activateSandboxDaemon } = createMode(false);
		expect(await resume()).toEqual({ cancelled: false });
		expect(switchSession.mock.calls[0]?.[1]?.setup).toBeUndefined();
		expect(states.has("/project\0resumed")).toBe(false);
		expect(activateSandboxDaemon).not.toHaveBeenCalled();
	});

	it("keeps the original attachment when switching is cancelled", async () => {
		const { resume, states, switchSession, activateSandboxDaemon, mode } = createMode(true, "cancelled");
		expect(await resume()).toEqual({ cancelled: true });
		expect(states.has("/project\0resumed")).toBe(false);
		expect(states.has("/project\0previous")).toBe(true);
		expect((mode as unknown as { activeSandboxBackendConnected: boolean }).activeSandboxBackendConnected).toBe(true);
		expect(switchSession).toHaveBeenCalledOnce();
		expect(activateSandboxDaemon).not.toHaveBeenCalled();
	});

	it("restores the selected session's previous state if replacement fails", async () => {
		const { resume, states, switchSession, activateSandboxDaemon, mode } = createMode(true, "failed");
		const remembered = { ...states.get("/project\0previous")!, url: "ws://remembered" };
		states.set("/project\0resumed", remembered);
		expect(await resume()).toEqual({ cancelled: true });
		expect(states.get("/project\0resumed")).toBe(remembered);
		expect(states.has("/project\0previous")).toBe(true);
		expect((mode as unknown as { activeSandboxBackendConnected: boolean }).activeSandboxBackendConnected).toBe(true);
		expect(switchSession).toHaveBeenCalledOnce();
		expect(activateSandboxDaemon).not.toHaveBeenCalled();
	});

	it("carries the attachment through a missing cwd retry", async () => {
		const { resume, states, sandbox, switchSession, activateSandboxDaemon } = createMode(true, "missing-cwd");
		expect(await resume()).toEqual({ cancelled: false });
		expect(switchSession).toHaveBeenCalledTimes(2);
		expect(switchSession.mock.calls[1]?.[1]?.cwdOverride).toBe("/project");
		expect(states.get("/project\0resumed")).toBe(sandbox);
		expect(activateSandboxDaemon).toHaveBeenCalledOnce();
	});
});
