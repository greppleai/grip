# Third-party Git extensions

`/extensions` → **Install from Git URL** installs an extension package from a URL you supply. This is separate from the [official catalog](official-extensions.md): there is no third-party catalog, marketplace, publisher verification or sandbox.

> **Trust:** Extensions and dependency install scripts run with your full user permissions, including filesystem, command, network and credential access. A Git host, valid manifest or commit hash does not establish trust. Review the repository and its dependencies before approval. A package may also provide skills, rules, prompts and themes.

## Install and review

1. Open `/extensions` and choose **Install from Git URL**, from either the installed list or official-catalog view.
2. Enter an explicit HTTPS or SSH Git URL, optionally followed by `@ref`:
   ```text
   https://example.com/author/extension
   https://example.com/author/extension@v1.0.0
   ssh://git@example.com/author/extension@main
   git:https://example.com/author/extension@<commit>
   ```
   These are placeholders. An optional `git:` prefix is supported only before an explicit HTTPS/SSH URL. Refs can identify a branch, tag or commit. No ref means the default branch at preparation time.
3. Choose **User / active profile** or **Project**. Preparation fetches a disposable checkout, resolves and detaches a full commit, and inspects manifest/resource paths without importing extension code or invoking npm. Git hooks/templates, fsmonitor and submodule recursion are disabled for this flow; entries needed from an unpopulated submodule will fail recognition.
4. Read the **third-party / unverified** review: canonical source, requested ref, full resolved commit, declared entries (canonical targets), destination, captured profile and full-permissions warning. **Cancel** is selected by default. Only **Trust and install this commit** approves dependency installation and subsequent activation.
5. Wait for approved installation and inventory reconciliation. Success closes the manager and requests the normal reload when the session, tools and tracked commands are idle. Persisted installation is not proof of successful activation.

The URL input rejects npm specs, local/file paths, bare host/path and scp-style shorthand, HTTP and `git://` transport, URL queries/fragments and control characters. Embedded HTTPS usernames/tokens and passwords are rejected; an SSH username is allowed. Use configured SSH keys or a Git credential helper instead. Preparation disables Git terminal credential prompts and cannot bypass offline mode. Git is needed for preparation, and npm (or the configured `npmCommand` wrapper) is needed after approval.

Cancel/back before approval discards the preparation. During preparation the configured cancel key requests an abort; cleanup waits for the current bounded Git command to settle, not immediate process-tree termination. Late results are discarded. Once approved, installation is not cancelable: wait for settlement and inspect inventory. Scripts can have effects outside the checkout; an error is not a rollback guarantee.

## Minimal author repository

```text
my-extension/
├── package.json
└── extension.ts
```

Root `package.json`:

```json
{
  "name": "my-grip-extension",
  "version": "1.0.0",
  "type": "module",
  "grip": {
    "extensions": ["extension.ts"]
  }
}
```

`extension.ts`:

```typescript
import type { ExtensionAPI } from "@greppleai/grip";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("My extension loaded", "info");
  });
}
```

