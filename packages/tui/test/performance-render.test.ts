import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { tuiPerformance } from "../src/performance.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	tuiPerformance.stop();
	resetCapabilitiesCache();
});

for (const mode of ["regular", "fullscreen"] as const) {
	describe(`performance instrumentation (${mode})`, () => {
		it("measures coalesced input through frame/write completion without retaining text", async () => {
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			const terminal = new VirtualTerminal(80, 24);
			const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			const secret = "PRIVATE-KEYSTROKE";
			const editor: Component = {
				render: () => [`editor${CURSOR_MARKER}`],
				handleInput: () => {},
				invalidate: () => {},
			};
			tui.addChild(new Text("PRIVATE-TRANSCRIPT", 0, 0));
			tui.addChild(editor);
			tui.setFocus(editor);
			tui.start();
			try {
				await terminal.waitForRender();
				tuiPerformance.start();
				terminal.sendInput(secret);
				terminal.sendInput("second-input");
				await terminal.waitForRender();
				tuiPerformance.stop();
				const capture = tuiPerformance.snapshot();
				assert.equal(capture.summary["input.dispatch"]?.count, 2);
				assert.equal(capture.summary["input.to_render"]?.count, 1);
				assert.equal(capture.summary["render.frame"]?.count, 1);
				assert.ok(capture.summary["render.prepare"]);
				assert.ok(capture.summary["render.diff"]);
				assert.ok(capture.summary["terminal.write"]);
				if (mode === "fullscreen") assert.ok(capture.summary["render.layout"]);
				const latency = capture.traceEvents.find((event) => event.name === "input.to_render")!;
				assert.deepEqual(latency.args, { inputs: 2 });
				const serialized = JSON.stringify(capture);
				assert.ok(!serialized.includes(secret));
				assert.ok(!serialized.includes("PRIVATE-TRANSCRIPT"));
			} finally {
				tui.stop();
			}
		});

		it("records failed frames and closes timing spans when a component throws", async () => {
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			const terminal = new VirtualTerminal(80, 24);
			const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			tui.start();
			try {
				await terminal.waitForRender();
				tui.addChild({
					render: () => {
						throw new Error("component failure");
					},
					invalidate: () => {},
				});
				tuiPerformance.start();
				assert.throws(() => tui.renderNow(), /component failure/);
				tuiPerformance.stop();
				const frame = tuiPerformance.snapshot().traceEvents.find((event) => event.name === "render.frame")!;
				assert.equal((frame.args as { failed: number }).failed, 1);
			} finally {
				tui.clear();
				tui.stop();
			}
		});
	});
}
