import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	type Model,
	registerFauxProvider,
} from "@greppleai/grip-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES, getDefaultActiveToolNames } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import {
	createJobToolDefinition,
	formatJobTaskPrompt,
	type JobRunRequest,
	jobParamsSchema,
} from "../src/core/tools/job.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { createHarness } from "./suite/harness.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalJobModel = process.env.GRIP_DEFAULT_JOB_MODEL;
function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "grip-job-test-"));
	tempDirs.push(dir);
	return dir;
}
function context(cwd: string, model?: Model<Api>): ExtensionContext {
	return { cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false, model } as unknown as ExtensionContext;
}
afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	if (originalJobModel === undefined) delete process.env.GRIP_DEFAULT_JOB_MODEL;
	else process.env.GRIP_DEFAULT_JOB_MODEL = originalJobModel;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("job tool", () => {
	it("registers and activates job by default with an explicit opt-out", async () => {
		const cwd = createTempDir();
		expect(createAllToolDefinitions(new LocalToolOperations(cwd)).job.name).toBe("job");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("job");
		expect(getDefaultActiveToolNames(false)).not.toContain("job");
		const pi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.getActiveToolNames()).toContain("job");
			session.setJobsEnabled(false);
			expect(session.getActiveToolNames()).not.toContain("job");
			session.setJobsEnabled(true);
			expect(session.getActiveToolNames()).toContain("job");
			expect(session.systemPrompt).not.toContain("<available_jobs>");
		} finally {
			await pi.dispose();
		}
	});

	it("honors explicit tool lists, exclusions, and no-tools modes", async () => {
		const cwd = createTempDir();
		for (const [options, active] of [
			[{ tools: ["job"] }, ["job"]],
			[{ excludedTools: ["job"] }, []],
			[{ tools: [] }, []],
			[{ noTools: "all" as const }, []],
		] as [{ tools?: string[]; excludedTools?: string[]; noTools?: "all" }, string[]][]) {
			const pi = await GripAgent.create({
				cwd,
				sessionManager: new InMemorySessionManager(cwd),
				settingsManager: SettingsManager.inMemory(),
				...options,
			});
			try {
				const session = await pi.createAgentSession();
				if (active.length) expect(session.getActiveToolNames()).toEqual([...active]);
				else expect(session.getActiveToolNames()).not.toContain("job");
			} finally {
				await pi.dispose();
			}
		}
	});

	it("does not activate job in a harness without an embedded runner", async () => {
		const harness = await createHarness({ settings: { enableJobs: true } });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("job");
		} finally {
			harness.cleanup();
		}
	});

	it("exposes bounded task modes, output contracts, cwd, tool and skill limits, but no personas", () => {
		const definition = createJobToolDefinition();
		expect(definition.name).toBe("job");
		expect(definition.promptSnippet).toBe("Delegate a bounded job to an isolated session");
		const forbidden = new Set(["agent", "agentScope", "systemPrompt", "model", "modelHint"]);
		for (const properties of [
			jobParamsSchema.properties,
			jobParamsSchema.properties.tasks.items.properties,
			jobParamsSchema.properties.chain.items.properties,
		]) {
			const names = Object.keys(properties);
			expect(names).toEqual(expect.arrayContaining(["task", "responseFormat", "tools", "skills", "cwd"]));
			expect(names.filter((name) => forbidden.has(name))).toEqual([]);
		}
		expect(formatJobTaskPrompt("Inspect auth", "Return risks")).toBe(
			"<task>\nInspect auth\n</task>\n\n<response-format>\nReturn risks\n</response-format>",
		);
	});

	it("validates one nonempty mode before invoking a runner", async () => {
		const cwd = createTempDir();
		const runner = vi.fn(async () => ({ exitCode: 0, stderr: "" }));
		const definition = createJobToolDefinition({ runner });
		for (const params of [{}, { task: "one", tasks: [{ task: "two" }] }, { tasks: [], chain: [] }]) {
			const result = await definition.execute("invalid", params, undefined, undefined, context(cwd));
			expect(result.content[0]).toMatchObject({ text: "Invalid parameters. Provide exactly one mode." });
			expect(result.details.results).toEqual([]);
		}
		expect(runner).not.toHaveBeenCalled();
	});

	it("fails closed when operations, remote backend or runner is unavailable", async () => {
		const cwd = createTempDir();
		const definition = createJobToolDefinition();
		const missing = await definition.execute("missing", { task: "inspect" }, undefined, undefined, {
			cwd,
		} as unknown as ExtensionContext);
		expect(missing.content[0]).toMatchObject({ text: "Jobs require explicit workspace tool operations." });
		const remote = new LocalToolOperations(cwd);
		Object.defineProperty(remote, "getBackendInfo", { value: () => ({ type: "remote", cwd, configured: false }) });
		const unavailable = await definition.execute("remote", { task: "inspect" }, undefined, undefined, {
			cwd,
			toolOperations: remote,
		} as unknown as ExtensionContext);
		expect(unavailable.content[0]).toMatchObject({ text: "Jobs cannot run with an unconfigured remote backend." });
		const noRunner = await definition.execute("runner", { task: "inspect" }, undefined, undefined, context(cwd));
		expect(noRunner.content[0]).toMatchObject({ text: "Job runner is not configured for this session." });
	});

	it("runs single, parallel, and chain tasks with per-task cwd, tools, skills and {previous} expansion", async () => {
		const cwd = createTempDir();
		const requests: {
			task: string;
			prompt: string;
			cwd: string;
			tools?: string[];
			skills?: string[];
			includeDefaultSkillTool?: boolean;
		}[] = [];
		const definition = createJobToolDefinition({
			runner: async (request) => {
				requests.push(request);
				request.onMessage(fauxAssistantMessage(`answer for ${request.task}`));
				return { exitCode: 0, stderr: "" };
			},
		});
		const single = await definition.execute(
			"single",
			{ task: "inspect", responseFormat: "short", cwd: join(cwd, "sub"), tools: ["read"], skills: ["guide"] },
			undefined,
			undefined,
			context(cwd),
		);
		expect(single.content).toEqual([{ type: "text", text: "answer for inspect" }]);
		expect(single.details.mode).toBe("single");
		expect(requests[0]).toMatchObject({
			cwd: join(cwd, "sub"),
			tools: ["read"],
			skills: ["guide"],
			includeDefaultSkillTool: false,
			prompt: formatJobTaskPrompt("inspect", "short"),
		});
		const parallel = await definition.execute(
			"parallel",
			{
				tasks: [
					{ task: "a", cwd: join(cwd, "a") },
					{ task: "b", tools: ["bash"] },
				],
			},
			undefined,
			undefined,
			context(cwd),
		);
		expect(parallel.details.mode).toBe("parallel");
		expect(parallel.details.results.map((item) => item.status)).toEqual(["completed", "completed"]);
		expect(parallel.content[0]).toMatchObject({ text: expect.stringContaining("Parallel: 2/2 succeeded") });
		expect(JSON.stringify(parallel.content)).not.toContain("ad-hoc");
		expect(requests[1]).toMatchObject({ cwd: join(cwd, "a"), includeDefaultSkillTool: true });
		expect(requests[2]).toMatchObject({ cwd, tools: ["bash"], includeDefaultSkillTool: false });
		const chain = await definition.execute(
			"chain",
			{ chain: [{ task: "start" }, { task: "use {previous} and {previous}" }] },
			undefined,
			undefined,
			context(cwd),
		);
		expect(chain.details.mode).toBe("chain");
		expect(chain.details.results.map((item) => item.step)).toEqual([1, 2]);
		expect(requests.at(-1)?.task).toBe("use answer for start and answer for start");
		expect(chain.content[0]).toMatchObject({ text: "answer for use answer for start and answer for start" });
		expect(JSON.stringify(chain.content)).not.toContain("ad-hoc");
	});

	it("prefers global jobModel over env, then falls back to env and parent model", async () => {
		const cwd = createTempDir();
		const settings = SettingsManager.inMemory();
		const received: string[] = [];
		const definition = createJobToolDefinition({
			getConfiguredModel: () => settings.getJobModel(),
			runner: async (request) => {
				received.push(request.model ?? "none");
				request.onMessage(fauxAssistantMessage("done"));
				return { exitCode: 0, stderr: "" };
			},
		});
		process.env.GRIP_DEFAULT_JOB_MODEL = "env/model";
		settings.setJobModel("global/model");
		const ctx = context(cwd, getModel("openai-codex", "gpt-5.6"));
		await definition.execute("one", { task: "one" }, undefined, undefined, ctx);
		settings.setJobModel(undefined);
		await definition.execute("two", { task: "two" }, undefined, undefined, ctx);
		delete process.env.GRIP_DEFAULT_JOB_MODEL;
		await definition.execute("three", { task: "three" }, undefined, undefined, ctx);
		expect(received).toEqual(["global/model", "env/model", "openai-codex/gpt-5.6"]);
	});

	it("bounds retained messages and cancels queued parallel tasks after abort", async () => {
		const cwd = createTempDir();
		const bounded = createJobToolDefinition({
			runner: async (request) => {
				for (let i = 0; i < 12; i++)
					request.onMessage({
						role: "toolResult",
						toolCallId: `call-${i}`,
						toolName: "read",
						content: [{ type: "text", text: "x".repeat(100_000) }],
						details: { raw: "y".repeat(100_000) },
						isError: false,
						timestamp: Date.now(),
					});
				request.onMessage(fauxAssistantMessage("bounded output"));
				return { exitCode: 0, stderr: "" };
			},
		});
		const result = await bounded.execute(
			"bounded",
			{ tasks: [{ task: "one" }, { task: "two" }] },
			undefined,
			undefined,
			context(cwd),
		);
		for (const item of result.details.results) {
			expect(JSON.stringify(item.messages).length).toBeLessThan(300_000);
			expect(item.messages.length).toBeLessThan(12);
			expect(item.status).toBe("completed");
		}
		const controller = new AbortController();
		const runner = vi.fn(async (request: JobRunRequest) => {
			request.onMessage(fauxAssistantMessage("partial"));
			controller.abort();
			throw new Error("aborted");
		});
		const aborted = await createJobToolDefinition({ runner }).execute(
			"abort",
			{ tasks: Array.from({ length: 8 }, (_, i) => ({ task: `task ${i}` })) },
			controller.signal,
			undefined,
			context(cwd),
		);
		expect(runner).toHaveBeenCalledTimes(1);
		expect(aborted.details.results).toHaveLength(8);
		expect(aborted.details.results.every((item) => item.status === "failed" && item.stopReason === "aborted")).toBe(
			true,
		);
		expect(aborted.details.results[0].messages).toHaveLength(1);
	});

	it("runs an isolated child with the global model, parent tool ceiling and preloaded skill", async () => {
		const cwd = createTempDir();
		const agentDir = createTempDir();
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(agentDir, "skills", "child-guide"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "child-guide", "SKILL.md"),
			"---\nname: child-guide\ndescription: Child instructions\n---\nCHILD SKILL INSTRUCTIONS",
		);
		const faux = registerFauxProvider({
			models: [
				{ id: "faux-parent", reasoning: true },
				{ id: "faux-child", reasoning: true },
			],
		});
		const model = faux.getModel("faux-parent")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((m) => ({
				id: m.id,
				name: m.name,
				api: m.api,
				reasoning: m.reasoning,
				input: m.input,
				cost: m.cost,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				baseUrl: m.baseUrl,
			})),
		});
		const settings = SettingsManager.inMemory();
		settings.setJobModel("faux/faux-child");
		process.env.GRIP_DEFAULT_JOB_MODEL = "faux/invalid-env";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("job", { task: "inspect", tools: ["read"], skills: ["child-guide"] }), {
				stopReason: "toolUse",
			}),
			(context, _options, _state, selectedModel) => {
				expect(selectedModel.id).toBe("faux-child");
				expect(context.tools?.map((tool) => tool.name)).toEqual(["read"]);
				expect(context.systemPrompt).toContain("CHILD SKILL INSTRUCTIONS");
				expect(JSON.stringify(context.messages)).toContain("<task>\\ninspect\\n</task>");
				return fauxAssistantMessage("child result");
			},
			fauxAssistantMessage("parent result"),
		]);
		const pi = await GripAgent.create({
			cwd,
			agentDir,
			sessionManager: new InMemorySessionManager(cwd),
			authStorage,
			modelRegistry,
			settingsManager: settings,
			model,
			tools: ["read", "job"],
		});
		try {
			const session = await pi.createAgentSession();
			await session.prompt("delegate");
			const result = session.messages.find((message) => message.role === "toolResult");
			expect(JSON.stringify(result)).toContain('"preloadedSkills":["child-guide"]');
			expect(JSON.stringify(result)).toContain('"model":"faux/faux-child"');
			expect(faux.state.callCount).toBe(3);
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});
});
