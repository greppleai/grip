import { currentStep, type Plan } from "./plan-store.ts";
import { formatLoop, type LoopState } from "./loop-state.ts";

export const COMPLETE_MARKER = "PLANNER_COMPLETE";
export const COMPACTION_THRESHOLD_PERCENT = 40;

// Quote backend paths and IDs for exact copying, even when they contain Markdown punctuation.
function code(value: string): string {
  const quoted = JSON.stringify(value);
  const longest = Math.max(0, ...Array.from(quoted.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${quoted}${fence}`;
}

// Include enough context to act immediately, but keep large records on disk.
function excerpt(body: string, path: string, limit: number): string {
  const text = body.trim();
  if (text.length <= limit) return text || "(no authored content)";
  const clipped = text.slice(0, limit);
  // Keep the following sections outside an authored fenced code block cut by the budget.
  const fences = Array.from(clipped.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm), ([, fence]) => fence);
  let open = "";
  for (const fence of fences) {
    if (!open) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = "";
  }
  return `${clipped}${open ? `\n${open}` : ""}\n\n[Shortened; read ${code(path)} for the rest.]`;
}

export function buildPrompt(state: LoopState, plan: Plan, reflection = false): string {
  const step = currentStep(plan);
  const handoffs = step ? plan.handoffs.filter((handoff) => handoff.toStep === step.id && handoff.toOrder === step.order) : [];
  const authoredProgress = step?.progress.filter((entry) => {
    const body = entry.body.trim();
    return body.length > 0 && body !== "<!-- Write the progress context here. -->";
  }) ?? [];
  const recent = authoredProgress.slice(-3);
  const latest = recent.at(-1);
  const references = [
    // Bounded even if a plan accumulates hundreds of incoming handoffs.
    ...handoffs.slice(-3).map((handoff) => `- Incoming handoff: ${code(handoff.path)}`),
    handoffs.length > 3 ? "- More incoming handoffs may be in the plan or source step directories; read only as needed." : "",
    ...recent.map((entry) => `- Recent progress: ${code(entry.path)}`),
    step?.directory && step.progress.length > recent.length ? `- Other PROGRESS files are in ${code(step.directory)}; read as needed.` : "",
  ].filter(Boolean);
  const actions = [
    step?.directory && !authoredProgress.length ? `- No authored PROGRESS yet; call \`planner_progress_prepare\` with planName ${code(plan.id)} and stepId ${code(step.id)} before saving context (reuse an empty prepared file if present).` : "",
    state.itemsPerIteration ? `- Complete at most ${state.itemsPerIteration} step(s) this iteration.` : "",
    reflection ? "- Briefly reassess the approach; record useful decisions in PROGRESS or HANDOFF, not INDEX instructions." : "",
    step?.directory
      ? "- Do the work and validate it. Save substantive context in authored numbered PROGRESS files; prepare an empty file first with `planner_progress_prepare` if needed. Plan and step INDEX instructions are frozen: change only status there."
      : "- Do the work, validate it, and save progress in the legacy flat STEP body or authored HANDOFF files. Only status may change in plan INDEX.",
    step?.directory
      ? "- Before switching steps, author an outgoing HANDOFF in the source step directory with YAML `from_step`, `from_order`, `to_step`, `to_order` (numeric IDs quoted)."
      : "- Before switching steps write an outgoing HANDOFF with exact IDs and orders.",
    "- Then call `planner_done` and end this response.",
    `- When every step is Completed or Skipped, call \`planner_done\` to finish (or emit \`${COMPLETE_MARKER}\`).`,
  ].filter(Boolean);
  return [
    `# Planner · ${formatLoop(state)}`,
    `**Plan ID:** ${code(plan.id)}${step ? `\n\n**Active step ID:** ${code(step.id)} (order ${step.order})` : ""}`,
    `## Plan · ${plan.name}\n\nINDEX: ${code(plan.path)}\n\n${excerpt(plan.body, plan.path, 1200)}`,
    step ? `## Active step · ${step.name}\n\nINDEX: ${code(step.path)}\n\n${excerpt(step.body, step.path, 1400)}` : "## Active step\n\nAll steps are closed.",
    references.length ? `## Related context\n\n${references.join("\n")}` : "",
    latest ? `### Latest authored progress · ${code(latest.path)}\n\n${excerpt(latest.body, latest.path, 1100)}` : "",
    `## Next actions\n\n${actions.join("\n")}`,
  ].filter(Boolean).join("\n\n");
}
export function compactionInstructions(state: LoopState, plan: Plan): string {
  return `Planner checkpoint: ${formatLoop(state)}. Durable context is in ${JSON.stringify(plan.path)}, runtime state ${JSON.stringify(plan.path.replace(/INDEX\.md$/, "LOOP-STATE.json"))} (if present), and referenced STEP/PROGRESS/HANDOFF files. Keep the summary short: preserve user constraints, unsaved work, changed files, validation and unresolved risks. Do not repeat the stored plan or completed-step history.`;
}
export function shouldCompact(percent: number | null | undefined): boolean {
  return percent != null && Number.isFinite(percent) && (percent <= 1 ? percent * 100 : percent) >= COMPACTION_THRESHOLD_PERCENT;
}