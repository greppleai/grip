# Grip Documentation

Grip is a minimal terminal coding harness. It is designed to stay small at the core while being extended through TypeScript extensions, skills, rules, prompt templates, themes, and Grip packages.

## Quick start

Install the single compiled executable from a published Grip release:

```bash
# macOS/Linux
curl -fsSL https://raw.githubusercontent.com/greppleai/grip/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/greppleai/grip/main/install.ps1 | iex
```

These commands require the scripts and checksummed release binaries to have been published. They do **not** install the Grip CLI through npm. See [Quickstart](quickstart.md) for pinning versions, PATH, and uninstall instructions; the old Pi installer at `https://pi.dev/install.sh` is unrelated.

Then run it in a project directory:

```bash
grip
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting Grip.

For the full first-run flow, see [Quickstart](quickstart.md). Upgrading from the previous project identity? Read [Migrating to Grip](migrating-to-grip.md); existing configuration and sessions are not moved automatically.

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Migrating to Grip](migrating-to-grip.md) - manual migration from the old CLI, packages, and configuration paths.
- [Using Grip](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [Settings](settings.md) - global and project settings.
- [Language Server Protocol](lsp.md) - configure spawned servers, attached endpoints, host connections, and remote-backend path mappings.
- [Remote Daemon](daemon.md) - run `grip --daemon` as a confined remote workspace runtime.
- [Lima Sandbox](sandbox.md) - hidden user-only `/sandbox` command for Lima VM workspace execution.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Rules](rules.md) - on-demand mandatory constraints and policies.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Grip packages](packages.md) - bundle and share extensions, skills, rules, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed Grip in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Session format](session-format.md) - JSONL session file format, entry types, and session APIs.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
