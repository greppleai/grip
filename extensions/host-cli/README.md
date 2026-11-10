# Host CLI

Official extension source for narrowly scoped host commands while workspace tools run in a mapped sandbox. Registers one tool per configured CLI (for example, `kubectl`), not a general-purpose host shell. Its tools are active only while a sandbox is connected: availability is reconciled at session start, before each prompt and before each agent turn. Detached/local sessions have these tools removed from the active tool list; attaching a sandbox enables them at the next reconciliation. Other active tools are preserved. Execution also checks the sandbox connection before mapping and immediately before spawning the host command. Nothing is allowed by default.

## Setup

Before publication, load the local source with `grip -e /absolute/path/to/extensions/host-cli/index.ts`. After a compatible release is published to the official catalog, install with `grip install official:host-cli`. This source change does not publish it.

The canonical policy is [`config/pi/host-cli.yaml`](../../host-cli.yaml). The Ansible agent role links it to `~/.grip/agent/host-cli.yaml`; custom agent homes must link it themselves (`GRIP_CODING_AGENT_DIR` is honored). On Unix, the opened target must be owned by the Grip user and not writable by group/others (`chmod 600` is recommended). Host-managed symlinks are supported; the link, target and parent directories must be trusted and outside all sandbox-writable mounts. Do not mount this configuration checkout writable inside a sandbox using these tools. Only the configured agent-home policy is read; workspace policies are not discovered or merged. Review policy changes before syncing or pulling them: they authorize unattended host execution on every linked machine.

The repository's kubectl policy allows `get` and `describe` for explicitly listed resource types (including Pods, workloads, Services, Nodes, Events, ConfigMaps, storage, networking and RBAC resources), plus `top pods/nodes`, `api-resources`, `api-versions` and the client version. Examples:

```sh
kubectl get pods -A
kubectl get deployments -n staging -o yaml
kubectl describe services --namespace production
kubectl top pods -n staging --no-headers
```

Use full plural resource names. Options may appear in any order after the command/resource prefix, with separate values (for example, `get pods -o yaml -n staging`). `get` output formats are limited to `wide`, `json`, `yaml` and `name`. Arbitrary object names, resource/name shorthand, comma-separated resources, `all`, custom resources, logs, exec, proxy, file/raw requests, context/kubeconfig overrides and write commands are not authorized. Secrets are excluded, including singular, qualified and mixed-resource spellings. This is a command/resource allowlist, **not a guarantee that output contains no credentials**: Pod specifications, Events and ConfigMaps can expose sensitive plaintext, and service accounts/RBAC reveal security metadata. Enforce read-only access and deny Secret access with Kubernetes RBAC as the authoritative boundary.

The repository's `gh` policy permits explicit built-in read operations: repository list/view; issue and PR list/view (including comments); PR diffs/checks; release list/view; workflow list/view; run list/view summaries; label lists; and repository/issue/PR/commit searches. **PR creation is the sole write exception**. Nonempty repository, head, base, title and body options are required; `--head` skips implicit pushes/forks. The only additional creation options are `--draft` and `--no-maintainer-edit`. Other creates, edits, merges, reviews, comments and deletes remain denied. It is a conservative allowlist, not unrestricted access to every GitHub endpoint. No generic `gh api`/GraphQL, auth/secret/variable commands, aliases/extensions, Actions logs, code search, downloads/clones/checkouts, browser launches or formatting expressions are allowed.

```sh
gh repo list --limit 100 -- owner
gh repo view -- owner/repo
gh pr list --repo owner/repo --state all --limit 100
gh issue view --repo owner/repo --comments -- 123
gh pr diff --repo owner/repo -- 123
gh run view --repo owner/repo -- 123456
gh search issues --limit 100 -- 'repo:owner/repo state:open bug'
gh pr create --repo owner/repo --head feature --base main --title 'Fix behavior' --body 'Details' --draft
```

Options may appear in any order after the command prefix, but query identifiers and search strings must follow the literal `--` terminator. PR creation has no positionals. List limits are restricted to 30, 100, 200 or 1000. This policy does not guarantee zero incidental local cache/config activity by the CLI. Free-text descriptions, comments, README files, release notes and diffs may contain pasted credentials; denying Secret/credential commands cannot redact these. Use a least-privilege GitHub token: read-only for queries, with pull-request write permission only when creation is needed, and trusted host CLI configuration. Adding the new `gh` tool requires `/reload`; policy edits to an already registered tool are read on its next call.

