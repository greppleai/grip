# Grip

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

Grip is a minimal terminal coding harness. Adapt Grip to your workflows without forking and modifying its internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Rules](#rules), [Prompt Templates](#prompt-templates), and [Themes](#themes). Bundle those resources into [Grip Packages](#grip-packages) to share through npm or git.

Grip ships with powerful defaults and built-in isolated job delegation, while leaving broader workflows such as plan mode to extensions and packages.

Grip runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps. The linked [openclaw/openclaw](https://github.com/openclaw/openclaw) is an upstream Pi SDK integration, not a verified Grip integration.

## Upstream session sharing (historical reference)

The following upstream Pi sharing workflow is retained for attribution; `pi-share-hf` is not a verified Grip integration. If you use Pi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Remote Daemon](#remote-daemon)
- [Lima Sandbox](#lima-sandbox)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Rules](#rules)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Grip Packages](#grip-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

Install the single Grip executable from a published, checksummed [GitHub release](https://github.com/greppleai/grip/releases); no npm or Bun is required on the destination machine:

```bash
# macOS/Linux (inspect the installer first)
curl -fsSL https://raw.githubusercontent.com/greppleai/grip/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/greppleai/grip/main/install.ps1 | iex
```

These URLs become active only after the scripts and release assets are published. Rerun the installer to update; set `GRIP_VERSION=vX.Y.Z` to pin a release. The old `https://pi.dev/install.sh` installs upstream Pi, **not** Grip. See [manual migration](docs/migrating-to-grip.md) when replacing an existing Pi installation.

For extension or SDK development with Node.js, npm releases also include `@greppleai/grip`, `@greppleai/grip-ai`, `@greppleai/grip-agent-core`, and `@greppleai/grip-tui`. Install the CLI with `npm install -g @greppleai/grip` if you prefer npm over the standalone binary.

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
grip
```

Or use your existing subscription:

```bash
grip
/login  # Then select provider
```

Then just talk to Grip. By default, Grip gives the model file and shell tools plus the `job` tool for bounded jobs; see [job usage](docs/usage.md#tool-options). Disable job delegation via `/settings` or `"enableJobs": false` in `settings.json` if you prefer. The model uses enabled tools to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [packages](#grip-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

Grip generates built-in model catalogs from upstream metadata on first startup and caches them in `~/.grip/agent/` (or `GRIP_CODING_AGENT_DIR`). Once you sign in to Codex, Grip separately discovers the models listed for your ChatGPT account and caches them per account. With an OpenRouter key, Grip filters its model list using OpenRouter's user-specific endpoint and caches eligible IDs per key. First use requires network access; subsequent starts reuse the caches and check for updates. Run `/model --refresh` to fetch immediately, including account-filtered models; `--offline` uses cached catalogs without making startup requests. Authenticate via subscription (`/login`) or API key, then open `/model` (or Ctrl+L) to choose a provider and model. The provider screen always appears, even with only one provider. See [model selection and extension migration](docs/usage.md#model-selection) for navigation, scoped/all switching, and direct or cross-provider search.

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- OpenAI
- Azure OpenAI
- DeepSeek
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.grip/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Historical upstream Pi interactive mode screenshot; Grip paths and branding differ" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model, active profile

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Clipboard | Ctrl+V to paste an image or text (Alt+V on Windows), or drag images onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage model-provider credentials |
| `/websearch login` | Choose a web search engine and configure its API key |
| `/model` | Switch models |
| `/image [show\|clear\|model-id]` | Show, reset, or set the Codex image-generation model for the active profile (global without a profile) |
| `/job model show`, `/job model set --model <provider/model-id>`, `/job model clear` | Inspect, set, or clear the active profile's job model (global without a profile) |
| `/profile list`, `/profile create <name>`, `/profile use <name>` | List, snapshot, or switch named settings profiles (switching is session-only) |
| `/profile directory <name> <absolute-path>`, `/profile directory clear <absolute-path>` | Assign or remove a directory-prefix profile rule |
| `/profile sandbox <name> --name <vm> [--autoconnect on\|off]` | Choose an existing VM with name completion and set startup auto-connection in one command; options also work separately |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session; keep the currently connected sandbox if any |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/context-compression [on\|off]` | Show or change agent-initiated compression for this session (default: off) |
| `/compress-detection [on\|off]` | Show or change background detection for this session (default: off); enabling also enables compression |
| `/compress-detection-model [provider/model-id\|clear]` | Choose a detector model and enable detection for this session, or clear it |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, hooks, extensions, skills, rules, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit Grip |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.grip/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |
| Ctrl+X | Copy the last assistant message |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so Grip can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `~/.grip/agent/sessions/` organized by working directory. Existing sessions under `~/.pi/agent/sessions/` are not discovered automatically; see [manual migration](docs/migrating-to-grip.md).

```bash
grip -c                  # Continue most recent session
grip -r                  # Browse and select from past sessions
grip --no-session        # Ephemeral mode (don't save)
grip --session <path|id> # Use specific session file or ID
grip --fork <path|id>    # Fork specific session file or ID into a new session

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Historical upstream Pi tree-view screenshot; Grip paths and branding differ" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Ctrl+X to copy the selected entry
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy, but the full history remains in the JSONL file. The model can use `session_search` to locate finalized entries omitted from context and `session_entry_get` to retrieve one exact model-visible entry; `/tree` remains available for interactive navigation. The `compress_context` tool uses context metadata entry IDs to replace a tail—or an earlier bounded range via `endEntryId`—with a summary while retaining later messages and archiving the originals on another branch. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.grip/agent/settings.json` | Global (all projects) |
| `.grip/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Telemetry and update checks

Grip has two separate startup features:

- **Update check:** fetches npm metadata for `@greppleai/grip` to check for a newer version when that package is available. Disable it with `GRIP_SKIP_VERSION_CHECK=1`. Disabling update checks only turns off this check.
- **Install/update telemetry:** after first install or a changelog-detected update, the current implementation sends an anonymous version ping to the upstream `https://pi.dev/api/report-install` endpoint. This is not a verified Grip service. Opt out by setting `enableInstallTelemetry` to `false` in `settings.json`, or by setting `GRIP_TELEMETRY=0`. This does not disable update checks; Grip may still contact the npm registry unless update checks are disabled or offline mode is enabled.

Use `--offline` or `GRIP_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

---

## Remote Daemon

`grip --daemon` starts an integrated remote workspace daemon from the `@greppleai/grip` package. The local Grip process remains the orchestrator for model calls, credentials, sessions, prompts, extensions, jobs, RPC, and UI; the daemon owns one confined workspace for canonical tools, project resources, file transfer, and optional process execution.

Start a daemon:

```bash
GRIP_DAEMON_TOKEN='replace-with-a-random-token-at-least-32-bytes-long' grip --daemon --daemon-cwd /workspace --daemon-port 8787
```

Connect from a local Grip process:

```bash
GRIP_REMOTE_TOKEN='replace-with-a-random-token-at-least-32-bytes-long' grip --remote ws://127.0.0.1:8787/grip/workspace
```

There is no separate Grip daemon package or executable. See [docs/daemon.md](docs/daemon.md) for topology, security, configuration, Docker, resources/extensions behavior, troubleshooting, and migration.

---

## Lima Sandbox

Interactive `/sandbox` manages workspace backends through Lima VMs or attaches to existing sandbox daemons. The command is user-only and hidden from model-visible catalogs. Local Grip keeps model/session/UI orchestration while workspace tools run in the selected backend. See [docs/sandbox.md](docs/sandbox.md) for VM commands, configuration, troubleshooting, and security limits.

---

## Context Files

Grip loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.grip/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

If a directory contains `AGENTS.override.md`, Grip loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories still layer normally, including when project instructions come from a daemon tool backend.

Use for project instructions, conventions, common commands. All selected files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.grip/SYSTEM.md` (project) or `~/.grip/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.grip/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.grip/agent/prompts/`, `.grip/prompts/`, or a [Grip package](#grip-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.grip/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.grip/agent/skills/`, `~/.agents/skills/`, `.grip/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [Grip package](#grip-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Rules

On-demand mandatory constraints and policies. Invoke via `/rule:name` or let the agent load them automatically when the task or files match the rule description.

```markdown
<!-- ~/.grip/agent/rules/typescript/RULES.md -->
---
name: typescript
description: Mandatory TypeScript rules. Load before editing *.ts or *.tsx files.
---

# TypeScript Rules

- No `any` unless absolutely necessary.
- Use top-level imports only.
```

Place in `~/.grip/agent/rules/`, `~/.agents/rules/`, `.grip/rules/`, or `.agents/rules/` (from `cwd` up through parent directories) or a [Grip package](#grip-packages) to share with others. See [docs/rules.md](docs/rules.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Historical upstream Pi Doom extension screenshot; Grip branding differs" width="600"></p>

TypeScript modules that extend Grip with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (grip: ExtensionAPI) {
  grip.registerTool({ name: "deploy", ... });
  grip.registerCommand("stats", { ... });
  grip.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. Grip waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `grip.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- Remote daemon and sandbox execution
- MCP server integration
- Make Grip look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.grip/agent/extensions/`, `.grip/extensions/`, or a [Grip package](#grip-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and Grip immediately applies changes.

Place in `~/.grip/agent/themes/`, `.grip/themes/`, or a [Grip package](#grip-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Grip Packages

Bundle and share extensions, skills, rules, prompts, and themes via npm or git. The [upstream Pi package keyword](https://www.npmjs.com/search?q=keywords%3Api-package) and [upstream Pi community](https://discord.com/channels/1456806362351669492/1457744485428629628) are historical discovery links, not a verified Grip registry or community.

> **Security:** Grip packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
grip install npm:@foo/grip-tools              # illustrative package name, not a verified npm listing
grip install npm:@foo/grip-tools@1.2.3        # pinned version
grip install git:github.com/user/repo
grip install git:github.com/user/repo@v1      # tag or commit
grip install git:git@github.com:user/repo
grip install git:git@github.com:user/repo@v1  # tag or commit
grip install https://github.com/user/repo
grip install https://github.com/user/repo@v1      # tag or commit
grip install ssh://git@github.com/user/repo
grip install ssh://git@github.com/user/repo@v1    # tag or commit
grip remove npm:@foo/grip-tools
grip uninstall npm:@foo/grip-tools          # alias for remove
grip list
grip update                               # update Grip and packages (skips pinned packages)
grip update --extensions                  # update packages only
grip update --self                        # update Grip only
grip update --self --force                # reinstall Grip even if current
grip update npm:@foo/grip-tools             # update one package
grip config                               # enable/disable extensions, skills, rules, prompts, themes
```

Packages install to `~/.grip/agent/git/` (git) or `~/.grip/agent/npm/` (npm). Use `-l` for project-local installs (`.grip/git/`, `.grip/npm/`). Git `@ref` values are pinned tags or commits; pinned packages are skipped by `grip update`, so use `grip install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `grip` key to `package.json`:

```json
{
  "name": "my-grip-package",
  "keywords": ["grip-package"],
  "grip": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "rules": ["./rules"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `grip` manifest, Grip auto-discovers from conventional directories (`extensions/`, `skills/`, `rules/`, `prompts/`, `themes/`). The `grip-package` keyword above is illustrative metadata, not required by the loader.

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, InMemorySessionManager, ModelRegistry, GripAgent } from "@greppleai/grip";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const grip = await GripAgent.create({
  sessionManager: new InMemorySessionManager(),
  authStorage,
  modelRegistry,
});
const session = await grip.createAgentSession();

await session.prompt("What files are in the current directory?");
await grip.dispose();
```

For advanced multi-session flows, use `GripAgent` methods such as `newSession()`, `switchSession()`, `fork()`, and `importFromJsonl()`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
grip --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

Grip is aggressively extensible so it does not have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [Grip packages](#grip-packages). This keeps the core minimal while letting you shape Grip to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**Focused jobs.** The built-in `job` tool is enabled by default and offloads bounded tasks to fresh in-memory sessions with isolated conversations and shared authentication. Each child uses the main agent's normal prompt builder, including current project instructions and available skills, with a bounded-job overlay; the parent verifies results and owns the final answer. Pass `task` for one job, `tasks` for independent parallel jobs, or `chain` for sequential jobs with `{previous}` handoff. Each task can specify `tools`, `skills`, `cwd`, and `responseFormat`. Run `/job model set --model provider/model-id` to set a job model for the active profile (or globally when no profile is active); `/job model clear` restores `GRIP_DEFAULT_JOB_MODEL`, then the parent model. Extensions and packages can provide other orchestration models.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
grip [options] [@files...] [messages...]
```

### Package Commands

```bash
grip install <source> [-l]     # Install package, -l for project-local
grip remove <source> [-l]      # Remove package
grip uninstall <source> [-l]   # Alias for remove
grip update [source|self|grip] # Update Grip and packages (skips pinned packages)
grip update --extensions       # Update packages only
grip update --self             # Update Grip only
grip update --self --force     # Reinstall Grip even if current
grip update --extension <src>  # Update one package
grip list                      # List installed packages
grip config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, Grip also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | grip -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |
| `--remote <url>` | Run built-in workspace tools through a `grip --daemon` WebSocket backend |
| `--remote-deferred` | Start with a deferred daemon backend and connect later with `/sandbox --attach <ws://url>` |
| `--remote-cwd <path>` | Stable daemon workspace cwd for deferred remote mode |
| `--daemon` | Start the integrated remote workspace daemon instead of a normal Grip session |
Available built-in tools include `read_image`, `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `websearch`, `session_search`, `session_entry_get`, `compress_context`, and `job`. By default `read_image`, `bash`, `write`, `websearch`, `session_search`, `session_entry_get`, and `job` are active; `read`, `edit`, `grep`, `find`, and `ls` remain available through explicit tool selection. Context compression is opt-in via `/context-compression on`, `GRIP_CONTEXT_COMPRESSION=1`, or an explicit `--tools` allowlist. Background detection is separately opt-in via `/compress-detection on` or `GRIP_CONTEXT_COMPRESSION_DETECTION=1` and requires a configured detector model. Disable job delegation with `/settings` or `"enableJobs": false`; an explicit `--tools` allowlist can still select `job` independently. An explicit parent tool allowlist also limits tools available to its jobs; `--no-tools` and `--no-builtin-tools` remain authoritative.

The built-in `read_image` tool accepts image files only and returns an image payload for model input; it rejects text files without exposing their contents. The separate text-file `read` tool remains opt-in and must be selected explicitly (for example, `--tools read`). Large images may be resized, and image size/format limits and vision support depend on the selected model/provider.
### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--rule <path>` | Load rule (repeatable) |
| `--no-rules` | Disable rule discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--tui-mode <mode>` | TUI mode: `regular` (default) or experimental `fullscreen` |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

`fullscreen` keeps the transcript in an application-owned viewport above a fixed status/editor/footer dock. `regular` retains the main screen and terminal-owned scrollback. Set **TUI mode** in `/settings` for future sessions or use `--tui-mode` for one startup.

### File Arguments

Prefix files with `@` to include in the message:

```bash
grip @prompt.md "Answer this"
grip -p @screenshot.png "What's in this image?"
grip @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
grip "List all .ts files in src/"

# Non-interactive
grip -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | grip -p "Summarize this text"

# Different model
grip --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
grip --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
grip --model sonnet:high "Solve this complex problem"

# Limit model cycling
grip --models "claude-*,gpt-4o"

# Read-only mode
grip --tools read,grep,find,ls -p "Review the code"

# Start an integrated remote workspace daemon
GRIP_DAEMON_TOKEN='replace-with-a-random-token-at-least-32-bytes-long' grip --daemon --daemon-cwd /workspace --daemon-port 8787

# Connect to that daemon from the orchestrating Grip
GRIP_REMOTE_TOKEN='replace-with-a-random-token-at-least-32-bytes-long' grip --remote ws://127.0.0.1:8787/grip/workspace
# Start with a deferred daemon backend for later RPC or /sandbox attachment
grip --remote-deferred --remote-cwd /workspace --mode rpc

# High thinking level
grip --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GRIP_CODING_AGENT_DIR` | Override config directory (default: `~/.grip/agent`) |
| `GRIP_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `GRIP_REMOTE_TOKEN` | Bearer token sent by the Grip remote-workspace client to `grip --daemon` |
| `GRIP_REMOTE_SESSION_BASE_URL` | Remote session service URL (overridden by `--remote-session-base-url`) |
| `GRIP_REMOTE_SESSION_TOKEN` | Bearer token for remote session service (overridden by `--remote-session-token`) |
| `GRIP_REMOTE_PROJECT_ID` | Project id sent to remote session service (overridden by `--remote-project-id`) |
| `GRIP_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `GRIP_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `GRIP_SKIP_VERSION_CHECK` | Skip the Grip version update check at startup. This prevents the npm metadata request |
| `GRIP_TELEMETRY` | Override install/update telemetry. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `GRIP_CONTEXT_COMPRESSION` | Set to `1` to enable `compress_context` by default for all agents. Detection remains off |
| `GRIP_CONTEXT_COMPRESSION_DETECTION` | Set to `1` to enable background detection and `compress_context` for all agents. Requires a configured `compressionDetectionModel` |
| `GRIP_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `GRIP_DEFAULT_JOB_MODEL` | Optional `provider/model-id` used for built-in jobs unless trusted global or profile `jobModel` is set; unset inherits the parent model. An invalid/unavailable model fails the job rather than silently falling back |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |
| `GRIP_DAEMON_HOST`, `GRIP_DAEMON_PORT`, `GRIP_DAEMON_CWD`, `GRIP_DAEMON_TOKEN` | Integrated daemon bind address, port, workspace root, and bearer token |
| `GRIP_DAEMON_TEMP_ROOT` | Optional additional confined daemon temporary root; the default sandbox image uses `/tmp` |
---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [@greppleai/grip-ai](../ai/README.md): Core LLM toolkit
- [@greppleai/grip-agent-core](../agent/README.md): Agent framework
- [@greppleai/grip-tui](../tui/README.md): Terminal UI components
