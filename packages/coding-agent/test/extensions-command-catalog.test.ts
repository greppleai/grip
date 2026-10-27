import type { AutocompleteProvider } from "@greppleai/grip-tui";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ResolvedCommand } from "../src/core/extensions/types.ts";
import type { ResourceDiagnostic } from "../src/core/resource-loader.ts";
import { BUILTIN_SLASH_COMMANDS, HIDDEN_BUILTIN_SLASH_COMMAND_NAMES } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface CommandCatalogHost {
	createBaseAutocompleteProvider(): AutocompleteProvider;
	getBuiltInCommandConflictDiagnostics(runner: Pick<ExtensionRunner, "getRegisteredCommands">): ResourceDiagnostic[];
}

function createHost(commands: ResolvedCommand[]) {
	const runner = { getRegisteredCommands: () => commands };
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as InteractiveMode, {
		runtimeHost: {
			session: {
				session: { getCwd: () => process.cwd() },
				settingsManager: { getEnableSkillCommands: () => false },
				promptTemplates: [],
				extensionRunner: runner,
			},
		},
		skillCommands: new Map<string, string>(),
		fdPath: null,
	});
	return { host: mode as unknown as CommandCatalogHost, runner };
}

async function suggestions(provider: AutocompleteProvider, text: string) {
	return provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force: false });
}

describe("/extensions built-in catalog", () => {
	it("registers one visible management command", () => {
		expect(BUILTIN_SLASH_COMMANDS.filter((command) => command.name === "extensions")).toEqual([
			{
				name: "extensions",
				description: "Browse installed extensions and install or uninstall official extensions",
			},
		]);
		expect(HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has("extensions")).toBe(false);
	});

	it("completes without extension factories or a catalog request", async () => {
		const { host } = createHost([]);
		const provider = host.createBaseAutocompleteProvider();
		const text = "/ext";
		const result = await suggestions(provider, text);
		const item = result?.items.find((candidate) => candidate.value === "extensions");
		expect(item).toEqual(expect.objectContaining({ value: "extensions" }));
		expect(provider.applyCompletion([text], 0, text.length, item!, result!.prefix).lines).toEqual(["/extensions "]);
		const trailing = await suggestions(provider, "/extensions ");
		expect(trailing?.items).toContainEqual(expect.objectContaining({ value: "extensions", label: "/extensions" }));
	});

	it("reserves the built-in name using the existing collision diagnostics and autocomplete filter", async () => {
		const handler = vi.fn(async () => {});
		const command: ResolvedCommand = {
			name: "extensions",
			invocationName: "extensions",
			description: "Conflicting extension command",
			sourceInfo: { path: "/fixture/extension.ts", source: "local", scope: "user", origin: "top-level" },
			handler,
		};
		const { host, runner } = createHost([command]);
		expect(host.getBuiltInCommandConflictDiagnostics(runner)).toEqual([
			{
				type: "warning",
				message:
					"Extension command '/extensions' conflicts with built-in interactive command. Skipping in autocomplete.",
				path: "/fixture/extension.ts",
			},
		]);
		const result = await suggestions(host.createBaseAutocompleteProvider(), "/extensions");
		expect(result?.items.filter((item) => item.value === "extensions")).toEqual([
			expect.objectContaining({
				value: "extensions",
				description: "Browse installed extensions and install or uninstall official extensions",
			}),
		]);
		expect(handler).not.toHaveBeenCalled();
	});
});
