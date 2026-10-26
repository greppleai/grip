import { describe, expect, it, vi } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.ts";
import { getDefaultActiveToolNames } from "../src/core/agent-session.ts";
import {
	REMOTE_WORKSPACE_CAPABILITIES,
	REMOTE_WORKSPACE_METHODS,
} from "../src/core/remote-workspace-protocol/contract.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("removed language-server integration", () => {
	it("does not expose LSP tools, settings, CLI flags, or protocol capabilities", () => {
		expect(getDefaultActiveToolNames()).not.toEqual(expect.arrayContaining(["lsp_hover", "lsp_diagnostics"]));
		expect(REMOTE_WORKSPACE_METHODS).not.toContain("lsp.status");
		expect(REMOTE_WORKSPACE_CAPABILITIES).not.toContain("lsp_status");
		expect(SettingsManager.inMemory().getGlobalSettings()).not.toHaveProperty("enableLspTools");

		const parsed = parseArgs(["--lsp-config", "old.json", "--no-lsp", "--enable-lsp-tools"]);
		expect(parsed.unknownFlags).toEqual(
			new Map<string, boolean | string>([
				["lsp-config", "old.json"],
				["no-lsp", true],
				["enable-lsp-tools", true],
			]),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp();
			const help = String(log.mock.calls[0]?.[0]);
			expect(help).not.toContain("lsp_");
			expect(help).not.toContain("--lsp-config");
		} finally {
			log.mockRestore();
		}
	});
});
