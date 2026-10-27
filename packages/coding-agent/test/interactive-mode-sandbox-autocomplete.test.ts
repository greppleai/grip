import type { AutocompleteItem, AutocompleteProvider } from "@greppleai/grip-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface SandboxNameFixture {
	name: string;
	status: string;
}

function createProvider(
	list: () => Promise<SandboxNameFixture[]>,
	sandboxCompletions?: (prefix: string) => Promise<AutocompleteItem[]>,
) {
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: {
			session: {
				session: { getCwd: () => process.cwd() },
				supportsDirectoryChange: () => !sandboxCompletions,
				getSandboxDirectoryCompletions: sandboxCompletions,
				settingsManager: { getEnableSkillCommands: () => false },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
			},
		},
		activeSandboxBackendConnected: Boolean(sandboxCompletions),
		skillCommands: new Map(),
		fdPath: null,
		createLimaSandboxService: () => ({ list }),
	});
	return (
		mode as unknown as { createBaseAutocompleteProvider(): AutocompleteProvider }
	).createBaseAutocompleteProvider();
}

async function suggestionsFor(provider: AutocompleteProvider, text: string) {
	return provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: true });
}
async function automaticSuggestions(provider: AutocompleteProvider, text: string) {
	return provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: false });
}

describe("/sandbox start --name autocomplete", () => {
	it("lists Lima sandboxes from all workspaces and replaces only the argument", async () => {
		const list = vi.fn().mockResolvedValue([
			{ name: "grip-one", status: "Running" },
			{ name: "grip-two", status: "Stopped" },
			{ name: "other", status: "Running" },
		]);
		const provider = createProvider(list);
		const text = "/sandbox start --name grip-";
		const suggestions = await suggestionsFor(provider, text);
		expect(list).toHaveBeenCalledWith({ workspaceRoot: process.cwd(), allWorkspaces: true });
		expect(suggestions).toEqual({
			prefix: "start --name grip-",
			items: [
				{ value: "start --name grip-one", label: "grip-one", description: "Running" },
				{ value: "start --name grip-two", label: "grip-two", description: "Stopped" },
			],
		});
		const selected = suggestions?.items[0];
		expect(selected).toBeDefined();
		if (selected && suggestions) {
			expect(provider.applyCompletion([text], 0, text.length, selected, suggestions.prefix).lines).toEqual([
				"/sandbox start --name grip-one",
			]);
		}
	});

	it("suggests names before or after the space following --name", async () => {
		const list = vi.fn().mockResolvedValue([{ name: "grip-dev", status: "Running" }]);
		const provider = createProvider(list);
		for (const text of ["/sandbox start --name", "/sandbox start --name "]) {
			const suggestions = await suggestionsFor(provider, text);
			expect(suggestions?.items[0]?.label).toBe("grip-dev");
			expect((await automaticSuggestions(provider, text))?.items[0]?.label).toBe("grip-dev");
			if (suggestions) {
				expect(
					provider.applyCompletion([text], 0, text.length, suggestions.items[0]!, suggestions.prefix).lines,
				).toEqual(["/sandbox start --name grip-dev"]);
			}
		}
	});

	it("does not suggest directories when Lima has no matches or fails", async () => {
		const list = vi.fn().mockResolvedValue([]);
		const provider = createProvider(list);
		expect(await suggestionsFor(provider, "/sandbox start --name ")).toBeNull();
		list.mockRejectedValue(new Error("Lima unavailable"));
		expect(await suggestionsFor(provider, "/sandbox start --name ")).toBeNull();
		// Other completion contexts still use the existing provider.
		expect(await suggestionsFor(provider, "ordinary prompt ")).not.toBeNull();
	});
});

