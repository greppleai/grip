import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, getKeybindings, setKeybindings, Text, type TuiMode } from "@greppleai/grip-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { ExtensionCatalogComponent } from "../src/modes/interactive/components/extension-catalog.ts";
import { catalogConfigurationKey, catalogRuntimeOwners } from "../src/modes/interactive/extension-catalog.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const source = "git:github.com/greppleai/planner@old";
const previousKeys = getKeybindings();
const roots: string[] = [];
const renderers: ReturnType<typeof createInteractiveTui>[] = [];

function directory() {
	const root = mkdtempSync(join(tmpdir(), "grip-catalog-host-"));
	roots.push(root);
	return root;
}

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(() => {
	for (const renderer of renderers.splice(0)) renderer.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setKeybindings(previousKeys);
	vi.restoreAllMocks();
});

async function fixture(tuiMode: TuiMode) {
	const root = directory();
	const cwd = join(root, "host-project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const settings = SettingsManager.create(cwd, agentDir);
	settings.setPackages([source]);
	await settings.flush();
	const terminal = new VirtualTerminal(100, 40);
	const renderer = createInteractiveTui({ tuiMode, terminal, showHardwareCursor: false, logDirectory: root });
	renderers.push(renderer);
	const ui = createInteractiveTuiReference(() => renderer);
	const editor = new Text("editor");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	const session = {
		settingsManager: settings,
		isIdle: true,
		session: { getCwd: () => cwd },
		resourceLoader: { getExtensions: () => ({ extensions: [] }) },
		getToolBackendInfo: () => ({ type: "remote", cwd: "/remote-tools-only" }),
	};
	const runtimeHost = { session, services: { cwd, agentDir } };
	const showError = vi.fn();
	const reload = vi.fn(async () => {});
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost,
		ui,
		renderer,
		editor,
		editorContainer,
		isInitialized: true,
		isShuttingDown: false,
		shutdownRequested: false,
		catalogOpen: false,
		catalogEpoch: 0,
		catalogDialogCancel: undefined,
		showError,
		showStatus: vi.fn(),
		handleReloadCommand: reload,
	}) as InteractiveMode;
	const dispatch = Reflect.get(mode, "handleBuiltInEditorCommand") as (text: string) => Promise<boolean>;
	const cancel = () => {
		const pending = Reflect.get(mode, "catalogDialogCancel") as (() => void) | undefined;
		pending?.();
	};
	const title = () => editorContainer.children[0]?.render(100).join("\n") ?? "";
	const waitForMenu = async (text: string) => vi.waitFor(() => expect(title()).toContain(text));
	const install = vi
		.spyOn(DefaultPackageManager.prototype, "installAndPersist")
		.mockRejectedValue(new Error("unexpected install"));
	const remove = vi.spyOn(DefaultPackageManager.prototype, "removeAndPersist").mockImplementation(async () => {
		settings.setPackages([]);
		return true;
	});
	ui.start();
	const open = () => dispatch.call(mode, "/extensions");
	const removalConsent = async () => {
		terminal.sendInput("\r");
		await waitForMenu("upgrade unavailable");
		terminal.sendInput("\x1b[B");
		terminal.sendInput("\r");
		await waitForMenu("Confirm remove");
	};
	return {
		mode,
		settings,
		terminal,
		ui,
		renderer,
		editor,
		editorContainer,
		runtimeHost,
		showError,
		reload,
		install,
		remove,
		open,
		cancel,
		waitForMenu,
		removalConsent,
	};
}

describe("catalog host settings and provenance", () => {
	it("reports real file paths without creating settings directories or guessing custom storage paths", () => {
		const root = directory();
		const settings = SettingsManager.create(join(root, "workspace"), join(root, "agent"));
		expect(settings.getFilePath("global")).toBe(join(root, "agent", "settings.json"));
		expect(settings.getFilePath("project")).toBe(join(root, "workspace", ".grip", "settings.json"));
		expect(catalogConfigurationKey(settings)).toBe(catalogConfigurationKey(settings));
		expect(existsSync(join(root, "agent"))).toBe(false);
		expect(existsSync(join(root, "workspace"))).toBe(false);
		expect(SettingsManager.inMemory().getFilePath("global")).toBeNull();
		expect(() => catalogConfigurationKey(SettingsManager.inMemory())).toThrow("file-backed");
	});

	it("fingerprints exact filters and refuses external edits before they can overwrite cached settings", async () => {
		const root = directory();
		const settings = SettingsManager.create(root, join(root, "agent"));
		settings.setPackages([{ source, extensions: ["one.ts"], skills: [] }]);
		await settings.flush();
		const before = catalogConfigurationKey(settings);
		settings.setPackages([{ source, extensions: ["two.ts"], skills: [] }]);
		await settings.flush();
		expect(catalogConfigurationKey(settings)).not.toBe(before);
		const file = settings.getFilePath("global")!;
		writeFileSync(file, JSON.stringify({ packages: [{ source, extensions: [] }] }));
		expect(() => catalogConfigurationKey(settings)).toThrow("Use /reload");
		writeFileSync(file, "{");
		expect(() => catalogConfigurationKey(settings)).toThrow();
		writeFileSync(file, "null");
		expect(() => catalogConfigurationKey(settings)).toThrow("JSON object");
	});

	it("retains duplicate command and lazy-tool owners from real inline factories", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(api) => {
				api.registerCommand("planner", { description: "fixture", handler: async () => {} });
				api.registerTool(
					{
						name: "planner_prepare",
						label: "Plan",
						description: "fixture",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: null }),
					},
					{ lazy: true },
				);
			},
			directory(),
			createEventBus(),
			runtime,
			"<inline:1>",
		);
		const owners = catalogRuntimeOwners([extension, extension]);
		expect(owners).toHaveLength(2);
		expect(owners[0]).toEqual({
			path: "<inline:1>",
			source: "inline",
			scope: "temporary",
			commands: ["planner"],
			tools: ["planner_prepare"],
		});
		extension.tools.clear();
		expect(owners[0].tools).toEqual(["planner_prepare"]);
		expect(catalogRuntimeOwners([extension])[0].tools).toEqual([]);
	});
});

