import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { currentStep, PlanStore, serializeMarkdown } from "./plan-store.ts";

const directories: string[] = [];
async function setup() {
	const cwd = await mkdtemp(join(tmpdir(), "planner-numbered-"));
	directories.push(cwd);
	const store = new PlanStore(cwd, {
		readFile,
		readdir,
		stat,
		mkdir: async (path, options) => {
			await mkdir(path, options);
		},
		writeFile: async (path, content) => {
			await writeFile(path, content);
		},
	});
	await store.preparePlan("demo");
	return store;
}
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("padding covers small, large and maximum safe orders without truncation", async () => {
	const store = await setup();
	for (const order of [1, 12, 9999, 10000, Number.MAX_SAFE_INTEGER]) {
		const prepared = await store.prepareStep("demo", "work", order);
		expect(basename(dirname(prepared.path))).toBe(`STEP-${String(order).padStart(4, "0")}`);
		expect(await readFile(prepared.path, "utf8")).toBe(prepared.content);
	}
	expect((await store.load("demo")).steps.map((s) => s.order)).toEqual([1, 12, 9999, 10000, Number.MAX_SAFE_INTEGER]);
});

test("rejects prefixed display names and invalid path names", async () => {
	const store = await setup();
	for (const name of ["0001-work", "10000-work", "00001-work"]) {
		await expect(store.prepareStep("demo", name, 1)).rejects.toThrow("unprefixed");
	}
	await expect(store.prepareStep("demo", "x".repeat(81), 1)).rejects.toThrow("1–80");
	expect(await readdir(store.directory("demo"))).toEqual(["INDEX.md"]);
	const prepared = await store.prepareStep("demo", "x".repeat(80), 1);
	expect(basename(dirname(prepared.path))).toBe("STEP-0001");
});

test("numbered prefix mismatch and noncanonical padding report an actionable error", async () => {
	for (const id of ["0002-work", "00001-work", "0000-work", "10000-work"]) {
		const store = await setup();
		const path = join(store.directory("demo"), `STEP-${id}.md`);
		const content = serializeMarkdown({
			metadata: { name: "Work", order: 1, description: "", status: "Pending" },
			body: "\nKeep me\n",
		});
		await writeFile(path, content);
		await expect(store.load("demo")).rejects.toThrow("rename the file and update handoff IDs/orders together");
		await expect(store.activateStep("demo")).rejects.toThrow("prefix must match order");
		expect(await readFile(path, "utf8")).toBe(content);
	}
});

test("mixed legacy and numbered steps preserve exact handoff IDs, selection and context", async () => {
	const store = await setup();
	const legacy = join(store.directory("demo"), "STEP-legacy.md");
	await writeFile(
		legacy,
		serializeMarkdown({
			metadata: { name: "Legacy", order: 2, description: "", status: "Pending" },
			body: "\nLegacy context\n",
		}),
	);
	const prepared = await store.prepareStep("demo", "work", 1);
	const doc = await store.read(prepared.path);
	await writeFile(
		prepared.path,
		serializeMarkdown({
			...doc,
			metadata: { ...doc.metadata, extra: { keep: true } },
			body: "\n# Saved\n\nExact body\n",
		}),
	);
	await expect(store.prepareStep("demo", "another", 2)).rejects.toThrow("already exists");
	await expect(store.prepareHandoff("demo", "work", "legacy")).rejects.toThrow("must exist");
	const handoff = await store.prepareHandoff("demo", "0001", "legacy");
	expect(basename(handoff.path)).toBe("HANDOFF-0001.md");
	expect((await store.read(handoff.path)).metadata).toEqual({
		from_step: "0001",
		from_order: 1,
		to_step: "legacy",
		to_order: 2,
	});
	const before = await store.read(prepared.path);
	const plan = await store.activateStep("demo");
	expect(currentStep(plan)?.id).toBe("0001");
	expect(plan.steps.map((s) => [s.id, s.status])).toEqual([
		["0001", "In Progress"],
		["legacy", "Pending"],
	]);
	expect(plan.steps[0].body).toBe(before.body);
	expect(plan.steps[0].metadata.extra).toEqual({ keep: true });
	expect((await readdir(store.directory("demo"))).includes("STEP-legacy.md")).toBe(true);
});

test("numbered preparation never overwrites existing path collisions", async () => {
	const store = await setup();
	const path = join(store.directory("demo"), "STEP-0001");
	await mkdir(path);
	await expect(store.prepareStep("demo", "work", 1)).rejects.toThrow();
	expect((await stat(path)).isDirectory()).toBe(true);
	await rm(path, { recursive: true });
	const first = await store.prepareStep("demo", "work", 1);
	await expect(store.prepareStep("demo", "work", 1)).rejects.toThrow("already exists");
	expect(await readFile(first.path, "utf8")).toBe(first.content);
});

test("explicit migration coordinates numbered IDs, orders and handoffs without losing context", async () => {
	const store = await setup();
	const first = { path: join(store.directory("demo"), "STEP-0001-work.md") };
	const legacyPath = join(store.directory("demo"), "STEP-legacy.md");
	const firstDoc = {
		metadata: { name: "Work", order: 1, description: "", status: "Pending", extra: { preserve: true } },
		body: "\nWork context\n",
	};
	const legacyDoc = {
		metadata: { name: "Legacy", order: 2, description: "", status: "Pending" },
		body: "\nLegacy context\n",
	};
	await writeFile(first.path, serializeMarkdown(firstDoc));
	await writeFile(legacyPath, serializeMarkdown(legacyDoc));
	const handoff = await store.prepareHandoff("demo", "legacy", "0001-work");
	const handoffDoc = await store.read(handoff.path);
	await writeFile(handoff.path, serializeMarkdown({ ...handoffDoc, body: "\nMigration handoff\n" }));
	const workPath = join(store.directory("demo"), "STEP-10000-work.md");
	const migratedPath = join(store.directory("demo"), "STEP-9999-legacy.md");
	await rename(first.path, workPath);
	await expect(store.load("demo")).rejects.toThrow("prefix must match order");
	await writeFile(workPath, serializeMarkdown({ ...firstDoc, metadata: { ...firstDoc.metadata, order: 10000 } }));
	await rename(legacyPath, migratedPath);
	await writeFile(migratedPath, serializeMarkdown({ ...legacyDoc, metadata: { ...legacyDoc.metadata, order: 9999 } }));
	await expect(store.load("demo")).rejects.toThrow("handoff step names/orders");
	await writeFile(
		handoff.path,
		serializeMarkdown({
			...handoffDoc,
			metadata: {
				...handoffDoc.metadata,
				from_step: "9999-legacy",
				from_order: 9999,
				to_step: "10000-work",
				to_order: 10000,
			},
			body: "\nMigration handoff\n",
		}),
	);
	// Lexical filename order differs here; activation must follow numeric order.
	const plan = await store.activateStep("demo");
	expect(plan.steps.map((s) => [s.id, s.status])).toEqual([
		["9999-legacy", "In Progress"],
		["10000-work", "Pending"],
	]);
	expect(plan.steps.map((s) => s.body)).toEqual([legacyDoc.body, firstDoc.body]);
	expect(plan.steps[1].metadata.extra).toEqual({ preserve: true });
	expect(plan.handoffs[0].body).toBe("\nMigration handoff\n");
	expect(plan.handoffs[0].path).toBe(handoff.path); // Optional handoff filename rename is unnecessary.
	expect((await readdir(store.directory("demo"))).sort()).toEqual([
		"HANDOFF-legacy.md",
		"INDEX.md",
		"STEP-10000-work.md",
		"STEP-9999-legacy.md",
	]);
});
