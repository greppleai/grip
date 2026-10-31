import { CURSOR_MARKER, setKeybindings, stripTerminalSequences, visibleWidth } from "@greppleai/grip-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledExtension } from "../src/core/extension-inventory.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { OfficialCatalogView } from "../src/core/official-catalog-view.ts";
import { OfficialExtensionError } from "../src/core/official-transport.ts";
import type { PackageManager } from "../src/core/package-manager.ts";
import type { SourceScope } from "../src/core/source-info.ts";
import { ExtensionManagerComponent } from "../src/modes/interactive/components/extension-manager.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { GIT_EXTENSION_URL, gitExtensionReview } from "./fixtures/git-extension-review.ts";

function installation(source = "official:fixture", scope: SourceScope = "user", managed = true): InstalledExtension {
	return {
		identity: JSON.stringify([scope, source]),
		source,
		scope,
		configured: true,
		installedPath: "/managed/fixture",
		version: "1.0.0",
		status: "loaded",
		removal: managed && scope !== "temporary" ? { source, scope } : null,
		entries: [],
		errors: [],
	};
}

function catalog(): OfficialCatalogView {
	return {
		fetchedAt: 100,
		stale: false,
		error: null,
		offline: false,
		extensions: [
			{
				id: "fixture",
				compatibleVersion: "1.0.0",
				unavailableReason: null,
				manifest: {
					name: "fixture",
					version: "1.0.0",
					description: "Searchable rainbow tools",
					type: "module",
					engines: { grip: "*" },
					grip: {
						official: { id: "fixture", displayName: "Fixture" },
						extensions: ["index.js"],
						skills: [],
						rules: [],
						prompts: [],
						themes: [],
					},
				},
			},
		],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness(rows: InstalledExtension[] = [], view = catalog()) {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const getExtensionInventory = vi.fn(async () => rows);
	const getOfficialCatalog = vi.fn<PackageManager["getOfficialCatalog"]>(async () => view);
	const installAndPersist = vi.fn<PackageManager["installAndPersist"]>(async () => {});
	const removeAndPersist = vi.fn<PackageManager["removeAndPersist"]>(async () => true);
	const prepareGitExtension = vi.fn<PackageManager["prepareGitExtension"]>(async (_source, options) =>
		gitExtensionReview(options.scope),
	);
	const installPreparedGitExtension = vi.fn<PackageManager["installPreparedGitExtension"]>(
		async () => `${GIT_EXTENSION_URL}@${"a".repeat(40)}`,
	);
	const discardGitExtension = vi.fn<PackageManager["discardGitExtension"]>();
	const requestRender = vi.fn();
	const onClose = vi.fn();
	const themes: Pick<Theme, "fg">[] = [{ fg: (_color, text) => text }];
	const component = new ExtensionManagerComponent({
		keybindings,
		getTheme: () => themes[0],
		requestRender,
		onClose,
		packageManager: {
			getOfficialCatalog,
			installAndPersist,
			removeAndPersist,
			prepareGitExtension,
			installPreparedGitExtension,
			discardGitExtension,
		},
		resourceLoader: { getExtensionInventory },
	});
	component.focused = true;
	return {
		component,
		keybindings,
		getExtensionInventory,
		getOfficialCatalog,
		installAndPersist,
		removeAndPersist,
		prepareGitExtension,
		installPreparedGitExtension,
		discardGitExtension,
		requestRender,
		onClose,
		themes,
	};
}

function text(component: ExtensionManagerComponent): string {
	return stripTerminalSequences(component.render(150).join("\n"));
}

function choose(component: ExtensionManagerComponent, label: string): void {
	for (let attempt = 0; attempt < 30; attempt++) {
		const selectedLabel = text(component).match(/^→ (.*)$/m)?.[1];
		if (selectedLabel?.startsWith(label)) return;
		component.handleInput("\x1b[B");
	}
	throw new Error(`Choice not found: ${label}\n${text(component)}`);
}

function activate(component: ExtensionManagerComponent, label: string): void {
	choose(component, label);
	component.handleInput("\r");
}

async function openCatalog(component: ExtensionManagerComponent): Promise<void> {
	activate(component, "Install extension");
	await vi.waitFor(() => expect(text(component)).toContain("Refresh catalog"));
}

async function openInstallConfirmation(component: ExtensionManagerComponent): Promise<void> {
	await openCatalog(component);
	activate(component, "Fixture");
	activate(component, "Install");
}

async function openGitReview(component: ExtensionManagerComponent, scope = "User / active profile"): Promise<void> {
	activate(component, "Install from Git URL");
	component.handleInput(`${GIT_EXTENSION_URL}@main`);
	component.handleInput("\r");
	activate(component, scope);
	await vi.waitFor(() => expect(text(component)).toContain("Trust and install this commit"));
}

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("extension manager component", () => {
	it("offers browsing with no installed extensions, without fetching on open, and closes once", async () => {
		const h = harness();
		await h.component.initialize();
		expect(text(h.component)).toContain("No installed or configured remote extensions");
		expect(text(h.component)).toContain("Install extension");
		expect(h.getOfficialCatalog).not.toHaveBeenCalled();
		h.component.handleInput("\x1b");
		h.component.handleInput("\x1b");
		await vi.waitFor(() => expect(h.onClose).toHaveBeenCalledExactlyOnceWith(false));
		expect(h.component.render(80)).toEqual([]);
	});

	it.each(["user", "project"] as const)(
		"hides %s local extensions and keeps remote packages visible after refresh",
		async (scope) => {
			const rows = [installation("auto", scope, false), installation("./local-package", scope, false)];
			const h = harness(rows);
			await h.component.initialize();
			expect(text(h.component)).toContain("No installed or configured remote extensions.");
			expect(text(h.component)).not.toContain("auto");
			expect(text(h.component)).not.toContain("./local-package");
			expect(text(h.component)).toContain("Install extension");
			rows.push(
				installation("git:git@github.com:acme/remote.git", scope),
				installation("npm:remote", scope),
				installation(),
			);
			activate(h.component, "Refresh installed");
			await vi.waitFor(() => expect(text(h.component)).toContain("git:git@github.com:acme/remote.git"));
			expect(text(h.component)).toContain("npm:remote");
			expect(text(h.component)).toContain("official:fixture");
			expect(text(h.component)).not.toContain("No installed or configured remote extensions.");
			expect(text(h.component)).not.toContain("auto");
			expect(text(h.component)).not.toContain("./local-package");
			expect(rows).toHaveLength(5);
			expect(h.installAndPersist).not.toHaveBeenCalled();
			expect(h.removeAndPersist).not.toHaveBeenCalled();
			await h.component.dispose();
		},
	);

	it("renders scoped status, unknown versions, unmanaged remote protection and failed-entry provenance", async () => {
		const disabled = installation();
		disabled.status = "disabled";
		const failed = installation("npm:broken", "project");
		failed.status = "failed";
		failed.errors = ["Factory failed"];
		failed.entries = [
			{
				path: "/project/broken.js",
				status: "failed",
				errors: ["Entry error"],
				sourceInfo: { path: "/project/broken.js", source: "npm:broken", scope: "project", origin: "package" },
			},
		];
		const missing = installation("official:missing");
		missing.status = "missing";
		missing.installedPath = null;
		const manual = installation("npm:unmanaged", "temporary", false);
		manual.version = null;
		const h = harness([disabled, failed, missing, manual]);
		await h.component.initialize();
		expect(text(h.component)).toContain("disabled");
		expect(text(h.component)).toContain("missing");
		activate(h.component, "npm:broken");
		expect(text(h.component)).toContain("project/package");
		expect(text(h.component)).toContain("/project/broken.js");
		expect(text(h.component)).toContain("Factory failed");
		expect(text(h.component)).toContain("Entry error");
		h.component.handleInput("\x1b");
		activate(h.component, "npm:unmanaged");
		expect(text(h.component)).toContain("unknown (not reported)");
		expect(text(h.component)).toContain("Grip will not delete these files");
		expect(text(h.component)).not.toContain("Uninstall");
		expect(h.removeAndPersist).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it("preserves independent search and selection through detail/back and catalog/back", async () => {
		const h = harness([installation("npm:broken"), installation("npm:other")]);
		await h.component.initialize();
		h.component.handleInput("broken");
		expect(text(h.component)).not.toContain("npm:other");
		activate(h.component, "npm:broken");
		h.component.handleInput("\x1b");
		expect(text(h.component)).toContain("→ npm:broken");
		await openCatalog(h.component);
		h.component.handleInput("rainbow");
		activate(h.component, "Fixture");
		h.component.handleInput("\x1b");
		expect(text(h.component)).toContain("rainbow");
		expect(text(h.component)).toContain("→ Fixture");
		h.component.handleInput("\x1b");
		expect(text(h.component)).toContain("broken");
		expect(text(h.component)).not.toContain("npm:other");
		await openCatalog(h.component);
		expect(text(h.component)).toContain("rainbow");
		expect(h.getOfficialCatalog).toHaveBeenCalledTimes(1);
		await h.component.dispose();
	});

	it("renders empty cached/offline/error catalogs and offers explicit refresh", async () => {
		const view = catalog();
		view.extensions = [];
		view.offline = true;
		view.stale = true;
		view.error = new OfficialExtensionError("network", "Check network configuration");
		const h = harness([], view);
		await h.component.initialize();
		await openCatalog(h.component);
		expect(text(h.component)).toContain("No official extensions are currently published");
		expect(text(h.component)).toContain("Offline | stale cache");
		expect(text(h.component)).toContain("network: Check network configuration");
		activate(h.component, "Refresh catalog");
		await vi.waitFor(() => expect(h.getOfficialCatalog).toHaveBeenCalledTimes(2));
		expect(h.getOfficialCatalog.mock.calls[1][0]).toMatchObject({ refresh: true });
		await h.component.dispose();
	});

	it("shows a retry action when catalog service rejects rather than inventing an empty catalog", async () => {
		const h = harness();
		h.getOfficialCatalog.mockRejectedValue(new Error("No cache available"));
		await h.component.initialize();
		await openCatalog(h.component);
		expect(text(h.component)).toContain("No cache available");
		expect(text(h.component)).toContain("Catalog unavailable");
		expect(text(h.component)).not.toContain("No official extensions are currently published");
		await h.component.dispose();
	});

	it("requires trust confirmation and automatically closes only after install reconciliation settles", async () => {
		const rows: InstalledExtension[] = [];
		const h = harness(rows);
		const inventory = deferred<InstalledExtension[]>();
		h.getExtensionInventory.mockResolvedValueOnce(rows).mockReturnValueOnce(inventory.promise);
		h.installAndPersist.mockImplementation(async () => {
			const row = installation();
			row.status = "not-loaded";
			rows.push(row);
		});
		await h.component.initialize();
		await openInstallConfirmation(h.component);
		expect(text(h.component)).toContain("full access");
		expect(text(h.component)).toContain("not sandboxed");
		expect(text(h.component)).toContain("credentials");
		expect(text(h.component)).toContain("→ Cancel");
		h.component.handleInput("\r");
		expect(h.installAndPersist).not.toHaveBeenCalled();
		activate(h.component, "Install");
		activate(h.component, "Confirm");
		await vi.waitFor(() => expect(h.getExtensionInventory).toHaveBeenCalledTimes(2));
		expect(h.onClose).not.toHaveBeenCalled();
		expect(text(h.component)).toContain("install: working");
		h.component.handleInput("\r");
		expect(h.installAndPersist).toHaveBeenCalledExactlyOnceWith(
			"official:fixture",
			expect.objectContaining({
				official: expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }),
			}),
		);
		inventory.resolve(rows);
		await vi.waitFor(() => expect(h.onClose).toHaveBeenCalledExactlyOnceWith(true));
		expect(h.component.render(80)).toEqual([]);
		h.component.handleInput("\x1b");
		expect(h.onClose).toHaveBeenCalledTimes(1);
	});

	it("keeps the manager open when cancellation arrives during post-install inventory reconciliation", async () => {
		const h = harness();
		const inventory = deferred<InstalledExtension[]>();
		h.getExtensionInventory.mockResolvedValueOnce([]).mockReturnValueOnce(inventory.promise);
		await h.component.initialize();
		await openInstallConfirmation(h.component);
		activate(h.component, "Confirm");
		await vi.waitFor(() => expect(h.getExtensionInventory).toHaveBeenCalledTimes(2));
		h.component.handleInput("\x1b");
		inventory.resolve([installation()]);
		await vi.waitFor(() => expect(text(h.component)).not.toContain("install: working"));
		expect(text(h.component)).toContain("Saved.");
		expect(text(h.component)).toContain("Reload/restart pending");
		expect(h.onClose).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it("confirms an owned uninstall with exact scope and data-preservation explanation", async () => {
		const row = installation("npm:third-party", "project");
		const h = harness([row]);
		await h.component.initialize();
		activate(h.component, "npm:third-party");
		activate(h.component, "Uninstall");
		expect(text(h.component)).toContain("from project scope?");
		expect(text(h.component).replace(/\s+/g, " ")).toContain(
			"configuration/data outside the managed installation are preserved",
		);
		expect(h.removeAndPersist).not.toHaveBeenCalled();
		activate(h.component, "Confirm");
		await vi.waitFor(() => expect(text(h.component)).toContain("Saved."));
		expect(h.removeAndPersist).toHaveBeenCalledWith(row.source, expect.objectContaining({ local: true }));
		await h.component.dispose();
	});

	it("explains unavailable releases without offering install", async () => {
		const view = catalog();
		view.extensions[0].compatibleVersion = null;
		view.extensions[0].unavailableReason = "No compatible stable release for Grip 0.1.8.";
		const h = harness([], view);
		await h.component.initialize();
		await openCatalog(h.component);
		activate(h.component, "Fixture");
		expect(text(h.component)).toContain("No compatible stable release");
		expect(text(h.component)).toContain("Compatible stable version: none");
		expect(text(h.component)).not.toContain("→ Install");
		h.component.handleInput("\r");
		expect(h.installAndPersist).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it.each([false, true])("keeps cancellation visible after settlement (committed=%s)", async (committed) => {
		const h = harness();
		const pending = deferred<void>();
		h.installAndPersist.mockImplementation(async (_source, options) => {
			options?.official?.onProgress?.({ id: "fixture", phase: "downloading" });
			await pending.promise;
		});
		await h.component.initialize();
		await openInstallConfirmation(h.component);
		activate(h.component, "Confirm");
		await vi.waitFor(() => expect(text(h.component)).toContain("install: downloading"));
		h.component.handleInput("\x1b");
		h.component.handleInput("\x1b");
		expect(h.installAndPersist.mock.calls[0][1]?.official?.signal?.aborted).toBe(true);
		expect(text(h.component)).toContain("Cancellation requested");
		expect(h.onClose).not.toHaveBeenCalled();
		if (committed) pending.resolve();
		else pending.reject(new OfficialExtensionError("canceled", "Canceled"));
		await vi.waitFor(() => expect(text(h.component)).toContain(committed ? "Saved." : "does not guarantee rollback"));
		expect(h.getExtensionInventory).toHaveBeenCalledTimes(2);
		expect(text(h.component)).toContain("Reload/restart pending");
		expect(h.onClose).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it("keeps failed install diagnostics visible instead of automatically closing", async () => {
		const h = harness();
		h.installAndPersist.mockRejectedValue(new OfficialExtensionError("network", "Download failed"));
		await h.component.initialize();
		await openInstallConfirmation(h.component);
		activate(h.component, "Confirm");
		await vi.waitFor(() => expect(text(h.component)).toContain("Download failed"));
		expect(text(h.component)).toContain("does not guarantee rollback");
		expect(h.getExtensionInventory).toHaveBeenCalledTimes(2);
		expect(h.onClose).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it("keeps non-official removals mounted without promising subprocess cancellation", async () => {
		const h = harness([installation("npm:third-party")]);
		const pending = deferred<boolean>();
		h.removeAndPersist.mockImplementation(() => pending.promise);
		await h.component.initialize();
		activate(h.component, "npm:third-party");
		activate(h.component, "Uninstall");
		activate(h.component, "Confirm");
		await vi.waitFor(() => expect(text(h.component)).toContain("remove: working"));
		h.component.handleInput("\x1b");
		expect(text(h.component)).toContain("Wait for this operation to settle");
		expect(text(h.component)).not.toContain("request cancellation");
		expect(h.onClose).not.toHaveBeenCalled();
		pending.resolve(true);
		await vi.waitFor(() => expect(text(h.component)).toContain("Saved."));
		await h.component.dispose();
	});

	it("honors remapped selection/edit keys and renders their hints without hardcoded fallbacks", async () => {
		const h = harness();
		h.keybindings.setUserBindings({
			"tui.select.confirm": "ctrl+y",
			"tui.select.cancel": "ctrl+x",
			"tui.select.down": "ctrl+n",
			"tui.select.up": "ctrl+p",
			"tui.editor.deleteCharBackward": "ctrl+q",
		});
		await h.component.initialize();
		expect(text(h.component)).toContain("ctrl+y select");
		h.component.handleInput("\r");
		expect(h.getOfficialCatalog).not.toHaveBeenCalled();
		h.component.handleInput("z");
		h.component.handleInput("\x11");
		expect(text(h.component)).not.toContain("z");
		h.component.handleInput("\x19");
		await vi.waitFor(() => expect(text(h.component)).toContain("Refresh catalog"));
		expect(text(h.component)).toContain("→ Fixture");
		h.component.handleInput("\x1b");
		expect(text(h.component)).toContain("Official catalog");
		h.component.handleInput("\x0e");
		h.component.handleInput("\x19");
		await vi.waitFor(() => expect(h.getOfficialCatalog).toHaveBeenCalledTimes(2));
		h.component.handleInput("\x18");
		await vi.waitFor(() => expect(text(h.component)).not.toContain("catalog: working"));
		await h.component.dispose();
	});

	it("forwards focus/IME to active search only, not detail, confirmation or detached UI", async () => {
		const h = harness();
		await h.component.initialize();
		expect(h.component.render(80).join("\n")).toContain(CURSOR_MARKER);
		h.component.focused = false;
		expect(h.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		h.component.focused = true;
		await openCatalog(h.component);
		expect(h.component.render(80).join("\n")).toContain(CURSOR_MARKER);
		activate(h.component, "Fixture");
		expect(h.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		activate(h.component, "Install");
		expect(h.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
		await h.component.dispose();
		expect(h.component.render(80)).toEqual([]);
	});

	it("uses inline selector borders and spacing on every page without an overlay frame", async () => {
		const h = harness();
		await h.component.initialize();
		const assertLayout = () => {
			const lines = h.component.render(76).map(stripTerminalSequences);
			expect(lines[0]).toBe("─".repeat(76));
			expect(lines[1]).toBe("");
			expect(lines[2]).toBe("Extensions");
			expect(lines.at(-2)).toBe("");
			expect(lines.at(-1)).toBe("─".repeat(76));
			expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│]/);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(76);
		};
		assertLayout();
		const search = h.component.render(76).find((line) => line.includes(CURSOR_MARKER))!;
		expect(stripTerminalSequences(search.slice(0, search.indexOf(CURSOR_MARKER)))).toBe("> ");
		await openCatalog(h.component);
		assertLayout();
		activate(h.component, "Fixture");
		assertLayout();
		activate(h.component, "Install");
		assertLayout();
		await h.component.dispose();
	});

	it("keeps inline borders while closing and waiting for inventory to settle", async () => {
		const h = harness();
		const pending = deferred<InstalledExtension[]>();
		h.getExtensionInventory.mockReturnValue(pending.promise);
		const initialization = h.component.initialize();
		await vi.waitFor(() => expect(h.getExtensionInventory).toHaveBeenCalledOnce());
		h.component.handleInput("\x1b");
		const lines = h.component.render(76).map(stripTerminalSequences);
		expect(lines[0]).toBe("─".repeat(76));
		expect(lines.at(-1)).toBe("─".repeat(76));
		expect(lines.join("\n")).toContain("Closing; waiting for management work to settle...");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(76);
		pending.resolve([]);
		await initialization;
		await vi.waitFor(() => expect(h.onClose).toHaveBeenCalledExactlyOnceWith(false));
	});

	it("is width-safe with Unicode/hostile metadata and resolves the current theme after invalidation", async () => {
		const view = catalog();
		view.extensions[0].manifest!.description = `${"界🌈".repeat(30)}\x1b]52;c;secret\x07\n\r\x00`;
		const h = harness([], view);
		await h.component.initialize();
		await openCatalog(h.component);
		const assertWidths = () => {
			for (const width of [0, 1, 2, 3, 4, 5, 8, 24, 40, 80]) {
				for (const line of h.component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		};
		assertWidths();
		activate(h.component, "Fixture");
		assertWidths();
		expect(h.component.render(150).join("\n")).not.toContain("\x1b]52");
		expect(h.component.render(150).join("\n")).not.toContain("\x00");
		activate(h.component, "Install");
		assertWidths();
		h.themes[0] = { fg: (_color, value) => `\x1b[31m${value}\x1b[39m` };
		h.component.invalidate();
		expect(h.component.render(80).join("\n")).toContain("\x1b[31m");
		assertWidths();
		await h.component.dispose();
	});

	it("blocks mutation after inventory failure, and retries through the visible refresh action", async () => {
		const h = harness([installation()]);
		h.getExtensionInventory.mockRejectedValueOnce(new Error("Settings unreadable"));
		await h.component.initialize();
		expect(text(h.component)).toContain("Inventory unavailable: Settings unreadable");
		activate(h.component, "Refresh installed");
		await vi.waitFor(() => expect(text(h.component)).not.toContain("Inventory unavailable"));
		activate(h.component, "official:fixture");
		expect(text(h.component)).toContain("Uninstall");
		await h.component.dispose();
	});

	it("awaits mutation disposal and suppresses render/close callbacks after replacement", async () => {
		const h = harness();
		const pending = deferred<void>();
		h.installAndPersist.mockImplementation(() => pending.promise);
		await h.component.initialize();
		await openInstallConfirmation(h.component);
		activate(h.component, "Confirm");
		await vi.waitFor(() => expect(h.installAndPersist).toHaveBeenCalledTimes(1));
		const dispose = h.component.dispose();
		let settled = false;
		void dispose.then(() => {
			settled = true;
		});
		const renderCount = h.requestRender.mock.calls.length;
		h.component.handleInput("\x1b");
		await Promise.resolve();
		expect(settled).toBe(false);
		pending.resolve();
		expect(await dispose).toBe(true);
		expect(h.onClose).not.toHaveBeenCalled();
		expect(h.requestRender).toHaveBeenCalledTimes(renderCount);
		expect(h.getExtensionInventory).toHaveBeenCalledTimes(1);
	});
});

describe("Git extension manager component", () => {
	it("offers Git installation from both lists without depending on the official catalog", async () => {
		const h = harness();
		await h.component.initialize();
		expect(text(h.component)).toContain("Install from Git URL");
		await openCatalog(h.component);
		expect(text(h.component)).toContain("Install from Git URL");
		activate(h.component, "Install from Git URL");
		expect(text(h.component)).toContain("HTTPS or SSH only");
		expect(h.prepareGitExtension).not.toHaveBeenCalled();
		h.component.handleInput("\x1b");
		expect(text(h.component)).toContain("Official catalog");
		await h.component.dispose();
	});

	it.each(["user", "project"] as const)(
		"reviews %s destination, captured profile and full permissions with Cancel selected",
		async (scope) => {
			const h = harness();
			await h.component.initialize();
			await openGitReview(h.component, scope === "user" ? "User / active profile" : "Project");
			const screen = text(h.component);
			expect(screen).toContain("Third-party / unverified Git package");
			expect(screen).toContain(`Source: ${GIT_EXTENSION_URL}`);
			expect(screen).toContain("Requested ref: main");
			expect(screen).toContain("a".repeat(40));
			expect(screen).toContain(`Destination: ${scope} | user profile: work`);
			expect(screen).toContain("Entry: extension.ts");
			expect(screen).toContain("dependency install scripts");
			expect(screen).toContain("filesystem, network and credential access");
			expect(screen).toContain("not sandboxing or publisher authentication");
			expect(screen).toContain("skills, rules, prompts and themes");
			expect(screen).toContain("does not establish trust");
			expect(screen).toContain("Saving is not activation");
			expect(screen).toContain("not automatically updated");
			expect(screen).toContain("→ Cancel");
			expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
			h.component.handleInput("\r");
			expect(text(h.component)).toContain("HTTPS or SSH only");
			expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
			expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
			expect(await h.component.dispose()).toBe(false);
		},
	);

	it.each(["npm:third-party", "./local", "https://token@example.com/extension"])(
		"rejects %s visibly before preparing",
		async (source) => {
			const h = harness();
			await h.component.initialize();
			activate(h.component, "Install from Git URL");
			h.component.handleInput(source);
			h.component.handleInput("\r");
			expect(text(h.component)).toMatch(/Other sources are not supported|Do not embed credentials/);
			expect(text(h.component)).toContain("HTTPS or SSH only");
			expect(h.prepareGitExtension).not.toHaveBeenCalled();
			expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
			await h.component.dispose();
		},
	);

	it("shows preparation errors without an approval action or package selection", async () => {
		const h = harness();
		h.prepareGitExtension.mockRejectedValue(new Error("Missing package.json grip.extensions"));
		await h.component.initialize();
		activate(h.component, "Install from Git URL");
		h.component.handleInput(GIT_EXTENSION_URL);
		h.component.handleInput("\r");
		activate(h.component, "Project");
		await vi.waitFor(() => expect(text(h.component)).toContain("Missing package.json grip.extensions"));
		expect(text(h.component)).not.toContain("Trust and install");
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
		expect(h.onClose).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it("shows cancelable preparation progress and cleans a late review before accepting more input", async () => {
		const h = harness();
		const pending = deferred<ReturnType<typeof gitExtensionReview>>();
		h.prepareGitExtension.mockReturnValue(pending.promise);
		await h.component.initialize();
		activate(h.component, "Install from Git URL");
		h.component.handleInput(GIT_EXTENSION_URL);
		h.component.handleInput("\r");
		activate(h.component, "User / active profile");
		await vi.waitFor(() => expect(h.prepareGitExtension).toHaveBeenCalledOnce());
		expect(text(h.component)).toContain("git-prepare: working");
		expect(text(h.component)).toContain("request cancellation");
		h.component.handleInput("\r");
		h.component.handleInput("\x1b");
		expect(text(h.component)).toContain("Cancellation requested; waiting for settlement");
		expect(h.onClose).not.toHaveBeenCalled();
		expect(h.prepareGitExtension.mock.calls[0][1].signal.aborted).toBe(true);
		pending.resolve(gitExtensionReview());
		await vi.waitFor(() => expect(text(h.component)).toContain("No code was approved"));
		expect(text(h.component)).not.toContain("Trust and install");
		expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it("installs once only on affirmative trust, waits through settlement and inventory, then asks the host to reload", async () => {
		const h = harness();
		const installing = deferred<string>();
		const inventory = deferred<InstalledExtension[]>();
		h.installPreparedGitExtension.mockReturnValue(installing.promise);
		await h.component.initialize();
		await openGitReview(h.component);
		h.getExtensionInventory.mockReturnValueOnce(inventory.promise);
		activate(h.component, "Trust and install this commit");
		await vi.waitFor(() => expect(h.installPreparedGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture"));
		expect(text(h.component)).toContain("git-install: working");
		expect(text(h.component)).toContain("Wait for this operation to settle");
		h.component.handleInput("\r");
		h.component.handleInput("\x1b");
		expect(text(h.component)).not.toContain("Cancellation requested");
		expect(h.onClose).not.toHaveBeenCalled();
		installing.resolve("pinned source");
		await vi.waitFor(() => expect(h.getExtensionInventory).toHaveBeenCalledTimes(2));
		expect(h.onClose).not.toHaveBeenCalled();
		inventory.resolve([]);
		await vi.waitFor(() => expect(h.onClose).toHaveBeenCalledExactlyOnceWith(true));
		expect(h.installPreparedGitExtension).toHaveBeenCalledOnce();
		expect(h.installAndPersist).not.toHaveBeenCalled();
		expect(h.discardGitExtension).not.toHaveBeenCalled();
	});

	it.each(["Dependency installation failed", "Files installed, but package selection could not be verified"])(
		"keeps %s visible, refreshes inventory and gives reconciliation guidance",
		async (message) => {
			const h = harness();
			h.installPreparedGitExtension.mockRejectedValue(new Error(message));
			await h.component.initialize();
			await openGitReview(h.component);
			activate(h.component, "Trust and install this commit");
			await vi.waitFor(() => expect(text(h.component)).toContain(message));
			expect(text(h.component)).toContain("Review inventory/settings before retrying");
			expect(text(h.component)).toMatch(/cannot be\s+rolled back automatically/);
			expect(text(h.component)).toContain("Reload/restart pending");
			expect(h.getExtensionInventory).toHaveBeenCalledTimes(2);
			expect(h.onClose).not.toHaveBeenCalled();
			await h.component.dispose();
		},
	);

	it("uses remapped input, selection and cancellation bindings without granting trust", async () => {
		const h = harness();
		await h.component.initialize();
		activate(h.component, "Install from Git URL");
		h.keybindings.setUserBindings({
			"tui.input.submit": "ctrl+s",
			"tui.select.confirm": "ctrl+y",
			"tui.select.cancel": "ctrl+x",
			"tui.select.down": "ctrl+n",
		});
		h.component.handleInput(GIT_EXTENSION_URL);
		expect(text(h.component)).toContain("ctrl+s continue to destination");
		h.component.handleInput("\r");
		expect(text(h.component)).toContain("HTTPS or SSH only");
		h.component.handleInput("\x13");
		expect(text(h.component)).toContain("Choose the install destination");
		h.component.handleInput("\x0e");
		h.component.handleInput("\x19");
		await vi.waitFor(() => expect(text(h.component)).toContain("Trust and install this commit"));
		expect(h.prepareGitExtension.mock.calls[0][1].scope).toBe("project");
		expect(text(h.component)).toContain("→ Cancel");
		h.component.handleInput("\x18");
		expect(h.discardGitExtension).toHaveBeenCalledExactlyOnceWith("review-fixture");
		expect(h.installPreparedGitExtension).not.toHaveBeenCalled();
		await h.component.dispose();
	});

	it("renders narrow Git input/review safely and follows focus", async () => {
		const h = harness();
		const review = gitExtensionReview();
		review.name = "\x1b[31muntrusted\x1b[0m\nname";
		review.entries = [`${"nested/".repeat(20)}entry.ts`];
		h.prepareGitExtension.mockResolvedValue(review);
		await h.component.initialize();
		activate(h.component, "Install from Git URL");
		expect(h.component.render(40).join("\n")).toContain(CURSOR_MARKER);
		h.component.focused = false;
		expect(h.component.render(40).join("\n")).not.toContain(CURSOR_MARKER);
		h.component.focused = true;
		h.component.handleInput(GIT_EXTENSION_URL);
		h.component.handleInput("\r");
		activate(h.component, "User / active profile");
		await vi.waitFor(() => expect(text(h.component)).toContain("Trust and install this commit"));
		expect(h.component.render(40).join("\n")).not.toContain("\x1b[31m");
		for (const width of [1, 7, 20, 40, 80]) {
			for (const line of h.component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(h.component.render(40).join("\n")).not.toContain(CURSOR_MARKER);
		await h.component.dispose();
	});

	it.each(["failed", "disabled", "not-loaded"] as const)(
		"preserves %s inventory after reload rather than equating selection with activation",
		async (status) => {
			const row = installation(`${GIT_EXTENSION_URL}@${"a".repeat(40)}`);
			row.status = status;
			if (status === "failed") row.errors = ["Extension must export a default factory function"];
			const h = harness([row]);
			await h.component.initialize();
			activate(h.component, "https://example.com/");
			expect(text(h.component)).toContain(status);
			expect(text(h.component)).toContain("Third-party / unverified");
			expect(text(h.component)).toContain("Not part of official automatic updates");
			if (status === "failed") {
				expect(text(h.component)).toContain("default factory function");
				expect(text(h.component)).toContain("disable or uninstall");
			}
			if (status !== "failed") expect(text(h.component)).not.toContain("successful activation");
			activate(h.component, "Uninstall");
			expect(text(h.component)).toContain("Only this managed package selection/install is removed");
			expect(h.removeAndPersist).not.toHaveBeenCalled();
			await h.component.dispose();
		},
	);
});
