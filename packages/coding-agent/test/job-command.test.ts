import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutocompleteProvider } from "@greppleai/grip-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseJobCommand } from "../src/core/job-command.ts";
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
		expect((await complete(provider, "/job model "))?.map(({ label }) => label)).toEqual(["show", "set", "clear"]);
		expect((await complete(provider, "/job model set "))?.[0]).toEqual({
			label: "--model",
			text: "/job model set --model ",
		});
		expect((await complete(provider, "/job model set --model "))?.map(({ label }) => label)).toEqual([
			"openai/gpt-5",
			"anthropic/claude-sonnet",
		]);
	});
});
