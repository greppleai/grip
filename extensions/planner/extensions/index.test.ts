import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { withFileMutationQueue } from "@greppleai/grip";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@greppleai/grip";
import { Check } from "typebox/value";
import registerPlanner from "./index.ts";
import { PlanStore, serializeMarkdown, parseMarkdown } from "./plan-store.ts";
import { buildPrompt, shouldCompact } from "./prompts.ts";
import { createLoopState, parseBuildArgs } from "./loop-state.ts";

const directories: string[] = [];
// Keep legacy lifecycle fixtures flat. New directory lifecycle has separate tests.
async function prepareFlatStep(store: PlanStore, id: string, order: number) {
  const path = join(store.directory("demo"), `STEP-${String(order).padStart(4, "0")}-${id}.md`);
  const content = serializeMarkdown({ metadata: { name: id, order, description: "", status: "Pending" }, body: "\n<!-- Write the step content here. -->\n" });
  await writeFile(path, content);
  return { path, content };
}
async function setup(percent = 10, hasUI = true) {
  const cwd = await mkdtemp(join(tmpdir(), "planner-loop-")); directories.push(cwd);
  const operations = { cwd, mkdir: async (p: string, opts?: { recursive?: boolean }) => { await mkdir(p, opts); }, readFile, writeFile: async (p: string, content: string | Buffer) => { await writeFile(p, content); }, readdir: async (p: string) => readdir(p), stat };
  const store = new PlanStore(cwd, operations);
  await store.preparePlan("demo", "Demo");
  await writeFile(store.indexPath("demo"), serializeMarkdown({ metadata: { name: "Demo", description: "Build it", status: "Pending" }, body: "\n# Demo\n\nBuild it\n" }));
  const stepPath = join(store.directory("demo"), "STEP-0001-first.md");
  async function step(status = "Pending", body = "\nSaved progress\n") {
    await writeFile(stepPath, serializeMarkdown({ metadata: { name: "First", order: 1, description: "Do work", status }, body }));
  }
  // Fixture remains a legacy flat plan; preparation tests exercise the new layout separately.
  await step("Pending", "\nWork\n");
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: string[] = [];
  const notices: string[] = [];
  const entries: any[] = [];
  const compactions: any[] = [];
  let pending = false;
  let idle = false;
  const api = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerTool: (def: any) => tools.set(def.name, def),
    on: (event: string, handler: any) => events.set(event, handler),
    sendUserMessage: (text: string) => messages.push(text),
    sendMessage: (message: any) => notices.push(message.content),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, toolOperations: operations, hasUI,
    ui: { notify: (text: string) => notices.push(text), setStatus() {} },
    getContextUsage: () => ({ percent }),
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    compact: (request: unknown) => compactions.push(request),
    session: { getBranch: () => entries },
  } as unknown as ExtensionContext;
  registerPlanner(api);
  const call = (name: string, params = {}) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  const command = (args: string) => commands.get("planner").handler(args, ctx);
  async function flush() { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5)); }
  return { api, ctx, store, step, messages, notices, entries, events, compactions, tools, commands, call, command, flush, setPercent: (v: number) => { percent = v; }, setPending: (v: boolean) => { pending = v; }, setIdle: (v: boolean) => { idle = v; } };
}