Example policy: `name` is both the tool name and the CLI command, resolved through the host Grip process's `PATH`. No executable path is configured:

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

Array rules match a **complete argv template**. A string is an exact literal; a nested list is a finite set of choices for exactly one argument. `{text: true}` accepts one arbitrary literal text argument (including multiline/empty strings, at most 65536 characters, without NUL). It never splits that text into additional arguments. Length and order must match. Quote YAML booleans/numbers when intended as CLI strings. An empty template `[]` explicitly permits no arguments. `commands: []` disables everything.

For independent boolean flags, use a mapping with `args` and `flags` instead of enumerating combinations:

```yaml
version: 1
commands:
  - name: git
    allow:
      - args: [status, --short]
        flags: [--branch]
      - args: [diff]
        flags: [--cached, --check]
```

`args` is the required, ordered prefix and supports the same literal, choice and text slots as an array template. The optional `flags` list permits standalone flags after the prefix, in any order, including duplicates. Missing `flags`, `options` and `positionals` default to empty lists. Invocations are limited to 64 arguments.

### Structured options and reusable choices

Use `options` instead of enumerating combinations of optional arguments:

```yaml
allow:
  - args: [get, &resources [pods, services]]
    options:
      - &namespace_option {names: [-n, --namespace], value: {text: true}}
      - {names: [-o, --output], value: [json, yaml, wide]}
      - {names: [-A, --all-namespaces]}
  - args: [describe, *resources]
    options:
      - *namespace_option
  - args: [pr, create]
    options:
      - {names: [--repo], value: {text: true}, required: true}
      - {names: [--head], value: {text: true}, required: true}
      - {names: [--base], value: {text: true}, required: true}
      - {names: [--title], value: {text: true}, required: true}
      - {names: [--body], value: {text: true}, required: true}
      - {names: [--draft]}
```

Each option declares explicit `names` (including any short aliases), an optional `value` slot, and an optional boolean `required` (default false). Omitting `value` makes it a boolean option. Valued options consume exactly one **nonempty** argv element, even if it begins with a hyphen; it is never reinterpreted as another option. They support literal, finite-choice and `{text: true}` values. Options may appear in any order after `args`, at most once per option, including across aliases. Missing required options, duplicates, unknown flags, combined short flags and inline `--flag=value` forms are rejected. Required values must be explicit: no defaults or implicit option normalization.

`positionals: [{text: true}]` requires exactly one argument after an explicit `--` terminator. All options must come before it; nothing after it is parsed as an option. Omitting `positionals` permits no trailing positional arguments or extra terminator.

YAML anchors/aliases reuse choices, options or option lists without duplicating them. The YAML parser uses `maxAliasCount: 100` to bound alias expansion; recursive/invalid policy shapes and unknown keys are rejected. No YAML merge keys or arbitrary root-level definition maps are enabled. The shipped policy defines its Kubernetes resource allowlist once and reuses shared GitHub options. Exact array templates remain supported for commands requiring a fixed order; this existing version-1 policy syntax is not removed.

When every flag is trusted, explicitly opt into a wildcard:

```yaml
allow:
  - args: [diff]
    flags: ["--*"] # Any long flag, including --flag=value
  - args: [status]
    flags: ["*"] # Any short or long flag, including combined short flags
```

Quote wildcards in YAML. These are the only wildcard forms; arbitrary patterns such as `--safe-*` are rejected. Wildcards can be mixed with literal entries, e.g. `["--*", -v]`, but **cannot be combined with structured options or positionals**. A wildcard matches one argument starting with one or two hyphens followed by an ASCII letter/digit, at most 4096 characters and without control characters. It does not permit bare `-`/`--`, positional arguments or separate flag values. Inline values such as `--format=json` are accepted by wildcard flags only. Every matching flag, including future CLI flags and flags that change configuration or execute programs, is authorized: use wildcards only when that entire capability is intended. Exact array templates remain literal, including any `*` strings.

There are no general globs, regexes, environment substitutions, shell parsing, implicit aliases or flag normalization. Flags are accepted only after the complete prefix. Review the CLI semantics before granting every combination: this matcher cannot verify that an allowed flag is actually boolean or harmless.

With the kubectl example above, `delete`, `exec`, plugins, `--raw`, `--kubeconfig`, `--server`, `--context`, `-f`, extra/duplicate flags, `--namespace=staging`, shell pipelines and unknown resource names are denied before execution. These are denied because they do not match, not because the extension maintains a Kubernetes-specific denylist.

