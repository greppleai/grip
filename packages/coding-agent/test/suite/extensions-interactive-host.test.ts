import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@greppleai/grip-ai";
import { Container, setKeybindings, stripTerminalSequences, TuiMainScreen } from "@greppleai/grip-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { InstalledExtension } from "../../src/core/extension-inventory.ts";
import { GripAgent } from "../../src/core/grip-agent.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { encodeOfficialArtifact, officialJson, officialSha256 } from "../../src/core/official-artifact.ts";
import {
	OFFICIAL_CATALOG_URL,
	OFFICIAL_REPOSITORY,
	type OfficialCatalog,
	type OfficialRelease,
	parseOfficialManifest,
} from "../../src/core/official-catalog.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../../src/core/resource-loader.ts";
import { InMemorySessionManager } from "../../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import type { ExtensionManagerComponent } from "../../src/modes/interactive/components/extension-manager.ts";
import type { ExtensionManagerReloadCoordinator } from "../../src/modes/interactive/extension-manager-reload.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme, stopThemeWatcher } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

interface MountedManagerView {
	component: ExtensionManagerComponent;
}

interface ManagerHost {
	handleEditorSubmit(text: string): Promise<void>;
	handleFollowUp(): Promise<void>;
	promptSession(message: string): Promise<void>;
	bindCurrentSessionExtensions(): Promise<void>;
	disposeExtensionManager(): Promise<void>;
	extensionManager: MountedManagerView | undefined;
	extensionManagerReload: ExtensionManagerReloadCoordinator;
}

function text(component: ExtensionManagerComponent): string {
	return stripTerminalSequences(component.render(100).join("\n"));
}

function activate(component: ExtensionManagerComponent, label: string): void {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (
			text(component)
				.match(/^→ (.*)$/m)?.[1]
				?.startsWith(label)
		) {
			component.handleInput("\r");
			return;
		}
		component.handleInput("\x1b[B");
	}
	throw new Error(`Choice not found: ${label}\n${text(component)}`);
}

