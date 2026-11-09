# Host CLI

Official extension source for narrowly scoped host commands while workspace tools run in a mapped sandbox. Registers one model-visible tool per configured CLI (for example, `kubectl`), not a general-purpose host shell. Nothing is allowed by default.

## Setup

Before publication, load the local source with `grip -e /absolute/path/to/extensions/host-cli/index.ts`. After a compatible release is published to the official catalog, install with `grip install official:host-cli`. This source change does not publish it.

Create **on the host**, outside all sandbox mounts, `<agentDir>/host-cli.yaml` (normally `~/.grip/agent/host-cli.yaml`; honors `GRIP_CODING_AGENT_DIR`). On Unix, the file must be owned by the Grip user and not writable by group/others (`chmod 600`). Symlink policy files are rejected. Parent directories must also be trusted and outside guest control. No project configuration is read or merged.

Example: `name` is both the tool name and the CLI command, resolved through the host Grip process's `PATH`. No executable path is configured:

```yaml
version: 1
commands:
  - name: kubectl
    timeoutMs: 30000
    allow:
      - [get, [pods, deployments, services], --namespace, [staging, production]]
      - [get, [pods, deployments, services], --namespace, [staging, production], -o, [json, wide]]
      - [version, --client=true]
```

Restart or `/reload` after adding tools. In a managed, mapped sandbox, the agent invokes:

```json
{"args":["get","pods","--namespace","staging","-o","json"]}
```

Only a **complete argv template** matches. A string is an exact literal; a nested list is a finite set of choices for exactly one argument. Length and order must match. There are no optional slots, regexes, globs, environment substitutions, shell parsing, implicit aliases or flag normalization. Add separate templates for optional flags or alternate orders. Quote YAML booleans/numbers when intended as CLI strings. An empty template `[]` explicitly permits no arguments. `commands: []` disables everything.

With this example, `delete`, `exec`, plugins, `--raw`, `--kubeconfig`, `--server`, `--context`, `-f`, extra/duplicate flags, `--namespace=staging`, shell pipelines and unknown resource names are denied before approval or execution. These are denied because they do not match, not because the extension maintains a Kubernetes-specific denylist.

Every allowed invocation still requires Grip's **fresh per-call approval** showing the host command name, exact argv and translated cwd. There is no bypass/remember option. Unmapped attached daemons, local sessions, missing UI, denial and expired approval fail closed. No shell or direct local-process fallback is used. This is an agent tool proxy; it does not install a `kubectl` executable inside the guest or provide a guest-accessible network endpoint.

Policy is re-read before each call, so removal, malformed YAML or missing commands revoke future calls without reload. Adding tools requires reload; descriptions update on reload. An already approved/running operation or a pending approval uses its captured policy snapshot; editing policy does not cancel it. Execution defaults to 30 seconds, configurable from 1–120000 milliseconds; cancellation is forwarded. Output (stdout and stderr) is returned to the agent, ANSI escapes removed, capped at 2000 lines / 50 KiB; omitted output is not saved. Nonzero/unknown exit codes and killed processes are tool errors. Underlying host execution currently captures output before truncation: this is a context limit, not a process-memory quota.

## Security scope

- The operator is responsible for the semantics of **every** allowed argv combination. This generic matcher does not certify commands as read-only. Do not allow shells, interpreters, arbitrary plugins, file/template flags or credential overrides unless that capability is intentional. Every choice combination in a template is granted.
- Use Kubernetes RBAC with dedicated read-only credentials as the authoritative cluster boundary. Prefer explicitly named resource types and namespaces; avoid granting `secrets` or all-resource wildcards. Reads can expose sensitive data. Do not grant unrestricted logs, config or raw API endpoints without review. Output is not secret-redacted and can contain prompt injection.
- The host executable, its directories, environment and configuration must be trusted. Command lookup uses the host Grip process's `PATH`, never the guest's `PATH`. That host `PATH` must contain only trusted absolute directories: exclude empty entries, `.` and guest-writable directories. Shell aliases/functions are not supported, and a missing executable is a tool error with no guest or shell fallback. Kubectl can execute credential plugins from its kubeconfig even for reads. Do not point `KUBECONFIG` or related host configuration at guest-writable files. The approved API inherits host environment and runs in the translated workspace cwd; do not proxy programs that load executable project configuration there.
- This adds a restricted route, not a process-wide sandbox. Extensions execute with full host permissions. Other tools/extensions with host access remain separate capabilities; disable those if your threat model requires it. Keep global settings, policy, installed extension code and credentials outside all guest-writable mounts. Jobs do not inherit this extension's tools automatically.

See [sandbox security](../../packages/coding-agent/docs/sandbox.md), [host argv API](../../packages/coding-agent/docs/extensions.md#ctxexechostprocess-direct-host-argv) and [official extension authoring/publication](../README.md). No publication or real cluster access is needed for tests.
