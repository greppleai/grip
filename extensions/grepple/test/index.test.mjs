import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../index.ts";

function harness(initialTools) {
	const events = new Map();
	const registered = [];
	const commands = new Map();
	const selections = [];
	const notifications = [];
	let jobFactory;
	let active = [...initialTools];
	extension({
		registerJobFactory(factory) {
			jobFactory = factory;
		},
		registerTool(tool) {
			registered.push(tool.name);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		on(name, handler) {
			events.set(name, handler);
		},
		getActiveTools() {
			return active;
		},
		setActiveTools(names) {
			selections.push(names);
			active = names;
		},
	});
	const ctx = {
		cwd: "/workspace/project",
		signal: undefined,
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
		toolOperations: { mapWorkspaceDirectoryToHost: async () => "/host/project" },
		getToolBackendInfo: () => ({ type: "local", cwd: "/workspace/project" }),
		isSandbox: () => false,
		execToolBackend: async () => ({ exitCode: 1, output: "", cancelled: false, truncated: false }),
		execHostCommand: async () => { throw new Error("Host call not expected"); },
	};
	return { events, registered, commands, selections, notifications, ctx, getActive: () => active, jobFactory };
}

test("jobs receive Grepple workflow hooks without the installation command", async () => {
	const parent = harness(["read", "bash", "grep", "edit", "write"]);
	const events = new Map();
	const commands = new Map();
	let active = ["read", "bash", "grep", "edit", "write"];
	parent.jobFactory({
		on(name, handler) { events.set(name, handler); },
		registerCommand(name, definition) { commands.set(name, definition); },
		getActiveTools() { return active; },
		setActiveTools(names) { active = names; },
	});
	assert.deepEqual([...events.keys()], ["session_start", "before_agent_start", "tool_call"]);
	assert.deepEqual([...commands.keys()], []);
	events.get("session_start")();
	assert.deepEqual(active, ["bash"]);
	const prompt = events.get("before_agent_start")({
		systemPrompt: "Job prompt",
		systemPromptOptions: { selectedTools: ["bash"], contextFiles: [] },
	});
	assert.match(prompt.systemPrompt, /### Grepple repository workflow/);
	assert.deepEqual(await events.get("tool_call")({ toolName: "edit" }, parent.ctx), {
		block: true,
		reason: "Use bash to run grepple write --root . with a literal directive/body transaction; the next directive or EOF ends its body (no end marker).",
	});
	const jobCtx = {
		...parent.ctx,
		execToolBackend: async () => ({ exitCode: 0, output: JSON.stringify({ blocked: true, reason: "Use Grepple" }), cancelled: false, truncated: false }),
	};
	assert.deepEqual(await events.get("tool_call")({ toolName: "bash", input: { command: "rg needle ." } }, jobCtx), {
		block: true,
		reason: "Use Grepple",
	});
});
test("deactivates direct tools without registering overrides or affecting unrelated tools", () => {
	const h = harness(["read", "bash", "grep", "edit", "write", "grepple", "other", "websearch"]);
	assert.deepEqual(h.registered, []);
	assert.deepEqual([...h.events.keys()], ["session_start", "before_agent_start", "tool_call"]);
	assert.deepEqual([...h.commands.keys()], ["grepple-install"]);
	h.events.get("session_start")();
	assert.deepEqual(h.getActive(), ["bash", "other", "websearch"]);
	h.events.get("session_start")();
	assert.equal(h.selections.length, 1);
});

test("activates Bash when it is missing", () => {
	const h = harness(["read", "other", "grep", "write"]);
	h.events.get("session_start")();
	assert.deepEqual(h.getActive(), ["bash", "other"]);
});

test("adds concise Grepple guidance only when it is needed", () => {
	const h = harness(["bash"]);
	const prompt = h.events.get("before_agent_start");
	const event = { systemPrompt: "Base prompt", systemPromptOptions: { selectedTools: ["bash"], contextFiles: [] } };
	const updated = prompt(event);
	assert.match(updated.systemPrompt, /^Base prompt\n\n### Grepple repository workflow/);
	assert.match(updated.systemPrompt, /grepple --outline FILE.*grepple --at FILE @KIND:START-END/);
	assert.match(updated.systemPrompt, /::grepple replace PATH START \[END\]/);
	assert.match(updated.systemPrompt, /::grepple create PATH/);
	assert.match(updated.systemPrompt, /::grepple delete PATH SHA256/);
	assert.match(updated.systemPrompt, /next directive or EOF ends the body/);
	assert.match(updated.systemPrompt, /no end marker/);
	assert.match(updated.systemPrompt, /--at FILE:LINE\[-END\]/);
	assert.match(updated.systemPrompt, /--domain-area or --functional-area/);
	assert.match(updated.systemPrompt, /grepple tree --domain-area LABEL PATH/);
	assert.match(updated.systemPrompt, /grepple --functional-area LABEL -F 'Name' --count-summary PATH/);
	assert.match(updated.systemPrompt, /Recheck unfiltered if coverage is incomplete/);
	assert.equal(prompt({ ...event, systemPromptOptions: { selectedTools: ["read"] } }), undefined);
	assert.equal(prompt({ ...event, systemPromptOptions: { selectedTools: ["bash"], customPrompt: "Custom" } }), undefined);
	const projectInstructions = { ...event, systemPromptOptions: { selectedTools: ["bash"], contextFiles: [{ content: "## Grepple-first repository workflow" }] } };
	const reminderOnly = prompt(projectInstructions);
	assert.match(reminderOnly.systemPrompt, /--domain-area or --functional-area/);
	assert.match(reminderOnly.systemPrompt, /grepple --outline FILE.*grepple --at FILE @KIND:START-END/);
	assert.doesNotMatch(reminderOnly.systemPrompt, /### Grepple repository workflow/);
	assert.equal(prompt({ ...projectInstructions, systemPrompt: reminderOnly.systemPrompt }), undefined);
	const structured = prompt({ ...event, systemPrompt: "## Guidelines\nParent rules\n\n## Skills\nSkill catalog\n\n## Jobs\nJob catalog\n\n## Grip documentation\nDocs\nCurrent date: 2026-10-25" });
	assert.ok(structured.systemPrompt.indexOf("### Grepple repository workflow") < structured.systemPrompt.indexOf("## Skills"));
	assert.ok(structured.systemPrompt.indexOf("## Skills") < structured.systemPrompt.indexOf("## Jobs"));
	assert.ok(structured.systemPrompt.indexOf("## Jobs") < structured.systemPrompt.indexOf("## Grip documentation"));
	const reminderStructured = prompt({ ...projectInstructions, systemPrompt: "## Guidelines\nParent rules\n\n## Jobs\nJob catalog\n\n## Grip documentation\nDocs\nCurrent date: 2026-10-25" });
	assert.ok(reminderStructured.systemPrompt.indexOf("For broad local Grepple tree/search") < reminderStructured.systemPrompt.indexOf("## Jobs"));
	const withProjectHeading = prompt({ ...event, systemPrompt: "## Guidelines\n<project_context>\n## Skills\nProject text\n</project_context>\n\n## Skills\nSkill catalog\n\n## Grip documentation\nDocs" });
	assert.ok(withProjectHeading.systemPrompt.indexOf("</project_context>") < withProjectHeading.systemPrompt.indexOf("### Grepple repository workflow"));
	assert.ok(withProjectHeading.systemPrompt.indexOf("### Grepple repository workflow") < withProjectHeading.systemPrompt.lastIndexOf("## Skills"));
});

test("blocks built-in edit even if re-enabled, but leaves unrelated tool calls alone", async () => {
	const h = harness(["bash"]);
	const call = h.events.get("tool_call");
	assert.deepEqual(await call({ toolName: "edit" }, h.ctx), {
		block: true,
		reason:
			"Use bash to run grepple write --root . with a literal directive/body transaction; the next directive or EOF ends its body (no end marker).",
	});
	for (const toolName of ["read", "grep", "write", "grepple", "other"]) {
		assert.equal(await call({ toolName }, h.ctx), undefined);
	}
});

test("Bash guard runs in the active backend, forwarding only a valid canonical denial", async () => {
	const h = harness(["bash"]);
	const executions = [];
	h.ctx.execToolBackend = async (shell, options) => {
		executions.push({ shell, options });
		return { exitCode: 0, output: JSON.stringify({ blocked: true, reason: "Use Grepple instead" }), cancelled: false, truncated: false };
	};
	const decision = await h.events.get("tool_call")({ toolName: "bash", input: { command: "rg needle ." } }, h.ctx);
	assert.deepEqual(decision, { block: true, reason: "Use Grepple instead" });
	assert.equal(executions.length, 1);
	assert.deepEqual(executions[0].options, { cwd: h.ctx.cwd, signal: undefined, timeout: 10 });
	assert.match(executions[0].shell, /grepple grep-guard$/);
});

test("guard fails open for missing, invalid, timed-out, or oversized responses", async () => {
	const h = harness(["bash"]);
	const call = h.events.get("tool_call");
	let count = 0;
	for (const result of [
		{ exitCode: 1, output: "" },
		{ exitCode: 0, output: "not JSON" },
		{ exitCode: 0, output: '{"blocked":true}' },
		{ exitCode: 0, output: '{"blocked":true,"reason":""}' },
		{ exitCode: 0, output: '{"blocked":false}' },
		{ exitCode: 0, output: '{"blocked":true,"reason":"deny"}', truncated: true },
		{ exitCode: 0, output: '{"blocked":true,"reason":"deny"}', cancelled: true },
	]) {
		h.ctx.execToolBackend = async () => {
			count++;
			return { cancelled: false, truncated: false, ...result };
		};
		assert.equal(await call({ toolName: "bash", input: { command: "rg x" } }, h.ctx), undefined);
	}
	h.ctx.execToolBackend = async () => {
		throw new Error("backend disconnected");
	};
	assert.equal(await call({ toolName: "bash", input: { command: "rg x" } }, h.ctx), undefined);
	assert.equal(await call({ toolName: "bash", input: { command: "x".repeat(1024 * 1024) } }, h.ctx), undefined);
	assert.equal(await call({ toolName: "bash", input: {} }, h.ctx), undefined);
	assert.equal(count, 7);
});

test("guard command transmits untrusted shell text literally", async () => {
	const dir = mkdtempSync(join(tmpdir(), "grepple-grip-guard-"));
	try {
		const stub = join(dir, "grepple");
		writeFileSync(stub, `#!/usr/bin/env node
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(process.env.CAPTURE, input);
  process.stdout.write(JSON.stringify({ blocked: true, reason: "Use Grepple instead" }));
});
`);
		chmodSync(stub, 0o755);
		const h = harness(["bash"]);
		h.ctx.cwd = dir;
		const capture = join(dir, "request.json");
		h.ctx.execToolBackend = async (shell, options) => {
			const result = spawnSync("sh", ["-c", shell], {
				cwd: options.cwd,
				encoding: "utf8",
				env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture },
			});
			return { exitCode: result.status, output: `${result.stdout}${result.stderr}`, cancelled: false, truncated: false };
		};
		const injected = join(dir, "injected");
		const command = `rg 'needle' $(touch ${injected})\n echo "grep's $value"`;
		assert.deepEqual(await h.events.get("tool_call")({ toolName: "bash", input: { command } }, h.ctx), {
			block: true,
			reason: "Use Grepple instead",
		});
		assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { command });
		assert.equal(existsSync(injected), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("install command is explicit and installs only once without a sandbox", async () => {
	const h = harness(["bash"]);
	const executions = [];
	h.ctx.execToolBackend = async (shell, options) => {
		executions.push({ shell, options });
		return { exitCode: 0, cancelled: false };
	};
	h.events.get("session_start")();
	assert.equal(executions.length, 0);
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.equal(executions.length, 1);
	assert.deepEqual(executions[0].options, { cwd: h.ctx.cwd, timeout: 600 });
	assert.match(executions[0].shell, /https:\/\/raw\.githubusercontent\.com\/greppleai\/grepple\/main\/install\.sh/);
	assert.match(executions[0].shell, /--bin-dir "\$HOME\/\.local\/bin"/);
	assert.doesNotMatch(executions[0].shell, /\|\s*sh\b|\bsudo\b/);
	assert.deepEqual(h.notifications, [{ message: "Grepple installed in the local backend (also the host).", level: "info" }]);
});

test("sandbox install uses the backend, then asks for separate host approval", async () => {
	const h = harness(["bash"]);
	h.ctx.getToolBackendInfo = () => ({ type: "remote", configured: true, cwd: h.ctx.cwd });
	h.ctx.isSandbox = () => true;
	const executions = [];
	h.ctx.execToolBackend = async (shell, options) => {
		executions.push({ side: "sandbox", shell, options });
		return { exitCode: 0, cancelled: false };
	};
	h.ctx.execHostCommand = async (shell, options) => {
		executions.push({ side: "host", shell, options });
		return { exitCode: 0, cancelled: false };
	};
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.deepEqual(executions.map(({ side }) => side), ["sandbox", "host"]);
	assert.equal(executions[0].shell, executions[1].shell);
	assert.equal(executions[1].options.cwd, h.ctx.cwd);
	assert.equal(executions[1].options.timeout, 600);
	assert.equal(executions[1].options.approvalTimeoutMs, 60_000);
	assert.match(executions[1].options.question, /host ~\/\.local\/bin/);
	assert.deepEqual(h.notifications, [{ message: "Grepple installed in both sandbox and host (~/.local/bin).", level: "info" }]);
});

test("install refuses unmapped sandbox and unrelated remote backend before executing", async () => {
	const h = harness(["bash"]);
	let executions = 0;
	h.ctx.execToolBackend = async () => { executions++; throw new Error("unexpected install"); };
	h.ctx.getToolBackendInfo = () => ({ type: "remote", configured: true, cwd: h.ctx.cwd });
	h.ctx.isSandbox = () => true;
	h.ctx.toolOperations.mapWorkspaceDirectoryToHost = async () => { throw new Error("unmapped"); };
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.match(h.notifications.at(-1).message, /verified sandbox-to-host mount/);
	h.ctx.isSandbox = () => false;
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.match(h.notifications.at(-1).message, /detached remote backends/);
	assert.equal(executions, 0);
});

test("failed backend install prevents host call; refused host install reports partial success", async () => {
	const h = harness(["bash"]);
	h.ctx.getToolBackendInfo = () => ({ type: "remote", configured: true, cwd: h.ctx.cwd });
	h.ctx.isSandbox = () => true;
	let hostCalls = 0;
	h.ctx.execHostCommand = async () => { hostCalls++; throw new Error("Host command was not approved"); };
	h.ctx.execToolBackend = async () => ({ exitCode: 1, cancelled: false });
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.equal(hostCalls, 0);
	assert.match(h.notifications.at(-1).message, /host install was not attempted/);
	h.ctx.execToolBackend = async () => ({ exitCode: 0, cancelled: false });
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.equal(hostCalls, 1);
	assert.match(h.notifications.at(-1).message, /sandbox, but host installation was not completed: Host command was not approved/);
});

test("sandbox install refuses missing approval UI without touching either backend", async () => {
	const h = harness(["bash"]);
	h.ctx.isSandbox = () => true;
	h.ctx.hasUI = false;
	h.ctx.getToolBackendInfo = () => ({ type: "remote", configured: true, cwd: h.ctx.cwd });
	h.ctx.execToolBackend = async () => { throw new Error("unexpected backend install"); };
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.match(h.notifications.at(-1).message, /approval UI/);
});

test("nonzero host exit reports a partial install rather than success", async () => {
	const h = harness(["bash"]);
	h.ctx.isSandbox = () => true;
	h.ctx.getToolBackendInfo = () => ({ type: "remote", configured: true, cwd: h.ctx.cwd });
	h.ctx.execToolBackend = async () => ({ exitCode: 0, cancelled: false });
	h.ctx.execHostCommand = async () => ({ exitCode: 1, cancelled: false });
	await h.commands.get("grepple-install").handler("", h.ctx);
	assert.deepEqual(h.notifications, [{ message: "Grepple installed in the sandbox, but host installation failed.", level: "error" }]);
});