test("preparation and delivery use the backend cwd rather than the host session cwd", async () => {
  const f = await setup();
  const backendCwd = "/workspace";
  const local = f.ctx.toolOperations;
  const calls: string[] = [];
  function mapped(path: string): string {
    calls.push(path);
    if (!path.startsWith(`${backendCwd}/`)) throw new Error(`Path escapes the daemon workspace and allowed temporary root: ${path}`);
    return join(f.ctx.cwd, path.slice(backendCwd.length + 1));
  }
  // Model Lima's mounted workspace without a VM: only backend-namespace paths
  // are accepted, and every operation is forwarded to the simulated mount.
  f.ctx.toolOperations = {
    ...local, cwd: backendCwd,
    readFile: (path) => local.readFile(mapped(path)),
    writeFile: (path, content) => local.writeFile(mapped(path), content),
    mkdir: (path, options) => local.mkdir(mapped(path), options),
    readdir: (path) => local.readdir(mapped(path)),
    stat: (path) => local.stat(mapped(path)),
  };
  if (Bun.which("grepple")) (f.ctx as any).execToolBackend = async (command: string, options: { cwd: string }) => {
    expect(options.cwd).toBe(backendCwd);
    expect(command).toContain(`${backendCwd}/.planner/`);
    expect(command).not.toContain(f.ctx.cwd);
    const spec = command.match(/--at '([^']+)'$/)?.[1];
    expect(spec).toBeDefined();
    const hostSpec = spec!.replace(`${backendCwd}/`, `${f.ctx.cwd}/`);
    const proc = Bun.spawn(["grepple", "--no-spill", "--line-only", "--repeat-source", "--at", hostSpec], { cwd: f.ctx.cwd, stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { output, exitCode: await proc.exited, cancelled: false, truncated: false };
  };
  const remoteRoot = `${backendCwd}/.planner/sandbox`;
  const documents = [
    ["planner_prepare", { planName: "sandbox" }, "INDEX.md"],
    ["planner_step_prepare", { planName: "sandbox", stepName: "first", order: 1 }, "STEP-0001/INDEX.md"],
    ["planner_step_prepare", { planName: "sandbox", stepName: "second", order: 2 }, "STEP-0002/INDEX.md"],
    ["planner_handoff_prepare", { planName: "sandbox", fromStep: "0001", toStep: "0002" }, "STEP-0001/HANDOFF-0001.md"],
  ] as const;
  for (const [tool, params, filename] of documents) {
    const response = await f.call(tool, params);
    const text = response.content[0].text;
    expect(text).toContain(JSON.stringify(`${remoteRoot}/${filename}`));
    expect(text).toContain(await readFile(join(f.store.directory("sandbox"), filename), "utf8"));
    if (Bun.which("grepple")) expect(text).toContain("Fresh Grepple anchors");
  }
  expect(f.messages).toEqual([]);
  await f.command("prepare command-plan");
  expect(f.notices.at(-1)).toContain(`${backendCwd}/.planner/command-plan/INDEX.md`);
  expect((await f.store.load("command-plan")).status).toBe("Pending");

  const planPath = `${remoteRoot}/INDEX.md`;
  const firstIndexPath = `${remoteRoot}/STEP-0001/INDEX.md`;
  const secondIndexPath = `${remoteRoot}/STEP-0002/INDEX.md`;
  for (const path of [planPath, firstIndexPath, secondIndexPath]) {
    const original = (await f.ctx.toolOperations.readFile(path)).toString("utf8");
    await f.ctx.toolOperations.writeFile(path, original.replace("status: Pending", "status: Pending # preserved")
      .replace("<!-- Write the plan content here. -->", "# Authored plan goals")
      .replace("<!-- Write the step content here. -->", "# Authored step instructions")
      .replace("description: \"\"", "description: \"\"\nextra: { preserve: yes }"));
  }
  const firstIndexBefore = (await f.ctx.toolOperations.readFile(firstIndexPath)).toString("utf8");
  const secondIndexBefore = (await f.ctx.toolOperations.readFile(secondIndexPath)).toString("utf8");
  const beforeStartup = await readFile(f.store.indexPath("sandbox"), "utf8");
  f.setPercent(40);
  await f.call("planner_start", { planName: "sandbox" });
  expect(f.compactions).toHaveLength(1);
  expect(f.messages).toEqual([]);
  expect(await readFile(f.store.indexPath("sandbox"), "utf8")).toBe(beforeStartup);
  expect((await f.store.load("sandbox")).steps.map((step) => step.status)).toEqual(["Pending", "Pending"]);
  expect(f.compactions[0].customInstructions).toContain(`${remoteRoot}/INDEX.md`);
  expect(f.compactions[0].customInstructions).not.toContain(f.ctx.cwd);
  f.compactions[0].onComplete(); f.compactions[0].onComplete(); await f.flush();
  expect(f.messages).toHaveLength(1);
  f.setPercent(10);
  expect((await f.store.load("sandbox")).steps.map((step) => step.status)).toEqual(["In Progress", "Pending"]);
  expect(f.messages[0]).toContain(`${remoteRoot}/STEP-0001/INDEX.md`);
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  const progress = await f.call("planner_progress_prepare", { planName: "sandbox", stepId: "0001" });
  expect(progress.content[0].text).toContain(`${remoteRoot}/STEP-0001/PROGRESS-0001.md`);
  const path = `${remoteRoot}/STEP-0001/PROGRESS-0001.md`;
  const doc = parseMarkdown((await f.ctx.toolOperations.readFile(path)).toString("utf8"), path);
  await f.ctx.toolOperations.writeFile(path, serializeMarkdown({ ...doc, body: "\nSaved sandbox progress.\n" }));
  const later = await f.call("planner_progress_prepare", { planName: "sandbox", stepId: "0001" });
  const laterPath = `${remoteRoot}/STEP-0001/PROGRESS-0002.md`;
  expect(later.content[0].text).toContain(laterPath);
  const laterDoc = parseMarkdown((await f.ctx.toolOperations.readFile(laterPath)).toString("utf8"), laterPath);
  await f.ctx.toolOperations.writeFile(laterPath, serializeMarkdown({ ...laterDoc, metadata: { ...laterDoc.metadata, note: "second" }, body: "\nValidated a second progress update.\n" }));
  await f.store.updateStepStatus("sandbox", "0001", "Completed");
  const handoff = `${remoteRoot}/STEP-0001/HANDOFF-0001.md`;
  const handoffDoc = parseMarkdown((await f.ctx.toolOperations.readFile(handoff)).toString("utf8"), handoff);
  await f.ctx.toolOperations.writeFile(handoff, serializeMarkdown({ ...handoffDoc, body: "\nUse the verified approach.\n" }));
  await f.call("planner_done");
  expect((await f.store.load("sandbox")).steps.map((step) => step.status)).toEqual(["Completed", "In Progress"]);
  expect(f.messages[1]).toContain(`${remoteRoot}/STEP-0002/INDEX.md`);
  expect(f.messages[1]).toContain(`${remoteRoot}/STEP-0001/HANDOFF-0001.md`);
  f.setIdle(true); await f.command("stop");
  const beforeResume = await readFile(f.store.indexPath("sandbox"), "utf8");
  f.setPercent(60);
  await f.command("resume sandbox");
  expect(f.compactions).toHaveLength(2);
  expect(f.messages).toHaveLength(2);
  expect(await readFile(f.store.indexPath("sandbox"), "utf8")).toBe(beforeResume);
  expect(f.compactions[1].customInstructions).toContain(`${remoteRoot}/INDEX.md`);
  expect(f.compactions[1].customInstructions).not.toContain(f.ctx.cwd);
  f.compactions[1].onComplete(); f.compactions[1].onComplete(); await f.flush();
  expect(f.messages).toHaveLength(3);
  expect(f.messages[2]).toContain(`${remoteRoot}/STEP-0002/INDEX.md`);
  expect(f.messages[2]).toContain(`${remoteRoot}/STEP-0001/HANDOFF-0001.md`);
  expect((await f.store.readRuntime("sandbox"))?.loop.iteration).toBe(3);
  expect((await f.store.load("sandbox")).metadata.iteration).toBeUndefined();
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  const secondPrepared = await f.call("planner_progress_prepare", { planName: "sandbox", stepId: "0002" });
  expect(secondPrepared.content[0].text).toContain(`${remoteRoot}/STEP-0002/PROGRESS-0001.md`);
  const secondPath = `${remoteRoot}/STEP-0002/PROGRESS-0001.md`;
  const secondDoc = parseMarkdown((await f.ctx.toolOperations.readFile(secondPath)).toString("utf8"), secondPath);
  await f.ctx.toolOperations.writeFile(secondPath, serializeMarkdown({ ...secondDoc, body: "\nFinished remotely.\n" }));
  await f.store.updateStepStatus("sandbox", "0002", "Completed");
  await f.call("planner_done");
  const finished = await f.store.load("sandbox");
  expect(finished.status).toBe("Completed");
  expect(finished.steps[0].metadata.extra).toEqual({ preserve: "yes" });
  expect(finished.steps[1].progress[0].body).toBe("\nFinished remotely.\n");
  expect(finished.steps[0].progress.map((p) => p.sequence)).toEqual([1, 2]);
  expect(finished.steps[0].progress[1].metadata.note).toBe("second");
  expect(finished.steps[0].progress[1].body).toBe("\nValidated a second progress update.\n");
  expect(finished.steps[1].metadata.extra).toEqual({ preserve: "yes" });
  expect(await readFile(f.store.indexPath("sandbox"), "utf8")).toBe(beforeStartup.replace("status: Pending", "status: Completed"));
  expect((await f.ctx.toolOperations.readFile(firstIndexPath)).toString("utf8")).toBe(firstIndexBefore.replace("status: Pending", "status: Completed"));
  expect((await f.ctx.toolOperations.readFile(secondIndexPath)).toString("utf8")).toBe(secondIndexBefore.replace("status: Pending", "status: Completed"));
  expect(finished.handoffs[0].metadata).toEqual({ from_step: "0001", from_order: 1, to_step: "0002", to_order: 2 });
  expect(f.compactions).toHaveLength(2); expect(f.messages).toHaveLength(3);
  await f.command("list");
  expect(f.notices.at(-1)).toContain("sandbox");
  for (const prompt of f.messages) expect(prompt).not.toContain(f.ctx.cwd);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((filePath) => filePath.startsWith(`${backendCwd}/.planner`))).toBe(true);
});

