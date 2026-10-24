import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PlanStore, parseMarkdown, type PreparedDocument } from "./plan-store.ts";

const directories: string[] = [];
const files = {
  mkdir: async (path: string, options?: { recursive?: boolean }) => { await mkdir(path, options); },
  readFile,
  writeFile: async (path: string, content: string | Buffer) => { await writeFile(path, content); },
  readdir: async (path: string) => readdir(path),
  stat,
};
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "planner-prepare-"));
  directories.push(cwd);
  return new PlanStore(cwd, files);
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function expectWritten(prepared: PreparedDocument) {
  expect(isAbsolute(prepared.path)).toBe(true);
  expect(await readFile(prepared.path, "utf8")).toBe(prepared.content);
  return parseMarkdown(prepared.content, prepared.path);
}

test("preparePlan returns the exact empty scaffold without description text", async () => {
  const store = await setup();
  const prepared = await store.preparePlan("demo");
  expect(prepared.path).toBe(store.indexPath("demo"));
  const document = await expectWritten(prepared);
  expect(document.metadata).toEqual({ name: "demo", description: "", status: "Pending" });
  expect(document.body).toBe("\n<!-- Write the plan content here. -->\n");
  expect((await store.load("demo")).steps).toEqual([]);
  expect(await readdir(store.directory("demo"))).toEqual(["INDEX.md"]);
});

test("prepareStep creates multiple valid steps without changing the parent index", async () => {
  const store = await setup();
  const index = await store.preparePlan("demo", "Display: demo");
  const first = await store.prepareStep("demo", "first", 1, "First step");
  const second = await store.prepareStep("demo", "second", 2);
  const document = await expectWritten(first);
  await expectWritten(second);
  expect(document.metadata).toEqual({ name: "First step", order: 1, description: "", status: "Pending" });
  expect(document.body).toBe("\n<!-- Write the step content here. -->\n");
  expect((await store.load("demo")).steps.map((step) => step.id)).toEqual(["0001", "0002"]);
  expect(await readFile(index.path, "utf8")).toBe(index.content);
});

test("prepareHandoff resolves exact endpoint orders and returns placeholder context", async () => {
  const store = await setup();
  const index = await store.preparePlan("demo");
  const from = await store.prepareStep("demo", "source", 3);
  const to = await store.prepareStep("demo", "target", 7);
  const handoff = await store.prepareHandoff("demo", "0003", "0007");
  expect(handoff.path).toBe(join(store.directory("demo"), "STEP-0003", "HANDOFF-0003.md"));
  const document = await expectWritten(handoff);
  expect(document.metadata).toEqual({ from_step: "0003", from_order: 3, to_step: "0007", to_order: 7 });
  expect(document.body).toBe("\n<!-- Write the handoff context here. -->\n");
  expect((await store.load("demo")).handoffs).toHaveLength(1);
  for (const untouched of [index, from, to]) expect(await readFile(untouched.path, "utf8")).toBe(untouched.content);
  expect(document.body).toBe("\n<!-- Write the handoff context here. -->\n");
  expect((await store.load("demo")).handoffs).toHaveLength(1);
  for (const untouched of [index, from, to]) expect(await readFile(untouched.path, "utf8")).toBe(untouched.content);
});

test("preparation refuses overwrites, duplicate orders and invalid metadata", async () => {
  const store = await setup();
  const index = await store.preparePlan("demo");
  const step = await store.prepareStep("demo", "first", 1);
  await store.prepareStep("demo", "second", 2);
  const handoff = await store.prepareHandoff("demo", "0001", "0002");
  await expect(store.preparePlan("demo", "Replacement")).rejects.toThrow();
  await expect(store.prepareStep("demo", "first", 1)).rejects.toThrow("already exists");
  await expect(store.prepareStep("demo", "other", 1)).rejects.toThrow("already exists");
  await expect(store.prepareHandoff("demo", "0001", "0002")).rejects.toThrow("overwrite");
  for (const order of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(store.prepareStep("demo", "bad-order", order)).rejects.toThrow("positive integer");
  }
  await expect(store.preparePlan("blank", " ")).rejects.toThrow("Display name");
  await expect(store.prepareStep("demo", "blank", 3, "")).rejects.toThrow("Display name");
  for (const original of [index, step, handoff]) expect(await readFile(original.path, "utf8")).toBe(original.content);
  expect((await readdir(store.directory("demo"))).sort()).toEqual(["INDEX.md", "STEP-0001", "STEP-0002"]);
});

