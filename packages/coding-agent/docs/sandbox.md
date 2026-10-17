# Workspace Sandbox

`/sandbox` is the single interactive command for workspace tool backends. It can show or clear the active backend, attach an existing sandbox daemon, or manage a Docker container or Lima VM. Sandbox connections are session-local: a new session starts on its underlying backend, returning to an earlier session reconnects its remembered sandbox while Grip remains running, and multiple session sandboxes may coexist. Local Grip remains the orchestrator: provider credentials, model calls, session history, extensions, RPC, and UI stay in the local process; subagent workspace tools inherit the parent session's active sandbox.

The command is user-only. It is shown in interactive slash-command completion, but it is not exposed through RPC `get_commands`, extension-visible command catalogs, system prompts, tool definitions, prompt templates, skills, or rules. This only hides the Grip operator command from LLM-visible catalogs; it does not prevent a model with host shell access from invoking Docker or Lima directly.

## Commands

Type these commands in interactive mode:

```text
/sandbox [status]
/sandbox clear
/sandbox --attach <ws://url>
/sandbox start [--runtime docker|lima] [--image <image>] [--name <lima-instance>] [--template <lima-template>]
/sandbox list [--runtime docker|lima]
/sandbox stop [sandbox]
```

- `/sandbox` and `/sandbox status` show the active workspace tool backend.
- `/sandbox clear` disconnects the active deferred or sandbox backend without stopping a managed container or VM.
- `/sandbox --attach` connects to an already-running sandbox daemon without starting or managing its container. Set `GRIP_REMOTE_TOKEN` when the daemon requires authentication. The daemon workspace root must match `--remote-cwd` in deferred mode, or `sandbox.workspaceMountPath` (default `/workspace`) otherwise.
- `/sandbox start` launches a Docker container by default. With `--runtime lima`, it creates a Lima VM from `template:docker-rootful`, mounts the current working directory read-write at `/workspace`, starts `grip --daemon` inside the VM, and switches workspace tools and project resource loading to that daemon. Use `--template` to override the Lima template for a new VM. Passing `--name` implies `--runtime lima` when no runtime is specified; without `--name`, runtime selection is unchanged. `--name` creates the named instance if missing, starts it if stopped, or reuses it if running. Existing instances must already have a writable `/workspace` mount mapping to the current directory. Explicitly named VMs remain running after `/sandbox stop` or graceful Grip shutdown; only their Grip daemon is stopped, regardless of `sandbox.cleanup`.
- `/sandbox list` lists sandboxes for the current workspace. Use `/sandbox list --runtime lima` to list matching Lima instances that can be reused by name.
- `/sandbox stop` stops the active Grip-owned sandbox. For a daemon connected with `--attach`, it only detaches and restores the previous tool backend. Explicitly named Lima VMs remain running, but their Grip daemon is stopped. With an id or name, it uses the active runtime, or `sandbox.runtime` when no sandbox is active. Ambiguous cases require an explicit target.

Example:

```text
GRIP_REMOTE_TOKEN=... grip
/sandbox --attach ws://127.0.0.1:8787/grip/workspace
/sandbox stop

/sandbox start --image grip-sandbox:local
/sandbox list

/sandbox start --runtime lima
/sandbox start --runtime lima --template template:alpine
/sandbox list --runtime lima
/sandbox stop

/sandbox start --name my-dev
/sandbox stop
```

When start succeeds, Grip shows the sandbox name/id, the host-to-sandbox workspace mount, a redacted daemon endpoint, and a status line that workspace tools/resources now route through the sandbox daemon.

## Workspace mount and daemon endpoint

Defaults:

| Setting | Default |
| --- | --- |
| Host workspace | current working directory |
| Container workspace | `/workspace` |
| Daemon command | `grip --daemon` |
| Docker network mode | `bridge` |
| Daemon preferred bind and endpoint | `127.0.0.1:8787` |
| Daemon token | generated per start |
| Lima binary | `limactl` |
| Lima template | `template:docker-rootful` |

The mounted workspace is read/write. Any process in the container can modify files in the mounted host directory. Paths reported by the daemon use the container workspace root (`/workspace`), while local Grip keeps session and UI state on the host. The container uses Docker bridge networking and publishes only the authenticated daemon port to the configured host bind address (`127.0.0.1` by default), so sandbox processes cannot directly access host loopback services. Grip uses the configured daemon port when available and otherwise selects an available host port, allowing separate sessions to keep concurrent sandbox containers. The default image also configures `/tmp` as an additional confined temporary root, so workspace tools can use disposable scratch files without exposing another host mount.

