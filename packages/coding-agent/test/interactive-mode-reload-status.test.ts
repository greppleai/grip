import { Container } from "@greppleai/grip-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolBackendInfo } from "../src/core/tools/operations.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createReloadMode(backend: () => ToolBackendInfo, reload: () => Promise<void>) {
	const statuses = new Map<string, string>([
		["toolBackend", "stale"],
		["extension", "stale"],
	]);
	const editor = Object.assign(new Container(), {
		setPaddingX: vi.fn(),
		setAutocompleteMaxVisible: vi.fn(),
	});
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: {
			session: {
				isStreaming: false,
				isCompacting: false,
				reload,
				getToolBackendInfo: backend,
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				extensionRunner: {},
				modelRegistry: { getError: () => undefined },
				settingsManager: {
					getHideThinkingBlock: () => false,
					getOutputPad: () => 1,
					getTheme: () => undefined,
					getEditorPaddingX: () => 1,
					getAutocompleteMaxVisible: () => 10,
					getShowHardwareCursor: () => true,
					getClearOnShrink: () => true,
				},
			},
		},
		footerDataProvider: {
			clearExtensionStatuses: () => statuses.clear(),
			setExtensionStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			setShowHardwareCursor: vi.fn(),
			setClearOnShrink: vi.fn(),
		},
		keybindings: { reload: vi.fn() },
		defaultEditor: editor,
		editor,
		editorContainer: new Container(),
		resetExtensionUI: () => statuses.clear(),
		setupAutocompleteProvider: vi.fn(),
		setupExtensionShortcuts: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		showLoadedResources: vi.fn(),
		showRuntimeDiagnostics: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	}) as InteractiveMode;
	return { mode, statuses };
}

describe("InteractiveMode /reload backend status", () => {
	beforeAll(() => initTheme("dark"));

	it("restores the current remote backend indicator without clearing reloaded extension statuses", async () => {
		let info = {
			type: "remote",
			configured: true,
			cwd: "/workspace",
			url: "ws://127.0.0.1:8787/grip/workspace",
			protocol: "ws",
			workspace: { id: "abcdefghijklmnop", root: "/workspace", pathFlavor: "posix" },
		} satisfies ToolBackendInfo;
		const { mode, statuses } = createReloadMode(
			() => info,
			async () => {
				info = { ...info, url: "grip+ws://127.0.0.1:8787/grip/workspace" };
				statuses.set("extension", "reloaded");
			},
		);
		const reload = Reflect.get(mode, "handleReloadCommand") as (this: InteractiveMode) => Promise<void>;

		await reload.call(mode);

		expect(statuses.get("toolBackend")).toContain("tools: remote grip+ws://127.0.0.1:8787/grip/workspace /workspace");
		expect(statuses.get("extension")).toBe("reloaded");
	});

	it("restores the local backend indicator if reload fails", async () => {
		const { mode, statuses } = createReloadMode(
			() => ({ type: "local", cwd: "/workspace" }),
			async () => {
				throw new Error("reload failed");
			},
		);
		const reload = Reflect.get(mode, "handleReloadCommand") as (this: InteractiveMode) => Promise<void>;

		await reload.call(mode);

		expect(statuses.get("toolBackend")).toContain("tools: local /workspace");
		expect(statuses.has("extension")).toBe(false);
	});
});
