import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	registerFauxProvider,
	type TextContent,
} from "@greppleai/grip-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES, getDefaultActiveToolNames } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import {
	createSubagentToolDefinition,
	formatSubagentTaskPrompt,
	subagentParamsSchema,
} from "../src/core/tools/subagent.ts";
import { discoverAgents, discoverAgentsWithOperations } from "../src/core/tools/subagent-agents.ts";
import { createHarness } from "./suite/harness.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalSubagentModel = process.env.GRIP_DEFAULT_SUBAGENT_MODEL;

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	if (originalSubagentModel === undefined) delete process.env.GRIP_DEFAULT_SUBAGENT_MODEL;
	else process.env.GRIP_DEFAULT_SUBAGENT_MODEL = originalSubagentModel;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native subagent tool", () => {
	it("registers and activates subagents by default, with an explicit opt-out", () => {
		const cwd = createTempDir("pi-subagent-tools-");
		const definitions = createAllToolDefinitions(new LocalToolOperations(cwd));
		expect(definitions.subagent.name).toBe("subagent");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("subagent");
		expect(getDefaultActiveToolNames()).toContain("subagent");
		expect(getDefaultActiveToolNames(false)).not.toContain("subagent");
	});

	it("activates the subagent tool without configuring settings", async () => {
		const cwd = createTempDir("pi-subagent-enabled-");
		const pi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.getActiveToolNames()).toContain("subagent");
		} finally {
			await pi.dispose();
		}
	});
	it("shows effective default and approval-gated project presets, and refreshes them on reload", async () => {
		const cwd = createTempDir("pi-subagent-catalog-cwd-");
		const agentDir = createTempDir("pi-subagent-catalog-agent-");
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		mkdirSync(join(cwd, ".grip", "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "explore.md"),
			'---\nname: explore\ndescription: User map & <survey> "sources"\n---\nUSER PRIVATE PROMPT',
		);
		writeFileSync(
			join(cwd, ".grip", "agents", "explore.md"),
			"---\nname: explore\ndescription: Project explorer\n---\nPROJECT PRIVATE PROMPT",
		);
		const pi = await GripAgent.create({
			cwd,
			agentDir,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
		});
		try {
			const session = await pi.createAgentSession();
			const prompt = session.systemPrompt;
			expect(prompt).toContain(
				'<subagent name="explore" source="user" agentScope="user" description="User map &amp; &lt;survey&gt; &quot;sources&quot;" />',
			);
			expect(prompt).toContain(
				'<subagent name="explore" source="project" agentScope="project" description="Project explorer" />',
			);
			expect(prompt).toContain('<subagent name="worker" source="bundled" agentScope="user"');
			expect(prompt).toContain("Implement a bounded coding slice, add or update tests, run focused checks");
			expect(prompt).toContain("Listing them does not grant approval");
			expect(prompt).toContain("With agentScope both, a project preset overrides");
			expect(prompt.indexOf("## Skills")).toBeLessThan(prompt.indexOf("## Subagents"));
			expect(prompt.indexOf("<available_subagents>")).toBeLessThan(prompt.indexOf("## Subagents"));
			expect(prompt).not.toContain("USER PRIVATE PROMPT");
			expect(prompt).not.toContain("PROJECT PRIVATE PROMPT");

			writeFileSync(
				join(agentDir, "agents", "map.md"),
				"---\nname: map\ndescription: Map recent changes\n---\nMap instructions",
			);
			expect(session.systemPrompt).not.toContain('<subagent name="map"');
			await session.reload();
			expect(session.systemPrompt).toContain(
				'<subagent name="map" source="user" agentScope="user" description="Map recent changes" />',
			);
		} finally {
			await pi.dispose();
		}
	});

	it("applies runtime setting changes to active tools and the available subagent catalog", async () => {
		const cwd = createTempDir("pi-subagent-toggle-");
		const pi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.subagentsEnabled).toBe(true);
			expect(session.getActiveToolNames()).toContain("subagent");
			expect(session.getToolDefinition("subagent")).toBeDefined();
			expect(session.systemPrompt).toContain("<available_subagents>");
			expect(session.systemPrompt).toContain("## Subagents");
			expect(session.systemPrompt).not.toContain("## Skills");
			expect(session.systemPrompt).toContain('<subagent name="explore" source="bundled" agentScope="user"');

			session.setSubagentsEnabled(false);
			expect(session.subagentsEnabled).toBe(false);
			expect(session.getActiveToolNames()).not.toContain("subagent");
			expect(session.systemPrompt).not.toContain("<available_subagents>");

			session.setSubagentsEnabled(true);
			expect(session.subagentsEnabled).toBe(true);
			expect(session.getActiveToolNames()).toContain("subagent");
			expect(session.systemPrompt).toContain("<available_subagents>");
		} finally {
			await pi.dispose();
		}
	});

	it("applies settings file changes on reload", async () => {
		const cwd = createTempDir("pi-subagent-reload-");
		const agentDir = createTempDir("pi-subagent-reload-config-");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ enableSubagents: false }));
		const pi = await GripAgent.create({
			cwd,
			agentDir,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.create(cwd, agentDir),
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.getActiveToolNames()).not.toContain("subagent");

			writeFileSync(settingsPath, JSON.stringify({ enableSubagents: true }));
			await session.reload();
			expect(session.getActiveToolNames()).toContain("subagent");
			expect(session.systemPrompt).toContain("<available_subagents>");

			writeFileSync(settingsPath, JSON.stringify({ enableSubagents: false }));
			await session.reload();
			expect(session.getActiveToolNames()).not.toContain("subagent");
			expect(session.systemPrompt).not.toContain("<available_subagents>");
		} finally {
			await pi.dispose();
		}
	});

	it("lets explicit tool allowlists enable the subagent tool", async () => {
		const cwd = createTempDir("pi-subagent-allowlist-");
		const pi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
			tools: ["subagent"],
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.getActiveToolNames()).toEqual(["subagent"]);
			session.setSubagentsEnabled(false);
			expect(session.getActiveToolNames()).toEqual(["subagent"]);
		} finally {
			await pi.dispose();
		}
	});

	it("preserves exclusions when subagents are enabled", async () => {
		const cwd = createTempDir("pi-subagent-subset-");
		const pi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory({ enableSubagents: true }),
			excludedTools: ["subagent"],
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.getActiveToolNames()).not.toContain("subagent");
			expect(session.systemPrompt).not.toContain("<available_subagents>");
		} finally {
			await pi.dispose();
		}
	});

	it("keeps empty and no-tools modes authoritative without removing custom tools from builtin-only mode", async () => {
		const cwd = createTempDir("pi-subagent-no-tools-");
		const emptyPi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory({ enableSubagents: true }),
			tools: [],
		});
		try {
			const session = await emptyPi.createAgentSession();
			expect(session.getActiveToolNames()).toEqual([]);
			expect(session.systemPrompt).not.toContain("<available_subagents>");
		} finally {
			await emptyPi.dispose();
		}

		const customTool = {
			name: "custom",
			label: "Custom",
			description: "Custom tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "custom" }], details: {} }),
		};
		const builtinOnlyPi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory({ enableSubagents: true }),
			customTools: [customTool],
			noTools: "builtin",
		});
		try {
			const session = await builtinOnlyPi.createAgentSession();
			expect(session.getActiveToolNames()).toEqual(["custom"]);
			expect(session.systemPrompt).not.toContain("<available_subagents>");
		} finally {
			await builtinOnlyPi.dispose();
		}

		const noToolsPi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory({ enableSubagents: true }),
			customTools: [customTool],
			noTools: "all",
		});
		try {
			const session = await noToolsPi.createAgentSession();
			expect(session.getActiveToolNames()).toEqual([]);
			expect(session.systemPrompt).not.toContain("<available_subagents>");
		} finally {
			await noToolsPi.dispose();
		}
	});

	it("does not advertise built-in presets when a custom tool overrides subagent", async () => {
		const cwd = createTempDir("pi-subagent-custom-tool-");
		const pi = await GripAgent.create({
			cwd,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
			customTools: [
				{
					name: "subagent",
					label: "Custom",
					description: "Different subagent implementation",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text" as const, text: "custom" }], details: {} }),
				},
			],
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.getActiveToolNames()).toContain("subagent");
			expect(session.getToolDefinition("subagent")?.description).toBe("Different subagent implementation");
			expect(session.systemPrompt).not.toContain("<available_subagents>");
		} finally {
			await pi.dispose();
		}
	});

	it("keeps subagent tools inactive by default without an embedded runner", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("subagent");
		} finally {
			harness.cleanup();
		}
	});

	it("does not activate subagent tools when enabled without an embedded runner", async () => {
		const harness = await createHarness({ settings: { enableSubagents: true } });
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("subagent");
		} finally {
			harness.cleanup();
		}
	});

	it("reports a configuration error when no embedded runner is available", async () => {
		const cwd = createTempDir("pi-subagent-no-runner-");
		const result = await createSubagentToolDefinition().execute(
			"call-no-runner",
			{ task: "inspect" },
			undefined,
			undefined,
			{ cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false } as unknown as ExtensionContext,
		);
		expect(result.content).toEqual([{ type: "text", text: "Subagent runner is not configured for this session." }]);
	});

	it("fails closed before discovery when workspace operations are missing", async () => {
		const cwd = createTempDir("pi-subagent-missing-operations-");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "escape.md"),
			"---\nname: escape\ndescription: Must not load\n---\nHost instructions.",
		);
		const runner = vi.fn();
		const result = await createSubagentToolDefinition({ runner }).execute(
			"call-missing-operations",
			{ task: "inspect", agentScope: "project", agent: "escape" },
			undefined,
			undefined,
			{ cwd, hasUI: false } as unknown as ExtensionContext,
		);
		expect(result.content).toEqual([{ type: "text", text: "Subagents require explicit workspace tool operations." }]);
		expect(runner).not.toHaveBeenCalled();
	});

	it("discovers daemon project presets through the borrowed workspace backend", async () => {
		const cwd = createTempDir("pi-subagent-daemon-");
		mkdirSync(join(cwd, ".grip", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".grip", "agents", "remote.md"),
			"---\nname: remote\ndescription: Remote project preset\ntools: read\n---\nRemote instructions.",
		);
		const operations = new LocalToolOperations(cwd);
		Object.defineProperty(operations, "getBackendInfo", {
			value: () => ({
				type: "remote",
				cwd,
				url: "ws://daemon.test/pi/workspace",
				protocol: "ws",
				configured: true,
				workspace: { id: "subagent-workspace", root: cwd, pathFlavor: "posix" },
			}),
		});
		const discovery = await discoverAgentsWithOperations(
			createTempDir("pi-subagent-local-cwd-"),
			"project",
			operations,
		);
		expect(discovery.projectAgentsDir).toBe(join(cwd, ".grip", "agents"));
		expect(discovery.agents).toEqual([
			expect.objectContaining({
				name: "remote",
				source: "project",
				systemPrompt: "Remote instructions.",
				tools: ["read"],
			}),
		]);
	});

	it("uses the remote workspace catalog and removes it when the backend is unavailable", async () => {
		const hostCwd = createTempDir("pi-subagent-catalog-host-");
		const guestCwd = createTempDir("pi-subagent-catalog-guest-");
		const agentDir = createTempDir("pi-subagent-catalog-remote-config-");
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(hostCwd, ".grip", "agents"), { recursive: true });
		mkdirSync(join(guestCwd, ".grip", "agents"), { recursive: true });
		writeFileSync(
			join(hostCwd, ".grip", "agents", "host.md"),
			"---\nname: host\ndescription: Should not be discovered\n---\nHost prompt",
		);
		writeFileSync(
			join(guestCwd, ".grip", "agents", "guest.md"),
			"---\nname: guest\ndescription: Remote workspace scout\n---\nGuest prompt",
		);
		let configured = true;
		const operations = new LocalToolOperations(guestCwd);
		Object.defineProperty(operations, "getBackendInfo", {
			configurable: true,
			value: () =>
				configured
					? {
							type: "remote" as const,
							cwd: guestCwd,
							url: "ws://daemon.test/pi/workspace",
							protocol: "ws" as const,
							configured: true as const,
							workspace: { id: "guest", root: guestCwd, pathFlavor: "posix" as const },
						}
					: { type: "remote" as const, cwd: guestCwd, configured: false as const },
		});
		const pi = await GripAgent.create({
			cwd: hostCwd,
			agentDir,
			sessionManager: new InMemorySessionManager(hostCwd),
			settingsManager: SettingsManager.inMemory(),
			toolOperations: operations,
			resourceLoaderOptions: { toolOperations: operations },
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.systemPrompt).toContain('<subagent name="guest" source="project" agentScope="project"');
			expect(session.systemPrompt).not.toContain('<subagent name="host"');
			configured = false;
			await session.reload();
			expect(session.systemPrompt).toContain("No named presets are available for the current backend.");
			expect(session.systemPrompt).not.toContain('<subagent name="guest"');
		} finally {
			await pi.dispose();
		}
	});

	it("bundles default agents and lets user definitions override them", () => {
		const cwd = createTempDir("pi-subagent-cwd-");
		const agentDir = createTempDir("pi-subagent-config-");
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "explore.md"),
			[
				"---",
				"name: explore",
				"description: User explorer",
				"tools: read",
				"model: unused/model",
				"modelHint: cheapest",
				"---",
				"Custom explore prompt.",
			].join("\n"),
		);

		const discovery = discoverAgents(cwd, "user");
		expect(discovery.agents.map((agent) => agent.name)).toEqual(["explore", "worker", "reviewer"]);
		expect(discovery.agents.find((agent) => agent.name === "explore")).toMatchObject({
			description: "User explorer",
			source: "user",
			systemPrompt: "Custom explore prompt.",
		});
		expect(discovery.agents.every((agent) => !("model" in agent) && !("modelHint" in agent))).toBe(true);
	});

	it("supports ad-hoc personas, output contracts, and tool restrictions without model selection", () => {
		const definition = createSubagentToolDefinition();
		expect(definition.description).toContain("bounded, clearly specified job");
		expect(definition.description).toContain("Select a discovered preset by name");
		expect(definition.description).not.toContain("Use explore for focused codebase investigation");
		expect(definition.promptGuidelines).toBeUndefined();
		const properties = subagentParamsSchema.properties;
		expect(properties.responseFormat).toBeDefined();
		expect(properties.systemPrompt).toBeDefined();
		expect(properties.tools).toBeDefined();
		expect(properties.skills).toBeDefined();
		expect("model" in properties).toBe(false);
		expect("modelHint" in properties).toBe(false);
		expect("continueSession" in properties).toBe(false);
		expect("confirmProjectAgents" in properties).toBe(false);
		for (const item of [properties.tasks.items.properties, properties.chain.items.properties]) {
			expect(item.agent).toBeDefined();
			expect(item.tools).toBeDefined();
			expect("model" in item).toBe(false);
			expect("modelHint" in item).toBe(false);
		}
		expect(formatSubagentTaskPrompt("Inspect auth", "Return files and risks")).toBe(
			"<task>\nInspect auth\n</task>\n\n<response-format>\nReturn files and risks\n</response-format>",
		);
	});

	it("requires host approval for project presets and fails closed without a UI", async () => {
		const cwd = createTempDir("pi-subagent-project-trust-");
		mkdirSync(join(cwd, ".grip", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".grip", "agents", "project.md"),
			["---", "name: project", "description: Project preset", "---", "Project-controlled prompt."].join("\n"),
		);
		let runnerCalls = 0;
		const runner = async () => {
			runnerCalls++;
			return { exitCode: 0, stderr: "" };
		};

		const untrustedResult = await createSubagentToolDefinition({ runner }).execute(
			"call-project-untrusted",
			{ agentScope: "project", agent: "project", task: "inspect" },
			undefined,
			undefined,
			{ cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false } as unknown as ExtensionContext,
		);
		expect(untrustedResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("require host approval"),
		});
		expect(runnerCalls).toBe(0);

		let confirmationCalls = 0;
		await createSubagentToolDefinition({ runner }).execute(
			"call-project-approved",
			{ agentScope: "project", agent: "project", task: "inspect" },
			undefined,
			undefined,
			{
				cwd,
				toolOperations: new LocalToolOperations(cwd),
				hasUI: true,
				ui: {
					confirm: async () => {
						confirmationCalls++;
						return true;
					},
				},
			} as unknown as ExtensionContext,
		);
		expect(confirmationCalls).toBe(1);
		expect(runnerCalls).toBe(1);

		const trustedResult = await createSubagentToolDefinition({ runner, trustProjectAgents: true }).execute(
			"call-project-trusted",
			{ agentScope: "project", agent: "project", task: "inspect" },
			undefined,
			undefined,
			{ cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false } as unknown as ExtensionContext,
		);
		expect(runnerCalls).toBe(2);
		expect(trustedResult.content[0]).toMatchObject({ type: "text", text: "(no output)" });
	});

	it("uses an injected in-process runner without invoking the CLI", async () => {
		const cwd = createTempDir("pi-subagent-embedded-");
		let receivedPrompt = "";
		let receivedModel: string | undefined;
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				receivedPrompt = request.prompt;
				receivedModel = request.model;
				request.onMessage(fauxAssistantMessage("embedded result"));
				return { exitCode: 0, stderr: "" };
			},
		});
		delete process.env.GRIP_DEFAULT_SUBAGENT_MODEL;
		const model = getModel("openai-codex", "gpt-5.6");
		const result = await definition.execute(
			"call-embedded",
			{ task: "Inspect auth", tools: ["read"] },
			undefined,
			undefined,
			{ cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false, model } as unknown as ExtensionContext,
		);

		expect(receivedPrompt).toBe("<task>\nInspect auth\n</task>");
		expect(receivedModel).toBe("openai-codex/gpt-5.6");
		expect(result.content).toEqual([{ type: "text", text: "embedded result" }]);
		expect(result.details.results[0]).toMatchObject({ status: "completed", exitCode: 0 });
		process.env.GRIP_DEFAULT_SUBAGENT_MODEL = "openai-codex/gpt-5.6-luna";
		const configuredResult = await definition.execute(
			"call-configured-model",
			{ task: "Review auth" },
			undefined,
			undefined,
			{ cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false, model } as unknown as ExtensionContext,
		);
		expect(receivedModel).toBe("openai-codex/gpt-5.6-luna");
		expect(configuredResult.details.results[0].model).toBe("openai-codex/gpt-5.6-luna");
	});

	it("combines final assistant text blocks while building presentation state incrementally", async () => {
		const cwd = createTempDir("pi-subagent-presentation-");
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				const message = fauxAssistantMessage("first block");
				message.content.push({ type: "text", text: "second block" });
				request.onMessage(message);
				return { exitCode: 0, stderr: "" };
			},
		});
		const result = await definition.execute("call-presentation", { task: "respond" }, undefined, undefined, {
			cwd,
			toolOperations: new LocalToolOperations(cwd),
			hasUI: false,
		} as unknown as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "first block\nsecond block" }]);
	});

	it("bounds retained output across parallel tasks", async () => {
		const cwd = createTempDir("pi-subagent-bounded-");
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				for (let index = 0; index < 12; index++) {
					request.onMessage({
						role: "toolResult",
						toolCallId: `call-${index}`,
						toolName: "read",
						content: [{ type: "text", text: "x".repeat(100_000) }],
						details: { raw: "y".repeat(100_000) },
						isError: false,
						timestamp: Date.now(),
					});
				}
				request.onMessage(fauxAssistantMessage("bounded final output"));
				return { exitCode: 0, stderr: "" };
			},
		});
		const result = await definition.execute(
			"call-bounded",
			{ tasks: [{ task: "one" }, { task: "two" }] },
			undefined,
			undefined,
			{ cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false } as unknown as ExtensionContext,
		);

		expect(result.details.results).toHaveLength(2);
		for (const taskResult of result.details.results) {
			expect(JSON.stringify(taskResult.messages).length).toBeLessThan(300_000);
			expect(taskResult.messages.length).toBeLessThan(12);
			expect(taskResult.status).toBe("completed");
		}
	});

	it("returns structured partial results and does not start queued tasks when aborted", async () => {
		const cwd = createTempDir("pi-subagent-abort-");
		const controller = new AbortController();
		let runnerCalls = 0;
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				runnerCalls++;
				request.onMessage(fauxAssistantMessage("partial output"));
				controller.abort();
				throw new Error("runner aborted");
			},
		});
		const tasks = Array.from({ length: 8 }, (_, index) => ({ task: `task ${index}` }));
		const result = await definition.execute("call-abort", { tasks }, controller.signal, undefined, {
			cwd,
			toolOperations: new LocalToolOperations(cwd),
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(runnerCalls).toBe(1);
		expect(result.details.results).toHaveLength(8);
		expect(result.details.results.every((taskResult) => taskResult.status === "failed")).toBe(true);
		expect(result.details.results.every((taskResult) => taskResult.stopReason === "aborted")).toBe(true);
		expect(result.details.results[0].messages).toHaveLength(1);
		expect(result.details.results[0].messages[0]).toMatchObject({ role: "assistant" });
	});

	it("runs fresh embedded subagents with the configured model and the parent's tool ceiling", async () => {
		const cwd = createTempDir("pi-subagent-pi-agent-");
		const agentDir = createTempDir("pi-subagent-pi-agent-config-");
		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1.0-alpha", reasoning: true },
				{ id: "faux-2.0-beta", reasoning: true },
			],
		});
		const model = faux.getModel("faux-1.0-alpha")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		let childToolNames: string[] = [];
		let childUserText = "";
		let childModelId = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { task: "Return child output", tools: ["read", "bash"] }), {
				stopReason: "toolUse",
			}),
			(context, _options, _state, selectedModel) => {
				childModelId = selectedModel.id;
				childToolNames = context.tools?.map((tool) => tool.name) ?? [];
				const user = context.messages.find((message) => message.role === "user");
				childUserText =
					user?.role === "user" && Array.isArray(user.content)
						? user.content
								.filter((part): part is TextContent => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("child output");
			},
			fauxAssistantMessage("parent output"),
		]);
		const settingsManager = SettingsManager.inMemory({ enableSubagents: true });
		const pi = await GripAgent.create({
			cwd,
			agentDir,
			sessionManager: new InMemorySessionManager(cwd),
			authStorage,
			modelRegistry,
			settingsManager,
			model,
			scopedModels: [{ model }],
			tools: ["read", "subagent"],
		});
		try {
			process.env.GRIP_DEFAULT_SUBAGENT_MODEL = `${model.provider}/faux-2.0-beta`;
			const session = await pi.createAgentSession();
			await session.prompt("delegate");
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			const toolText =
				toolResult?.role === "toolResult"
					? toolResult.content
							.filter((part): part is TextContent => part.type === "text")
							.map((part) => part.text)
							.join("\n")
					: "";
			expect(toolText).toBe("child output");
			expect(childToolNames).toContain("read");
			expect(childToolNames).not.toContain("bash");
			expect(childToolNames).not.toContain("write");
			expect(childToolNames).not.toContain("edit");
			expect(childModelId).toBe("faux-2.0-beta");
			expect(childToolNames).not.toContain("subagent");
			expect(childUserText).toBe("<task>\nReturn child output\n</task>");
			expect(session.messages.at(-1)).toMatchObject({ role: "assistant" });
			expect(faux.state.callCount).toBe(3);
			expect(session.getToolDefinition("subagent")?.parameters).toBeDefined();
			await session.setModel(faux.getModel("faux-2.0-beta")!);
			expect(session.getToolDefinition("subagent")?.parameters).toBeDefined();

			delete process.env.GRIP_DEFAULT_SUBAGENT_MODEL;
			faux.appendResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { task: "Second bounded job" }), {
					stopReason: "toolUse",
				}),
				(context, _options, _state, selectedModel) => {
					expect(selectedModel.id).toBe("faux-2.0-beta");
					expect(JSON.stringify(context.messages)).toContain("Second bounded job");
					expect(JSON.stringify(context.messages)).not.toContain("Return child output");
					return fauxAssistantMessage("fresh child output");
				},
				fauxAssistantMessage("parent finished"),
			]);
			await session.prompt("delegate another job");
			expect(faux.state.callCount).toBe(6);

			process.env.GRIP_DEFAULT_SUBAGENT_MODEL = `${model.provider}/definitely-not-a-model`;
			faux.appendResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { task: "Model should fail" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("parent handled error"),
			]);
			await session.prompt("delegate with an invalid default model");
			expect(faux.state.callCount).toBe(8);
			expect(JSON.stringify(session.messages.filter((message) => message.role === "toolResult").at(-1))).toContain(
				"GRIP_DEFAULT_SUBAGENT_MODEL",
			);
			settingsManager.setSubagentModel("worker", `${model.provider}/faux-1.0-alpha`);
			faux.appendResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "Use preset model" }), {
					stopReason: "toolUse",
				}),
				(_context, _options, _state, selectedModel) => {
					expect(selectedModel.id).toBe("faux-1.0-alpha");
					return fauxAssistantMessage("configured child output");
				},
				fauxAssistantMessage("parent handled configured output"),
			]);
			await session.prompt("delegate with a named override despite invalid env");
			expect(faux.state.callCount).toBe(11);
			settingsManager.setSubagentModel("worker", `${model.provider}/missing-model`);
			faux.appendResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "Should fail" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("parent handled named error"),
			]);
			await session.prompt("delegate with an unavailable configured preset model");
			expect(faux.state.callCount).toBe(13);
			expect(JSON.stringify(session.messages.filter((message) => message.role === "toolResult").at(-1))).toContain(
				"subagentModels",
			);
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});

	it("lets a child load a parent-visible skill on demand while preserving explicit tool limits", async () => {
		const cwd = createTempDir("pi-subagent-skill-workspace-");
		const agentDir = createTempDir("pi-subagent-skill-config-");
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(agentDir, "skills", "child-guide"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "child-guide", "SKILL.md"),
			"---\nname: child-guide\ndescription: Guidance for a delegated worker\n---\nCHILD SKILL INSTRUCTIONS",
		);
		const faux = registerFauxProvider({ models: [{ id: "faux-child-skills", reasoning: true }] });
		const model = faux.getModel("faux-child-skills")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "reviewer", task: "Consult the skill" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toContain("load_skill");
				expect(context.tools?.map((tool) => tool.name)).not.toContain("write");
				expect(context.systemPrompt).toContain("<available_skills>");
				expect(context.systemPrompt).toContain("child-guide");
				expect(context.systemPrompt).not.toContain("CHILD SKILL INSTRUCTIONS");
				return fauxAssistantMessage(fauxToolCall("load_skill", { name: "child-guide" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("CHILD SKILL INSTRUCTIONS");
				return fauxAssistantMessage("skill loaded");
			},
			fauxAssistantMessage("parent received skill result"),
		]);
		const pi = await GripAgent.create({
			cwd,
			agentDir,
			sessionManager: new InMemorySessionManager(cwd),
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			model,
			tools: ["read", "load_skill", "subagent"],
		});
		try {
			const session = await pi.createAgentSession();
			await session.prompt("delegate a focused review");
			expect(faux.state.callCount).toBe(4);
			faux.appendResponses([
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						agent: "reviewer",
						task: "Use only read but preload instructions",
						tools: ["read"],
						skills: ["child-guide"],
					}),
					{ stopReason: "toolUse" },
				),
				(context) => {
					expect(context.tools?.map((tool) => tool.name)).not.toContain("load_skill");
					expect(context.systemPrompt).toContain("CHILD SKILL INSTRUCTIONS");
					return fauxAssistantMessage("forced preload complete");
				},
				fauxAssistantMessage("parent received forced preload result"),
			]);
			await session.prompt("delegate a read-only review");
			expect(faux.state.callCount).toBe(7);
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});
	it("runs only opted-in child extension hooks with fresh state and existing tool limits", async () => {
		const cwd = createTempDir("pi-subagent-opt-in-extensions-");
		const agentDir = createTempDir("pi-subagent-opt-in-config-");
		process.env[ENV_AGENT_DIR] = agentDir;
		const faux = registerFauxProvider({ models: [{ id: "faux-subagent-extensions", reasoning: true }] });
		const model = faux.getModel("faux-subagent-extensions")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		let childFactoryCalls = 0;
		const childFactory = (pi: ExtensionAPI) => {
			childFactoryCalls++;
			pi.on("session_start", () => {
				pi.setActiveTools([...pi.getActiveTools().filter((tool) => tool !== "read"), "write"]);
			});
			pi.on("before_agent_start", (event) => ({
				systemPrompt: `${event.systemPrompt}\n\nCHILD EXTENSION GUIDANCE`,
			}));
			pi.on("tool_call", (event) => {
				if (event.toolName === "bash") return { block: true, reason: "CHILD EXTENSION GUARD" };
			});
		};
		const parentFactory = (pi: ExtensionAPI) => {
			pi.registerSubagentFactory(childFactory);
			pi.registerCommand("parent-only", { handler: async () => {} });
		};
		const unrelatedFactory = (pi: ExtensionAPI) => {
			pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\nUNRELATED EXTENSION` }));
		};
		faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("CHILD EXTENSION GUIDANCE");
				expect(context.systemPrompt).not.toContain("UNRELATED EXTENSION");
				expect(context.tools?.map((tool) => tool.name)).not.toContain("read");
				expect(context.tools?.map((tool) => tool.name)).not.toContain("subagent");
				expect(context.tools?.map((tool) => tool.name)).not.toContain("write");
				expect(context.tools?.map((tool) => tool.name)).not.toContain("grep");
				return fauxAssistantMessage(fauxToolCall("bash", { command: "rg should-not-run" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("CHILD EXTENSION GUARD");
				return fauxAssistantMessage("child result");
			},
		]);
		const pi = await GripAgent.create({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { extensionFactories: [parentFactory, unrelatedFactory] },
			tools: ["read", "bash", "subagent"],
		});
		try {
			const session = await pi.createAgentSession();
			const result = await session
				.getToolDefinition("subagent")!
				.execute("subagent-ext", { agent: "explore", task: "Check extension hooks" }, undefined, undefined, {
					cwd,
					toolOperations: session.getToolOperations(),
					model,
					hasUI: false,
				} as never);
			expect(result.content).toEqual([{ type: "text", text: "child result" }]);
			expect(childFactoryCalls).toBe(1);
			expect(faux.state.callCount).toBe(2);
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});
	it("uses the active sandbox backend when it changes after the parent session starts", async () => {
		const localCwd = createTempDir("pi-subagent-remote-host-cwd-");
		const remoteCwd = join(tmpdir(), "pi-subagent-remote-workspace-does-not-exist");
		rmSync(remoteCwd, { recursive: true, force: true });
		const agentDir = createTempDir("pi-subagent-remote-host-config-");
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(agentDir, "skills", "host-guide"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "host-guide", "SKILL.md"),
			"---\nname: host-guide\ndescription: Host-installed Grepple-style instructions\n---\nHOST SKILL INSTRUCTIONS",
		);
		const hostSkillReferencePath = join(agentDir, "skills", "host-guide", "reference.md");
		writeFileSync(hostSkillReferencePath, "HOST SKILL REFERENCE CONTENT");
		const faux = registerFauxProvider({ models: [{ id: "faux-remote", reasoning: true }] });
		const model = faux.getModel("faux-remote")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		const operations = new LocalToolOperations(localCwd);
		operations.cwd = remoteCwd;
		Object.defineProperty(operations, "getBackendInfo", {
			configurable: true,
			value: () => ({
				type: "remote" as const,
				cwd: remoteCwd,
				url: "ws://sandbox.test/pi/workspace",
				protocol: "ws" as const,
				configured: true as const,
				workspace: { id: "sandbox-workspace", root: remoteCwd, pathFlavor: "posix" as const },
			}),
		});
		const hostPromptPath = join(localCwd, "host-secret.txt");
		writeFileSync(hostPromptPath, "HOST SECRET MUST NOT BE LOADED");
		let childSystemPrompt = "";
		faux.setResponses([
			(context) => {
				childSystemPrompt = context.systemPrompt ?? "";
				expect(childSystemPrompt).toContain("host-guide");
				expect(childSystemPrompt).not.toContain("HOST SKILL INSTRUCTIONS");
				return fauxAssistantMessage(fauxToolCall("load_skill", { name: "host-guide" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("HOST SKILL INSTRUCTIONS");
				return fauxAssistantMessage(fauxToolCall("read", { path: hostSkillReferencePath }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("HOST SKILL REFERENCE CONTENT");
				return fauxAssistantMessage("child output");
			},
			(context) => {
				expect(context.systemPrompt).toContain('<preloaded-skill name="host-guide"');
				expect(context.systemPrompt).toContain("HOST SKILL INSTRUCTIONS");
				expect(context.tools?.map((tool) => tool.name)).not.toContain("load_skill");
				return fauxAssistantMessage("subdir output");
			},
		]);
		const pi = await GripAgent.create({
			cwd: localCwd,
			agentDir,
			sessionManager: new InMemorySessionManager(localCwd),
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			model,
		});
		try {
			const session = await pi.createAgentSession();
			const result = await session
				.getToolDefinition("subagent")!
				.execute(
					"subagent-sandbox",
					{ task: "Return child output", systemPrompt: hostPromptPath },
					undefined,
					undefined,
					{
						cwd: localCwd,
						toolOperations: operations,
						model,
						hasUI: false,
					} as never,
				);
			expect(result.content).toEqual([{ type: "text", text: "child output" }]);
			expect(childSystemPrompt).toContain(hostPromptPath);
			expect(childSystemPrompt).not.toContain("HOST SECRET MUST NOT BE LOADED");
			const subdirectoryResult = await session
				.getToolDefinition("subagent")!
				.execute(
					"subagent-sandbox-subdir",
					{ task: "work in subdir", cwd: join(remoteCwd, "subdir"), skills: ["host-guide"], tools: ["read"] },
					undefined,
					undefined,
					{ cwd: localCwd, toolOperations: operations, model, hasUI: false } as never,
				);
			expect(subdirectoryResult.content).toEqual([{ type: "text", text: "subdir output" }]);
			const mismatchedCwd = await session
				.getToolDefinition("subagent")!
				.execute("subagent-sandbox-cwd", { task: "escape", cwd: localCwd }, undefined, undefined, {
					cwd: localCwd,
					toolOperations: operations,
					model,
					hasUI: false,
				} as never);
			expect(mismatchedCwd.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("Sandboxed subagent cwd must stay within"),
			});
			expect(faux.state.callCount).toBe(4);
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});
	it("fails closed instead of starting subagents on an unconfigured remote backend", async () => {
		const localCwd = createTempDir("pi-subagent-parent-remote-local-");
		const remoteCwd = join(tmpdir(), "pi-subagent-parent-remote-workspace-does-not-exist");
		rmSync(remoteCwd, { recursive: true, force: true });
		const agentDir = createTempDir("pi-subagent-parent-remote-config-");
		const faux = registerFauxProvider({ models: [{ id: "faux-parent-remote", reasoning: true }] });
		const model = faux.getModel("faux-parent-remote")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		const operations = new LocalToolOperations(localCwd);
		operations.cwd = remoteCwd;
		Object.defineProperty(operations, "getBackendInfo", {
			configurable: true,
			value: () => ({ type: "remote" as const, cwd: remoteCwd, configured: false as const }),
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { task: "Return child output" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("child output"),
			fauxAssistantMessage("parent output"),
		]);
		const pi = await GripAgent.create({
			cwd: remoteCwd,
			agentDir,
			sessionManager: new InMemorySessionManager(remoteCwd),
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ enableSubagents: true }),
			model,
			toolOperations: operations,
			resourceLoaderOptions: { toolOperations: operations },
		});
		try {
			const session = await pi.createAgentSession();
			await session.prompt("delegate");
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			const toolText =
				toolResult?.role === "toolResult"
					? toolResult.content
							.filter((part): part is TextContent => part.type === "text")
							.map((part) => part.text)
							.join("\n")
					: "";
			expect(toolText).toContain("Subagents cannot run with an unconfigured remote backend");
			expect(session.messages.at(-1)).toMatchObject({ role: "assistant" });
			expect(faux.state.callCount).toBe(2);
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});

	it("does not discover host project presets for operations without backend identity", async () => {
		const hostCwd = createTempDir("pi-subagent-unknown-host-");
		mkdirSync(join(hostCwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(hostCwd, ".pi", "agents", "escape.md"),
			"---\nname: escape\ndescription: Host preset\n---\nHost instructions.",
		);
		const operations = new LocalToolOperations(createTempDir("pi-subagent-unknown-backend-"));
		Object.defineProperty(operations, "getBackendInfo", { value: undefined });
		const discovery = await discoverAgentsWithOperations(hostCwd, "project", operations);
		expect(discovery).toEqual({ agents: [], projectAgentsDir: null });
	});

	it("rejects ambiguous mode parameters before running a subagent", async () => {
		const cwd = createTempDir("pi-subagent-invalid-");
		const definition = createSubagentToolDefinition();
		const result = await definition.execute(
			"call-1",
			{ agent: "explore", task: "inspect", tasks: [{ agent: "reviewer", task: "review" }] },
			undefined,
			undefined,
			{ cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false } as unknown as ExtensionContext,
		);

		expect(result.content[0]).toMatchObject({ type: "text" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Provide exactly one mode");
		expect(result.details.results).toEqual([]);
	});
});

it("keeps excluded tools hidden from discovery and lifecycle APIs", async () => {
	const cwd = createTempDir("pi-excluded-tool-policy-");
	const secretTool = {
		name: "secret",
		label: "Secret",
		description: "Must remain excluded",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "secret" }], details: {} }),
	};
	const pi = await GripAgent.create({
		cwd,
		sessionManager: new InMemorySessionManager(cwd),
		settingsManager: SettingsManager.inMemory(),
		customTools: [secretTool],
		excludedTools: ["secret"],
	});
	try {
		const session = await pi.createAgentSession();
		session.registerSessionTool(secretTool, { lazy: true });
		session.setActiveToolsByName([...session.getActiveToolNames(), "secret"]);

		expect(session.getAllTools().some((tool) => tool.name === "secret")).toBe(false);
		expect(session.getToolDefinition("secret")).toBeUndefined();
		expect(session.getAvailableSessionTools().some((tool) => tool.name === "secret")).toBe(false);
		expect(session.loadSessionTool("secret")).toBe(false);
		expect(session.getActiveToolNames()).not.toContain("secret");
		expect(session.systemPrompt).not.toContain('name="secret"');
	} finally {
		await pi.dispose();
	}
});