test("missing parents/endpoints and invalid path IDs create no documents", async () => {
  const store = await setup();
  await expect(store.prepareStep("missing", "first", 1)).rejects.toThrow();
  await expect(store.prepareHandoff("missing", "first", "second")).rejects.toThrow();
  await store.preparePlan("demo");
  await store.prepareStep("demo", "first", 1);
  await expect(store.prepareHandoff("demo", "0001", "missing")).rejects.toThrow("must exist");
  for (const id of ["../escape", "/tmp/escape", "a/b", "", "."]) {
    await expect(store.preparePlan(id)).rejects.toThrow();
    await expect(store.prepareStep("demo", id, 2)).rejects.toThrow();
    await expect(store.prepareHandoff("demo", "0001", id)).rejects.toThrow();
    await expect(store.prepareHandoff("demo", "0001", "0001", id)).rejects.toThrow();
  }
  expect((await readdir(store.root)).sort()).toEqual(["demo"]);
  expect((await readdir(store.directory("demo"))).sort()).toEqual(["INDEX.md", "STEP-0001"]);
});

test("explicit handoff identifiers allow distinct destinations without overwriting", async () => {
  const store = await setup();
  await store.preparePlan("demo");
  await store.prepareStep("demo", "first", 1);
  await store.prepareStep("demo", "second", 2);
  await store.prepareStep("demo", "third", 3);
  const original = await store.prepareHandoff("demo", "0001", "0002");
  const additional = await store.prepareHandoff("demo", "0001", "0003", "first-to-third");
  expect(additional.path).toEndWith("HANDOFF-first-to-third.md");
  expect((await store.load("demo")).handoffs).toHaveLength(2);
  expect(await readFile(original.path, "utf8")).toBe(original.content);
});

test("concurrent preparations cannot claim the same plan, order or handoff file", async () => {
  const store = await setup();
  const plans = await Promise.allSettled([store.preparePlan("demo"), store.preparePlan("demo")]);
  expect(plans.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const steps = await Promise.allSettled([store.prepareStep("demo", "a", 1), store.prepareStep("demo", "b", 1)]);
  expect(steps.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const plan = await store.load("demo");
  expect(plan.steps).toHaveLength(1);
  const source = plan.steps[0].id;
  await store.prepareStep("demo", "target", 2);
  const handoffs = await Promise.allSettled([store.prepareHandoff("demo", source, "0002"), store.prepareHandoff("demo", source, "0002")]);
  expect(handoffs.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await store.load("demo")).handoffs).toHaveLength(1);
});

test("preparation protects existing directories and dangling symlinks", async () => {
  const store = await setup();
  await store.preparePlan("demo");
  const directory = join(store.directory("demo"), "STEP-directory.md");
  await mkdir(directory);
  // A malformed existing STEP entry prevents loading, never gets replaced.
  await expect(store.prepareStep("demo", "directory", 1)).rejects.toThrow();
  expect((await stat(directory)).isDirectory()).toBe(true);
  await rm(directory, { recursive: true });
  await store.prepareStep("demo", "first", 1);
  await store.prepareStep("demo", "second", 2);
  const missingTarget = join(store.root, "missing-target.md");
  const alias = join(store.directory("demo"), "HANDOFF-alias.md");
  await symlink(missingTarget, alias);
  await expect(store.prepareHandoff("demo", "0001", "0002", "alias")).rejects.toThrow();
  await expect(stat(missingTarget)).rejects.toThrow();
});