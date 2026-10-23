import { setKeybindings, type TUI } from "@greppleai/grip-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("extension approval selector", () => {
	it("highlights only the heading and leaves approval details in the readable text color", () => {
		const heading = "Run on host (no shell)?";
		const reason = 'Reason: "Run host git pull using host credentials?"';
		const args = 'Arguments: ["-c","core.hooksPath=/dev/null","pull","--rebase","origin","main"]';
		const selector = new ExtensionSelectorComponent(
			`${heading}\n\n${reason}\nExplanation (unverified):\n  "Rebase local commits"\n\n${args}\nHost cwd: "/home/user/grip"`,
			["No", "Yes"],
			() => {},
			() => {},
		);
		const lines = selector.render(120);
		expect(lines.find((line) => line.includes(heading))).toContain(theme.fg("accent", theme.bold(heading)));
		expect(lines.find((line) => line.includes(reason))).toContain(theme.fg("text", reason));
		expect(lines.find((line) => line.includes("Explanation (unverified):"))).toContain(
			theme.fg("text", "Explanation (unverified):"),
		);
		expect(lines.find((line) => line.includes("Host cwd:"))).toContain(
			theme.fg("text", 'Host cwd: "/home/user/grip"'),
		);
		expect(stripAnsi(lines.join("\n"))).toContain(args);
		selector.dispose();
	});

	it("recolors approval details after a theme change", () => {
		const detail = 'Host cwd: "/home/user/grip"';
		const selector = new ExtensionSelectorComponent(
			`Approve?\n${detail}`,
			["No", "Yes"],
			() => {},
			() => {},
		);
		const before = selector.render(80).find((line) => line.includes(detail));
		try {
			initTheme("light");
			selector.invalidate();
			const after = selector.render(80).find((line) => line.includes(detail));
			expect(after).toContain(theme.fg("text", detail));
			expect(after).not.toBe(before);
		} finally {
			selector.dispose();
			initTheme("dark");
		}
	});

	it("keeps a countdown on the heading rather than the last approval detail", () => {
		vi.useFakeTimers();
		const selector = new ExtensionSelectorComponent(
			'Approve?\nHost cwd: "/home/user/grip"',
			["No", "Yes"],
			() => {},
			() => {},
			{ tui: { requestRender: vi.fn() } as unknown as TUI, timeout: 2000 },
		);
		try {
			const firstRender = stripAnsi(selector.render(80).join("\n"));
			expect(firstRender).toContain("Approve? (2s)");
			expect(firstRender).toContain('Host cwd: "/home/user/grip"');
			expect(firstRender).not.toContain('Host cwd: "/home/user/grip" (2s)');
			vi.advanceTimersByTime(1000);
			const nextRender = stripAnsi(selector.render(80).join("\n"));
			expect(nextRender).toContain("Approve? (1s)");
			expect(nextRender).not.toContain('Host cwd: "/home/user/grip" (1s)');
		} finally {
			selector.dispose();
			vi.useRealTimers();
		}
	});
});
