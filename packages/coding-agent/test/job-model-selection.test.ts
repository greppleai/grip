import type { AgentMessage } from "@greppleai/grip-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import type { JobModelOption, Settings } from "../src/core/settings-manager.ts";
import { createJobToolDefinition, type JobDetails, type JobToolInput } from "../src/core/tools/job.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const catalog: JobModelOption[] = [
	{ model: "faux/cheap", description: "Mechanical extraction with supplied context; not architecture decisions." },
	{ model: "faux/other", description: "Broader investigation." },
];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function fixture(settings: Partial<Settings> = {}, tools = ["read", "job"]) {
	vi.stubEnv("GRIP_DEFAULT_JOB_MODEL", "");
	const harness = await createHarness({
		models: ["parent", "default", "cheap", "other"].map((id) => ({ id, reasoning: true })),
		settings: { jobModels: catalog, ...settings },
	});
	cleanups.push(harness.cleanup);
	const cwd = harness.tempDir;
	const pi = await GripAgent.create({
		cwd,
		agentDir: cwd,
		model: harness.getModel(),
		authStorage: harness.authStorage,
		modelRegistry: harness.session.modelRegistry,
		settingsManager: harness.settingsManager,
		sessionManager: new InMemorySessionManager(cwd),
		resourceLoader: createTestResourceLoader(),
		toolOperations: new LocalToolOperations(cwd),
		tools,
		hooks: false,
	});
	cleanups.push(() => pi.dispose());
	const session = await pi.createAgentSession();
	const context = {
		cwd,
		toolOperations: session.getToolOperations(),
		model: session.model,
		hasUI: false,
	} as unknown as ExtensionContext;
	return { harness, session, context, settings: harness.settingsManager };
}

function jobDetails(messages: readonly AgentMessage[]): JobDetails {
	const result = messages.find((message) => message.role === "toolResult" && message.toolName === "job");
	if (result?.role !== "toolResult") throw new Error("Expected job result");
	return result.details as JobDetails;
}

