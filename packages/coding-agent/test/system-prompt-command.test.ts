import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@greppleai/grip-ai";
import type { AutocompleteProvider } from "@greppleai/grip-tui";
import { Container } from "@greppleai/grip-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { HIDDEN_BUILTIN_SLASH_COMMAND_NAMES } from "../src/core/slash-commands.ts";
import { parseSystemPromptCommand } from "../src/core/system-prompt-command.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

describe("/system-prompt", () => {
	it("parses exact commands, quoted names, and explicit project scope", () => {
		expect(parseSystemPromptCommand("")).toEqual({ action: "main" });
		expect(parseSystemPromptCommand("--subagent worker")).toEqual({
			action: "subagent",
			name: "worker",
			agentScope: "user",
		});
		expect(parseSystemPromptCommand('--subagent "source explorer" --agent-scope project')).toEqual({
			action: "subagent",
			name: "source explorer",
			agentScope: "project",
		});
		for (const invalid of [
			"--subagent",
			"--subagent --agent-scope project",
			'--subagent "open',
			"--subagent worker --agent-scope unknown",
			"--subagent worker extra",
		]) {
			expect(parseSystemPromptCommand(invalid)).toEqual({ action: "invalid" });
		}
		expect(HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has("system-prompt")).toBe(true);
	});

	it("completes bundled and scope-specific project preset names", async () => {
		const cwd = tempDir("grip-prompt-completion-");
		const agentDir = tempDir("grip-prompt-completion-agent-");
		vi.stubEnv("GRIP_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(cwd, ".grip", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".grip", "agents", "review.md"),
			"---\nname: review sources\ndescription: Project-only review\n---\nReview code",
		);
		const settingsManager = SettingsManager.inMemory();
		vi.spyOn(settingsManager, "getEnableSkillCommands").mockReturnValue(false);
		const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
			runtimeHost: {
				session: {
					settingsManager,
					session: { getCwd: () => cwd },
					getToolOperations: () => ({ cwd, getBackendInfo: () => ({ type: "local", cwd }) }),
					promptTemplates: [],
					extensionRunner: { getRegisteredCommands: () => [] },
				},
			},
			skillCommands: new Map(),
			fdPath: null,
		}) as unknown as { createBaseAutocompleteProvider(): AutocompleteProvider };
		const provider = mode.createBaseAutocompleteProvider();
		const complete = async (text: string) => {
			const suggestions = await provider.getSuggestions([text], 0, text.length, {
				signal: new AbortController().signal,
				force: false,
			});
			return suggestions?.items.map(
				(item) => provider.applyCompletion([text], 0, text.length, item, suggestions.prefix).lines[0],
			);
		};
		expect(await complete("/system-prom")).toContain("/system-prompt ");
		expect(await complete("/system-prompt ")).toContain("/system-prompt --subagent ");
		expect(await complete("/system-prompt --subagent rev")).toContain("/system-prompt --subagent reviewer");
		expect(await complete('/system-prompt --subagent "review s')).toContain(
			'/system-prompt --subagent "review sources" --agent-scope project',
		);
	});
	it("renders the current prompt and subagent previews locally without submitting a message", async () => {
		initTheme("dark");
		const chatContainer = new Container();
		const previewSubagentSystemPrompt = vi.fn(async () => "CHILD PROMPT MARKER");
		const showWarning = vi.fn();
		const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
			runtimeHost: { session: { systemPrompt: "MAIN PROMPT MARKER" }, previewSubagentSystemPrompt },
			chatContainer,
			editor: { setText: vi.fn() },
			ui: { requestRender: vi.fn() },
			showWarning,
			showError: vi.fn(),
		}) as unknown as { handleBuiltInEditorCommand(text: string): Promise<boolean> };
		expect(await mode.handleBuiltInEditorCommand("/system-prompt")).toBe(true);
		expect(chatContainer.render(160).join("\n")).toContain("MAIN PROMPT MARKER");
		expect(previewSubagentSystemPrompt).not.toHaveBeenCalled();
		expect(
			await mode.handleBuiltInEditorCommand('/system-prompt --subagent "source explorer" --agent-scope project'),
		).toBe(true);
		expect(previewSubagentSystemPrompt).toHaveBeenCalledWith("source explorer", "project");
		expect(chatContainer.render(160).join("\n")).toContain("CHILD PROMPT MARKER");
		expect(await mode.handleBuiltInEditorCommand("/system-prompt --subagent")).toBe(true);
		expect(showWarning).toHaveBeenCalledOnce();
		expect(previewSubagentSystemPrompt).toHaveBeenCalledOnce();
	});

	it("builds the same generated child prompt in user and project scopes without running a task", async () => {
		const cwd = tempDir("grip-prompt-workspace-");
		const agentDir = tempDir("grip-prompt-config-");
		vi.stubEnv("GRIP_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "agents"));
		mkdirSync(join(cwd, ".grip", "agents"), { recursive: true });
		mkdirSync(join(agentDir, "skills", "prompt-skill"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "prompt-skill", "SKILL.md"),
			"---\nname: prompt-skill\ndescription: Prompt preview regression\ntools: write\n---\nSKILL PROMPT MARKER",
		);
		writeFileSync(
			join(agentDir, "agents", "explore.md"),
			"---\nname: explore\ndescription: User explorer\ntools: read,grep\nskills: prompt-skill\n---\nUSER PROMPT MARKER",
		);
		writeFileSync(
			join(cwd, ".grip", "agents", "explore.md"),
			"---\nname: explore\ndescription: Project explorer\ntools: read\n---\nPROJECT PROMPT MARKER",
		);
		const model = getModel("openai-codex", "gpt-5.6");
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-only-no-requests");
		const pi = await GripAgent.create({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			sessionManager: new InMemorySessionManager(cwd),
			settingsManager: SettingsManager.inMemory(),
		});
		const promptSpy = vi.spyOn(AgentSession.prototype, "prompt");
		try {
			const parent = await pi.createAgentSession();
			parent.registerSessionSkill({
				name: "hidden-guide",
				filePath: "<hidden-guide>",
				description: "User-only hidden skill",
				content: "HIDDEN SKILL INSTRUCTIONS",
				disableModelInvocation: true,
			});
			const userPrompt = await pi.previewSubagentSystemPrompt("explore", "user");
			expect(userPrompt).toContain("You are an expert coding assistant operating inside grip");
			expect(userPrompt).toContain("USER PROMPT MARKER");
			expect(userPrompt).toContain("- grep:");
			expect(userPrompt).toContain("- load_skill:");
			expect(userPrompt).not.toContain("- write:");
			expect(userPrompt).toContain("<available_skills>");
			expect(userPrompt).not.toContain("hidden-guide");
			expect(userPrompt).toContain('<preloaded-skill name="prompt-skill"');
			expect(userPrompt).toContain("SKILL PROMPT MARKER");
			expect(userPrompt).not.toContain("PROJECT PROMPT MARKER");
			expect(userPrompt).toContain(`Current working directory: ${cwd}`);
			const projectPrompt = await pi.previewSubagentSystemPrompt("explore", "project");
			expect(projectPrompt).toContain("PROJECT PROMPT MARKER");
			expect(projectPrompt).toContain("- load_skill:");
			expect(projectPrompt).toContain("<available_skills>");
			expect(projectPrompt).toContain("prompt-skill");
			expect(projectPrompt).not.toContain("USER PROMPT MARKER");
			expect(await pi.previewSubagentSystemPrompt("explore", "both")).toBe(projectPrompt);
			expect(parent.systemPrompt).not.toContain("PROJECT PROMPT MARKER");
			expect(promptSpy).not.toHaveBeenCalled();
			await expect(pi.previewSubagentSystemPrompt("missing", "user")).rejects.toThrow("Unknown subagent");
			const restricted = await GripAgent.create({
				cwd,
				agentDir,
				model,
				authStorage,
				modelRegistry: ModelRegistry.inMemory(authStorage),
				sessionManager: new InMemorySessionManager(cwd),
				settingsManager: SettingsManager.inMemory(),
				tools: ["read", "subagent"],
			});
			try {
				await restricted.createAgentSession();
				const restrictedPrompt = await restricted.previewSubagentSystemPrompt("reviewer");
				expect(restrictedPrompt).not.toContain("- load_skill:");
				expect(restrictedPrompt).not.toContain("<available_skills>");
			} finally {
				await restricted.dispose();
			}
		} finally {
			await pi.dispose();
		}
	});

	it("inherits host and workspace skills from the parent in a remote child", async () => {
		const hostCwd = tempDir("grip-skill-catalog-host-");
		const guestCwd = tempDir("grip-skill-catalog-guest-");
		const agentDir = tempDir("grip-skill-catalog-config-");
		vi.stubEnv("GRIP_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "skills", "host-guide"), { recursive: true });
		mkdirSync(join(guestCwd, ".grip", "skills", "guest-guide"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "host-guide", "SKILL.md"),
			"---\nname: host-guide\ndescription: Local instructions\n---\nHOST PRIVATE INSTRUCTIONS",
		);
		writeFileSync(
			join(guestCwd, ".grip", "skills", "guest-guide", "SKILL.md"),
			"---\nname: guest-guide\ndescription: Remote instructions\n---\nGUEST SKILL INSTRUCTIONS",
		);
		const operations = new LocalToolOperations(guestCwd);
		Object.defineProperty(operations, "getBackendInfo", {
			configurable: true,
			value: () => ({
				type: "remote" as const,
				cwd: guestCwd,
				url: "ws://daemon.test/pi/workspace",
				protocol: "ws" as const,
				configured: true as const,
				workspace: { id: "guest", root: guestCwd, pathFlavor: "posix" as const },
			}),
		});
		const model = getModel("openai-codex", "gpt-5.6");
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-only-no-requests");
		const pi = await GripAgent.create({
			cwd: hostCwd,
			agentDir,
			model,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			sessionManager: new InMemorySessionManager(hostCwd),
			settingsManager: SettingsManager.inMemory(),
			toolOperations: operations,
			resourceLoaderOptions: { toolOperations: operations },
		});
		try {
			const parent = await pi.createAgentSession();
			parent.registerSessionSkill({
				name: "inline-host-guide",
				filePath: "<inline-host-guide>",
				description: "Host-local inline instructions",
				content: "HOST INLINE INSTRUCTIONS",
				disableModelInvocation: false,
			});
			const parentPrompt = parent.systemPrompt;
			expect(parentPrompt).toContain("host-guide");
			expect(parentPrompt).toContain("guest-guide");
			const prompt = await pi.previewSubagentSystemPrompt("reviewer");
			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("guest-guide");
			expect(prompt).toContain("host-guide");
			expect(prompt).toContain("inline-host-guide");
			expect(prompt).not.toContain("HOST PRIVATE INSTRUCTIONS");
			expect(prompt).not.toContain("HOST INLINE INSTRUCTIONS");
		} finally {
			await pi.dispose();
		}
	});
});
