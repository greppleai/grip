# Settings

Grip uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.grip/agent/settings.json` | Global (all projects) |
| `.grip/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## Hook settings

Hooks use a Claude Code-compatible schema and are captured as an immutable per-session snapshot. Native Grip settings are preferred: trusted user hooks are read from the active `<agentDir>/settings.json` (normally `~/.grip/agent/settings.json`) before the compatibility source `~/.claude/settings.json`. For local interactive startup, project hooks trigger a **Don't trust / Trust once / Trust always** prompt. Trust once covers only the initial session; Trust always records the canonical repository location in `<agentDir>/trusted-project-hooks.json` and includes all future changes at that location. `--trust-project-hooks` bypasses the prompt. Trusted project sources are read from `.grip/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json` in that order; exact duplicates from later sources are ignored. Approved project command hooks follow the active workspace backend, executing inside a sandbox after the session switches to it; project HTTP hooks are blocked there rather than escaping through host networking. Initial remote project discovery remains disabled. Hook parse/schema/execution problems appear as nonfatal `GripAgent` diagnostics. SDK hosts can disable discovery, inject a trusted snapshot, and restrict HTTP URLs/environment interpolation with `CreateGripAgentOptions.hooks`.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `compressionDetectionModel` | string or null | - | Global or active-profile `provider/model-id` for background compression recommendations; project settings cannot select it. `null` in a profile disables an inherited model. Saved selections stay inactive unless enabled with `/compress-detection on` or `GRIP_CONTEXT_COMPRESSION_DETECTION=1`. |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |
| `tuiMode` | string | `"regular"` | Interactive TUI mode: `"regular"` uses the main screen and terminal scrollback; experimental `"fullscreen"` uses an application-owned viewport. `/settings` changes apply immediately and persist; `--tui-mode` overrides the startup value |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` replays the complete logical transcript, while `"resume-hint"` restores the previous main screen without replaying transcript content so any shell or launcher resume affordance remains visible. Has no effect in regular TUI mode |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows a draggable thumb temporarily while scrolling or hovering it, `"always"` reserves the rightmost column and keeps the draggable thumb visible, and `"hidden"` disables it. Has no effect in regular TUI mode |

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to the **upstream** `https://pi.dev/api/report-install` endpoint still used by this checkout; it is not a verified Grip service. Opting out of telemetry does not disable update checks; Grip can still fetch npm metadata for `@greppleai/grip` to look for the latest version when that package exists in the registry.

Set `GRIP_SKIP_VERSION_CHECK=1` to disable the Grip version update check. Use `--offline` or `GRIP_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry. Set `GRIP_TELEMETRY=0` or `enableInstallTelemetry: false` to disable the upstream telemetry ping alone.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable bounded retry for transient agent-turn, compaction, and branch-summary errors |
| `retry.maxRetries` | number | `3` | Maximum additional attempts for agent turns and summary operations |
| `retry.baseDelayMs` | number | `2000` | Base delay for exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Provider-level attempts happen inside each agent-turn or summary attempt, so enabling both layers multiplies the possible request count. SDK/provider retries may also handle out-of-usage-limit errors before Grip sees them, which can block until provider quota resets.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.grip/agent/npm/`; project-scoped npm packages install under `.grip/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Tool Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enableJobs` | boolean | `true` | Enable the built-in `job` tool for bounded delegated tasks. Changes made in `/settings` apply immediately; `/reload` applies file edits. An explicit CLI/SDK tool allowlist can still select `job`, while no-tools modes remain authoritative. |
| `jobModel` | string or null | - | Trusted global or active-profile exact available `provider/model-id` for jobs; project settings cannot select it. Set via `/job model set --model <provider/model-id>` and clear via `/job model clear`. `null` in a profile disables an inherited global job model. Takes precedence over `GRIP_DEFAULT_JOB_MODEL`, then the parent model; applies to the next job. |
| `imageModel` | string or null | `gpt-image-2` | Codex image-generation model ID. Set with `/image <model-id>`; `/image clear` restores the default, including in a profile. Project settings are ignored. Model availability is determined by Codex at request time. |
| `tools` | object | `{}` | Per-tool configuration keyed by tool name |
| `tools.websearch.provider` | string | `"duckduckgo"` | Web search provider: `"duckduckgo"`, `"brave"`, or `"firecrawl"` |
| `tools.websearch.apiKey` | string | - | Provider API key. Brave env fallback: `GRIP_WEBSEARCH_BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY`. Firecrawl env fallback: `GRIP_WEBSEARCH_FIRECRAWL_API_KEY` or `FIRECRAWL_API_KEY` |
| `tools.websearch.baseUrl` | string | Provider default API URL | Override the Brave or Firecrawl endpoint for compatible/proxy APIs |

