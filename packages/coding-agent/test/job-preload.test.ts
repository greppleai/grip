import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@greppleai/grip-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionFactory } from "../src/core/extensions/types.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createJobToolDefinition, type JobDetails, type JobToolInput, jobParamsSchema } from "../src/core/tools/job.ts";
import { LocalToolOperations, type ToolOperations } from "../src/core/tools/operations.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture(
	tools = ["bash", "read"],
	factory?: ExtensionFactory,
	configureOperations?: (operations: ToolOperations) => void,
) {
	vi.stubEnv("GRIP_DEFAULT_JOB_MODEL", "");
	const harness = await createHarness();
	const cwd = harness.tempDir;
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const extensionsResult = factory ? await createTestExtensionsResult([factory], cwd) : undefined;
	const operations = new LocalToolOperations(cwd);
	configureOperations?.(operations);
	const pi = await GripAgent.create({
		cwd,
		agentDir,
		model: harness.getModel(),
		authStorage: harness.authStorage,
		modelRegistry: harness.session.modelRegistry,
		sessionManager: new InMemorySessionManager(cwd),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		tools: ["job", ...tools],
		toolOperations: operations,
		hooks: false,
	});
	cleanups.push(async () => {
		await pi.dispose();
		harness.cleanup();
	});
	const session = await pi.createAgentSession();
	return { harness, pi, session, cwd };
}

function jobDetails(messages: readonly AgentMessage[]): JobDetails {
	const result = messages.find((message) => message.role === "toolResult" && message.toolName === "job");
	if (result?.role !== "toolResult") throw new Error("Expected job result");
	return result.details as JobDetails;
}