test("prepared scaffolds expose fresh backend Grepple anchors for immediate edits", async () => {
  if (!Bun.which("grepple")) return; // Optional runtime dependency; failure-path tests run without it.
  const f = await setup();
  (f.ctx as any).execToolBackend = async (command: string, options: { cwd: string }) => {
    const proc = Bun.spawn(["sh", "-c", command], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { output, exitCode: await proc.exited, cancelled: false, truncated: false };
  };
  const plan = await f.call("planner_prepare", { planName: "anchors" });
  const step = await f.call("planner_step_prepare", { planName: "anchors", stepName: "first", order: 1 });
  await f.call("planner_step_prepare", { planName: "anchors", stepName: "second", order: 2 });
  const progress = await f.call("planner_progress_prepare", { planName: "anchors", stepId: "0001" });
  const handoff = await f.call("planner_handoff_prepare", { planName: "anchors", fromStep: "0001", toStep: "0002" });
  for (const response of [plan, step, progress, handoff]) {
    const text = response.content[0].text;
    expect(text).toContain("Fresh Grepple anchors");
    expect(text).toMatch(/[^│\n]{3}│1│---/);
    expect(text).not.toContain("Grepple anchors unavailable");
  }
  const anchor = plan.content[0].text.match(/^([^│\n]{3})│\d+│<!-- Write the plan content here\. -->$/m)?.[1];
  expect(anchor).toBeDefined();
  const edit = Bun.spawn(["grepple", "--no-repo-config", "write", "--root", f.ctx.cwd, "--dry-run"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  edit.stdin.write(`::grepple file .planner/anchors/INDEX.md\n::grepple replace ${anchor} ${anchor}\n# Authored goal\n::grepple end\n`);
  edit.stdin.end();
  const editOutput = (await new Response(edit.stdout).text()) + (await new Response(edit.stderr).text());
  expect(await edit.exited).toBe(0);
  expect(editOutput).toContain("+# Authored goal");
  expect(await readFile(f.store.indexPath("anchors"), "utf8")).toContain("<!-- Write the plan content here. -->");
  await f.command("prepare command-anchors");
  expect(f.notices.at(-1)).toContain("Fresh Grepple anchors");
});

test("prepare anchor fallback preserves scaffold after backend failures and invalid reads", async () => {
  const f = await setup();
  const cases = [
    { exitCode: 127, output: "grepple: not found", cancelled: false, truncated: false },
    { exitCode: 1, output: "permission denied", cancelled: false, truncated: false },
    { exitCode: 0, output: "bad│1│---", cancelled: false, truncated: true },
    { exitCode: 0, output: "wrong/path\n\nAb3│1│---", cancelled: false, truncated: false },
    { exitCode: 0, output: "", cancelled: true, truncated: false },
  ];
  for (const [index, response] of cases.entries()) {
    const name = `failure-${index}`;
    const path = f.store.indexPath(name);
    let executed = false;
    (f.ctx as any).execToolBackend = async (command: string, options: { cwd: string; timeout: number }) => {
      executed = true;
      expect(options.cwd).toBe(f.ctx.cwd);
      expect(options.timeout).toBe(5);
      expect(command).toContain(path);
      expect(await readFile(path, "utf8")).toContain("Write the plan content here");
      return response;
    };
    const text = (await f.call("planner_prepare", { planName: name })).content[0].text;
    expect(executed).toBe(true);
    expect(text).toContain(JSON.stringify(path));
    expect(text).toContain(await readFile(path, "utf8"));
    expect(text).toContain("Grepple anchors unavailable");
    expect(text).not.toContain("Fresh Grepple anchors");
  }
  (f.ctx as any).execToolBackend = async () => { throw new Error("offline backend"); };
  const offline = (await f.call("planner_prepare", { planName: "offline" })).content[0].text;
  expect(offline).toContain("Grepple anchors unavailable");
  expect(offline).toContain(await readFile(f.store.indexPath("offline"), "utf8"));
});

test("prepare uses backend paths with shell punctuation and concurrent files", async () => {
  if (!Bun.which("grepple")) return;
  const f = await setup();
  const backendCwd = join(f.ctx.cwd, "a'b [workspace]");
  await mkdir(backendCwd);
  f.ctx.toolOperations.cwd = backendCwd;
  const seen: string[] = [];
  (f.ctx as any).execToolBackend = async (command: string, options: { cwd: string }) => {
    expect(options.cwd).toBe(backendCwd);
    seen.push(command);
    const proc = Bun.spawn(["sh", "-c", command], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { output, exitCode: await proc.exited, cancelled: false, truncated: false };
  };
  const results = await Promise.all(["one", "two"].map((name) => f.call("planner_prepare", { planName: name })));
  for (const [i, response] of results.entries()) {
    const path = join(backendCwd, ".planner", ["one", "two"][i], "INDEX.md");
    expect(response.content[0].text).toContain(JSON.stringify(path));
    expect(response.content[0].text).toContain("Fresh Grepple anchors");
    expect(response.content[0].text).toContain(await readFile(path, "utf8"));
  }
  expect(seen).toHaveLength(2);
  expect(seen.every((command) => command.includes("'\\''"))).toBe(true);
});

test("preparation tools return the exact scaffold without starting or scheduling work", async () => {
  const f = await setup();
  const demoBefore = await readFile(f.store.indexPath("demo"), "utf8");
  async function prepare(tool: string, params: Record<string, unknown>, path: string) {
    const response = await f.call(tool, params);
    const text = response.content[0].text;
    expect(text).toContain(JSON.stringify(path));
    expect(text).toContain("next round");
    expect(text).toContain(await readFile(path, "utf8"));
    return text;
  }
  const planAdvice = await prepare("planner_prepare", { planName: "prepared", name: "Prepared plan" }, f.store.indexPath("prepared"));
  expect(planAdvice).toContain("plan INDEX high level");
  const stepAdvice = await prepare("planner_step_prepare", { planName: "prepared", stepName: "source", order: 4, name: "Source step" }, join(f.store.directory("prepared"), "STEP-0004", "INDEX.md"));
  expect(stepAdvice).toContain("work, limits and checks in plain language");
  await prepare("planner_step_prepare", { planName: "prepared", stepName: "target", order: 9 }, join(f.store.directory("prepared"), "STEP-0009", "INDEX.md"));
  const progressAdvice = await prepare("planner_progress_prepare", { planName: "prepared", stepId: "0004" }, join(f.store.directory("prepared"), "STEP-0004", "PROGRESS-0001.md"));
  expect(progressAdvice).toContain("changes and paths, checks and results");
  const handoffAdvice = await prepare("planner_handoff_prepare", { planName: "prepared", fromStep: "0004", toStep: "0009" }, join(f.store.directory("prepared"), "STEP-0004", "HANDOFF-0004.md"));
  expect(handoffAdvice).toContain("what the next step needs");
  await prepare("planner_handoff_prepare", { planName: "prepared", fromStep: "0004", toStep: "0009", handoffName: "source-extra" }, join(f.store.directory("prepared"), "STEP-0004", "HANDOFF-source-extra.md"));
  const plan = await f.store.load("prepared");
  expect(plan.name).toBe("Prepared plan");
  expect(plan.description).toBe("");
  expect(plan.status).toBe("Pending");
  expect(plan.steps.map((step) => [step.name, step.order, step.description, step.status])).toEqual([
    ["Source step", 4, "", "Pending"], ["target", 9, "", "Pending"],
  ]);
  expect(plan.handoffs.map((handoff) => [handoff.fromOrder, handoff.toOrder])).toEqual([[4, 9], [4, 9]]);
  expect(await readFile(f.store.indexPath("demo"), "utf8")).toBe(demoBefore);
  expect(f.messages).toEqual([]);
  expect(f.entries).toEqual([]);
  expect(f.compactions).toEqual([]);
  await f.command("status");
  expect(f.notices.at(-1)).toBe("No active planner loop.");
});

test("preparation schemas accept metadata only and reject description/body inputs", async () => {
  const f = await setup();
  const examples = [
    ["planner_prepare", { planName: "new" }],
    ["planner_step_prepare", { planName: "demo", stepName: "second", order: 2 }],
    ["planner_handoff_prepare", { planName: "demo", fromStep: "0001-first", toStep: "0001-first" }],
  ] as const;
  for (const [tool, params] of examples) {
    const definition = f.tools.get(tool);
    expect(Check(definition.parameters, params)).toBe(true);
    expect(definition.promptSnippet).toContain("next round");
    for (const key of ["description", "body", "content"]) expect(Check(definition.parameters, { ...params, [key]: "Text" })).toBe(false);
  }
  expect(Check(f.tools.get("planner_step_prepare").parameters, { planName: "demo", stepName: "bad", order: 0 })).toBe(false);
  expect(Check(f.tools.get("planner_step_prepare").parameters, { planName: "demo", stepName: "bad", order: 1.5 })).toBe(false);
});

test("prepare command displays the scaffold in UI and headless modes without an agent turn", async () => {
  for (const hasUI of [true, false]) {
    const f = await setup(10, hasUI);
    const command = f.commands.get("planner");
    expect(command.description).toContain("prepare");
    expect(command.description).not.toContain("create");
    expect(command.getArgumentCompletions("").map((item: { value: string }) => item.value)).toEqual(["prepare", "build", "resume", "stop", "status", "list", "cancel"]);
    await f.command("prepare command-plan");
    const path = f.store.indexPath("command-plan");
    const notice = f.notices.at(-1)!;
    expect(notice).toContain(JSON.stringify(path));
    expect(notice).toContain(await readFile(path, "utf8"));
    expect(f.messages).toEqual([]);
    expect(f.entries).toEqual([]);
    expect((await f.store.load("command-plan")).status).toBe("Pending");
  }
});

test("prepare command rejects extra content and removed create command only shows help", async () => {
  const f = await setup();
  await f.command("prepare");
  expect(f.notices.at(-1)).toBe("Usage: /planner prepare <plan-name>");
  await f.command("prepare extra description");
  expect(f.notices.at(-1)).toBe("Usage: /planner prepare <plan-name>");
  await f.command("create old-plan");
  expect(f.notices.at(-1)).toContain("/planner prepare <plan-name>");
  expect(f.notices.at(-1)).not.toContain("/planner create");
  expect((await f.store.list()).map((plan) => plan.id)).toEqual(["demo"]);
  expect(f.messages).toEqual([]);
});

test("preparation tool and command errors preserve existing documents", async () => {
  const f = await setup();
  const before = await readFile(f.store.indexPath("demo"), "utf8");
  await expect(f.call("planner_prepare", { planName: "demo" })).rejects.toThrow();
  await expect(f.call("planner_step_prepare", { planName: "demo", stepName: "second", order: 1 })).rejects.toThrow("already exists");
  await expect(f.call("planner_handoff_prepare", { planName: "demo", fromStep: "0001-first", toStep: "missing" })).rejects.toThrow("must exist");
  await f.command("prepare demo");
  expect(f.notices.at(-1)).not.toContain("Prepared");
  expect(await readFile(f.store.indexPath("demo"), "utf8")).toBe(before);
  expect(f.messages).toEqual([]);
  expect(f.entries).toEqual([]);
});

test("prepared documents can be authored, built, handed off and completed", async () => {
  const f = await setup();
  await f.call("planner_prepare", { planName: "workflow" });
  await expect(f.call("planner_start", { planName: "workflow" })).rejects.toThrow("Add STEP");
  await f.call("planner_step_prepare", { planName: "workflow", stepName: "investigate", order: 1 });
  await f.call("planner_step_prepare", { planName: "workflow", stepName: "implement", order: 2 });
  await f.call("planner_handoff_prepare", { planName: "workflow", fromStep: "0001", toStep: "0002" });
  expect(f.messages).toEqual([]);
  expect(f.entries).toEqual([]);

  async function author(path: string, metadata: Record<string, unknown>, body: string) {
    const document = await f.store.read(path);
    await writeFile(path, serializeMarkdown({ ...document, metadata: { ...document.metadata, ...metadata }, body }));
  }
  const index = f.store.indexPath("workflow");
  const directory = f.store.directory("workflow");
  const investigate = join(directory, "STEP-0001", "INDEX.md");
  const implement = join(directory, "STEP-0002", "INDEX.md");
  const handoff = join(directory, "STEP-0001", "HANDOFF-0001.md");
  await author(index, { name: "Authored workflow", description: "Validate prepare then author" }, "\n# Goal\n\nImplement the validated approach.\n");
  await author(investigate, { description: "Choose the approach" }, "\nInspect the source and record findings.\n");
  await author(implement, { description: "Implement and validate" }, "\nApply the findings and run tests.\n");

  await f.call("planner_start", { planName: "workflow" });
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0]).toContain(investigate);
  expect((await f.store.load("workflow")).status).toBe("In Progress");
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  await f.call("planner_progress_prepare", { planName: "workflow", stepId: "0001" });
  await author(join(directory, "STEP-0001", "PROGRESS-0001.md"), {}, "\nInspected the source; the existing API is suitable.\n");
  await f.store.updateStepStatus("workflow", "0001", "Completed");
  await author(handoff, {}, "\nReuse the existing API and verify regressions.\n");
  await f.call("planner_done");
  expect(f.messages).toHaveLength(2);
  expect(f.messages[1]).toContain(implement);
  expect(f.messages[1]).toContain(handoff);
  await f.call("planner_progress_prepare", { planName: "workflow", stepId: "0002" });
  await author(join(directory, "STEP-0002", "PROGRESS-0001.md"), {}, "\nImplemented the approach; regression tests pass.\n");
  await f.store.updateStepStatus("workflow", "0002", "Completed");
  const response = await f.call("planner_done");
  expect(response.content[0].text).toBe("Plan completed. No next iteration.");
  const plan = await f.store.load("workflow");
  expect(plan.status).toBe("Completed");
  expect(plan.steps.map((step) => step.status)).toEqual(["Completed", "Completed"]);
  expect(plan.description).toBe("Validate prepare then author");
  expect(plan.body).toBe("\n# Goal\n\nImplement the validated approach.\n");
  expect(plan.handoffs[0].body).toBe("\nReuse the existing API and verify regressions.\n");
  expect(f.messages).toHaveLength(2);
});

test("build and resume activate the selected step before delivering its prompt", async () => {
  const f = await setup();
  const path = join(f.store.directory("demo"), "STEP-0001-first.md");
  const deliveredStatuses: unknown[] = [];
  f.api.sendUserMessage = (text) => {
    deliveredStatuses.push(parseMarkdown(readFileSync(path, "utf8"), path).metadata.status);
    f.messages.push(String(text));
  };
  await f.call("planner_start", { planName: "demo" });
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  f.setIdle(true); await f.command("stop");
  await f.step("Pending", "\nResume this work.\n");
  await f.command("resume demo");
  expect(deliveredStatuses).toEqual(["In Progress", "In Progress"]);
  expect(f.messages[1]).toContain(path);
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
});

test("completing or skipping a step activates the next step and resets the progress baseline", async () => {
  for (const terminal of ["Completed", "Skipped"]) {
    const f = await setup();
    await prepareFlatStep(f.store, "second", 2);
    const path = join(f.store.directory("demo"), "STEP-0002-second.md");
    await f.call("planner_start", { planName: "demo" });
    f.api.sendUserMessage = (text) => {
      expect(parseMarkdown(readFileSync(path, "utf8"), path).metadata.status).toBe("In Progress");
      f.messages.push(String(text));
    };
    await f.step(terminal);
    await f.call("planner_done");
    expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual([terminal, "In Progress"]);
    expect(f.messages[1]).toContain(path);
    await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  }
});

test("pending messages and iteration limits suppress next-step activation", async () => {
  for (const suppression of ["pending", "limit"]) {
    const f = await setup();
    await prepareFlatStep(f.store, "second", 2);
    await f.call("planner_start", { planName: "demo", maxIterations: suppression === "limit" ? 1 : 50 });
    await f.step("Completed");
    if (suppression === "pending") f.setPending(true);
    await f.call("planner_done");
    expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual(["Completed", "Pending"]);
    expect(f.messages).toHaveLength(1);
  }
  const f = await setup();
  f.setPending(true);
  await expect(f.call("planner_start", { planName: "demo" })).rejects.toThrow("Pending messages");
  expect((await f.store.load("demo")).steps[0].status).toBe("Pending");
  expect(f.messages).toEqual([]);
});

test("compaction success and failure activate the next step exactly once on delivery", async () => {
  for (const outcome of ["success", "failure"]) {
    const f = await setup();
    await prepareFlatStep(f.store, "second", 2);
    await f.call("planner_start", { planName: "demo" });
    f.setPercent(60);
    await f.step("Completed");
    await f.call("planner_done");
    expect((await f.store.load("demo")).steps[1].status).toBe("Pending");
    const originalWrite = f.ctx.toolOperations.writeFile;
    let activations = 0;
    f.ctx.toolOperations.writeFile = async (path, content) => {
      if (path.endsWith("STEP-0002-second.md")) activations++;
      await originalWrite(path, content);
    };
    if (outcome === "success") f.compactions[0].onComplete();
    else f.compactions[0].onError(new Error("failure"));
    f.compactions[0].onComplete();
    await f.flush();
    expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual(["Completed", "In Progress"]);
    expect(activations).toBe(1);
    expect(f.messages).toHaveLength(2);
    await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  }
});

test("stop, cancel or pending messages while activation is queued prevent mutation and delivery", async () => {
  for (const phase of ["start", "advance"]) {
    for (const action of ["stop", "cancel", "pending"]) {
      const f = await setup();
      const filename = phase === "start" ? "STEP-0001-first.md" : "STEP-0002-second.md";
      const path = join(f.store.directory("demo"), filename);
      if (phase === "advance") {
        await prepareFlatStep(f.store, "second", 2);
        await f.call("planner_start", { planName: "demo" });
        await f.step("Completed");
      }
      let entered!: () => void;
      let release!: () => void;
      let sampled!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { sampled = resolve; });
      const blocker = withFileMutationQueue(path, async () => { entered(); await hold; });
      await inside;
      const originalRead = f.ctx.toolOperations.readFile;
      let reads = 0;
      f.ctx.toolOperations.readFile = async (filePath) => {
        const content = await originalRead(filePath);
        if (filePath === path && ++reads === (phase === "start" ? 2 : 3)) sampled();
        return content;
      };
      const attempt = f.call(phase === "start" ? "planner_start" : "planner_done", phase === "start" ? { planName: "demo" } : {}).then(() => null, (error) => error);
      let cancellation: Promise<unknown> | undefined;
      try {
        await ready;
        if (action === "pending") f.setPending(true);
        else if (action === "cancel") cancellation = f.command("cancel demo");
        else { f.setIdle(true); await f.command("stop"); }
      } finally { release(); }
      await blocker;
      await attempt;
      await cancellation;
      expect(parseMarkdown(await readFile(path, "utf8"), path).metadata.status).toBe("Pending");
      expect(f.messages).toHaveLength(phase === "start" ? 0 : 1);
      if (action === "cancel") expect((await f.store.load("demo")).status).toBe("Skipped");
    }
  }
});

test("activation failures do not deliver prompts and failed continuations pause the loop", async () => {
  for (const phase of ["start", "advance"]) {
    const f = await setup();
    const path = join(f.store.directory("demo"), phase === "start" ? "STEP-0001-first.md" : "STEP-0002-second.md");
    if (phase === "advance") {
      await prepareFlatStep(f.store, "second", 2);
      await f.call("planner_start", { planName: "demo" });
      await f.step("Completed");
    }
    const originalWrite = f.ctx.toolOperations.writeFile;
    f.ctx.toolOperations.writeFile = async (filePath, content) => {
      if (filePath === path) throw new Error("Activation write refused");
      await originalWrite(filePath, content);
    };
    await expect(f.call(phase === "start" ? "planner_start" : "planner_done", phase === "start" ? { planName: "demo" } : {})).rejects.toThrow("Activation write refused");
    expect(parseMarkdown(await readFile(path, "utf8"), path).metadata.status).toBe("Pending");
    expect(f.messages).toHaveLength(phase === "start" ? 0 : 1);
    await f.command("status");
    expect(f.notices.at(-1)).toBe("No active planner loop.");
    f.ctx.toolOperations.writeFile = originalWrite;
    await f.call("planner_start", { planName: "demo" });
    expect((await f.store.load("demo")).steps.at(-1)?.status).toBe("In Progress");
  }
});

test("delivery retains an existing active step ahead of lower-order Pending work", async () => {
  const f = await setup();
  for (const [id, order, status] of [["second", 2, "In Progress"], ["third", 3, "Skipped"], ["fourth", 4, "Completed"]] as const) {
    const prepared = await prepareFlatStep(f.store, id, order);
    const doc = parseMarkdown(prepared.content, prepared.path);
    await writeFile(prepared.path, serializeMarkdown({ ...doc, metadata: { ...doc.metadata, status } }));
  }
  const path = join(f.store.directory("demo"), "STEP-0002-second.md");
  const original = await readFile(path, "utf8");
  const originalWrite = f.ctx.toolOperations.writeFile;
  let stepWrites = 0;
  f.ctx.toolOperations.writeFile = async (filePath, content) => {
    if (filePath.includes("STEP-")) stepWrites++;
    await originalWrite(filePath, content);
  };
  await f.call("planner_start", { planName: "demo" });
  await f.step("Pending");
  await f.call("planner_done");
  expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual(["Pending", "In Progress", "Skipped", "Completed"]);
  expect(f.messages).toHaveLength(2);
  for (const prompt of f.messages) {
    expect(prompt).toContain(path);
    expect(prompt).not.toContain("STEP-0001-first.md");
  }
  expect(stepWrites).toBe(0);
  expect(await readFile(path, "utf8")).toBe(original);
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
});

test("session recovery does not activate a Pending successor until explicit delivery", async () => {
  const f = await setup();
  await prepareFlatStep(f.store, "second", 2);
  await f.call("planner_start", { planName: "demo" });
  await f.step("Completed");
  const paths = [f.store.indexPath("demo"), join(f.store.directory("demo"), "STEP-0001-first.md"), join(f.store.directory("demo"), "STEP-0002-second.md")];
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const originalWrite = f.ctx.toolOperations.writeFile;
  let writes = 0;
  f.ctx.toolOperations.writeFile = async (path, content) => { writes++; await originalWrite(path, content); };
  await f.events.get("session_shutdown")({}, f.ctx);
  await f.events.get("session_start")({}, f.ctx);
  expect(writes).toBe(0);
  expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
  expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual(["Completed", "Pending"]);
  expect(f.messages).toHaveLength(1);
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  f.setIdle(true); await f.command("stop");
  await f.command("resume demo");
  expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual(["Completed", "In Progress"]);
  expect(f.messages).toHaveLength(2);
  expect(f.messages[1]).toContain(paths[2]);
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
});

test("stale or suppressed compaction callbacks leave a Pending successor untouched", async () => {
  for (const action of ["stop", "cancel", "reload", "pending"]) {
    const f = await setup();
    await prepareFlatStep(f.store, "second", 2);
    await f.call("planner_start", { planName: "demo" });
    f.setPercent(60);
    await f.step("Completed");
    await f.call("planner_done");
    expect(f.compactions).toHaveLength(1);
    const path = join(f.store.directory("demo"), "STEP-0002-second.md");
    const before = await readFile(path, "utf8");
    if (action === "pending") f.setPending(true);
    else if (action === "reload") {
      await f.events.get("session_shutdown")({}, f.ctx);
      await f.events.get("session_start")({}, f.ctx);
    } else { f.setIdle(true); await f.command(action === "cancel" ? "cancel demo" : "stop"); }
    f.compactions[0].onComplete();
    f.compactions[0].onError(new Error("late failure"));
    await f.flush();
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual(["Completed", "Pending"]);
    expect(f.messages).toHaveLength(1);
  }
});

test("stop during the checkpoint's first read cannot continue or overwrite a replacement loop", async () => {
  for (const replacement of [false, true]) {
    const f = await setup();
    await prepareFlatStep(f.store, "second", 2);
    await f.call("planner_start", { planName: "demo" });
    await f.step("Completed");
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const originalRead = f.ctx.toolOperations.readFile;
    let held = false;
    f.ctx.toolOperations.readFile = async (path) => {
      const content = await originalRead(path);
      if (!held && path === f.store.indexPath("demo")) { held = true; entered(); await hold; }
      return content;
    };
    const checkpoint = f.call("planner_done");
    try {
      await ready;
      f.setIdle(true); await f.command("stop");
      if (replacement) await f.call("planner_start", { planName: "demo" });
    } finally { release(); }
    const result = await checkpoint;
    expect(result.content[0].text).toContain("Planner loop changed; no continuation delivered.");
    expect((await f.store.load("demo")).steps.map((step) => step.status)).toEqual(["Completed", replacement ? "In Progress" : "Pending"]);
    expect(f.messages).toHaveLength(replacement ? 2 : 1);
    if (replacement) await expect(f.call("planner_done")).rejects.toThrow("Save progress");
    else await expect(f.call("planner_done")).rejects.toThrow("No active planner loop");
  }
});

test("command/tool surface is planner-only and no snapshot system hook", async () => {
  const f = await setup();
  expect([...f.tools.keys()]).toEqual(["planner_prepare", "planner_step_prepare", "planner_progress_prepare", "planner_handoff_prepare", "planner_start", "planner_done"]);
  expect(f.events.has("before_agent_start")).toBe(false);
  await f.command("build demo");
  expect(f.messages[0]).toContain("STEP-0001-first.md");
  expect((await f.store.load("demo")).status).toBe("In Progress");
});
test("done requires saved progress; queues one continuation", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" });
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  await f.step("In Progress", "\nImplemented part one; tests next.\n");
  await f.call("planner_done");
  expect(f.messages.length).toBe(2);
  expect((await f.store.readRuntime("demo"))?.loop.iteration).toBe(2);
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
});
test("terminal steps complete plan without another iteration", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" });
  f.setPercent(60);
  await f.step("Skipped");
  await f.call("planner_done");
  expect((await f.store.load("demo")).status).toBe("Completed");
  expect(f.compactions.length).toBe(0);
  expect(f.messages.length).toBe(1);
  await expect(f.call("planner_done")).rejects.toThrow("No active");
});
test("completion marker cannot close open steps", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" });
  const event = { messages: [{ role: "assistant", content: [{ type: "text", text: "PLANNER_COMPLETE" }] }] };
  await f.events.get("agent_end")(event, f.ctx);
  expect((await f.store.load("demo")).status).toBe("In Progress");
  await f.step("Completed");
  await f.events.get("agent_end")(event, f.ctx);
  expect((await f.store.load("demo")).status).toBe("Completed");
});
test("40% compaction continues once on success and ignores duplicate done/callback", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" });
  f.setPercent(40);
  await f.step("In Progress");
  await f.call("planner_done");
  expect(f.compactions.length).toBe(1);
  expect(f.messages.length).toBe(1);
  await f.call("planner_done");
  f.compactions[0].onComplete(); f.compactions[0].onComplete();
  await f.flush();
  expect(f.messages.length).toBe(2);
  expect((await f.store.readRuntime("demo"))?.loop.iteration).toBe(2);
});

