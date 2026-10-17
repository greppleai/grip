# Grip

Grip is a self-extensible coding-agent harness for working in a terminal. It provides the `grip` CLI and the runtime packages it uses.

## Install

Install the supported CLI package from a verified registry:

```bash
npm install -g --ignore-scripts @greppleai/grip
```

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
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [AGENTS.md](AGENTS.md) for repository-specific development instructions.

## Security and releases

- Dependency changes and generated lockfiles are reviewed; `package-lock.json` is the dependency ground truth.
- The published CLI includes a generated `npm-shrinkwrap.json` to pin its transitive dependencies.
- Use `npm run release:local` to build and inspect release artifacts locally before an authorized release.
- Install commands and `grip update --self` use `--ignore-scripts` where supported.

## License

MIT

Grip is based on Pi Agent.
