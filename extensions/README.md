# Optional extensions

Extension packages in this directory are tracked with Grip's source but are
not part of the CLI distribution. They are deliberately outside the root npm
workspaces and the package, release, and binary-asset build inputs. Building,
installing, or starting Grip does not install or load them automatically.

- [Planner](planner/README.md): local Markdown plans and iterative build loops.

Use `/extensions` in an interactive Grip version with catalog support to review
an exact source and explicitly choose an installation scope. Planner's catalog
target selects only `extensions/planner` from an immutable Git commit; no npm
publication or monorepo-root installation is required. See the
[official extension guide](../packages/coding-agent/docs/official-extensions.md).

Local paths remain supported, but require a source checkout on the extension
host; the CLI does not ship a copy. Existing configured packages can still be
loaded or restored at startup through the normal package workflow.