describe("job context preload", () => {
	it("exposes and forwards per-task preloads in single, parallel and chain modes", async () => {
		const { cwd } = await fixture();
		const preload = [{ tool: "bash", args: { command: "pwd", output_mode: "always" } }];
		for (const properties of [
			jobParamsSchema.properties,
			jobParamsSchema.properties.tasks.items.properties,
			jobParamsSchema.properties.chain.items.properties,
		]) {
			expect(properties.preload).toMatchObject({ maxItems: 16 });
		}
		const requests: unknown[] = [];
		const definition = createJobToolDefinition({
			runner: async (request) => {
				requests.push(request.preload);
				request.onMessage(fauxAssistantMessage("answer"));
				return { exitCode: 0, stderr: "" };
			},
		});
		for (const params of [
			{ task: "one", preload },
			{ tasks: [{ task: "two", preload }] },
			{ chain: [{ task: "three", preload }] },
		]) {
			await definition.execute("forward", params, undefined, undefined, {
				cwd,
				toolOperations: new LocalToolOperations(cwd),
			} as unknown as ExtensionContext);
		}
		expect(requests).toEqual([preload, preload, preload]);
	});

	it("hydrates the first child turn in order using child cwd, with visible provenance and no extra model turns", async () => {
		const { harness, session, cwd } = await fixture();
		const sub = join(cwd, "sub");
		mkdirSync(sub);
		writeFileSync(join(sub, "context.txt"), "PRELOADED SOURCE");
		session.registerSessionSkill({
			name: "guide",
			description: "Guide",
			filePath: "",
			disableModelInvocation: false,
			content: "PRELOADED SKILL",
		});
		const params: JobToolInput = {
			task: "inspect",
			tools: ["bash", "read"],
			cwd: sub,
			skills: ["guide"],
			preload: [
				{ tool: "bash", args: { command: "pwd", output_mode: "always" } },
				{ tool: "read", args: { path: "context.txt" } },
			],
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("job", params), { stopReason: "toolUse" }),
			(context) => {
				expect(context.systemPrompt).toContain("PRELOADED SKILL");
				expect(context.messages[0].role).toBe("user");
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results.map((message) => message.toolName)).toEqual(["bash", "read"]);
				expect(getMessageText(results[0])).toContain(sub);
				expect(getMessageText(results[1])).toContain("PRELOADED SOURCE");
				expect(JSON.stringify(context.messages)).toContain("Parent-supplied context preload");
				return fauxAssistantMessage("child answer");
			},
			fauxAssistantMessage("parent answer"),
		]);
		await session.prompt("delegate");
		const result = jobDetails(session.messages).results[0];
		expect(result.status, result.stderr || result.errorMessage).toBe("completed");
		expect(result.usage.turns).toBe(1);
		expect(result.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(3);
		expect(session.getToolOperations().cwd).toBe(cwd);
	});

	it.each([
		["unavailable", [{ tool: "write", args: { path: "bad.txt", content: "bad" } }], "not enabled"],
		["invalid arguments", [{ tool: "read", args: {} }], "failed"],
		["command failure", [{ tool: "bash", args: { command: "exit 7", output_mode: "always" } }], "code 7"],
		["too many", Array.from({ length: 17 }, () => ({ tool: "bash", args: { command: "pwd" } })), "16"],
	])("fails before child inference for %s", async (_name, preload, error) => {
		const { harness, session } = await fixture();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("job", { task: "inspect", tools: ["bash", "read"], preload }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("parent handles failure"),
		]);
		await session.prompt("delegate");
		const result = session.messages.find((message) => message.role === "toolResult");
		expect(getMessageText(result)).toContain(error);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("cannot widen the parent allowlist, even through preload", async () => {
		const { harness, session } = await fixture([]);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("job", {
					task: "inspect",
					tools: ["bash"],
					preload: [{ tool: "bash", args: { command: "pwd" } }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent handles failure"),
		]);
		await session.prompt("delegate");
		expect(jobDetails(session.messages).results[0]).toMatchObject({ status: "failed", usage: { turns: 0 } });
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("runs child extension permission handlers and stops subsequent preloads on denial", async () => {
		const calls: string[] = [];
		const { harness, session } = await fixture(["bash"], (api) => {
			api.registerJobFactory((child) => {
				child.on("tool_call", (event) => {
					calls.push(event.toolName);
					return { block: true, reason: "preload denied" };
				});
			});
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("job", {
					task: "inspect",
					tools: ["bash"],
					preload: [
						{ tool: "bash", args: { command: "pwd" } },
						{ tool: "bash", args: { command: "pwd" } },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent handles denial"),
		]);
		await session.prompt("delegate");
		expect(calls).toEqual(["bash"]);
		expect(jobDetails(session.messages).results[0].stderr).toContain("preload denied");
		expect(harness.faux.state.callCount).toBe(2);
	});
	it.each(["abort", "timeout"])("cancels preloading on %s without starting child inference", async (mode) => {
		let started = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const { harness, session } = await fixture(["wait"], (api) => {
			api.registerJobFactory((child) => {
				child.registerTool({
					name: "wait",
					label: "Wait",
					description: "Wait for cancellation",
					parameters: Type.Object({}),
					execute: async (_id, _args, signal) => {
						started();
						await new Promise<void>((resolve) =>
							signal?.addEventListener("abort", () => resolve(), { once: true }),
						);
						throw new Error("preload cancelled");
					},
				});
			});
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("job", { task: "inspect", tools: ["wait"], preload: [{ tool: "wait", args: {} }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent handles failure"),
		]);
		if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const prompt = session.prompt("delegate");
		await ready;
		if (mode === "abort") await session.abort();
		else await vi.advanceTimersByTimeAsync(60_000);
		await prompt;
		const result = jobDetails(session.messages).results[0];
		expect(result.status).toBe("failed");
		expect(result.usage.turns).toBe(0);
		expect(result.stderr).toContain(mode === "abort" ? "aborted" : "timed out");
	});
	it("routes preload calls through the remote backend with a per-job cwd", async () => {
		const remoteCalls: string[] = [];
		let expectedCwd = "";
		const { harness, session, cwd } = await fixture(["bash"], undefined, (operations) => {
			const root = operations.cwd;
			operations.getBackendInfo = () => ({
				type: "remote",
				configured: true,
				cwd: root,
				url: "ws://workspace.invalid",
				protocol: "ws",
				workspace: { id: "test", root, pathFlavor: "posix" },
			});
			operations.resolveWorkspaceToolExecution = () => "remote";
			operations.executeWorkspaceTool = async (name, invocation) => {
				remoteCalls.push(name);
				expect(invocation.executionOptions.cwd).toBe(expectedCwd);
				return { content: [{ type: "text", text: "REMOTE PRELOAD" }], details: {} };
			};
		});
		const sub = join(cwd, "remote-sub");
		expectedCwd = sub;
		mkdirSync(sub);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("job", {
					task: "inspect",
					cwd: sub,
					tools: ["bash"],
					preload: [{ tool: "bash", args: { command: "pwd", output_mode: "always" } }],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(context.messages.some((message) => getMessageText(message).includes("REMOTE PRELOAD"))).toBe(true);
				return fauxAssistantMessage("child answer");
			},
			fauxAssistantMessage("parent answer"),
		]);
		await session.prompt("delegate");
		expect(jobDetails(session.messages).results[0]).toMatchObject({
			status: "completed",
			execution: { backend: "remote", cwd: sub },
		});
		expect(remoteCalls).toEqual(["bash"]);
		expect(session.getToolOperations().cwd).toBe(cwd);
	});
});
