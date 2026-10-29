import type { Plan } from "./plan-store.ts";

export type LoopState = {
	planId: string;
	iteration: number;
	itemsPerIteration: number;
	maxIterations: number;
	reflectEvery: number;
};
export type LoopOptions = Partial<Pick<LoopState, "itemsPerIteration" | "maxIterations" | "reflectEvery">>;
type ParsedBuildArgs = { planId: string; options: LoopOptions };

function numberOption(value: unknown, fallback: number, minimum = 0): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new Error(`Loop options must be integers >= ${minimum}.`);
	return value;
}
export function createLoopState(
	plan: Plan,
	options: LoopOptions = {},
	resume = false,
	persisted?: LoopState,
): LoopState {
	// LOOP-STATE.json is authoritative; old INDEX fields are a read-only fallback.
	const saved = persisted ? loopMetadata(persisted) : plan.metadata;
	const iteration = numberOption(saved.iteration, 1, 1) + (resume ? 1 : 0);
	if (!Number.isSafeInteger(iteration)) throw new Error("Loop iteration exceeds the safe integer range.");
	return {
		planId: plan.id,
		iteration,
		itemsPerIteration: numberOption(options.itemsPerIteration ?? saved.items_per_iteration, 1),
		maxIterations: numberOption(options.maxIterations ?? saved.max_iterations, Math.max(50, plan.steps.length * 5)),
		reflectEvery: numberOption(options.reflectEvery ?? saved.reflect_every, 0),
	};
}
export function loopMetadata(state: LoopState): Record<string, unknown> {
	return {
		iteration: state.iteration,
		items_per_iteration: state.itemsPerIteration,
		max_iterations: state.maxIterations,
		reflect_every: state.reflectEvery,
	};
}
export function formatLoop(state: LoopState): string {
	return `${state.planId}: iteration ${state.iteration}${state.maxIterations ? `/${state.maxIterations}` : ""}`;
}
export function parseBuildArgs(args: string): ParsedBuildArgs {
	const [planId, ...tokens] = args.trim().split(/\s+/);
	if (!planId)
		throw new Error(
			"Usage: /planner build <plan-name> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
		);
	const keys: Record<string, keyof LoopOptions> = {
		"--items-per-iteration": "itemsPerIteration",
		"--reflect-every": "reflectEvery",
		"--max-iterations": "maxIterations",
	};
	const options: LoopOptions = {};
	for (let i = 0; i < tokens.length; i += 2) {
		const key = keys[tokens[i]];
		if (!key || !/^\d+$/.test(tokens[i + 1] ?? "")) throw new Error(`Invalid option: ${tokens[i]}`);
		options[key] = numberOption(Number(tokens[i + 1]), 0);
	}
	return { planId, options };
}
