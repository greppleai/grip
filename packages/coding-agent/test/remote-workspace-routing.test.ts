import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@greppleai/grip-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type ProviderHeaders,
	registerFauxProvider,
	type TextContent,
} from "@greppleai/grip-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { GripAgent } from "../src/core/grip-agent.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { LocalSessionManager } from "../src/core/session/local-session-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	borrowToolOperations,
	createRemoteToolOperations,
	DeferredRemoteToolOperations,
	type ToolBackendInfo,
} from "../src/core/tools/operations.ts";
import { WorkspaceToolHost } from "../src/core/tools/workspace-tool-host.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-remote-routing-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function reservePort(): Promise<number> {
	const server = createHttpServer();
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Unable to reserve test port");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function createServer(
	workspaceRoot: string,
	allowProcessExec = true,
	token?: string,
	lspConfigPath?: string,
	temporaryRoot?: string,
	allowFullFilesystem = false,
) {
	const port = await reservePort();
	const command = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-cwd",
			workspaceRoot,
			"--daemon-port",
			String(port),
			"--daemon-allow-root",
			...(lspConfigPath ? ["--daemon-lsp-config", lspConfigPath] : []),
			...(allowProcessExec ? ["--daemon-allow-process-exec"] : []),
			...(allowFullFilesystem ? ["--daemon-allow-full-filesystem"] : []),
		],
		{
			...(token ? { GRIP_DAEMON_TOKEN: token } : {}),
			...(temporaryRoot ? { GRIP_DAEMON_TEMP_ROOT: temporaryRoot } : {}),
		},
		workspaceRoot,
	);
	if (!command.configuration) throw new Error("Missing daemon configuration");
	const server = createDaemonServer(command.configuration);
	const address = await server.listen();
	return { server, address };
}

