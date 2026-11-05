/** Fixed names and numeric-only arguments: never record input, terminal output, paths, or session content. */
export type TuiPerformanceName =
	| "input.dispatch"
	| "input.to_render"
	| "render.frame"
	| "render.prepare"
	| "render.diff"
	| "render.layout"
	| "render.normalize"
	| "terminal.write"
	| "footer.render"
	| "footer.usage"
	| "footer.context"
	| "footer.compression"
	| "component.render"
	| "event_loop.lag"
	| "process.memory"
	| "session.size";

export interface TuiPerformanceArgs {
	bytes?: number;
	columns?: number;
	rows?: number;
	lines?: number;
	children?: number;
	inputs?: number;
	redraws?: number;
	fullscreen?: number;
	entries?: number;
	messages?: number;
	ms?: number;
	rss?: number;
	heapUsed?: number;
	heapTotal?: number;
	external?: number;
	arrayBuffers?: number;
	failed?: number;
}

export interface TuiPerformanceSpan {
	readonly startedAt: number;
	readonly generation: number;
}

type TuiPerformancePhase = "X" | "C";

interface StoredEvent {
	name: TuiPerformanceName;
	phase: TuiPerformancePhase;
	ts: number;
	duration: number | null;
	args: TuiPerformanceArgs;
}

export interface TuiPerformanceMetric {
	count: number;
	totalMs: number;
	maxMs: number;
	p50Ms: number;
	p95Ms: number;
}

export interface TuiPerformanceMetadata {
	formatVersion: number;
	node: string;
	bun: string | null;
	platform: string;
	arch: string;
	captureDurationMs: number;
	recording: boolean;
	summaryScope: string;
}

export interface TuiPerformanceSnapshot {
	traceEvents: Array<Record<string, unknown>>;
	displayTimeUnit: "ms";
	summary: Partial<Record<TuiPerformanceName, TuiPerformanceMetric>>;
	droppedEvents: number;
	capacity: number;
	retainedEvents: number;
	metadata: TuiPerformanceMetadata;
}

const ARGUMENT_NAMES = new Set([
	"bytes",
	"columns",
	"rows",
	"lines",
	"children",
	"inputs",
	"redraws",
	"fullscreen",
	"entries",
	"messages",
	"ms",
	"rss",
	"heapUsed",
	"heapTotal",
	"external",
	"arrayBuffers",
	"failed",
]);

/**
 * Opt-in process-local recorder. No disk I/O or timers while disabled.
 * O(1) bounded ring retains the newest events; summaries describe only that retained window.
 * Span clocks are monotonic milliseconds; Chrome Trace timestamps/durations are microseconds.
 */
