# Remote Workspace Daemon

`grip --daemon` starts Grip as a remote workspace runtime. A normal local Grip process remains the orchestrator: it owns provider credentials, model calls, prompts, sessions, compaction, extensions, subagents, RPC, and UI. The daemon owns one configured workspace and executes canonical workspace tools, primitive project-resource operations, streamed file transfers, and optional process execution.

Grip includes the daemon in the single-file executable; install a published, checksummed binary using [Quickstart](quickstart.md#install) or use a locally built executable. The daemon needs no npm installation on its host.

## Start a daemon

```bash
# Install the verified Grip binary first (see Quickstart).
GRIP_DAEMON_TOKEN='long-random-token' \
grip --daemon --daemon-cwd /workspace --daemon-host 127.0.0.1 --daemon-port 8787
```

Connect from another Grip process:

```bash
GRIP_REMOTE_TOKEN='long-random-token' grip --remote ws://127.0.0.1:8787/grip/workspace
```

Attach an interactive Grip session when the daemon is running in a sandbox whose workspace root is `/workspace`:

```bash
GRIP_REMOTE_TOKEN='long-random-token' grip
/sandbox --attach ws://127.0.0.1:8787/grip/workspace
```

For a deferred daemon backend, use `grip --remote-deferred --remote-cwd /workspace` followed by `/sandbox --attach <ws://url>`. `/sandbox` is the only interactive backend-management command.

Use `GRIP_REMOTE_TOKEN` on the client. Do not put tokens in query strings or URLs.

## Topology and trust boundary

In ordinary v1 mode, each daemon connection exposes a single workspace root; all clients of a daemon still share its OS-user trust domain. The daemon is an authenticated remote-code-execution service: anyone with the bearer token can use every advertised daemon capability. The separately negotiated v2 shared-Lima mode binds a workspace root per channel, but does **not** provide hostile-client isolation.

Application-layer confinement prevents protocol paths and symlinks from escaping the configured workspace and optional temporary root for file tools, resource reads, file transfers, temporary outputs, and subprocess working directories. `GRIP_DAEMON_TEMP_ROOT` is opt-in and should point only to disposable storage inside an OS sandbox; it is unset by default. This is not an operating-system sandbox. If process execution is enabled, commands can access anything the daemon OS user can access. Run the daemon as a dedicated unprivileged user, in a container, VM, or equivalent sandbox for hostile repositories.

The daemon refuses root and insecure non-loopback deployment by default. Non-loopback HTTP requires explicit override and should only be used behind a trusted TLS terminator. Prefer TLS for direct non-local use.


The shared Lima workflow uses a **separately negotiated v2** protocol, not a reinterpretation of the v1 single-root handshake. Each local TUI opens its own authenticated WebSocket and binds a workspace channel under the guest daemon's fixed parent mount. The daemon starts with `--daemon-shared-parent`; ordinary `--remote` still creates a v1 connection. Shared transfers are not advertised (ordinary v1 transfers remain available), and guest process execution is enabled for trusted clients only. See [sandbox.md](sandbox.md#direct-shared-lima-attachment) for attachment and stop policy.

## Configuration

Common options:

| Option | Environment | Description |
| --- | --- | --- |
| `--daemon-host <ip>` | `GRIP_DAEMON_HOST` | Bind address. Defaults to `127.0.0.1`. |
| `--daemon-port <port>` | `GRIP_DAEMON_PORT` | Bind port. Defaults to `8787`. |
| `--daemon-cwd <dir>` | `GRIP_DAEMON_CWD` | Canonical confined workspace root. Defaults to current directory. |
| environment only | `GRIP_DAEMON_TEMP_ROOT` | Optional additional confined temporary root. Intended for container/VM scratch storage such as `/tmp`. |
| environment only | `GRIP_DAEMON_TOKEN` | Server bearer token required by clients. |
| environment only | `GRIP_DAEMON_ORIGINS` | Optional comma-separated exact WebSocket Origin allowlist. |
| `--daemon-tls-cert <file>` / `--daemon-tls-key <file>` | `GRIP_DAEMON_TLS_CERT` / `GRIP_DAEMON_TLS_KEY` | Direct TLS listener material. |
| `--daemon-allow-process-exec` | `GRIP_DAEMON_ALLOW_PROCESS_EXEC` | Enable shell/tool subprocess execution. |

Run `grip --daemon --help` for the complete limit and deployment option list.

## Resources and extensions

Project instructions, skills, rules, and prompt templates are read through the daemon's confined primitive operations and parsed by the local orchestrating Grip with remote provenance. User and package resources remain local.

Extensions always run in the orchestrating Grip process. `grip --daemon` does not discover or execute user, package, or project extensions and does not provide a fake `ExtensionContext`. Local extension hooks still wrap remote tool calls once, and backend-aware extensions may use the borrowed daemon `ToolOperations` facade.


## Operations and file transfer

The daemon publishes a negotiated catalog of canonical Grip workspace tools. Local Grip prepares tool arguments once; the daemon validates again before execution. Catalog generation changes pause and refresh the local proxy. Stale, not-started calls may be retried once; calls that may have started side effects are not replayed.

File uploads/downloads and artifact reads use bounded streamed transfer messages. Whole responses, updates, transfer chunks, inbound frames, outbound queues, active calls, subprocess output, request duration, connections, and shutdown are bounded. Partial upload/write state is cleaned up on abort, timeout, disconnect, or shutdown.

## Docker examples

A local daemon smoke-test image lives at `packages/coding-agent/examples/daemon-docker` and starts the packaged `grip --daemon` command inside the container.


```bash
docker build -f packages/coding-agent/examples/daemon-docker/Dockerfile -t grip-remote-daemon-test .
docker run --rm -p 8787:8787 --name grip-remote-daemon-test grip-remote-daemon-test
GRIP_REMOTE_TOKEN=dev-token-dev-token-dev-token-dev-token ./grip-test.sh --remote ws://127.0.0.1:8787/grip/workspace
```

## Troubleshooting

- `401`/`403`: check `GRIP_DAEMON_TOKEN` on the server and `GRIP_REMOTE_TOKEN` on the client. Tokens are header-only.
- `404`: connect to `/grip/workspace`.
- Non-loopback bind rejected: use loopback, enable TLS, or explicitly accept insecure transport only behind a trusted boundary.
- `bash` unavailable: start the daemon with `--daemon-allow-process-exec` and isolate the OS user/container.
- Resource reload mismatch: reconnect or run `/reload` after changing remote project resources.

## Migration from `pi-daemon`

First list global packages with `npm ls -g --depth=0`. If the retired standalone daemon package is installed, uninstall it by its exact name from that list with `npm uninstall -g PACKAGE_NAME` (replace `PACKAGE_NAME` before running). Then install Grip:

```bash
npm install -g --ignore-scripts @greppleai/grip
grip --daemon --daemon-cwd /workspace --daemon-port 8787
```

Breaking changes from the retired daemon:

- no separate daemon package, `pi-daemon` binary, compatibility shim, or old unversioned protocol;
- no query-string or userinfo tokens; use `Authorization: Bearer` via `GRIP_REMOTE_TOKEN`;
- no `HOST`/`PORT` aliases; use `GRIP_DAEMON_HOST`/`GRIP_DAEMON_PORT` or CLI flags;
- workspace paths, symlinks, transfers, subprocess cwd, temporary outputs, and resources are confined;
- process execution is disabled unless explicitly granted;
- non-loopback and root deployments are refused unless explicitly overridden.
