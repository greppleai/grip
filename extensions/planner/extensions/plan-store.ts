import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { isMap, isScalar, parseDocument, stringify } from "yaml";
import { withFileMutationQueue, type ExtensionContext } from "@greppleai/grip";
import type { LoopState } from "./loop-state.ts";

export const STATUSES = ["Pending", "In Progress", "Completed", "Skipped"] as const;
export type Status = (typeof STATUSES)[number];
export type MarkdownDocument = { metadata: Record<string, unknown>; body: string; path: string };
export type PreparedDocument = { path: string; content: string };
export type Progress = MarkdownDocument & { sequence: number };
export type Step = MarkdownDocument & { id: string; name: string; description: string; order: number; status: Status; directory?: string; progress: Progress[] };
export type Handoff = MarkdownDocument & { fromStep: string; fromOrder: number; toStep: string; toOrder: number };
export type Plan = MarkdownDocument & { id: string; name: string; description: string; status: Status; steps: Step[]; handoffs: Handoff[] };
type FileOperations = Pick<ExtensionContext["toolOperations"], "readFile" | "writeFile" | "mkdir" | "readdir" | "stat">;
export type RuntimeState = { version: 1; loop: LoopState; frozen: { plan?: string; steps: Record<string, string> } };

export function validateId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) {
    throw new Error("Names used in paths must be 1–80 letters, numbers, hyphens or underscores, starting with a letter or number.");
  }
  return id;
}

export function parseMarkdown(text: string, path: string): MarkdownDocument {
  const match = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${path}: expected YAML frontmatter.`);
  const yaml = parseDocument(match[1], { uniqueKeys: true });
  if (yaml.errors.length) throw new Error(`${path}: ${yaml.errors[0].message}`);
  const metadata: unknown = yaml.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error(`${path}: frontmatter must be a mapping.`);
  return { metadata: metadata as Record<string, unknown>, body: text.replace(/^\uFEFF/, "").slice(match[0].length), path };
}

export function serializeMarkdown(doc: Pick<MarkdownDocument, "metadata" | "body">): string {
  return `---\n${stringify(doc.metadata)}---\n${doc.body}`;
}

// Change only the scalar token, leaving comments, YAML layout, line endings and body byte-identical.
export function replaceStatus(text: string, path: string, status: Status): string {
  if (!STATUSES.includes(status)) throw new Error(`${path}: invalid status.`);
  const withoutBom = text.replace(/^\uFEFF/, "");
  const match = withoutBom.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${path}: expected YAML frontmatter.`);
  const yaml = parseDocument(match[1], { uniqueKeys: true });
  if (yaml.errors.length || !isMap(yaml.contents)) throw new Error(`${path}: invalid YAML frontmatter.`);
  const fields = yaml.contents.items.filter((item) => isScalar(item.key) && item.key.value === "status");
  if (fields.length !== 1 || !isScalar(fields[0].value) || !fields[0].value.range || !STATUSES.includes(fields[0].value.value as Status)) {
    throw new Error(`${path}: status must be a single scalar status.`);
  }
  const value = fields[0].value;
  const [start, end] = value.range;
  const raw = match[1].slice(start, end);
  if (raw.includes("\n") || raw.includes("\r")) throw new Error(`${path}: multiline status is unsupported.`);
  const offset = text.length - withoutBom.length + match[0].indexOf(match[1]);
  const replacement = raw.startsWith("'") ? `'${status.replaceAll("'", "''")}'` : raw.startsWith('"') ? JSON.stringify(status) : status;
  return text.slice(0, offset + start) + replacement + text.slice(offset + end);
}

function textField(doc: MarkdownDocument, key: string, allowEmpty = false): string {
  const value = doc.metadata[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${doc.path}: ${key} must be a string${allowEmpty ? "" : " (not empty)"}.`);
  return value;
}
function orderField(doc: MarkdownDocument, key: string): number {
  const value = doc.metadata[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${doc.path}: ${key} must be a positive integer.`);
  return value;
}
function statusField(doc: MarkdownDocument): Status {
  const value = doc.metadata.status;
  if (!STATUSES.includes(value as Status)) throw new Error(`${doc.path}: status must be ${STATUSES.join(", ")}.`);
  return value as Status;
}
export function isTerminal(status: Status): boolean { return status === "Completed" || status === "Skipped"; }
export function currentStep(plan: Plan): Step | undefined {
  return plan.steps.find((step) => step.status === "In Progress") ?? plan.steps.find((step) => step.status === "Pending");
}

