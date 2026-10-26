import { getKeybindings, setKeybindings, visibleWidth } from "@greppleai/grip-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { inspectOfficialExtension, OFFICIAL_EXTENSIONS } from "../src/core/official-extensions.ts";
import {
	ExtensionCatalogComponent,
	officialExtensionChoice,
} from "../src/modes/interactive/components/extension-catalog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const entry = OFFICIAL_EXTENSIONS[0];
const state = inspectOfficialExtension(entry, [], []);
const choice = officialExtensionChoice(entry, state);
const previousKeys = getKeybindings();

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(() => setKeybindings(previousKeys));

describe("extension catalog picker", () => {
	it("browses pinned metadata offline without invoking any operation", () => {
		const select = vi.fn();
		const picker = new ExtensionCatalogComponent({
			title: "Official extensions",
			choices: [choice],
			onSelect: select,
			onCancel: vi.fn(),
		});
		const text = stripAnsi(picker.render(90).join("\n"));
		expect(text).toContain("Planner");
		expect(text).toContain("not installed");
		expect(choice.details).toContain(`Repository: ${entry.repository}`);
		expect(text).toContain("https://github.com/greppleai/grip/tree/");
		expect(choice.details).toContain(`Approved target: ${entry.target?.source}`);
		expect(select).not.toHaveBeenCalled();
	});

	it("shows missing configuration separately from a loaded owner and displays all conflicts", () => {
		const duplicate = inspectOfficialExtension(
			entry,
			[
				{ source: "npm:@greppleai/planner@1.0.0", scope: "user", filtered: true },
				{ source: "git:github.com/greppleai/planner", scope: "project", filtered: false },
			],
			[{ path: "<factory>", source: "local", scope: "temporary", commands: ["planner"], tools: [] }],
		);
		const view = officialExtensionChoice(entry, duplicate);
		expect(view.label).toContain("conflict");
		const details = view.details.join("\n");
		expect(details).toContain("user: npm:");
		expect(details).toContain("project: git:");
		expect(details).toContain("Files: missing");
		expect(details).toContain("local version: unverified");
		expect(details).toContain("Loaded: <factory>");
		expect(details).toContain("Resource filters");
		const missing = officialExtensionChoice(
			entry,
			inspectOfficialExtension(entry, [{ source: "npm:@greppleai/planner", scope: "user", filtered: false }], []),
		);
		expect(missing.label).toContain("configured / missing");
	});

	it("uses overridden navigation, confirm and cancel bindings, without hardcoded arrow/Enter fallback", () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.up": "ctrl+p",
				"tui.select.down": "ctrl+n",
				"tui.select.confirm": "ctrl+y",
				"tui.select.cancel": "ctrl+x",
			}),
		);
		const select = vi.fn();
		const cancel = vi.fn();
		const picker = new ExtensionCatalogComponent({
			title: "Confirm installation",
			choices: [
				{ value: "cancel", label: "Cancel", description: "", details: ["No changes"] },
				{ value: "install", label: "Install", description: "", details: ["Lifecycle scripts may execute"] },
			],
			onSelect: select,
			onCancel: cancel,
		});
		picker.handleInput("\r");
		picker.handleInput("\x1b[B");
		expect(select).not.toHaveBeenCalled();
		picker.handleInput("\x19");
		expect(select).toHaveBeenLastCalledWith("cancel");
		picker.handleInput("\x0e");
		expect(stripAnsi(picker.render(80).join("\n"))).toContain("Lifecycle scripts");
		picker.handleInput("\x19");
		expect(select).toHaveBeenLastCalledWith("install");
		picker.handleInput("\x10");
		picker.handleInput("\x19");
		expect(select).toHaveBeenLastCalledWith("cancel");
		picker.handleInput("\x18");
		expect(cancel).toHaveBeenCalledOnce();
		expect(stripAnsi(picker.render(80).join("\n"))).toContain("ctrl+n down");
		setKeybindings(new KeybindingsManager({ "tui.select.down": "ctrl+d" }));
		picker.invalidate();
		expect(stripAnsi(picker.render(80).join("\n"))).toContain("ctrl+d down");
	});

	it.each([1, 2, 12, 32, 80])("renders safely within %i columns", (width) => {
		const picker = new ExtensionCatalogComponent({
			title: "Official extensions",
			choices: [choice],
			onSelect: vi.fn(),
			onCancel: vi.fn(),
		});
		expect(picker.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("does not interpret control sequences from local package metadata", () => {
		const picker = new ExtensionCatalogComponent({
			title: "Official extensions",
			choices: [
				{
					value: "test",
					label: "Unsafe\x1b]52;clipboard\x07",
					description: "",
					details: ["version: \x1b]0;title\x07"],
				},
			],
			onSelect: vi.fn(),
			onCancel: vi.fn(),
		});
		const output = picker.render(80).join("\n");
		expect(output).not.toContain("\x1b]");
		expect(output).not.toContain("\x07");
	});

	it("supports an empty catalog and mutation-free back", () => {
		const cancel = vi.fn();
		const select = vi.fn();
		const picker = new ExtensionCatalogComponent({
			title: "Official extensions",
			choices: [],
			onSelect: select,
			onCancel: cancel,
		});
		picker.handleInput("\r");
		expect(select).not.toHaveBeenCalled();
		picker.handleInput("\x1b");
		expect(cancel).toHaveBeenCalledOnce();
		expect(stripAnsi(picker.render(80).join("\n"))).toContain("No official extensions available");
	});
});
