# Quickstart

This page gets you from install to a useful first Grip session.

## Install

When available in your registry, Grip is distributed as an npm package:

```bash
npm install -g --ignore-scripts @greppleai/grip
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Grip does not require install scripts for normal npm installs. The new npm scope's publication and ownership have not been verified by this repository rename.

### Uninstall

Use the package manager that installed Grip:

```bash
# npm install -g
npm uninstall -g @greppleai/grip

# pnpm
pnpm remove -g @greppleai/grip

# Yarn
yarn global remove @greppleai/grip

# Bun
bun uninstall -g @greppleai/grip
```

Uninstalling Grip leaves settings, credentials, sessions, and installed Grip packages in `~/.grip/agent/`. For migrating an older Pi installation, see [Migrating to Grip](migrating-to-grip.md). The old Pi curl installer is not a verified Grip installation method.

Then start Grip in the project directory you want it to work on:

```bash
cd /path/to/project
grip
```

## Authenticate

Grip can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start Grip and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching Grip:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
grip
```

You can also run `/login` and select an API-key provider to store the key in `~/.grip/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once Grip starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Grip gives the model tools for:

- reading, writing, and editing files
- running shell commands
- language-server diagnostics, navigation, and refactoring when an external LSP server is explicitly configured

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Grip runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

Subagent delegation is opt-in. Open `/settings` and set **Enable subagents** to `true`, or set `"enableSubagents": true` in `settings.json`, to activate `subagent`, `subagent_runs`, and `create_subagent`. The `subagent` tool includes explore, worker, and reviewer presets.

## Give Grip project instructions

Grip loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Grip loads:

- `~/.grip/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

If a directory contains `AGENTS.override.md`, Grip loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Other directories continue to layer normally.

Restart Grip, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
grip @README.md "Summarize this"
grip @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
grip -c                    # Continue most recent session
grip -r                    # Browse previous sessions
grip --session <path|id>  # Open a specific session
```

Inside Grip, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
grip -p "Summarize this codebase"
cat README.md | grip -p "Summarize this text"
grip -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Grip](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Grip Packages](packages.md) - install shared extensions, skills, rules, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
