import type { AgentSession } from "../../core/agent-session.ts";

export type ExtensionManagerReloadPhase = "pending" | "reloading" | "applied" | "restart-required";

export interface ExtensionManagerReloadStatus {
	phase: ExtensionManagerReloadPhase;
	message: string;
}

export interface ExtensionManagerReloadOptions {
	getSession: () => AgentSession;
	/** Use the interactive reload lifecycle, bound to this exact session. */
	reload: (session: AgentSession) => Promise<void>;
	onStatus: (status: ExtensionManagerReloadStatus) => void;
}

interface ReloadAttempt {
	session: AgentSession;
	signal: AbortSignal;
	isCurrent: () => boolean;
	isRuntimeCurrent: () => boolean;
}

/** Reconciliation after manager operations settle; never aborts session work. */
export class ExtensionManagerReloadCoordinator {
	private readonly options: ExtensionManagerReloadOptions;
	private pending: Promise<void> | null = null;
	private abort: AbortController | null = null;
	private disposed = false;
	private required = false;
	private revision = 0;
	private generation = 0;
	private commands = 0;
	private applying = false;
	private application: Promise<void> | null = null;
	private readonly commandWaiters = new Set<() => void>();

	constructor(options: ExtensionManagerReloadOptions) {
		this.options = options;
	}

	get reloadRequired(): boolean {
		return this.required;
	}

	/** Track interactive submissions: extension commands intentionally release prompt admission. */
	async trackCommand<T>(command: () => Promise<T>): Promise<T> {
		if (this.disposed) throw new Error("Cannot submit commands after extension manager host disposal.");
		const generation = this.generation;
		while (this.applying) {
			const session = this.options.getSession();
			await this.application?.catch(() => {});
			if (this.disposed || this.generation !== generation || this.options.getSession() !== session) {
				throw new Error("Session changed while waiting for extension reload; submit the command again.");
			}
		}
		this.commands++;
		try {
			return await command();
		} finally {
			this.commands--;
			if (this.commands === 0) {
				for (const done of this.commandWaiters) done();
			}
		}
	}

	/** Retain late committed configuration without scheduling work in an invalid context. */
	markRequired(): void {
		this.required = true;
		this.revision++;
	}

	/** Call only after the manager has disposed and its mutation has settled. */
	request(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.markRequired();
		if (this.pending) {
			if (!this.abort?.signal.aborted) return this.pending;
			const generation = this.generation;
			return this.pending.then(() => {
				if (!this.disposed && generation === this.generation && this.required) return this.request();
			});
		}
		const session = this.options.getSession();
		const runner = session.extensionRunner;
		const abort = new AbortController();
		this.abort = abort;
		const current = () => !abort.signal.aborted && this.options.getSession() === session;
		const runtimeCurrent = () => current() && session.extensionRunner === runner;
		const attempt: ReloadAttempt = {
			session,
			signal: abort.signal,
			isCurrent: current,
			isRuntimeCurrent: runtimeCurrent,
		};
		// Assign before observers run, so a reentrant request shares this work.
		this.pending = Promise.resolve().then(async () => {
			try {
				await this.reconcile(attempt);
			} catch (error) {
				if (!current()) return;
				const message = error instanceof Error ? error.message : String(error);
				this.publish({
					phase: "restart-required",
					message: `Extension changes saved; reload or restart required: ${message}`,
				});
			} finally {
				this.pending = null;
				this.abort = null;
			}
		});
		return this.pending;
	}

	private async waitForBarrier(attempt: ReloadAttempt): Promise<void> {
		const { session, signal } = attempt;
		if (this.commands > 0) {
			await new Promise<void>((resolve) => {
				const done = () => {
					signal.removeEventListener("abort", done);
					this.commandWaiters.delete(done);
					resolve();
				};
				this.commandWaiters.add(done);
				signal.addEventListener("abort", done, { once: true });
			});
			return;
		}
		// Cancellation detaches promptly even when the old session never settles.
		await new Promise<void>((resolve, reject) => {
			const canceled = () => resolve();
			signal.addEventListener("abort", canceled, { once: true });
			Promise.resolve()
				.then(() => {
					if (!signal.aborted) return session.waitForIdle();
				})
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", canceled));
		});
	}

	private async reconcile(attempt: ReloadAttempt): Promise<void> {
		while (attempt.isRuntimeCurrent()) {
			if (this.commands > 0 || !attempt.session.isIdle) {
				this.publish({
					phase: "pending",
					message: "Extension changes saved; reload pending until the session is idle.",
				});
				if (!attempt.isRuntimeCurrent()) return;
				await this.waitForBarrier(attempt);
				continue;
			}
			this.publish({ phase: "reloading", message: "Reloading saved extension configuration..." });
			// Presentation callbacks can synchronously replace the session or start work.
			if (!attempt.isRuntimeCurrent()) return;
			if (this.commands > 0 || !attempt.session.isIdle) continue;
			await this.reload(attempt.session);
			return;
		}
	}

	/** Shared application gate for automatic reconciliation and explicit host reload. */
	async reload(session: AgentSession): Promise<void> {
		if (this.disposed || this.applying || this.options.getSession() !== session) {
			throw new Error("Cannot reload an obsolete or already reloading extension host.");
		}
		const generation = this.generation;
		const revision = this.revision;
		this.applying = true;
		// Assign the gate before the lifecycle can synchronously admit another submission.
		const application = Promise.resolve().then(() => this.options.reload(session));
		this.application = application;
		try {
			await application;
		} finally {
			this.applying = false;
			this.application = null;
		}
		if (this.disposed || generation !== this.generation || this.options.getSession() !== session) return;
		if (revision !== this.revision) {
			this.publish({
				phase: "restart-required",
				message: "Additional extension changes saved during reload; reload or restart required.",
			});
			return;
		}
		this.required = false;
		this.publish({
			phase: "applied",
			message: "Extension configuration reloaded; disabled extension loading remains disabled.",
		});
	}

	private publish(status: ExtensionManagerReloadStatus): void {
		try {
			this.options.onStatus(status);
		} catch {
			// A detached status observer cannot change the outcome of a saved mutation.
		}
	}

	/** Invalidate before external reload/session replacement; inspect reloadRequired afterward. */
	invalidate(): void {
		this.generation++;
		this.abort?.abort();
	}

	dispose(): void {
		this.disposed = true;
		this.invalidate();
	}
}