Sandbox bash calls receive the current `GRIP_SESSION_ID`, `GRIP_SESSION_FILE`, `GRIP_PROVIDER`, `GRIP_MODEL`, and `GRIP_REASONING_LEVEL` values per invocation. This metadata follows the active session rather than the daemon process environment; other host environment variables are not forwarded automatically.

`/sandbox start` uses a fresh bearer token for every daemon. Docker receives it through the container environment. Lima generates it inside the guest and returns it directly to the host launcher. Grip keeps the token in memory and uses it to connect to the daemon. Tokens are not put in Docker or Lima command arguments, image layers, container or instance names, labels, URLs, or user-facing status. Status, list output, and errors redact secrets.

## Image and configuration

The current default image is `ghcr.io/fleetagent/pi-sandbox:latest`, an upstream image, **not a verified Grip image**. To run a Grip daemon, build a reviewed local image below or configure a verified compatible replacement; do not assume the upstream image provides `grip`. The local example image uses integrated `grip --daemon` from `@greppleai/grip`. The retired upstream `@fleetagent/pi-daemon` package and `pi-daemon` binary are not used or supported.

When a sandbox daemon connects, Grip also loads `~/.grip/AGENTS.md` from the daemon user's home directory as user-scoped context. This is separate from the orchestrator's global instructions and lets custom Docker images or Lima users define instructions that apply only inside the sandbox. Create or update the file inside the sandbox, then run `/reload` to refresh context.
Configuration precedence for a start is:

1. command flags: `/sandbox start --runtime <runtime>`, `--image <image>`, `--name <lima-instance>`, and `--template <lima-template>`;
2. environment variables: `GRIP_SANDBOX_*`;
3. project settings in `.grip/settings.json`;
4. global settings in `~/.grip/agent/settings.json`;
5. defaults.

Sandbox settings:

```json
{
  "sandbox": {
    "runtime": "docker",
    "image": "grip-sandbox:local",
    "dockerBinary": "docker",
    "limaBinary": "limactl",
    "limaTemplate": "template:docker-rootful",
    "limaInstanceNamePrefix": "grip-sandbox",
    "workspaceMountPath": "/workspace",
    "containerNamePrefix": "grip-sandbox",
    "daemonPort": 8787,
    "daemonHostBind": "127.0.0.1",
    "cleanup": "stop"
  }
}
```

Environment overrides:

| Variable | Setting |
| --- | --- |
| `GRIP_SANDBOX_RUNTIME` | `sandbox.runtime` (`docker` or `lima`) |
| `GRIP_SANDBOX_IMAGE` | `sandbox.image` |
| `GRIP_SANDBOX_DOCKER` | `sandbox.dockerBinary` |
| `GRIP_SANDBOX_LIMA` | `sandbox.limaBinary` |
| `GRIP_SANDBOX_LIMA_TEMPLATE` | `sandbox.limaTemplate` |
| `GRIP_SANDBOX_LIMA_INSTANCE_PREFIX` | `sandbox.limaInstanceNamePrefix` |
| `GRIP_SANDBOX_WORKSPACE_MOUNT` | `sandbox.workspaceMountPath` |
| `GRIP_SANDBOX_CONTAINER_PREFIX` | `sandbox.containerNamePrefix` |
| `GRIP_SANDBOX_DAEMON_PORT` | `sandbox.daemonPort` |
| `GRIP_SANDBOX_DAEMON_HOST_BIND` | `sandbox.daemonHostBind` |
| `GRIP_SANDBOX_CLEANUP` | `sandbox.cleanup` (`stop` or `remove`) |

## Base image

Build the local base image from repository release artifacts:

```bash
npm run release:local -- --out /tmp/grip-local-release --force
docker build \
  -f packages/coding-agent/examples/sandbox-docker/Dockerfile \
  -t grip-sandbox:local \
  /tmp/grip-local-release
```

Then use it for one start:

```text
/sandbox start --image grip-sandbox:local
```

Or make it the default:

```bash
GRIP_SANDBOX_IMAGE=grip-sandbox:local grip
```

See [`../examples/sandbox-docker/README.md`](../examples/sandbox-docker/README.md) for image build inputs and manual `docker run` commands.

## Sandbox identity, list, and stop

Grip labels sandbox containers and filters list/stop operations by those labels, not by name alone. Labels include sandbox ownership, workspace hash, workspace mount target, daemon port, owner uid when available, Grip version, and a session id. Labels do not contain tokens.

