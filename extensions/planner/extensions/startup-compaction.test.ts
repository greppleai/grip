import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ToolMkdirOptions,
	withFileMutationQueue,
} from "@greppleai/grip";
import { afterEach, expect, test } from "vitest";
import registerPlanner from "./index.ts";
import { PlanStore, serializeMarkdown } from "./plan-store.ts";
import type { PlannerCompactionRequest } from "./test-fixtures.ts";

const directories: string[] = [];
interface StartupToolContent {
	text: string;
}

interface StartupToolResult {
	content: StartupToolContent[];
}

interface StartupStepFixture {
	path: string;
}

interface StartupEventRegistry {
	get(name: string): (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
}

interface StartupFixture {
	ctx: ExtensionContext;
	store: PlanStore;
	step: StartupStepFixture;
	call(name: string, params?: Record<string, unknown>): Promise<StartupToolResult>;
	command(args: string): Promise<void>;
	requests: PlannerCompactionRequest[];
	messages: string[];
	notices: string[];
	events: StartupEventRegistry;
	entries: unknown[];
	snapshot(): Promise<string[]>;
	flush(): Promise<void>;
	setPending(value: boolean): void;
	setIdle(value: boolean): void;
	setPercent(value: number): void;
}

interface Barrier {
	entered: Promise<void>;
	hold: Promise<void>;
	enter(): void;
	release(): void;
}

async function setup(
	percent: number | null | undefined = 40,
	hasUI = true,
	directory = false,
): Promise<StartupFixture> {
	const cwd = await mkdtemp(join(tmpdir(), "planner-startup-"));
	directories.push(cwd);
	const files = {
		cwd,
		readFile,
		readdir,
		stat,
		mkdir: async (path: string, options?: ToolMkdirOptions) => {
			await mkdir(path, options);
		},
		writeFile: async (path: string, content: string | Buffer) => {
			await writeFile(path, content);
		},
	};
	const store = new PlanStore(cwd, files);
	await store.preparePlan("demo");
	const step = directory
		? await store.prepareStep("demo", "first", 1)
		: { path: join(store.directory("demo"), "STEP-0001-first.md") };
	if (!directory)
		await writeFile(
			step.path,
			serializeMarkdown({
				metadata: { name: "First", order: 1, description: "", status: "Pending" },
				body: "\nLegacy work\n",
			}),
		);
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const messages: string[] = [],
		notices: string[] = [],
		requests: any[] = [],
		entries: any[] = [];
	let pending = false,
		idle = false;
	const api = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, handler: any) => events.set(name, handler),
		sendUserMessage: (text: string) => messages.push(text),
		sendMessage: (message: any) => notices.push(message.content),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		toolOperations: files,
		hasUI,
		ui: { notify: (text: string) => notices.push(text), setStatus() {} },
		getContextUsage: () => (percent == null ? undefined : { percent }),
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		compact: (request: unknown) => requests.push(request),
		session: { getBranch: () => entries },
	} as unknown as ExtensionContext;
	registerPlanner(api);
	const call = (name: string, params: unknown = {}) =>
		tools.get(name).execute("call", params, undefined, undefined, ctx);
	const command = (args: string) => commands.get("planner").handler(args, ctx);
	const snapshot = () => Promise.all([store.indexPath("demo"), step.path].map((path) => readFile(path, "utf8")));
	const flush = async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	return {
		ctx,
		store,
		step,
		call,
		command,
		requests,
		messages,
		notices,
		events,
		entries,
		snapshot,
		flush,
		setPending: (value: boolean) => {
			pending = value;
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		setPercent: (value: number) => {
			percent = value;
		},
	};
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("startup success is staged before all mutation in busy UI, busy headless and idle headless modes", async () => {
	for (const [hasUI, idle, entrypoint] of [
		[true, false, "tool"],
		[false, false, "tool"],
		[false, true, "build"],
	] as const) {
		const f = await setup(40, hasUI);
		f.setIdle(idle);
		const before = await f.snapshot();
		if (entrypoint === "tool")
			expect((await f.call("planner_start", { planName: "demo" })).content[0].text).toContain("End this response");
		else await f.command("build demo");
		expect(f.requests).toHaveLength(1);
		expect(await f.snapshot()).toEqual(before);
		expect(f.entries).toEqual([]);
		expect(f.messages).toEqual([]);
		await expect(f.call("planner_start", { planName: "demo" })).rejects.toThrow("Stop the current");
		await expect(f.call("planner_done")).rejects.toThrow("No active");
		f.requests[0].onComplete();
		f.requests[0].onComplete();
		f.requests[0].onError(new Error("late"));
		await f.flush();
		expect(f.messages).toHaveLength(1);
		expect(f.messages[0]).toContain(f.step.path);
		const plan = await f.store.load("demo");
		expect(plan.status).toBe("In Progress");
		expect(plan.steps[0].status).toBe("In Progress");
		expect(plan.metadata.iteration).toBeUndefined();
		expect((await f.store.readRuntime("demo"))?.loop.iteration).toBe(1);
		await expect(f.call("planner_done")).rejects.toThrow("Save progress");
	}
});

test("below-threshold, unknown and nonfinite usage starts normally; normalized fractions compact", async () => {
	for (const percent of [0, 10, 39.99, 0.3999, null, undefined, NaN, Infinity]) {
		const f = await setup(percent === undefined ? null : percent);
		await f.call("planner_start", { planName: "demo" });
		expect(f.requests).toEqual([]);
		expect(f.messages).toHaveLength(1);
	}
	for (const percent of [0.4, 0.5, 1, 40, 80]) {
		const f = await setup(percent);
		await f.call("planner_start", { planName: "demo" });
		expect(f.requests).toHaveLength(1);
		expect(f.messages).toEqual([]);
	}
});

test("startup compaction failure pauses mutation-free, ignores duplicate callbacks and permits retry", async () => {
	for (const hasUI of [true, false]) {
		const f = await setup(40, hasUI);
		const before = await f.snapshot();
		await f.call("planner_start", { planName: "demo" });
		f.requests[0].onError(new Error("denied"));
		f.requests[0].onComplete();
		await f.flush();
		expect(await f.snapshot()).toEqual(before);
		expect(f.messages).toEqual([]);
		expect(f.entries).toEqual([]);
		expect(f.notices.join("\n")).toContain("Startup compaction failed: denied");
		f.setPercent(10);
		await f.call("planner_start", { planName: "demo" });
		expect(f.messages).toHaveLength(1);
	}
	const f = await setup();
	const before = await f.snapshot();
	f.ctx.compact = () => {
		throw new Error("unavailable");
	};
	await expect(f.call("planner_start", { planName: "demo" })).rejects.toThrow(
		"Startup compaction could not be requested",
	);
	expect(await f.snapshot()).toEqual(before);
	expect(f.messages).toEqual([]);
	f.setPercent(10);
	await f.call("planner_start", { planName: "demo" });
	expect(f.messages).toHaveLength(1);
});

test("stop, cancel, shutdown, reload and pending messages suppress stale startup callbacks", async () => {
	const actions: StaleStartupAction[] = ["stop", "cancel", "shutdown", "reload", "pending"];
	for (const action of actions) {
		const f = await setup();
		const before = await f.snapshot();
		await f.call("planner_start", { planName: "demo" });
		await suppressStaleStartup(f, action);
		f.requests[0].onComplete();
		f.requests[0].onError(new Error("late"));
		await f.flush();
		const after = await f.snapshot();
		expect(after[1]).toBe(before[1]);
		if (action !== "cancel") expect(after[0]).toBe(before[0]);
		else expect((await f.store.load("demo")).status).toBe("Skipped");
		expect(f.messages).toEqual([]);
		if (action === "pending") {
			expect(f.notices.join("\n")).toContain("suppressed by pending messages");
			f.setPending(false);
			f.setPercent(10);
			await f.call("planner_start", { planName: "demo" });
			expect(f.messages).toHaveLength(1);
		}
	}
});

test("stale callbacks cannot release or activate a replacement startup reservation", async () => {
	const f = await setup();
	await f.call("planner_start", { planName: "demo" });
	f.setIdle(true);
	await f.command("stop");
	await f.call("planner_start", { planName: "demo" });
	f.requests[0].onComplete();
	f.requests[0].onError(new Error("old"));
	await f.flush();
	await expect(f.call("planner_start", { planName: "demo" })).rejects.toThrow("Stop the current");
	expect(f.messages).toEqual([]);
	f.requests[1].onComplete();
	await f.flush();
	expect(f.messages).toHaveLength(1);
});

test("success reloads fresh Markdown and captures the post-activation progress baseline", async () => {
	const f = await setup();
	await f.call("planner_start", { planName: "demo" });
	const second = { path: join(f.store.directory("demo"), "STEP-0002-second.md") };
	await writeFile(
		second.path,
		serializeMarkdown({
			metadata: { name: "Second", order: 2, description: "", status: "Pending" },
			body: "\nWork\n",
		}),
	);
	const firstDoc = await f.store.read(f.step.path);
	await writeFile(
		f.step.path,
		serializeMarkdown({
			...firstDoc,
			metadata: { ...firstDoc.metadata, status: "Completed" },
			body: "\nNew context\n",
		}),
	);
	const indexDoc = await f.store.read(f.store.indexPath("demo"));
	await writeFile(
		indexDoc.path,
		serializeMarkdown({
			...indexDoc,
			metadata: { ...indexDoc.metadata, iteration: 7, items_per_iteration: 3, extra: "keep" },
		}),
	);
	f.requests[0].onComplete();
	await f.flush();
	expect(f.messages[0]).toContain(second.path);
	expect(f.messages[0]).toContain("iteration 7/50");
	expect(f.messages[0]).toContain("at most 3");
	const plan = await f.store.load("demo");
	expect(plan.steps.map((s) => s.status)).toEqual(["Completed", "In Progress"]);
	expect(plan.metadata.extra).toBe("keep");
	expect(plan.steps[0].body).toBe("\nNew context\n");
	await expect(f.call("planner_done")).rejects.toThrow("Save progress");
});

test("fresh invalid, terminal, empty or over-budget plans pause before startup writes", async () => {
	for (const change of ["invalid", "terminal", "empty", "budget"]) {
		const f = await setup();
		await f.call("planner_start", { planName: "demo" });
		if (change === "invalid") await writeFile(f.step.path, "broken\n");
		if (change === "terminal") await f.store.updateIndex("demo", { status: "Completed" });
		if (change === "empty") await rm(f.step.path);
		if (change === "budget") {
			const doc = await f.store.read(f.store.indexPath("demo"));
			await writeFile(doc.path, serializeMarkdown({ ...doc, metadata: { ...doc.metadata, iteration: 51 } }));
		}
		const index = await readFile(f.store.indexPath("demo"), "utf8");
		f.requests[0].onComplete();
		await f.flush();
		expect(await readFile(f.store.indexPath("demo"), "utf8")).toBe(index);
		expect(f.messages).toEqual([]);
		expect(f.entries).toEqual([]);
		expect(f.notices.join("\n")).toContain("startup paused");
	}
});

test("explicit resume compacts before incrementing persisted iteration; recovery alone does not compact", async () => {
	const f = await setup(10);
	await f.call("planner_start", { planName: "demo" });
	f.setIdle(true);
	await f.command("stop");
	f.setPercent(40);
	await f.events.get("session_start")({}, f.ctx);
	expect(f.requests).toEqual([]);
	const before = await f.snapshot();
	await f.command("resume demo --max-iterations 8");
	expect(f.requests).toHaveLength(1);
	expect(await f.snapshot()).toEqual(before);
	f.requests[0].onComplete();
	f.requests[0].onComplete();
	await f.flush();
	expect(f.messages).toHaveLength(2);
	expect(f.messages[1]).toContain("iteration 2/8");
	expect((await f.store.readRuntime("demo"))?.loop.iteration).toBe(2);
});

test("resume failure leaves iteration untouched and fresh resume budgets are revalidated", async () => {
	for (const outcome of ["error", "budget"]) {
		const f = await setup(10);
		await f.call("planner_start", { planName: "demo" });
		f.setIdle(true);
		await f.command("stop");
		f.setPercent(40);
		await f.command("resume demo --max-iterations 2");
		if (outcome === "budget") {
			const runtime = (await f.store.readRuntime("demo"))!;
			await f.store.saveRuntime("demo", { ...runtime, loop: { ...runtime.loop, iteration: 2 } });
		}
		const before = await f.snapshot();
		if (outcome === "error") f.requests[0].onError(new Error("resume failed"));
		else f.requests[0].onComplete();
		await f.flush();
		expect(await f.snapshot()).toEqual(before);
		expect(f.messages).toHaveLength(1);
		expect(f.notices.join("\n")).toContain("startup paused");
	}
});

test("startup instructions are small references and initial invalid options never request compaction", async () => {
	const f = await setup();
	const doc = await f.store.read(f.step.path);
	await writeFile(f.step.path, serializeMarkdown({ ...doc, body: "huge-body-marker".repeat(10000) }));
	await expect(f.call("planner_start", { planName: "demo", maxIterations: -1 })).rejects.toThrow("Loop options");
	expect(f.requests).toEqual([]);
	await f.call("planner_start", { planName: "demo" });
	expect(f.requests[0].customInstructions.length).toBeLessThan(1000);
	expect(f.requests[0].customInstructions).toContain(f.store.indexPath("demo"));
	expect(f.requests[0].customInstructions).not.toContain("huge-body-marker");
});

function barrier(): Barrier {
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { entered, hold, enter, release };
}

type StaleStartupAction = "stop" | "cancel" | "shutdown" | "reload" | "pending";
type QueuedStartupAction = "stop" | "cancel" | "reload" | "pending";

// Apply the lifecycle change that must invalidate a stale startup callback.
async function suppressStaleStartup(f: StartupFixture, action: StaleStartupAction): Promise<void> {
	if (action === "pending") {
		f.setPending(true);
		return;
	}
	if (action === "shutdown" || action === "reload") {
		await f.events.get("session_shutdown")({}, f.ctx);
		if (action === "reload") await f.events.get("session_start")({}, f.ctx);
		return;
	}
	f.setIdle(true);
	await f.command(action === "cancel" ? "cancel demo" : "stop");
}

interface QueuedActivationGate {
	queue: Barrier;
	sampled: Barrier;
	lockedValidation: Barrier;
	blocker: Promise<void>;
}

// Hold the activation write lock and pause the fresh reads that precede and follow it.
async function gateQueuedActivation(f: StartupFixture): Promise<QueuedActivationGate> {
	const queue = barrier();
	const sampled = barrier();
	const lockedValidation = barrier();
	const blocker = withFileMutationQueue(f.step.path, async () => {
		queue.enter();
		await queue.hold;
	});
	await queue.entered;
	const originalRead = f.ctx.toolOperations.readFile;
	let reads = 0;
	f.ctx.toolOperations.readFile = async (path) => {
		const content = await originalRead(path);
		// Fresh callback load first, initial activation load second, and fresh
		// validation under the acquired target lock third. Suppress at that last
		// read, after activation has passed its first guard and the queue barrier.
		if (path === f.step.path) {
			reads++;
			if (reads === 2) {
				sampled.enter();
				await sampled.hold;
			}
			if (reads === 3) {
				lockedValidation.enter();
				await lockedValidation.hold;
			}
		}
		return content;
	};
	return { queue, sampled, lockedValidation, blocker };
}

// Interrupt the loop once activation waits on its locked revalidation.
type LockedActivationInterruption = "stop" | "reload" | "pending";

async function interruptLockedActivation(f: StartupFixture, action: LockedActivationInterruption): Promise<void> {
	if (action === "pending") {
		f.setPending(true);
		return;
	}
	if (action === "reload") {
		await f.events.get("session_start")({}, f.ctx);
		return;
	}
	f.setIdle(true);
	await f.command("stop");
}

test("lifecycle changes during the callback's fresh read prevent all startup writes", async () => {
	for (const action of ["stop", "cancel", "reload", "shutdown", "pending"]) {
		const f = await setup();
		const before = await f.snapshot();
		await f.call("planner_start", { planName: "demo" });
		const gate = barrier();
		const originalRead = f.ctx.toolOperations.readFile;
		let blocked = false;
		f.ctx.toolOperations.readFile = async (path) => {
			const content = await originalRead(path);
			if (!blocked && path === f.store.indexPath("demo")) {
				blocked = true;
				gate.enter();
				await gate.hold;
			}
			return content;
		};
		f.requests[0].onComplete();
		await gate.entered;
		try {
			if (action === "pending") f.setPending(true);
			else if (action === "reload") await f.events.get("session_start")({}, f.ctx);
			else if (action === "shutdown") await f.events.get("session_shutdown")({}, f.ctx);
			else {
				f.setIdle(true);
				await f.command(action === "cancel" ? "cancel demo" : "stop");
			}
		} finally {
			gate.release();
		}
		await f.flush();
		expect(f.messages).toEqual([]);
		const after = await f.snapshot();
		expect(after[1]).toBe(before[1]);
		if (action !== "cancel") expect(after[0]).toBe(before[0]);
		else expect((await f.store.load("demo")).status).toBe("Skipped");
	}
});

test("a fresh-read callback invalidated by stop cannot release a replacement startup", async () => {
	const f = await setup();
	const before = await f.snapshot();
	await f.call("planner_start", { planName: "demo" });
	const gate = barrier();
	const originalRead = f.ctx.toolOperations.readFile;
	let blocked = false;
	f.ctx.toolOperations.readFile = async (path) => {
		const content = await originalRead(path);
		if (!blocked && path === f.store.indexPath("demo")) {
			blocked = true;
			gate.enter();
			await gate.hold;
		}
		return content;
	};
	f.requests[0].onComplete();
	await gate.entered;
	try {
		f.setIdle(true);
		await f.command("stop");
		await f.call("planner_start", { planName: "demo" });
	} finally {
		gate.release();
	}
	await f.flush();
	expect(await f.snapshot()).toEqual(before);
	expect(f.messages).toEqual([]);
	await expect(f.call("planner_start", { planName: "demo" })).rejects.toThrow("Stop the current");
	f.requests[1].onComplete();
	await f.flush();
	expect(f.messages).toHaveLength(1);
});

// biome-ignore format: Keep the custom bounded-test-matrix directive attached to the callback.
test("post-compaction queued activation rechecks guards for legacy and directory steps", // grip-ignore noExcessiveCollectionIterations: eight directory/action combinations are a bounded test matrix.
async () => {
	const actions: QueuedStartupAction[] = ["stop", "cancel", "pending", "reload"];
	for (const directory of [false, true])
		for (const action of actions) {
			const f = await setup(40, true, directory);
			await f.call("planner_start", { planName: "demo" });
			const beforeStep = await readFile(f.step.path, "utf8");
			const gate = await gateQueuedActivation(f);
			f.requests[0].onComplete();
			let cancellation: Promise<unknown> | undefined;
			try {
				await gate.sampled.entered;
				gate.sampled.release();
				gate.queue.release();
				await gate.lockedValidation.entered;
				if (action === "cancel") cancellation = f.command("cancel demo");
				else await interruptLockedActivation(f, action);
			} finally {
				gate.sampled.release();
				gate.lockedValidation.release();
				gate.queue.release();
			}
			await gate.blocker;
			await cancellation;
			await f.flush();
			expect(await readFile(f.step.path, "utf8")).toBe(beforeStep);
			expect(f.messages).toEqual([]);
			// The plan status write has already occurred; an in-flight write cannot roll back.
			expect((await f.store.load("demo")).status).toBe(action === "cancel" ? "Skipped" : "In Progress");
			if (action !== "cancel") {
				f.setPending(false);
				f.setPercent(10);
				await f.call("planner_start", { planName: "demo" });
				expect(f.messages).toHaveLength(1);
			}
		}
});
