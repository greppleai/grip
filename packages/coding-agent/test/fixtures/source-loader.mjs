import { registerHooks } from "node:module";

// Child processes must resolve workspace packages to current source, as the Vitest config does.
const aliases = new Map([
	["@greppleai/grip-ai", new URL("../../../ai/src/index.ts", import.meta.url).href],
	["@greppleai/grip-ai/oauth", new URL("../../../ai/src/oauth.ts", import.meta.url).href],
	["@greppleai/grip-agent-core", new URL("../../../agent/src/index.ts", import.meta.url).href],
	["@greppleai/grip-tui", new URL("../../../tui/src/index.ts", import.meta.url).href],
]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = aliases.get(specifier);
		if (url) return { url, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
