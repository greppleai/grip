import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/core/session/session.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import type {
	PerformanceDiagnostics,
	PerformanceDiagnosticsContext,
} from "../src/modes/interactive/performance-diagnostics.ts";

interface DiagnosticsRenderer {
	mode: string;
}
interface DiagnosticsUiContext {
	settingsManager: Pick<SettingsManager, "getPerformanceDiagnostics">;
	activeSession: Pick<Session, "getCwd" | "getSessionId">;
	renderer: DiagnosticsRenderer;
	performanceDiagnostics: Pick<PerformanceDiagnostics, "configure">;
}
interface DiagnosticsMethods {
	updatePerformanceDiagnostics(this: DiagnosticsUiContext): Promise<void>;
}
const methods = InteractiveMode.prototype as unknown as DiagnosticsMethods;

describe("interactive performance diagnostics binding", () => {
	it("uses the active session's working directory and ID, with live renderer mode", async () => {
		const configure = vi.fn<(context: PerformanceDiagnosticsContext | null) => Promise<void>>().mockResolvedValue();
		const context: DiagnosticsUiContext = {
			settingsManager: { getPerformanceDiagnostics: () => true },
			activeSession: { getCwd: () => "/active-working-directory", getSessionId: () => "active-session-id" },
			renderer: { mode: "regular" },
			performanceDiagnostics: { configure },
		};
		await methods.updatePerformanceDiagnostics.call(context);
		const binding = configure.mock.calls[0]![0]!;
		expect(binding.cwd).toBe("/active-working-directory");
		expect(binding.sessionId).toBe("active-session-id");
		expect(binding.mode()).toBe("regular");
		context.renderer.mode = "fullscreen";
		expect(binding.mode()).toBe("fullscreen");
		context.settingsManager.getPerformanceDiagnostics = () => false;
		await methods.updatePerformanceDiagnostics.call(context);
		expect(configure).toHaveBeenLastCalledWith(null);
	});
});
