import { realpathSync } from "node:fs";
import type { ThinkingLevel } from "@greppleai/grip-agent-core";
import { type Api, type Model, registerFauxProvider } from "@greppleai/grip-ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type InteractiveModePrototype = {
	handleProfileCommand(this: ProfileCommandContext, text: string): Promise<void>;
};

interface ProfileCommandSession {
	scopedModels: ReadonlyArray<ScopedModel>;
	modelRegistry: ModelRegistry;
	model?: Model<Api>;
	isStreaming?: boolean;
	isCompacting?: boolean;
	setScopedModels: (models: ScopedModel[]) => void;
	setModel: (model: Model<Api>) => Promise<void>;
	setThinkingLevel: (level: ThinkingLevel) => void;
}

interface ProfileCommandUi {
	requestRender: () => void;
}

interface ProfileCommandContext {
	session: ProfileCommandSession;
	settingsManager: SettingsManager;
	updateAvailableProviderCount: () => Promise<void>;
	handleReloadCommand: () => Promise<boolean>;
	ui: ProfileCommandUi;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /profile", () => {
	it("snapshots the current scope and restores it by name", async () => {
		const faux = registerFauxProvider();
		try {
			const model = faux.getModel();
			const modelRegistry = { getAvailable: () => [model] } as unknown as ModelRegistry;
			const settingsManager = SettingsManager.inMemory();
			const setScopedModels = vi.fn();
			const context: ProfileCommandContext = {
				session: {
					scopedModels: [{ model, thinkingLevel: "high" }],
					modelRegistry,
					setScopedModels,
					setModel: vi.fn(async () => {}),
					setThinkingLevel: vi.fn(),
				},
				settingsManager,
				updateAvailableProviderCount: vi.fn(async () => {}),
				handleReloadCommand: vi.fn(async () => true),
				ui: { requestRender: vi.fn() },
				showError: vi.fn(),
				showWarning: vi.fn(),
				showStatus: vi.fn(),
			};
			Object.setPrototypeOf(context, InteractiveMode.prototype);

			await interactiveModePrototype.handleProfileCommand.call(context, "/profile create deep");
			expect(settingsManager.getModelProfiles().deep).toEqual([`${model.provider}/${model.id}:high`]);

			context.session.scopedModels = [];
			await interactiveModePrototype.handleProfileCommand.call(context, "/profile use deep");

			expect(setScopedModels).toHaveBeenCalledWith([{ model, thinkingLevel: "high" }]);
			expect(context.session.setModel).toHaveBeenCalledWith(model);
			expect(settingsManager.getEnabledModels()).toEqual([`${model.provider}/${model.id}:high`]);
			expect(settingsManager.getActiveProfile()).toBe("deep");
			expect(context.handleReloadCommand).toHaveBeenCalledOnce();
			expect(context.showError).not.toHaveBeenCalled();
		} finally {
			faux.unregister();
		}
	});