export class TuiPerformanceRecorder {
	private readonly capacity: number;
	private readonly events: Array<StoredEvent | undefined>;
	private next = 0;
	private size = 0;
	private dropped = 0;
	private enabledValue = false;
	private generation = 0;
	private captureStart = 0;
	private captureEnd = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(capacity = 20_000) {
		if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100_000) {
			throw new RangeError("capacity must be an integer between 1 and 100000");
		}
		this.capacity = capacity;
		this.events = new Array(capacity);
	}

	get enabled(): boolean {
		return this.enabledValue;
	}

	start(): void {
		this.stop();
		this.generation++;
		this.events.fill(undefined);
		this.next = 0;
		this.size = 0;
		this.dropped = 0;
		this.captureStart = performance.now();
		this.captureEnd = this.captureStart;
		this.enabledValue = true;
		let expectedTick = this.captureStart + 100;
		let lastMemorySample = this.captureStart;
		this.sampleMemory();
		this.timer = setInterval(() => {
			const now = performance.now();
			this.count("event_loop.lag", { ms: Math.max(0, now - expectedTick) });
			expectedTick = now + 100;
			if (now - lastMemorySample >= 1000) {
				this.sampleMemory();
				lastMemorySample = now;
			}
		}, 100);
		this.timer.unref();
	}

	stop(): void {
		if (this.enabledValue) this.captureEnd = performance.now();
		this.enabledValue = false;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}

	begin(): TuiPerformanceSpan | undefined {
		return this.enabledValue ? { startedAt: performance.now(), generation: this.generation } : undefined;
	}

	/** minDurationMs allows slow-component detail without retaining every tiny component span. */
	end(
		name: TuiPerformanceName,
		span: TuiPerformanceSpan | undefined,
		args: TuiPerformanceArgs = {},
		minDurationMs = 0,
	): void {
		if (!this.enabledValue || !span || span.generation !== this.generation) return;
		const duration = performance.now() - span.startedAt;
		if (!Number.isFinite(duration) || duration < minDurationMs) return;
		const safeArgs = sanitizeArgs(args);
		this.append({ name, phase: "X", ts: span.startedAt - this.captureStart, duration, args: safeArgs });
	}

	count(name: TuiPerformanceName, args: TuiPerformanceArgs): void {
		if (!this.enabledValue) return;
		this.append({
			name,
			phase: "C",
			ts: performance.now() - this.captureStart,
			duration: null,
			args: sanitizeArgs(args),
		});
	}

	snapshot(): TuiPerformanceSnapshot {
		const traceEvents: Array<Record<string, unknown>> = [
			{ name: "process_name", ph: "M", pid: 1, args: { name: "Grip TUI" } },
			{ name: "thread_name", ph: "M", pid: 1, tid: 1, args: { name: "UI thread" } },
			{ name: "thread_name", ph: "M", pid: 1, tid: 2, args: { name: "Input latency (overlaps UI work)" } },
		];
		const durations = new Map<TuiPerformanceName, number[]>();
		for (let i = 0; i < this.size; i++) {
			const event = this.events[(this.next - this.size + i + this.capacity) % this.capacity];
			if (!event) continue;
			const trace: Record<string, unknown> = {
				name: event.name,
				cat: "tui",
				ph: event.phase,
				ts: event.ts * 1000,
				pid: 1,
				tid: event.name === "input.to_render" ? 2 : 1,
				args: { ...event.args },
			};
			if (event.duration !== null) trace.dur = event.duration * 1000;
			traceEvents.push(trace);
			collectDuration(durations, event);
		}
		const summary: TuiPerformanceSnapshot["summary"] = {};
		for (const [name, values] of durations) {
			values.sort((a, b) => a - b);
			summary[name] = {
				count: values.length,
				totalMs: values.reduce((total, value) => total + value, 0),
				maxMs: values[values.length - 1]!,
				p50Ms: values[Math.ceil(0.5 * values.length) - 1]!,
				p95Ms: values[Math.ceil(0.95 * values.length) - 1]!,
			};
		}
		return {
			traceEvents,
			displayTimeUnit: "ms",
			summary,
			droppedEvents: this.dropped,
			capacity: this.capacity,
			retainedEvents: this.size,
			metadata: {
				formatVersion: 1,
				node: process.versions.node,
				bun: process.versions.bun ?? null,
				platform: process.platform,
				arch: process.arch,
				captureDurationMs: (this.enabledValue ? performance.now() : this.captureEnd) - this.captureStart,
				recording: this.enabledValue,
				summaryScope: "retained events only; nested spans are inclusive",
			},
		};
	}

	/** Consume a bounded batch without restarting clocks or invalidating in-flight spans. */
	drain(): TuiPerformanceSnapshot {
		const batch = this.snapshot();
		this.events.fill(undefined);
		this.next = 0;
		this.size = 0;
		this.dropped = 0;
		return batch;
	}

	private sampleMemory(): void {
		const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
		this.count("process.memory", { rss, heapUsed, heapTotal, external, arrayBuffers });
	}

	private append(event: StoredEvent): void {
		this.events[this.next] = event;
		this.next = (this.next + 1) % this.capacity;
		if (this.size < this.capacity) this.size++;
		else this.dropped++;
	}
}

function sanitizeArgs(args: TuiPerformanceArgs): TuiPerformanceArgs {
	const safeArgs: Record<string, number> = {};
	for (const [key, value] of Object.entries(args)) {
		if (ARGUMENT_NAMES.has(key) && typeof value === "number" && Number.isFinite(value)) safeArgs[key] = value;
	}
	return safeArgs;
}

function collectDuration(durations: Map<TuiPerformanceName, number[]>, event: StoredEvent): void {
	const value = event.duration ?? (event.name === "event_loop.lag" ? event.args.ms : undefined);
	if (value === undefined) return;
	let values = durations.get(event.name);
	if (!values) {
		values = [];
		durations.set(event.name, values);
	}
	values.push(value);
}

export const tuiPerformance = new TuiPerformanceRecorder();
