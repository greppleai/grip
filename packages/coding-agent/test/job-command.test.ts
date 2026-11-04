import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@greppleai/grip-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeJobCommand, parseJobCommand } from "../src/core/job-command.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "grip-job-command-"));
	dirs.push(cwd);
	vi.stubEnv("GRIP_CODING_AGENT_DIR", cwd);
	vi.stubEnv("GRIP_DEFAULT_JOB_MODEL", undefined);
	const manager = SettingsManager.create(cwd, cwd);
	vi.spyOn(manager, "getEnableSkillCommands").mockReturnValue(false);
	const models = [
		{ provider: "openai", id: "gpt-5" },
		{ provider: "anthropic", id: "claude-sonnet" },
	];
	const refreshJobModelCatalog = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: {
			session: {
				settingsManager: manager,
				session: { getCwd: () => cwd },
				getToolOperations: () => ({ cwd }),
				model: models[0],
				modelRegistry: { getAvailable: () => models },
				refreshJobModelCatalog,
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
		refreshJobModelCatalog,
		models,
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

describe("/job model command", () => {
	it("strictly parses show, set, and clear without aliases or per-job names", () => {
		expect(parseJobCommand("model show")).toEqual({ action: "show" });
		expect(parseJobCommand("model set --model openai/gpt-5")).toEqual({ action: "set", model: "openai/gpt-5" });
		expect(parseJobCommand("model clear")).toEqual({ action: "clear" });
		for (const text of [
			"list",
			"model get",
			"model set --name worker --model openai/gpt-5",
			"model set --model openai/gpt-5 --name worker",
			"model clear extra",
			"model set --model",
		]) {
			expect(parseJobCommand(text)).toEqual({ action: "invalid" });
		}
	});

	it("persists the global model, validates choices, shows its source, and clears it", async () => {
		const { mode, manager, cwd, showStatus, showWarning } = fixture();
		await mode.handleBuiltInEditorCommand("/job model show");
		expect(showStatus.mock.lastCall?.[0]).toContain("openai/gpt-5 (parent model)");

		await mode.handleBuiltInEditorCommand("/job model set --model anthropic/claude-sonnet");
		await manager.flush();
		expect(manager.getJobModel()).toBe("anthropic/claude-sonnet");
		expect(JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8")).jobModel).toBe("anthropic/claude-sonnet");
		await mode.handleBuiltInEditorCommand("/job model show");
		expect(showStatus.mock.lastCall?.[0]).toContain("anthropic/claude-sonnet (setting)");

		await mode.handleBuiltInEditorCommand("/job model set --model missing/model");
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("Unavailable job model"));
		expect(manager.getJobModel()).toBe("anthropic/claude-sonnet");

		await mode.handleBuiltInEditorCommand("/job model clear");
		await manager.flush();
		expect(manager.getJobModel()).toBeUndefined();
		expect(JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8"))).not.toHaveProperty("jobModel");
	});

	it("autocompletes only global model operations and available model references", async () => {
		const { mode } = fixture();
		const provider = mode.createBaseAutocompleteProvider();
		expect((await complete(provider, "/job "))?.map(({ label }) => label)).toEqual(["model"]);
		expect((await complete(provider, "/job model "))?.map(({ label }) => label)).toEqual([
			"show",
			"set",
			"clear",
			"add",
			"remove",
		]);
		expect((await complete(provider, "/job model set "))?.[0]).toEqual({
			label: "--model",
			text: "/job model set --model ",
		});
		expect((await complete(provider, "/job model set --model "))?.map(({ label }) => label)).toEqual([
			"openai/gpt-5",
			"anthropic/claude-sonnet",
		]);
		expect(completeJobCommand("  model\tset --mo", [])).toEqual([{ value: "model set --model ", label: "--model" }]);
		expect(completeJobCommand("  mod", [])).toEqual([{ value: "model ", label: "model" }]);
		expect(completeJobCommand("model add openai/gpt-5 ", ["openai/gpt-5"])).toEqual([]);
		expect(completeJobCommand("model show ", ["openai/gpt-5"])).toEqual([]);
	});
	it("parses descriptions and rejects malformed or blank quotes", () => {
		expect(parseJobCommand('model add gpt-5 "fast model"')).toEqual({
			action: "add",
			model: "gpt-5",
			description: "fast model",
		});
		expect(parseJobCommand("model add gpt-5 fast model")).toEqual({
			action: "add",
			model: "gpt-5",
			description: "fast model",
		});
		expect(parseJobCommand("model add gpt-5 don't guess")).toEqual({
			action: "add",
			model: "gpt-5",
			description: "don't guess",
		});
		expect(parseJobCommand('model add gpt-5 "say \\"hello\\" and \\\\ path"')).toEqual({
			action: "add",
			model: "gpt-5",
			description: 'say "hello" and \\ path',
		});
		for (const input of [
			'model add gpt-5 "bad',
			'model add gpt-5 "bad\\"',
			"model add gpt-5 '  '",
			"model remove gpt-5 extra",
		]) {
			expect(parseJobCommand(input)).toEqual({ action: "invalid" });
		}
	});

	it("persists catalog updates without changing the default and refreshes the session", async () => {
		const { mode, manager, cwd, refreshJobModelCatalog, showStatus } = fixture();
		await mode.handleBuiltInEditorCommand("/job model set --model openai/gpt-5");
		await mode.handleBuiltInEditorCommand('/job model add gpt-5 "Fast model"');
		await mode.handleBuiltInEditorCommand("/job model add openai/gpt-5 Updated description");
		expect(manager.getJobModel()).toBe("openai/gpt-5");
		expect(manager.getJobModels()).toEqual([{ model: "openai/gpt-5", description: "Updated description" }]);
		expect(JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8")).jobModels).toEqual(manager.getJobModels());
		await mode.handleBuiltInEditorCommand("/job model show");
		expect(showStatus.mock.lastCall?.[0]).toContain("openai/gpt-5: Updated description");
		await mode.handleBuiltInEditorCommand("/job model remove gpt-5");
		expect(manager.getJobModels()).toEqual([]);
		expect(manager.getJobModel()).toBe("openai/gpt-5");
		expect(refreshJobModelCatalog).toHaveBeenCalledTimes(3);
	});

	it("rejects unavailable and ambiguous models and completes stale registered choices", async () => {
		const { mode, manager, models, showWarning, showStatus } = fixture();
		models.push({ provider: "other", id: "gpt-5" });
		await mode.handleBuiltInEditorCommand("/job model add gpt-5 ambiguous");
		await mode.handleBuiltInEditorCommand("/job model add missing/model nope");
		expect(showWarning).toHaveBeenCalledTimes(2);
		expect(manager.getJobModels()).toEqual([]);
		manager.setJobModels([{ model: "old/luna", description: "stale" }]);
		await manager.flush();
		const provider = mode.createBaseAutocompleteProvider();
		expect((await complete(provider, "/job model remove "))?.map(({ label }) => label)).toEqual(["old/luna"]);
		expect(await complete(provider, "/job model add openai/gpt-5 description ")).toBeUndefined();
		await mode.handleBuiltInEditorCommand("/job model show");
		expect(showStatus.mock.lastCall?.[0]).toContain("old/luna (unavailable): stale");
		await mode.handleBuiltInEditorCommand("/job model remove luna");
		expect(manager.getJobModels()).toEqual([]);
	});
	it("isolates profile catalog changes from global settings", async () => {
		const { mode, manager, cwd } = fixture();
		await mode.handleBuiltInEditorCommand("/job model add gpt-5 global model");
		manager.setModelProfile("work", []);
		await manager.flush();
		manager.useProfile("work");
		await mode.handleBuiltInEditorCommand("/job model add claude-sonnet profile model");
		const saved = JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8"));
		expect(saved.jobModels).toEqual([{ model: "openai/gpt-5", description: "global model" }]);
		expect(saved.profiles.work.jobModels).toEqual([
			{ model: "openai/gpt-5", description: "global model" },
			{ model: "anthropic/claude-sonnet", description: "profile model" },
		]);
	});

	it("does not refresh after a load or save error", async () => {
		const { mode, manager, refreshJobModelCatalog } = fixture();
		const load = vi.spyOn(manager, "getLoadError").mockReturnValue(new Error("load failed"));
		await mode.handleBuiltInEditorCommand("/job model add gpt-5 description");
		expect(manager.getJobModels()).toEqual([]);
		load.mockReturnValue(null);
		vi.spyOn(manager, "drainErrors").mockReturnValue([{ scope: "global", error: new Error("save failed") }]);
		await mode.handleBuiltInEditorCommand("/job model add gpt-5 description");
		expect(refreshJobModelCatalog).not.toHaveBeenCalled();
	});
});