	it("selects the project-overridden model while keeping the profile job model", async () => {
		const faux = registerFauxProvider();
		try {
			const first = faux.getModel();
			const second = { ...first, id: `${first.id}-second` };
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () =>
				JSON.stringify({
					profiles: {
						work: {
							defaultProvider: first.provider,
							defaultModel: first.id,
							defaultThinkingLevel: "high",
							jobModel: `${first.provider}/${first.id}`,
							enabledModels: [`${first.provider}/${first.id}`, `${second.provider}/${second.id}`],
						},
					},
				}),
			);
			storage.withLock("project", () =>
				JSON.stringify({
					defaultProvider: second.provider,
					defaultModel: second.id,
					defaultThinkingLevel: "low",
					jobModel: "untrusted/project",
				}),
			);
			const settingsManager = SettingsManager.fromStorage(storage);
			const context = {
				session: {
					scopedModels: [],
					modelRegistry: { getAvailable: () => [first, second] } as unknown as ModelRegistry,
					setScopedModels: vi.fn(),
					setModel: vi.fn(async (model: Model<Api>) => {
						settingsManager.setDefaultModelAndProvider(model.provider, model.id);
					}),
					setThinkingLevel: vi.fn((level: ThinkingLevel) => {
						settingsManager.setDefaultThinkingLevel(level);
					}),
				},
				settingsManager,
				updateAvailableProviderCount: vi.fn(async () => {}),
				handleReloadCommand: vi.fn(async () => true),
				ui: { requestRender: vi.fn() },
				showError: vi.fn(),
				showWarning: vi.fn(),
				showStatus: vi.fn(),
			} as ProfileCommandContext;
			Object.setPrototypeOf(context, InteractiveMode.prototype);
			await interactiveModePrototype.handleProfileCommand.call(context, "/profile use work");
			expect(context.session.setModel).toHaveBeenCalledWith(second);
			expect(settingsManager.getJobModel()).toBe(`${first.provider}/${first.id}`);
			expect(settingsManager.getProfile("work")?.defaultModel).toBe(first.id);
			expect(settingsManager.getProfile("work")?.defaultThinkingLevel).toBe("high");
			expect(context.showError).not.toHaveBeenCalled();
		} finally {
			faux.unregister();
		}
	});
	it("creates a profile without listing every available model when the scope is empty", async () => {
		const faux = registerFauxProvider();
		try {
			const model = faux.getModel();
			const settingsManager = SettingsManager.inMemory();
			const context = {
				session: {
					model,
					scopedModels: [],
					modelRegistry: { getAvailable: () => [model] } as unknown as ModelRegistry,
				},
				settingsManager,
				showError: vi.fn(),
				showStatus: vi.fn(),
			} as unknown as ProfileCommandContext;
			Object.setPrototypeOf(context, InteractiveMode.prototype);

			await interactiveModePrototype.handleProfileCommand.call(context, "/profile create lean");
			expect(settingsManager.getProfile("lean")?.defaultModel).toBe(model.id);
			expect(Object.hasOwn(settingsManager.getGlobalSettings().profiles?.lean ?? {}, "enabledModels")).toBe(false);
			await interactiveModePrototype.handleProfileCommand.call(context, "/profile list");
			expect(context.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("Profiles: lean"));
			expect(context.showError).not.toHaveBeenCalled();
		} finally {
			faux.unregister();
		}
	});

	it("rejects unknown profiles", async () => {
		const context = {
			session: { scopedModels: [], modelRegistry: {}, setScopedModels: vi.fn() },
			settingsManager: SettingsManager.inMemory(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as ProfileCommandContext;
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.handleProfileCommand.call(context, "/profile use missing");

		expect(context.showError).toHaveBeenCalledWith("Unknown profile: missing");
		expect(context.session.setScopedModels).not.toHaveBeenCalled();
	});
	it("assigns and clears a directory rule through /profile", async () => {
		const settingsManager = SettingsManager.inMemory({ profiles: { work: { theme: "light" } } });
		const context = {
			session: { scopedModels: [], modelRegistry: {}, setScopedModels: vi.fn() },
			settingsManager,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as ProfileCommandContext;
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.handleProfileCommand.call(context, "/profile directory work /home/user/work");
		expect(settingsManager.getGlobalSettings().profileDirectories).toEqual({ "/home/user/work": "work" });
		expect(
			SettingsManager.inMemory(settingsManager.getGlobalSettings(), "/home/user/work/project").getActiveProfile(),
		).toBe("work");
		await interactiveModePrototype.handleProfileCommand.call(context, "/profile directory clear /home/user/work");
		expect(settingsManager.getGlobalSettings().profileDirectories).toEqual({});
		expect(context.showError).not.toHaveBeenCalled();
	});
	it("sets a profile VM only when it exists and configures startup auto-connect", async () => {
		const cwd = realpathSync(process.cwd());
		const settingsManager = SettingsManager.inMemory({ profiles: { work: { theme: "light" } } }, cwd);
		const service = { list: vi.fn(async () => [{ name: "my-vm" }]) };
		const context = {
			settingsManager,
			activeSession: { getCwd: () => cwd },
			createLimaSandboxService: () => service,
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as ProfileCommandContext;
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.handleProfileCommand.call(context, "/profile sandbox work --name my-vm");
		expect(service.list).toHaveBeenCalledWith({ workspaceRoot: cwd, allWorkspaces: true });
		expect(settingsManager.getProfile("work")?.defaultSandbox).toBe("my-vm");
		await interactiveModePrototype.handleProfileCommand.call(
			context,
			"/profile sandbox work --name my-vm --autoconnect off",
		);
		expect(settingsManager.getProfile("work")).toMatchObject({ defaultSandbox: "my-vm", autoConnectSandbox: false });
		await interactiveModePrototype.handleProfileCommand.call(
			context,
			"/profile sandbox work --autoconnect on --name my-vm",
		);
		expect(settingsManager.getProfile("work")).toMatchObject({ defaultSandbox: "my-vm", autoConnectSandbox: true });
		await interactiveModePrototype.handleProfileCommand.call(context, "/profile sandbox work --autoconnect off");
		expect(settingsManager.getProfile("work")?.autoConnectSandbox).toBe(false);
		await interactiveModePrototype.handleProfileCommand.call(context, "/profile sandbox work auto-connect on");
		expect(settingsManager.getProfile("work")?.autoConnectSandbox).toBe(true);
		await interactiveModePrototype.handleProfileCommand.call(context, "/profile sandbox work auto-connect off");
		await interactiveModePrototype.handleProfileCommand.call(context, "/profile sandbox work");
		expect(context.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("auto-connect: off"));

		service.list.mockResolvedValueOnce([]);
		await interactiveModePrototype.handleProfileCommand.call(
			context,
			"/profile sandbox work --name missing-vm --autoconnect on",
		);
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
		expect(settingsManager.getProfile("work")).toMatchObject({ defaultSandbox: "my-vm", autoConnectSandbox: false });
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
		expect(settingsManager.getProfile("work")?.defaultSandbox).toBe("my-vm");
		await interactiveModePrototype.handleProfileCommand.call(context, "/profile sandbox work clear");
		await settingsManager.reload();
		expect(settingsManager.getProfile("work")?.defaultSandbox).toBeUndefined();
		expect(settingsManager.getProfile("work")?.autoConnectSandbox).toBe(false);
		expect(settingsManager.getProfile("work")?.theme).toBe("light");
	});
});
