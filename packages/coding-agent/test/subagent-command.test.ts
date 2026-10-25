import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getModel } from "@greppleai/grip-ai";
import type { AutocompleteProvider } from "@greppleai/grip-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { parseSubagentCommand } from "../src/core/subagent-command.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { createSubagentToolDefinition } from "../src/core/tools/subagent.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "grip-subagent-command-"));
	dirs.push(cwd);
	vi.stubEnv("GRIP_CODING_AGENT_DIR", cwd);
	vi.stubEnv("GRIP_DEFAULT_SUBAGENT_MODEL", undefined);
	const manager = SettingsManager.create(cwd, cwd);
	vi.spyOn(manager, "getEnableSkillCommands").mockReturnValue(false);
	const models = [
		{ provider: "openai", id: "gpt-5" },
		{ provider: "anthropic", id: "claude-sonnet" },
	];
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: {
			session: {
				settingsManager: manager,
				session: { getCwd: () => cwd },
				getToolOperations: () => ({ cwd, getBackendInfo: () => ({ type: "local", cwd }) }),
				model: models[0],
				modelRegistry: { getAvailable: () => models },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
			},
		},
		skillCommands: new Map(),
		fdPath: null,
		editor: { setText: vi.fn() },
		showStatus,
		showWarning,
		showError: vi.fn(),
	});
	return {
		mode: mode as unknown as {
			handleBuiltInEditorCommand(text: string): Promise<boolean>;
			createBaseAutocompleteProvider(): AutocompleteProvider;
		},
		manager,
		cwd,
		showStatus,
		showWarning,
	};
}

async function complete(provider: AutocompleteProvider, text: string) {
	const suggestions = await provider.getSuggestions([text], 0, text.length, {
		signal: new AbortController().signal,
		force: false,
	});
	return suggestions?.items.map((item) => ({
		label: item.label,
		text: provider.applyCompletion([text], 0, text.length, item, suggestions.prefix).lines[0],
	}));
}