describe("per-job model selection", () => {
	it("exposes catalog guidance and refreshes it without enabling inactive tools", async () => {
		const { session, settings } = await fixture();
		expect(session.agent.state.tools.find((tool) => tool.name === "job")?.description).toContain(
			catalog[0].description,
		);
		session.setActiveToolsByName(["job"]);
		settings.setJobModels([{ model: "faux/other", description: "NEW ROUTING GUIDANCE" }]);
		session.refreshJobModelCatalog();
		expect(session.getActiveToolNames()).toEqual(["job"]);
		const description = session.agent.state.tools[0].description;
		expect(description).toContain("NEW ROUTING GUIDANCE");
		expect(description).not.toContain(catalog[0].description);
		settings.setJobModels([]);
		session.refreshJobModelCatalog();
		expect(session.agent.state.tools[0].description).toContain("No alternate job models");
	});

	it.each(["base", "extension"])("preserves %s job tool overrides when refreshing", async (mode) => {
		const custom = {
			name: "job",
			label: "Custom job",
			description: "CUSTOM JOB OVERRIDE",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		const harness = await createHarness({
			tools: mode === "base" ? [custom] : undefined,
			extensionFactories:
				mode === "extension"
					? [
							(api) => {
								api.registerTool(custom);
							},
						]
					: undefined,
			jobRunner: async () => ({ exitCode: 0, stderr: "" }),
		});
		cleanups.push(harness.cleanup);
		harness.session.setActiveToolsByName(["job"]);
		harness.settingsManager.setJobModels(catalog);
		harness.session.refreshJobModelCatalog();
		expect(harness.session.getActiveToolNames()).toEqual(["job"]);
		expect(harness.session.agent.state.tools[0].description).toBe("CUSTOM JOB OVERRIDE");
	});

	it("does not activate an excluded job tool when refreshing its catalog", async () => {
		const { session, settings } = await fixture({}, []);
		settings.setJobModels(catalog);
		session.refreshJobModelCatalog();
		expect(session.getActiveToolNames()).toEqual([]);
	});

	it("forwards explicit models in every mode and leaves omitted choices on their existing default", async () => {
		const { context, settings } = await fixture({ jobModel: "faux/default" });
		vi.stubEnv("GRIP_DEFAULT_JOB_MODEL", "faux/other");
		const requests: string[] = [];
		const definition = createJobToolDefinition({
			getConfiguredModel: () => settings.getJobModel(),
			getModelOptions: () => settings.getJobModels(),
			runner: async (request) => {
				requests.push(request.model ?? "none");
				request.onMessage(fauxAssistantMessage(`answer ${request.model}`));
				return { exitCode: 0, stderr: "" };
			},
		});
		const cases: Array<{ params: JobToolInput; expected: string[] }> = [
			{ params: { task: "one", model: " CHEAP " }, expected: ["faux/cheap"] },
			{
				params: { tasks: [{ task: "a", model: "faux/cheap" }, { task: "b" }] },
				expected: ["faux/cheap", "faux/default"],
			},
			{
				params: { chain: [{ task: "a", model: "other" }, { task: "use {previous}" }] },
				expected: ["faux/other", "faux/default"],
			},
			{
				params: { model: "cheap", tasks: [{ task: "a" }, { task: "b", model: "other" }] },
				expected: ["faux/cheap", "faux/other"],
			},
		];
		for (const { params, expected } of cases) {
			requests.length = 0;
			const original = structuredClone(params);
			const result = await definition.execute("models", params, undefined, undefined, context);
			expect(requests).toEqual(expected);
			expect(result.details.results.map((entry) => entry.model)).toEqual(expected);
			expect(params).toEqual(original);
		}
		requests.length = 0;
		settings.setJobModel(undefined);
		await definition.execute("env", { task: "env" }, undefined, undefined, context);
		vi.stubEnv("GRIP_DEFAULT_JOB_MODEL", "");
		await definition.execute("parent", { task: "parent" }, undefined, undefined, context);
		expect(requests).toEqual(["faux/other", "faux/parent"]);
	});

	it("validates every explicit selection before running any job", async () => {
		const { context } = await fixture();
		const runner = vi.fn(async () => ({ exitCode: 0, stderr: "" }));
		const definition = createJobToolDefinition({ runner, getModelOptions: () => catalog });
		for (const params of [
			{ task: "unknown", model: "cheap-ish" },
			{ task: "blank", model: "  " },
			{
				tasks: [
					{ task: "valid", model: "cheap" },
					{ task: "unknown", model: "missing" },
				],
			},
			{
				chain: [
					{ task: "valid", model: "cheap" },
					{ task: "unknown", model: "missing" },
				],
			},
		]) {
			const result = await definition.execute("invalid-model", params, undefined, undefined, context);
			expect(result).toMatchObject({ isError: true, details: { results: [] } });
		}
		expect(runner).not.toHaveBeenCalled();
		const ambiguous = createJobToolDefinition({
			runner,
			getModelOptions: () => [catalog[0], { model: "second/cheap", description: "Also cheap" }],
		});
		expect(
			await ambiguous.execute("ambiguous", { task: "ambiguous", model: "cheap" }, undefined, undefined, context),
		).toMatchObject({ isError: true });
		expect(runner).not.toHaveBeenCalled();
	});

	it.each(["single", "parallel", "chain"])(
		"uses selected child models rather than the configured default in %s mode",
		async (mode) => {
			const { harness, session } = await fixture({ jobModel: "faux/default" });
			vi.stubEnv("GRIP_DEFAULT_JOB_MODEL", "faux/parent");
			const params: JobToolInput =
				mode === "single"
					? { task: "inspect", model: "cheap", tools: ["read"] }
					: mode === "parallel"
						? {
								tasks: [
									{ task: "a", model: "cheap", tools: ["read"] },
									{ task: "b", model: "other", tools: ["read"] },
								],
							}
						: {
								chain: [
									{ task: "a", model: "cheap", tools: ["read"] },
									{ task: "use {previous}", model: "other", tools: ["read"] },
								],
							};
			const expected = mode === "single" ? ["faux/cheap"] : ["faux/cheap", "faux/other"];
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("job", params), { stopReason: "toolUse" }),
				...expected.map<FauxResponseFactory>(() => (context, _options, _state, model) => {
					expect(context.tools?.map((tool) => tool.name)).toEqual(["read"]);
					return fauxAssistantMessage(`child ${model.id}`);
				}),
				fauxAssistantMessage("parent answer"),
			]);
			await session.prompt("delegate");
			const results = jobDetails(session.messages).results;
			expect(results.map((result) => result.execution?.model)).toEqual(expected);
			expect(results.every((result) => result.status === "completed")).toBe(true);
			expect(session.model?.id).toBe("parent");
			expect(harness.faux.state.callCount).toBe(expected.length + 2);
		},
	);

	it("keeps the default when model is omitted even with a nonempty catalog", async () => {
		const { harness, session } = await fixture({ jobModel: "faux/default" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("job", { task: "inspect" }), { stopReason: "toolUse" }),
			(_context, _options, _state, model) => {
				expect(model.id).toBe("default");
				return fauxAssistantMessage("child answer");
			},
			fauxAssistantMessage("parent answer"),
		]);
		await session.prompt("delegate");
		expect(jobDetails(session.messages).results[0].execution?.model).toBe("faux/default");
	});

	it("fails unavailable registered selections before preloading or child inference", async () => {
		const { harness, session } = await fixture({
			jobModels: [{ model: "faux/missing", description: "No longer available" }],
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("job", {
					task: "inspect",
					model: "missing",
					tools: ["read"],
					preload: [{ tool: "read", args: { path: "missing.txt" } }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("parent handles failure"),
		]);
		await session.prompt("delegate");
		const result = jobDetails(session.messages).results[0];
		expect(result).toMatchObject({ status: "failed", usage: { turns: 0 } });
		expect(result.stderr).toContain("not an available provider/model-id");
		expect(result.execution).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(2);
	});
});
