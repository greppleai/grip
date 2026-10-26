import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@greppleai/grip-ai";
import { afterEach, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createJobToolDefinition } from "../src/core/tools/job.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";

const temporaryDirectories: string[] = [];
function createContext(): ExtensionContext {
	const cwd = mkdtempSync(join(tmpdir(), "grip-job-handoff-"));
	temporaryDirectories.push(cwd);
	return { cwd, toolOperations: new LocalToolOperations(cwd), hasUI: false } as unknown as ExtensionContext;
}
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("reports child execution context to the parent without changing the child's answer", async () => {
	const context = createContext();
	const definition = createJobToolDefinition({
		runner: async (request) => {
			request.onMessage(fauxAssistantMessage("child answer"));
			return {
				exitCode: 0,
				stderr: "",
				execution: {
					cwd: request.cwd,
					backend: "local",
					model: "faux/child",
					tools: ["bash"],
					preloadedSkills: ["grepple-write"],
				},
			};
		},
	});
	expect(definition.name).toBe("job");
	const result = await definition.execute(
		"handoff",
		{ task: "answer", tools: ["bash"], skills: ["grepple-write"] },
		undefined,
		undefined,
		context,
	);
	const output = result.content[0];
	expect(output).toMatchObject({ type: "text", text: expect.stringContaining('"backend":"local"') });
	if (output?.type !== "text") throw new Error("Expected text handoff");
	expect(output.text).toContain(`"cwd":${JSON.stringify(context.cwd)}`);
	expect(output.text).toContain('"model":"faux/child"');
	expect(output.text).toContain('"tools":["bash"]');
	expect(output.text).toContain('"preloadedSkills":["grepple-write"]');
	expect(output.text).toMatch(/child answer$/);
	expect(result.details.results[0].execution).toMatchObject({ cwd: context.cwd, model: "faux/child" });
});

it("attributes execution context to each parallel task and chain step, without copying it into {previous}", async () => {
	const context = createContext();
	const receivedTasks: string[] = [];
	const definition = createJobToolDefinition({
		runner: async (request) => {
			receivedTasks.push(request.task);
			request.onMessage(fauxAssistantMessage(`answer for ${request.task}`));
			return {
				exitCode: 0,
				stderr: "",
				execution: {
					cwd: request.cwd,
					backend: "local",
					model: "faux/child",
					tools: ["bash"],
					preloadedSkills: [],
				},
			};
		},
	});
	const first = join(context.cwd, "first");
	const second = join(context.cwd, "second");
	const parallel = await definition.execute(
		"parallel-handoff",
		{
			tasks: [
				{ task: "first", cwd: first },
				{ task: "second", cwd: second },
			],
		},
		undefined,
		undefined,
		context,
	);
	const parallelText = parallel.content[0];
	if (parallelText?.type !== "text") throw new Error("Expected parallel text handoff");
	expect(parallelText.text).toContain(`"cwd":${JSON.stringify(first)}`);
	expect(parallelText.text).toContain(`"cwd":${JSON.stringify(second)}`);
	expect(parallel.details.results.map((result) => result.execution?.cwd)).toEqual([first, second]);
	const chain = await definition.execute(
		"chain-handoff",
		{
			chain: [
				{ task: "step one", cwd: first },
				{ task: "use {previous}", cwd: second },
			],
		},
		undefined,
		undefined,
		context,
	);
	const chainText = chain.content[0];
	if (chainText?.type !== "text") throw new Error("Expected chain text handoff");
	expect(chainText.text).toContain(`Step 1: Execution: {"cwd":${JSON.stringify(first)}`);
	expect(chainText.text).toContain(`Step 2: Execution: {"cwd":${JSON.stringify(second)}`);
	expect(chainText.text).not.toContain("ad-hoc");
	expect(receivedTasks.at(-1)).toBe("use answer for step one");
	expect(receivedTasks.at(-1)).not.toContain("Execution:");
});