function text(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("\n");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("remote canonical workspace tool routing", () => {
	it("loads guest skills through the remote backend and local skills from the host by name", async () => {
		const guestRoot = await createTemporaryDirectory();
		const localRoot = await createTemporaryDirectory();
		const guestSkillDir = join(guestRoot, "guest-skill");
		const localSkillDir = join(localRoot, "local-skill");
		await mkdir(guestSkillDir);
		await mkdir(localSkillDir);
		const guestSkillPath = join(guestSkillDir, "SKILL.md");
		const localSkillPath = join(localSkillDir, "SKILL.md");
		await writeFile(guestSkillPath, "# Guest Skill\n");
		await writeFile(localSkillPath, "# Host Skill\n");
		const skills: Skill[] = [
			{
				name: "guest-skill",
				description: "Skill in the guest",
				filePath: guestSkillPath,
				baseDir: guestSkillDir,
				sourceInfo: createSyntheticSourceInfo(guestSkillPath, { source: "remote" }),
				disableModelInvocation: false,
			},
			{
				name: "local-skill",
				description: "Skill on the host",
				filePath: localSkillPath,
				baseDir: localSkillDir,
				sourceInfo: createSyntheticSourceInfo(localSkillPath, { source: "path" }),
				disableModelInvocation: false,
			},
		];
		const { server, address } = await createServer(guestRoot);
		const operations = await createRemoteToolOperations(address.url);
		const resourceLoader = { ...createTestResourceLoader(), getSkills: () => ({ skills, diagnostics: [] }) };
		const harness = await createHarness({ toolOperations: operations, resourceLoader });
		try {
			const definition = harness.session.getToolDefinition("load_skill");
			expect(definition).toBeDefined();
			const result = await definition!.execute(
				"load-remote-skills",
				{ name: ["guest-skill", "local-skill"] },
				undefined,
				undefined,
				harness.session.extensionRunner.createContext(),
			);
			expect(text(result)).toContain("# Guest Skill");
			expect(text(result)).toContain("# Host Skill");
			expect(text(result)).toContain(`Skill directory: ${JSON.stringify(localSkillDir)}`);
		} finally {
			await harness.session.dispose();
			await operations.dispose();
			await server.close();
			harness.cleanup();
		}
	});

	it("executes all seven canonical tools once through the daemon host with updates and details", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot);
		const operations = await createRemoteToolOperations(address.url);
		const host = new WorkspaceToolHost({
			cwd: operations.cwd,
			operations,
			tools: { bash: { commandPrefix: "printf prefix;" } },
		});

		expect([...host.getDefinitions().keys()]).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		await host.execute("write", {
			toolCallId: "write-1",
			arguments: { path: "sample.txt", content: "alpha\nbeta\n" },
		});
		expect(await readFile(join(workspaceRoot, "sample.txt"), "utf8")).toBe("alpha\nbeta\n");

		const readResult = await host.execute("read", {
			toolCallId: "read-1",
			arguments: { path: "sample.txt" },
		});
		const readText = text(readResult);
		expect(readText).toContain("alpha");
		const hashLines = readText.split("\n").filter((line) => line.includes("│"));
		const firstHash = hashLines[0]?.slice(0, 3);
		if (!firstHash) throw new Error("Read result did not contain a hashline anchor");

		const editResult = await host.execute("edit", {
			toolCallId: "edit-1",
			arguments: {
				file_path: "sample.txt",
				changes: [{ hash_range_inclusive: [firstHash, firstHash], content_lines: ["changed"] }],
			},
		});
		expect(editResult.details).toMatchObject({ firstChangedLine: 1 });
		expect(await readFile(join(workspaceRoot, "sample.txt"), "utf8")).toBe("changed\nbeta\n");

		expect(text(await host.execute("ls", { toolCallId: "ls-1", arguments: {} }))).toContain("sample.txt");
		expect(text(await host.execute("find", { toolCallId: "find-1", arguments: { pattern: "*.txt" } }))).toContain(
			"sample.txt",
		);
		expect(text(await host.execute("grep", { toolCallId: "grep-1", arguments: { pattern: "changed" } }))).toContain(
			"sample.txt:1: changed",
		);

		const updates: string[] = [];
		const bashResult = await host.execute("bash", {
			toolCallId: "bash-1",
			arguments: { command: "printf routed" },
			onUpdate: (update) => updates.push(text(update)),
		});
		expect(text(bashResult)).toBe("prefixrouted");
		expect(updates.some((update) => update.includes("prefixrouted"))).toBe(true);

		await host.dispose();
		await operations.dispose();
		await server.close();
	});

	it("injects current session metadata into sandbox bash calls", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot);
		const operations = await createRemoteToolOperations(address.url);
		const harness = await createHarness({ toolOperations: operations });
		try {
			expect(harness.session.getToolBackendInfo().type).toBe("remote");
			expect(harness.session.isSandbox()).toBe(false);
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command:
								'printf \'%s\\n\' "$GRIP_SESSION_ID" "$GRIP_SESSION_FILE" "$GRIP_PROVIDER" "$GRIP_MODEL" "$GRIP_REASONING_LEVEL"',
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("inspect sandbox metadata");
			const result = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "bash",
			);
			const output =
				result?.role === "toolResult"
					? result.content
							.find((entry) => entry.type === "text")
							?.text?.trimEnd()
							.split("\n")
					: undefined;
			expect(output).toEqual([
				harness.session.sessionId,
				harness.session.sessionReference,
				harness.session.model?.provider,
				harness.session.model?.id,
				harness.session.thinkingLevel,
			]);
		} finally {
			await harness.session.dispose();
			await operations.dispose();
			await server.close();
			harness.cleanup();
		}
	});

	it("hosts configured LSP beside the daemon workspace without a local AgentSession manager", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const configPath = join(workspaceRoot, "daemon-lsp.json");
		const exitMarker = join(workspaceRoot, "lsp-exited.txt");
		const fixture = fileURLToPath(new URL("./fixtures/lsp-stdio-server.mjs", import.meta.url));
		await writeFile(
			configPath,
			JSON.stringify({
				servers: [
					{
						id: "fixture",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "spawn", command: "node", args: [fixture, `--exit-marker=${exitMarker}`] },
						lifecycle: { type: "managed" },
						workspace: { type: "session" },
					},
				],
			}),
		);
		await writeFile(join(workspaceRoot, "sample.ts"), "const value = 1;\n");
		const { server, address } = await createServer(workspaceRoot, true, undefined, configPath);
		const operations = await createRemoteToolOperations(address.url);
		const harness = await createHarness({ toolOperations: operations, settings: { enableLspTools: true } });
		expect(harness.session.getLspStatus()).toMatchObject({
			owner: "daemon",
			enabled: true,
			servers: [expect.objectContaining({ serverId: "fixture", state: "idle", running: false })],
		});
		expect(harness.session.getAllTools().some((tool) => tool.name === "lsp_hover")).toBe(true);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("lsp_hover", { path: "sample.ts", line: 1, character: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect hover");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "lsp_hover",
		);
		expect(result?.role === "toolResult" ? result.content[0] : undefined).toMatchObject({
			type: "text",
			text: "fixture hover: const value = 1;",
		});
		expect(harness.session.getLspStatus()).toMatchObject({
			owner: "daemon",
			servers: [expect.objectContaining({ serverId: "fixture", state: "running", ownership: "managed" })],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "sample.ts", content: "const changed = 2;\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("lsp_hover", { path: "sample.ts", line: 1, character: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("change and inspect hover");
		const hoverResults = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "lsp_hover",
		);
		const synchronizedHover = hoverResults.at(-1);
		expect(synchronizedHover?.role === "toolResult" ? synchronizedHover.content[0] : undefined).toMatchObject({
			type: "text",
			text: "fixture hover: const changed = 2;",
		});
		await harness.session.dispose();
		await operations.dispose();
		await server.close();
		await vi.waitFor(async () => expect(await readFile(exitMarker, "utf8")).toBe("exited"));
	});

	it("propagates cancellation to daemon-owned LSP requests", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const configPath = join(workspaceRoot, "daemon-lsp-cancel.json");
		const fixture = fileURLToPath(new URL("./fixtures/lsp-stdio-server.mjs", import.meta.url));
		await writeFile(
			configPath,
			JSON.stringify({
				servers: [
					{
						id: "fixture",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "spawn", command: "node", args: [fixture, "--hang-hover"] },
						lifecycle: { type: "managed" },
						workspace: { type: "session" },
					},
				],
			}),
		);
		await writeFile(join(workspaceRoot, "sample.ts"), "const value = 1;\n");
		const { server, address } = await createServer(workspaceRoot, true, undefined, configPath);
		const operations = await createRemoteToolOperations(address.url);
		const harness = await createHarness({ toolOperations: operations });
		const controller = new AbortController();
		const invocation = operations.executeWorkspaceTool("lsp_hover", {
			toolCallId: "cancel-lsp",
			arguments: { path: "sample.ts", line: 1, character: 1 },
			signal: controller.signal,
			executionOptions: {},
		});
		setTimeout(() => controller.abort(), 50);
		await expect(invocation).rejects.toThrow(/cancel|abort/iu);
		await harness.session.dispose();
		await operations.dispose();
		await server.close();
	});

	it("keeps AgentSession as the sole lifecycle and extension-policy owner", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = await createRemoteToolOperations(address.url);
		let toolCalls = 0;
		let toolResults = 0;
		let originalToolError: string | undefined;
		const harness = await createHarness({
			toolOperations: operations,
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						toolCalls++;
					});
					pi.on("tool_result", async (event) => {
						if (event.isError) {
							originalToolError = event.content
								.filter((entry): entry is TextContent => entry.type === "text")
								.map((entry) => entry.text)
								.join("\n");
						}
						toolResults++;
						return { content: [{ type: "text", text: "local result middleware" }] };
					});
				},
			],
		});
		await server.reload();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "agent.txt", content: "agent" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write remotely");
		expect(originalToolError).toBeUndefined();
		const persistedToolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(
			persistedToolResult?.role === "toolResult"
				? persistedToolResult.content.find((entry) => entry.type === "text")?.text
				: undefined,
		).toBe("local result middleware");
		expect(await readFile(join(workspaceRoot, "agent.txt"), "utf8")).toBe("agent");
		expect(toolCalls).toBe(1);
		expect(toolResults).toBe(1);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		await harness.session.dispose();
		const replacement = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		expect(
			text(await replacement.execute("read", { toolCallId: "replacement", arguments: { path: "agent.txt" } })),
		).toContain("agent");
		await replacement.dispose();
		await operations.dispose();
		await server.close();
		harness.cleanup();
	});

	it("allows file tools across the guest filesystem only when explicitly enabled", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const guestDirectory = await createTemporaryDirectory();
		const externalFile = join(guestDirectory, "guest.txt");
		await writeFile(externalFile, "outside mount\n");
		await symlink(guestDirectory, join(workspaceRoot, "guest-link"));
		const { server, address } = await createServer(workspaceRoot, false, undefined, undefined, undefined, true);
		const operations = await createRemoteToolOperations(address.url);
		const host = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		try {
			const readText = text(
				await host.execute("read", { toolCallId: "guest-read", arguments: { path: externalFile } }),
			);
			expect(readText).toContain("outside mount");
			const firstHash = readText
				.split("\n")
				.find((line) => line.includes("│"))
				?.slice(0, 3);
			if (!firstHash) throw new Error("Read result did not contain a hashline anchor");
			await host.execute("edit", {
				toolCallId: "guest-edit",
				arguments: {
					path: externalFile,
					changes: [{ hash_range_inclusive: [firstHash, firstHash], content_lines: ["edited"] }],
				},
			});
			expect(await readFile(externalFile, "utf8")).toBe("edited\n");
			await host.execute("write", {
				toolCallId: "guest-write",
				arguments: { path: join(workspaceRoot, "guest-link", "new.txt"), content: "written" },
			});
			expect(await readFile(join(guestDirectory, "new.txt"), "utf8")).toBe("written");
			await expect(operations.resolveWorkspaceDirectory(guestDirectory)).rejects.toThrow();
		} finally {
			await host.dispose();
			await operations.dispose();
			await server.close();
		}
	});

	it("preserves cancellation, canonical errors, confinement, and mutation ordering", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const outside = await createTemporaryDirectory();
		const temporaryRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, true, undefined, undefined, temporaryRoot);
		const operations = await createRemoteToolOperations(address.url);
		const host = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		const temporaryFile = join(temporaryRoot, "scratch.txt");
		await host.execute("write", {
			toolCallId: "temporary-write",
			arguments: { path: temporaryFile, content: "temporary" },
		});
		expect(await readFile(temporaryFile, "utf8")).toBe("temporary");
		expect(
			text(await host.execute("read", { toolCallId: "temporary-read", arguments: { path: temporaryFile } })),
		).toContain("temporary");

		await expect(
			host.execute("read", { toolCallId: "escape", arguments: { path: join(outside, "secret.txt") } }),
		).rejects.toThrow("Path escapes the daemon workspace");
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(temporaryRoot, "outside-link"));
		await expect(
			host.execute("read", {
				toolCallId: "temporary-symlink-read",
				arguments: { path: join(temporaryRoot, "outside-link", "secret.txt") },
			}),
		).rejects.toThrow("Path escapes the daemon workspace");
		await symlink(outside, join(workspaceRoot, "outside-link"));
		await expect(
			host.execute("read", { toolCallId: "dotdot-escape", arguments: { path: "../secret.txt" } }),
		).rejects.toThrow("Path escapes the daemon workspace");
		await expect(
			host.execute("read", { toolCallId: "symlink-read", arguments: { path: "outside-link/secret.txt" } }),
		).rejects.toThrow("Path escapes the daemon workspace");
		await expect(
			host.execute("write", {
				toolCallId: "symlink-write",
				arguments: { path: "outside-link/modified.txt", content: "escaped" },
			}),
		).rejects.toThrow("Path escapes the daemon workspace");
		await expect(readFile(join(outside, "modified.txt"), "utf8")).rejects.toThrow();
		await symlink(join(outside, "future.txt"), join(workspaceRoot, "broken-link"));
		await expect(
			host.execute("write", {
				toolCallId: "broken-symlink-write",
				arguments: { path: "broken-link", content: "escaped" },
			}),
		).rejects.toThrow("broken symbolic link");
		await expect(readFile(join(outside, "future.txt"), "utf8")).rejects.toThrow();

		const first = host.execute("write", {
			toolCallId: "ordered-1",
			arguments: { path: "ordered.txt", content: "first" },
		});
		const second = host.execute("write", {
			toolCallId: "ordered-2",
			arguments: { path: "ordered.txt", content: "second" },
		});
		await Promise.all([first, second]);
		expect(await readFile(join(workspaceRoot, "ordered.txt"), "utf8")).toBe("second");

		await expect(
			host.execute("bash", { toolCallId: "failure", arguments: { command: "printf failure; exit 3" } }),
		).rejects.toThrow("Command exited with code 3");

		const controller = new AbortController();
		const running = host.execute("bash", {
			toolCallId: "cancel",
			arguments: { command: "sleep 5" },
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		await expect(running).rejects.toThrow(/cancel|abort/iu);

		await operations.dispose();
		await server.close();
	});

	it("uses typed client credentials and rejects deferred workspace identity drift", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const otherRoot = await createTemporaryDirectory();
		const token = "remote-routing-token-0123456789abcdef";
		const { server, address } = await createServer(workspaceRoot, false, token);
		await expect(
			createRemoteToolOperations(address.url, { token: "wrong-token-that-is-at-least-32-bytes" }),
		).rejects.toThrow("Failed to connect remote workspace");
		const authenticated = await createRemoteToolOperations(address.url, { token });
		expect(authenticated.cwd).toBe(workspaceRoot);
		await authenticated.dispose();
		const deferred = new DeferredRemoteToolOperations(otherRoot);
		await expect(deferred.configureRemote(address.url, { token })).rejects.toThrow("workspace root mismatch");
		const sandboxExpected = new DeferredRemoteToolOperations(otherRoot);
		await sandboxExpected.configureRemote(address.url, { token, expectedCwd: workspaceRoot });
		expect(sandboxExpected.getBackendInfo()).toMatchObject({ type: "remote", cwd: workspaceRoot, configured: true });
		await sandboxExpected.dispose();
		await server.close();
	});
	it("changes sandbox cwd without replacing the session or disconnecting the mounted workspace", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const guestSubdirectory = join(workspaceRoot, "subdirectory");
		await mkdir(guestSubdirectory);
		await writeFile(join(guestSubdirectory, "guest.txt"), "inside sandbox");
		const hostRoot = await createTemporaryDirectory();
		const temporaryRoot = await createTemporaryDirectory();
		await symlink(temporaryRoot, join(workspaceRoot, "outside-link"));
		const { server, address } = await createServer(workspaceRoot, true, undefined, undefined, temporaryRoot);
		const deferred = new DeferredRemoteToolOperations(hostRoot);
		const harness = await createHarness({ toolOperations: deferred });
		try {
			await harness.session.activateSandboxDaemon({ url: address.url, token: "", expectedCwd: workspaceRoot });
			const session = harness.session.session;
			const originalHostCwd = session.getCwd();
			const operations = harness.session.getToolOperations();
			const host = new WorkspaceToolHost({ cwd: operations.cwd, operations });
			const otherClient = await createRemoteToolOperations(address.url);
			const otherHost = new WorkspaceToolHost({ cwd: otherClient.cwd, operations: otherClient });
			try {
				await expect(harness.session.getSandboxDirectoryCompletions("../")).resolves.toEqual([]);
				await expect(harness.session.changeSandboxWorkingDirectory("../outside")).rejects.toThrow("outside");
				await expect(harness.session.changeSandboxWorkingDirectory("outside-link")).rejects.toThrow();
				await expect(harness.session.changeSandboxWorkingDirectory("missing")).rejects.toThrow();
				expect(await harness.session.getSandboxDirectoryCompletions("sub")).toEqual([
					{ value: "subdirectory/", label: "subdirectory/" },
				]);
				expect(operations.cwd).toBe(workspaceRoot);
				expect(await harness.session.changeSandboxWorkingDirectory("subdirectory")).toBe(guestSubdirectory);
				expect(harness.session.session).toBe(session);
				expect(session.getCwd()).toBe(originalHostCwd);
				expect(harness.session.getToolBackendInfo()).toMatchObject({
					type: "remote",
					cwd: workspaceRoot,
					workspace: { root: workspaceRoot },
				});
				expect(
					text(await host.execute("read", { toolCallId: "read-cd", arguments: { path: "guest.txt" } })),
				).toContain("inside sandbox");
				await host.execute("write", {
					toolCallId: "write-cd",
					arguments: { path: "written.txt", content: "guest" },
				});
				expect(await readFile(join(guestSubdirectory, "written.txt"), "utf8")).toBe("guest");
				expect(
					text(await host.execute("bash", { toolCallId: "bash-cd", arguments: { command: "pwd" } })),
				).toContain(guestSubdirectory);
				expect(await readFile(join(guestSubdirectory, "guest.txt"), "utf8")).toBe("inside sandbox");
				expect(text(await otherHost.execute("ls", { toolCallId: "other-ls", arguments: {} }))).toContain(
					"subdirectory/",
				);
				expect(otherClient.cwd).toBe(workspaceRoot);
				expect(harness.session.getToolBackendInfo()).toMatchObject({ type: "remote", configured: true });
			} finally {
				await host.dispose();
				await otherHost.dispose();
				await otherClient.dispose();
			}
		} finally {
			await harness.session.dispose();
			harness.cleanup();
			await deferred.dispose();
			await server.close();
		}
	});

	it("approves each mapped host command with its exact command and host cwd", async () => {
		const guestRoot = await createTemporaryDirectory();
		const hostRoot = await createTemporaryDirectory();
		const guestSubdirectory = join(guestRoot, "sub");
		const hostSubdirectory = join(hostRoot, "sub");
		await mkdir(guestSubdirectory);
		await mkdir(hostSubdirectory);
		const { server, address } = await createServer(guestRoot);
		const deferred = new DeferredRemoteToolOperations(hostRoot);
		const harness = await createHarness({ toolOperations: deferred });
		const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValueOnce("No").mockResolvedValue("Yes");
		const command = "printf approved > host-marker.txt";
		try {
			expect(harness.session.isSandbox()).toBe(false);
			await harness.session.activateSandboxDaemon({
				url: address.url,
				token: "",
				expectedCwd: guestRoot,
				hostWorkspaceRoot: hostRoot,
			});
			await harness.session.bindExtensions({ uiContext: { select } as ExtensionUIContext });
			const ctx = harness.session.extensionRunner.createContext();
			expect(ctx.isSandbox()).toBe(true);
			expect(await ctx.toolOperations.mapWorkspaceDirectoryToHost?.(guestSubdirectory)).toBe(hostSubdirectory);
			await expect(
				ctx.execHostCommand(command, { question: "Publish this repository?", cwd: guestSubdirectory }),
			).rejects.toThrow("not approved");
			await expect(readFile(join(hostSubdirectory, "host-marker.txt"))).rejects.toThrow();
			await harness.session.changeSandboxWorkingDirectory("sub");
			const result = await ctx.execHostCommand(command, { question: "Publish this repository?" });
			expect(result.exitCode).toBe(0);
			expect(await readFile(join(hostSubdirectory, "host-marker.txt"), "utf8")).toBe("approved");
			await expect(readFile(join(guestSubdirectory, "host-marker.txt"))).rejects.toThrow();
			expect(select).toHaveBeenCalledTimes(2);
			expect(select).toHaveBeenCalledWith(
				`Run on host?\nReason: "Publish this repository?"\nCommand: ${JSON.stringify(command)}\nHost cwd: ${JSON.stringify(hostSubdirectory)}`,
				["No", "Yes"],
				{ signal: undefined },
			);
		} finally {
			await harness.session.dispose();
			await deferred.dispose();
			await server.close();
			harness.cleanup();
		}
	});

	it("approves direct host executables with argv and no shell, and denies before spawning", async () => {
		const guestRoot = await createTemporaryDirectory();
		const hostRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(guestRoot);
		const deferred = new DeferredRemoteToolOperations(hostRoot);
		const harness = await createHarness({ toolOperations: deferred });
		const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValueOnce("No").mockResolvedValue("Yes");
		const args = [
			"-e",
			"require('node:fs').writeFileSync('direct.txt', process.argv[1])",
			"literal;touch injected.txt",
		];
		try {
			await harness.session.activateSandboxDaemon({
				url: address.url,
				token: "",
				expectedCwd: guestRoot,
				hostWorkspaceRoot: hostRoot,
			});
			await harness.session.bindExtensions({ uiContext: { select } as ExtensionUIContext });
			const ctx = harness.session.extensionRunner.createContext();
			const options = {
				question: "Run direct program?",
				explanation: "Refresh refs without exposing credentials",
				cwd: guestRoot,
			};
			await expect(ctx.execHostProcess(process.execPath, args, options)).rejects.toThrow("not approved");
			await expect(readFile(join(hostRoot, "direct.txt"))).rejects.toThrow();
			const result = await ctx.execHostProcess(process.execPath, args, options);
			expect(result).toMatchObject({ code: 0, killed: false });
			expect(await readFile(join(hostRoot, "direct.txt"), "utf8")).toBe(args[2]);
			await expect(readFile(join(hostRoot, "injected.txt"))).rejects.toThrow();
			await expect(readFile(join(guestRoot, "direct.txt"))).rejects.toThrow();
			expect(select).toHaveBeenCalledTimes(2);
			expect(select).toHaveBeenCalledWith(
				`Run on host (no shell)?\nReason: "Run direct program?"\nExplanation (unverified): "Refresh refs without exposing credentials"\nExecutable: ${JSON.stringify(process.execPath)}\nArguments: ${JSON.stringify(args)}\nHost cwd: ${JSON.stringify(hostRoot)}`,
				["No", "Yes"],
				{ signal: undefined },
			);
			await ctx.execHostProcess(process.execPath, args, { question: "No explanation", cwd: guestRoot });
			expect(select.mock.calls[2][0]).not.toContain("Explanation (unverified):");
			await expect(ctx.execHostProcess(process.execPath, args, { ...options, explanation: "  " })).rejects.toThrow(
				"valid strings",
			);
			expect(select).toHaveBeenCalledTimes(3);
		} finally {
			await harness.session.dispose();
			await deferred.dispose();
			await server.close();
			harness.cleanup();
		}
	});

	it("fails closed for unattached host mounts, absent UI, escaped paths and cancellations", async () => {
		const guestRoot = await createTemporaryDirectory();
		const hostRoot = await createTemporaryDirectory();
		const outside = await createTemporaryDirectory();
		await mkdir(join(guestRoot, "link"));
		await symlink(outside, join(hostRoot, "link"));
		const { server, address } = await createServer(guestRoot);
		const deferred = new DeferredRemoteToolOperations(hostRoot);
		const harness = await createHarness({ toolOperations: deferred });
		const command = "printf denied > marker.txt";
		try {
			await harness.session.activateSandboxDaemon({ url: address.url, token: "", expectedCwd: guestRoot });
			const ctx = harness.session.extensionRunner.createContext();
			expect(ctx.isSandbox()).toBe(true); // An attached sandbox need not have a host mapping.
			await expect(ctx.execHostCommand(command, { question: "test" })).rejects.toThrow("approval UI");
			await expect(ctx.execHostProcess("git", ["push"], { question: "test" })).rejects.toThrow("approval UI");
			const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Yes");
			await harness.session.bindExtensions({ uiContext: { select } as ExtensionUIContext });
			await expect(ctx.execHostCommand(command, { question: "test" })).rejects.toThrow("mapping");
			await expect(ctx.execHostProcess("git", ["push"], { question: "test" })).rejects.toThrow("mapping");
			await harness.session.clearRemoteSandbox();
			expect(harness.session.isSandbox()).toBe(false);
			const localCtx = harness.session.extensionRunner.createContext();
			await expect(localCtx.execHostProcess("git", ["push"], { question: "test" })).rejects.toThrow(
				"connected sandbox",
			);
			await harness.session.activateSandboxDaemon({
				url: address.url,
				token: "",
				expectedCwd: guestRoot,
				hostWorkspaceRoot: hostRoot,
			});
			const fresh = harness.session.extensionRunner.createContext();
			await expect(
				fresh.execHostCommand(command, { question: "test", cwd: join(guestRoot, "link") }),
			).rejects.toThrow("escapes");
			await expect(fresh.execHostCommand(command, { question: "test", cwd: outside })).rejects.toThrow();
			const abort = new AbortController();
			abort.abort();
			await expect(fresh.execHostCommand(command, { question: "test", signal: abort.signal })).rejects.toThrow(
				"cancelled",
			);
			await expect(
				fresh.execHostProcess("git", ["push"], { question: "test", signal: abort.signal }),
			).rejects.toThrow("cancelled");
			expect(select).not.toHaveBeenCalled();
			const abortOnApproval = new AbortController();
			select.mockImplementationOnce(async () => {
				abortOnApproval.abort();
				return "Yes";
			});
			await expect(
				fresh.execHostCommand(command, { question: "test", signal: abortOnApproval.signal }),
			).rejects.toThrow("not approved");
			expect(select).toHaveBeenCalledTimes(1);
			const abortProcessOnApproval = new AbortController();
			select.mockImplementationOnce(async () => {
				abortProcessOnApproval.abort();
				return "Yes";
			});
			await expect(
				fresh.execHostProcess("git", ["push"], { question: "test", signal: abortProcessOnApproval.signal }),
			).rejects.toThrow("not approved");
			expect(select).toHaveBeenCalledTimes(2);
			await expect(readFile(join(hostRoot, "marker.txt"))).rejects.toThrow();
			await expect(readFile(join(outside, "marker.txt"))).rejects.toThrow();
		} finally {
			await harness.session.dispose();
			await deferred.dispose();
			await server.close();
			harness.cleanup();
		}
	});

	it("aborts the active LLM loop when the sandbox connection drops without running tools on the host", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot);
		const hostRoot = await createTemporaryDirectory();
		const deferred = new DeferredRemoteToolOperations(hostRoot);
		const harness = await createHarness({ toolOperations: deferred });
		const abort = vi.spyOn(harness.session.agent, "abort");
		try {
			await harness.session.activateSandboxDaemon({ url: address.url, token: "", expectedCwd: workspaceRoot });
			expect(abort).not.toHaveBeenCalled();
			expect(harness.session.isSandbox()).toBe(true);
			await server.close();
			await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
			expect(harness.session.isSandbox()).toBe(false);
			expect(harness.session.getToolBackendInfo().type).toBe("remote");
			await expect(harness.session.prompt("run a local tool instead")).rejects.toThrow("Sandbox connection lost");
			await expect(harness.session.getToolOperations().writeFile("host-escape.txt", "unsafe")).rejects.toThrow();
			await expect(readFile(join(hostRoot, "host-escape.txt"), "utf8")).rejects.toThrow();
			await expect(readFile(join(workspaceRoot, "host-escape.txt"), "utf8")).rejects.toThrow();
		} finally {
			await harness.session.dispose();
			await server.close();
			harness.cleanup();
		}
	});
	it("keeps sandbox overlays session-local across new sessions", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, false);
		const deferred = new DeferredRemoteToolOperations(workspaceRoot);
		const pi = await GripAgent.create({
			cwd: workspaceRoot,
			toolOperations: deferred,
			sessionManager: new InMemorySessionManager(workspaceRoot),
		});
		try {
			const first = await pi.createAgentSession();
			const activations = await Promise.allSettled([
				first.activateSandboxDaemon({ url: address.url, token: "", expectedCwd: workspaceRoot }),
				first.activateSandboxDaemon({ url: address.url, token: "", expectedCwd: workspaceRoot }),
			]);
			expect(activations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(activations.filter((result) => result.status === "rejected")).toHaveLength(1);
			expect(first.getToolBackendInfo()).toMatchObject({ type: "remote", configured: true });
			expect(first.isSandbox()).toBe(true);
			expect(deferred.getBackendInfo()).toEqual({ type: "remote", cwd: workspaceRoot, configured: false });

			await pi.newSession();
			expect(pi.session.getToolBackendInfo()).toEqual({ type: "remote", cwd: workspaceRoot, configured: false });
			expect(pi.session.isSandbox()).toBe(false);
			expect(deferred.getBackendInfo()).toEqual({ type: "remote", cwd: workspaceRoot, configured: false });
		} finally {
			await pi.dispose();
			await deferred.dispose();
			await server.close();
		}
	});
	it("dispatches interactive /sandbox --attach and stop against a real v1 daemon transport", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const file = join(workspaceRoot, "interactive-attach.txt");
		await writeFile(file, "attached through v1");
		const { server, address } = await createServer(workspaceRoot, false);
		const deferred = new DeferredRemoteToolOperations(workspaceRoot);
		const agent = await GripAgent.create({
			cwd: workspaceRoot,
			toolOperations: deferred,
			sessionManager: new InMemorySessionManager(workspaceRoot),
		});
		try {
			const session = await agent.createAgentSession();
			const showError = vi.fn();
			const showStatus = vi.fn();
			const context = {
				session,
				activeSession: { getCwd: () => workspaceRoot, getSessionId: () => "interactive-v1-test" },
				sessionSandboxStates: new Map(),
				managedLimaInstances: new Map(),
				createLimaSandboxService: () => ({
					resolveConfig: () => ({ workspaceMountPath: workspaceRoot }),
					start: async () => {
						throw new Error("Unexpected Lima start");
					},
					list: async () => {
						throw new Error("Unexpected Lima list");
					},
					stop: async () => {
						throw new Error("Unexpected Lima stop");
					},
				}),
				refreshUiAfterBackendChange: vi.fn(),
				updateToolBackendStatus: vi.fn(),
				formatToolBackendStatus: (info: ToolBackendInfo) => `tools: ${info.type}`,
				showStatus,
				showWarning: vi.fn(),
				showError,
			};
			Object.setPrototypeOf(context, InteractiveMode.prototype);
			const dispatch = (
				InteractiveMode.prototype as unknown as {
					handleSandboxCommand(this: typeof context, text: string): Promise<void>;
				}
			).handleSandboxCommand;
			await dispatch.call(context, `/sandbox --attach ${address.url}`);
			expect(showError).not.toHaveBeenCalled();
			expect(session.getToolBackendInfo()).toMatchObject({ type: "remote", cwd: workspaceRoot, configured: true });
			expect((await session.getToolOperations().readFile(file)).toString()).toBe("attached through v1");
			await dispatch.call(context, "/sandbox stop");
			expect(showError).not.toHaveBeenCalled();
			expect(session.getToolBackendInfo()).toMatchObject({ type: "remote", cwd: workspaceRoot, configured: false });
			expect(showStatus.mock.calls.map(([message]) => message).join("\n")).toContain("Sandbox detached");
		} finally {
			await agent.dispose();
			await deferred.dispose();
			await server.close();
		}
	});
	it("does not expose an authenticated daemon bearer token to provider header hooks", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const token = "provider-header-secret-0123456789abcdef";
		const { server, address } = await createServer(workspaceRoot, false, token);
		const operations = await createRemoteToolOperations(address.url, { token });
		const faux = registerFauxProvider();
		const model = faux.getModel();
		let observedHeaders: ProviderHeaders | undefined;
		let providerHeaders: ProviderHeaders | undefined;
		faux.setResponses([
			(_context, options) => {
				providerHeaders = { ...options?.headers };
				return fauxAssistantMessage("done");
			},
		]);
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("before_provider_headers", (event) => {
						observedHeaders = { ...event.headers };
						event.headers["x-correlation-id"] = "daemon-safe";
					});
				},
			],
			workspaceRoot,
		);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "model-provider-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const pi = await GripAgent.create({
			cwd: workspaceRoot,
			model,
			authStorage,
			modelRegistry,
			sessionManager: new InMemorySessionManager(workspaceRoot),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			toolOperations: operations,
		});

		try {
			const session = await pi.createAgentSession();
			await session.prompt("trace safely");
			await session.waitForIdle();
			const serializedHeaders = JSON.stringify({ observedHeaders, providerHeaders });
			expect(serializedHeaders).not.toContain(token);
			expect(observedHeaders).not.toHaveProperty("authorization");
			expect(providerHeaders).toMatchObject({ "x-correlation-id": "daemon-safe" });
		} finally {
			await pi.dispose();
			await operations.dispose();
			await server.close();
			faux.unregister();
		}
	});

	it("keeps deferred daemon connections owned across host replacement and disposes them once", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		await writeFile(join(workspaceRoot, "deferred.txt"), "deferred");
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = new DeferredRemoteToolOperations(workspaceRoot);
		await operations.configureRemote(address.url);
		const firstHost = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		expect(firstHost.getDefinition("bash")).toBeUndefined();
		expect(
			text(await firstHost.execute("read", { toolCallId: "deferred-1", arguments: { path: "deferred.txt" } })),
		).toContain("deferred");
		await firstHost.dispose();
		await server.close();
		const replacementServer = await createServer(workspaceRoot, false);
		await operations.configureRemote(replacementServer.address.url);
		const replacementHost = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		expect(
			text(await replacementHost.execute("read", { toolCallId: "deferred-2", arguments: { path: "deferred.txt" } })),
		).toContain("deferred");
		await replacementHost.dispose();
		await operations.dispose();
		await operations.dispose();
		await replacementServer.server.close();
	});

	it("lets the top-level GripAgent own one remote runtime while sessions remain borrowers", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = await createRemoteToolOperations(address.url);
		const borrowed = borrowToolOperations(operations);
		expect("dispose" in borrowed).toBe(false);
		expect((borrowed as { dispose?: unknown }).dispose).toBeUndefined();
		const disposeRemote = operations.dispose.bind(operations);
		let disposeCalls = 0;
		operations.dispose = async () => {
			disposeCalls++;
			await disposeRemote();
		};
		const piAgent = await GripAgent.create({
			cwd: workspaceRoot,
			toolOperations: operations,
			ownsToolOperations: true,
		});
		await Promise.all([piAgent.dispose(), piAgent.dispose()]);
		expect(disposeCalls).toBe(1);
		await server.close();
	});
	it("keeps JSONL sessions local while daemon tools mutate only the remote workspace", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const localSessionDir = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = await createRemoteToolOperations(address.url);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "daemon-only.txt", content: "remote" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "model-provider-key");
		const pi = await GripAgent.create({
			cwd: workspaceRoot,
			model,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			sessionManager: new LocalSessionManager({ cwd: workspaceRoot, sessionDir: localSessionDir }),
			resourceLoader: createTestResourceLoader(),
			toolOperations: operations,
		});
		try {
			const session = await pi.createAgentSession();
			await session.prompt("write through daemon");
			await session.waitForIdle();
			expect(await readFile(join(workspaceRoot, "daemon-only.txt"), "utf8")).toBe("remote");
			const localFiles = await readdir(localSessionDir);
			expect(localFiles.filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
			expect((await readdir(workspaceRoot)).some((file) => file.endsWith(".jsonl"))).toBe(false);
		} finally {
			await pi.dispose();
			await operations.dispose();
			await server.close();
			faux.unregister();
		}
	});
});
