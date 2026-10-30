# Official extensions

Official extensions are independently versioned, published releases curated from the [`extensions/` source directory](../../../extensions/README.md). Their package identity is `official:<id>`, not an npm package or Git repository. Grip selects a published stable release compatible with your Grip version; it never installs unpublished code from `main`.

Planner is selected as an official extension source. Pushes to main can publish it automatically after tests; local packaging never publishes. `official:planner` appears once publication updates the production catalog. The manager also supports an empty catalog; examples elsewhere in the repository are not automatically official or installed.

> **Trust:** Official extensions run as your user with full access to files, commands, network and credentials. They are not sandboxed. Review code and install only extensions you trust. Catalog checksums verify artifact integrity relative to the trusted official repository; they do not independently authenticate the publisher or limit extension behavior.

## Browse and install

In interactive mode, enter `/extensions`:

1. Choose **Install extension** to open the searchable official catalog.
2. Select an entry to see its description, supported Grip range and compatible stable version. Entries without a compatible release explain why installation is unavailable.
3. Choose **Install**, read the full-access warning and confirm.
4. Wait for the operation to settle, then leave the manager to apply saved changes safely.

Use the configured selection keys shown in the footer; type to search. Installed and catalog searches/selections are retained when returning from details. **Refresh catalog** retries discovery; cached, stale, offline and unavailable states are distinguished. Browsing does not execute catalog code or install unselected entries.

The initial installed/configured view includes official packages, third-party packages and manual extensions. Details show the source, scope, known version, entry points and loaded/disabled/missing/failed status. An unreported version remains unknown. **Refresh installed** refreshes inventory; when inventory is unavailable, management actions are blocked rather than guessing ownership.

The built-in command remains available with no extensions, factory failures or `--no-extensions`. That flag disables official factories and automatic official updates, not management; installing does not override it.

### CLI

Replace `example` below with an ID from the published catalog; it is a placeholder:

```sh
grip install official:example
grip list
grip update official:example
grip remove official:example
# Equivalent removal command:
grip uninstall official:example
```

Official installations are **global-only**, under `<agentDir>/official/` (normally `~/.grip/agent/official/`). `GRIP_CODING_AGENT_DIR` selects a different agent directory. `-l`/`--local` and project `.grip/settings.json` official selections are unsupported. Do not put an official identity in the `extensions` path list or append a version/ref to its ID.

Successful installation selects `official:<id>` in the active profile's `packages`, or top-level global `packages` when using the default profile. Installed files are shared across profiles; selecting an already installed, verified compatible extension in another profile does not download it again, including offline. Merely adding an ID to settings does not download a missing official installation; use the install command or manager. Installation downloads a bounded, checksum-verified artifact with its runtime dependencies and declared assets already bundled. The official installation path does not invoke Git, npm or package lifecycle scripts on your machine.

## Uninstall and ownership

Select an installed entry, choose **Uninstall** and confirm, or use the CLI command above. The action is offered only when inventory establishes a scoped managed-package removal target. For a third-party package, it delegates to existing package removal; it can remove the package's other resources too. Manual/local extension source files never acquire deletion authority from appearing in the list. Disable or remove those files at their source; see [package resource configuration](packages.md#enable-and-disable-resources).

Official uninstall removes the selection from the active profile (or default settings). The shared active-installation record remains while any profile or default settings still selects the extension. It does **not** delete manually maintained extensions, unrelated settings or user configuration/data outside the managed installation. Keep user data outside installation trees. Immutable code versions are retained, including after uninstall, so other running Grip processes can continue using files they already loaded. Uninstall is not a disk purge and does not revoke already executing code. A later restart does not reinstall the removed selection.

## Applying changes to a running session

Install/uninstall first saves package state; it does not replace live extension code while the manager is open. The manager shows **Reload/restart pending** until changes are applied. On close, Grip waits for the session, tools and tracked interactive commands to settle, then uses the normal resource reload lifecycle. New commands wait for reconciliation rather than running against an obsolete extension host.

A busy session reports that reload is pending until idle. A failed reload reports that changes are saved but reload/restart is required; it is not reported as a successful activation. Retry `/reload` when idle or restart Grip. `--no-extensions` remains authoritative after reload. CLI mutations affect persisted state; already running processes retain their loaded code until their own reload/restart.

During an official operation, the configured cancel key requests cancellation. Closing waits for mutation settlement and refreshes inventory. Cancellation can arrive after a commit: it is not a rollback guarantee. Inspect the resulting inventory before retrying.

## Automatic updates

At process startup, before initial extension imports/factories, Grip checks only selected, installed official extensions. It installs only strictly newer compatible stable releases, independently per extension. It does not downgrade, install prereleases, download unselected entries or update manual/npm/Git extensions automatically. Existing third-party update notifications and explicit package update commands are unchanged.

