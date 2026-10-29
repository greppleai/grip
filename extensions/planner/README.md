# Planner

A local Markdown plan extension for Grip. Plans live in the active file
backend's working directory, including Lima/remote workspaces; no server or
planning-service credentials are required.

## Install and commands

Planner is selected as an official extension source, but source presence does **not** publish it. Once `official:planner` is published and visible in the catalog, use `/extensions` or:

```sh
grip install official:planner
grip list
grip update official:planner
grip remove official:planner
```

The independently versioned initial package is `1.0.0`; its declared Grip range is `>=0.2.1 <0.3.0` (minimum 0.2.1). The range is validated against this checkout, not every released executable; release approval and executable smoke tests remain required. Official extensions run with full user access: review and trust the code before installation.

Official installations are global and include their runtime dependencies. At startup Grip updates selected installations to newer compatible stable releases unless updates are disabled or offline; verified installed versions can be reused offline. Removing the official package removes selection and activation but retains immutable code versions and does not remove plans. Running sessions need to reload or restart after CLI changes; `/extensions` applies changes after work settles. See Grip's official extensions guide for policy and recovery.

### Switching from the Git package

After the official release is published and visible in `/extensions`:

1. Stop Planner (`/planner stop`, pressing Escape first if busy) and wait for outstanding work, callbacks and writes to settle in every affected session. Back up the complete `.planner/` directories on each active backend, including `LOOP-STATE.json` and authored files. Back up any changes in the managed Git checkout too: package removal deletes that checkout.
2. Use `grip list` and inspect global and project configuration, explicit `-e`/`--extension` flags and other local copies. Remove the old managed selection at its actual scope, for example `grip remove git:github.com/greppleai/planner` (add `-l` for a project selection). Removal can affect the package's other resources. Disable any other Planner factory sources rather than loading both.
3. Reload or restart affected sessions and verify the Git factory is no longer loaded. Install `official:planner` only after publication, then reload/restart or use `/extensions` and wait for its changes to apply. Verify one Planner factory and its skill are active.
4. Inspect existing plans and explicitly resume when ready. Switching packages does not migrate, delete or rewrite `.planner/` data; do not remove or edit runtime state to force a resume.

```text
/planner prepare my-plan
/planner build my-plan
/planner build my-plan --items-per-iteration 1 --reflect-every 3 --max-iterations 50
/planner resume my-plan --max-iterations 100
/planner stop
/planner status
/planner list
/planner cancel my-plan
```

`prepare` displays an empty INDEX path and scaffold; author it in a subsequent
round. It does not start a turn or build. `build` starts an authored plan;
`resume` increments its saved iteration. `stop` pauses (ESC first if busy);
`cancel` marks the plan Skipped. To reopen a terminal plan, review its context
and runtime state and change only INDEX `status` to Pending before resuming.

## Prepare and author new-format plans

Preparation tools take identity/metadata only, return the exact absolute
**backend** path and placeholder Markdown, refuse overwrites, and never start
a build. Author returned scaffolds with file tools before use. If Grepple is installed
on the **active tool backend**, preparation also reads the newly written file and
appends its native `HASH│LINE│content` rows. Use the returned three-character
hash directly in an anchored edit, without another read. For example, after
`planner_prepare({ "planName": "feature" })` returns the plan INDEX path and
an anchor for its placeholder line:

```sh
# Run on the same backend; substitute the actual returned three-character hash.
printf '%s\n' '# Feature goal' | grepple write --root /workspace edit \
  --path .planner/feature/INDEX.md --start HASH --end HASH
```

`/planner prepare` offers the same optional output. If Grepple is absent, the
read fails, or its output is incomplete, the exact scaffold/path is still
returned with a fallback notice: read the file normally before an anchored edit.
Grepple is optional and not a planner runtime dependency. Anchors refer to the
freshly prepared file and must be refreshed after anyone edits it.

| Tool | Required arguments | Optional arguments |
| --- | --- | --- |
| `planner_prepare` | `planName` | `name` (display name) |
| `planner_step_prepare` | `planName`, `stepName`, `order` | `name` (display name) |
| `planner_progress_prepare` | `planName`, `stepId` | none |
| `planner_handoff_prepare` | `planName`, `fromStep`, `toStep` | `handoffName` (additional filename ID) |
| `planner_start` | `planName` | `itemsPerIteration`, `maxIterations`, `reflectEvery` |
| `planner_done` | none | none |