describe("/profile sandbox autocomplete", () => {
	it("suggests VM names with status for --name in either option order", async () => {
		const list = vi.fn().mockResolvedValue([
			{ name: "grip-one", status: "Running" },
			{ name: "grip-two", status: "Stopped" },
			{ name: "not-matching", status: "Running" },
		]);
		const provider = createProvider(list);
		for (const text of [
			"/profile sandbox work --name grip-",
			"/profile sandbox work --autoconnect off --name grip-",
		]) {
			const suggestions = await automaticSuggestions(provider, text);
			expect(list).toHaveBeenCalledWith({ workspaceRoot: process.cwd(), allWorkspaces: true });
			expect(suggestions?.prefix).toBe(text.slice("/profile ".length));
			expect(suggestions?.items).toEqual([
				{
					value: `${text.slice("/profile ".length, -"grip-".length)}grip-one`,
					label: "grip-one",
					description: "Running",
				},
				{
					value: `${text.slice("/profile ".length, -"grip-".length)}grip-two`,
					label: "grip-two",
					description: "Stopped",
				},
			]);
			if (suggestions) {
				expect(
					provider.applyCompletion([text], 0, text.length, suggestions.items[0]!, suggestions.prefix).lines,
				).toEqual([text.replace(/grip-$/, "grip-one")]);
			}
		}
	});

	it("offers --autoconnect and --name arguments without suggesting files for missing VMs", async () => {
		const list = vi.fn().mockResolvedValue([{ name: "grip-dev", status: "Running" }]);
		const provider = createProvider(list);
		for (const text of ["/profile sandbox work --name", "/profile sandbox work --name "]) {
			const suggestions = await automaticSuggestions(provider, text);
			expect(suggestions?.items[0]?.label).toBe("grip-dev");
			if (suggestions) {
				expect(
					provider.applyCompletion([text], 0, text.length, suggestions.items[0]!, suggestions.prefix).lines,
				).toEqual(["/profile sandbox work --name grip-dev"]);
			}
		}
		expect(
			(await automaticSuggestions(provider, "/profile sandbox work --name grip-dev "))?.items.map(
				(item) => item.label,
			),
		).toEqual(["--autoconnect on", "--autoconnect off"]);
		expect(
			(await automaticSuggestions(provider, "/profile sandbox work --autoconnect "))?.items.map(
				(item) => item.label,
			),
		).toEqual(["on", "off"]);
		expect(
			(await automaticSuggestions(provider, "/profile sandbox work --autoconnect off "))?.items.map(
				(item) => item.label,
			),
		).toEqual(["--name "]);
		list.mockResolvedValueOnce([]);
		expect(await suggestionsFor(provider, "/profile sandbox work --name ")).toBeNull();
		list.mockRejectedValueOnce(new Error("Lima unavailable"));
		expect(await suggestionsFor(provider, "/profile sandbox work --name ")).toBeNull();
	});
});

describe("built-in slash command argument choices", () => {
	it("keeps no-argument commands selectable after a space", async () => {
		const provider = createProvider(async () => []);
		const text = "/quit ";
		const suggestions = await automaticSuggestions(provider, text);
		expect(suggestions?.items).toEqual([expect.objectContaining({ value: "quit", label: "/quit" })]);
		expect(
			provider.applyCompletion([text], 0, text.length, suggestions!.items[0]!, suggestions!.prefix).lines,
		).toEqual(["/quit"]);
	});

	it("keeps /new selectable after a space without suggesting arguments", async () => {
		const provider = createProvider(async () => []);
		const text = "/new ";
		const suggestions = await automaticSuggestions(provider, text);
		expect(suggestions?.items).toEqual([expect.objectContaining({ value: "new", label: "/new" })]);
		expect(
			provider.applyCompletion([text], 0, text.length, suggestions!.items[0]!, suggestions!.prefix).lines,
		).toEqual(["/new"]);
		expect(await automaticSuggestions(provider, "/new --")).toBeNull();
	});

	it("offers supported actions and nested sandbox options while typing", async () => {
		const provider = createProvider(async () => []);
		for (const [text, expected] of [
			["/hooks ", ["enable", "disable"]],
			["/context-compression o", ["on", "off"]],
			["/compress-detection ", ["on", "off"]],
			["/sandbox ", ["status", "clear", "--attach", "start", "list", "stop"]],
			["/sandbox start ", ["--name", "--template", "--update"]],
			["/sandbox start --", ["--name", "--template", "--update"]],
		] as const) {
			const suggestions = await automaticSuggestions(provider, text);
			expect(suggestions?.items.map((item) => item.label)).toEqual(expected);
		}
		const options = await automaticSuggestions(provider, "/sandbox start --");
		expect(
			provider.applyCompletion(
				["/sandbox start --"],
				0,
				"/sandbox start --".length,
				options!.items[0]!,
				options!.prefix,
			).lines,
		).toEqual(["/sandbox start --name "]);
	});
});

describe("/cd sandbox autocomplete", () => {
	it("uses guest completions and never falls back to host directories", async () => {
		const guest = vi.fn(async (prefix: string) =>
			prefix === "pl" ? [{ value: "planner/", label: "planner/" }] : [],
		);
		const provider = createProvider(async () => [], guest);
		const suggestions = await automaticSuggestions(provider, "/cd pl");
		expect(guest).toHaveBeenCalledWith("pl");
		expect(suggestions?.items).toEqual([{ value: "planner/", label: "planner/" }]);
		expect(await automaticSuggestions(provider, "/cd missing")).toBeNull();
	});
});
