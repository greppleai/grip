/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatRulesForPrompt, type Rule } from "./rules.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

// grip-ignore noNearIdenticalDataStructures: System-prompt context requires loaded file content, while the interactive status fixture is display-only and permits path-only entries.
export interface SystemPromptContextFile {
	path: string;
	content: string;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write, load_skill] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Built-in subagent catalog and guidance, when the built-in tool is active. */
	subagentPrompt?: SubagentPromptParts;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: SystemPromptContextFile[];
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Pre-loaded rules. */
	rules?: Rule[];
}

export interface SubagentPromptParts {
	catalog: string;
	guidance: string;
}
interface SystemPromptFinalizationOptions {
	appendSystemPrompt?: string;
	subagentPrompt?: SubagentPromptParts;
	includeGripDocumentation: boolean;
	promptCwd: string;
	date: string;
	contextFiles: SystemPromptContextFile[];
	skills: Skill[];
	rules: Rule[];
	hasRead: boolean;
	hasLoadSkill: boolean;
}

function getCurrentPromptDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function appendUniqueGuideline(guidelines: string[], seen: Set<string>, guideline: string): void {
	if (seen.has(guideline)) return;
	seen.add(guideline);
	guidelines.push(guideline);
}

function formatPromptGuidelines(tools: string[], additionalGuidelines: string[] | undefined): string {
	const guidelines: string[] = [];
	const seen = new Set<string>();
	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		appendUniqueGuideline(
			guidelines,
			seen,
			"Use bash for shell commands; follow project-specific instructions for repository file operations",
		);
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		appendUniqueGuideline(
			guidelines,
			seen,
			"Prefer grep/find/ls tools over bash for file exploration unless project instructions specify another workflow (faster, respects .gitignore)",
		);
	}
	for (const guideline of additionalGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) appendUniqueGuideline(guidelines, seen, normalized);
	}
	appendUniqueGuideline(guidelines, seen, "Be concise in your responses");
	appendUniqueGuideline(guidelines, seen, "Show file paths clearly when working with files");
	return guidelines.map((guideline) => `- ${guideline}`).join("\n");
}

function formatAvailableTools(tools: string[], toolSnippets: Record<string, string> | undefined): string {
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	return visibleTools.length > 0
		? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
		: "(none)";
}

function buildDefaultSystemPrompt(options: BuildSystemPromptOptions, tools: string[]): string {
	const toolsList = formatAvailableTools(tools, options.toolSnippets);
	const guidelines = formatPromptGuidelines(tools, options.promptGuidelines);
	const stateCompressionSection = tools.includes("compress_context")
		? `### State compression
Consider compress_context at concrete checkpoints: when the user switches tasks, an investigation has yielded stable findings, an implementation slice is complete, or validation has finished and its raw logs are no longer needed. If older tool output or intermediate reasoning can be replaced by a concise account of decisions and current state, compress before starting the next slice; do not wait for a context percentage or an explicit request. Keep the active work and details needed for the next step intact. Do not compress a trivial exchange or interrupt an ongoing investigation, edit, or test.

The primary agent does not receive a context-utilization percentage. A background detector may send an advisory with an urgency score; treat it as a cue to evaluate the next safe checkpoint, not an instruction to compress immediately.

You receive model-only context metadata after user messages and completed tool-call batches, with session entry IDs but no utilization estimate. Use a user or assistant tool-call entry ID as a compression cut point; tool-result IDs are for lookup, not cuts. Do not repeat this metadata to the user.

Turn batches of reads, searches, builds, and tests into concise state: findings and decisions, changed files, what passed or failed (including relevant errors), unresolved issues, and concrete next steps. Preserve important user instructions and constraints. Omit redundant tool output rather than carrying it forward.

Choose a cut point from the entry IDs already visible in context metadata. Pass startEntryId and a summary to replace through the current tail, or add inclusive endEntryId to replace an older bounded range while retaining later messages. Never split a tool call from its results. Detector-suggested IDs are advisory; verify the range yourself before acting. Do not send a list of IDs. Call compress_context alone, not alongside other tools. session_search defaults to current model context; scope: branch/all retrieves historical entries for reference, not necessarily valid compression cut points.`
		: "";
	return `You are an expert coding assistant operating inside grip, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

## Guidelines
${guidelines}${stateCompressionSection ? `\n\n${stateCompressionSection}` : ""}`;
}

function formatGripDocumentation(): string {
	return `## Grip documentation
Read these docs only when the user asks about grip itself, its SDK, extensions, themes, skills, or TUI:
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading grip docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), type TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), grip packages (docs/packages.md)
- When working on grip topics, read the docs and examples, and follow .md cross-references before implementing
- Always read grip .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}

function finalizeSystemPrompt(prompt: string, options: SystemPromptFinalizationOptions): string {
	if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
	if (options.contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path, content } of options.contextFiles) {
			prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}
	if (options.hasRead && options.rules.length > 0) prompt += formatRulesForPrompt(options.rules);
	if (options.hasLoadSkill) {
		const skillCatalog = formatSkillsForPrompt(options.skills);
		if (skillCatalog) prompt += `\n\n## Skills${skillCatalog}`;
	}
	if (options.subagentPrompt?.catalog) prompt += `\n\n${options.subagentPrompt.catalog}`;
	if (options.subagentPrompt?.guidance) prompt += `\n\n## Subagents\n${options.subagentPrompt.guidance}`;
	if (options.includeGripDocumentation) prompt += `\n\n${formatGripDocumentation()}`;
	prompt += `\nCurrent date: ${options.date}`;
	prompt += `\nCurrent working directory: ${options.promptCwd}`;
	return prompt;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools || ["read", "bash", "edit", "write", "load_skill"];
	const basePrompt = options.customPrompt || buildDefaultSystemPrompt(options, tools);
	return finalizeSystemPrompt(basePrompt, {
		includeGripDocumentation: !options.customPrompt,
		subagentPrompt: options.subagentPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		promptCwd: options.cwd.replace(/\\/g, "/"),
		date: getCurrentPromptDate(),
		contextFiles: options.contextFiles ?? [],
		skills: options.skills ?? [],
		rules: options.rules ?? [],
		hasRead: !options.selectedTools || tools.includes("read"),
		hasLoadSkill: tools.includes("load_skill"),
	});
}