```json
{
  "tools": {
    "websearch": {
      "provider": "firecrawl",
      "apiKey": "YOUR_FIRECRAWL_API_KEY"
    }
  }
}
```

Global and project `tools` settings merge per tool name, so a project can override `tools.websearch.baseUrl` while keeping a global `tools.websearch.apiKey`. Environment variables remain supported for `websearch`; explicit settings take precedence over environment variables. Firecrawl uses `POST /v2/search` with web results only.

In interactive mode, run `/websearch login` to select DuckDuckGo (no key), Brave Search, or Firecrawl. Brave and Firecrawl keys entered there are stored separately per engine in `~/.grip/agent/auth.json` (not in `settings.json`); selecting an engine again lets you keep its saved key by submitting an empty prompt, or replace it by entering a new key. The selected provider is saved globally under `tools.websearch.provider` and takes effect on the next tool call. `/logout` can remove saved web search credentials. Keys saved by this command take precedence over `tools.websearch.apiKey`; provider-specific environment variables remain fallbacks.

### Lima Sandbox

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sandbox.limaBinary` | string | `"limactl"` | Lima executable |
| `sandbox.limaTemplate` | string | `"template:docker-rootful"` | Template used to create a managed VM |
| `sandbox.limaInstanceNamePrefix` | string | `"grip-sandbox"` | Generated VM name prefix |
| `sandbox.workspaceMountPath` | string | `"/workspace"` | Guest path for the mounted current workspace |
| `sandbox.daemonPort` | number | `8787` | Preferred loopback-forwarded daemon port; an available port is selected when occupied for new VMs |
| `sandbox.daemonHostBind` | string | `"127.0.0.1"` | Host bind for the daemon forward |
| `sandbox.cleanup` | string | `"stop"` | Stop behavior: `"stop"` or `"remove"` for owned VMs |
| `defaultSandboxes` | object | `{}` | User-home-only map of exact canonical host directories to existing named Lima VMs, set by `/sandbox start --name <vm> --set-default` or `/sandbox default set` |

```json
{
  "sandbox": {
    "limaBinary": "limactl",
    "cleanup": "remove"
  }
}
```

Precedence for sandbox starts is `--template`, `GRIP_SANDBOX_*` environment variables, project settings, the selected profile, global settings, then defaults. See [Lima Sandbox](sandbox.md) for command syntax, environment variables, and security notes.

To connect to a named VM automatically when starting Grip in a directory, use `/sandbox start --name my-dev --set-default` to create/connect and assign in one step, `/sandbox default set` to assign an already-connected named VM, or `/sandbox default --name my-dev` to assign an existing VM explicitly. This stores `"defaultSandboxes": { "/absolute/canonical/path": "my-dev" }` in `~/.grip/agent/settings.json` (or the configured agent directory). Project `.grip/settings.json` cannot assign defaults. Matching is exact; starting from a child directory does not inherit the mapping. Only existing named VMs are eligible on startup, so a miss cannot silently create a VM. Startup connection errors are shown as warnings and leave the local backend available.


For a running shared Lima VM, `/sandbox start --name` uses `sandbox.workspaceMountPath`, `sandbox.daemonHostBind`, `sandbox.daemonPort` and `sandbox.limaBinary` to verify its fixed writable parent mount and loopback forward before attaching. `sandbox.cleanup` does not authorize stopping or deleting the shared VM. Auth, config and sessions remain on the host; same-user agents share the default host directory unless each selects a distinct `GRIP_CODING_AGENT_DIR`. Shared writes and edits use revision preconditions, but shell writes can still race. Shared transfers are unavailable; guest process execution requires trusted clients. See [sandbox.md](sandbox.md#direct-shared-lima-attachment).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".grip/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `GRIP_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Profiles and Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |
| `profiles` | object | `{}` | Named overrides for any ordinary setting, including `defaultProvider`, `defaultModel`, `enabledModels`, and `jobModel` |
| `profileDirectories` | object | `{}` | Absolute directory prefixes mapped to profile names; longest matching ancestor wins |
| `modelProfiles` | object | `{}` | Older model-only snapshots; still selectable and converted to full profiles on use |
| `profiles.<name>.defaultSandbox` | string | - | Existing named Lima VM to connect when this profile is selected on startup; trusted global settings only |
| `profiles.<name>.autoConnectSandbox` | boolean | `true` | Set `false` to skip startup sandbox connection for this profile, including a directory default |

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "jobModel": "anthropic/claude-haiku-4-5",
  "profileDirectories": {
    "/home/user/personal": "personal",
    "/home/user/work": "work"
  },
  "profiles": {
    "personal": {
      "defaultProvider": "anthropic",
      "defaultModel": "claude-sonnet-4-5"
    },
    "work": {
      "defaultProvider": "openai-codex",
      "defaultModel": "gpt-5.6",
      "enabledModels": ["openai-codex/gpt-5.6", "anthropic/claude-opus-4-7:high"],
      "jobModel": "anthropic/claude-haiku-4-5",
      "theme": "light",
      "defaultSandbox": "work-vm",
      "autoConnectSandbox": true,
      "enableJobs": true
    }
  }
}
```

Profile settings live in the global settings file. Effective precedence for ordinary settings is global settings → selected profile → project `.grip/settings.json` → runtime overrides (including CLI model selection). For the trusted job and compression detector models, project settings are ignored: runtime → profile → global. Arrays replace earlier arrays; nested settings such as `terminal`, `retry`, and `tools` merge under the normal settings rules. Profile management (`profiles`, `profileDirectories`), directory sandbox assignments, and changelog bookkeeping remain global. A profile's `defaultSandbox` and `autoConnectSandbox` are read only from trusted global profiles, never from project settings. `jobModel: null` in a profile suppresses an inherited global job model so the environment or parent model can be used. Profile names use letters, digits, dots, underscores, and hyphens, beginning with a letter or digit.

A directory rule applies to its exact directory and all descendants, not similarly named siblings. The longest matching absolute prefix wins; outside matching directories, no profile is active on startup. An old `activeProfile` value in settings is ignored and removed the next time `/profile use` runs. Starting Grip under a matching prefix selects that profile's model and job model for new and resumed sessions; an explicit `--model` still wins. A profile's `defaultSandbox` takes priority over an exact-directory `defaultSandboxes` assignment and connects on startup unless `autoConnectSandbox` is `false`; if the profile has no VM assignment, the directory assignment still applies. The VM must already exist and be compatible with the selected workspace. `/profile directory work /home/user/work` adds a rule, `/profile directory clear /home/user/work` removes it. `/profile use work` switches only the current Grip process; it never persists the active selection. Creating, resuming, or forking a session retains that manual selection. A fresh launch selects a directory rule or the default settings again. Manual profile switches do not automatically change an already connected sandbox. `/profile sandbox work --name work-vm --autoconnect off` assigns an existing named VM and disables startup auto-connection in one command; the options work in either order, and VM names autocomplete. `/profile sandbox work --autoconnect on` re-enables connection; the older `auto-connect on|off` form still works. `/profile sandbox work clear` removes the VM assignment, and `/profile sandbox work` shows its configuration. These sandbox commands take effect on next startup, not during the current session. `/profile list` shows profiles and the active choice. `/profile create work` replaces that profile with a snapshot of the current effective settings, current model, explicitly scoped models (if any), and any active profile sandbox preference. It omits `enabledModels` when there is no explicit model scope instead of writing every available model. Switching reloads resources and updates the selected model and job model; settings that only take effect during process startup may need a restart. User package/resource paths in a profile replace their global lists; project resources are loaded separately with project precedence. The footer always displays the active profile or `default`.

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Terminal Mermaid rendering: `"off"`, `"final"`, or `"streaming"`. Invalid values fall back to `"streaming"` |

Built-in Mermaid rendering applies only to ordinary user and assistant messages in the interactive transcript. `"final"` keeps streaming assistant fences as source until the message finishes; `"streaming"` renders best-effort partial diagrams while streaming. The built-in does not render Mermaid in thinking or custom messages, summaries, print/RPC/JSON output, or HTML export, and never changes session storage or model context.

### Resources

These settings define where to load extensions, skills, rules, prompts, and themes from.

Paths in `~/.grip/agent/settings.json` resolve relative to `~/.grip/agent`. Paths in `.grip/settings.json` resolve relative to `.grip`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git/local package sources or global-only `official:<id>` selections |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `rules` | string[] | `[]` | Local rule file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills and rules as `/skill:name` and `/rule:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details. `pi-skills` above is an illustrative third-party package identifier, not a project-owned package name or Grip alias.

### Official Extensions

The global-only `officialExtensions` object controls startup updates of selected, installed official packages. Project settings do not override it. The default is `autoUpdate: true`; set it to `false` to opt out. `catalogMaxAgeMs` defaults to 21600000 (maximum 86400000), `requestTimeoutMs` to 3000 (maximum 30000), and `startupBudgetMs` to 8000 (maximum 60000). Numeric values must be positive safe integers in milliseconds.

```json
{
  "officialExtensions": {
    "autoUpdate": false
  }
}
```

Official sources must be installed explicitly with `/extensions` or `grip install official:<id>`; adding one to `packages` does not download missing code. They are global-only, with no project or temporary installation. `--offline` / `GRIP_OFFLINE=1` and `--no-extensions` skip automatic official updates. `GRIP_SKIP_VERSION_CHECK` controls only the core version check. Explicit management remains available when auto-update is disabled. See [official extensions](official-extensions.md) for bounded-update settings, full-access trust, retained versions, safe reload and recovery.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.grip/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.grip/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .grip/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
