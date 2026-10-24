# Using Grip

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Historical upstream Pi interactive mode screenshot; Grip paths and branding differ" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Copy response | Ctrl+X copies the last assistant message; in `/tree`, it copies the selected entry |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `$VISUAL` or `$EDITOR` |

See [Keybindings](keybindings.md) for all shortcuts and customization.

Grip does not download or install `fd` or `rg` automatically. Install `fd` (or `fdfind`) for `@` file suggestions and local `find`, and ripgrep (`rg`) for local `grep`; put them on `PATH`. Previously installed binaries in the user agent's `bin` directory remain usable. Remote workspace implementations may provide their own search tools.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model [reference or query]` | Choose a provider and model, select an exact reference, or search across providers |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session, reusing the active sandbox connection if connected |
| `/cd [directory]` | Change working directory (within the existing guest mount when sandboxed) |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, hooks, extensions, skills, rules, prompts, and context files |
| `/hooks <enable|disable>` | Enable or disable subsequent hooks for the current session |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit Grip |

`/hooks disable` immediately prevents subsequent hook events in the current session; a hook execution already in progress is allowed to finish. `/hooks enable` resumes dispatch. Skipped events are not replayed, and a newly created or resumed session starts with hooks enabled. `/reload` preserves this enabled/disabled state while refreshing file-backed hook configuration.

`/hooks` and `/sandbox` are user-only interactive commands hidden from model-visible command catalogs. `/sandbox` shows or clears the current backend, attaches a sandbox daemon, manages Lima sandboxes, and can set a per-directory default with `/sandbox start --name <vm> --set-default` or `/sandbox default set`; see [Workspace Sandbox](sandbox.md).

## Model Selection

Open `/model` or use `app.model.select` (Ctrl+L by default). The native picker **always starts with providers**, even when only one provider is available; it never skips straight to models.

- Type to filter providers by display name or ID. Each row shows its ID, model count in the active scope, and a check mark for the current provider.
- Use Up/Down or PageUp/PageDown to navigate. Enter opens the highlighted provider without changing the model or saved default.
- In a provider, type to filter models by ID or readable name. Rows identify the provider, the current model has a check mark, and the highlighted model's readable name appears below the list. Enter selects the model and saves the primary model default.
- Escape from models returns to providers and restores the previous provider filter and highlight. Reentering a provider starts with an empty model filter. Escape at the provider screen cancels without changing the model or default.
- A nonempty filter edit selects the best match. Clearing a filter retains the selection's position where possible. Confirming an empty result does nothing.

These are the default keys; selector hints follow your [keybindings](keybindings.md), including confirmation and cancellation.

### Scoped and All Models

If a model scope exists (configured with `/scoped-models`, `enabledModels`, or `--models`), the picker starts in **scoped** mode. Tab switches between scoped and all available models. Provider counts and membership reflect the active mode; a provider with no scoped models is absent until you switch to all.

Switching scope in provider-first navigation returns to the provider screen and clears the filter. Models within a provider retain configured scoped order. In all mode, the current model comes first, followed by provider/model ID order. Providers are sorted by display name and ID. This is deterministic ordering, not newest-release ordering. Opening the picker refreshes the registry, including `models.json`; availability reflects configured authentication, not a live credential check.

Model cycling (Ctrl+P / Shift+Ctrl+P) and `/scoped-models` configuration are unchanged. Choosing a model from all mode does not add it to your scope.

### Direct References and Cross-provider Search

- `/model provider/model-id` selects an exact available reference directly, without opening the picker. Exact matching respects the active model scope when one exists.
- If the argument does not match an exact reference, `/model <query>` opens a model search across providers in the active scope. For example, `/model son` can find matching Sonnet models from multiple providers. Use Tab to include all available models when scoped mode is active.
- In this cross-provider search, Tab keeps the query and search view; Escape cancels directly rather than opening providers. Clearing the query keeps the cross-provider model list. Bare `/model` always uses the provider-first flow.

The `/compress-detection-model` picker uses the same provider-first navigation, but choosing a detector changes only its configuration, not the primary session model or primary default.

### Migrating from provider-model-picker

The native flow needs no extension, `/pm` command, or additional shortcut. Grip does not automatically disable your extension or rewrite personal configuration.