The phase is shared by the default loader across interactive, print, JSON, RPC and SDK startup. It runs once per canonical agent directory per process, not on every resource reload, session replacement or subagent creation. It performs no background code replacement during a session. Explicit install/update remains available when automatic updates are disabled.

Add this to **global** `<agentDir>/settings.json` to opt out:

```json
{
  "officialExtensions": {
    "autoUpdate": false
  }
}
```

`officialExtensions` is global-only; project overrides do not control it. Available settings:

| Setting | Default | Accepted values |
| --- | --- | --- |
| `autoUpdate` | `true` | Boolean |
| `catalogMaxAgeMs` | `21600000` (6 hours) | Integer 1–86400000 |
| `requestTimeoutMs` | `3000` | Integer 1–30000 |
| `startupBudgetMs` | `8000` | Integer 1–60000 |

Requests and the whole startup phase are bounded. Catalog freshness avoids unnecessary requests; a failed catalog attempt has a persisted 60-second retry backoff. One extension's failure does not prevent independent updates unless the shared deadline/cancellation ends the batch.

`GRIP_SKIP_VERSION_CHECK=1` disables the core version check, **not** official extension updates. Use the official policy above, `--offline` or `GRIP_OFFLINE=1` instead. See [settings](settings.md#official-extensions).

## Offline use and recovery

Start with `grip --offline` or `GRIP_OFFLINE=1` to skip startup networking. Already installed, verified compatible versions still load. The manager can show a cached catalog, including its age/error; without a cache, discovery is unavailable. Refresh cannot bypass offline mode. An install/update needing a download fails offline; uninstall remains available.

On network, rate-limit, checksum, compatibility or disk failure, startup retains the last verified compatible installation and reports a nonfatal diagnostic. A corrupt tree or an installation incompatible with the current Grip version is not executed as a fallback. Other usable extensions can still load.

- **Missing/not loaded:** inspect the row's source/scope and errors. Install explicitly if selected code is absent; adding a settings entry alone is insufficient.
- **No compatible release:** use a supported Grip version or wait for a compatible extension release. Do not edit the installed manifest to bypass compatibility checks.
- **Download/integrity failure:** check connectivity and retry `grip install official:example` or `grip update official:example` as indicated by the diagnostic. Persistent local integrity failures require investigation; do not overwrite verified receipts or mutate retained trees to force loading.
- **Busy installation:** allow the other process to settle, then retry. Do not delete locks while an operation may be running.
- **Interrupted operation:** retry management or restart. Under per-extension and settings locks, Grip reconciles the persisted transaction with desired membership before selecting active code. Staging/partial or unverified files are never a load fallback.
- **Reload failed:** the package commit may have succeeded. Inspect inventory, then retry `/reload` when idle or restart; do not infer rollback from an error/cancel message.

For diagnostics, use `grip list` and the manager's source/version/error details. Preserve settings, state and retained files when reporting a persistent failure. There is no automatic garbage-collection or user-facing purge command for retained official versions.

## SDK and custom loader integration

The default `GripAgent` resource loader awaits its pre-import official update phase. A custom `ResourceLoader` owns its own preparation/loading lifecycle; merely implementing the inventory method does not schedule updates.

For hosts implementing package/resource contracts:

- Await `PackageManager.getInstalledPath()` and `listConfiguredPackages()`; both return Promises. Configured rows include nullable `version` and `error` values, including failed/missing selections.
- Implement the required `PackageManager.getOfficialCatalog()` and `startupOfficialUpdates(noExtensions)` methods. Catalog browsing returns presentation metadata/cache diagnostics, not executable extension instances.
- Use `installAndPersist()` / `removeAndPersist()` for official mutations. The generic synchronous settings-membership helpers reject official sources; do not split their installation and membership commit.
- `PackageMutationOptions.official` contains official-only cancellation, offline, refresh and timeout controls. It does not promise cancellation of existing npm/Git subprocesses, and `offline: false` cannot override environment offline mode.
- Include `diagnostics` in `ResolvedPaths` and implement `ResourceLoader.getExtensionInventory()`. Consume its scoped `removal` target rather than deriving deletion rights from a path or catalog ID. Provenance includes official identity/version and load-error source information.
- A runtime host's before-session-invalidate callback may return a Promise. Replacement/disposal awaits it so in-flight management settles before the old session is disposed.

See [SDK usage](sdk.md), [extension API](extensions.md) and the [authoring and independent publication guide](../../../extensions/README.md). Merging to main authorizes automatic publication after tests; source, license and compatibility approval must precede the merge. Executable smoke testing remains a maintainer responsibility. Installation and local validation do not publish.