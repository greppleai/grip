---
name: planner
description: Use for local Markdown planning and autonomous iterative build loops with /planner.
---

# Planner

Plans live under the active backend's `.planner/<planName>/INDEX.md`. New steps
are numeric-only `STEP-0001/INDEX.md` (ID `0001`); `stepName` is a display name,
not the ID/path. Padding is at least four digits, never truncated above 9999.
Legacy flat `STEP-0001-design.md` retains ID `0001-design` and writable body.
Mixed layouts are valid if IDs/orders are unique. Do not force migration.

## Prepare, then author

Each tool returns the exact backend path and empty Markdown scaffold without
starting work or overwriting anything. Supply identity/metadata only; author
real instructions/context in the next round with ordinary file tools. When
Grepple is installed on the active backend, the response also includes a fresh
read with native `HASH│LINE│content` rows for immediate anchored editing. Use
only the actual three-character hashes returned for this file, not line numbers:

```sh
# Run on the same backend; substitute the actual returned three-character hash.
printf '%s\n' '# Authored plan goal' | grepple write --root /workspace edit \
  --path .planner/feature/INDEX.md --start HASH --end HASH
```

If the backend has no Grepple or its read fails, preparation returns the exact
scaffold plus a fallback notice: read the file normally before editing with
anchors. Do not assume Grepple on the extension host is available remotely;
refresh anchors after any intervening edit. `/planner prepare` displays the
same optional anchors, but does not trigger an agent turn.

- `planner_prepare({planName, name?})`: plan INDEX; `/planner prepare <name>`
  displays it without triggering an agent turn.
- `planner_step_prepare({planName, stepName, order, name?})`: numeric directory
  step INDEX; order unique positive safe integer, `name` overrides display
  name. Author its instructions before first activation.
- `planner_progress_prepare({planName, stepId})`: numbered PROGRESS in a
  directory step. Use exact numeric ID; max existing sequence + 1 (even across
  gaps), canonical filename and `sequence` frontmatter. Author substantive
  progress body; empty placeholders are not saved work. Flat legacy steps
  require explicit migration before this tool can be used.
- `planner_handoff_prepare({planName, fromStep, toStep, handoffName?})`: exact
  endpoint IDs/orders from files, `HANDOFF-<fromStep>.md` inside source step
  directory (plan root for flat source). Distinct handoffName allows another
  file. Author context before switching steps.

## What to write in each file

- Plan INDEX: the overall goal, boundaries and results to deliver. Keep it high level; do not copy step instructions or log work here.
- Step INDEX: in plain language, say what this step will change, what to avoid and how to check it. Be specific without repeating the whole plan. Write this before activation; afterwards change only its status.
- PROGRESS: briefly record what changed (with paths), checks and results, decisions, blockers and the next action. Include enough detail to resume; do not repeat unchanged plans or paste long logs.
- HANDOFF: state what the destination step needs to know, what was done or deferred, where to look and any remaining risk. Do not duplicate the entire PROGRESS history.

Use short headings or bullets when helpful. Prefer concrete facts over filler or jargon. Empty prepared files are not progress; there is no required word count or fixed report template.

Plan INDEX has `name`, `description`, `status`. Step INDEX also has `order`.
PROGRESS has `sequence: 1` with no status. Handoff YAML example:

```yaml
---
from_step: "0001"
from_order: 1
to_step: "0002"
to_order: 2
---
```

Quote numeric IDs: bare `0001` may parse as a number. Legacy flat handoffs
use their *full* filename IDs and can remain at plan root. Read only relevant
incoming handoffs unless additional context is needed. Paths may be remote
backend paths (e.g. `/workspace/.planner/feature/STEP-0001/INDEX.md`).

## Status, state and lifecycle

Author plan INDEX before build, directory step INDEX before first activation.
Thereafter change only INDEX `status` (Pending, In Progress, Completed, Skipped),
never body or other frontmatter. Planner status writes preserve other bytes;
frozen instruction signatures are checked on startup, checkpoint and recovery.
External changes are detected upon checking, not OS-blocked. Legacy flat STEP
bodies remain writable; planner INDEX writes stay status-only in all plans.
Store new-format progress in PROGRESS/HANDOFF, not INDEX instructions.
`LOOP-STATE.json` stores iteration/options/signatures, not authored work;
legacy INDEX fields are read-only fallback until state exists.

The planner retains an active step or activates the lowest-order Pending step
before delivery; recovery alone neither activates nor compacts. Do not
manually activate a step in normal managed iterations. Save authored context,
mark a finished step Completed/Skipped (include a rationale if skipped), call
`planner_done` once, then end the response. Status-only terminal edits and
untouched PROGRESS/HANDOFF placeholders do not count as saved work, even for
all-terminal completion. Step budget is advisory for manually edited files.

At/above 40% context usage, build/explicit resume stage compaction **before**
startup writes, even in busy headless mode. End the response; callback success
reloads/validates before delivery. Startup failure pauses without writes or a
work prompt; retry explicitly. Checkpoint compaction failure warns and
continues; busy headless checkpoints skip it. Unknown/below-threshold usage
starts normally. Stop (ESC first if busy), cancel, pending messages and stale
callbacks suppress queued startup. `0` disables an explicit limit/budget/cadence.
Use `/planner stop`, `/planner resume <plan-name>`, `/planner cancel <plan-name>`.
Status/activation/runtime writes cannot roll back a partially completed phase;
inspect files before retrying. No cross-process locking or exactly-once prompt
acknowledgement is available.

## Manual migration

Stop and wait for pending work; back up the *whole* plan directory including
LOOP-STATE. Move chosen legacy step instructions/metadata/order/status into
canonical `STEP-<padded-order>/INDEX.md`, split old progress-bearing body into
numbered PROGRESS with `sequence: 1` if needed, and update **all** affected
handoff IDs (quote numeric IDs), endpoint orders and Markdown path references.
Root handoffs may remain root. Avoid collisions/duplicate orders and only
remove old flat files after verifying copies. `/planner list`, inspect, then
resume. If frozen signatures reject a change, restore the backup instead of
editing/deleting runtime state. See [the bundled README](../../README.md) for detailed procedure and limits; resolve the link from this skill directory.
