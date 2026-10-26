# Workspace Sandbox

`/sandbox` is the user-only interactive command for workspace tool backends. It can show or clear the active backend, attach an existing sandbox daemon, or manage a Lima VM. Connections are remembered in memory while Grip runs. If `/resume` switches sessions while a sandbox is connected, the selected session uses that active connection; without a live connection, switching back to a session reconnects its remembered sandbox (if any). Local Grip retains provider credentials, model calls, session history, extensions, RPC, and UI; child job workspace tools inherit the active backend.

The command appears in slash-command completion but not in model-visible catalogs, system prompts, tool definitions, templates, skills, or rules. This is not a permission boundary: a model with host shell access may still invoke Lima directly.

`/new` starts a fresh conversation in the same connected sandbox (started or attached) without starting another VM. When no sandbox is connected, `/new` starts a local session. Sandbox connections are remembered in memory only while Grip remains running.

Inside a connected sandbox, `/cd <directory>` changes the guest working directory for subsequent tools within the existing mounted workspace; completion lists directories from the guest, and the footer displays the guest working directory. `/cd` without an argument returns to the guest workspace root. It does not change the host session directory, remount the workspace, or reconnect the daemon. In a VM that mounts one host project at `/workspace`, `/workspace/planner` is not another mounted host project; open that project as a separate workspace, or attach a daemon whose workspace root contains both projects. The guest working directory resets to the mount root after a session switch or reconnection. Reviewed extensions may explicitly call `ctx.execHostProcess()` (direct argv) or `ctx.execHostCommand()` (shell) to run on the host after per-operation user approval; only managed sandboxes with a verified mount can translate guest directories to host directories. See [Extensions](extensions.md#ctxexechostprocess-direct-host-argv).

Lima-managed sandboxes allow workspace tools (`read`, `write`, `edit`, `ls`, `find`, and `grep`) to access paths anywhere in the guest filesystem, including outside the mounted workspace. This does not mount additional host directories; guest OS permissions still apply. `/cd` remains within the mounted workspace. An attached daemon stays workspace-confined by default: only enable `--daemon-allow-full-filesystem` when the daemon runs inside an intentionally isolated guest, never on an untrusted host. Existing guest daemons need an update or restart to enable this access.

## Commands

```text
/sandbox [status]
/sandbox clear
/sandbox --attach <ws://url>
/sandbox start [--name <lima-instance>] [--workspace <host-folder>] [--template <lima-template>] [--update] [--set-default]
/sandbox list
/sandbox default [status]
/sandbox default --name <existing-lima-vm>
/sandbox default set
/sandbox default clear
/profile sandbox <profile> [status]
/profile sandbox <profile> --name <existing-lima-vm> [--autoconnect on|off]
/profile sandbox <profile> --autoconnect on|off [--name <existing-lima-vm>]
/profile sandbox <profile> auto-connect on|off
/profile sandbox <profile> clear
```

- `/sandbox status` shows the active workspace tool backend. `/sandbox clear` disconnects it without stopping a VM.
- `/sandbox --attach` connects to an already-running daemon without managing its lifecycle. Set `GRIP_REMOTE_TOKEN` if required. The daemon workspace root must match `--remote-cwd` in deferred mode, or `sandbox.workspaceMountPath` otherwise.
- `/sandbox start` creates a per-session Lima VM with the current working directory mounted read/write at `/workspace`. `--template` overrides the VM template for a new instance. `--name` creates an absent VM, resumes a stopped per-session VM, or attaches to a running VM after guest-mode inspection. A running VM with a verified shared guest-state marker uses the direct shared-daemon protocol; a VM without it follows the per-session path. `/sandbox start --name my-dev --set-default` records the VM as this host directory's future default **after** it connects successfully; `--set-default` requires `--name`.
- `--workspace <host-folder>` selects a host workspace independently of the active host directory, for example `/sandbox start --name my-dev --workspace /home/me/projects/other`. Relative paths resolve against the active host directory; quote paths containing spaces. Leading `$HOME`, `${HOME}`, and `~` expand to the host user's home directory, including inside quoted paths. No shell commands or other environment variables are expanded. Existing shared and per-session VMs accept directories within their fixed writable workspace mount, with symlinks resolved before checking containment. Selecting a subdirectory maps the agent workspace and initial guest working directory to that subdirectory (for example, `/host/projects/grip` within `/host/projects:/workspace` becomes `/workspace/grip`). For a new VM, the selected folder becomes its mount. This does not change the host session directory or add mounts to an existing VM.
- `/sandbox start --name <running-shared-VM> --update` updates a verified shared guest and reconnects this TUI. It stages and validates the replacement first, stops its supervised daemon (disconnecting every attached client), atomically replaces the executable, and restarts the same service. It cannot be combined with `--template`; legacy, stopped, or unverifiable VMs are refused without disconnecting anyone.
- `/sandbox list` shows Lima instances whose workspace mount contains the current host workspace, including ancestor-mounted VMs.
- `/sandbox default --name <existing-lima-vm>` assigns an existing named Lima VM to the current host directory for future interactive startups. `/sandbox default set` assigns the currently connected named Lima VM instead, including one created without `--name`; it rejects a raw `--attach` daemon or a VM mounted for a different host directory. `/sandbox default` shows the exact-directory assignment; `/sandbox default clear` removes it without disconnecting an active sandbox. Assignments live only in the user-home Grip settings file and match the exact canonical directory, not child directories. On startup Grip verifies the named VM exists and uses the usual `/sandbox start --name` mount/guest checks before connecting; it never creates a missing VM automatically. An explicitly configured remote backend takes precedence. A failed connection warns and leaves the session local. This setting does not persist daemon tokens or apply to raw `--attach` URLs.
- A profile can specify `"defaultSandbox": "my-dev"` in its entry in user-home `profiles`, or assign an existing VM with `/profile sandbox work --name my-dev --autoconnect on`. `--name` autocompletes existing named Lima VMs; `--autoconnect on|off` can be combined with `--name` in either order or used alone. The existing `auto-connect on|off` form also works. `/profile sandbox work` shows its configuration, and `clear` removes the profile's VM assignment. The selected profile's VM takes priority over the directory assignment; `"autoConnectSandbox": false` in that profile disables both startup choices. Auto-connect defaults to enabled, but only for an assigned VM. Profile selection by directory prefix applies to descendants; the existing VM must be compatible with the actual workspace mount. Project settings cannot choose a startup VM. `/sandbox default` continues to manage the exact-directory assignment; `/profile use` changes the active profile only for this process and does not connect or replace a running sandbox. Next startup uses directory rules again, or no profile if none match.
- `/sandbox stop` stops only tracked per-session daemons and process-owned VMs. For a shared named VM or an attached daemon it detaches the current session only. A matching name or mount does not establish ownership; named per-session VMs remain running after daemon stop. Grip never stops another client's shared guest or VM.

```text
/sandbox start
/sandbox start --template template:alpine
/sandbox list
/sandbox stop
/sandbox start --name my-dev
/sandbox start --name my-dev --set-default
/sandbox default set
/sandbox start --name my-dev --update
/sandbox stop
```

A successful start shows the VM name/id, host-to-guest workspace mount, redacted daemon endpoint, and backend status. Workspace tools and resources then route through the guest daemon. Sandbox bash calls receive the current `GRIP_SESSION_ID`, `GRIP_SESSION_FILE`, `GRIP_PROVIDER`, `GRIP_MODEL`, and `GRIP_REASONING_LEVEL` metadata for the active session; other host environment variables are not forwarded automatically.

## Configuration

The mounted workspace is writable. The daemon normally binds through a host loopback forward on port `8787`; newly created VMs select an available port if necessary. New per-session daemons use fresh bearer tokens. Running shared guests retain their existing token, retrieved by each local TUI via Lima access. Grip keeps tokens in memory and redacts them from displayed output. Tokens are not stored in session files, so sandbox backends are not restored after Grip exits.

Start precedence: command `--template`, then `GRIP_SANDBOX_*` environment variables, project `.grip/settings.json`, the selected user profile, global `~/.grip/agent/settings.json`, then defaults. Available settings:

```json
{
  "sandbox": {
    "limaBinary": "limactl",
    "limaTemplate": "template:docker-rootful",
    "limaInstanceNamePrefix": "grip-sandbox",
    "workspaceMountPath": "/workspace",
    "daemonPort": 8787,
    "daemonHostBind": "127.0.0.1",
    "cleanup": "stop"
  }
}
```

| Environment variable | Setting |
| --- | --- |
| `GRIP_SANDBOX_LIMA` | `sandbox.limaBinary` |
| `GRIP_SANDBOX_LIMA_TEMPLATE` | `sandbox.limaTemplate` |
| `GRIP_SANDBOX_LIMA_INSTANCE_PREFIX` | `sandbox.limaInstanceNamePrefix` |
| `GRIP_SANDBOX_WORKSPACE_MOUNT` | `sandbox.workspaceMountPath` |
| `GRIP_SANDBOX_DAEMON_PORT` | `sandbox.daemonPort` |
| `GRIP_SANDBOX_DAEMON_HOST_BIND` | `sandbox.daemonHostBind` |
| `GRIP_SANDBOX_CLEANUP` | `sandbox.cleanup` (`stop` or `remove`) |
| `GRIP_SANDBOX_GUEST_BINARY` | Explicit local Linux ELF guest executable for development |

The default Lima template name contains `docker-rootful`; it is a Lima VM template choice, not a Docker-container sandbox runtime. Change `sandbox.limaTemplate` or use `--template` to select a different Lima template.

### Guest Grip during development

A new managed VM installs an exact-version Linux Grip release using the checksummed repository installer, when those release assets are published. An existing named per-session VM without Grip installs the latest published release using the same installer; an existing installation is left alone. In development, `GRIP_SANDBOX_GUEST_BINARY` installs the local Linux build instead, including in existing VMs. To test local code, cross-compile a Linux binary matching the guest architecture and opt in:

```bash
NODE_OPTIONS=--import=tsx ./scripts/build-binaries.sh --skip-install --platform linux-x64
GRIP_SANDBOX_GUEST_BINARY="$PWD/packages/coding-agent/binaries/grip-linux-x64" ./grip-test.sh
# In Grip: /sandbox start --name my-dev --update
```

For ARM64 use `--platform linux-arm64` and `grip-linux-arm64`. The ELF is validated, copied via `limactl copy` only when safe, checked against its SHA-256 and version, and installed at `~/.local/bin/grip`. An identical installation is reused. Normal attachment never replaces the running shared guest's binary. Explicit `--update` uses `GRIP_SANDBOX_GUEST_BINARY` when set; a source/tsx development session requires it rather than silently installing a release. Otherwise the update downloads the checksummed Linux release matching the Grip version that issued the command. The shared systemd unit must already run `~/.local/bin/grip`; other service binary paths require manual reconciliation. Downloads and validation complete before client disconnection. An uncertain install or restart leaves the VM for inspection. The guest needs `sha256sum` and `/proc`.

## Direct shared Lima attachment

In each host workspace run `/sandbox start --name <running-shared-VM>`. The VM must already have a fixed writable parent mount, matching loopback forward, exact-version guest Grip, and a verified `~/.cache/grip/shared-lima` guest-state directory. Its systemd user manager must be running with linger enabled so Grip can start or reuse a supervised shared daemon. This command does not provision a new shared VM or convert a legacy one: a running VM without the shared marker takes the per-session path.

Each TUI obtains the guest credential through local Lima access and opens its own authenticated v2 WebSocket workspace channel. Parent-root clients can access their children; shared file writes and edits use revision preconditions, but shell writes can still race. Transfers are unavailable in shared mode. `/sandbox stop` and `/sandbox clear` detach only the current TUI; neither stops the shared daemon or VM. Coordinate all clients and independently verify ownership before any manual guest or VM shutdown.

Grip probes guest mode under the named owner lock before any legacy setup. A missing marker follows the per-session path; unreadable, symlinked, or ambiguous state refuses attachment. A stopped shared VM with a mismatched mount is not automatically resumed. Per-session start and stop check for shared guest state before rotating or killing a legacy daemon. Noncooperating programs may ignore these locks; a VM name alone proves nothing.

Shared startup requires guest `systemd-run --user`, `systemctl --user`, and `loginctl ... Linger=yes` already enabled by an operator. Grip launches one transient `grip-shared-lima-PORT.service` with `Restart=no`; it does not automatically restart failed units or retry uncertain operations. The unit reads its private 0600 token file without passing credentials in service arguments. Grip verifies its MainPID against a boot-ID/process-start-time-bound PID record before reuse. Missing manager, mismatched process identity, or uncertain guest state require manual reconciliation; guest shutdown remains explicit.

## Lifecycle and security

Automatically named, process-owned VMs follow `sandbox.cleanup` on graceful Grip shutdown, subject to stopped-VM uncertainty. Tracked per-session named Lima daemons stop without stopping their VMs. A failed readiness check leaves uncertain guest state for manual reconciliation. Shared guest daemons and VMs remain running. Session switches reconnect remembered channels while the process remains running.

Lima VMs are not complete security sandboxes. The workspace is mounted read/write and guest processes can modify it as the guest user. Child jobs inherit the active workspace backend and load project instructions through it; parent extensions are not loaded in children by default. The daemon token grants privileged workspace tool access. Reused VMs retain their own software, credentials, filesystem, and network access; use only trusted instances and Lima templates. Keep `sandbox.daemonHostBind` loopback-only unless you provide a separate trusted network/TLS boundary, and do not store secrets in the mounted workspace unless the guest should read them.

## Troubleshooting

- Lima missing: install Lima or configure `GRIP_SANDBOX_LIMA` / `sandbox.limaBinary`. New managed VMs require the published exact-version guest installer; reused VMs must provide a matching binary.
- Port conflict: a newly created VM selects an available port; a running shared VM requires its configured forward to match exactly.
- Activation failure: inspect VM and daemon state before retrying; do not stop an unverified VM or other shared clients.
- Empty `/sandbox list`: only instances whose workspace mount contains the current host workspace appear. Check the VM's configured mount and directory access.
- `/sandbox stop` not found: use the listed id or name, or switch to the owning workspace. Stopped or uncertain VMs require manual reconciliation before removal.