```text
planner_prepare({ "planName": "feature" })
planner_step_prepare({ "planName": "feature", "stepName": "design", "order": 1, "name": "Design API" })
planner_step_prepare({ "planName": "feature", "stepName": "implement", "order": 2 })
```

`stepName` is display/preparation metadata, **not** the path or ID. The order
determines the numeric-only step directory and ID: order 1 → `STEP-0001` (ID
`0001`), 10000 → `STEP-10000` (ID `10000`). Padding has at least four digits,
no truncation. Orders are unique positive safe integers; at most one step is
In Progress. A step directory's suffix must match INDEX `order`, and execution
selects by numeric order, not lexical filename order.

```text
.planner/feature/
  INDEX.md                    # authored plan instructions
  LOOP-STATE.json             # planner-owned; created after successful startup
  STEP-0001/
    INDEX.md                  # authored step instructions
    PROGRESS-0001.md          # saved decisions/validation
    PROGRESS-0002.md          # later update
    HANDOFF-0001.md           # context to a downstream step
  STEP-0002/INDEX.md
```

Example frontmatter (each file also has a free-form Markdown body):

```yaml
# Plan INDEX.md
---
name: Feature
description: Build the feature
status: Pending
---
# STEP-0001/INDEX.md
---
name: Design API
order: 1
description: Design before implementation
status: Pending
---
# STEP-0001/PROGRESS-0001.md
---
sequence: 1
---
# STEP-0001/HANDOFF-0001.md
---
from_step: "0001"
from_order: 1
to_step: "0002"
to_order: 2
---
```

Quote numeric-only handoff IDs: unquoted `0001` may be parsed as a number.
Pass exact IDs (not `stepName`) to `planner_handoff_prepare`; orders are resolved
from the step files. Outgoing handoffs live in their **source** directory;
additional handoffs need a distinct `handoffName`. Incoming handoffs match
both target ID and order. Root-level legacy handoffs remain readable. Prepare
and author the handoff before switching steps; an empty scaffold is not work.

`planner_progress_prepare({ "planName": "feature", "stepId": "0001" })`
allocates `PROGRESS-0001.md`, `PROGRESS-0002.md`, etc. Sequence is max existing
+ 1, even across gaps. Preparation checks canonical filename/sequence, overflow
and collisions. Author substantive context in the returned file's body; later
corrections are allowed, but keep its `sequence` and filename fixed. Don't
delete the highest PROGRESS if its numbering history must be retained. Local
queues serialize same-process tool requests; no cross-process exclusive-create
guarantee. Flat legacy steps require migration before preparing PROGRESS.

Write the plan INDEX as a short overview: goal, boundaries and expected result.
Before activation, write each step INDEX in plain language: the work to do,
limits and how to check it. Do not use either INDEX as a work log. In each
PROGRESS, record concrete changes with paths, checks and results, blockers and
next actions; in each HANDOFF, record what the destination step needs, what
was deferred, relevant paths and risks. Keep reports specific but concise:
short bullets beat repeated plans, long logs or filler. No word-count rule is
enforced; an untouched placeholder does not count as saved work.

## Execution, immutability and recovery

Author plan INDEX before build and each directory step INDEX before its first
activation. After that, change **only `status`** in those INDEX files. Planner
status writes preserve every other byte (body, metadata, comments, formatting);
it checks frozen instruction hashes at startup, checkpoint and recovery.
External edits are detected upon checking, not blocked by OS permissions.
Statuses are Pending, In Progress, Completed, Skipped. Legacy flat step bodies
remain writable for progress, but even for legacy plans the planner writes
only the plan INDEX status.

`LOOP-STATE.json` holds iteration, options and frozen hashes, not progress.
Old INDEX iteration/options are a read-only fallback until it exists; runtime
writes never alter INDEX instructions. Build/resume/continuation retain an
existing active step or activate the lowest-order Pending step before delivery.
Save authored PROGRESS/HANDOFF context, mark a finished step Completed/Skipped,
call `planner_done` once and end the response. Status-only changes and empty
scaffolds do not count as saved progress, even if all steps are terminal; save
an explanation when skipping. The one-step-per-iteration budget is advisory
when editing files manually. Prompts include bounded excerpts of the plan
INDEX, active step INDEX and latest authored PROGRESS (when available), with
exact paths to read full content. They also reference up to three relevant
incoming handoffs and three recent authored PROGRESS files. Empty prepared
PROGRESS files are not treated as saved work. The work prompt sent at build,
resume or continuation is Markdown in both the agent context and Grip's interactive
transcript; print/JSON/RPC consumers receive its readable text. For example:

