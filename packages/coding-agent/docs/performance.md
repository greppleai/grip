# TUI performance diagnostics

Enable **Performance diagnostics** in `/settings` to investigate slow typing, scrolling, or redraws. It is disabled by default. When enabled, Grip automatically records in both regular and fullscreen interactive modes; no capture/export commands or development profiler are needed.

You can also set `"performanceDiagnostics": true` in your global or project `settings.json` before startup. File edits take effect on `/reload`. The `/settings` toggle takes effect immediately. It updates the project preference if explicitly configured there, otherwise the active profile or global preference.

## Files

Diagnostics are saved automatically under the active working directory:

```text
.grip/performance/<session-id>/tui-<capture-id>-<slot>.jsonl
```

Each newline-delimited JSON record is a self-contained batch containing Chrome `traceEvents`, a timing `summary`, overwrite counts, and runtime/version/renderer metadata. Events use microsecond timestamps relative to the start of that capture. Summary durations are milliseconds. Batches do not repeat events; combine batches from the same capture to analyze its timeline. `capturedAt` is the batch's wall-clock timestamp. Rotation slots are not chronological; order batches by capture duration/timestamps.

Grip buffers at most 20,000 events and writes about once per second, with a final flush when disabling diagnostics, switching sessions/directories, or shutting down normally. Slow storage never queues an unbounded backlog: events overwritten before the next flush are counted in that batch's `droppedEvents`. Abrupt termination can lose buffered events or leave an incomplete final JSONL line; ignore that incomplete line when analyzing.

Each capture rotates through four files of at most 8 MiB each (32 MiB maximum per capture). Rotation discards the oldest data in that capture. Starting again creates a new capture and preserves previous files, including on resume. Old captures and other sessions are not automatically deleted; remove their directories when no longer needed. Files request owner-only permissions (`0600`; filesystem rules apply). Add `.grip/performance/` to your repository's ignore rules if needed.

Files are written by the **interactive UI process**, not its tool sandbox. If Grip runs over SSH, files are on that SSH host. If only tools run remotely, files remain on the UI machine under its active working directory. Write failures stop gathering for that capture and show a warning; after fixing the directory, toggle diagnostics off and on to retry. There are no uploads or diagnostic listeners.

## Gather and analyze

1. Enable diagnostics in `/settings` in the affected session.
2. Reproduce the lag for 20–30 seconds by typing, deleting, scrolling, or leaving the UI idle. There is no need to submit a prompt or spend provider tokens.
3. Disable diagnostics to flush the last batch. Collect that session's JSONL files.
4. Compare with a fresh session using the same version, terminal dimensions, renderer mode, extensions, tmux/SSH setup, and actions.

Each batch's `summary` includes count, total, max, p50, and p95 for span timings and sampled event-loop lag. Summaries describe **retained events in that batch only**; do not average batch percentiles. For a Chrome Trace viewer, combine a capture's `traceEvents` arrays into a JSON object with a `traceEvents` property. JSONL itself is intended for direct scripted analysis, not direct trace-viewer import.

| Event | Meaning |
| --- | --- |
| `input.dispatch` | Synchronous input callback handling; a callback may contain multiple characters. |
| `input.to_render` | Earliest coalesced input callback through its next completed application render; separate latency lane because it overlaps UI work. |
| `render.frame` | Whole application frame, dimensions, redraw count delta, and failure flag. |
| `render.prepare`, `component.render` | Component traversal; containers taking less than 1 ms are omitted. |
| `render.layout`, `render.normalize`, `render.diff` | Renderer-specific layout, normalization, and diff/output phases. |
| `terminal.write` | Synchronous write submission time and UTF-8 byte count, not terminal painting. |
| `footer.render`, `footer.usage`, `footer.context`, `footer.compression` | Footer total and statistics calculation phases. |
| `session.size` | Numeric session entry and retained model-message counts. |
| `event_loop.lag` | Excess delay of a 100 ms monotonic timer. |
| `process.memory` | RSS, JS heap, external and ArrayBuffer memory, initially and roughly once per second. |

Large footer spans point toward statistics work; large prepare/component spans toward transcript traversal; large diff/write spans toward output submission. Nested spans are inclusive, so they must not be added together as independent CPU costs.

## Limits and privacy

Recording adds timing, allocation, JSON serialization and local I/O overhead; it is not a zero-overhead benchmark. These are application spans, not a stack-sampling CPU profile. Event-loop stalls alone cannot distinguish GC, contention, or synchronous extension work.

Input timing starts when the terminal callback runs and output timing ends at synchronous write submission. OS/SSH buffering and physical screen painting are outside these measurements. Failed frames have no successful input-to-render completion.

Events contain fixed names and finite numeric arguments, not keystrokes, prompts, transcript text, tool output, credentials, or workspace paths. Runtime/version/platform and capture timestamps are included; the directory name contains the session ID. Review diagnostics before sharing. Turning gathering off stops timers/writes but does not delete saved files.