**The host-owned YAML policy is the authorization. Matching commands run on the host without per-call approval**, including in print/JSON/RPC modes without an approval UI. Installing this extension and granting argv templates therefore grants unattended host execution for those exact combinations. Unmatched commands, local sessions and sandboxes without a verified host mount mapping fail closed. The reviewed extension deliberately uses Node's host-side `execFile` with `shell: false`; it does not call or change Grip's separately approved host APIs. This is an agent tool proxy; it does not install a `kubectl` executable inside the guest or provide a guest-accessible network endpoint.

Policy is re-read before each call, so removal, malformed YAML or missing commands revoke future calls without reload. Adding tools requires reload; descriptions update on reload. An invocation uses the policy snapshot validated before mapping/execution; editing policy does not cancel an already running operation. Execution defaults to 30 seconds, configurable from 1–120000 milliseconds; cancellation is forwarded. Output (stdout and stderr) is returned to the agent, ANSI escapes removed, capped at 2000 lines / 50 KiB; omitted output is not saved. Nonzero/unknown exit codes and killed processes are tool errors. Capture is separately bounded at 1 MiB per stream; exceeding it kills the direct child and reports an error. Timeout and cancellation also kill the direct child; this is not a process-tree sandbox for CLI-launched credential helpers or other descendants.

## Git commit and non-force push

After disabling any other extension providing a `git` tool, add this command to your host policy (merge into the existing `commands` array if retaining kubectl):

```yaml
version: 1
commands:
  - name: git
    timeoutMs: 120000
    allow:
      - [commit, -m, {text: true}]
      - [push, origin, HEAD:refs/heads/main]
```

Replace `origin` and `main` with your intended remote and destination branch. The commit message can be any text; `{text: true}` consumes exactly one argv value after `-m`, so message content is not treated as shell syntax or extra Git flags. Keep push slots literal: a text slot in an option or refspec position could grant force flags or leading-`+` refspecs. The explicit push refspec avoids inheriting `remote.origin.push` refspecs, which could contain a leading `+`. Bare `push`, other subcommands, global `-c`/`-C` options, additional flags (including `-f`, `--force`, and `--force-with-lease`) and leading-`+` refspecs do not match and are denied. Reload after adding the Git tool.

This is an argv restriction, not a sandbox for Git itself: commits and pushes can execute hooks, credential helpers and configured programs on the host. Trust the repository, remote and Git configuration; use server-side protected branches to enforce no history rewriting independently.

## Security scope

- The operator is responsible for the semantics of **every** allowed argv combination. This generic matcher does not certify commands as read-only. Do not allow shells, interpreters, arbitrary plugins, file/template flags or credential overrides unless that capability is intentional. Every choice combination in a template is granted.
- Use Kubernetes RBAC with dedicated read-only credentials as the authoritative cluster boundary. Prefer explicitly named resource types and namespaces; avoid granting `secrets` or all-resource wildcards. Reads can expose sensitive data. Do not grant unrestricted logs, config or raw API endpoints without review. Output is not secret-redacted and can contain prompt injection.
- The host executable, its directories, environment and configuration must be trusted. Command lookup uses the host Grip process's `PATH`, never the guest's `PATH`. That host `PATH` must contain only trusted absolute directories: exclude empty entries, `.` and guest-writable directories. Shell aliases/functions are not supported, and a missing executable is a tool error with no guest or shell fallback. Kubectl can execute credential plugins from its kubeconfig even for reads. Do not point `KUBECONFIG` or related host configuration at guest-writable files. The process inherits host environment and runs in the translated workspace cwd; do not proxy programs that load executable project configuration there.
- This adds a restricted route, not a process-wide sandbox. Extensions execute with full host permissions. Other host APIs/tools still retain their own approval requirements; this extension does not weaken them. Other tools/extensions with host access remain separate capabilities; disable those if your threat model requires it. Keep global settings, policy, installed extension code and credentials outside all guest-writable mounts. Jobs do not inherit this extension's tools automatically.

See [sandbox security](../../packages/coding-agent/docs/sandbox.md), [host argv API](../../packages/coding-agent/docs/extensions.md#ctxexechostprocess-direct-host-argv) and [official extension authoring/publication](../README.md). No publication or real cluster access is needed for tests.
