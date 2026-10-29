import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { type ToolFileStat, type ToolMkdirOptions, withFileMutationQueue } from "@greppleai/grip";
import { isMap, isScalar, parseDocument, stringify } from "yaml";
import type { LoopState } from "./loop-state.ts";

export const STATUSES = ["Pending", "In Progress", "Completed", "Skipped"] as const;
export type Status = (typeof STATUSES)[number];
export type MarkdownDocument = { metadata: Record<string, unknown>; body: string; path: string };
export type PreparedDocument = { path: string; content: string };
export type Progress = MarkdownDocument & { sequence: number };
export type Step = MarkdownDocument & {
	id: string;
	name: string;
	description: string;
	order: number;
	status: Status;
	directory?: string;
	progress: Progress[];
};
export type Handoff = MarkdownDocument & { fromStep: string; fromOrder: number; toStep: string; toOrder: number };
export type Plan = MarkdownDocument & {
	id: string;
	name: string;
	description: string;
	status: Status;
	steps: Step[];
	handoffs: Handoff[];
};
export interface FileOperations {
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string | Buffer): Promise<void>;
	mkdir(path: string, options?: ToolMkdirOptions): Promise<void>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<ToolFileStat>;
}
export type FrozenTemplates = { plan?: string; steps: Record<string, string> };
export type RuntimeState = { version: 1; loop: LoopState; frozen: FrozenTemplates };
type LoadedEntries = { steps: Step[]; handoffs: Handoff[] };
type PreparationKind = "plan" | "step";
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function validateId(id: string): string {
	if (!ID_PATTERN.test(id)) {
		throw new Error(
			"Names used in paths must be 1–80 letters, numbers, hyphens or underscores, starting with a letter or number.",
		);
	}
	return id;
}

export function parseMarkdown(text: string, path: string): MarkdownDocument {
	const match = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new Error(`${path}: expected YAML frontmatter.`);
	const yaml = parseDocument(match[1], { uniqueKeys: true });
	if (yaml.errors.length) throw new Error(`${path}: ${yaml.errors[0].message}`);
	const metadata: unknown = yaml.toJS();
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		throw new Error(`${path}: frontmatter must be a mapping.`);
	return {
		metadata: metadata as Record<string, unknown>,
		body: text.replace(/^\uFEFF/, "").slice(match[0].length),
		path,
	};
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
	if (
		fields.length !== 1 ||
		!isScalar(fields[0].value) ||
		!fields[0].value.range ||
		!STATUSES.includes(fields[0].value.value as Status)
	) {
		throw new Error(`${path}: status must be a single scalar status.`);
	}
	const value = fields[0].value;
	const [start, end] = value.range;
	const raw = match[1].slice(start, end);
	if (raw.includes("\n") || raw.includes("\r")) throw new Error(`${path}: multiline status is unsupported.`);
	const offset = text.length - withoutBom.length + match[0].indexOf(match[1]);
	const replacement = raw.startsWith("'")
		? `'${status.replaceAll("'", "''")}'`
		: raw.startsWith('"')
			? JSON.stringify(status)
			: status;
	return text.slice(0, offset + start) + replacement + text.slice(offset + end);
}

