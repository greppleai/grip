import type { ExtensionAPI, ExtensionContext } from "@greppleai/grip";
import { Type } from "typebox";
import { relative } from "node:path";
import { PlanStore, isTerminal, type Plan, type PreparedDocument, type RuntimeState } from "./plan-store.ts";
import { createLoopState, formatLoop, parseBuildArgs, type LoopOptions, type LoopState } from "./loop-state.ts";
import { buildPrompt, compactionInstructions, COMPLETE_MARKER, shouldCompact } from "./prompts.ts";

const help = [
  "/planner prepare <plan-name>",
  "/planner build <plan-name> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
  "/planner resume <plan-name> [options]",
  "/planner stop | status | list | cancel <plan-name>",
].join("\n");
const optionSchema = {
  itemsPerIteration: Type.Optional(Type.Integer({ minimum: 0 })),
  maxIterations: Type.Optional(Type.Integer({ minimum: 0 })),
  reflectEvery: Type.Optional(Type.Integer({ minimum: 0 })),
};
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const preparationText = ({ path, content }: PreparedDocument): string => {
  const advice = /\/HANDOFF-[^/]+\.md$/.test(path)
    ? "State what the next step needs, what was deferred, relevant paths and risks; avoid repeating the full history."
    : /\/PROGRESS-\d+\.md$/.test(path)
      ? "Record concrete changes and paths, checks and results, blockers and next actions; keep it concise."
      : /\/STEP-\d+\/INDEX\.md$/.test(path)
        ? "Before activation, explain the work, limits and checks in plain language; later change only status."
        : "Keep the plan INDEX high level: goal, boundaries and expected result; do not log work here.";
  return `Prepared ${JSON.stringify(path)}. Author this document in your next round; preparation does not start a build. ${advice}\n\n${content}`;
};
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function preparedResult(doc: PreparedDocument, ctx: ExtensionContext): Promise<string> {
  const base = preparationText(doc);
  const fallback = `${base}\n\nGrepple anchors unavailable on the active backend; read this file before an anchored edit.`;
  // The backend shell, not the extension host, must see both Grepple and the prepared path.
  if (typeof ctx.execToolBackend !== "function" || doc.content.length > 12000) return fallback;
  const lines = doc.content.endsWith("\n") ? doc.content.slice(0, -1).split("\n") : doc.content.split("\n");
  if (!lines.length || lines.length > 120 || lines.some((line) => line.includes("\r"))) return fallback;
  try {
    const command = `grepple --no-spill --line-only --repeat-source --at ${shellQuote(`${doc.path}:1-${lines.length}`)}`;
    const read = await ctx.execToolBackend(command, { cwd: ctx.toolOperations.cwd, timeout: 5, signal: ctx.signal });
    if (read.cancelled || read.truncated || read.exitCode !== 0 || read.output.length > 24000) return fallback;
    const rows = read.output.trimEnd().split("\n");
    const expectedPath = relative(ctx.toolOperations.cwd, doc.path);
    if (rows[0] !== expectedPath && rows[0] !== doc.path) return fallback;
    if (rows[1] !== "" || rows.length !== lines.length + 2) return fallback;
    for (let i = 0; i < lines.length; i++) {
      const match = rows[i + 2].match(/^([^│]{3})│(\d+)│(.*)$/);
      if (!match || Number(match[2]) !== i + 1 || match[3] !== lines[i]) return fallback;
    }
    return `${base}\n\nFresh Grepple anchors (use the three-character hashes with \`grepple write\`; no separate read needed):\n${read.output.trimEnd()}`;
  } catch { return fallback; }
}
function fingerprint(plan: Plan): string {
  const authored = (body: string, placeholder: string) => !!body.trim() && body.trim() !== placeholder;
  return JSON.stringify({
    steps: plan.steps.flatMap((step) => {
      if (step.directory) return step.progress.filter((p) => authored(p.body, "<!-- Write the progress context here. -->"))
        .map((p) => [step.id, p.path, p.sequence, p.metadata, p.body]);
      const { status: _status, ...metadata } = step.metadata;
      return authored(step.body, "<!-- Write the step content here. -->") ? [[step.id, metadata, step.body]] : [];
    }),
    handoffs: plan.handoffs.filter((h) => authored(h.body, "<!-- Write the handoff context here. -->"))
      .map((h) => [h.path, h.metadata, h.body]),
  });
}

