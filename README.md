# Grip

Grip is a self-extensible coding-agent harness for working in a terminal. It provides the `grip` CLI and the runtime packages it uses.

## Install

After the installer and checksummed binaries are published to the [Grip GitHub releases](https://github.com/greppleai/grip/releases), install the single executable (no npm or Bun required on the destination machine):

```bash
# macOS or Linux; inspect install.sh before piping it to a shell
curl -fsSL https://raw.githubusercontent.com/greppleai/grip/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/greppleai/grip/main/install.ps1 | iex
```

The installers verify the release's SHA-256 before replacing `grip` in `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\Grip\bin`). They add the directory to future shells' PATH when needed. To pin a version, set `GRIP_VERSION=vX.Y.Z` before installing; rerun the installer to update. These URLs will not work until the scripts are merged and a release publishes its binary assets.

## Use

```bash
grip
```

Run `grip --help` for command-line options. See the [Grip documentation](packages/coding-agent/docs/index.md) for configuration, extensions, providers, sessions, and advanced workflows.

## Packages

| Package | Description |
| --- | --- |
| [@greppleai/grip](packages/coding-agent) | Interactive coding-agent CLI |
| [@greppleai/grip-agent-core](packages/agent) | Agent runtime, tools, and state management |
| [@greppleai/grip-ai](packages/ai) | Multi-provider LLM API |
| [@greppleai/grip-tui](packages/tui) | Terminal UI library |

## Development

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
./grip-test.sh
# Build the single-file executable locally (requires Bun and development dependencies):
NODE_OPTIONS=--import=tsx npm run build:binary --workspace @greppleai/grip
./packages/coding-agent/dist/grip --version
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [AGENTS.md](AGENTS.md) for repository-specific development instructions.

## Security and releases

- Dependency changes and generated lockfiles are reviewed; `package-lock.json` is the build dependency ground truth.
- Binary release assets and SHA-256 checksums are built from tags; no npm publishing is triggered by the release workflows.
- The executable embeds its resources and extracts native/WASM and documentation files to a private temporary directory at runtime; user configuration stays in its usual location. A crash or an OS lock on a loaded native add-on may leave disposable temporary data behind.
- `grip update --self` cannot replace a compiled binary; rerun the verified installer to update it.

## License

MIT

Grip is based on Pi Agent.
