import { tuiPerformance } from "@greppleai/grip-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => tuiPerformance.stop());

describe("footer performance instrumentation", () => {
	it("records phase timings and numeric session size without changing output", () => {
		initTheme("dark");
		const session = {
			state: { messages: [], model: undefined },
			session: {
				getEntries: () => [],
				getBranch: () => [],
				getCwd: () => "/PRIVATE-WORKSPACE",
				getSessionName: () => "PRIVATE-SESSION-NAME",
			},
			getContextUsage: () => undefined,
			getCompressionDetectionCounts: () => ({ keep: 0, compress: 0 }),
			getCompressionDetectionCost: () => 0,
			settingsManager: { getCompressionDetectionModel: () => undefined, getActiveProfile: () => "PRIVATE-PROFILE" },
		} as unknown as AgentSession;
		const footer = new FooterComponent(session, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		});
		const before = footer.render(100);
		tuiPerformance.start();
		const during = footer.render(100);
		tuiPerformance.stop();
		expect(during).toEqual(before);
		const capture = tuiPerformance.snapshot();
		for (const name of ["footer.render", "footer.usage", "footer.context", "footer.compression"] as const) {
			expect(capture.summary[name]?.count).toBe(1);
		}
		expect(capture.traceEvents.find((event) => event.name === "session.size")?.args).toEqual({
			entries: 0,
			messages: 0,
		});
		expect(JSON.stringify(capture)).not.toContain("PRIVATE-");
	});
});