test("planner_done reprompts with the current step after ordinary or compacted continuation", async () => {
  for (const mode of ["ordinary", "compact-success", "compact-failure"]) {
    const f = await setup();
    const index = await f.store.preparePlan("current");
    await writeFile(index.path, index.content.replace("<!-- Write the plan content here. -->", "Goal: deliver the current plan."));
    const first = await f.store.prepareStep("current", "first", 1);
    const second = await f.store.prepareStep("current", "second", 2);
    await writeFile(first.path, first.content.replace("<!-- Write the step content here. -->", "First: investigate."));
    await writeFile(second.path, second.content.replace("<!-- Write the step content here. -->", "Second: verify delivery."));
    await f.call("planner_start", { planName: "current" });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toContain("First: investigate.");
    const firstProgress = await f.store.prepareProgress("current", "0001");
    await writeFile(firstProgress.path, firstProgress.content.replace("<!-- Write the progress context here. -->", "Investigation finished."));
    await f.store.updateStepStatus("current", "0001", "Completed");
    if (mode !== "ordinary") f.setPercent(60);
    await f.call("planner_done");
    if (mode !== "ordinary") {
      expect(f.messages).toHaveLength(1);
      expect((await f.store.load("current")).steps[1].status).toBe("Pending");
      if (mode === "compact-success") f.compactions[0].onComplete();
      else f.compactions[0].onError(new Error("compaction unavailable"));
      f.compactions[0].onComplete();
      await f.flush();
    }
    expect(f.messages).toHaveLength(2);
    const next = f.messages[1];
    for (const text of [index.path, second.path, '**Active step ID:** `"0002"`', "Goal: deliver the current plan.", "Second: verify delivery."]) expect(next).toContain(text);
    expect(next).not.toContain("First: investigate.");
    expect(next).not.toContain("Investigation finished.");
    expect((await f.store.load("current")).steps[1].status).toBe("In Progress");
    f.setPercent(10);
    const secondProgress = await f.store.prepareProgress("current", "0002");
    await writeFile(secondProgress.path, secondProgress.content.replace("<!-- Write the progress context here. -->", "Verification passed."));
    await f.call("planner_done");
    expect(f.messages).toHaveLength(3);
    expect(f.messages[2]).toContain(secondProgress.path);
    expect(f.messages[2]).toContain("Verification passed.");
    expect(f.messages[2]).not.toContain("Investigation finished.");
  }
});
test("compaction failure falls back to continuation", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" }); await f.step("In Progress");
  f.setPercent(0.5);
  await f.call("planner_done");
  f.compactions[0].onError(new Error("failure")); await f.flush();
  expect(f.messages.length).toBe(2);
  expect(f.notices.some((s) => s.includes("continuing without"))).toBe(true);
});
test("headless busy run skips compaction and keeps follow-up workflow", async () => {
  const f = await setup(10, false);
  await f.call("planner_start", { planName: "demo" }); await f.step("In Progress");
  f.setPercent(60);
  await f.call("planner_done");
  expect(f.compactions.length).toBe(0); expect(f.messages.length).toBe(2);
});
test("stopping prevents late compaction callbacks from restarting loop", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" }); await f.step("In Progress");
  f.setPercent(60);
  await f.call("planner_done"); f.setIdle(true); await f.command("stop");
  f.compactions[0].onComplete(); await f.flush();
  expect(f.messages.length).toBe(1);
  expect((await f.store.load("demo")).status).toBe("In Progress");
});
test("max iteration limit pauses and explicit resume can increase it", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo", maxIterations: 1 }); await f.step("In Progress");
  await f.call("planner_done"); expect(f.messages.length).toBe(1);
  await f.command("resume demo --max-iterations 3");
  expect(f.messages.length).toBe(2); expect(f.messages[1]).toContain("iteration 2/3");
});
test("session reload recovers reference and local metadata, not a remote plan", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" });
  await f.events.get("session_shutdown")({}, f.ctx);
  await f.events.get("session_start")({}, f.ctx);
  await f.step("In Progress"); await f.call("planner_done");
  expect(f.messages.length).toBe(2);
});
test("pending messages do not duplicate continuation", async () => {
  const f = await setup();
  await f.call("planner_start", { planName: "demo" }); await f.step("In Progress");
  f.setPending(true); await f.call("planner_done");
  expect(f.messages.length).toBe(1);
});
test("prompts stay small with large bodies and only reference relevant handoffs", async () => {
  const f = await setup();
  await f.step("In Progress", "x".repeat(100_000));
  const plan = await f.store.load("demo");
  plan.body = "y".repeat(100_000);
  plan.handoffs = Array.from({ length: 100 }, (_, i) => ({ path: `HANDOFF-${i}.md`, body: "z".repeat(10000), metadata: {}, fromStep: "other", fromOrder: 2, toStep: i < 5 ? "0001-first" : "other", toOrder: i < 5 ? 1 : 2 }));
  const prompt = buildPrompt(createLoopState(plan), plan);
  expect(prompt.length).toBeLessThan(4500);
  expect(prompt).toContain("y".repeat(100));
  expect(prompt).toContain("x".repeat(100));
  expect(prompt).toContain("Shortened; read");
  expect(prompt).toContain("HANDOFF-4.md"); expect(prompt).not.toContain("HANDOFF-99.md");
});
test("options are strict and zero means unlimited", async () => {
  const f = await setup(); const plan = await f.store.load("demo");
  expect(createLoopState(plan, { maxIterations: 0 }).maxIterations).toBe(0);
  expect(parseBuildArgs("demo --max-iterations 0").options.maxIterations).toBe(0);
  for (const s of ["", "demo --max-iterations", "demo --bogus 1", "demo --max-iterations -1", "demo junk"]) expect(() => parseBuildArgs(s)).toThrow();
  expect(shouldCompact(39)).toBe(false); expect(shouldCompact(0.4)).toBe(true); expect(shouldCompact(null)).toBe(false);
});

