#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.GRIP_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

main(process.argv.slice(2));
