import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@greppleai/grip";
import { type ToolMkdirOptions, withFileMutationQueue } from "@greppleai/grip";
import { Check } from "typebox/value";
import { afterEach, expect, test } from "vitest";
import registerPlanner from "./index.ts";
import { PlanStore, replaceStatus, serializeMarkdown } from "./plan-store.ts";

const roots: string[] = [];
const files = {
	mkdir: async (path: string, options?: ToolMkdirOptions) => {
		await mkdir(path, options);
	},
	readFile,
	readdir,
	stat,
	writeFile,
};
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "planner-directories-"));
	roots.push(root);
	const store = new PlanStore(root, files);
	await store.preparePlan("demo");
	return store;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("numeric-only directory paths, display names, 9999/10000 and safe integer order", async () => {
	const store = await setup();
	for (const order of [1, 9999, 10000, Number.MAX_SAFE_INTEGER]) {
		const step = await store.prepareStep("demo", "design", order, "Design work");
		expect(basename(step.path)).toBe("INDEX.md");
		expect(basename(dirname(step.path))).toBe(`STEP-${String(order).padStart(4, "0")}`);
	}
	expect((await store.load("demo")).steps.map((s) => s.id)).toEqual([
		"0001",
		"9999",
		"10000",
		String(Number.MAX_SAFE_INTEGER),
	]);
	await expect(store.prepareStep("demo", "other", 1)).rejects.toThrow("already exists");
});

test("progress allocation is serial across instances; edits, gaps, collisions and retries", async () => {
	const store = await setup();
	const step = await store.prepareStep("demo", "design", 1);
	// Separate PlanStore instances share the backend path mutation queue.
	// The store is rooted at the workspace, not the plan directory.
	const peer = new PlanStore(dirname(store.root), files);
	const first = await store.prepareProgress("demo", "0001");
	expect(basename(first.path)).toBe("PROGRESS-0001.md");
	expect(await readFile(first.path, "utf8")).toBe(first.content);
	await writeFile(first.path, first.content.replace("<!-- Write the progress context here. -->", "Decision saved"));
	const created = await Promise.all([store.prepareProgress("demo", "0001"), peer.prepareProgress("demo", "0001")]);
	expect(created.map((p) => basename(p.path)).sort()).toEqual(["PROGRESS-0002.md", "PROGRESS-0003.md"]);
	expect((await store.load("demo")).steps[0].progress.map((p) => p.sequence)).toEqual([1, 2, 3]);
	expect((await store.load("demo")).steps[0].progress[0].body).toContain("Decision saved");
	await rm(created[0].path);
	const fourth = await store.prepareProgress("demo", "0001");
	expect(basename(fourth.path)).toBe("PROGRESS-0004.md");
	const collision = join(dirname(step.path), "PROGRESS-0005.md");
	await symlink(join(store.root, "missing-target"), collision);
	await expect(store.prepareProgress("demo", "0001")).rejects.toThrow();
	await rm(collision);
	expect(basename((await store.prepareProgress("demo", "0001")).path)).toBe("PROGRESS-0005.md");
});

test("queued progress writers serialize on the target and retry a failed allocation without overwriting", async () => {
	const store = await setup();
	const step = await store.prepareStep("demo", "design", 1);
	const first = await store.prepareProgress("demo", "0001");
	await writeFile(
		first.path,
		first.content.replace("<!-- Write the progress context here. -->", "Keep this authored history."),
	);
	const before = await readFile(first.path, "utf8");
	const indexBefore = await readFile(step.path, "utf8");
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	const blocker = withFileMutationQueue(step.path, async () => {
		enter();
		await hold;
	});
	await entered;
	let failOnce = true;
	const peer = new PlanStore(dirname(store.root), {
		...files,
		writeFile: async (path, content) => {
			if (failOnce && path.endsWith("PROGRESS-0002.md")) {
				failOnce = false;
				throw new Error("backend refused progress");
			}
			return writeFile(path, content);
		},
	});
	const firstAttempt = peer.prepareProgress("demo", "0001");
	const nextAttempt = store.prepareProgress("demo", "0001");
	try {
		expect((await readdir(dirname(step.path))).sort()).toEqual(["INDEX.md", "PROGRESS-0001.md"]);
	} finally {
		release();
	}
	await blocker;
	await expect(firstAttempt).rejects.toThrow("backend refused progress");
	expect((await nextAttempt).path).toBe(join(dirname(step.path), "PROGRESS-0002.md"));
	expect((await store.prepareProgress("demo", "0001")).path).toBe(join(dirname(step.path), "PROGRESS-0003.md"));
	expect(await readFile(first.path, "utf8")).toBe(before);
	expect(await readFile(step.path, "utf8")).toBe(indexBefore);
	expect((await store.load("demo")).steps[0].progress.map((p) => p.sequence)).toEqual([1, 2, 3]);
});

