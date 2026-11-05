import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TuiPerformanceSnapshot, tuiPerformance } from "@greppleai/grip-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PerformanceDiagnostics,
	type PerformanceDiagnosticsContext,
} from "../src/modes/interactive/performance-diagnostics.ts";

let cwd: string;
let diagnostics: PerformanceDiagnostics;
let context: PerformanceDiagnosticsContext;
const errors = vi.fn();
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "grip-diagnostics-"));
	errors.mockReset();
	diagnostics = new PerformanceDiagnostics(errors);
	context = { cwd, sessionId: "session-one", version: "test", mode: () => "regular" };
});
afterEach(async () => {
	await diagnostics.configure(null);
	vi.restoreAllMocks();
	await rm(cwd, { recursive: true, force: true });
});
async function batches(sessionId = context.sessionId): Promise<TuiPerformanceSnapshot[]> {
	const directory = join(cwd, ".grip", "performance", sessionId);
	const files = await readdir(directory);
	const texts = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));
	return texts.flatMap((text) =>
		text
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as TuiPerformanceSnapshot),
	);
}

describe("automatic performance diagnostics", () => {
	it("does not create files or enable the recorder while disabled", async () => {
		await diagnostics.configure(null);
		expect(tuiPerformance.enabled).toBe(false);
		expect(await readdir(cwd)).toEqual([]);
	});
	it("flushes final events to private session-local JSONL and does not duplicate earlier batches", async () => {
		await diagnostics.configure(context);
		tuiPerformance.end("input.dispatch", tuiPerformance.begin(), { bytes: 2, ...{ secret: "PRIVATE-INPUT" } });
		await diagnostics.flush();
		tuiPerformance.end("render.frame", tuiPerformance.begin());
		await diagnostics.configure(null);
		const records = await batches();
		expect(records).toHaveLength(3);
		expect(
			records.flatMap((batch) => batch.traceEvents).filter((event) => event.name === "input.dispatch"),
		).toHaveLength(1);
		expect(records.at(-1)?.summary["render.frame"]?.count).toBe(1);
		expect(records[0]?.metadata).toMatchObject({ gripVersion: "test", tuiMode: "regular" });
		expect(JSON.stringify(records)).not.toContain(cwd);
		expect(JSON.stringify(records)).not.toContain("PRIVATE-INPUT");
		const directory = join(cwd, ".grip", "performance", context.sessionId);
		const names = await readdir(directory);
		expect(names[0]).toMatch(/\.jsonl$/);
		if (process.platform !== "win32") expect((await stat(join(directory, names[0]!))).mode & 0o777).toBe(0o600);
		expect(errors).not.toHaveBeenCalled();
	});
	it("periodically writes while recording without manual export", async () => {
		await diagnostics.configure(context);
		tuiPerformance.count("session.size", { entries: 123 });
		await vi.waitFor(
			async () => {
				expect(
					(await batches()).flatMap((batch) => batch.traceEvents).some((event) => event.name === "session.size"),
				).toBe(true);
			},
			{ timeout: 2500 },
		);
	});
	it("serializes session changes and disable; keeps each session's final events separate", async () => {
		await diagnostics.configure(context);
		tuiPerformance.count("session.size", { entries: 11 });
		const switching = diagnostics.configure({ ...context, sessionId: "session-two" });
		await switching;
		tuiPerformance.count("session.size", { entries: 22 });
		await diagnostics.configure(null);
		const first = (await batches())
			.flatMap((batch) => batch.traceEvents)
			.filter((event) => event.name === "session.size");
		const second = (await batches("session-two"))
			.flatMap((batch) => batch.traceEvents)
			.filter((event) => event.name === "session.size");
		expect(first.map((event) => event.args)).toEqual([{ entries: 11 }]);
		expect(second.map((event) => event.args)).toEqual([{ entries: 22 }]);
		expect(tuiPerformance.enabled).toBe(false);
	});
	it("does not restart captures on an unchanged binding and preserves files on re-enable", async () => {
		await diagnostics.configure(context);
		await diagnostics.configure(context);
		await diagnostics.configure(null);
		await diagnostics.configure(context);
		await diagnostics.configure(null);
		expect(await readdir(join(cwd, ".grip", "performance", context.sessionId))).toHaveLength(2);
	});
	it("stops and reports filesystem failures without rejecting or retrying every tick", async () => {
		await writeFile(join(cwd, ".grip"), "not a directory");
		await expect(diagnostics.configure(context)).resolves.toBeUndefined();
		expect(errors).toHaveBeenCalledTimes(1);
		expect(tuiPerformance.enabled).toBe(false);
		await diagnostics.flush();
		expect(errors).toHaveBeenCalledTimes(1);
	});
	it("rejects session IDs that could escape the diagnostics directory", async () => {
		await diagnostics.configure({ ...context, sessionId: "../outside" });
		expect(errors).toHaveBeenCalledTimes(1);
		expect(await readdir(cwd)).toEqual([]);
	});
	it("coalesces concurrent flushes and flushes events gathered during pending I/O on disable", async () => {
		await diagnostics.configure(context);
		tuiPerformance.count("session.size", { entries: 1 });
		const pending = diagnostics.flush();
		expect(diagnostics.flush()).toBe(pending);
		tuiPerformance.count("session.size", { entries: 2 });
		await diagnostics.configure(null);
		const sizes = (await batches())
			.flatMap((batch) => batch.traceEvents)
			.filter((event) => event.name === "session.size");
		expect(sizes.map((event) => event.args)).toEqual([{ entries: 1 }, { entries: 2 }]);
	});
	it("flushes to the old working directory before rebinding the same session in another directory", async () => {
		await diagnostics.configure(context);
		tuiPerformance.count("session.size", { entries: 1 });
		const other = join(cwd, "other-directory");
		await diagnostics.configure({ ...context, cwd: other });
		tuiPerformance.count("session.size", { entries: 2 });
		await diagnostics.configure(null);
		expect(
			(await batches())
				.flatMap((batch) => batch.traceEvents)
				.filter((event) => event.name === "session.size")
				.map((event) => event.args),
		).toEqual([{ entries: 1 }]);
		expect(await readdir(join(other, ".grip", "performance", context.sessionId))).toHaveLength(1);
	});
	it("disables recording when a write fails after startup", async () => {
		await diagnostics.configure(context);
		const batch = tuiPerformance.snapshot();
		batch.retainedEvents = 1;
		batch.traceEvents = [{ payload: "x".repeat(8 * 1024 * 1024) }];
		vi.spyOn(tuiPerformance, "drain").mockReturnValue(batch);
		await diagnostics.flush();
		expect(tuiPerformance.enabled).toBe(false);
		expect(errors).toHaveBeenCalledTimes(1);
		await diagnostics.flush();
		expect(errors).toHaveBeenCalledTimes(1);
	});
	it("rotates at most four files per capture and caps each file at 8 MiB", async () => {
		await diagnostics.configure(context);
		// Use a large synthetic batch to exercise all rotation slots without a long recording.
		const batch = tuiPerformance.snapshot();
		batch.retainedEvents = 1;
		batch.traceEvents = [{ payload: "x".repeat(4 * 1024 * 1024) }];
		vi.spyOn(tuiPerformance, "drain").mockReturnValue(batch);
		for (let i = 0; i < 6; i++) await diagnostics.flush();
		await diagnostics.configure(null);
		const directory = join(cwd, ".grip", "performance", context.sessionId);
		const names = await readdir(directory);
		expect(names).toHaveLength(4);
		for (const name of names) expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(8 * 1024 * 1024);
		expect(await batches()).toHaveLength(4);
		expect(errors).not.toHaveBeenCalled();
	});
});
