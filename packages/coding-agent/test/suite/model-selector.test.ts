import type { Api, Model } from "@greppleai/grip-ai";
import { setKeybindings, type TUI, visibleWidth } from "@greppleai/grip-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../src/modes/interactive/components/model-selector.ts";
import { InteractiveMode, type SelectorFactory } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

interface PickerOptions {
	current: Model<Api> | undefined;
	scoped: Model<Api>[];
	query: string | undefined;
	persist: boolean;
}

function rendered(selector: ModelSelectorComponent, width = 120): string {
	return stripAnsi(selector.render(width).join("\n"));
}

function selected(selector: ModelSelectorComponent): string | undefined {
	return rendered(selector)
		.split("\n")
		.find((line) => line.startsWith("→ "))
		?.trim();
}

function typeQuery(selector: ModelSelectorComponent, query: string): void {
	for (const character of query) selector.handleInput(character);
}

interface ModelPickerFooter {
	invalidate: () => void;
}

interface ModelCommandHost {
	session: Harness["session"];
	settingsManager: Harness["settingsManager"];
	ui: TUI;
	footer: ModelPickerFooter;
	showSelector: (factory: SelectorFactory) => void;
	showModelSelector: (query?: string) => void;
	getModelCandidates: () => Promise<Model<Api>[]>;
	findExactModelMatch: (query: string) => Promise<Model<Api> | undefined>;
	updateEditorBorderColor: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	maybeWarnAboutAnthropicSubscriptionAuth: (model: Model<Api>) => Promise<void>;
}

interface ModelCommandPrototype {
	handleModelCommand(this: ModelCommandHost, query?: string): Promise<void>;
	showModelSelector(this: ModelCommandHost, query?: string): void;
	getModelCandidates(this: ModelCommandHost): Promise<Model<Api>[]>;
	findExactModelMatch(this: ModelCommandHost, query: string): Promise<Model<Api> | undefined>;
	handleCompressionDetectionModelCommand(this: ModelCommandHost, query: string): Promise<void>;
}

const commands = InteractiveMode.prototype as unknown as ModelCommandPrototype;

