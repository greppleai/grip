import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
});

afterEach(() => {
	process.env = { ...originalEnv };
	mock.restoreAll();
});

describe("mouse selection clipboard", () => {
	it("uses tmux's clipboard command with selected Unicode text on stdin", async () => {
		process.env.TMUX = "/tmp/tmux-test/default,123,0";
		const copy = mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
		const terminal = new VirtualTerminal(40, 4);
		const writes = mock.method(terminal, "write");
		const tui = new TuiAltScreen(terminal);
		const flash = mock.method(tui, "flash");
		tui.addChild(new Text("alpha\nbeta 界 $(not-a-command)", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;40;2M");
			terminal.sendInput("\x1b[<0;40;2m");

			assert.equal(copy.mock.callCount(), 1);
			assert.deepEqual(copy.mock.calls[0]?.arguments, [
				"tmux",
				["load-buffer", "-w", "-"],
				{
					input: "alpha\nbeta 界 $(not-a-command)",
					stdio: ["pipe", "ignore", "ignore"],
					timeout: 5000,
				},
			]);
			assert.equal(
				writes.mock.calls.some((call) => call.arguments[0].includes("\x1b]52;")),
				false,
			);
			assert.deepEqual(
				flash.mock.calls.map((call) => call.arguments[0]),
				["Copied!"],
			);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("does not show Copied or emit ignored OSC 52 when tmux fails", async () => {
		process.env.TMUX = "/tmp/tmux-test/default,123,0";
		mock.method(childProcess, "execFileSync", () => {
			throw new Error("tmux unavailable");
		});
		const terminal = new VirtualTerminal(20, 4);
		const writes = mock.method(terminal, "write");
		const tui = new TuiAltScreen(terminal);
		const flash = mock.method(tui, "flash");
		tui.addChild(new Text("alpha", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			assert.doesNotThrow(() => terminal.sendInput("\x1b[<0;5;1m"));
			assert.deepEqual(
				flash.mock.calls.map((call) => call.arguments[0]),
				["Failed to copy to clipboard"],
			);
			assert.equal(
				writes.mock.calls.some((call) => call.arguments[0].includes("\x1b]52;")),
				false,
			);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("keeps OSC 52 copying outside tmux", async () => {
		const copy = mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
		const terminal = new VirtualTerminal(20, 4);
		const writes = mock.method(terminal, "write");
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<0;5;1m");
			assert.equal(copy.mock.callCount(), 0);
			assert.ok(writes.mock.calls.some((call) => call.arguments[0] === "\x1b]52;c;YWxwaGE=\x07"));
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("does not invoke tmux or confirm a copy for a click without a selection", async () => {
		process.env.TMUX = "/tmp/tmux-test/default,123,0";
		const copy = mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const flash = mock.method(tui, "flash");
		tui.addChild(new Text("alpha", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<0;1;1m");
			assert.equal(copy.mock.callCount(), 0);
			assert.equal(flash.mock.callCount(), 0);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});
});
