> Grip can help you use the SDK. Ask it to build an integration for your use case.

# SDK

The SDK provides programmatic access to Grip's agent capabilities. Use `GripAgent` as the composition root for embedded apps, custom interfaces, automated workflows, and tests.

See [examples/sdk/](../examples/sdk/) for working examples from minimal to full control.

`CreateGripAgentOptions.hooks` controls Claude-compatible hooks. Automatic discovery is user-only. Set the host-only `trustProjectHooks: true` only after approving the destination repository; it does not discover project hooks when the initial workspace backend is non-local. Once an approved local snapshot exists, project/local command hooks follow later backend transitions and execute inside sandbox/remote operations rather than on the host. Project/local HTTP hooks fail closed on non-local backends. User hooks and `hooks.snapshot` remain trusted host configuration, while `hooks.allowedHttpHookUrls` and `hooks.httpHookAllowedEnvVars` impose host ceilings. See [hooks.md](hooks.md).

## Quick Start

```typescript
import { AuthStorage, InMemorySessionManager, ModelRegistry, GripAgent } from "@greppleai/grip";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const pi = await GripAgent.create({
  sessionManager: new InMemorySessionManager(),
  authStorage,
  modelRegistry,
});

const session = await pi.createAgentSession();

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
await pi.dispose();
```

## Core Concepts

### GripAgent

`GripAgent` owns shared app services, the session lifecycle backend, and the current active `AgentSession`.

```typescript
import { InMemorySessionManager, GripAgent } from "@greppleai/grip";

const pi = await GripAgent.create({
  sessionManager: new InMemorySessionManager(),
});

const session = await pi.createAgentSession();
```

The session manages agent lifecycle, message history, model state, compaction, and event streaming.

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

Most one-off session options can be passed directly to `GripAgent.create()`:

```typescript
const pi = await GripAgent.create({
  cwd: process.cwd(),
  model,
  thinkingLevel: "high",
  tools: ["read", "grep", "find", "ls"],
  authStorage,
  modelRegistry,
  settingsManager,
  resourceLoader,
  sessionManager,
});
```

Use `pi.createAgentSession({ session })` when you already have an opened or created `Session`. Here `pi` is the example's local `GripAgent` instance.

### AgentSession

`AgentSession` owns active conversation behavior: prompts, message history, model state, compaction, event streaming, and in-place tree navigation.

Use `session.sessionReference` when you need the backend-neutral active session reference. For local JSONL sessions this is the session file path; for in-memory sessions it is `undefined`. `session.sessionFile` remains available as a local-file-oriented alias.

Session replacement APIs such as new-session, resume, fork, clone, and import live on `GripAgent`, not on `AgentSession`.

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

### SessionManager and Session

`SessionManager` handles lifecycle and discovery: create, open, continue, list, fork, and import. It returns a `Session`.

`Session` owns active persisted conversation state and tree operations.

## Prompting

```typescript
await session.prompt("What files are here?");

await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }],
});

await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

Use `steer()` or `followUp()` for explicit queueing during streaming:

```typescript
await session.steer("New instruction");
await session.followUp("After you're done, also do this");
```

## Events

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
```

Subscriptions are attached to a specific `AgentSession`. Re-subscribe after `GripAgent` replaces the active session.

## Session Replacement

```typescript
import { LocalSessionManager, GripAgent } from "@greppleai/grip";

const pi = await GripAgent.create({
  cwd: process.cwd(),
  sessionManager: new LocalSessionManager({ cwd: process.cwd() }),
});

await pi.createAgentSession();
await pi.newSession();
await pi.switchSession("/path/to/session.jsonl");
await pi.fork("entry-id");
await pi.fork("entry-id", { position: "at" });
await pi.importFromJsonl("/path/to/old-session.jsonl");
```

After replacement, use `pi.session` for the new active `AgentSession`.

## Common Configuration

### Model

```typescript
import { getModel } from "@greppleai/grip-ai";
import { AuthStorage, ModelRegistry, GripAgent } from "@greppleai/grip";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = getModel("anthropic", "claude-opus-4-5");

const pi = await GripAgent.create({
  authStorage,
  modelRegistry,
  model,
  thinkingLevel: "medium",
});
const session = await pi.createAgentSession();
```

### API keys and OAuth

```typescript
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

const pi = await GripAgent.create({ authStorage, modelRegistry });
await pi.createAgentSession();
```

### Resource loading

Use `DefaultResourceLoader` to override or discover extensions, skills, rules, prompt templates, themes, and context files.

```typescript
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const pi = await GripAgent.create({ resourceLoader: loader });
await pi.createAgentSession();
```

### Tools

```typescript
const pi = await GripAgent.create({
  tools: ["read", "grep", "find", "ls"],
  noTools: "builtin",
  customTools: [myTool],
});
await pi.createAgentSession();
```

Built-in tool names include `read`, `bash`, `edit`, `write`, `websearch`, `session_search`, `session_entry_get`, `compress_context`, `grep`, `find`, `ls`, and `subagent`. Subagent delegation is enabled by default for bounded jobs; set `enableSubagents: false` in settings to disable it. It inherits the parent model unless the host sets `GRIP_DEFAULT_SUBAGENT_MODEL=provider/model-id` or configures a named preset; the child cannot widen a parent tool allowlist. An explicit `tools` option selects any subset regardless of these defaults; `noTools: "all"` and `noTools: "builtin"` remain authoritative.

### Settings

```typescript
const settingsManager = SettingsManager.inMemory({
  enableSubagents: false, // Opt out of built-in delegation
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const pi = await GripAgent.create({ settingsManager });
await pi.createAgentSession();
```

For a live session, `session.setSubagentsEnabled(enabled)` persists the setting and immediately refreshes active tools and orchestration guidance. `session.reload()` applies settings-file changes.

## Run Modes

The SDK exports run mode utilities for building custom interfaces on top of `GripAgent`.

```typescript
import { InteractiveMode, LocalSessionManager, GripAgent, runPrintMode, runRpcMode } from "@greppleai/grip";

const pi = await GripAgent.create({
  cwd: process.cwd(),
  sessionManager: new LocalSessionManager({ cwd: process.cwd() }),
});
await pi.createAgentSession();

await runPrintMode(pi, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: [],
});

await runRpcMode(pi);

const mode = new InteractiveMode(pi, {
  migratedProviders: [],
  modelFallbackMessage: pi.modelFallbackMessage,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});
await mode.run();
```

See [RPC documentation](rpc.md) for the JSON protocol.

## Main Exports

```typescript
GripAgent
AgentSession
AuthStorage
ModelRegistry
DefaultResourceLoader
defineTool
InMemorySessionManager
LocalSessionManager
SettingsManager
createEventBus
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool, createSubagentTool
```

`createSubagentTool` requires a `SubagentRunner` in its options. `GripAgent` configures the embedded runner automatically; standalone tool construction must provide its own in-process runner.
For extension types, see [extensions.md](extensions.md).