test("mixed legacy and numbered plans compact, resume and complete without renaming legacy IDs", async () => {
  const f = await setup(60);
  const numberedFirst = join(f.store.directory("demo"), "STEP-0001-first.md");
  const legacyPath = join(f.store.directory("demo"), "STEP-first.md");
  await rename(numberedFirst, legacyPath);
  const second = await prepareFlatStep(f.store, "second", 2);
  const handoff = await f.store.prepareHandoff("demo", "first", "0002-second");
  const handoffDoc = await f.store.read(handoff.path);
  await writeFile(handoff.path, serializeMarkdown({ ...handoffDoc, body: "\nMixed-plan decisions\n" }));
  await f.call("planner_start", { planName: "demo" });
  expect(f.messages).toEqual([]);
  f.compactions[0].onComplete(); await f.flush();
  expect(f.messages[0]).toContain(legacyPath);
  f.setIdle(true); await f.command("stop");
  await f.command("resume demo");
  f.compactions[1].onComplete(); await f.flush();
  expect(f.messages[1]).toContain(legacyPath);
  await expect(f.call("planner_done")).rejects.toThrow("Save progress");
  const legacy = await f.store.read(legacyPath);
  await writeFile(legacyPath, serializeMarkdown({ ...legacy, metadata: { ...legacy.metadata, status: "Completed", extra: "keep legacy" }, body: "\nSaved legacy work\n" }));
  f.setPercent(10); await f.call("planner_done");
  expect(f.messages[2]).toContain(second.path);
  expect(f.messages[2]).toContain(handoff.path);
  const secondDoc = await f.store.read(second.path);
  await writeFile(second.path, serializeMarkdown({ ...secondDoc, metadata: { ...secondDoc.metadata, status: "Skipped" }, body: "\nNot needed\n" }));
  await f.call("planner_done");
  const plan = await f.store.load("demo");
  expect(plan.status).toBe("Completed");
  expect(plan.steps.map((s) => [s.id, s.status])).toEqual([["first", "Completed"], ["0002-second", "Skipped"]]);
  expect(plan.steps[0].metadata.extra).toBe("keep legacy");
  expect(plan.steps[0].body).toBe("\nSaved legacy work\n");
  expect(plan.handoffs[0].body).toBe("\nMixed-plan decisions\n");
  expect(plan.handoffs[0].metadata).toEqual({ from_step: "first", from_order: 1, to_step: "0002-second", to_order: 2 });
  expect(await readdir(f.store.directory("demo"))).not.toContain("STEP-0001-first.md");
  expect(f.compactions).toHaveLength(2); expect(f.messages).toHaveLength(3);
});

