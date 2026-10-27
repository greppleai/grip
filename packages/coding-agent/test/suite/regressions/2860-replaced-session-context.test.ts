import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@greppleai/grip-agent-core";
import {
	fauxAssistantMessage,
	getApiProvider,
	registerApiProvider,
	registerFauxProvider,
	type TextContent,
	unregisterApiProviders,
} from "@greppleai/grip-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { GripAgent } from "../../../src/core/grip-agent.ts";
import { LocalSessionManager } from "../../../src/core/session/local-session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../../src/index.ts";

function getText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("regression #2860: replaced session callbacks", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-2860-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
		const fauxStreamProvider = getApiProvider(faux.api);
		if (!fauxStreamProvider) throw new Error("Faux API provider was not registered");
		const restoredProviderSource = `test-2860:${tempDir}`;
		const restoreFauxStream = () => {
			if (!getApiProvider(faux.api)) registerApiProvider(fauxStreamProvider, restoredProviderSource);
		};

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtime = await GripAgent.create({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			sessionManager: new LocalSessionManager({ cwd: tempDir }),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			resolveSessionOptions: () => ({ model: faux.getModel() }),
		});
		await runtime.createAgentSession();
		restoreFauxStream();

		const rebindSession = async (): Promise<void> => {
			const session = runtime.session;
			await session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => session.waitForIdle(),
					newSession: async (options) => runtime.newSession(options),
					fork: async (entryId, options) => {
						const result = await runtime.fork(entryId, options);
						return { cancelled: result.cancelled };
					},
					navigateTree: async (targetId, options) => {
						const result = await session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
						return { cancelled: result.cancelled };
					},
					switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
					reload: async () => {
						await session.reload();
					},
				},
			});
		};

		runtime.setRebindSession(async () => {
			await rebindSession();
			// Session reload resets stream registrations; keep this test's faux stream
			// available for the prompt issued from the replacement session callback.
			restoreFauxStream();
		});
		await rebindSession();

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			unregisterApiProviders(restoredProviderSource);
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux };
	}

	it("rebinds before withSession, targets the replacement session, and invalidates stale pi/ctx", async () => {
		const events: string[] = [];
		let oldCtx: ExtensionCommandContext | undefined;
		let oldPi: ExtensionAPI | undefined;
		let oldSessionFile: string | undefined;
		let staleCtxThrows = false;
		let stalePiThrows = false;
		let replacementSessionFile: string | undefined;
		let instanceId = 0;
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				const currentInstance = ++instanceId;
				pi.on("session_start", () => {
					events.push(`start:${currentInstance}`);
				});
				pi.on("session_shutdown", () => {
					events.push(`shutdown:${currentInstance}`);
				});
				pi.registerCommand("repro", {
					description: "repro",
					handler: async (_args, ctx) => {
						oldCtx = ctx;
						oldPi = pi;
						oldSessionFile = ctx.session.getSessionReference();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								events.push(`with:${currentInstance}`);
								replacementSessionFile = replacedCtx.session.getSessionReference();
								try {
									oldCtx?.session.getSessionReference();
								} catch {
									staleCtxThrows = true;
								}
								try {
									oldPi?.sendUserMessage("stale message");
								} catch {
									stalePiThrows = true;
								}
								await replacedCtx.sendUserMessage("Hello from the new session!");
							},
						});
					},
				});
			},
			["hello reply"],
		);

		expect(events).toEqual(["start:1"]);

		await runtime.session.prompt("/repro");

		expect(events).toEqual(["start:1", "shutdown:1", "start:2", "with:1"]);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(staleCtxThrows).toBe(true);
		expect(stalePiThrows).toBe(true);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:Hello from the new session!",
			"assistant:hello reply",
		]);
	});

	it("supports withSession for fork", async () => {
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("fork-it", {
					description: "fork-it",
					handler: async (_args, ctx) => {
						const leafId = ctx.session.getLeafId();
						if (!leafId) {
							throw new Error("Missing leaf id");
						}
						await ctx.fork(leafId, {
							position: "at",
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("fork callback message");
							},
						});
					},
				});
			},
			["seed reply", "fork reply"],
		);

		await runtime.session.prompt("seed");
		await runtime.session.prompt("/fork-it");

		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:seed",
			"assistant:seed reply",
			"user:fork callback message",
			"assistant:fork reply",
		]);
	});

	it("supports withSession for switchSession", async () => {
		let targetSessionPath = "";
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("switch-it", {
					description: "switch-it",
					handler: async (_args, ctx) => {
						await ctx.switchSession(targetSessionPath, {
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("switch callback message");
							},
						});
					},
				});
			},
			["root reply", "target reply", "switch reply"],
		);

		await runtime.session.prompt("root");
		const originalSessionPath = runtime.session.sessionFile;
		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.prompt("target");
		targetSessionPath = runtime.session.sessionFile!;
		await runtime.switchSession(originalSessionPath!);

		await runtime.session.prompt("/switch-it");

		expect(runtime.session.sessionFile).toBe(targetSessionPath);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:target",
			"assistant:target reply",
			"user:switch callback message",
			"assistant:switch reply",
		]);
	});
});