1. Disable **every load source** for `provider-model-picker`. Use `grip config` to disable its resource in the applicable global or project scope, including auto-discovered local extensions. Remove any explicit `-e` / `--extension` launch argument or configured extension entry that still loads it. For a package, disable only the picker resource if you need its other resources; see [package filtering](packages.md#package-filtering). Removing an explicit entry alone is insufficient if the same extension is also auto-discovered.
2. In `~/.grip/agent/keybindings.json`, check whether `app.model.select` was unbound with `[]`. Remove that override to inherit Ctrl+L, or merge `"app.model.select": "ctrl+l"` (or your preferred key) into the existing object. Keep unrelated bindings. Review any old extension shortcut overrides before removing them; do not unbind unrelated tree actions to free this key.
3. Run `/reload`, or restart if you changed launch arguments. Verify `/model` and your configured model-selection shortcut both open Providers. `/pm` was extension-provided and is not a native command; use `/model` instead.

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want Grip to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.grip/agent/sessions/`, organized by working directory.

```bash
grip -c                  # Continue most recent session
grip -r                  # Browse and select a session
grip --no-session        # Ephemeral mode; do not save
grip --session <path|id> # Use a specific session file or session ID
grip --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

Grip loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.grip/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

If a directory contains `AGENTS.override.md`, Grip loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories still layer normally.

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.grip/SYSTEM.md` for a project
- `~/.grip/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link. Its current viewer URL defaults to the upstream `https://pi.dev/session/`; a Grip viewer has not been verified. Set `GRIP_SHARE_VIEWER_URL` to a trusted viewer endpoint before relying on a branded sharing flow.

For third-party session publishing workflows, see [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf), an upstream Pi integration that publishes sessions to Hugging Face datasets. Verify its compatibility with Grip before using it.

## CLI Reference

```bash
grip [options] [@files...] [messages...]
```

### Package Commands

```bash
grip install <source> [-l]       # Install package, -l for project-local
grip remove <source> [-l]        # Remove package
grip uninstall <source> [-l]     # Alias for remove
grip update [source|self|grip]   # Update Grip and packages; reconcile pinned git refs
grip update --extensions        # Update packages only; reconcile pinned git refs
grip update --self              # npm-managed installs only; for binary installs rerun the verified installer
grip update --extension <src>   # Update one package
grip list                       # List installed packages
grip config                     # Enable/disable package resources
```

These commands manage Grip packages; the compiled binary itself updates by rerunning the [verified installer](quickstart.md#install), not `grip update --self`. To uninstall Grip itself, see [Quickstart](quickstart.md#uninstall).

See [Grip Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, Grip also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | grip -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |
| `--remote <url>` | Run built-in tools through a `grip --daemon` backend (`ws://` or `wss://`) |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `session_search`, `session_entry_get`, `subagent`, `subagent_runs`, and `create_subagent`.

The three subagent tools are inactive by default. Enable them through `/settings` or `"enableSubagents": true` in `settings.json`. An explicit `--tools` allowlist can opt in to any subset regardless of that setting; `--no-tools` and `--no-builtin-tools` still suppress them.

The `subagent` tool runs fresh in-memory agent sessions in single, parallel, or chained mode. Each session has an isolated conversation while sharing parent authentication and model services, avoiding separate process startup. Each task can provide an optional named preset, persona (`systemPrompt`), output contract (`responseFormat`), model, tool allowlist, and working directory. Without a model it inherits the parent model; the parent receives authenticated same-family model metadata including context and token costs. Bundled presets are `explore`, `worker`, and `reviewer`. User definitions in `~/.grip/agent/agents/*.md` override bundled presets; project definitions in `.grip/agents/*.md` are opt-in through `agentScope` and require interactive confirmation by default.

Use `--remote-deferred --remote-cwd <path>` to start without a connected tool backend, then connect from interactive mode with `/sandbox --attach <ws://url>`. Connecting reloads project instruction resources from the selected daemon backend.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--rule <path>` | Load a rule; repeatable |
| `--no-rules` | Disable rule discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
grip --no-extensions -e ./my-extension.ts
```

With `--remote`, project instruction resources are loaded from the daemon workspace cwd: `.grip/skills`, `.grip/rules`, `.grip/prompts`, ancestor `.agents/skills` and `.agents/rules`, and per-directory `AGENTS.override.md`/`AGENTS.md`/`CLAUDE.md` context. `AGENTS.override.md` replaces the other context candidates only in its own directory. Extension loading, themes, user resources, and package resources remain local.

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--tui-mode <mode>` | TUI mode: `regular` (default) or experimental `fullscreen` |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

In `fullscreen` mode, the transcript scrolls inside the terminal viewport while queued messages, status, extension widgets, editor, and footer remain fixed at the bottom. In `regular` mode, Grip uses the terminal main screen and terminal-owned scrollback. Set **TUI mode** in `/settings` to switch immediately and choose the default for future sessions; `--tui-mode` overrides it for one startup. **Fullscreen exit output** controls whether shutdown replays the complete transcript or restores the previous main screen without replaying transcript content, leaving any shell or launcher resume affordance visible.

### File Arguments

Prefix files with `@` to include them in the message:

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

# Model with provider prefix
grip --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
grip --model sonnet:high "Solve this complex problem"

# Limit model cycling
grip --models "claude-*,gpt-4o"

# Read-only mode
grip --tools read,grep,find,ls -p "Review the code"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GRIP_CODING_AGENT_DIR` | Override config directory; default is `~/.grip/agent` |
| `GRIP_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `GRIP_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `GRIP_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `GRIP_SKIP_VERSION_CHECK` | Skip the Grip version update check at startup. This prevents the npm metadata request |
| `GRIP_TELEMETRY` | Override install/update telemetry: `1`/`true`/`yes` or `0`/`false`/`no`. This does not disable update checks |
| `GRIP_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

## Design Principles

Grip keeps the core small and pushes workflow-specific behavior into extensions, skills, rules, prompt templates, and packages.

Grip includes a focused subagent delegation tool but keeps broader workflow-specific behavior in extensions, skills, rules, prompt templates, and packages. It intentionally does not include built-in MCP, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages, or use external tools such as containers and tmux.

For the original upstream rationale, read the [Pi blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).