```markdown
# Planner · feature: iteration 1/50

**Plan ID:** `"feature"`

**Active step ID:** `"0001"` (order 1)

## Plan · Feature

INDEX: `"/workspace/.planner/feature/INDEX.md"`

Ship the feature safely.

## Active step · Design API

INDEX: `"/workspace/.planner/feature/STEP-0001/INDEX.md"`

Define the API and run its tests.

## Next actions

- Do the work and validate it. Save substantive context in authored numbered PROGRESS files.
- Then call `planner_done` and end this response.
```

Long excerpts are shortened with a path to the complete document. If steps remain open and work
was saved, `planner_done` queues another prompt using the current plan and
step. After checkpoint compaction, that prompt is sent from the callback;
completion, cancellation, pending messages and iteration limits can suppress
it. A compaction error warns and continues without compaction.

At/above 40% context usage, initial build and explicit resume request Grip
compaction **before any startup writes/delivery**. End the response; callback
success reloads and validates before delivery. Startup failure pauses without
mutating files or sending work; explicitly retry after resolving it. Unknown
or below-threshold usage starts normally. Checkpoint compaction failure warns
and continues; busy headless *checkpoints* skip it, but staged startup never
skips required compaction. Stop/cancel/reload, pending messages and stale
callbacks suppress queued work; recovery without delivery is read-only.
Default maximum is at least 50 iterations (or five per step); `0` disables
an explicit iteration limit, step budget or reflection cadence.

Status/activation/runtime writes are not a cross-file transaction: a later
failure may leave earlier statuses changed, or a partial runtime file. Prompt
enqueue has no durable acknowledgement; a crash after persisting state may
require explicit reconciliation before retry. In-process queues cannot cancel
in-flight backend writes or coordinate external writers. The backend exposes
`stat` but no `lstat`/realpath, so readable symlinks are not fully isolated.

## Legacy and manual migration

Flat `STEP-0001-design.md` keeps full ID `0001-design`; `STEP-design.md` keeps
ID `design`. Legacy files/root handoffs coexist with directory steps if
IDs/orders are unique. Flat plans and their writable step bodies work without
migration; no file is renamed automatically.

To migrate **manually**:

1. Stop, wait for pending callbacks/writes, and back up the *entire* plan
   directory, including INDEX, LOOP-STATE if present, steps and handoffs.
   Record old exact IDs, orders, handoff endpoints and Markdown path links.
2. For each chosen flat step, create an unused canonical
   `STEP-<order-padded-to-at-least-4-digits>/INDEX.md` preserving instructions,
   extra metadata, order and status. Separate historical progress from the old
   body into `PROGRESS-0001.md` (`sequence: 1`) when that body is not solely
   instructions. Never lose history or overwrite a destination; decide what
   stays frozen as instructions *before* activating the new directory step.
3. Rewrite **all** affected handoff endpoint IDs from old full IDs to quoted
   numeric IDs, with matching `from_order`/`to_order`, plus Markdown path
   references. Root handoffs may remain at root; optional moves into the new
   source directory require matching source IDs. Only remove/archive old flat
   files outside the plan after verifying copies. Avoid duplicate IDs/orders
   or multiple active statuses during the migration.
4. Run `/planner list`, inspect files/endpoints, then explicitly resume. If
   frozen signatures/runtime state reject it, restore the backup and reconcile
   rather than deleting or editing LOOP-STATE. A formerly active migrated step
   needs fresh authored PROGRESS after resume before checkpoint acceptance.

Reordering a directory step similarly needs stop, full backup, collision-safe
rename (temporary paths for swaps), frontmatter order and *all* handoff
IDs/orders/path references updated together. Frozen signature checks will
reject modifications to already activated instructions: restore/review rather
than bypassing the guard. There is no automatic in-place migration or reorder.

## Development

From the Grip repository root after `npm ci --ignore-scripts`:

```sh
node node_modules/vitest/dist/cli.js --run --config extensions/planner/vitest.config.mjs
npm run extensions:pack -- --out /tmp/grip-official-artifacts
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/official-contracts.test.ts test/official-packaging.test.ts test/official-planner-artifact.test.ts test/official-planner-lifecycle.test.ts
```

Run `npm run check` from the repository root after code changes. Packaging is local validation, not publication. For release readiness and the independent artifact/catalog workflow, see the repository's `extensions/README.md`.