describe("/extensions interactive host mounting", () => {
	const cleanups: Array<() => Promise<void>> = [];
	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function setup(
		options: HarnessOptions = {},
		prepareResources?: (harness: Harness) => Promise<ResourceLoader>,
	) {
		const harness: Harness = await createHarness(options);
		const resourceLoader = prepareResources ? await prepareResources(harness) : harness.session.resourceLoader;
		const runtime = await GripAgent.create({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			sessionManager: new InMemorySessionManager(harness.tempDir),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resourceLoader,
			model: harness.getModel(),
			hooks: false,
		});
		await runtime.createAgentSession();
		await runtime.session.bindExtensions({});
		const keybindings = new KeybindingsManager();
		vi.spyOn(keybindings, "reload").mockImplementation(() => {});
		vi.spyOn(KeybindingsManager, "create").mockReturnValue(keybindings);
		setKeybindings(keybindings);
		const mode = new InteractiveMode(runtime);
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = Reflect.get(mode, "editor") as CustomEditor;
		vi.spyOn(editor, "addToHistory");
		const editorContainer = Reflect.get(mode, "editorContainer") as Container;
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const showWarning = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		Object.assign(mode, { ui, showWarning, showStatus, showError });
		// Keep runtime invalidation/rebind registration real; sandbox and transcript setup
		// belong to init(), which this non-started terminal fixture deliberately avoids.
		Object.assign(mode, {
			restoreCurrentSessionSandbox: vi.fn(async () => {}),
			rebindCurrentSession: vi.fn(async () => {}),
		});
		const host = mode as unknown as ManagerHost;
		let stopped = false;
		const stopMode = () => {
			if (stopped) return;
			mode.stop();
			stopped = true;
		};
		cleanups.push(async () => {
			await host.disposeExtensionManager();
			stopMode();
			await runtime.dispose();
			ui.stop();
			stopThemeWatcher();
			await harness.session.dispose();
			harness.cleanup();
		});
		return {
			harness: { ...harness, session: runtime.session },
			runtime,
			mode,
			host,
			ui,
			editor,
			editorContainer,
			showWarning,
			showStatus,
			showError,
			stopMode,
		};
	}

	it("dispatches without factories and restores editor focus after selector disposal", async () => {
		const { host, ui, editor, editorContainer, harness } = await setup();
		const showOverlay = vi.spyOn(ui, "showOverlay");
		const prompt = vi.spyOn(harness.session, "prompt");
		await host.handleEditorSubmit(" /extensions ");
		const component = host.extensionManager!.component;
		expect(text(component)).toContain("Install extension");
		expect(text(component)).toContain("No installed or configured extensions.");
		expect(ui.getFocusedComponent()).toBe(component);
		expect(editorContainer.children).toEqual([component]);
		expect(ui.hasOverlay()).toBe(false);
		expect(showOverlay).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		component.handleInput("\x1b");
		await vi.waitFor(() => expect(host.extensionManager).toBeUndefined());
		expect(ui.getFocusedComponent()).toBe(editor);
		expect(editorContainer.children).toEqual([editor]);
		expect(editor.addToHistory).toHaveBeenCalledWith("/extensions");
	});

	it("reserves dispatch against a real conflicting extension command, including argument attempts", async () => {
		const handler = vi.fn(async () => {});
		const { host, harness, showWarning } = await setup({
			extensionFactories: [(api) => api.registerCommand("extensions", { handler })],
		});
		const prompt = vi.spyOn(harness.session, "prompt");
		await host.handleEditorSubmit("/extensions");
		await host.handleEditorSubmit("/extensions bypass");
		expect(host.extensionManager).toBeDefined();
		expect(showWarning).toHaveBeenCalledWith("Usage: /extensions");
		expect(handler).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each([false, true])("does not replace /model when a displaced manager closes (dispose=%s)", async (dispose) => {
		const { host, ui, editor, editorContainer } = await setup();
		await host.handleEditorSubmit("/extensions");
		const component = host.extensionManager!.component;
		await host.handleEditorSubmit("/model");
		const modelSelector = editorContainer.children[0];
		expect(modelSelector).not.toBe(component);
		expect(modelSelector).not.toBe(editor);
		expect(ui.getFocusedComponent()).toBe(modelSelector);
		if (dispose) await host.disposeExtensionManager();
		else component.handleInput("\x1b");
		await vi.waitFor(() => expect(host.extensionManager).toBeUndefined());
		expect(editorContainer.children).toEqual([modelSelector]);
		expect(ui.getFocusedComponent()).toBe(modelSelector);
		expect(ui.hasOverlay()).toBe(false);
		modelSelector.handleInput!("\x1b");
		expect(editorContainer.children).toEqual([editor]);
		expect(ui.getFocusedComponent()).toBe(editor);
	});

	it("remounts the same manager and ignores a replaced model selector's stale close", async () => {
		const { host, ui, editor, editorContainer } = await setup();
		await host.handleEditorSubmit("/extensions");
		const component = host.extensionManager!.component;
		await host.handleEditorSubmit("/model");
		const modelSelector = editorContainer.children[0];
		await host.handleEditorSubmit("/extensions");
		expect(host.extensionManager!.component).toBe(component);
		expect(editorContainer.children).toEqual([component]);
		expect(ui.getFocusedComponent()).toBe(component);
		modelSelector.handleInput!("\x1b");
		expect(editorContainer.children).toEqual([component]);
		expect(ui.getFocusedComponent()).toBe(component);
		component.handleInput("\x1b");
		await vi.waitFor(() => expect(host.extensionManager).toBeUndefined());
		expect(editorContainer.children).toEqual([editor]);
		expect(ui.getFocusedComponent()).toBe(editor);
	});

	it("does not replace /model when inventory settles after the manager starts closing", async () => {
		const { host, ui, editorContainer, harness } = await setup();
		const inventory = Promise.withResolvers<InstalledExtension[]>();
		cleanups.push(async () => inventory.resolve([]));
		const readInventory = vi
			.spyOn(harness.session.resourceLoader, "getExtensionInventory")
			.mockReturnValue(inventory.promise);
		const opening = host.handleEditorSubmit("/extensions");
		await vi.waitFor(() => expect(readInventory).toHaveBeenCalledOnce());
		const component = host.extensionManager!.component;
		expect(editorContainer.children).toEqual([component]);
		component.handleInput("\x1b");
		expect(text(component)).toContain("Closing;");
		await host.handleEditorSubmit("/model");
		const modelSelector = editorContainer.children[0];
		inventory.resolve([]);
		await opening;
		await vi.waitFor(() => expect(host.extensionManager).toBeUndefined());
		expect(editorContainer.children).toEqual([modelSelector]);
		expect(ui.getFocusedComponent()).toBe(modelSelector);
		expect(ui.hasOverlay()).toBe(false);
	});

	it.each([false, true])(
		"refocuses the same manager and preserves an unrelated overlay (dispose=%s)",
		async (dispose) => {
			const { host, ui, editor, editorContainer } = await setup();
			await host.handleEditorSubmit("/extensions");
			const first = host.extensionManager!.component;
			const other = new Container();
			const overlay = ui.showOverlay(other);
			await host.handleEditorSubmit("/extensions");
			expect(host.extensionManager!.component).toBe(first);
			expect(ui.getFocusedComponent()).toBe(first);
			overlay.focus();
			if (dispose) await host.disposeExtensionManager();
			else first.handleInput("\x1b");
			await vi.waitFor(() => expect(host.extensionManager).toBeUndefined());
			expect(editorContainer.children).toEqual([editor]);
			expect(ui.getFocusedComponent()).toBe(other);
			expect(ui.hasOverlay()).toBe(true);
			overlay.hide();
			expect(ui.getFocusedComponent()).toBe(editor);
		},
	);

	it.each([false, true])(
		"mounts with actual failed or disabled local loading (noExtensions=%s)",
		async (noExtensions) => {
			const root = mkdtempSync(join(tmpdir(), "grip-manager-host-"));
			cleanups.push(async () => {
				rmSync(root, { recursive: true, force: true });
			});
			const extensions = join(root, ".grip", "extensions");
			mkdirSync(extensions, { recursive: true });
			writeFileSync(
				join(extensions, "fixture.ts"),
				'export default () => { throw new Error("fixture factory failure"); };',
			);
			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir: join(root, "agent"),
				settingsManager: SettingsManager.inMemory(),
				noExtensions,
			});
			await loader.reload();
			expect(loader.getExtensions().extensions).toHaveLength(0);
			expect(loader.getExtensions().errors).toHaveLength(noExtensions ? 0 : 1);
			const { host, harness } = await setup({ resourceLoader: loader });
			const prompt = vi.spyOn(harness.session, "prompt");
			await host.handleEditorSubmit("/extensions");
			const rendered = text(host.extensionManager!.component);
			expect(rendered).toContain("Install extension");
			expect(rendered).toContain(noExtensions ? "disabled" : "failed");
			expect(prompt).not.toHaveBeenCalled();
			await host.disposeExtensionManager();
			await host.extensionManagerReload.request();
			expect(host.extensionManagerReload.reloadRequired).toBe(false);
			expect(loader.getExtensions().extensions).toHaveLength(0);
			expect(loader.getExtensions().errors).toHaveLength(noExtensions ? 0 : 1);
			await host.handleEditorSubmit("/extensions");
			expect(text(host.extensionManager!.component)).toContain(noExtensions ? "disabled" : "failed");
		},
	);

	it("mounts inventory failures without submitting a prompt or requesting a catalog", async () => {
		const { host, harness } = await setup();
		vi.spyOn(harness.session.resourceLoader, "getExtensionInventory").mockRejectedValue(
			new Error("inventory unavailable"),
		);
		const catalog = vi.spyOn(DefaultPackageManager.prototype, "getOfficialCatalog");
		await host.handleEditorSubmit("/extensions");
		expect(text(host.extensionManager!.component)).toContain("inventory unavailable");
		expect(catalog).not.toHaveBeenCalled();
	});

	async function beginUninstall(host: ManagerHost, harness: Harness) {
		const row: InstalledExtension = {
			identity: "managed-fixture",
			source: "official:fixture",
			scope: "user",
			configured: true,
			installedPath: "/fixture",
			version: "1.0.0",
			status: "loaded",
			removal: { source: "official:fixture", scope: "user" },
			entries: [],
			errors: [],
		};
		vi.spyOn(harness.session.resourceLoader, "getExtensionInventory").mockResolvedValue([row]);
		const mutation = Promise.withResolvers<boolean>();
		cleanups.push(async () => {
			mutation.resolve(true);
		});
		const remove = vi.spyOn(DefaultPackageManager.prototype, "removeAndPersist").mockReturnValue(mutation.promise);
		await host.handleEditorSubmit("/extensions");
		const component = host.extensionManager!.component;
		activate(component, "official:fixture");
		activate(component, "Uninstall");
		activate(component, "Confirm");
		await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
		return { component, mutation, controls: remove.mock.calls[0][1]!.official! };
	}

	it("awaits a canceled mutation, preserves the restart requirement, and rejects stale close effects", async () => {
		const { host, harness, ui, showStatus } = await setup();
		const reload = vi.spyOn(harness.session, "reload");
		const gate = Promise.withResolvers<void>();
		cleanups.push(async () => {
			gate.resolve();
		});
		const command = host.extensionManagerReload.trackCommand(() => gate.promise);
		const { component, mutation, controls } = await beginUninstall(host, harness);
		let settled = false;
		const disposal = host.disposeExtensionManager().then(() => {
			settled = true;
		});
		expect(controls.signal!.aborted).toBe(true);
		const other = new Container();
		const overlay = ui.showOverlay(other);
		component.handleInput("\x1b");
		await Promise.resolve();
		expect(settled).toBe(false);
		mutation.resolve(true);
		await disposal;
		expect(ui.getFocusedComponent()).toBe(other);
		expect(host.extensionManagerReload.reloadRequired).toBe(true);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("reload pending"));
		expect(reload).not.toHaveBeenCalled();
		const pending = host.extensionManagerReload.request();
		gate.resolve();
		await Promise.all([command, pending]);
		expect(reload).toHaveBeenCalledOnce();
		expect(host.extensionManagerReload.reloadRequired).toBe(false);
		overlay.hide();
	});
	it("awaits manager settlement before session replacement and blocks remounts until rebind", async () => {
		const { host, harness, runtime, mode, showWarning, showStatus } = await setup();
		const { component, mutation, controls } = await beginUninstall(host, harness);
		const oldSession = runtime.session;
		const disposeOld = vi.spyOn(oldSession, "dispose");
		const rebindStarted = Promise.withResolvers<void>();
		const rebindGate = Promise.withResolvers<void>();
		cleanups.push(async () => {
			rebindGate.resolve();
		});
		Object.assign(mode, {
			restoreCurrentSessionSandbox: async () => {
				rebindStarted.resolve();
				await rebindGate.promise;
			},
		});
		const replacement = runtime.newSession();
		await vi.waitFor(() => expect(controls.signal!.aborted).toBe(true));
		expect(disposeOld).not.toHaveBeenCalled();
		expect(runtime.session).toBe(oldSession);
		expect(host.extensionManager).toBeUndefined();
		const reopening = host.handleEditorSubmit("/extensions");
		mutation.resolve(true);
		await rebindStarted.promise;
		await reopening;
		expect(disposeOld).toHaveBeenCalledOnce();
		expect(host.extensionManagerReload.reloadRequired).toBe(true);
		expect(host.extensionManager).toBeUndefined();
		expect(showWarning).not.toHaveBeenCalled();
		await host.handleEditorSubmit("/extensions");
		expect(host.extensionManager).toBeUndefined();
		rebindGate.resolve();
		await replacement;
		await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("configuration reloaded"));
		await host.handleEditorSubmit("/extensions");
		const currentView = host.extensionManager;
		expect(currentView).toBeDefined();
		component.handleInput("\x1b");
		await Promise.resolve();
		expect(host.extensionManager).toBe(currentView);
	});
	it("awaits manager settlement during runtime disposal without stale status or overlay effects", async () => {
		const { host, harness, runtime, ui, showWarning, stopMode } = await setup();
		const { component, mutation, controls } = await beginUninstall(host, harness);
		const disposeOld = vi.spyOn(runtime.session, "dispose");
		const disposal = runtime.dispose();
		await vi.waitFor(() => expect(controls.signal!.aborted).toBe(true));
		expect(disposeOld).not.toHaveBeenCalled();
		expect(host.extensionManager).toBeUndefined();
		stopMode();
		mutation.resolve(true);
		await disposal;
		expect(disposeOld).toHaveBeenCalledOnce();
		expect(host.extensionManagerReload.reloadRequired).toBe(true);
		expect(showWarning).not.toHaveBeenCalled();
		component.handleInput("\x1b");
		expect(ui.hasOverlay()).toBe(false);
	});

	it("restores manager admission when asynchronous invalidation rejects", async () => {
		const { host, runtime, mode } = await setup();
		const oldSession = runtime.session;
		const disposeOld = vi.spyOn(oldSession, "dispose");
		const reset = Reflect.get(mode, "resetExtensionUI") as () => void;
		Object.assign(mode, {
			resetExtensionUI: () => {
				throw new Error("fixture reset failure");
			},
		});
		try {
			await expect(runtime.newSession()).rejects.toThrow("fixture reset failure");
		} finally {
			Object.assign(mode, { resetExtensionUI: reset });
		}
		expect(runtime.session).toBe(oldSession);
		expect(disposeOld).not.toHaveBeenCalled();
		await host.handleEditorSubmit("/extensions");
		expect(host.extensionManager).toBeDefined();
	});
	it("defers activation through a real tool and queued follow-up without interrupting either", async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const { host, harness, editor, showStatus } = await setup({
			extensionFactories: [
				(api) =>
					api.registerTool({
						name: "hold",
						label: "Hold",
						description: "Wait for the test",
						parameters: Type.Object({}),
						execute: async () => {
							started.resolve();
							await released.promise;
							return { content: [{ type: "text", text: "released" }], details: {} };
						},
					}),
			],
		});
		cleanups.push(async () => {
			released.resolve();
		});
		const { mutation } = await beginUninstall(host, harness);
		const reload = vi.spyOn(harness.session, "reload");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool finished"),
			fauxAssistantMessage("follow-up finished"),
		]);
		const prompt = host.promptSession("start");
		await started.promise;
		editor.setText("follow-up");
		await host.handleFollowUp();
		mutation.resolve(true);
		await host.disposeExtensionManager();
		expect(reload).not.toHaveBeenCalled();
		expect(host.extensionManagerReload.reloadRequired).toBe(true);
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("reload pending"));
		released.resolve();
		await prompt;
		await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
		expect(reload).toHaveBeenCalledOnce();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("tracks an extension command while its own waitForIdle remains usable", async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const { host, harness } = await setup({
			extensionFactories: [
				(api) =>
					api.registerCommand("hold-command", {
						handler: async (_args, ctx) => {
							await ctx.waitForIdle();
							started.resolve();
							await released.promise;
						},
					}),
			],
		});
		cleanups.push(async () => {
			released.resolve();
		});
		await host.bindCurrentSessionExtensions();
		const { mutation } = await beginUninstall(host, harness);
		const reload = vi.spyOn(harness.session, "reload");
		const command = host.promptSession("/hold-command");
		await started.promise;
		expect(harness.session.isIdle).toBe(true);
		mutation.resolve(true);
		await host.disposeExtensionManager();
		expect(reload).not.toHaveBeenCalled();
		released.resolve();
		await command;
		await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
		expect(reload).toHaveBeenCalledOnce();
	});

	it("retains saved changes after reload failure and applies them on explicit retry", async () => {
		const { host, harness, showWarning, showStatus } = await setup();
		const { mutation } = await beginUninstall(host, harness);
		const reload = vi.spyOn(harness.session, "reload").mockRejectedValueOnce(new Error("fixture reload failure"));
		mutation.resolve(true);
		await host.disposeExtensionManager();
		await vi.waitFor(() =>
			expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("fixture reload failure")),
		);
		expect(host.extensionManagerReload.reloadRequired).toBe(true);
		expect(showStatus).not.toHaveBeenCalledWith(expect.stringContaining("configuration reloaded"));
		await host.handleEditorSubmit("/reload");
		expect(reload).toHaveBeenCalledTimes(2);
		expect(host.extensionManagerReload.reloadRequired).toBe(false);
	});
	it("reconciles the replacement session after an obsolete in-flight reload settles", async () => {
		const { host, harness, runtime, showError } = await setup();
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		cleanups.push(async () => {
			released.resolve();
		});
		const reloadOriginal = harness.session.reload.bind(harness.session);
		vi.spyOn(harness.session, "reload").mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
			await reloadOriginal();
		});
		const pending = host.extensionManagerReload.request();
		await started.promise;
		const queued = host.handleEditorSubmit("/extensions");
		const rejected = expect(queued).rejects.toThrow("Session changed");
		await runtime.newSession();
		expect(runtime.session).not.toBe(harness.session);
		released.resolve();
		await Promise.all([pending, rejected]);
		await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
		expect(host.extensionManager).toBeUndefined();
		expect(showError).not.toHaveBeenCalled();
		await host.handleEditorSubmit("/extensions");
		expect(host.extensionManager).toBeDefined();
	});

	it("allows an extension command to explicitly reload without awaiting its own command barrier", async () => {
		const finished = vi.fn();
		const { host, harness, showError } = await setup({
			extensionFactories: [
				(api) =>
					api.registerCommand("apply-extensions", {
						handler: async (_args, ctx) => {
							await ctx.reload();
							finished();
						},
					}),
			],
		});
		await host.bindCurrentSessionExtensions();
		const reload = vi.spyOn(harness.session, "reload");
		await host.promptSession("/apply-extensions");
		expect(showError).not.toHaveBeenCalled();
		expect(finished).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledOnce();
	});
	it.each([false, true])(
		"installs and removes through real managed state and idle reload (noExtensions=%s)",
		async (noExtensions) => {
			const manifest = parseOfficialManifest(
				{
					name: "official-fixture",
					version: "1.0.0",
					description: "Managed acceptance fixture",
					type: "module",
					engines: { grip: ">=0.1.0 <1" },
					grip: { official: { id: "fixture", displayName: "Fixture" }, extensions: ["entry.js"] },
				},
				"fixture",
			);
			const entrySource =
				'export default api => { api.registerCommand("official-proof", { handler: async () => {} }); };';
			const bytes = encodeOfficialArtifact({
				schemaVersion: 1,
				manifest,
				files: [
					{ path: "package.json", base64: Buffer.from(officialJson(manifest)).toString("base64") },
					{ path: "entry.js", base64: Buffer.from(entrySource).toString("base64") },
				],
			});
			const release: OfficialRelease = {
				manifest,
				sourceCommit: "a".repeat(40),
				tag: "extension-fixture-v1.0.0",
				artifact: {
					url: `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/extension-fixture-v1.0.0/fixture-1.0.0.json.gz`,
					size: bytes.length,
					sha256: officialSha256(bytes),
				},
			};
			const catalog: OfficialCatalog = {
				schemaVersion: 1,
				repository: OFFICIAL_REPOSITORY,
				extensions: [{ id: "fixture", releases: [release] }],
			};
			const fetcher = vi.fn<typeof fetch>(async (input) => {
				if (String(input) === OFFICIAL_CATALOG_URL) return new Response(officialJson(catalog));
				if (String(input) === release.artifact.url) return new Response(new Uint8Array(bytes));
				throw new Error(`Unexpected request: ${String(input)}`);
			});
			vi.stubGlobal("fetch", fetcher);
			const started = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const manualSource =
				'export default api => { api.registerCommand("manual-proof", { handler: async () => {} }); };';
			const { host, harness, runtime, showStatus, showError } = await setup({}, async (h) => {
				const agentDir = join(h.tempDir, "agent");
				mkdirSync(join(agentDir, "extensions"), { recursive: true });
				writeFileSync(join(agentDir, "extensions", "manual.ts"), manualSource);
				writeFileSync(join(agentDir, "fixture-user-data.json"), '{"preserve":true}');
				writeFileSync(join(agentDir, "settings.json"), '{"theme":"light"}');
				h.settingsManager = SettingsManager.create(h.tempDir, agentDir);
				const loader = new DefaultResourceLoader({
					cwd: h.tempDir,
					agentDir,
					settingsManager: h.settingsManager,
					noExtensions,
					extensionFactories: [
						(api) =>
							api.registerCommand("hold-install", {
								handler: async (_args, ctx) => {
									await ctx.waitForIdle();
									started.resolve();
									await released.promise;
								},
							}),
					],
				});
				await loader.reload();
				return loader;
			});
			cleanups.push(async () => {
				released.resolve();
			});
			await host.bindCurrentSessionExtensions();
			const agentDir = join(harness.tempDir, "agent");
			const reload = vi.spyOn(runtime.session, "reload");
			const command = host.promptSession("/hold-install");
			await started.promise;
			await host.handleEditorSubmit("/extensions");
			const component = host.extensionManager!.component;
			activate(component, "Install extension");
			await vi.waitFor(() => expect(text(component)).toContain("Fixture (1.0.0)"));
			activate(component, "Fixture");
			activate(component, "Install");
			expect(text(component)).toContain("not sandboxed");
			expect(harness.settingsManager.getPackages()).toEqual([]);
			activate(component, "Confirm");
			await vi.waitFor(() => expect(text(component)).toContain("Saved. Reload/restart"));
			expect(harness.settingsManager.getPackages()).toEqual(["official:fixture"]);
			expect(SettingsManager.create(harness.tempDir, agentDir).getPackages()).toEqual(["official:fixture"]);
			expect(runtime.session.extensionRunner.getCommand("official-proof")).toBeUndefined();
			await host.disposeExtensionManager();
			expect(reload).not.toHaveBeenCalled();
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("reload pending"));
			released.resolve();
			await command;
			await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
			expect(reload).toHaveBeenCalledOnce();
			expect(Boolean(runtime.session.extensionRunner.getCommand("official-proof"))).toBe(!noExtensions);
			const inventory = await runtime.session.resourceLoader.getExtensionInventory();
			expect(inventory).toContainEqual(
				expect.objectContaining({
					source: "official:fixture",
					version: "1.0.0",
					status: noExtensions ? "disabled" : "loaded",
					removal: { source: "official:fixture", scope: "user" },
				}),
			);
			await host.handleEditorSubmit("/extensions");
			const removal = host.extensionManager!.component;
			activate(removal, "official:fixture");
			activate(removal, "Uninstall");
			expect(harness.settingsManager.getPackages()).toEqual(["official:fixture"]);
			activate(removal, "Confirm");
			await vi.waitFor(() => expect(text(removal)).toContain("Saved. Reload/restart"));
			expect(SettingsManager.create(harness.tempDir, agentDir).getPackages()).toEqual([]);
			expect(SettingsManager.create(harness.tempDir, agentDir).getTheme()).toBe("light");
			await host.disposeExtensionManager();
			await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
			expect(reload).toHaveBeenCalledTimes(2);
			expect(runtime.session.extensionRunner.getCommand("official-proof")).toBeUndefined();
			expect(
				(await runtime.session.resourceLoader.getExtensionInventory()).some(
					(row) => row.source === "official:fixture",
				),
			).toBe(false);
			expect(readFileSync(join(agentDir, "extensions", "manual.ts"), "utf8")).toBe(manualSource);
			expect(readFileSync(join(agentDir, "fixture-user-data.json"), "utf8")).toBe('{"preserve":true}');
			expect(Boolean(runtime.session.extensionRunner.getCommand("manual-proof"))).toBe(!noExtensions);
			expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
				OFFICIAL_CATALOG_URL,
				release.artifact.url,
			]);
			expect(showError).not.toHaveBeenCalled();
		},
	);
	it("keeps reload pending through the host's real compaction command", async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const { host, runtime, harness, showStatus } = await setup({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(api) =>
					api.on("session_before_compact", async (event) => {
						started.resolve();
						await released.promise;
						return {
							compaction: {
								summary: "compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					}),
			],
		});
		cleanups.push(async () => {
			released.resolve();
		});
		runtime.session.session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 1000,
		});
		runtime.session.session.appendMessage(fauxAssistantMessage("old response"));
		runtime.session.agent.state.messages = runtime.session.session.buildSessionContext().messages;
		const { mutation } = await beginUninstall(host, harness);
		const reload = vi.spyOn(runtime.session, "reload");
		const compact = host.handleEditorSubmit("/compact");
		await started.promise;
		expect(runtime.session.isCompacting).toBe(true);
		mutation.resolve(true);
		await host.disposeExtensionManager();
		expect(reload).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("reload pending"));
		released.resolve();
		await compact;
		await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
		expect(reload).toHaveBeenCalledOnce();
		expect(runtime.session.session.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("tracks extension shortcuts and rejects a stale captured handler after reload", async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const finished = vi.fn();
		const { host, harness, runtime, editor, showError } = await setup({
			extensionFactories: [
				(api) =>
					api.registerShortcut("ctrl+alt+e", {
						handler: async () => {
							started.resolve();
							await released.promise;
							finished();
						},
					}),
			],
		});
		cleanups.push(async () => {
			released.resolve();
		});
		await host.bindCurrentSessionExtensions();
		const shortcut = editor.onExtensionShortcut!;
		expect(shortcut("\x1b[101;7u")).toBe(true);
		await started.promise;
		const { mutation } = await beginUninstall(host, harness);
		const reload = vi.spyOn(runtime.session, "reload");
		mutation.resolve(true);
		await host.disposeExtensionManager();
		expect(reload).not.toHaveBeenCalled();
		released.resolve();
		await vi.waitFor(() => expect(host.extensionManagerReload.reloadRequired).toBe(false));
		expect(reload).toHaveBeenCalledOnce();
		expect(finished).toHaveBeenCalledOnce();
		expect(showError).not.toHaveBeenCalled();
		expect(shortcut("\x1b[101;7u")).toBe(true);
		await vi.waitFor(() =>
			expect(showError).toHaveBeenCalledWith(expect.stringContaining("shortcuts changed during reload")),
		);
		expect(finished).toHaveBeenCalledOnce();
	});
});
