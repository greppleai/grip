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
| `/websearch login` | Select DuckDuckGo, Brave Search, or Firecrawl; save or update search API keys |
| `/model [reference or query]` | Choose a provider and model, select an exact reference, or search across providers |
| `/job model show` | Show the effective job model and its source |
| `/job model set --model <provider/model-id>` | Save the single global job model |
| `/job model clear` | Clear the saved model (fall back to the environment or parent model) |
| `/system-prompt` | Show the current main-agent system prompt in the TUI without sending a message to the model |
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
`/hooks`, `/sandbox`, `/job`, and `/system-prompt` are user-only interactive commands hidden from model-visible command catalogs. `/system-prompt` only renders the current main prompt in the TUI; it neither delegates a task nor sends a message to an LLM. `/sandbox` shows or clears the current backend, attaches a sandbox daemon, manages Lima sandboxes, and can set a per-directory default with `/sandbox start --name <vm> --set-default` or `/sandbox default set`; see [Workspace Sandbox](sandbox.md). `/job` autocompletes its model subcommands and available models.
| `/hooks <enable|disable>` | Enable or disable subsequent hooks for the current session |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit Grip |

`/hooks disable` immediately prevents subsequent hook events in the current session; a hook execution already in progress is allowed to finish. `/hooks enable` resumes dispatch. Skipped events are not replayed, and a newly created or resumed session starts with hooks enabled. `/reload` preserves this enabled/disabled state while refreshing file-backed hook configuration.


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

Built-in tools include `read_image`, `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `websearch`, `session_search`, `session_entry_get`, `compress_context`, and `job`.

`read_image` is active by default and accepts image files only; it returns the image as model input and rejects text files rather than reading their contents. The separate `read` tool handles text files and remains opt-in: select it explicitly with `--tools read` or include it in an allowlist. Image processing may resize large images to fit provider limits, and image size and supported formats depend on the selected model/provider. Models without vision support cannot interpret image payloads.

The `job` tool is active by default. Disable it through `/settings` or `"enableJobs": false` in `settings.json`. An explicit `--tools` allowlist selects its own subset regardless of that setting; no-tools modes still suppress it. Parent tool allowlists and exclusions bound child tool access.

| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

## Design Principles

Grip keeps the core small and pushes workflow-specific behavior into extensions, skills, rules, prompt templates, and packages.

Grip includes a focused job delegation tool but keeps broader workflow-specific behavior in extensions, skills, rules, prompt templates, and packages. It intentionally does not include built-in MCP, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages, or use external tools such as containers and tmux.

For the original upstream rationale, read the [Pi blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).