function textField(doc: MarkdownDocument, key: string, allowEmpty = false): string {
	const value = doc.metadata[key];
	if (typeof value !== "string" || (!allowEmpty && !value.trim()))
		throw new Error(`${doc.path}: ${key} must be a string${allowEmpty ? "" : " (not empty)"}.`);
	return value;
}
function orderField(doc: MarkdownDocument, key: string): number {
	const value = doc.metadata[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error(`${doc.path}: ${key} must be a positive integer.`);
	return value;
}
function statusField(doc: MarkdownDocument): Status {
	const value = doc.metadata.status;
	if (!STATUSES.includes(value as Status)) throw new Error(`${doc.path}: status must be ${STATUSES.join(", ")}.`);
	return value as Status;
}
export function isTerminal(status: Status): boolean {
	return status === "Completed" || status === "Skipped";
}
export function currentStep(plan: Plan): Step | undefined {
	return (
		plan.steps.find((step) => step.status === "In Progress") ?? plan.steps.find((step) => step.status === "Pending")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStateNumber(value: unknown, minimum: number): boolean {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function isHash(value: unknown): boolean {
	return typeof value === "string" && HASH_PATTERN.test(value);
}
function isLoopState(value: unknown, planId: string): value is LoopState {
	if (!isRecord(value)) return false;
	return (
		value.planId === planId &&
		isStateNumber(value.iteration, 1) &&
		isStateNumber(value.itemsPerIteration, 0) &&
		isStateNumber(value.maxIterations, 0) &&
		isStateNumber(value.reflectEvery, 0)
	);
}
function isFrozenTemplates(value: unknown): value is FrozenTemplates {
	if (!isRecord(value) || !isRecord(value.steps)) return false;
	if (value.plan !== undefined && !isHash(value.plan)) return false;
	return Object.entries(value.steps).every(([key, hash]) => ID_PATTERN.test(key) && isHash(hash));
}
function isRuntimeState(value: unknown, planId: string): value is RuntimeState {
	if (!isRecord(value) || value.version !== 1) return false;
	return isLoopState(value.loop, planId) && isFrozenTemplates(value.frozen);
}
function assertUniqueSteps(directory: string, steps: Step[]): void {
	if (
		new Set(steps.map((step) => step.order)).size !== steps.length ||
		new Set(steps.map((step) => step.id)).size !== steps.length
	)
		throw new Error(`${directory}: step IDs and orders must be unique.`);
	if (steps.filter((step) => step.status === "In Progress").length > 1)
		throw new Error(`${directory}: only one step may be In Progress.`);
}
function assertHandoffEndpoints(steps: Step[], handoffs: Handoff[]): void {
	const stepsById = new Map(steps.map((step) => [step.id, step]));
	for (const handoff of handoffs) {
		const from = stepsById.get(handoff.fromStep);
		const to = stepsById.get(handoff.toStep);
		if (!from || !to || from.order !== handoff.fromOrder || to.order !== handoff.toOrder)
			throw new Error(`${handoff.path}: handoff step names/orders do not match the plan.`);
	}
}

export class PlanStore {
	readonly root: string;
	private readonly files: FileOperations;
	constructor(cwd: string, files: FileOperations) {
		this.root = resolve(cwd, ".planner");
		this.files = files;
	}
	directory(id: string): string {
		return join(this.root, validateId(id));
	}
	indexPath(id: string): string {
		return join(this.directory(id), "INDEX.md");
	}
	runtimePath(id: string): string {
		return join(this.directory(id), "LOOP-STATE.json");
	}
	async read(path: string): Promise<MarkdownDocument> {
		return parseMarkdown((await this.files.readFile(path)).toString("utf8"), path);
	}

	async readRuntime(id: string): Promise<RuntimeState | undefined> {
		const path = this.runtimePath(id);
		if (!(await this.files.readdir(this.directory(id))).includes("LOOP-STATE.json")) return undefined;
		if (!(await this.files.stat(path)).isFile()) throw new Error(`${path}: runtime state must be a file.`);
		let raw: unknown;
		try {
			raw = JSON.parse((await this.files.readFile(path)).toString("utf8"));
		} catch (error) {
			throw new Error(`${path}: invalid runtime JSON: ${String(error)}`);
		}
		if (!isRuntimeState(raw, id)) throw new Error(`${path}: invalid runtime state.`);
		return raw;
	}

	async saveRuntime(id: string, state: RuntimeState, canWrite: () => boolean = () => true): Promise<void> {
		await withFileMutationQueue(this.indexPath(id), async () => {
			if (!canWrite()) return;
			const path = this.runtimePath(id);
			// Never confuse a directory or dangling symlink with an absent state file.
			if (
				(await this.files.readdir(this.directory(id))).includes("LOOP-STATE.json") &&
				!(await this.files.stat(path)).isFile()
			) {
				throw new Error(`${path}: runtime state must be a file.`);
			}
			if (!canWrite()) return;
			await this.files.writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
		});
	}

	private async templateHash(path: string): Promise<string> {
		const text = (await this.files.readFile(path)).toString("utf8");
		return createHash("sha256")
			.update(replaceStatus(text, path, "Pending"))
			.digest("hex");
	}

	async checkTemplates(plan: Plan, runtime?: RuntimeState): Promise<void> {
		if (!runtime) return;
		if (runtime.frozen.plan && runtime.frozen.plan !== (await this.templateHash(plan.path)))
			throw new Error(`${plan.path}: frozen plan INDEX instructions changed.`);
		const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
		for (const [id, hash] of Object.entries(runtime.frozen.steps)) {
			const step = stepsById.get(id);
			if (!step?.directory || hash !== (await this.templateHash(step.path)))
				throw new Error(`${id}: frozen step INDEX instructions changed.`);
		}
	}

	async freezeTemplates(plan: Plan, runtime?: RuntimeState): Promise<FrozenTemplates> {
		await this.checkTemplates(plan, runtime);
		const frozen = { plan: runtime?.frozen.plan, steps: { ...runtime?.frozen.steps } };
		if (!frozen.plan && plan.steps.some((step) => step.directory)) frozen.plan = await this.templateHash(plan.path);
		const selected = currentStep(plan);
		if (selected?.directory && !frozen.steps[selected.id])
			frozen.steps[selected.id] = await this.templateHash(selected.path);
		return frozen;
	}

	private async readProgress(directory: string): Promise<Progress[]> {
		const progress: Progress[] = [];
		const sequences = new Set<number>();
		for (const entry of (await this.files.readdir(directory)).sort()) {
			if (!entry.startsWith("PROGRESS-")) continue;
			const match = /^PROGRESS-(\d{4,})\.md$/.exec(entry);
			if (!match) throw new Error(`${directory}/${entry}: malformed progress filename.`);
			const path = join(directory, entry);
			if (!(await this.files.stat(path)).isFile()) throw new Error(`${path}: progress must be a file.`);
			const doc = await this.read(path);
			const sequence = orderField(doc, "sequence");
			if (match[1] !== String(sequence).padStart(4, "0"))
				throw new Error(`${path}: progress filename must match sequence ${sequence}.`);
			if (sequences.has(sequence)) throw new Error(`${path}: duplicate progress sequence.`);
			sequences.add(sequence);
			progress.push({ ...doc, sequence });
		}
		return progress.sort((a, b) => a.sequence - b.sequence);
	}

	async load(id: string): Promise<Plan> {
		const directory = this.directory(id);
		const index = await this.read(this.indexPath(id));
		const { steps, handoffs } = await this.loadEntries(directory);
		steps.sort((a, b) => a.order - b.order);
		assertUniqueSteps(directory, steps);
		assertHandoffEndpoints(steps, handoffs);
		handoffs.sort((a, b) => a.path.localeCompare(b.path));
		return {
			...index,
			id,
			name: textField(index, "name"),
			description: textField(index, "description", true),
			status: statusField(index),
			steps,
			handoffs,
		};
	}

	private async loadEntries(directory: string): Promise<LoadedEntries> {
		const steps: Step[] = [];
		const handoffs: Handoff[] = [];
		for (const filename of (await this.files.readdir(directory)).sort()) {
			const entry = await this.loadEntry(directory, filename);
			steps.push(...entry.steps);
			handoffs.push(...entry.handoffs);
		}
		return { steps, handoffs };
	}

	private async loadEntry(directory: string, filename: string): Promise<LoadedEntries> {
		if (filename.startsWith("STEP-") && filename.endsWith(".md"))
			return { steps: [await this.loadFlatStep(directory, filename)], handoffs: [] };
		if (filename.startsWith("STEP-")) return this.loadDirectoryStep(directory, filename);
		if (filename.startsWith("HANDOFF-") && filename.endsWith(".md")) {
			validateId(filename.slice(8, -3));
			return { steps: [], handoffs: [await this.readHandoff(join(directory, filename))] };
		}
		return { steps: [], handoffs: [] };
	}

	private async loadFlatStep(directory: string, filename: string): Promise<Step> {
		const stepId = validateId(filename.slice(5, -3));
		const doc = await this.read(join(directory, filename));
		const order = orderField(doc, "order");
		const prefix = stepId.match(/^(\d{4,})-/)?.[1];
		if (prefix && prefix !== String(order).padStart(4, "0")) {
			throw new Error(
				`${doc.path}: numbered filename prefix must match order ${order} as ${String(order).padStart(4, "0")}; rename the file and update handoff IDs/orders together.`,
			);
		}
		return {
			...doc,
			id: stepId,
			name: textField(doc, "name"),
			description: textField(doc, "description", true),
			order,
			status: statusField(doc),
			progress: [],
		};
	}

	private async loadDirectoryStep(directory: string, filename: string): Promise<LoadedEntries> {
		const stepId = filename.slice(5);
		const path = join(directory, filename);
		if (!/^\d{4,}$/.test(stepId) || !(await this.files.stat(path)).isDirectory())
			throw new Error(`${path}: malformed step directory; expected STEP-<padded-order>/INDEX.md.`);
		const doc = await this.read(join(path, "INDEX.md"));
		const order = orderField(doc, "order");
		if (stepId !== String(order).padStart(4, "0"))
			throw new Error(`${path}: step directory must match order ${order}.`);
		const progress = await this.readProgress(path);
		const step: Step = {
			...doc,
			id: validateId(stepId),
			name: textField(doc, "name"),
			description: textField(doc, "description", true),
			order,
			status: statusField(doc),
			directory: path,
			progress,
		};
		const handoffs: Handoff[] = [];
		for (const entry of (await this.files.readdir(path)).sort()) {
			if (!entry.startsWith("HANDOFF-")) continue;
			if (!/^HANDOFF-[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.md$/.test(entry))
				throw new Error(`${path}/${entry}: malformed handoff filename.`);
			handoffs.push(await this.readHandoff(join(path, entry), stepId));
		}
		return { steps: [step], handoffs };
	}

	private async readHandoff(path: string, source?: string): Promise<Handoff> {
		if (!(await this.files.stat(path)).isFile()) throw new Error(`${path}: handoff must be a file.`);
		const doc = await this.read(path);
		const fromStep = validateId(textField(doc, "from_step"));
		if (source && fromStep !== source) throw new Error(`${path}: handoff source does not match its step directory.`);
		return {
			...doc,
			fromStep,
			fromOrder: orderField(doc, "from_order"),
			toStep: validateId(textField(doc, "to_step")),
			toOrder: orderField(doc, "to_order"),
		};
	}

	async activateStep(id: string, canActivate: () => boolean = () => true): Promise<Plan> {
		return withFileMutationQueue(this.indexPath(id), async () => {
			while (true) {
				const plan = await this.load(id);
				const selected = currentStep(plan);
				if (!canActivate() || isTerminal(plan.status) || !selected || selected.status === "In Progress")
					return plan;
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
		try {
			entries = await this.files.readdir(this.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
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
		if (/^\d{4,}-/.test(stepId))
			throw new Error("Step preparation name must be unprefixed; pass the name without its numeric order prefix.");
		if (!Number.isSafeInteger(order) || order < 1) throw new Error("Step order must be a positive integer.");
		const stepIdForPath = String(order).padStart(4, "0");
		const path = join(this.directory(planId), `STEP-${stepIdForPath}`, "INDEX.md");
		const content = this.preparationContent(name, "step", { order });
		return withFileMutationQueue(this.indexPath(planId), async () => {
			const plan = await this.load(planId);
			if (plan.steps.some((step) => step.order === order || step.id === stepIdForPath))
				throw new Error(`Step order ${order} already exists in plan ${planId}.`);
			const folder = dirname(path);
			if ((await this.files.readdir(this.directory(planId))).includes(basename(folder)))
				throw new Error(`Refusing to overwrite existing step directory: ${folder}`);
			await this.files.mkdir(folder);
			await this.files.writeFile(path, content);
			return { path, content };
		});
	}

	async prepareHandoff(
		planId: string,
		fromStepId: string,
		toStepId: string,
		handoffId = fromStepId,
	): Promise<PreparedDocument> {
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
			if (!step.directory)
				throw new Error(
					`Step ${stepId} is a legacy flat file; migrate it to a step directory before preparing PROGRESS.`,
				);
			return withFileMutationQueue(step.path, async () => {
				const fresh = await this.load(planId);
				const current = fresh.steps.find((s) => s.id === stepId);
				if (!current?.directory) throw new Error(`Step ${stepId} changed while preparing PROGRESS.`);
				const max = current.progress.at(-1)?.sequence ?? 0;
				if (max >= Number.MAX_SAFE_INTEGER) throw new Error("PROGRESS sequence overflow.");
				const sequence = max + 1;
				const path = join(current.directory, `PROGRESS-${String(sequence).padStart(4, "0")}.md`);
				const content = serializeMarkdown({
					metadata: { sequence },
					body: "\n<!-- Write the progress context here. -->\n",
				});
				return this.prepareDocument(path, content);
			});
		});
	}

	private preparationContent(name: string, kind: PreparationKind, extra: Record<string, unknown> = {}): string {
		if (!name.trim()) throw new Error("Display name must not be empty.");
		return serializeMarkdown({
			metadata: { name, ...extra, description: "", status: "Pending" },
			body: `\n<!-- Write the ${kind} content here. -->\n`,
		});
	}

	private async prepareDocument(path: string, content: string): Promise<PreparedDocument> {
		return withFileMutationQueue(path, async () => {
			// Directory entries also catch directories and dangling symlinks, unlike stat.
			if ((await this.files.readdir(dirname(path))).includes(basename(path)))
				throw new Error(`Refusing to overwrite existing document: ${path}`);
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
	async updateIndex(
		id: string,
		metadata: Record<string, unknown>,
		canUpdate: (doc: MarkdownDocument) => boolean = () => true,
	): Promise<void> {
		if (Object.keys(metadata).length !== 1 || !STATUSES.includes(metadata.status as Status)) {
			throw new Error(
				"INDEX metadata is immutable; only a valid status update is allowed. Use LOOP-STATE.json for runtime state.",
			);
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
