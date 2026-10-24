# Optional extensions

Extension packages in this directory are tracked with Grip's source but are
not part of the CLI distribution. They are deliberately outside the root npm
workspaces and the package, release, and binary-asset build inputs. Building,
installing, or starting Grip does not install or load them automatically.

- [Planner](planner/README.md): local Markdown plans and iterative build loops.

Use Grip's existing package workflow to opt in to an individual package and
choose its installation scope. A local path requires a source checkout on the
host; the CLI does not ship a copy. Remote/catalog delivery requires its own
reviewed exact target and is not implied by source being present here.