describe("/subagent command", () => {
	it("strictly parses list and named model get/set", () => {
		expect(parseSubagentCommand("list")).toEqual({ action: "list" });
		expect(parseSubagentCommand("model get --name explore")).toEqual({ action: "get", name: "explore" });
		expect(parseSubagentCommand("model set --model openai/gpt-5 --name worker")).toEqual({
			action: "set",
			name: "worker",
			model: "openai/gpt-5",
		});
		expect(parseSubagentCommand('model get --name "source explorer"')).toEqual({
			action: "get",
			name: "source explorer",
		});
		for (const text of [
			"model get",
			"model get --name",
			"model set --name worker",
			"model get --name x --name y",
			"list extra",
			'model get --name "unfinished',
		]) {
			expect(parseSubagentCommand(text)).toEqual({ action: "invalid" });
		}
	});

	it("lists builtins, persists overrides, and rejects invalid names and models", async () => {
		const { mode, manager, cwd, showStatus, showWarning } = fixture();
		expect(await mode.handleBuiltInEditorCommand("/subagent list")).toBe(true);
		expect(showStatus.mock.lastCall?.[0]).toContain("explore (bundled) — openai/gpt-5");
		expect(showStatus.mock.lastCall?.[0]).toContain("reviewer (bundled)");
		await mode.handleBuiltInEditorCommand("/subagent model set --name worker --model anthropic/claude-sonnet");
		await manager.flush();
		expect(manager.getSubagentModel("worker")).toBe("anthropic/claude-sonnet");
		expect(JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8")).subagentModels).toEqual({
			worker: "anthropic/claude-sonnet",
		});
		expect(SettingsManager.create(cwd, cwd).getSubagentModel("worker")).toBe("anthropic/claude-sonnet");
		await mode.handleBuiltInEditorCommand("/subagent model get --name worker");
		expect(showStatus.mock.lastCall?.[0]).toContain("anthropic/claude-sonnet (configured)");
		await mode.handleBuiltInEditorCommand("/subagent model set --name missing --model openai/gpt-5");
		await mode.handleBuiltInEditorCommand("/subagent model set --name worker --model missing/model");
		expect(showWarning).toHaveBeenCalledTimes(2);
		expect(manager.getSubagentModel("worker")).toBe("anthropic/claude-sonnet");
	});

	it("autocompletes command, subcommands, flags, names, and available models", async () => {
		const { mode } = fixture();
		const provider = mode.createBaseAutocompleteProvider();
		expect((await complete(provider, "/suba"))?.some((item) => item.text === "/subagent ")).toBe(true);
		expect(await complete(provider, "/subagent ")).toEqual([
			{ label: "list", text: "/subagent list" },
			{ label: "model", text: "/subagent model " },
		]);
		expect((await complete(provider, "/subagent model "))?.map((item) => item.label)).toEqual(["get", "set"]);
		expect((await complete(provider, "/subagent model set --model openai/gpt-5 "))?.[0]).toEqual({
			label: "--name",
			text: "/subagent model set --model openai/gpt-5 --name ",
		});
		expect((await complete(provider, "/subagent model get --name rev"))?.[0]).toEqual({
			label: "reviewer",
			text: "/subagent model get --name reviewer",
		});
		expect(
			(await complete(provider, "/subagent model set --name worker --model "))?.map((item) => item.label),
		).toEqual(["openai/gpt-5", "anthropic/claude-sonnet"]);
		expect(await complete(provider, "/subagent model get ")).toEqual([
			{ label: "--name", text: "/subagent model get --name " },
		]);
		expect((await complete(provider, "/subagent model set --name wor"))?.[0]).toEqual({
			label: "worker",
			text: "/subagent model set --name worker",
		});
		expect((await complete(provider, "/subagent model set --name worker "))?.[0]).toEqual({
			label: "--model",
			text: "/subagent model set --name worker --model ",
		});
		expect((await complete(provider, "/subagent model set --name worker --model anthropic/"))?.[0]).toEqual({
			label: "anthropic/claude-sonnet",
			text: "/subagent model set --name worker --model anthropic/claude-sonnet",
		});
	});
	it("completes and configures user presets with spaces in their names", async () => {
		const { mode, cwd, manager } = fixture();
		mkdirSync(join(cwd, "agents"));
		writeFileSync(
			join(cwd, "agents", "source.md"),
			"---\nname: source explorer\ndescription: Source discovery\n---\nFind the relevant source.",
		);
		const provider = mode.createBaseAutocompleteProvider();
		expect((await complete(provider, '/subagent model get --name "source e'))?.[0]).toEqual({
			label: "source explorer",
			text: '/subagent model get --name "source explorer"',
		});
		await mode.handleBuiltInEditorCommand('/subagent model set --name "source explorer" --model openai/gpt-5');
		expect(manager.getSubagentModel("source explorer")).toBe("openai/gpt-5");
	});
	it("uses a configured preset model for the next delegated run ahead of the environment default", async () => {
		const { manager, cwd } = fixture();
		manager.setSubagentModel("worker", "anthropic/claude-sonnet");
		vi.stubEnv("GRIP_DEFAULT_SUBAGENT_MODEL", "openai-codex/gpt-5.6-luna");
		const requests: string[] = [];
		const tool = createSubagentToolDefinition({
			getConfiguredModel: (name) => manager.getSubagentModel(name),
			runner: async (request) => {
				requests.push(`${request.agent}: ${request.model}`);
				request.onMessage(fauxAssistantMessage("done"));
				return { exitCode: 0, stderr: "" };
			},
		});
		const context = {
			cwd,
			toolOperations: new LocalToolOperations(cwd),
			hasUI: false,
			model: getModel("openai-codex", "gpt-5.6"),
		} as unknown as ExtensionContext;
		await tool.execute("named", { agent: "worker", task: "Implement one change" }, undefined, undefined, context);
		await tool.execute("other", { agent: "explore", task: "Find one entrypoint" }, undefined, undefined, context);
		expect(requests).toEqual(["worker: anthropic/claude-sonnet", "explore: openai-codex/gpt-5.6-luna"]);
	});
});
