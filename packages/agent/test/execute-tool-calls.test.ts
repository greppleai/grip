import { fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentTool } from "../src/types.ts";

const parameters = Type.Object({ text: Type.String() });

describe("caller-supplied tool calls", () => {
	it("uses validation, hooks, updates, transcript and lifecycle without calling the model", async () => {
		const streamFn = vi.fn(() => {
			throw new Error("unexpected inference");
		});
		const tool: AgentTool<typeof parameters> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters,
			execute: vi.fn<AgentTool<typeof parameters>["execute"]>(async (_id, args, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "working" }], details: {} });
				return { content: [{ type: "text", text: args.text }], details: {} };
			}),
		};
		const before = vi.fn(async () => undefined);
		const after = vi.fn(async () => ({ content: [{ type: "text" as const, text: "postprocessed" }] }));
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn,
			beforeToolCall: before,
			afterToolCall: after,
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});
		const message = fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" });
		const batch = await agent.executeToolCalls(message, [{ role: "user", content: "Preload context", timestamp: 0 }]);
		expect(batch.messages[0]).toMatchObject({
			toolName: "echo",
			isError: false,
			content: [{ text: "postprocessed" }],
		});
		expect(before).toHaveBeenCalledOnce();
		expect(after).toHaveBeenCalledOnce();
		expect(tool.execute).toHaveBeenCalledOnce();
		expect(streamFn).not.toHaveBeenCalled();
		expect(agent.state.messages.map((entry) => entry.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.pendingToolCalls.size).toBe(0);
	});

	it("returns ordinary errors for unavailable tools, invalid arguments and blocked calls", async () => {
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const before = vi.fn(async () => ({ block: true, reason: "denied", terminate: true }));
		const agent = new Agent({
			initialState: { tools: [{ name: "echo", label: "Echo", description: "Echo", parameters, execute }] },
			beforeToolCall: before,
		});
		for (const call of [
			fauxToolCall("missing", {}),
			fauxToolCall("echo", {}),
			fauxToolCall("echo", { text: "hello" }),
		]) {
			const batch = await agent.executeToolCalls(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			expect(batch.messages[0].isError).toBe(true);
			if (call.name === "echo" && "text" in call.arguments) expect(batch.terminate).toBe(true);
		}
		expect(before).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
	});

	it("excludes concurrent runs and aborts in-flight tools while awaiting lifecycle listeners", async () => {
		let started = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const agent = new Agent({
			initialState: {
				tools: [
					{
						name: "wait",
						label: "Wait",
						description: "Wait",
						parameters: Type.Object({}),
						execute: async (_id, _args, signal) => {
							started();
							await new Promise<void>((resolve) =>
								signal?.addEventListener("abort", () => resolve(), { once: true }),
							);
							throw new Error("aborted");
						},
					},
				],
			},
		});
		let release = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") await barrier;
		});
		const run = agent.executeToolCalls(fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }));
		await ready;
		await expect(agent.prompt("concurrent")).rejects.toThrow("already processing");
		agent.abort();
		let idle = false;
		const settled = agent.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);
		release();
		const batch = await run;
		await settled;
		expect(batch.messages[0]).toMatchObject({ isError: true });
		expect(agent.state.isStreaming).toBe(false);
	});
});
