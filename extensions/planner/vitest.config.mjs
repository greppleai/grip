import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	root: source("../../"),
	test: {
		include: ["extensions/planner/extensions/*.test.ts"],
		environment: "node",
		env: { GRIP_EMBEDDED_ASSET_DIR: "" },
		testTimeout: 30000,
	},
	resolve: {
		alias: [
			{ find: /^@greppleai\/grip$/, replacement: source("../../packages/coding-agent/src/index.ts") },
			{ find: /^@greppleai\/grip-ai$/, replacement: source("../../packages/ai/src/index.ts") },
			{ find: /^@greppleai\/grip-ai\/oauth$/, replacement: source("../../packages/ai/src/oauth.ts") },
			{ find: /^@greppleai\/grip-agent-core$/, replacement: source("../../packages/agent/src/index.ts") },
			{ find: /^@greppleai\/grip-tui$/, replacement: source("../../packages/tui/src/index.ts") },
		],
	},
});