Docker container names use the configured prefix plus a sanitized workspace name, workspace hash, and per-start session suffix. Managed Lima names use `sandbox.limaInstanceNamePrefix` with the same workspace/session identity and a random suffix. Daemon ports are allocated per start, preferring `sandbox.daemonPort` and falling back to an available host port. `/sandbox list --runtime lima` reports Lima instances whose writable `/workspace` mount maps to the current host workspace; their names can be passed back to `/sandbox start --runtime lima --name <name>`. Explicitly named VMs are left running by `/sandbox stop`, whether newly created or reused, while Grip stops or removes automatically named VMs according to `sandbox.cleanup`.

Stopping the active sandbox clears the current session's remote tool backend and returns it to the previous non-sandbox backend or local tool execution. If Grip was started in deferred remote mode, stop leaves that session's deferred backend unconfigured. Switching sessions disconnects the old live client without stopping its managed sandbox; returning to that session reconnects it from memory. On graceful Grip shutdown, Docker containers and automatically named Lima instances started by that Grip process are stopped or removed according to `sandbox.cleanup`; explicitly named Lima VMs remain running with their Grip daemon stopped. Tokens are never persisted to session files, so sandboxes are not restored after Grip exits.

## Security boundaries

Docker and Lima sandbox modes are not complete security sandboxes.

- The current working directory is mounted read/write into the container or VM.
- Subagents inherit the active workspace backend. Sandboxed subagents reject host cwd overrides, do not load host project context or extensions, treat custom system prompts as literal text, and cannot continue an older run after the parent backend changes.
- Sandbox processes can read, write, delete, or chmod files in that mount as the guest user.
- Files created by the default image are owned by uid `1000` unless Docker/user policy changes it.
- `/tmp` is writable container-local scratch storage and is removed with the container; it is not mounted from the host by default.
- The daemon token authorizes high-privilege workspace tool access for the mounted workspace.
- Anyone with Docker access on the host may inspect containers, images, mounts, labels, ports, and environment depending on host policy.
- Override Docker images and Lima templates are trusted code. A malicious image or template can run arbitrary processes against the mounted workspace.
- Docker socket mounts, privileged mode, broad host volumes, or extra credentials can further break the intended boundary.
- Bridge networking prevents direct host-loopback access, but the container may still reach external networks and host services deliberately exposed beyond loopback.
- Reused Lima instances retain their existing filesystem, software, credentials, and network access; only reuse instances you trust.
- Hidden command behavior only keeps `/sandbox` out of LLM-visible Grip catalogs. It is not an OS, Docker, or VM permission boundary.

Use trusted images, avoid mounting the Docker socket, avoid privileged containers, keep `sandbox.daemonHostBind` loopback-only unless you add a separate trusted network/TLS boundary, and do not place secrets in the mounted workspace unless the sandbox image should access them.

## Troubleshooting

- Docker missing: install Docker or set `GRIP_SANDBOX_DOCKER` / `sandbox.dockerBinary` to the correct executable.
- Lima missing: install Lima or set `GRIP_SANDBOX_LIMA` / `sandbox.limaBinary`. Newly created Lima VMs, including explicitly named ones, provision the current `@greppleai/grip` version through npm when `grip` is missing; reused instances must already provide a compatible `grip` command. Provisioning requires an apt-based guest and package availability.
- Permission denied connecting to Docker: add the user to the appropriate Docker group, start Docker Desktop, or run Grip where Docker is accessible. Treat Docker group membership as host-level administrative power.
- Image pull/build failure: verify the image name, registry authentication, network access, and local build command. For local images, build with the local release directory as context; do not use `--skip-install` for the sandbox Dockerfile.
- Port conflict: Grip prefers the configured daemon port (default `8787`) and automatically selects an available port when it is occupied. A remaining bind failure can indicate an invalid `sandbox.daemonHostBind`, exhausted local resources, or a race with another process.
- Start succeeds but daemon activation fails: the container or VM may still be running. Use the runtime-specific `/sandbox list` and `/sandbox stop <id-or-name>` commands to clean it up.
- `/sandbox list` is empty: Docker listing only includes Grip-labeled containers; Lima listing only includes instances with the current workspace mounted at `/workspace`. Check that you selected the intended runtime and workspace.
- `/sandbox stop` says no sandbox was found: pass the listed id or name, or switch to the workspace that owns the sandbox.
- Already stopped: stop is idempotent for matching containers and reports already-stopped containers cleanly.
