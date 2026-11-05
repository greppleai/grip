import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { TuiPerformanceRecorder } from "../src/performance.ts";

const recorders: TuiPerformanceRecorder[] = [];
afterEach(() => {
	for (const recorder of recorders.splice(0)) recorder.stop();
	mock.restoreAll();
	mock.timers.reset();
});

function createRecorder(capacity = 20): TuiPerformanceRecorder {
	const recorder = new TuiPerformanceRecorder(capacity);
	recorders.push(recorder);
	return recorder;
}

describe("TuiPerformanceRecorder", () => {
	it("is inert when disabled and validates its capacity", () => {
		const recorder = createRecorder();
		assert.equal(recorder.enabled, false);
		assert.equal(recorder.begin(), undefined);
		recorder.count("session.size", { entries: 10 });
		recorder.end("render.frame", undefined);
		assert.equal(recorder.snapshot().retainedEvents, 0);
		assert.equal(recorder.snapshot().metadata.captureDurationMs, 0);
		assert.throws(() => new TuiPerformanceRecorder(0), RangeError);
		assert.throws(() => new TuiPerformanceRecorder(100_001), RangeError);
	});

	it("bounds storage and retains newest events with overwrite accounting", () => {
		const recorder = createRecorder(2);
		recorder.start(); // initial memory sample
		recorder.count("session.size", { entries: 1 });
		recorder.count("session.size", { entries: 2 });
		recorder.count("session.size", { entries: 3 });
		const snapshot = recorder.snapshot();
		const events = snapshot.traceEvents.filter((event) => event.ph === "C");
		assert.deepEqual(
			events.map((event) => event.args),
			[{ entries: 2 }, { entries: 3 }],
		);
		assert.equal(snapshot.retainedEvents, 2);
		assert.equal(snapshot.droppedEvents, 2);
	});

	it("drains independent batches without invalidating in-flight spans or resetting the capture clock", () => {
		let clock = 100;
		mock.method(performance, "now", () => clock);
		const recorder = createRecorder(2);
		recorder.start();
		const span = recorder.begin();
		for (let i = 0; i < 3; i++) recorder.count("session.size", { entries: i });
		const first = recorder.drain();
		assert.equal(first.retainedEvents, 2);
		assert.equal(first.droppedEvents, 2);
		assert.equal(recorder.drain().retainedEvents, 0);
		clock += 10;
		recorder.end("render.frame", span);
		const second = recorder.drain();
		assert.equal(second.droppedEvents, 0);
		assert.equal(second.summary["render.frame"]?.totalMs, 10);
		assert.equal(second.traceEvents.find((event) => event.name === "render.frame")?.ts, 0);
		assert.equal(recorder.enabled, true);
	});

	it("rejects stale spans even when restart occurs at the same clock timestamp", () => {
		mock.method(performance, "now", () => 100);
		const recorder = createRecorder();
		recorder.start();
		const old = recorder.begin();
		recorder.stop();
		recorder.end("render.frame", old);
		recorder.start();
		recorder.end("render.frame", old);
		recorder.end("render.frame", recorder.begin());
		assert.equal(recorder.snapshot().summary["render.frame"]?.count, 1);
		recorder.stop();
		const size = recorder.snapshot().retainedEvents;
		recorder.count("session.size", { entries: 1 });
		assert.equal(recorder.snapshot().retainedEvents, size);
	});

	it("exports microseconds, retained-window percentiles, and immutable numeric-only data", () => {
		let clock = 100;
		mock.method(performance, "now", () => clock);
		const recorder = createRecorder();
		recorder.start();
		for (const duration of [1, 10, 30]) {
			const started = recorder.begin();
			clock += duration;
			recorder.end("render.frame", started, { lines: 10, bytes: Number.NaN, ...{ secret: "PRIVATE" } });
		}
		const snapshot = recorder.snapshot();
		assert.deepEqual(snapshot.summary["render.frame"], { count: 3, totalMs: 41, maxMs: 30, p50Ms: 10, p95Ms: 30 });
		const event = snapshot.traceEvents.find((entry) => entry.name === "render.frame")!;
		assert.equal(event.ts, 0);
		assert.equal(event.dur, 1000);
		assert.deepEqual(event.args, { lines: 10 });
		(event.args as { lines: number }).lines = 999;
		assert.deepEqual(recorder.snapshot().traceEvents.find((entry) => entry.name === "render.frame")!.args, {
			lines: 10,
		});
		assert.ok(!JSON.stringify(recorder.snapshot()).includes("PRIVATE"));
		recorder.end("component.render", recorder.begin(), {}, 1);
		assert.equal(recorder.snapshot().summary["component.render"], undefined);
	});

	it("samples monotonic event-loop lag and memory and stops sampling", () => {
		let clock = 100;
		mock.method(performance, "now", () => clock);
		mock.timers.enable({ apis: ["setInterval"] });
		const recorder = createRecorder(50);
		recorder.start();
		clock = 1200;
		mock.timers.tick(1100);
		const snapshot = recorder.snapshot();
		assert.equal(snapshot.summary["event_loop.lag"]?.maxMs, 1000);
		assert.equal(snapshot.traceEvents.filter((event) => event.name === "process.memory").length, 2);
		recorder.stop();
		clock = 5000;
		mock.timers.tick(5000);
		assert.equal(recorder.snapshot().retainedEvents, snapshot.retainedEvents);
		assert.equal(recorder.snapshot().metadata.captureDurationMs, 1100);
	});
});
