import { expect, it } from "vitest";
import { DaemonOutboundBudget } from "../src/daemon/outbound-budget.ts";

it("bounds aggregate pending callbacks across channels even when ws bufferedAmount is zero", () => {
	const budget = new DaemonOutboundBudget(100, 2);
	const first = budget.reserve(40, 0);
	const second = budget.reserve(40, 0);
	expect(() => budget.reserve(1, 0)).toThrow("exceeds daemon limits");
	first();
	expect(() => budget.reserve(61, 0)).toThrow("exceeds daemon limits");
	const third = budget.reserve(60, 0);
	second();
	third();
	// Callback cleanup must be safe if the transport tries to settle twice.
	third();
	const last = budget.reserve(100, 0);
	last();
});

it("respects socket-queued bytes after callbacks have drained", () => {
	const budget = new DaemonOutboundBudget(100, 2);
	expect(() => budget.reserve(41, 60)).toThrow("exceeds daemon limits");
	const done = budget.reserve(40, 60);
	done();
});