export class PlanStore {
  readonly root: string;
  constructor(cwd: string, private readonly files: FileOperations) { this.root = resolve(cwd, ".planner"); }
  directory(id: string): string { return join(this.root, validateId(id)); }
  indexPath(id: string): string { return join(this.directory(id), "INDEX.md"); }
  runtimePath(id: string): string { return join(this.directory(id), "LOOP-STATE.json"); }
  async read(path: string): Promise<MarkdownDocument> { return parseMarkdown((await this.files.readFile(path)).toString("utf8"), path); }

  async readRuntime(id: string): Promise<RuntimeState | undefined> {
    const path = this.runtimePath(id);
    if (!(await this.files.readdir(this.directory(id))).includes("LOOP-STATE.json")) return undefined;
    if (!(await this.files.stat(path)).isFile()) throw new Error(`${path}: runtime state must be a file.`);
    let raw: unknown;
    try { raw = JSON.parse((await this.files.readFile(path)).toString("utf8")); }
    catch (error) { throw new Error(`${path}: invalid runtime JSON: ${String(error)}`); }
    const state = raw as RuntimeState;
    const validNumber = (n: unknown, min: number) => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
    if (!state || state.version !== 1 || !state.loop || state.loop.planId !== id ||
        !validNumber(state.loop.iteration, 1) || !validNumber(state.loop.itemsPerIteration, 0) ||
        !validNumber(state.loop.maxIterations, 0) || !validNumber(state.loop.reflectEvery, 0) ||
        !state.frozen || !state.frozen.steps || typeof state.frozen.steps !== "object" || Array.isArray(state.frozen.steps) ||
        (state.frozen.plan !== undefined && !/^[a-f0-9]{64}$/.test(state.frozen.plan)) ||
        Object.entries(state.frozen.steps).some(([key, value]) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(key) || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
      throw new Error(`${path}: invalid runtime state.`);
    }
    return state;
  }

  async saveRuntime(id: string, state: RuntimeState, canWrite: () => boolean = () => true): Promise<void> {
    await withFileMutationQueue(this.indexPath(id), async () => {
      if (!canWrite()) return;
      const path = this.runtimePath(id);
      // Never confuse a directory or dangling symlink with an absent state file.
      if ((await this.files.readdir(this.directory(id))).includes("LOOP-STATE.json") && !(await this.files.stat(path)).isFile()) {
        throw new Error(`${path}: runtime state must be a file.`);
      }
      if (!canWrite()) return;
      await this.files.writeFile(path, JSON.stringify(state, null, 2) + "\n");
    });
  }

  private async templateHash(path: string): Promise<string> {
    const text = (await this.files.readFile(path)).toString("utf8");
    return createHash("sha256").update(replaceStatus(text, path, "Pending")).digest("hex");
  }

  async checkTemplates(plan: Plan, runtime?: RuntimeState): Promise<void> {
    if (!runtime) return;
    if (runtime.frozen.plan && runtime.frozen.plan !== await this.templateHash(plan.path)) throw new Error(`${plan.path}: frozen plan INDEX instructions changed.`);
    for (const [id, hash] of Object.entries(runtime.frozen.steps)) {
      const step = plan.steps.find((candidate) => candidate.id === id && candidate.directory);
      if (!step || hash !== await this.templateHash(step.path)) throw new Error(`${id}: frozen step INDEX instructions changed.`);
    }
  }

  async freezeTemplates(plan: Plan, runtime?: RuntimeState): Promise<RuntimeState["frozen"]> {
    await this.checkTemplates(plan, runtime);
    const frozen = { plan: runtime?.frozen.plan, steps: { ...runtime?.frozen.steps } };
    if (!frozen.plan && plan.steps.some((step) => step.directory)) frozen.plan = await this.templateHash(plan.path);
    const selected = currentStep(plan);
    if (selected?.directory && !frozen.steps[selected.id]) frozen.steps[selected.id] = await this.templateHash(selected.path);
    return frozen;
  }

  private async readProgress(directory: string): Promise<Progress[]> {
    const progress: Progress[] = [];
    for (const entry of (await this.files.readdir(directory)).sort()) {
      if (!entry.startsWith("PROGRESS-")) continue;
      const match = /^PROGRESS-(\d{4,})\.md$/.exec(entry);
      if (!match) throw new Error(`${directory}/${entry}: malformed progress filename.`);
      const path = join(directory, entry);
      if (!(await this.files.stat(path)).isFile()) throw new Error(`${path}: progress must be a file.`);
      const doc = await this.read(path);
      const sequence = orderField(doc, "sequence");
      if (match[1] !== String(sequence).padStart(4, "0")) throw new Error(`${path}: progress filename must match sequence ${sequence}.`);
      if (progress.some((p) => p.sequence === sequence)) throw new Error(`${path}: duplicate progress sequence.`);
      progress.push({ ...doc, sequence });
    }
    return progress.sort((a, b) => a.sequence - b.sequence);
  }

  async load(id: string): Promise<Plan> {
    const directory = this.directory(id);
    const index = await this.read(this.indexPath(id));
    const steps: Step[] = [];
    const handoffs: Handoff[] = [];
    const collectHandoff = async (path: string, source?: string) => {
      if (!(await this.files.stat(path)).isFile()) throw new Error(`${path}: handoff must be a file.`);
      const doc = await this.read(path);
      const fromStep = validateId(textField(doc, "from_step"));
      if (source && fromStep !== source) throw new Error(`${path}: handoff source does not match its step directory.`);
      handoffs.push({ ...doc, fromStep, fromOrder: orderField(doc, "from_order"), toStep: validateId(textField(doc, "to_step")), toOrder: orderField(doc, "to_order") });
    };
    for (const filename of (await this.files.readdir(directory)).sort()) {
      if (filename.startsWith("STEP-") && filename.endsWith(".md")) {
        const stepId = validateId(filename.slice(5, -3));
        const doc = await this.read(join(directory, filename));
        const order = orderField(doc, "order");
        const prefix = stepId.match(/^(\d{4,})-/)?.[1];
        if (prefix && prefix !== String(order).padStart(4, "0")) {
          throw new Error(`${doc.path}: numbered filename prefix must match order ${order} as ${String(order).padStart(4, "0")}; rename the file and update handoff IDs/orders together.`);
        }
        steps.push({ ...doc, id: stepId, name: textField(doc, "name"), description: textField(doc, "description", true), order, status: statusField(doc), progress: [] });
      } else if (filename.startsWith("STEP-")) {
        const stepId = filename.slice(5);
        const path = join(directory, filename);
        if (!/^\d{4,}$/.test(stepId) || !(await this.files.stat(path)).isDirectory()) throw new Error(`${path}: malformed step directory; expected STEP-<padded-order>/INDEX.md.`);
        const doc = await this.read(join(path, "INDEX.md"));
        const order = orderField(doc, "order");
        if (stepId !== String(order).padStart(4, "0")) throw new Error(`${path}: step directory must match order ${order}.`);
        const progress = await this.readProgress(path);
        steps.push({ ...doc, id: validateId(stepId), name: textField(doc, "name"), description: textField(doc, "description", true), order, status: statusField(doc), directory: path, progress });
        for (const entry of (await this.files.readdir(path)).sort()) {
          if (!entry.startsWith("HANDOFF-")) continue;
          if (!/^HANDOFF-[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.md$/.test(entry)) throw new Error(`${path}/${entry}: malformed handoff filename.`);
          await collectHandoff(join(path, entry), stepId);
        }
      } else if (filename.startsWith("HANDOFF-") && filename.endsWith(".md")) {
        validateId(filename.slice(8, -3));
        await collectHandoff(join(directory, filename));
      }
    }
    steps.sort((a, b) => a.order - b.order);
    if (new Set(steps.map((step) => step.order)).size !== steps.length || new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error(`${directory}: step IDs and orders must be unique.`);
    if (steps.filter((step) => step.status === "In Progress").length > 1) throw new Error(`${directory}: only one step may be In Progress.`);
    for (const handoff of handoffs) {
      const from = steps.find((step) => step.id === handoff.fromStep);
      const to = steps.find((step) => step.id === handoff.toStep);
      if (!from || !to || from.order !== handoff.fromOrder || to.order !== handoff.toOrder) throw new Error(`${handoff.path}: handoff step names/orders do not match the plan.`);
    }
    handoffs.sort((a, b) => a.path.localeCompare(b.path));
    return { ...index, id, name: textField(index, "name"), description: textField(index, "description", true), status: statusField(index), steps, handoffs };
  }

  async activateStep(id: string, canActivate: () => boolean = () => true): Promise<Plan> {
    return withFileMutationQueue(this.indexPath(id), async () => {
      while (true) {
        const plan = await this.load(id);
        const selected = currentStep(plan);
        if (!canActivate() || isTerminal(plan.status) || !selected || selected.status === "In Progress") return plan;
        const activated = await withFileMutationQueue(selected.path, async () => {
          // A queued editor may have completed, reordered or changed this step.
          // Reload the whole plan under the target lock before choosing to write.
          const fresh = await this.load(id);
          const next = currentStep(fresh);
          if (!canActivate() || isTerminal(fresh.status) || !next || next.status === "In Progress") return fresh;
          if (next.path !== selected.path) return undefined;
          const text = (await this.files.readFile(next.path)).toString("utf8");
          await this.files.writeFile(next.path, replaceStatus(text, next.path, "In Progress"));
          return this.load(id);
        });
        if (activated) return activated;
        // Selection changed: release the previous target queue before retrying.
      }
    });
  }

  async list(): Promise<Plan[]> {
    let entries: string[];
    try { entries = await this.files.readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const plans: Plan[] = [];
    for (const id of entries.sort()) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) continue;
      if ((await this.files.stat(this.directory(id))).isDirectory()) plans.push(await this.load(id));
    }
    return plans;
  }

  async preparePlan(id: string, name = id): Promise<PreparedDocument> {
    const path = this.indexPath(id);
    const content = this.preparationContent(name, "plan");
    return withFileMutationQueue(path, async () => {
      await this.files.mkdir(this.root, { recursive: true });
      // Atomic directory creation refuses existing plans, including symlink aliases.
      await this.files.mkdir(this.directory(id));
      await this.files.writeFile(path, content);
      return { path, content };
    });
  }

  async prepareStep(planId: string, stepId: string, order: number, name = stepId): Promise<PreparedDocument> {
    validateId(stepId);
    if (/^\d{4,}-/.test(stepId)) throw new Error("Step preparation name must be unprefixed; pass the name without its numeric order prefix.");
    if (!Number.isSafeInteger(order) || order < 1) throw new Error("Step order must be a positive integer.");
    const stepIdForPath = String(order).padStart(4, "0");
    const path = join(this.directory(planId), `STEP-${stepIdForPath}`, "INDEX.md");
    const content = this.preparationContent(name, "step", { order });
    return withFileMutationQueue(this.indexPath(planId), async () => {
      const plan = await this.load(planId);
      if (plan.steps.some((step) => step.order === order || step.id === stepIdForPath)) throw new Error(`Step order ${order} already exists in plan ${planId}.`);
      const folder = dirname(path);
      if ((await this.files.readdir(this.directory(planId))).includes(basename(folder))) throw new Error(`Refusing to overwrite existing step directory: ${folder}`);
      await this.files.mkdir(folder);
      await this.files.writeFile(path, content);
      return { path, content };
    });
  }

  async prepareHandoff(planId: string, fromStepId: string, toStepId: string, handoffId = fromStepId): Promise<PreparedDocument> {
    validateId(fromStepId);
    validateId(toStepId);
    const file = `HANDOFF-${validateId(handoffId)}.md`;
    return withFileMutationQueue(this.indexPath(planId), async () => {
      const plan = await this.load(planId);
      const from = plan.steps.find((step) => step.id === fromStepId);
      const to = plan.steps.find((step) => step.id === toStepId);
      if (!from || !to) throw new Error("Handoff source and target steps must exist in the parent plan.");
      const path = join(from.directory ?? this.directory(planId), file);
      const content = serializeMarkdown({
        metadata: { from_step: from.id, from_order: from.order, to_step: to.id, to_order: to.order },
        body: "\n<!-- Write the handoff context here. -->\n",
      });
      return this.prepareDocument(path, content);
    });
  }

  async prepareProgress(planId: string, stepId: string): Promise<PreparedDocument> {
    validateId(stepId);
    return withFileMutationQueue(this.indexPath(planId), async () => {
      const plan = await this.load(planId);
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step) throw new Error(`Step ${stepId} does not exist in plan ${planId}.`);
      if (!step.directory) throw new Error(`Step ${stepId} is a legacy flat file; migrate it to a step directory before preparing PROGRESS.`);
      return withFileMutationQueue(step.path, async () => {
        const fresh = await this.load(planId);
        const current = fresh.steps.find((s) => s.id === stepId);
        if (!current?.directory) throw new Error(`Step ${stepId} changed while preparing PROGRESS.`);
        const max = current.progress.at(-1)?.sequence ?? 0;
        if (max >= Number.MAX_SAFE_INTEGER) throw new Error("PROGRESS sequence overflow.");
        const sequence = max + 1;
        const path = join(current.directory, `PROGRESS-${String(sequence).padStart(4, "0")}.md`);
        const content = serializeMarkdown({ metadata: { sequence }, body: "\n<!-- Write the progress context here. -->\n" });
        return this.prepareDocument(path, content);
      });
    });
  }

  private preparationContent(name: string, kind: "plan" | "step", extra: Record<string, unknown> = {}): string {
    if (!name.trim()) throw new Error("Display name must not be empty.");
    return serializeMarkdown({
      metadata: { name, ...extra, description: "", status: "Pending" },
      body: `\n<!-- Write the ${kind} content here. -->\n`,
    });
  }

  private async prepareDocument(path: string, content: string): Promise<PreparedDocument> {
    return withFileMutationQueue(path, async () => {
      // Directory entries also catch directories and dangling symlinks, unlike stat.
      if ((await this.files.readdir(dirname(path))).includes(basename(path))) throw new Error(`Refusing to overwrite existing document: ${path}`);
      await this.files.writeFile(path, content);
      return { path, content };
    });
  }

  async updateStepStatus(planId: string, stepId: string, status: Status): Promise<void> {
    validateId(stepId);
    await withFileMutationQueue(this.indexPath(planId), async () => {
      const step = (await this.load(planId)).steps.find((candidate) => candidate.id === stepId);
      if (!step) throw new Error(`Step ${stepId} does not exist in plan ${planId}.`);
      await withFileMutationQueue(step.path, async () => {
        const fresh = (await this.load(planId)).steps.find((candidate) => candidate.id === stepId);
        if (!fresh || fresh.path !== step.path) throw new Error(`Step ${stepId} changed during status update.`);
        const text = (await this.files.readFile(step.path)).toString("utf8");
        await this.files.writeFile(step.path, replaceStatus(text, step.path, status));
      });
    });
  }
  async updateIndex(id: string, metadata: Record<string, unknown>, canUpdate: (doc: MarkdownDocument) => boolean = () => true): Promise<void> {
    if (Object.keys(metadata).length !== 1 || !STATUSES.includes(metadata.status as Status)) {
      throw new Error("INDEX metadata is immutable; only a valid status update is allowed. Use LOOP-STATE.json for runtime state.");
    }
    const path = this.indexPath(id);
    await withFileMutationQueue(path, async () => {
      const doc = await this.read(path);
      if (!canUpdate(doc)) return;
      const text = (await this.files.readFile(path)).toString("utf8");
      await this.files.writeFile(path, replaceStatus(text, path, metadata.status as Status));
    });
  }
}