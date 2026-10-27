import type { AgentTool } from "@greppleai/grip-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	ExtensionManagerReloadCoordinator,
	type ExtensionManagerReloadStatus,
} from "../../src/modes/interactive/extension-manager-reload.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

function gate(): PromiseWithResolvers<void> {
	return Promise.withResolvers<void>();
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function blockedTool(started: PromiseWithResolvers<void>, released: PromiseWithResolvers<void>): AgentTool {
	return {
		name: "hold",
		label: "Hold",
		description: "Wait for the test gate",
		parameters: Type.Object({}),
		execute: async () => {
			started.resolve();
			await released.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
}

describe("extension manager reload coordination", () => {
	const harnesses: Harness[] = [];
	const coordinators: ExtensionManagerReloadCoordinator[] = [];

	async function setup(options: HarnessOptions = {}) {
		const harness = await createHarness(options);
		harnesses.push(harness);
		const statuses: ExtensionManagerReloadStatus[] = [];
		const getSession = vi.fn(() => harness.session);
		const reload = vi.fn((session: AgentSession) => session.reload());
		const coordinator = new ExtensionManagerReloadCoordinator({
			getSession,
			reload,
			onStatus: (status) => statuses.push(status),
		});
		coordinators.push(coordinator);
		return { harness, coordinator, statuses, getSession, reload };
	}

	afterEach(async () => {
		for (const coordinator of coordinators.splice(0)) coordinator.dispose();
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("reloads an idle session through the supplied lifecycle and coalesces requests", async () => {
		const { harness, coordinator, statuses, reload } = await setup();
		const previous = harness.session.extensionRunner;
		const first = coordinator.request();
		expect(coordinator.request()).toBe(first);
		await first;
		expect(reload).toHaveBeenCalledExactlyOnceWith(harness.session);
		expect(harness.session.extensionRunner).not.toBe(previous);
		expect(statuses.map((status) => status.phase)).toEqual(["reloading", "applied"]);
		expect(coordinator.reloadRequired).toBe(false);
	});

	it("waits through tools, follow-up responses and settlement without aborting work", async () => {
		const started = gate();
		const released = gate();
		const { harness, coordinator, statuses, reload } = await setup({ tools: [blockedTool(started, released)] });
		reload.mockImplementation((session) => {
			expect(session.isIdle).toBe(true);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			return session.reload();
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		const prompt = harness.session.prompt("start");
		await started.promise;
		const pending = coordinator.request();
		await tick();
		expect(statuses.at(-1)?.phase).toBe("pending");
		expect(reload).not.toHaveBeenCalled();
		expect(coordinator.reloadRequired).toBe(true);
		released.resolve();
		await Promise.all([prompt, pending]);
		expect(harness.getPendingResponseCount()).toBe(0);
		// Reload itself creates another lifecycle cycle; settlement above is checked before it.
		expect(reload).toHaveBeenCalledOnce();
	});

	it("tracks extension commands separately from session idle admission", async () => {
		const started = gate();
		const released = gate();
		const { harness, coordinator, reload } = await setup({
			extensionFactories: [
				(api) =>
					api.registerCommand("hold-command", {
						handler: async () => {
							started.resolve();
							await released.promise;
						},
					}),
			],
		});
		const command = coordinator.trackCommand(() => harness.session.prompt("/hold-command"));
		await started.promise;
		await harness.session.waitForIdle();
		// Session commands release prompt admission so their own waitForIdle remains usable.
		expect(harness.session.isIdle).toBe(true);
		const pending = coordinator.request();
		await tick();
		expect(reload).not.toHaveBeenCalled();
		released.resolve();
		await Promise.all([command, pending]);
		expect(reload).toHaveBeenCalledOnce();
	});

	it("keeps retry gaps pending through the recovered response", async () => {
		const started = gate();
		const released = gate();
		const retry = gate();
		const { harness, coordinator, reload } = await setup({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			tools: [blockedTool(started, released)],
		});
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retry.resolve();
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("recovered"),
		]);
		const prompt = harness.session.prompt("retry");
		await retry.promise;
		const pending = coordinator.request();
		await started.promise;
		expect(reload).not.toHaveBeenCalled();
		released.resolve();
		await Promise.all([prompt, pending]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(reload).toHaveBeenCalledOnce();
	});

	it("waits for manual compaction before reloading", async () => {
		const started = gate();
		const released = gate();
		const { harness, coordinator, reload } = await setup({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(api) =>
					api.on("session_before_compact", async (event) => {
						started.resolve();
						await released.promise;
						return {
							compaction: {
								summary: "compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					}),
			],
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const compact = harness.session.compact();
		await started.promise;
		const pending = coordinator.request();
		await tick();
		expect(reload).not.toHaveBeenCalled();
		released.resolve();
		await Promise.all([compact, pending]);
		expect(reload).toHaveBeenCalledOnce();
	});

	it("detaches invalidated waits promptly without acting on an unsettled old session", async () => {
		const released = gate();
		const { coordinator, harness, reload, statuses } = await setup();
		const command = coordinator.trackCommand(() => released.promise);
		const pending = coordinator.request();
		await tick();
		const count = statuses.length;
		coordinator.invalidate();
		await pending;
		expect(reload).not.toHaveBeenCalled();
		expect(coordinator.reloadRequired).toBe(true);
		released.resolve();
		await command;
		await harness.session.waitForIdle();
		expect(statuses).toHaveLength(count);
	});

	it("rejects stale session captures after replacement, even without explicit invalidation", async () => {
		const released = gate();
		const { coordinator, getSession, reload, statuses } = await setup();
		const replacement = await createHarness();
		harnesses.push(replacement);
		const command = coordinator.trackCommand(() => released.promise);
		const pending = coordinator.request();
		await tick();
		getSession.mockReturnValue(replacement.session);
		const count = statuses.length;
		released.resolve();
		await Promise.all([command, pending]);
		expect(reload).not.toHaveBeenCalled();
		expect(statuses).toHaveLength(count);
		expect(coordinator.reloadRequired).toBe(true);
	});

	it("retains the reconciliation requirement after reload failure and allows retry", async () => {
		const { coordinator, reload, statuses } = await setup();
		reload.mockRejectedValueOnce(new Error("loader failed"));
		await coordinator.request();
		expect(statuses.at(-1)).toEqual({
			phase: "restart-required",
			message: "Extension changes saved; reload or restart required: loader failed",
		});
		expect(coordinator.reloadRequired).toBe(true);
		await coordinator.request();
		expect(coordinator.reloadRequired).toBe(false);
	});

	it("does not reload when a status observer starts a command, and suppresses disposed callbacks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const released = gate();
		const statuses: ExtensionManagerReloadStatus[] = [];
		let command: Promise<void> | null = null;
		const reload = vi.fn((session: AgentSession) => session.reload());
		const coordinator = new ExtensionManagerReloadCoordinator({
			getSession: () => harness.session,
			reload,
			onStatus: (status) => {
				statuses.push(status);
				if (status.phase === "reloading" && !command) command = coordinator.trackCommand(() => released.promise);
			},
		});
		coordinators.push(coordinator);
		const pending = coordinator.request();
		await tick();
		expect(reload).not.toHaveBeenCalled();
		expect(statuses.at(-1)?.phase).toBe("pending");
		coordinator.dispose();
		await pending;
		const count = statuses.length;
		released.resolve();
		await command;
		await coordinator.request();
		expect(statuses).toHaveLength(count);
		expect(reload).not.toHaveBeenCalled();
	});
	it("cancels a real session idle wait without aborting its active tool", async () => {
		const started = gate();
		const released = gate();
		const { harness, coordinator, reload, statuses } = await setup({ tools: [blockedTool(started, released)] });
		const wait = vi.spyOn(harness.session, "waitForIdle");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		const prompt = harness.session.prompt("start");
		await started.promise;
		const pending = coordinator.request();
		await tick();
		expect(wait).toHaveBeenCalledOnce();
		coordinator.invalidate();
		await pending;
		const count = statuses.length;
		expect(harness.session.isIdle).toBe(false);
		released.resolve();
		await prompt;
		await tick();
		expect(reload).not.toHaveBeenCalled();
		expect(statuses).toHaveLength(count);
	});

	it("rejects a stale runner after another reload on the same session", async () => {
		const released = gate();
		const { harness, coordinator, statuses, reload } = await setup();
		const command = coordinator.trackCommand(() => released.promise);
		const pending = coordinator.request();
		await tick();
		await harness.session.reload();
		const count = statuses.length;
		released.resolve();
		await Promise.all([command, pending]);
		expect(reload).not.toHaveBeenCalled();
		expect(statuses).toHaveLength(count);
		expect(coordinator.reloadRequired).toBe(true);
	});

	it("does not claim later mutations were applied by an already-running reload", async () => {
		const started = gate();
		const released = gate();
		const { coordinator, reload, statuses } = await setup();
		reload.mockImplementationOnce(async (session) => {
			started.resolve();
			await released.promise;
			await session.reload();
		});
		const pending = coordinator.request();
		await started.promise;
		expect(coordinator.request()).toBe(pending);
		released.resolve();
		await pending;
		expect(coordinator.reloadRequired).toBe(true);
		expect(statuses.at(-1)?.phase).toBe("restart-required");
		await coordinator.request();
		expect(coordinator.reloadRequired).toBe(false);
	});

	it("isolates failing status observers from successful runtime reconciliation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const reload = vi.fn((session: AgentSession) => session.reload());
		const coordinator = new ExtensionManagerReloadCoordinator({
			getSession: () => harness.session,
			reload,
			onStatus: () => {
				throw new Error("detached presentation");
			},
		});
		coordinators.push(coordinator);
		await coordinator.request();
		expect(coordinator.reloadRequired).toBe(false);
		expect(reload).toHaveBeenCalledOnce();
	});
	it("holds new interactive command admission until an ongoing reload finishes", async () => {
		const started = gate();
		const released = gate();
		const { coordinator, reload } = await setup();
		reload.mockImplementationOnce(async (session) => {
			started.resolve();
			await released.promise;
			await session.reload();
		});
		const pending = coordinator.request();
		await started.promise;
		const submission = vi.fn(async () => "submitted");
		const command = coordinator.trackCommand(submission);
		await tick();
		expect(submission).not.toHaveBeenCalled();
		released.resolve();
		await pending;
		expect(await command).toBe("submitted");
		expect(submission).toHaveBeenCalledOnce();
	});

	it.each(["invalidate", "dispose"] as const)("cancels queued command admission on %s", async (action) => {
		const started = gate();
		const released = gate();
		const { coordinator, reload } = await setup();
		reload.mockImplementationOnce(async (session) => {
			started.resolve();
			await released.promise;
			await session.reload();
		});
		const pending = coordinator.request();
		await started.promise;
		const submission = vi.fn(async () => "must not run");
		const command = coordinator.trackCommand(submission);
		const rejected = expect(command).rejects.toThrow("Session changed");
		coordinator[action]();
		released.resolve();
		await Promise.all([pending, rejected]);
		expect(submission).not.toHaveBeenCalled();
		expect(coordinator.reloadRequired).toBe(true);
	});
});