test("directory lifecycle ignores status-only and empty PROGRESS; freezes templates and completes with authored context", async () => {
  const f = await setup();
  await f.store.preparePlan("directory");
  const first = await f.store.prepareStep("directory", "design", 1);
  const second = await f.store.prepareStep("directory", "build", 2);
  const planIndex = f.store.indexPath("directory");
  const planBefore = await readFile(planIndex, "utf8");
  const stepBefore = await readFile(first.path, "utf8");
  await f.call("planner_start", { planName: "directory" });
  expect((await f.store.readRuntime("directory"))?.loop.iteration).toBe(1);
  expect((await f.store.readRuntime("directory"))?.frozen.plan).toHaveLength(64);
  expect((await f.store.readRuntime("directory"))?.frozen.steps["0001"]).toHaveLength(64);
  expect((await f.store.readRuntime("directory"))?.frozen.steps["0002"]).toBeUndefined();
  await f.store.updateStepStatus("directory", "0001", "Completed");
  await expect(f.call("planner_done")).rejects.toThrow("Save");
  const prepared = await f.call("planner_progress_prepare", { planName: "directory", stepId: "0001" });
  expect(prepared.content[0].text).toContain("PROGRESS-0001.md");
  await expect(f.call("planner_done")).rejects.toThrow("Save");
  const progressPath = join(f.store.directory("directory"), "STEP-0001", "PROGRESS-0001.md");
  const progress = await f.store.read(progressPath);
  await writeFile(progressPath, serializeMarkdown({ ...progress, body: "\nDecision and validation recorded.\n" }));
  await f.call("planner_done");
  expect((await f.store.readRuntime("directory"))?.loop.iteration).toBe(2);
  expect((await f.store.readRuntime("directory"))?.frozen.steps["0002"]).toHaveLength(64);
  expect(f.messages[1]).toContain(second.path);
  expect(f.messages[1]).not.toContain("Decision and validation recorded.");
  await f.store.updateStepStatus("directory", "0002", "Skipped");
  await expect(f.call("planner_done")).rejects.toThrow("Save");
  const secondProgress = await f.store.prepareProgress("directory", "0002");
  await writeFile(secondProgress.path, secondProgress.content.replace("<!-- Write the progress context here. -->", "Skipped: unnecessary after design validation."));
  await f.call("planner_done");
  expect((await f.store.load("directory")).status).toBe("Completed");
  expect(await readFile(planIndex, "utf8")).toBe(planBefore.replace("status: Pending", "status: Completed"));
  expect(await readFile(first.path, "utf8")).toBe(stepBefore.replace("status: Pending", "status: Completed"));
});

