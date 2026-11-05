import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { tuiPerformance } from "@greppleai/grip-tui";

export interface PerformanceDiagnosticsContext {
	cwd: string;
	sessionId: string;
	version: string;
	mode: () => string;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_COUNT = 4;

/** Buffered local diagnostics. Only one flush can be in flight; the recorder bounds backpressure. */
export class PerformanceDiagnostics {
	private transition: Promise<void> = Promise.resolve();
	private pending: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private context: PerformanceDiagnosticsContext | null = null;
	private file: FileHandle | null = null;
	private directory = "";
	private run = "";
	private slot = 0;
	private bytes = 0;

	constructor(onError: (error: unknown) => void) {
		this.onError = onError;
	}
	private readonly onError: (error: unknown) => void;

	/** Serializes toggles and session changes so batches cannot leak into another session. */
	configure(context: PerformanceDiagnosticsContext | null): Promise<void> {
		this.transition = this.transition.then(async () => {
			if (context && this.context?.cwd === context.cwd && this.context.sessionId === context.sessionId) return;
			await this.stop();
			if (!context) return;
			try {
				if (!/^[a-zA-Z0-9_-]+$/.test(context.sessionId)) throw new Error("Invalid diagnostics session ID");
				this.directory = join(context.cwd, ".grip", "performance", context.sessionId);
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				this.run = `${Date.now()}-${randomUUID()}`;
				this.slot = 0;
				await this.openFile();
				this.context = context;
				tuiPerformance.start();
				this.timer = setInterval(() => void this.flush(), 1000);
				this.timer.unref();
				await this.flush();
			} catch (error) {
				await this.fail(error);
			}
		});
		return this.transition;
	}

	flush(): Promise<void> {
		if (this.pending) return this.pending;
		if (!this.context) return Promise.resolve();
		const batch = tuiPerformance.drain();
		if (!batch.retainedEvents) return Promise.resolve();
		const context = this.context;
		this.pending = (async () => {
			try {
				const line = `${JSON.stringify({
					...batch,
					metadata: {
						...batch.metadata,
						gripVersion: context.version,
						tuiMode: context.mode(),
						capturedAt: new Date().toISOString(),
					},
				})}\n`;
				const size = Buffer.byteLength(line);
				if (size > MAX_FILE_BYTES) throw new Error("Diagnostics batch exceeds file size limit");
				if (this.bytes + size > MAX_FILE_BYTES) {
					await this.file?.close();
					this.file = null;
					this.slot = (this.slot + 1) % FILE_COUNT;
					await this.openFile();
				}
				await this.file!.writeFile(line, "utf8");
				this.bytes += size;
			} catch (error) {
				await this.fail(error);
			}
		})().finally(() => {
			this.pending = null;
		});
		return this.pending;
	}

	private async openFile(): Promise<void> {
		// A unique run prefix preserves previous captures; only this run's four slots are reused.
		const path = join(this.directory, `tui-${this.run}-${this.slot}.jsonl`);
		this.file = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		this.bytes = 0;
	}

	private async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		tuiPerformance.stop();
		await this.pending;
		await this.flush();
		await this.file?.close().catch((error: unknown) => this.onError(error));
		this.file = null;
		this.context = null;
	}

	private async fail(error: unknown): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		tuiPerformance.stop();
		this.context = null;
		await this.file?.close().catch(() => {});
		this.file = null;
		this.onError(error);
	}
}
