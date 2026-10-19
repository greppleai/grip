/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   grip -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@greppleai/grip";
import { createBashTool, LocalToolOperations } from "@greppleai/grip";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(new LocalToolOperations(cwd), {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, GRIP_SPAWN_HOOK: "1" },
		}),
	});

	pi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
