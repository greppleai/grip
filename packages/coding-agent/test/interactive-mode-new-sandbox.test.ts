import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/core/session/session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface CommandAction {
	run(): Promise<void>;
}

interface NewSessionOptions {
	setup?: (session: Session) => void | Promise<void>;
}

function createMode(connected: boolean, cancelled = false) {
	const previous = { getCwd: () => "/project", getSessionId: () => "previous" };
	const next = { getCwd: () => "/project", getSessionId: () => "next" };
	const sandbox = {
		type: "daemon",
		url: "ws://sandbox",
		token: "secret",
		expectedCwd: "/guest",
		containerId: "vm" as string | undefined,
	};
	const states = new Map([["/project\0previous", sandbox]]);
	const activateSandboxDaemon = vi.fn(async () => ({}));
	const session = { session: previous, activateSandboxDaemon };
	let mode: InteractiveMode;
	const newSession = vi.fn(async (options?: NewSessionOptions) => {
		if (cancelled) return { cancelled: true };
		await options?.setup?.(next as unknown as Session);
		session.session = next;
		await (mode as unknown as { restoreCurrentSessionSandbox(): Promise<void> }).restoreCurrentSessionSandbox();
		return { cancelled: false };
	});
	mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: { session, newSession },
		sessionSandboxStates: states,
		activeSandboxBackendConnected: connected,
		statusContainer: { clear: vi.fn() },
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		editor: { setText: vi.fn() },
		renderCurrentSessionState: vi.fn(),
		showWarning: vi.fn(),
		handleFatalRuntimeError: vi.fn(),
	});
	const command = (text: string) =>
		(
			mode as unknown as { resolveParameterizedEditorCommand(text: string): CommandAction | undefined }
		).resolveParameterizedEditorCommand(text);
	return { command, states, newSession, activateSandboxDaemon, mode };
}

describe("/new --sandbox", () => {
	it("reuses the connected sandbox for the new session without starting another VM", async () => {
		const { command, states, newSession, activateSandboxDaemon } = createMode(true);
		await command("/new --sandbox")?.run();
		expect(newSession).toHaveBeenCalledOnce();
		expect(states.get("/project\0next")).toBe(states.get("/project\0previous"));
		expect(activateSandboxDaemon).toHaveBeenCalledWith({
			url: "ws://sandbox",
			token: "secret",
			expectedCwd: "/guest",
		});
	});

	it("keeps an attached remote sandbox without starting a container", async () => {
		const { command, states, activateSandboxDaemon, mode } = createMode(true);
		const attached = states.get("/project\0previous")!;
		attached.containerId = undefined;
		attached.url = "ws://attached";
		await command("/new --sandbox")?.run();
		expect(states.get("/project\0next")).toBe(attached);
		expect(activateSandboxDaemon).toHaveBeenCalledWith({
			url: "ws://attached",
			token: "secret",
			expectedCwd: "/guest",
		});
		expect((mode as unknown as { activeSandboxContainerId?: string }).activeSandboxContainerId).toBeUndefined();
	});
	it("does not reuse an inactive sandbox or change bare /new", async () => {
		const inactive = createMode(false);
		await inactive.command("/new --sandbox")?.run();
		expect(inactive.newSession).toHaveBeenCalledWith(undefined);
		expect(inactive.activateSandboxDaemon).not.toHaveBeenCalled();
		const bare = createMode(true);
		await bare.command("/new")?.run();
		expect(bare.newSession).toHaveBeenCalledWith(undefined);
		expect(bare.activateSandboxDaemon).not.toHaveBeenCalled();
	});

	it("leaves the original sandbox alone when the new session is cancelled", async () => {
		const { command, states, activateSandboxDaemon } = createMode(true, true);
		await command("/new --sandbox")?.run();
		expect(states.has("/project\0next")).toBe(false);
		expect(states.has("/project\0previous")).toBe(true);
		expect(activateSandboxDaemon).not.toHaveBeenCalled();
	});

	it("rejects unsupported /new options", async () => {
		const { command, newSession, mode } = createMode(true);
		await command("/new --other")?.run();
		expect(newSession).not.toHaveBeenCalled();
		expect((mode as unknown as { showWarning: ReturnType<typeof vi.fn> }).showWarning).toHaveBeenCalledWith(
			"Usage: /new [--sandbox]",
		);
	});
});