test("directory runtime rejects frozen instruction drift, recovers read-only and never delivers on state-write failure", async () => {
  const f = await setup();
  await f.store.preparePlan("frozen");
  const step = await f.store.prepareStep("frozen", "work", 1);
  const originalWrite = f.ctx.toolOperations.writeFile;
  f.ctx.toolOperations.writeFile = async (path, content) => {
    if (path.endsWith("LOOP-STATE.json")) throw new Error("runtime unavailable");
    return originalWrite(path, content);
  };
  await expect(f.call("planner_start", { planName: "frozen" })).rejects.toThrow("runtime unavailable");
  expect(f.messages).toEqual([]);
  expect(await f.store.readRuntime("frozen")).toBeUndefined();
  f.ctx.toolOperations.writeFile = originalWrite;
  await f.call("planner_start", { planName: "frozen" });
  expect(f.messages).toHaveLength(1);
  const indexBefore = await readFile(f.store.indexPath("frozen"), "utf8");
  const stepBefore = await readFile(step.path, "utf8");
  const stateBefore = await readFile(f.store.runtimePath("frozen"), "utf8");
  await f.events.get("session_start")({}, f.ctx);
  expect(await readFile(f.store.runtimePath("frozen"), "utf8")).toBe(stateBefore);
  expect(await readFile(step.path, "utf8")).toBe(stepBefore);
  expect(f.messages).toHaveLength(1);
  await writeFile(step.path, stepBefore.replace("<!-- Write the step content here. -->", "unauthorized instruction edit"));
  await expect(f.call("planner_done")).rejects.toThrow("frozen step INDEX instructions changed");
  expect(await readFile(f.store.indexPath("frozen"), "utf8")).toBe(indexBefore);
  await writeFile(step.path, stepBefore);
  await writeFile(f.store.indexPath("frozen"), indexBefore.replace("name: frozen", "name: altered"));
  f.setIdle(true); await f.command("stop");
  await expect(f.call("planner_start", { planName: "frozen" })).rejects.toThrow("frozen plan INDEX instructions changed");
  expect(f.messages).toHaveLength(1);
});

test("stopped legacy step can be manually migrated with preserved context and exact root handoff", async () => {
  const f = await setup();
  const target = await f.store.prepareStep("demo", "target", 2);
  const handoff = await f.store.prepareHandoff("demo", "0001-first", "0002");
  await f.call("planner_start", { planName: "demo" });
  f.setIdle(true); await f.command("stop");
  const sourcePath = join(f.store.directory("demo"), "STEP-0001-first.md");
  const source = await f.store.read(sourcePath);
  const planBefore = await readFile(f.store.indexPath("demo"), "utf8");
  const runtimeBefore = await readFile(f.store.runtimePath("demo"), "utf8");
  const migratedFolder = join(f.store.directory("demo"), "STEP-0001");
  await mkdir(migratedFolder);
  await writeFile(join(migratedFolder, "INDEX.md"), serializeMarkdown({ ...source, metadata: { ...source.metadata, extra: "retained" }, body: "\nDesign instructions.\n" }));
  await writeFile(join(migratedFolder, "PROGRESS-0001.md"), serializeMarkdown({ metadata: { sequence: 1 }, body: source.body }));
  const rootHandoff = await f.store.read(handoff.path);
  await writeFile(handoff.path, serializeMarkdown({ ...rootHandoff, metadata: { ...rootHandoff.metadata, from_step: "0001" }, body: "\nCarry design into implementation.\n" }));
  await rm(sourcePath);
  await f.command("list");
  expect((await f.store.load("demo")).steps.map((step) => step.id)).toEqual(["0001", "0002"]);
  expect((await f.store.load("demo")).steps[0].progress[0].body).toBe(source.body);
  await f.command("resume demo");
  expect(f.messages.at(-1)).toContain(join(migratedFolder, "INDEX.md"));
  expect((await f.store.readRuntime("demo"))?.loop.iteration).toBe(2);
  expect((await f.store.readRuntime("demo"))?.frozen.steps["0001"]).toHaveLength(64);
  await expect(f.call("planner_done")).rejects.toThrow("Save");
  const progress = await f.store.prepareProgress("demo", "0001");
  expect(progress.path).toEndWith("PROGRESS-0002.md");
  await writeFile(progress.path, progress.content.replace("<!-- Write the progress context here. -->", "Verified migration and metadata."));
  await f.store.updateStepStatus("demo", "0001", "Completed");
  await f.call("planner_done");
  expect(f.messages.at(-1)).toContain(target.path);
  expect(f.messages.at(-1)).toContain(handoff.path);
  const secondProgress = await f.store.prepareProgress("demo", "0002");
  await writeFile(secondProgress.path, secondProgress.content.replace("<!-- Write the progress context here. -->", "Implementation done."));
  await f.store.updateStepStatus("demo", "0002", "Completed");
  await f.call("planner_done");
  const plan = await f.store.load("demo");
  expect(plan.status).toBe("Completed");
  expect(plan.steps[0].metadata.extra).toBe("retained");
  expect(plan.handoffs[0]).toMatchObject({ fromStep: "0001", fromOrder: 1, toStep: "0002", toOrder: 2 });
  expect(await readFile(f.store.indexPath("demo"), "utf8")).toBe(planBefore.replace("status: In Progress", "status: Completed"));
  expect(await readFile(f.store.runtimePath("demo"), "utf8")).not.toBe(runtimeBefore);
});