export default function registerPlanner(pi: ExtensionAPI) {
  let loop: LoopState | null = null;
  let starting: { planId: string; generation: number } | null = null;
  let checkpoint = "";
  let generation = 0;
  let advancing = false;
  let compactionPending = false;
  const store = (ctx: ExtensionContext) => {
    const files = ctx.toolOperations;
    // Session cwd belongs to the host; sandbox/remote paths belong to the backend.
    return new PlanStore(files.cwd, files);
  };

  function ui(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus("planner", loop ? `Planner ${formatLoop(loop)}` : undefined);
  }
  function remember(ctx: ExtensionContext): void {
    pi.appendEntry("planner-loop", { cwd: ctx.cwd, loop });
    ui(ctx);
  }
  function clear(ctx: ExtensionContext): void {
    generation++;
    loop = null;
    starting = null;
    checkpoint = "";
    compactionPending = false;
    remember(ctx);
  }
  function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else pi.sendMessage({ customType: "planner", content: text, display: true });
  }

  async function start(planId: string, options: LoopOptions, ctx: ExtensionContext, resume = false): Promise<string> {
    if (loop || starting || compactionPending) throw new Error("Stop the current planner loop before starting another.");
    if (ctx.hasPendingMessages()) throw new Error("Pending messages already queued; start the planner after they are handled.");
    const plans = store(ctx);
    const expectedGeneration = ++generation;
    starting = { planId, generation: expectedGeneration };
    const ownsStartup = () => generation === expectedGeneration && starting?.generation === expectedGeneration;
    const valid = () => ownsStartup() && !ctx.hasPendingMessages();
    const release = () => { if (ownsStartup()) starting = null; };
    const validate = async (plan: Plan): Promise<{ state: LoopState; runtime?: RuntimeState }> => {
      if (!valid()) throw new Error("Planner start cancelled or suppressed by pending messages.");
      if (isTerminal(plan.status)) throw new Error(`Plan ${planId} is ${plan.status}; set INDEX.md status to Pending to reopen it.`);
      if (!plan.steps.length) throw new Error(`Add STEP-<order>/INDEX.md (or legacy flat STEP files) to ${plans.directory(planId)} before building.`);
      const runtime = await plans.readRuntime(planId);
      await plans.checkTemplates(plan, runtime);
      if (!valid()) throw new Error("Planner start cancelled or suppressed by pending messages.");
      const state = createLoopState(plan, options, resume, runtime?.loop);
      if (state.maxIterations && state.iteration > state.maxIterations) throw new Error("Max iterations reached. Increase --max-iterations or use 0 for unlimited.");
      return { state, runtime };
    };
    const launch = async ({ state, runtime }: { state: LoopState; runtime?: RuntimeState }): Promise<string> => {
      await plans.updateIndex(planId, { status: "In Progress" }, (doc) => valid() && doc.metadata.status !== "Completed" && doc.metadata.status !== "Skipped");
      if (!valid()) throw new Error("Planner start cancelled or suppressed by pending messages.");
      const activated = await plans.activateStep(planId, valid);
      if (!valid()) throw new Error("Planner start cancelled or suppressed by pending messages.");
      if (isTerminal(activated.status)) throw new Error(`Plan ${planId} is ${activated.status}; no iteration delivered.`);
      const frozen = await plans.freezeTemplates(activated, runtime);
      if (!valid()) throw new Error("Planner start cancelled or suppressed by pending messages.");
      await plans.saveRuntime(planId, { version: 1, loop: state, frozen }, valid);
      if (!valid()) throw new Error("Planner start cancelled or suppressed by pending messages.");
      loop = state;
      checkpoint = fingerprint(activated);
      remember(ctx);
      pi.sendUserMessage(buildPrompt(state, activated), { deliverAs: "followUp" });
      return `Started ${formatLoop(state)}.`;
    };
    let staged = false;
    try {
      const plan = await plans.load(planId);
      const prepared = await validate(plan);
      if (!shouldCompact(ctx.getContextUsage()?.percent)) return await launch(prepared);

      // Pi queues extension compaction outside the active tool batch. Never await
      // its callback here: busy/UI/headless callers must return to let it drain.
      let settled = false;
      const afterCompaction = async (error?: Error) => {
        if (settled || !ownsStartup()) return;
        settled = true;
        try {
          if (error) throw new Error(`Startup compaction failed: ${error.message}`);
          if (!valid()) throw new Error("Planner start suppressed by pending messages.");
          const fresh = await plans.load(planId);
          if (!ownsStartup()) return;
          await launch(await validate(fresh));
        } catch (failure) {
          if (ownsStartup()) notify(ctx, `Planner startup paused: ${String(failure)}. Retry build/resume after resolving it.`, "error");
        } finally { release(); }
      };
      try {
        ctx.compact({
          customInstructions: compactionInstructions(prepared.state, plan),
          onComplete: () => { void afterCompaction(); },
          onError: (error) => { void afterCompaction(error); },
        });
      } catch (error) {
        settled = true;
        throw new Error(`Startup compaction could not be requested: ${String(error)}`);
      }
      staged = true;
      return "Startup compaction requested; plan files are unchanged until it succeeds. Startup follows automatically. End this response.";
    } finally {
      if (!staged) release();
    }
  }

  async function finish(plan: Plan, ctx: ExtensionContext): Promise<void> {
    if (!plan.steps.length || plan.steps.some((step) => !isTerminal(step.status))) throw new Error("Cannot finish: mark every step Completed or Skipped first.");
    const plans = store(ctx);
    await plans.checkTemplates(plan, await plans.readRuntime(plan.id));
    if (fingerprint(plan) === checkpoint) throw new Error("Save authored progress/context before completing; terminal statuses alone are not progress.");
    await plans.updateIndex(plan.id, { status: "Completed" });
    clear(ctx);
    notify(ctx, `Planner complete: ${plan.id}.`);
  }

  async function advance(ctx: ExtensionContext, expectedGeneration: number): Promise<void> {
    const valid = () => !!loop && generation === expectedGeneration && !ctx.hasPendingMessages();
    if (!loop || !valid()) return;
    const next = { ...loop, iteration: loop.iteration + 1 };
    if (!Number.isSafeInteger(next.iteration)) throw new Error("Loop iteration exceeds the safe integer range.");
    if (next.maxIterations && next.iteration > next.maxIterations) {
      clear(ctx);
      notify(ctx, "Max iterations reached. Loop paused; use /planner resume with a larger limit.");
      return;
    }
    const plans = store(ctx);
    const plan = await plans.load(next.planId);
    if (!valid()) return;
    if (isTerminal(plan.status)) { clear(ctx); return; }
    const runtime = await plans.readRuntime(next.planId);
    await plans.checkTemplates(plan, runtime);
    if (runtime && runtime.loop.iteration !== loop.iteration) throw new Error("Runtime iteration changed; resume after reconciliation.");
    if (!valid()) return;
    const activated = await plans.activateStep(next.planId, valid);
    if (!valid()) return;
    if (isTerminal(activated.status)) { clear(ctx); return; }
    const frozen = await plans.freezeTemplates(activated, runtime);
    if (!valid()) return;
    await plans.saveRuntime(next.planId, { version: 1, loop: next, frozen }, valid);
    if (!valid()) return;
    loop = next;
    checkpoint = fingerprint(activated);
    remember(ctx);
    const reflect = next.reflectEvery > 0 && (next.iteration - 1) % next.reflectEvery === 0;
    pi.sendUserMessage(buildPrompt(next, activated, reflect), { deliverAs: "followUp" });
  }

  async function done(ctx: ExtensionContext): Promise<string> {
    if (!loop) throw new Error("No active planner loop. Use /planner build <plan-name>.");
    if (compactionPending || advancing) return "Continuation already in progress; end this response.";
    advancing = true;
    try {
      const expectedGeneration = generation;
      const activeLoop = loop;
      const plans = store(ctx);
      const plan = await plans.load(activeLoop.planId);
      await plans.checkTemplates(plan, await plans.readRuntime(activeLoop.planId));
      if (generation !== expectedGeneration || loop !== activeLoop) return "Planner loop changed; no continuation delivered.";
      if (plan.status === "Skipped") { clear(ctx); return "Plan skipped; loop stopped."; }
      if (plan.steps.length && plan.steps.every((step) => isTerminal(step.status))) {
        await finish(plan, ctx);
        return "Plan completed. No next iteration.";
      }
      if (plan.status === "Completed") throw new Error("Plan marked Completed but steps remain open. Fix the Markdown statuses.");
      if (fingerprint(plan) === checkpoint) throw new Error("Save progress/context in PROGRESS or HANDOFF files (legacy: STEP body) before calling planner_done.");
      if (ctx.hasPendingMessages()) return "Pending messages already queued. Continue there.";
      const iteration = activeLoop.iteration;
      if (shouldCompact(ctx.getContextUsage()?.percent) && (ctx.isIdle() || ctx.hasUI)) {
        compactionPending = true;
        // Keep the original threshold, callback-based continuation, and failure fallback.
        // Busy headless runs skip compaction so their staged follow-up stays active.
        let settled = false;
        const continueLoop = async (error?: Error) => {
          if (settled || generation !== expectedGeneration) return;
          settled = true;
          compactionPending = false;
          if (error) notify(ctx, `Compaction failed (${error.message}); continuing without it.`, "warning");
          try { await advance(ctx, expectedGeneration); }
          catch (failure) {
            if (generation === expectedGeneration) { clear(ctx); notify(ctx, `Planner paused: ${String(failure)}`, "error"); }
          }
        };
        try {
          ctx.compact({ customInstructions: compactionInstructions(loop, plan), onComplete: () => { void continueLoop(); }, onError: (error) => { void continueLoop(error); } });
        } catch (error) { await continueLoop(error instanceof Error ? error : new Error(String(error))); }
        return `Iteration ${iteration} saved. Compaction requested; continuation follows automatically. End this response.`;
      }
      try { await advance(ctx, expectedGeneration); }
      catch (failure) { if (generation === expectedGeneration) clear(ctx); throw failure; }
      const delivered = generation === expectedGeneration && loop?.iteration === iteration + 1;
      return `Iteration ${iteration} saved. ${delivered ? "Next iteration queued." : loop ? "Continuation suppressed; no iteration delivered." : "Loop stopped."} End this response.`;
    } finally { advancing = false; }
  }

  pi.registerCommand("planner", {
    description: "Local Markdown plans: prepare, build, resume, stop, status, list, cancel",
    getArgumentCompletions: (prefix) => ["prepare", "build", "resume", "stop", "status", "list", "cancel"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      try {
        if (command === "build" || command === "resume") {
          const parsed = parseBuildArgs(rest.join(" "));
          notify(ctx, await start(parsed.planId, parsed.options, ctx, command === "resume"));
        } else if (command === "prepare") {
          if (rest.length !== 1) throw new Error("Usage: /planner prepare <plan-name>");
          notify(ctx, await preparedResult(await store(ctx).preparePlan(rest[0]), ctx));
        } else if (command === "stop") {
          if (!ctx.isIdle()) throw new Error("Press ESC to interrupt first, then /planner stop.");
          clear(ctx);
          notify(ctx, "Planner paused. Plan files are unchanged.");
        } else if (command === "cancel") {
          if (rest.length !== 1) throw new Error("Usage: /planner cancel <plan-name>");
          // Invalidate queued delivery before waiting for the plan mutation queue.
          if (loop?.planId === rest[0] || starting?.planId === rest[0]) clear(ctx);
          await store(ctx).updateIndex(rest[0], { status: "Skipped" });
          notify(ctx, `Skipped plan ${rest[0]}.`);
        } else if (command === "status") {
          notify(ctx, loop ? formatLoop(loop) : "No active planner loop.");
        } else if (command === "list") {
          const plans = await store(ctx).list();
          notify(ctx, plans.length ? plans.map((p) => `${p.id}: ${p.status}`).join("\n") : "No plans in .planner.");
        } else notify(ctx, help);
      } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  pi.registerTool({
    name: "planner_prepare", label: "Prepare plan", description: "Scaffold .planner/<planName>/INDEX.md and return its path and exact Markdown. Author the content next round; does not start a build.",
    promptSnippet: "Prepare an empty local plan document before authoring its content next round.",
    parameters: Type.Object({ planName: Type.String(), name: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) { return result(await preparedResult(await store(ctx).preparePlan(params.planName, params.name), ctx)); },
  });
  pi.registerTool({
    name: "planner_step_prepare", label: "Prepare step", description: "Scaffold numeric-only STEP-0001/INDEX.md (padded order, not stepName) in an existing plan. stepName is display metadata; use exact numeric ID in handoffs. Author INDEX before first activation; only status changes afterward.",
    promptSnippet: "Prepare an empty step document with a unique order before authoring it next round.",
    parameters: Type.Object({
      planName: Type.String(), stepName: Type.String(), order: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      name: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) { return result(await preparedResult(await store(ctx).prepareStep(params.planName, params.stepName, params.order, params.name), ctx)); },
  });
  pi.registerTool({
    name: "planner_progress_prepare", label: "Prepare progress", description: "Scaffold next numbered PROGRESS-0001.md inside a numeric directory step, using max sequence + 1. Author substantive context next round; placeholders are not saved work. Legacy flat steps require migration. No build is triggered.",
    promptSnippet: "Prepare an empty numbered progress document for an existing directory step.",
    parameters: Type.Object({ planName: Type.String(), stepId: Type.String() }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) { return result(await preparedResult(await store(ctx).prepareProgress(params.planName, params.stepId), ctx)); },
  });
  pi.registerTool({
    name: "planner_handoff_prepare", label: "Prepare handoff", description: "Scaffold HANDOFF-<fromStep>.md inside the source directory (root for legacy flat steps). Endpoints use exact IDs and file orders; quote numeric IDs in YAML. Distinct handoffName permits additional files. Author context next round.",
    promptSnippet: "Prepare an empty handoff document with exact endpoint orders before authoring context next round.",
    parameters: Type.Object({
      planName: Type.String(), fromStep: Type.String(), toStep: Type.String(), handoffName: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _update, ctx) { return result(await preparedResult(await store(ctx).prepareHandoff(params.planName, params.fromStep, params.toStep, params.handoffName), ctx)); },
  });
  pi.registerTool({
    name: "planner_start", label: "Build plan", description: "Start an iterative build loop for a local Markdown plan. At 40% context usage, requests compaction first and stages startup until success; return and end this response. Startup compaction failure pauses without changing plan files.",
    promptSnippet: "Build a plan stored under .planner/<planName>.",
    parameters: Type.Object({ planName: Type.String(), ...optionSchema }),
    async execute(_id, params, _signal, _update, ctx) { return result(await start(params.planName, params, ctx)); },
  });
  pi.registerTool({
    name: "planner_done", label: "Planner checkpoint", description: "Continue after saving authored PROGRESS/HANDOFF context (legacy flat STEP body supported) and statuses; status-only edits or empty scaffolds do not count. Compacts at 40%; finishes when all steps close with saved work.",
    promptSnippet: "Checkpoint saved Markdown progress and continue the active planner loop.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) { return result(await done(ctx)); },
  });

  // No repeated plan snapshot in before_agent_start: each continuation already has references.
  pi.on("agent_end", async (event, ctx) => {
    if (!loop) return;
    const message = [...event.messages].reverse().find((m) => m.role === "assistant");
    const text = message?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    if (!text.split(/\r?\n/).some((line) => line.trim() === COMPLETE_MARKER)) return;
    try { await finish(await store(ctx).load(loop.planId), ctx); }
    catch (error) { notify(ctx, String(error), "warning"); }
  });
  pi.on("session_start", async (_event, ctx) => {
    generation++;
    loop = null;
    starting = null;
    compactionPending = false;
    advancing = false;
    const entry = [...ctx.session.getBranch()].reverse().find((e) => e.type === "custom" && e.customType === "planner-loop");
    if (entry?.type === "custom") {
      const data = entry.data as { cwd?: string; loop?: LoopState | null } | undefined;
      if (data?.cwd === ctx.cwd && data.loop) {
        try {
          const plans = store(ctx);
          const plan = await plans.load(data.loop.planId);
          const runtime = await plans.readRuntime(plan.id);
          await plans.checkTemplates(plan, runtime);
          if (!isTerminal(plan.status)) { loop = createLoopState(plan, {}, false, runtime?.loop); checkpoint = fingerprint(plan); }
        } catch (error) { notify(ctx, `Planner recovery failed: ${String(error)}`, "warning"); }
      }
    }
    ui(ctx);
  });
  pi.on("session_shutdown", () => { generation++; loop = null; starting = null; compactionPending = false; });
}