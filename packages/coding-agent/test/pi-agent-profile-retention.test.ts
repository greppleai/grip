import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@greppleai/grip-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { LocalSessionManager } from "../src/core/session/local-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function createAgent(useHostSettings = false) {
	const root = mkdtempSync(join(tmpdir(), "grip-profile-retention-"));
	tempDirectories.push(root);
	const cwd = join(root, "project");
	const otherCwd = join(root, "other");
	const agentDir = join(root, "agent");
	for (const directory of [cwd, otherCwd, agentDir]) mkdirSync(directory);
	const extension = join(root, "work-extension.mjs");
	writeFileSync(
		extension,
		'export default (grip) => grip.registerCommand("profile-only", { description: "Fixture", handler: async () => {} });',
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			profiles: {
				work: { theme: "light", extensions: [extension], jobModel: "test/work" },
				other: { theme: "dark", extensions: [] },
			},
			profileDirectories: { [otherCwd]: "other" },
			officialExtensions: { autoUpdate: false },
		}),
	);
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const resolvedProfiles: Array<string | undefined> = [];
	const agent = await GripAgent.create({
		cwd,
		agentDir,
		settingsManager: useHostSettings ? SettingsManager.create(cwd, agentDir) : undefined,
		hooks: false,
		authStorage,
		modelRegistry: ModelRegistry.inMemory(authStorage),
		sessionManager: new LocalSessionManager({ cwd, sessionDir: join(root, "sessions") }),
		resourceLoaderOptions: {
			noSkills: true,
			noRules: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
		resolveSessionOptions: ({ services }) => {
			resolvedProfiles.push(services.settingsManager.getActiveProfile());
			return { model };
		},
	});
	return { agent, faux, cwd, otherCwd, agentDir, resolvedProfiles };
}

describe("GripAgent profile retention", () => {
	it.each(["newSession", "switchSession", "fork"] as const)(
		"retains manual selection before resource loading and option resolution across %s",
		async (operation) => {
			const { agent, faux, cwd, agentDir, resolvedProfiles } = await createAgent();
			try {
				const session = await agent.createAgentSession();
				const entryId = session.session.appendMessage({ role: "user", content: "Fixture", timestamp: 1 });
				const reference = session.sessionReference!;
				agent.settingsManager.useProfile("work");
				const previous = agent.settingsManager;
				if (operation === "newSession") await agent.newSession();
				else if (operation === "switchSession") await agent.switchSession(reference);
				else await agent.fork(entryId);
				expect(agent.settingsManager).not.toBe(previous);
				expect(agent.settingsManager.getActiveProfile()).toBe("work");
				expect(agent.settingsManager.getTheme()).toBe("light");
				expect(agent.settingsManager.getJobModel()).toBe("test/work");
				expect(resolvedProfiles.at(-1)).toBe("work");
				expect(agent.resourceLoader.getExtensions().errors).toEqual([]);
				expect(agent.resourceLoader.getExtensions().extensions[0]?.commands.has("profile-only")).toBe(true);
				// A separate launch still follows directory defaults, not another process's manual selection.
				expect(SettingsManager.create(cwd, agentDir).getActiveProfile()).toBeUndefined();
			} finally {
				await agent.dispose();
				faux.unregister();
			}
		},
	);

	it("retains an explicit default selection instead of reapplying a directory rule", async () => {
		const { agent, faux, cwd, agentDir } = await createAgent();
		try {
			await agent.createAgentSession();
			// Adding a directory rule keeps the current default selection for this process.
			agent.settingsManager.setProfileDirectory(cwd, "work");
			await agent.settingsManager.flush();
			expect(SettingsManager.create(cwd, agentDir).getActiveProfile()).toBe("work");
			await agent.newSession();
			expect(agent.settingsManager.getActiveProfile()).toBeUndefined();
		} finally {
			await agent.dispose();
			faux.unregister();
		}
	});

	it("keeps host-supplied settings and their manual selection on replacement", async () => {
		const { agent, faux } = await createAgent(true);
		try {
			await agent.createAgentSession();
			agent.settingsManager.useProfile("work");
			const settings = agent.settingsManager;
			await agent.newSession();
			expect(agent.settingsManager).toBe(settings);
			expect(settings.getActiveProfile()).toBe("work");
		} finally {
			await agent.dispose();
			faux.unregister();
		}
	});

	it.each([false, true])(
		"re-evaluates directory defaults only without manual selection (manual=%s)",
		async (manual) => {
			const { agent, faux, otherCwd } = await createAgent();
			try {
				await agent.createAgentSession();
				if (manual) agent.settingsManager.useProfile("work");
				await agent.changeDirectory(otherCwd);
				expect(agent.settingsManager.getActiveProfile()).toBe(manual ? "work" : "other");
			} finally {
				await agent.dispose();
				faux.unregister();
			}
		},
	);
});
