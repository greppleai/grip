import { setKeybindings, TuiMainScreen } from "@greppleai/grip-tui";
import { afterEach, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ExtensionManagerReloadCoordinator } from "../src/modes/interactive/extension-manager-reload.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

afterEach(() => setKeybindings(new KeybindingsManager()));

it("recalls rejected sandbox commands and accepted prompts with Up and Down", async () => {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
	const showWarning = vi.fn();
	const pendingUserInputs: string[] = [];
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		editor,
		runtimeHost: { session: { isCompacting: false, isStreaming: false } },
		pendingBashComponents: [],
		pendingUserInputs,
		showWarning,
	});
	Object.assign(mode, {
		extensionManagerReload: new ExtensionManagerReloadCoordinator({
			getSession: () => Reflect.get(mode, "session") as AgentSession,
			reload: vi.fn(),
			onStatus: vi.fn(),
		}),
	});
	const submit = mode as unknown as { handleEditorSubmit(text: string): Promise<void> };
	let submission: Promise<void> | undefined;
	editor.onSubmit = (text) => {
		submission = submit.handleEditorSubmit(text);
	};

	const invalid = "/sandbox start --nmae dev";
	editor.setText(invalid);
	editor.handleInput("\r");
	await submission;
	expect(showWarning).toHaveBeenCalledOnce();
	expect(editor.getText()).toBe("");
	editor.handleInput("\x1b[A");
	expect(editor.getText()).toBe(invalid);
	editor.handleInput("\x1b[B");
	expect(editor.getText()).toBe("");

	editor.setText("ordinary prompt");
	editor.handleInput("\r");
	await submission;
	expect(pendingUserInputs).toEqual(["ordinary prompt"]);
	editor.handleInput("\x1b[A");
	expect(editor.getText()).toBe("ordinary prompt");
	editor.handleInput("\x1b[A");
	expect(editor.getText()).toBe(invalid);
	editor.handleInput("\x1b[B");
	expect(editor.getText()).toBe("ordinary prompt");
});