test("mixed legacy and directory steps advance on authored context without rewriting plan instructions", async () => {
  const f = await setup();
  const second = await f.store.prepareStep("demo", "directory-work", 2);
  const handoff = await f.store.prepareHandoff("demo", "0001-first", "0002");
  const initialIndex = await readFile(f.store.indexPath("demo"), "utf8");
  await f.call("planner_start", { planName: "demo" });
  await f.step("Completed", "\nLegacy findings written.\n");
  const outgoing = await f.store.read(handoff.path);
  await writeFile(handoff.path, serializeMarkdown({ ...outgoing, body: "\nCarry findings into directory step.\n" }));
  await f.call("planner_done");
  expect(f.messages[1]).toContain(second.path);
  expect(f.messages[1]).toContain(handoff.path);
  expect((await f.store.readRuntime("demo"))?.frozen.steps["0002"]).toHaveLength(64);
  await f.store.updateStepStatus("demo", "0002", "Completed");
  await expect(f.call("planner_done")).rejects.toThrow("Save");
  const progress = await f.store.prepareProgress("demo", "0002");
  await writeFile(progress.path, progress.content.replace("<!-- Write the progress context here. -->", "Validated directory work."));
  await f.call("planner_done");
  expect((await f.store.load("demo")).status).toBe("Completed");
  expect(await readFile(f.store.indexPath("demo"), "utf8")).toBe(initialIndex.replace("status: Pending", "status: Completed"));
});

test("directory startup compaction failure never creates runtime state or changes INDEX", async () => {
  const f = await setup(50);
  await f.store.preparePlan("staged");
  const step = await f.store.prepareStep("staged", "work", 1);
  const planBefore = await readFile(f.store.indexPath("staged"), "utf8");
  const stepBefore = await readFile(step.path, "utf8");
  await f.call("planner_start", { planName: "staged" });
  expect(f.compactions).toHaveLength(1);
  expect(await f.store.readRuntime("staged")).toBeUndefined();
  f.compactions[0].onError(new Error("denied"));
  f.compactions[0].onComplete(); await f.flush();
  expect(await f.store.readRuntime("staged")).toBeUndefined();
  expect(await readFile(f.store.indexPath("staged"), "utf8")).toBe(planBefore);
  expect(await readFile(step.path, "utf8")).toBe(stepBefore);
  expect(f.messages).toEqual([]);
  f.setPercent(10);
  await f.call("planner_start", { planName: "staged" });
  expect((await f.store.readRuntime("staged"))?.loop.iteration).toBe(1);
  expect(f.messages).toHaveLength(1);
});

test("directory prompts include plan, active step and latest authored progress, not empty placeholders", async () => {
  const f = await setup();
  const index = await f.store.preparePlan("history");
  await writeFile(index.path, index.content.replace("<!-- Write the plan content here. -->", "Plan goal: ship safely."));
  const first = await f.store.prepareStep("history", "first", 1);
  await writeFile(first.path, first.content.replace("<!-- Write the step content here. -->", "Step one: add tests."));
  const empty = await f.store.prepareProgress("history", "0001");
  const before = buildPrompt(createLoopState(await f.store.load("history")), await f.store.load("history"));
  expect(before).toContain("No authored PROGRESS yet");
  expect(before).not.toContain(empty.path);
  const authored = await f.store.prepareProgress("history", "0001");
  await writeFile(authored.path, authored.content.replace("<!-- Write the progress context here. -->", "Checks passed for step one."));
  const newestEmpty = await f.store.prepareProgress("history", "0001");
  const plan = await f.store.load("history");
  const prompt = buildPrompt(createLoopState(plan), plan);
  for (const text of [index.path, first.path, authored.path, '**Plan ID:** `"history"`', '**Active step ID:** `"0001"`', "Plan goal: ship safely.", "Step one: add tests.", "Checks passed for step one."]) expect(prompt).toContain(text);
  expect(prompt).not.toContain(empty.path);
  expect(prompt).not.toContain(newestEmpty.path);
  await f.store.updateStepStatus("history", "0001", "Completed");
  const second = await f.store.prepareStep("history", "second", 2);
  await writeFile(second.path, second.content.replace("<!-- Write the step content here. -->", "Step two: release."));
  const nextPlan = await f.store.load("history");
  const nextPrompt = buildPrompt(createLoopState(nextPlan), nextPlan);
  expect(nextPrompt).toContain(second.path);
  expect(nextPrompt).toContain("Step two: release.");
  expect(nextPrompt).not.toContain("Checks passed for step one.");
});

test("directory prompts bound progress history and include only the latest authored body", async () => {
  const f = await setup();
  await f.store.preparePlan("history");
  await f.store.prepareStep("history", "many", 1);
  for (let i = 1; i <= 5; i++) {
    const entry = await f.store.prepareProgress("history", "0001");
    await writeFile(entry.path, entry.content.replace("<!-- Write the progress context here. -->", `marker-${i}-` + "content".repeat(2000)));
  }
  const plan = await f.store.load("history");
  const prompt = buildPrompt(createLoopState(plan), plan);
  expect(prompt).not.toContain("PROGRESS-0001.md");
  expect(prompt).not.toContain("PROGRESS-0002.md");
  for (const seq of [3, 4, 5]) expect(prompt).toContain(`PROGRESS-000${seq}.md`);
  expect(prompt).toContain("marker-5");
  expect(prompt).not.toContain("marker-4-");
  expect(prompt).toContain("Shortened; read");
  expect(prompt.length).toBeLessThan(4000);
});

test("work prompts retain Markdown, safely quote paths and close clipped fences", async () => {
  const f = await setup();
  const plan = await f.store.load("demo");
  plan.path = '/workspace/a`b[1]/INDEX.md';
  plan.body = "# Authored goal\n\nKeep **bold** and [links](https://example.com).";
  plan.steps[0]!.path = '/workspace/a`b[1]/STEP-first.md';
  plan.steps[0]!.body = "```ts\n" + "const x = 1;\n".repeat(300);
  const state = createLoopState(plan, { itemsPerIteration: 1 });
  const prompt = buildPrompt(state, plan, true);
  expect(prompt).toMatch(/^# Planner · /);
  for (const heading of ["## Plan ·", "## Active step ·", "## Next actions"]) expect(prompt).toContain(heading);
  expect(prompt).toContain("# Authored goal\n\nKeep **bold** and [links](https://example.com).");
  expect(prompt).toContain('``"/workspace/a`b[1]/INDEX.md"``');
  expect(prompt).toContain("```ts\nconst x = 1;");
  expect(prompt).toMatch(/\n```\n\n\[Shortened; read /);
  expect(prompt).toContain("Briefly reassess the approach");
  expect(prompt).toContain("Complete at most 1 step(s)");
  expect(prompt).toContain("legacy flat STEP body");
  expect(prompt).toContain("`planner_done`");
  expect(prompt.length).toBeLessThan(4000);
});

test("directory and closed-step prompts keep actionable Markdown without empty progress", async () => {
  const f = await setup();
  await f.store.preparePlan("md");
  await f.store.prepareStep("md", "first", 1);
  const plan = await f.store.load("md");
  const active = buildPrompt(createLoopState(plan), plan);
  expect(active).toContain("## Next actions");
  expect(active).toContain("`planner_progress_prepare`");
  expect(active).toContain("source step directory");
  plan.steps[0]!.status = "Completed";
  const closed = buildPrompt(createLoopState(plan), plan);
  expect(closed).toContain("All steps are closed.");
  expect(closed).toContain("`PLANNER_COMPLETE`");
  expect(closed).not.toContain("No authored PROGRESS yet");
});