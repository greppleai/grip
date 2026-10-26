# Official extensions

Official extensions are a curated list of separately installed packages, not a
marketplace or bundled Grip features. Nothing is installed just because you
start or upgrade Grip. There is no planner enable flag.

This guide requires a Grip version with `/extensions` and Git `#path=` support;
the planner's SDK peer minimum alone does not establish those CLI capabilities.

## Browse and install

1. In interactive mode, enter `/extensions`. Browse with the picker keys; Escape
   or Back leaves without changing settings. Browsing uses local reviewed metadata,
   not a registry query or moving `latest` lookup.
2. Select Planner, then Install. Explicitly choose **User** or **Project (extension
   host)**. User settings are normally `~/.grip/agent/settings.json`; project
   settings are `.grip/settings.json` under the host cwd shown in the dialog.
3. Review the repository, exact source, scope, settings path and security warning.
   Confirmation defaults to Cancel. A missing install path may display as
   unresolved until the package manager creates its checkout.
4. Confirm to invoke Grip's existing package manager. Once started, the package
   operation cannot be cancelled or rolled back by dismissing the picker. On
   failure, inspect the refreshed state: files or settings may already have changed.
5. Choose Reload now or Later. Successful installation changes settings and disk,
   not the current runtime. Reload uses Grip's existing full resource lifecycle;
   it is not a planner-only hot swap. A reload failure does not undo installation.

The initial planner target is:

```text
git:github.com/greppleai/grip@961291825e61a44b9075ef3bf9a53f54a903998d#path=extensions/planner
```

Only that selected package is materialized in its managed sparse checkout. It
contains `/planner`, six `planner_*` tools and the host-local planner skill.
Its runtime dependency is separate from Grip's bundled SDK peers. This route
requires Git and a supported npm/Bun/pnpm command on the extension host, but no
planner npm publication. See [package sources](packages.md#git) for generic
selector syntax and self-contained package requirements.

## Trust and version selection

“Official” means curated source metadata, not sandboxing or a security guarantee.
Extensions execute with full host access; skills can direct tool execution.
Review both before loading. Planner's selected Git installation omits development
dependencies, does not auto-install peers and skips dependency lifecycle scripts.
Existing npm and repository-root Git package workflows retain their own script
behavior; the catalog warns before invoking such an action.

Catalog metadata names an exact npm version or full immutable Git commit, never
a moving branch or npm `latest`. New catalog targets must first be reviewed and
available at that source. Updating the catalog does not automatically install or
upgrade the listed extension. Git delivery here is independent of npm publication;
a future npm target needs its own reviewed, published exact version.

## Existing installations, upgrade and removal

The catalog recognizes known npm/Git planner identities and local planner package
metadata, as well as loaded owners of planner commands/tools. It does not treat
the Grip repository root or sibling subdirectories as planner. Filters, local
paths and saved plans are not silently rewritten. Duplicate or ambiguous owners
block mutation rather than choosing a winner.

Upgrade and Remove operate only in the existing installation's scope and require
confirmation. Upgrade selects the catalog's reviewed target, not the newest
registry version. Switching npm/Git kind, repository or selected package is not
an upgrade; manage that change explicitly outside the catalog. Local source code
is unmanaged: update its checkout yourself; removing its configuration does not
delete its files.

Loaded owners block catalog upgrade/removal because being idle cannot prove a
planner loop or callback is inactive. Stop the workflow, exit Grip and manage the
package with the existing package CLI; alternatively restart with
`grip --no-extensions` to perform catalog actions without loading extension owners.
Unknown/duplicate owners must be resolved explicitly. A session switch, queued
activity or external settings change invalidates an open confirmation.

Removal deletes managed package files where appropriate, never saved `.planner`
plans. Existing flat, numeric and mixed layouts remain supported without forced
migration. Review and resume a saved plan only after its intended owner is loaded.
See the [planner guide](../../../extensions/planner/README.md) for its workflow.

## Host and remote backend boundaries

Installation scope, settings, package resources and skills belong to the extension
host, even when tools operate in a Lima/remote workspace. The confirmation shows
that host cwd; a remote workspace path does not select a different project install.
Planner reads and mutates plan files through the active tool backend. A local-path
installation therefore needs the checkout and dependencies on the host, not just
inside a guest filesystem.

The picker is interactive-only. Existing package CLI commands and explicit SDK
resource loading remain available to non-interactive consumers. Configured
packages can still be restored automatically when missing at startup, including
packages explicitly configured by a project; that is the existing package
workflow, not a catalog default. An npm-managed or standalone Grip installation
must resolve the optional package externally: neither distribution should embed
planner runtime or skills. Source/fixture checks are not proof that a newly built
npm package or binary has been smoke-tested.