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

describe("/new sandbox inheritance", () => {
	it("reuses the connected sandbox for the new session without starting another VM", async () => {
		const { command, states, newSession, activateSandboxDaemon } = createMode(true);
		await command("/new")?.run();
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
		await command("/new")?.run();
		expect(states.get("/project\0next")).toBe(attached);
		expect(activateSandboxDaemon).toHaveBeenCalledWith({
			url: "ws://attached",
			token: "secret",
			expectedCwd: "/guest",
		});
		expect((mode as unknown as { activeSandboxContainerId?: string }).activeSandboxContainerId).toBeUndefined();
	});

	it("starts locally when no sandbox is connected, even if one is remembered", async () => {
		const inactive = createMode(false);
		await inactive.command("/new")?.run();
		expect(inactive.newSession).toHaveBeenCalledWith(undefined);
		expect(inactive.states.has("/project\0next")).toBe(false);
		expect(inactive.activateSandboxDaemon).not.toHaveBeenCalled();
	});

	it("leaves the original sandbox alone when the new session is cancelled", async () => {
		const { command, states, activateSandboxDaemon } = createMode(true, true);
		await command("/new")?.run();
		expect(states.has("/project\0next")).toBe(false);
		expect(states.has("/project\0previous")).toBe(true);
		expect(activateSandboxDaemon).not.toHaveBeenCalled();
	});

	it("rejects the removed --sandbox argument and other unsupported options", async () => {
		for (const text of ["/new --sandbox", "/new --other"]) {
			const { command, newSession, mode } = createMode(true);
			await command(text)?.run();
			expect(newSession).not.toHaveBeenCalled();
			expect((mode as unknown as { showWarning: ReturnType<typeof vi.fn> }).showWarning).toHaveBeenCalledWith(
				"Usage: /new",
			);
		}
	});
});
