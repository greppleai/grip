import { join, resolve } from "node:path";
import { getKeybindings, setKeybindings, Text, type TUI, visibleWidth } from "@greppleai/grip-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";

interface CapturedToolUpdateContent {
	type: string;
	text?: string;
}

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders a state-colored background cell without tinted panels or trailing padding", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"tool-status-line",
			{ path: "notes.ts", oldText: "old", newText: "new" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const pending = component.render(40).slice(1);
		expect(pending.length).toBeGreaterThan(1);
		expect(pending.every((line) => line.startsWith(theme.bgFromFg("muted", " ")))).toBe(true);
		expect(pending[0]).toBe(theme.bgFromFg("muted", " "));
		expect(stripAnsi(pending[0])).toBe(" ");
		expect(pending.every((line) => visibleWidth(line) <= 40)).toBe(true);

		component.updateResult({ content: [], details: {}, isError: false }, false);
		const success = component.render(40).slice(1);
		expect(success.every((line) => line.startsWith(theme.bgFromFg("success", " ")))).toBe(true);

		component.updateResult({ content: [], details: {}, isError: true }, false);
		const error = component.render(40).slice(1);
		expect(error.every((line) => line.startsWith(theme.bgFromFg("error", " ")))).toBe(true);
		expect(new Set([pending[0], success[0], error[0]]).size).toBe(3);
		for (const lines of [pending, success, error]) {
			expect(lines.every((line) => !line.endsWith(" "))).toBe(true);
			expect(lines.every((line) => (line.match(/\x1b\[48;/g)?.length ?? 0) === 1)).toBe(true);
			expect(lines.some((line) => visibleWidth(line) < 40)).toBe(true);
		}
		expect(
			component
				.render(1)
				.slice(1)
				.every((line) => visibleWidth(line) <= 1),
		).toBe(true);
	});

	test("renders the same status line before generic tool output", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-generic-line",
			{ foo: "bar" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = component.render(40).slice(1);
		expect(rendered.every((line) => line.startsWith(theme.bgFromFg("muted", " ")))).toBe(true);
		expect(rendered.every((line) => !line.endsWith(" "))).toBe(true);
		expect(rendered.some((line) => line.includes("custom_tool"))).toBe(true);
		expect(rendered.every((line) => (line.match(/\x1b\[48;/g)?.length ?? 0) === 1)).toBe(true);
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("renders load_skill like compact skill reads, expandable and with visible errors", async () => {
		const harness = await createHarness();
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		try {
			for (const name of ["first-skill", "second-skill"]) {
				harness.session.registerSessionSkill({
					name,
					description: name,
					filePath: `<${name}>`,
					baseDir: process.cwd(),
					disableModelInvocation: false,
					content: `# ${name} instructions\n`,
				});
			}
			const definition = harness.session.getToolDefinition("load_skill");
			expect(definition).toBeDefined();
			const args = { name: ["first-skill", "second-skill"] };
			const result = await definition!.execute(
				"tool-skill",
				args,
				undefined,
				undefined,
				harness.session.extensionRunner.createContext(),
			);
			const component = new ToolExecutionComponent(
				"load_skill",
				"tool-skill",
				args,
				{},
				definition,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({ ...result, isError: false }, false);
			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain("[skill] first-skill, second-skill");
			expect(collapsed).toContain("ctrl+o to expand");
			expect(collapsed).not.toContain("# first-skill instructions");
			expect(collapsed).not.toContain("# second-skill instructions");

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain("# first-skill instructions");
			expect(expanded).toContain("# second-skill instructions");
			expect(expanded).not.toContain("ctrl+o to expand");

			component.setExpanded(false);
			component.updateResult(
				{ content: [{ type: "text", text: "Skill not available: unknown" }], isError: true },
				false,
			);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("Skill not available: unknown");
		} finally {
			setKeybindings(previousKeybindings);
			harness.cleanup();
		}
	});
	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: CapturedToolUpdateContent[]; details?: unknown }> = [];
		const operations = new LocalToolOperations(process.cwd());
		operations.exec = async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { exitCode: 0 };
		};
		const tool = createBashToolDefinition(operations);
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: CapturedToolUpdateContent[]; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("colors bash commands separately from elapsed time and backend details", () => {
		const operations = new LocalToolOperations(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-colors",
			{ command: "echo hello", timeout: 115, output_mode: "on_fail" },
			{},
			createBashToolDefinition(operations),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		expect(component.render(120).join("\n")).toContain(theme.fg("accent", theme.bold("echo hello")));
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("timeout 115s");

		component.updateResult(
			{ content: [{ type: "text", text: "working" }], details: undefined, isError: false },
			true,
		);
		const partialLines = stripAnsi(component.render(120).join("\n")).split("\n");
		const elapsedLine = partialLines.find((line) => line.includes("Elapsed "));
		expect(elapsedLine).toContain("timeout 115s");
		expect(partialLines.findIndex((line) => line.includes("model output: on_fail"))).toBeGreaterThan(
			partialLines.findIndex((line) => line.includes("Elapsed ")),
		);

		component.updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false }, false);
		const success = component.render(120).join("\n");
		expect(success).toContain(`${theme.getFgAnsi("success")}Took `);
		expect(stripAnsi(success.split("\n").find((line) => line.includes("Took "))!)).toContain("timeout 115s");
		expect(success).toContain(theme.fg("muted", ` [local ${operations.cwd}]`));

		component.updateResult({ content: [{ type: "text", text: "failed" }], details: undefined, isError: true }, false);
		expect(component.render(120).join("\n")).toContain(`${theme.getFgAnsi("error")}Took `);
	});

	test("puts a highlighted hidden-line count after collapsed bash output and status", () => {
		const operations = new LocalToolOperations(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-preview",
			{ command: "produce lines", output_mode: "never" },
			{},
			createBashToolDefinition(operations),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		const output = Array.from({ length: 82 }, (_, index) => `entry-${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: undefined, isError: false }, false);

		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		try {
			const lines = component.render(120);
			const collapsed = stripAnsi(lines.join("\n"));
			expect(collapsed).not.toContain("entry-77");
			expect(collapsed).toContain("entry-82");
			expect(collapsed).toContain("model output: never · 77 lines hidden · ctrl+o to expand");
			expect(collapsed.indexOf("entry-82")).toBeLessThan(collapsed.indexOf("77 lines hidden"));
			expect(collapsed.indexOf("Took ")).toBeLessThan(collapsed.indexOf("77 lines hidden"));
			const hintLine = lines.find((line) => line.includes("77 lines hidden"));
			expect(hintLine).toContain(theme.fg("warning", "77 lines hidden"));
			expect(hintLine).toContain(theme.fg("accent", " · ctrl+o to expand"));
			expect(lines.findIndex((line) => line.includes("77 lines hidden"))).toBe(lines.length - 2);
			expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
			const narrowLines = component.render(40);
			expect(stripAnsi(narrowLines.join("\n"))).toContain("model output: never");
			expect(narrowLines.every((line) => visibleWidth(line) <= 40)).toBe(true);

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain("entry-1");
			expect(expanded).not.toContain("lines hidden");
			expect(expanded).toContain("model output: never");
		} finally {
			setKeybindings(previousKeybindings);
		}
	});

	test.each(["read", "grep", "find", "ls", "write"])("separates and colors %s collapsed output hints", (toolName) => {
		const previousKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager());
		try {
			const ops = new LocalToolOperations(process.cwd());
			const definitions = {
				read: createReadToolDefinition(ops),
				grep: createGrepToolDefinition(ops),
				find: createFindToolDefinition(ops),
				ls: createLsToolDefinition(ops),
				write: createWriteToolDefinition(ops),
			};
			const content = Array.from({ length: 25 }, (_, index) => `entry-${index + 1}`).join("\n");
			const component = new ToolExecutionComponent(
				toolName,
				`tool-${toolName}-preview`,
				{ path: "notes.txt", pattern: "entry", content },
				{},
				definitions[toolName as keyof typeof definitions],
				createFakeTui(),
				process.cwd(),
			);
			if (toolName !== "write") {
				component.updateResult(
					{ content: [{ type: "text", text: content }], details: undefined, isError: false },
					false,
				);
			}
			const lines = component.render(120);
			const hintIndex = lines.findIndex((line) => line.includes("lines hidden"));
			expect(hintIndex).toBeGreaterThan(0);
			expect(stripAnsi(lines[hintIndex - 1]!).trim()).toBe("");
			const count = stripAnsi(lines[hintIndex]!).match(/(\d+) lines hidden/)?.[1];
			expect(count).toBeDefined();
			expect(lines[hintIndex]).toContain(theme.fg("warning", `${count} lines hidden`));
			expect(lines[hintIndex]).toContain(theme.fg("accent", " · ctrl+o to expand"));
		} finally {
			setKeybindings(previousKeybindings);
		}
	});

	test("does not show the bash expansion hint when all output is visible", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-short",
			{ command: "echo short" },
			{},
			createBashToolDefinition(new LocalToolOperations(process.cwd())),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "short" }], isError: false }, false);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("lines hidden");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("model output: always");
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations = new LocalToolOperations(process.cwd());
		operations.exec = async (_command, { onData }) => {
			for (let i = 1; i <= 4000; i++) {
				onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
			}
			return { exitCode: 0 };
		};
		const tool = createBashToolDefinition(operations);
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const renderedLines = component.render(200);
		const marker = theme.bgFromFg("success", " ");
		expect(renderedLines.slice(1).every((line) => line.startsWith(marker))).toBe(true);
		const rendered = stripAnsi(
			renderedLines
				.map((line) => (line.startsWith(marker) ? line.slice(marker.length).replace(/^ /, "") : line))
				.join("\n"),
		);
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(new LocalToolOperations(process.cwd())),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(new LocalToolOperations(process.cwd()));
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(new LocalToolOperations(process.cwd()));
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(new LocalToolOperations(process.cwd())),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(new LocalToolOperations(process.cwd())),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".grip", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .grip/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".grip", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "read resource .grip/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Grip documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(new LocalToolOperations(process.cwd())),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Grip documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(new LocalToolOperations(process.cwd())),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}
});