describe("native provider-first model selector", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			models: [
				{ id: "shared", name: "Current Model", reasoning: true },
				{ id: "alpha", name: "Friendly Name", reasoning: false },
				{ id: "zeta", name: "Last Model", reasoning: true },
			],
		});
		harnesses.push(harness);
		return harness;
	}

	function addProvider(harness: Harness, id = "custom", name = "Custom Cloud", count = 1): Model<Api> {
		const base = harness.getModel();
		harness.session.modelRegistry.registerProvider(id, {
			name,
			api: base.api,
			apiKey: "faux-key",
			baseUrl: base.baseUrl,
			models: Array.from({ length: count }, (_, index) => ({
				...base,
				id: index === 0 ? "shared" : `model-${String(index).padStart(2, "0")}`,
				name: `模型 👩‍💻 ${index}`,
			})),
		});
		return harness.session.modelRegistry.find(id, "shared")!;
	}

	async function picker(harness: Harness, overrides: Partial<PickerOptions> = {}) {
		const options: PickerOptions = {
			current: harness.getModel(),
			scoped: [],
			query: undefined,
			persist: true,
			...overrides,
		};
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new ModelSelectorComponent(
			{ requestRender: vi.fn() } as unknown as TUI,
			options.current,
			harness.settingsManager,
			harness.session.modelRegistry,
			options.scoped.map((model) => ({ model })),
			onSelect,
			onCancel,
			options.query,
			options.persist,
		);
		await vi.waitFor(() => expect(rendered(selector)).not.toContain("Loading models"));
		return { selector, onSelect, onCancel };
	}

	function commandHost(harness: Harness) {
		const pickers: ModelSelectorComponent[] = [];
		const done = vi.fn();
		const host: ModelCommandHost = {
			session: harness.session,
			settingsManager: harness.settingsManager,
			ui: { requestRender: vi.fn() } as unknown as TUI,
			footer: { invalidate: vi.fn() },
			showSelector: (factory) => {
				const view = factory(done);
				expect(view.focus).toBe(view.component);
				expect(view.component).toBeInstanceOf(ModelSelectorComponent);
				pickers.push(view.component as ModelSelectorComponent);
			},
			showModelSelector: commands.showModelSelector,
			getModelCandidates: commands.getModelCandidates,
			findExactModelMatch: commands.findExactModelMatch,
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		};
		return { host, pickers, done };
	}

	it("never skips the provider screen with one provider and does not persist navigation/cancellation", async () => {
		const harness = await setup();
		harness.settingsManager.setDefaultModelAndProvider("saved", "default");
		const { selector, onSelect, onCancel } = await picker(harness);
		expect(rendered(selector)).toContain("Providers");
		expect(selected(selector)).toBe("→ faux [faux] (3 models) ✓");
		expect(rendered(selector)).not.toContain("Model Name:");
		selector.handleInput("\r");
		expect(selected(selector)).toBe("→ shared [faux] ✓");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("\x1b");
		expect(rendered(selector)).toContain("Providers");
		expect(onCancel).not.toHaveBeenCalled();
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
		expect(harness.settingsManager.getDefaultProvider()).toBe("saved");
		expect(harness.settingsManager.getDefaultModel()).toBe("default");
	});

	it("groups custom display names/counts and selects duplicate IDs by provider", async () => {
		const harness = await setup();
		const custom = addProvider(harness);
		const { selector, onSelect } = await picker(harness);
		expect(rendered(selector)).toContain("Custom Cloud [custom] (1 models)");
		expect(selected(selector)).toContain("faux [faux]");
		selector.handleInput("\x1b[A");
		expect(selected(selector)).toContain("Custom Cloud");
		selector.handleInput("\r");
		expect(selected(selector)).toBe("→ shared [custom]");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(custom);
		expect(harness.settingsManager.getDefaultProvider()).toBe("custom");
		expect(harness.settingsManager.getDefaultModel()).toBe("shared");
	});

	it("restores provider query and position on back and clears model search on reentry", async () => {
		const harness = await setup();
		addProvider(harness, "cloud-one", "Cloud One");
		addProvider(harness, "cloud-two", "Cloud Two");
		const { selector } = await picker(harness);
		typeQuery(selector, "cloud");
		expect(selected(selector)).toContain("Cloud One");
		selector.handleInput("\x1b[B");
		expect(selected(selector)).toContain("Cloud Two");
		selector.handleInput("\r");
		expect(selector.getSearchInput().getValue()).toBe("");
		typeQuery(selector, "no-such-model");
		expect(rendered(selector)).toContain("No matching models");
		selector.handleInput("\x1b");
		expect(selector.getSearchInput().getValue()).toBe("cloud");
		expect(selected(selector)).toContain("Cloud Two");
		selector.handleInput("\r");
		expect(selector.getSearchInput().getValue()).toBe("");
		expect(selected(selector)).toContain("shared");
	});

	it("resets provider matches on query edits, clamps on clearing, and ignores empty confirmation", async () => {
		const harness = await setup();
		addProvider(harness);
		const { selector, onSelect } = await picker(harness);
		typeQuery(selector, "c");
		expect(selected(selector)).toContain("Custom Cloud");
		selector.handleInput("\x7f");
		expect(selected(selector)).toContain("Custom Cloud");
		typeQuery(selector, "zzzzzz");
		expect(rendered(selector)).toContain("No matching providers");
		selector.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();
		expect(rendered(selector)).toContain("Providers");
	});

	it("searches model names and retains current-first, deterministic all-model order", async () => {
		const harness = await setup();
		const { selector, onSelect } = await picker(harness);
		selector.handleInput("\r");
		const list = rendered(selector);
		expect(list.indexOf("shared [")).toBeLessThan(list.indexOf("alpha ["));
		expect(list.indexOf("alpha [")).toBeLessThan(list.indexOf("zeta ["));
		typeQuery(selector, "Friendly");
		expect(selected(selector)).toContain("alpha [faux]");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(harness.getModel("alpha"));
	});

	it("preserves scoped order and rebuilds provider groups when scope changes", async () => {
		const harness = await setup();
		addProvider(harness);
		const { selector } = await picker(harness, { scoped: [harness.getModel("zeta")!, harness.getModel("alpha")!] });
		expect(rendered(selector)).not.toContain("Custom Cloud");
		expect(rendered(selector)).toContain("(2 models)");
		selector.handleInput("\r");
		expect(selected(selector)).toContain("zeta [faux]");
		selector.handleInput("\t");
		expect(rendered(selector)).toContain("Providers");
		expect(rendered(selector)).toContain("Custom Cloud");
		typeQuery(selector, "custom");
		selector.handleInput("\r");
		selector.handleInput("\t");
		expect(rendered(selector)).toContain("Providers");
		expect(rendered(selector)).not.toContain("Custom Cloud");
		expect(selector.getSearchInput().getValue()).toBe("");
	});

	it("retains cross-provider explicit query search and exits it directly", async () => {
		const harness = await setup();
		addProvider(harness);
		const { selector, onCancel } = await picker(harness, { query: "shared" });
		expect(rendered(selector)).toContain("Search all providers");
		expect(rendered(selector)).toContain("shared [custom]");
		expect(rendered(selector)).toContain("shared [faux]");
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("wraps and scrolls through models, supports pages and renders Unicode at narrow widths", async () => {
		const harness = await setup();
		addProvider(harness, "wide", "日本語 👩‍💻 Cloud", 15);
		const { selector } = await picker(harness);
		typeQuery(selector, "wide");
		selector.handleInput("\r");
		selector.handleInput("\x1b[A");
		expect(selected(selector)).toContain("shared [wide]");
		expect(rendered(selector)).toContain("(15/15)");
		selector.handleInput("\x1b[B");
		expect(selected(selector)).toContain("model-01");
		selector.handleInput("\x1b[6~");
		expect(selected(selector)).toContain("model-11");
		selector.handleInput("\x1b[5~");
		expect(selected(selector)).toContain("model-01");
		for (const width of [8, 20, 40]) {
			for (const line of selector.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		selector.focused = true;
		expect(selector.getSearchInput().focused).toBe(true);
		selector.focused = false;
		expect(selector.getSearchInput().focused).toBe(false);
	});

	it("uses configurable navigation, confirmation and cancellation with matching hints", async () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.confirm": "ctrl+e",
				"tui.select.cancel": "ctrl+q",
				"tui.select.down": "ctrl+n",
			}),
		);
		const harness = await setup();
		const { selector, onSelect, onCancel } = await picker(harness);
		expect(rendered(selector)).toContain("ctrl+e models");
		selector.handleInput("\x05");
		selector.handleInput("\x0e");
		expect(selected(selector)).toContain("alpha [faux]");
		selector.handleInput("\x11");
		expect(rendered(selector)).toContain("Providers");
		selector.handleInput("\x11");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("refreshes scoped instances and shows nonfatal registry errors alongside available models", async () => {
		const harness = await setup();
		const stale = { ...harness.getModel(), name: "stale" };
		const refresh = vi.spyOn(harness.session.modelRegistry, "refresh");
		vi.spyOn(harness.session.modelRegistry, "getError").mockReturnValue("Invalid models.json");
		const { selector, onSelect } = await picker(harness, { scoped: [stale] });
		expect(refresh).toHaveBeenCalledOnce();
		expect(rendered(selector)).toContain("Invalid models.json");
		selector.handleInput("\r");
		expect(rendered(selector)).toContain("Current Model");
		expect(rendered(selector)).not.toContain("stale");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(harness.getModel());
	});

	it("shows empty availability without accidentally selecting", async () => {
		const harness = await setup();
		vi.spyOn(harness.session.modelRegistry, "getAvailable").mockReturnValue([]);
		const { selector, onSelect } = await picker(harness);
		expect(rendered(selector)).toContain("Providers");
		expect(rendered(selector)).toContain("No matching providers");
		selector.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it.each(["refresh", "getAvailable"] as const)("shows %s failures without selecting a model", async (method) => {
		const harness = await setup();
		vi.spyOn(harness.session.modelRegistry, method).mockImplementation(() => {
			throw new Error("Registry failed");
		});
		const { selector, onSelect } = await picker(harness);
		expect(rendered(selector)).toContain("Registry failed");
		selector.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("routes exact references directly and unmatched queries to cross-provider search", async () => {
		const harness = await setup();
		addProvider(harness);
		const { host, pickers } = commandHost(harness);
		await commands.handleModelCommand.call(host, "custom/shared");
		expect(harness.session.model?.provider).toBe("custom");
		expect(pickers).toHaveLength(0);
		expect(host.footer.invalidate).toHaveBeenCalledOnce();
		await commands.handleModelCommand.call(host, "shar");
		await vi.waitFor(() => expect(rendered(pickers[0])).toContain("shared [faux]"));
		expect(rendered(pickers[0])).toContain("Search all providers");
	});

	it("uses the primary callback lifecycle and reports model-switch failures", async () => {
		const harness = await setup();
		const { host, pickers, done } = commandHost(harness);
		await commands.handleModelCommand.call(host);
		const selector = pickers[0];
		await vi.waitFor(() => expect(rendered(selector)).toContain("(3 models)"));
		selector.handleInput("\r");
		typeQuery(selector, "alpha");
		selector.handleInput("\r");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(harness.session.model?.id).toBe("alpha");
		expect(harness.settingsManager.getDefaultModel()).toBe("alpha");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(host.footer.invalidate).toHaveBeenCalledOnce();
		expect(host.updateEditorBorderColor).toHaveBeenCalledOnce();
		const switchModel = vi.spyOn(harness.session, "setModel").mockRejectedValue(new Error("Selection failed"));
		host.showModelSelector("zet");
		const failedSelector = pickers[1];
		await vi.waitFor(() => expect(rendered(failedSelector)).toContain("zeta [faux]"));
		failedSelector.handleInput("\r");
		await vi.waitFor(() => expect(host.showError).toHaveBeenCalledWith("Selection failed"));
		expect(switchModel).toHaveBeenCalledWith(harness.getModel("zeta"));
		expect(harness.session.model?.id).toBe("alpha");
		expect(host.footer.invalidate).toHaveBeenCalledOnce();
		expect(done).toHaveBeenCalledTimes(2);
	});

	it("isolates actual detector selection from primary defaults and session model", async () => {
		const harness = await setup();
		addProvider(harness);
		harness.settingsManager.setDefaultModelAndProvider("faux", "alpha");
		const primary = harness.session.model;
		const { host, pickers } = commandHost(harness);
		await commands.handleCompressionDetectionModelCommand.call(host, "");
		const selector = pickers[0];
		await vi.waitFor(() => expect(rendered(selector)).toContain("Custom Cloud"));
		typeQuery(selector, "custom");
		selector.handleInput("\r");
		selector.handleInput("\r");
		expect(harness.settingsManager.getCompressionDetectionModel()).toBe("custom/shared");
		expect(harness.session.model).toBe(primary);
		expect(harness.settingsManager.getDefaultProvider()).toBe("faux");
		expect(harness.settingsManager.getDefaultModel()).toBe("alpha");
	});
});
