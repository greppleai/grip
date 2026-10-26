import { describe, expect, test } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
			expect(prompt).toContain("## Guidelines");
			expect(prompt).not.toContain("## Skills");
			expect(prompt).not.toContain("<available_skills>");
			expect(prompt).not.toContain("## Jobs");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
					websearch: "Search the web",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).not.toContain("- edit:");
			expect(prompt).toContain("- write:");
			expect(prompt).toContain("- websearch:");
			expect(prompt).toContain(
				"Use bash for shell commands; follow project-specific instructions for repository file operations",
			);
		});

		test("instructs models to resolve grip docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading grip docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("You are an expert coding assistant operating inside grip");
			expect(prompt).toContain("## Grip documentation");
			expect(prompt).toContain("adding models (docs/models.md), grip packages (docs/packages.md)");
			expect(prompt).not.toContain("operating inside pi");
			expect(prompt).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
		});
		test("keeps rules visible when bash replaces read as the default file access tool", () => {
			const filePath = "/example/RULES.md";
			const rules = [
				{
					name: "example-rule",
					description: "Required rule",
					filePath,
					baseDir: "/example",
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const prompt = buildSystemPrompt({ cwd: process.cwd(), rules });
			expect(prompt).toContain("<name>example-rule</name>");
			expect(prompt).toContain("Load a rule's file with an available workspace tool");
			expect(buildSystemPrompt({ cwd: process.cwd(), selectedTools: [], rules })).not.toContain("<available_rules>");
		});
	});

	describe("skill discovery", () => {
		const skill = {
			name: "sample-skill",
			description: "A skill for prompt tests.",
			filePath: "/example/SKILL.md",
			baseDir: "/example",
			sourceInfo: {
				path: "/example/SKILL.md",
				source: "test",
				scope: "temporary" as const,
				origin: "top-level" as const,
			},
			disableModelInvocation: false,
		};

		test("lists skills by name when load_skill is available even without read", () => {
			const prompt = buildSystemPrompt({ selectedTools: ["load_skill"], skills: [skill], cwd: process.cwd() });
			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>sample-skill</name>");
			expect(prompt).toContain("Use load_skill with a skill name");
			expect(prompt).not.toContain("<location>");
		});

		test("keeps visible skills and brief parent job guidance in order without a preset catalog", () => {
			const guidance =
				"Delegate a bounded outcome; verify its evidence and remain responsible for the final answer.";
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "load_skill", "job"],
				skills: [skill],
				jobGuidance: guidance,
				cwd: process.cwd(),
			});
			const positions = [
				prompt.indexOf("## Guidelines"),
				prompt.indexOf("## Skills"),
				prompt.indexOf("## Jobs"),
				prompt.indexOf("## Grip documentation"),
			];
			expect(positions.every((position) => position >= 0)).toBe(true);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
			expect(prompt).toContain(`## Jobs\n${guidance}`);
			expect(prompt).not.toContain("<available_jobs>");
		});

		test("keeps short job guidance for a custom prompt only when job is enabled", () => {
			const options = {
				customPrompt: "Custom system instructions.",
				jobGuidance: "Use job for a bounded outcome.",
				cwd: process.cwd(),
			};
			const withJob = buildSystemPrompt({ ...options, selectedTools: ["read", "job"] });
			expect(withJob).toContain("## Jobs\nUse job for a bounded outcome.");
			expect(withJob).not.toContain("<available_jobs>");
			const withoutJob = buildSystemPrompt({ ...options, selectedTools: ["read"] });
			expect(withoutJob).not.toContain("## Jobs");
		});

		test("does not list skills if load_skill is unavailable", () => {
			const prompt = buildSystemPrompt({ selectedTools: ["read"], skills: [skill], cwd: process.cwd() });
			expect(prompt).not.toContain("<available_skills>");
		});
	});
	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("state compression", () => {
		test("gives concrete compression checkpoints without exposing utilization when the tool is active", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "compress_context"],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("## State compression");
			expect(prompt).toContain("Consider compress_context at concrete checkpoints");
			expect(prompt).toContain("when the user switches tasks");
			expect(prompt).toContain("an implementation slice is complete");
			expect(prompt).toContain("validation has finished");
			expect(prompt).toContain("do not wait for a context percentage or an explicit request");
			expect(prompt).toContain("does not receive a context-utilization percentage");
			expect(prompt).toContain("urgency score");
			expect(prompt).not.toContain("35%");
			expect(prompt).not.toContain("50%");
			expect(prompt).toContain("model-only context metadata after user messages and completed tool-call batches");
			expect(prompt).toContain("session entry IDs but no utilization estimate");
			expect(prompt).toContain("tool-result IDs are for lookup, not cuts");
			expect(prompt).toContain("Turn batches of reads, searches, builds, and tests into concise state");
			expect(prompt).toContain("what passed or failed (including relevant errors)");
			expect(prompt).toContain("Choose a cut point from the entry IDs already visible in context metadata");
			expect(prompt).toContain("Pass startEntryId and a summary");
			expect(prompt).toContain("inclusive endEntryId");
			expect(prompt).toContain("Detector-suggested IDs are advisory");
			expect(prompt).toContain("Do not send a list of IDs.");
			expect(prompt).toContain("Call compress_context alone");
		});

		test("omits compression guidance when the tool is unavailable", () => {
			const prompt = buildSystemPrompt({ selectedTools: ["read"], cwd: process.cwd() });
			expect(prompt).not.toContain("## State compression");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
