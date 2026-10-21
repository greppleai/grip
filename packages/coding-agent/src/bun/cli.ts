#!/usr/bin/env node
import { prepareEmbeddedAssets } from "./embedded-assets.ts";
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

process.emitWarning = (() => {}) as typeof process.emitWarning;
restoreSandboxEnv();
await prepareEmbeddedAssets();
const { APP_NAME } = await import("../config.ts");
process.title = APP_NAME;
if (process.argv[2] !== "--daemon") {
	await import("./register-bedrock.ts");
}
await import("../cli.ts");