test("malformed progress, overflow and legacy flat progress are rejected without writing", async () => {
	const store = await setup();
	const step = await store.prepareStep("demo", "design", 1);
	const folder = dirname(step.path);
	const bad = join(folder, "PROGRESS-00001.md");
	await writeFile(bad, serializeMarkdown({ metadata: { sequence: 1 }, body: "\n" }));
	await expect(store.load("demo")).rejects.toThrow("must match sequence");
	await rm(bad);
	await writeFile(
		join(folder, `PROGRESS-${Number.MAX_SAFE_INTEGER}.md`),
		serializeMarkdown({ metadata: { sequence: Number.MAX_SAFE_INTEGER }, body: "\n" }),
	);
	await expect(store.prepareProgress("demo", "0001")).rejects.toThrow("overflow");
	await rm(join(folder, `PROGRESS-${Number.MAX_SAFE_INTEGER}.md`));
	await writeFile(
		join(store.directory("demo"), "STEP-legacy.md"),
		serializeMarkdown({
			metadata: { name: "Old", order: 2, description: "", status: "Pending" },
			body: "\nOld progress\n",
		}),
	);
	await expect(store.prepareProgress("demo", "legacy")).rejects.toThrow("legacy flat file");
	expect((await readdir(folder)).sort()).toEqual(["INDEX.md"]);
});

test("nested and legacy handoffs validate exact endpoints and source", async () => {
	const store = await setup();
	const first = await store.prepareStep("demo", "design", 1);
	await store.prepareStep("demo", "build", 2);
	const nested = await store.prepareHandoff("demo", "0001", "0002");
	expect(nested.path).toBe(join(dirname(first.path), "HANDOFF-0001.md"));
	expect((await store.load("demo")).handoffs[0].fromStep).toBe("0001");
	const root = join(store.directory("demo"), "HANDOFF-legacy.md");
	await writeFile(
		root,
		serializeMarkdown({
			metadata: { from_step: "0001", from_order: 1, to_step: "0002", to_order: 2 },
			body: "\nLegacy root handoff\n",
		}),
	);
	expect((await store.load("demo")).handoffs).toHaveLength(2);
	await writeFile(nested.path, nested.content.replace('from_step: "0001"', 'from_step: "0002"'));
	await expect(store.load("demo")).rejects.toThrow("source does not match");
});

test("status replacement preserves every byte outside scalar, including CRLF, BOM and comments", async () => {
	const text =
		'\uFEFF---\r\nname: "Exact" # keep\r\nstatus: "Pending" # comment\r\nextra: { a: 1 }\r\n---\r\n# Body  \r\n';
	const next = replaceStatus(text, "test", "In Progress");
	expect(next).toBe(text.replace('"Pending"', '"In Progress"'));
	const store = await setup();
	const step = await store.prepareStep("demo", "design", 1);
	await writeFile(step.path, text.replace('name: "Exact"', 'name: "Exact"\r\ndescription: ""\r\norder: 1'));
	const original = await readFile(step.path, "utf8");
	await store.updateStepStatus("demo", "0001", "Completed");
	expect(await readFile(step.path, "utf8")).toBe(original.replace('"Pending"', '"Completed"'));
	await expect(store.updateIndex("demo", { iteration: 2 })).rejects.toThrow("immutable");
});

test("malformed directories and duplicate mixed orders are rejected", async () => {
	const store = await setup();
	await store.prepareStep("demo", "design", 1);
	await writeFile(
		join(store.directory("demo"), "STEP-old.md"),
		serializeMarkdown({ metadata: { name: "Old", description: "", order: 1, status: "Pending" }, body: "\n" }),
	);
	await expect(store.load("demo")).rejects.toThrow("unique");
	await rm(join(store.directory("demo"), "STEP-old.md"));
	await mkdir(join(store.directory("demo"), "STEP-00002"));
	await expect(store.load("demo")).rejects.toThrow();
});

test("registered progress tool has strict schema and returns an exact backend scaffold without delivery", async () => {
	const store = await setup();
	await store.prepareStep("demo", "design", 1);
	const tools = new Map<string, any>();
	const messages: string[] = [];
	registerPlanner({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {},
		on() {},
		sendUserMessage: (message: string) => messages.push(message),
	} as unknown as ExtensionAPI);
	const tool = tools.get("planner_progress_prepare");
	expect(Check(tool.parameters, { planName: "demo", stepId: "0001" })).toBe(true);
	expect(Check(tool.parameters, { planName: "demo", stepId: "0001", body: "not allowed" })).toBe(false);
	const ctx = { toolOperations: { ...files, cwd: dirname(store.root) } } as unknown as ExtensionContext;
	const result = await tool.execute("call", { planName: "demo", stepId: "0001" }, undefined, undefined, ctx);
	const prepared = (await store.load("demo")).steps[0].progress[0];
	expect(result.content[0].text).toContain(JSON.stringify(prepared.path));
	expect(result.content[0].text).toContain(await readFile(prepared.path, "utf8"));
	expect(messages).toEqual([]);
});
