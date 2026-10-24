import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanStore, parseMarkdown, serializeMarkdown, currentStep } from "./plan-store.ts";
import { withFileMutationQueue } from "@greppleai/grip";

const dirs: string[] = [];
export const files = { mkdir: async (path: string, options?: { recursive?: boolean }) => { await mkdir(path, options); }, readFile, writeFile: async (path: string, content: string | Buffer) => { await writeFile(path, content); }, readdir: async (path: string) => readdir(path), stat };
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "planner-store-")); dirs.push(cwd);
  const store = new PlanStore(cwd, files);
  const prepared = await store.preparePlan("demo", "Demo: migration");
  const document = parseMarkdown(prepared.content, prepared.path);
  await writeFile(prepared.path, serializeMarkdown({ ...document, metadata: { ...document.metadata, description: "Multiple\nlines" }, body: "\n# Demo: migration\n\nMultiple\nlines\n" }));
  return store;
}
async function step(store: PlanStore, id: string, order: number, status = "Pending") {
  await writeFile(join(store.directory("demo"), `STEP-${id}.md`), serializeMarkdown({ metadata: { name: id, order, description: "Work", status }, body: "\nFree-form context\n" }));
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("Markdown storage", () => {
  test("roundtrips YAML and free-form Markdown; preserves extra metadata on updates", async () => {
    const store = await setup();
    const authored = await store.read(store.indexPath("demo"));
    await writeFile(authored.path, serializeMarkdown({ ...authored, metadata: { ...authored.metadata, custom: { nested: true }, iteration: 2 } }));
    const before = await store.read(store.indexPath("demo"));
    await store.updateIndex("demo", { status: "In Progress" });
    const plan = await store.load("demo");
    expect(plan.name).toBe("Demo: migration");
    expect(plan.description).toBe("Multiple\nlines");
    expect(plan.body).toBe(before.body);
    expect(plan.metadata.custom).toEqual({ nested: true });
    expect(plan.status).toBe("In Progress");
  });
  test("sorts steps by order and chooses active before pending", async () => {
    const store = await setup();
    await step(store, "z", 1); await step(store, "a", 2, "In Progress");
    const plan = await store.load("demo");
    expect(plan.steps.map((s) => s.id)).toEqual(["z", "a"]);
    expect(currentStep(plan)?.id).toBe("a");
  });
  test("rejects duplicate orders and multiple active steps", async () => {
    const store = await setup();
    await step(store, "one", 1, "In Progress"); await step(store, "two", 1, "In Progress");
    await expect(store.load("demo")).rejects.toThrow("unique");
    await step(store, "two", 2, "In Progress");
    await expect(store.load("demo")).rejects.toThrow("only one");
  });
  test("validates exact handoff endpoints and indices", async () => {
    const store = await setup();
    await step(store, "one", 1, "Completed"); await step(store, "two", 2);
    const path = join(store.directory("demo"), "HANDOFF-one.md");
    await writeFile(path, serializeMarkdown({ metadata: { from_step: "one", from_order: 1, to_step: "two", to_order: 2 }, body: "\nDecision, risks, next actions.\n" }));
    expect((await store.load("demo")).handoffs[0].toStep).toBe("two");
    await step(store, "two", 3);
    await expect(store.load("demo")).rejects.toThrow("do not match");
  });
  test("refuses overwrite and traversal", async () => {
    const store = await setup();
    await expect(store.preparePlan("demo", "Overwrite")).rejects.toThrow();
    for (const id of ["../outside", "/tmp/x", "a/b", ".", "", "x.md"]) expect(() => store.indexPath(id)).toThrow();
    expect((await store.load("demo")).name).toBe("Demo: migration");
  });
  test("requires valid frontmatter, status and order", async () => {
    expect(() => parseMarkdown("# No frontmatter", "bad.md")).toThrow();
    expect(() => parseMarkdown("---\nname: one\nname: two\n---\n", "bad.md")).toThrow();
    const store = await setup();
    await step(store, "bad", 0);
    await expect(store.load("demo")).rejects.toThrow("positive integer");
    await step(store, "bad", 1, "pending");
    await expect(store.load("demo")).rejects.toThrow("status must be");
  });
  test("lists local plans; missing directory is empty", async () => {
    const store = await setup();
    expect((await store.list()).map((p) => p.id)).toEqual(["demo"]);
    expect(await new PlanStore(join(store.root, "missing"), files).list()).toEqual([]);
  });
  test("activation selects the first Pending step by order without reopening terminal steps", async () => {
    const store = await setup();
    await step(store, "completed", 1, "Completed");
    await step(store, "skipped", 2, "Skipped");
    await step(store, "z", 3); await step(store, "a", 4);
    const index = await readFile(store.indexPath("demo"), "utf8");
    const plan = await store.activateStep("demo");
    expect(plan.steps.map((s) => [s.id, s.status])).toEqual([
      ["completed", "Completed"], ["skipped", "Skipped"], ["z", "In Progress"], ["a", "Pending"],
    ]);
    expect(currentStep(plan)?.id).toBe("z");
    expect(currentStep(await store.load("demo"))?.status).toBe("In Progress");
    expect(await readFile(store.indexPath("demo"), "utf8")).toBe(index);
  });
  test("activation retains an existing active step and is idempotent without writes", async () => {
    const store = await setup();
    await step(store, "pending", 1); await step(store, "active", 2, "In Progress");
    let writes = 0;
    const observed = new PlanStore(join(store.root, ".."), {
      ...files, writeFile: async (path, content) => { writes++; await files.writeFile(path, content); },
    });
    expect(currentStep(await observed.activateStep("demo"))?.id).toBe("active");
    expect(currentStep(await observed.activateStep("demo"))?.id).toBe("active");
    expect((await store.load("demo")).steps[0].status).toBe("Pending");
    expect(writes).toBe(0);
  });
  test("activation preserves the exact body and unrelated frontmatter", async () => {
    const store = await setup();
    const path = join(store.directory("demo"), "STEP-one.md");
    const body = "\n# Context\r\n\r\nFree-form notes with trailing spaces.  \r\n\n";
    await writeFile(path, serializeMarkdown({ metadata: {
      name: "One", order: 1, description: "Multi\nline", status: "Pending", custom: { nested: ["keep", 7] },
    }, body }));
    const before = await store.read(path);
    const plan = await store.activateStep("demo");
    const after = await store.read(path);
    expect(after.metadata).toEqual({ ...before.metadata, status: "In Progress" });
    expect(after.body).toBe(body);
    expect(plan.steps[0].body).toBe(body);
    expect(plan.steps[0].metadata).toEqual(after.metadata);
    expect(plan.steps[0].status).toBe("In Progress");
  });
  test("activation does not write for empty, all-terminal or terminal parent plans", async () => {
    const store = await setup();
    let writes = 0;
    const observed = new PlanStore(join(store.root, ".."), {
      ...files, writeFile: async (path, content) => { writes++; await files.writeFile(path, content); },
    });
    expect((await observed.activateStep("demo")).steps).toEqual([]);
    await step(store, "done", 1, "Completed"); await step(store, "skip", 2, "Skipped");
    expect(currentStep(await observed.activateStep("demo"))).toBeUndefined();
    await step(store, "pending", 3);
    for (const status of ["Completed", "Skipped"]) {
      await store.updateIndex("demo", { status });
      expect((await observed.activateStep("demo")).steps[2].status).toBe("Pending");
    }
    expect(writes).toBe(0);
  });
  test("concurrent activation across store instances creates one active step and writes once", async () => {
    const store = await setup();
    await step(store, "one", 1); await step(store, "two", 2);
    let writes = 0;
    const operations = { ...files, writeFile: async (path: string, content: string | Buffer) => { writes++; await files.writeFile(path, content); } };
    const first = new PlanStore(join(store.root, ".."), operations);
    const second = new PlanStore(join(store.root, ".."), operations);
    const plans = await Promise.all([first.activateStep("demo"), second.activateStep("demo"), first.activateStep("demo")]);
    for (const plan of plans) expect(plan.steps.map((s) => s.status)).toEqual(["In Progress", "Pending"]);
    expect((await store.load("demo")).steps.filter((s) => s.status === "In Progress")).toHaveLength(1);
    expect(writes).toBe(1);
  });
  test("activation revalidates after a queued edit, preserving changes and terminal statuses", async () => {
    for (const status of ["Pending", "Completed", "Skipped"]) {
      const store = await setup();
      await step(store, "one", 1); await step(store, "two", 2);
      const path = join(store.directory("demo"), "STEP-one.md");
      let release!: () => void;
      let entered!: () => void;
      let sampled!: () => void;
      const enteredQueue = new Promise<void>((resolve) => { entered = resolve; });
      const sampledStep = new Promise<void>((resolve) => { sampled = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const editor = withFileMutationQueue(path, async () => { entered(); await hold; });
      await enteredQueue;
      const observed = new PlanStore(join(store.root, ".."), {
        ...files, readFile: async (filePath) => {
          const content = await files.readFile(filePath);
          if (filePath === path) sampled();
          return content;
        },
      });
      const activation = observed.activateStep("demo");
      try {
        await sampledStep;
        await writeFile(path, serializeMarkdown({ metadata: {
          name: "Edited", order: 1, description: "Newest", status, custom: "preserve",
        }, body: "\nNewest context.\n" }));
      } finally { release(); }
      await editor;
      const plan = await activation;
      const edited = plan.steps[0];
      expect(edited.name).toBe("Edited");
      expect(edited.metadata.custom).toBe("preserve");
      expect(edited.body).toBe("\nNewest context.\n");
      expect(edited.status).toBe(status === "Pending" ? "In Progress" : status);
      expect(plan.steps[1].status).toBe(status === "Pending" ? "Pending" : "In Progress");
    }
  });
  test("activation propagates write failures without claiming activation", async () => {
    const store = await setup();
    await step(store, "one", 1);
    const path = join(store.directory("demo"), "STEP-one.md");
    const original = await readFile(path, "utf8");
    const failing = new PlanStore(join(store.root, ".."), {
      ...files, writeFile: async () => { throw new Error("Backend write refused"); },
    });
    await expect(failing.activateStep("demo")).rejects.toThrow("Backend write refused");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await store.load("demo")).steps[0].status).toBe("Pending");
    expect((await store.activateStep("demo")).steps[0].status).toBe("In Progress");
  });
  test("activation preserves malformed-plan validation failures without writing", async () => {
    const store = await setup();
    let writes = 0;
    const observed = new PlanStore(join(store.root, ".."), {
      ...files, writeFile: async (path, content) => { writes++; await files.writeFile(path, content); },
    });
    await step(store, "one", 1); await step(store, "two", 1);
    await expect(observed.activateStep("demo")).rejects.toThrow("unique");
    await step(store, "one", 1, "In Progress"); await step(store, "two", 2, "In Progress");
    await expect(observed.activateStep("demo")).rejects.toThrow("only one");
    await step(store, "two", 2, "Invalid");
    await expect(observed.activateStep("demo")).rejects.toThrow("status must be");
    expect(writes).toBe(0);
  });
  test("serializes concurrent status updates without dropping authored fields", async () => {
    const store = await setup();
    const before = await readFile(store.indexPath("demo"), "utf8");
    await Promise.all([store.updateIndex("demo", { status: "Pending" }), store.updateIndex("demo", { status: "In Progress" })]);
    expect(await readFile(store.indexPath("demo"), "utf8")).toBe(before.replace("status: Pending", "status: In Progress"));
    await expect(store.updateIndex("demo", { iteration: 9 })).rejects.toThrow("immutable");
  });
});