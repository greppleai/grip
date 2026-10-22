import type { AutocompleteProvider } from "@greppleai/grip-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface SandboxNameFixture {
	name: string;
	status: string;
}

function createProvider(list: () => Promise<SandboxNameFixture[]>) {
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: {
			session: {
				session: { getCwd: () => process.cwd() },
				settingsManager: { getEnableSkillCommands: () => false },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
			},
		},
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
