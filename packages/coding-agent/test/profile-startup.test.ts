import { registerFauxProvider } from "@greppleai/grip-ai";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main.ts";

describe("profile startup model selection", () => {
	it("uses the directory profile's model and thinking level when continuing a session", () => {
		const faux = registerFauxProvider();
		try {
			const previous = faux.getModel();
			const work = { ...previous, id: `${previous.id}-work` };
			const registry = {
				find: (provider: string, id: string) =>
					[previous, work].find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: () => true,
				getAvailable: () => [previous, work],
				getAll: () => [previous, work],
			} as unknown as ModelRegistry;
			const settings = SettingsManager.inMemory(
				{
					profiles: {
						work: {
							defaultProvider: work.provider,
							defaultModel: work.id,
							defaultThinkingLevel: "high",
							enabledModels: [`${work.provider}/${work.id}`],
						},
					},
					profileDirectories: { "/home/user/work": "work" },
				},
				"/home/user/work/project",
			);
			const scoped: ScopedModel[] = [{ model: work }];
			const resumed = buildSessionOptions(parseArgs([]), scoped, true, registry, settings);
			expect(resumed.options.model).toEqual(work);
			expect(resumed.options.thinkingLevel).toBe("high");
			expect(resumed.options.scopedModels).toEqual(scoped);

			const unscoped = buildSessionOptions(parseArgs([]), [], true, registry, settings);
			expect(unscoped.options.model).toEqual(work);
			expect(unscoped.options.thinkingLevel).toBe("high");
			expect(settings.getJobModel()).toBeUndefined();

			const explicit = buildSessionOptions(
				parseArgs(["--model", `${previous.provider}/${previous.id}`]),
				scoped,
				true,
				registry,
				settings,
			);
			expect(explicit.options.model).toEqual(previous);
		} finally {
			faux.unregister();
		}
	});

	it("keeps the saved session model when no profile is active", () => {
		const faux = registerFauxProvider();
		try {
			const model = faux.getModel();
			const registry = { getAvailable: () => [model] } as unknown as ModelRegistry;
			const resolution = buildSessionOptions(parseArgs([]), [{ model }], true, registry, SettingsManager.inMemory());
			expect(resolution.options.model).toBeUndefined();
		} finally {
			faux.unregister();
		}
	});
});
