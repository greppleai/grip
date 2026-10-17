# SDK Examples

Programmatic usage of grip-coding-agent via `GripAgent`.

`GripAgent` is the SDK composition root. It owns shared services, creates the active `AgentSession`, and manages session replacement flows.

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Simplest usage with all defaults |
| `02-custom-model.ts` | Select model and thinking level |
| `03-custom-prompt.ts` | Replace or modify system prompt |
| `04-skills.ts` | Discover, filter, or replace skills |
| `05-tools.ts` | Built-in tool allowlists |
| `06-extensions.ts` | Logging, blocking, result modification |
| `07-context-files.ts` | AGENTS.md context files |
| `08-prompt-templates.ts` | File-based prompt templates |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config |
| `10-settings.ts` | Override compaction, retry, terminal settings |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |
| `12-full-control.ts` | Replace everything, no discovery |
| `13-session-runtime.ts` | Manage runtime-backed session replacement |

## Running

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import { getModel } from "@greppleai/grip-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  InMemorySessionManager,
  ModelRegistry,
  GripAgent,
  SettingsManager,
} from "@greppleai/grip-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const model = getModel("anthropic", "claude-opus-4-5");
const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are helpful.",
});
await loader.reload();

const gripAgent = await GripAgent.create({
  authStorage,
  modelRegistry,
  model,
  thinkingLevel: "high",
  resourceLoader: loader,
  tools: ["read", "bash", "edit", "write"],
  sessionManager: new InMemorySessionManager(),
  settingsManager: SettingsManager.inMemory(),
});

const session = await gripAgent.createAgentSession();
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("Hello");
await gripAgent.dispose();
```

## Options

Most one-off session options can be passed directly to `GripAgent.create()`:

| Option | Default | Description |
|--------|---------|-------------|
| `authStorage` | `AuthStorage.create()` | Credential storage |
| `modelRegistry` | `ModelRegistry.create(authStorage)` | Model registry |
| `cwd` | `process.cwd()` | Working directory |
| `agentDir` | `~/.grip/agent` | Config directory |
| `sessionManager` | local JSONL manager | Session lifecycle backend |
| `model` | From settings/first available | Model to use |
| `thinkingLevel` | From settings/`"off"` | off, low, medium, high |
| `tools` | `["read", "bash", "edit", "write"]` built-ins | Allowlist tool names across built-in, extension, and custom tools |
| `customTools` | `[]` | Additional tool definitions |
| `resourceLoader` | DefaultResourceLoader | Resource loader for extensions, skills, rules, prompts, themes |
| `settingsManager` | SettingsManager.create(cwd, agentDir) | Settings source |
| `resolveSessionOptions` | undefined | Per-session override hook for model, tools, and diagnostics |

Use `gripAgent.createAgentSession({ session })` when you need to provide an already-created or opened `Session`.