describe.each(["regular", "fullscreen"] as const)("/extensions production wiring (%s)", (tuiMode) => {
	it("registers interactive discovery, serializes invocations and cancels without mutation", async () => {
		const f = await fixture(tuiMode);
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "extensions")).toBe(true);
		const pending = f.open();
		expect(f.editorContainer.children[0]).toBeInstanceOf(ExtensionCatalogComponent);
		await f.open();
		expect(f.showError).toHaveBeenCalledWith("The extension catalog is already open.");
		f.terminal.sendInput("\x1b");
		expect(await pending).toBe(true);
		expect(f.editorContainer.children).toEqual([f.editor]);
		expect(f.install).not.toHaveBeenCalled();
		expect(f.remove).not.toHaveBeenCalled();
	});

	it("uses real renderer handoff and flushes settings before explicit reload", async () => {
		const f = await fixture(tuiMode);
		const stop = vi.spyOn(f.renderer, "stop");
		const start = vi.spyOn(f.renderer, "start");
		const pending = f.open();
		await f.removalConsent();
		expect(f.editorContainer.children[0].render(100).join("\n")).toContain(f.settings.getFilePath("global"));
		f.terminal.sendInput("\x1b[B");
		f.terminal.sendInput("\r");
		await f.waitForMenu("Reload resources?");
		expect(f.remove).toHaveBeenCalledExactlyOnceWith(source, { local: false });
		expect(stop).toHaveBeenCalledExactlyOnceWith({ preserveScreen: true });
		expect(start).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(f.settings.getFilePath("global")!, "utf8")).packages).toEqual([]);
		expect(f.reload).not.toHaveBeenCalled();
		f.terminal.sendInput("\x1b[B");
		f.terminal.sendInput("\r");
		await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
		f.cancel();
		await pending;
	});

	it("restores the real renderer after package failure without reloading", async () => {
		const f = await fixture(tuiMode);
		const start = vi.spyOn(f.renderer, "start");
		f.remove.mockRejectedValue(new Error("mock package failure"));
		const pending = f.open();
		await f.removalConsent();
		f.terminal.sendInput("\x1b[B");
		f.terminal.sendInput("\r");
		await vi.waitFor(() => expect(f.showError).toHaveBeenCalledWith(expect.stringContaining("mock package failure")));
		expect(start).toHaveBeenCalledOnce();
		expect(f.reload).not.toHaveBeenCalled();
		f.cancel();
		await pending;
	});

	it("settles an invalidated selector without restoring a stale editor or mutating", async () => {
		const f = await fixture(tuiMode);
		const pending = f.open();
		const focus = vi.spyOn(f.renderer, "setFocus");
		const replacement = new Text("replacement editor");
		Object.assign(f.mode, {
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			defaultEditor: {},
			setupAutocompleteProvider: vi.fn(),
			updateTerminalTitle: vi.fn(),
			setWorkingIndicator: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setCustomEditorComponent: () => {
				f.editorContainer.clear();
				f.editorContainer.addChild(replacement);
				f.ui.setFocus(replacement);
			},
		});
		const reset = Reflect.get(f.mode, "resetExtensionUI") as () => void;
		reset.call(f.mode);
		await pending;
		expect(focus).toHaveBeenCalledExactlyOnceWith(replacement);
		expect(f.editorContainer.children).toEqual([replacement]);
		expect(f.remove).not.toHaveBeenCalled();
		expect(Reflect.get(f.mode, "catalogDialogCancel")).toBeUndefined();
		expect(Reflect.get(f.mode, "catalogOpen")).toBe(false);
	});

	it("refuses consent after session activity changes", async () => {
		const f = await fixture(tuiMode);
		const pending = f.open();
		await f.removalConsent();
		f.runtimeHost.session.isIdle = false;
		f.terminal.sendInput("\x1b[B");
		f.terminal.sendInput("\r");
		await vi.waitFor(() => expect(f.showError).toHaveBeenCalledWith(expect.stringContaining("activity changed")));
		expect(f.remove).not.toHaveBeenCalled();
		f.cancel();
		await pending;
	});
	it("does not restart the renderer if shutdown begins during the confirmed operation", async () => {
		const f = await fixture(tuiMode);
		const start = vi.spyOn(f.renderer, "start");
		f.remove.mockImplementation(async () => {
			Reflect.set(f.mode, "isShuttingDown", true);
			f.settings.setPackages([]);
			return true;
		});
		const pending = f.open();
		await f.removalConsent();
		f.terminal.sendInput("\x1b[B");
		f.terminal.sendInput("\r");
		await pending;
		expect(f.remove).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
		expect(f.reload).not.toHaveBeenCalled();
	});

	it("refuses externally edited package filters after consent without terminal handoff", async () => {
		const f = await fixture(tuiMode);
		const stop = vi.spyOn(f.renderer, "stop");
		const pending = f.open();
		await f.removalConsent();
		writeFileSync(f.settings.getFilePath("global")!, JSON.stringify({ packages: [{ source, extensions: [] }] }));
		f.terminal.sendInput("\x1b[B");
		f.terminal.sendInput("\r");
		await vi.waitFor(() => expect(f.showError).toHaveBeenCalledWith(expect.stringContaining("Use /reload")));
		expect(f.remove).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		f.cancel();
		await pending;
	});
});