A default-exported factory is required; synchronous and asynchronous factories are supported. TypeScript does not require a build step. See the [extension API](extensions.md#writing-an-extension) for commands, tools and events.

### Recognition contract

This interactive Git flow requires all of the following:

- A readable, regular, nonsymlink `package.json` at the repository root, containing a JSON object with an object-valued `grip` and a nonempty array `grip.extensions`.
- Every array item is a concrete repository-relative path ending in lowercase `.ts` or `.js`. Leading `./` is allowed. Each path must resolve to a readable regular file already present at preparation time; directory entries and generated-only files are not accepted.
- No absolute/drive paths, `..` traversal segments, backslashes, control characters, leading `-`, glob characters or filter syntax (`*`, `?`, `[`, `]`, `{`, `}`, `!`, `+`). There is no directory/glob expansion in recognition.
- Symlinks for entries or their parent directories may resolve only inside the checkout. Confined aliases are allowed; duplicates are deduplicated by canonical resolved path, which is shown in review. Manifest/resource confinement is also checked before publication.

`name` and `version` are optional display metadata, not publisher identity or compatibility guarantees. Repository-controlled review text is sanitized for terminal display.

Recognition reads JSON/files; it does **not** import modules, parse/type-check extension source, validate exports or run factories. Syntax errors, missing runtime imports, nonfunction default exports, thrown errors and rejected factories are activation failures **after** approval. The manifest and reviewed entry contents are rechecked before and after dependency installation; approval is not a security audit or attestation of the whole dependency tree.

This stricter contract applies only to **Install from Git URL**. Existing CLI npm/Git/local sources, [convention directories](packages.md#convention-directories), package glob/filter semantics and local extension discovery remain supported elsewhere. A repository accepted by `grip install` through convention discovery alone can therefore be rejected by this interactive flow. Add explicit file declarations rather than treating recognition as a runtime check.

### Dependencies and other resources

Put runtime libraries in `dependencies`, not only `devDependencies`. The approved installer uses the existing Git dependency command: normally `npm install --omit=dev`; with a configured `npmCommand`, plain `install` is used for wrapper compatibility. Lifecycle scripts may run after approval. Do not rely on such scripts to create or change the manifest or reviewed extension entries: those must already exist and match after installation.

Grip-provided packages should not be bundled as separate host copies; follow the [package dependency guidance](packages.md#dependencies). Other declared skills, rules, prompts and themes use existing package resource rules and filters; their presence does not make the package official. Review those resources too.

## Scope, pinning and recovery

- **User:** membership is saved in the active profile's `packages`, or default global `packages` when no profile is active. Files use the shared `<agentDir>/git/<host>/<path>` tree (normally `~/.grip/agent/git/`).
- **Project:** membership is saved in project `.grip/settings.json`; files use `.grip/git/<host>/<path>`. This is project-scoped, not a separate per-profile installation. The review also shows the active user profile captured during preparation; changing profiles invalidates the preparation.
- The saved source is the reviewed repository URL plus `@<full-commit>`, even if the requested ref was a moving branch or no ref was supplied. Approval installs that prepared checkout without refetching the branch. The original branch/tag is review context, not a moving update subscription.
- This flow installs only into an absent target. It will not replace an existing/manual checkout or select a shared tree for another profile. Manage existing installations with the CLI; do not delete files or locks belonging to another operation.
- Git packages do not inherit official automatic updates. `grip update` reconciles a configured pin, not a newer branch tip. To deliberately change the pin, review the new code and use the existing CLI, for example `grip install https://example.com/author/extension@new-ref` (add `-l` for project scope). CLI installation is not the prepare/review flow and may run dependency scripts immediately.
- Before publication, dependency/validation failures leave no new package selection and clean owned staging. After files have been published, a settings failure retains those files and reports **Files installed, but package selection could not be verified**. Inspect `grip list`, inventory and the correct scope/profile settings before retrying; do not assume rollback or force a replacement.
- Reopen `/extensions` to inspect loaded/disabled/missing/failed status and entry errors. For syntax/import/default-factory failures, disable the resource with `grip config` or uninstall the managed package, then `/reload` when idle or restart. Correct the author repository and explicitly install a new ref when ready. Uninstall can remove the package's other resources too; unmanaged/local source files are not deletion targets.
- Disabled resource filters and `--no-extensions` remain authoritative after reload; installing does not enable disabled factories. Already running code is not revoked by uninstall or failure. Keep user data outside managed installation trees.

## Package-manager hosts

Custom `PackageManager` implementations must provide `prepareGitExtension(source, { scope, signal })`, `installPreparedGitExtension(id)` and `discardGitExtension(id)`. Preparation returns display data and an opaque backend-owned identity, not installation authority based on mutable client metadata. Only pass its ID to installation after explicit trust approval. IDs are single-use; discard on denial/back/close, and abort/await/discard late preparation results on cancellation. Approved installation has no cancellation argument: await settlement and refresh inventory even on failure before deciding whether to reload. These APIs do not change official mutation contracts.