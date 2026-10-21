import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
	RemoteWorkspaceServerRequestContext,
	RemoteWorkspaceTypedRequest,
} from "../src/core/remote-workspace-protocol/session.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { withSharedRevisionGuard } from "../src/daemon/shared-revision.ts";
import type { ConfinedDaemonToolOperations } from "../src/daemon/workspace-runtime.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("never starts a queued v2 write that was cancelled before entering the file queue", async () => {
	const root = await mkdtemp(join(tmpdir(), "grip-cancel-queued-"));
	dirs.push(root);
	const path = join(root, "file.txt");
	await writeFile(path, "old");
	const held = deferred();
	const started = deferred();
	const blocker = withFileMutationQueue(path, async () => {
		started.resolve();
		await held.promise;
	});
	await started.promise;
	const controller = new AbortController();
	const markSideEffectStarted = vi.fn();
	const context = {
		signal: controller.signal,
		markSideEffectStarted,
	} as unknown as RemoteWorkspaceServerRequestContext;
	const request = {
		method: "workspace.write",
		params: { path, expectedRevision: { unsafeOverwrite: true } },
	} as RemoteWorkspaceTypedRequest;
	const mutate = vi.fn(() => writeFile(path, "new"));
	const action = vi.fn(() => withFileMutationQueue(path, mutate));
	const attempt = withSharedRevisionGuard(request, root, {} as ConfinedDaemonToolOperations, context, action);
	controller.abort();
	held.resolve();
	try {
		await expect(attempt).rejects.toMatchObject({ code: "cancelled", executionState: "not_started" });
		await blocker;
		expect(action).toHaveBeenCalledOnce();
		expect(mutate).not.toHaveBeenCalled();
		expect(markSideEffectStarted).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe("old");
	} finally {
		held.resolve();
		await blocker;
	}
});

it("checks cancellation again after an asynchronous revision read, before any side effect", async () => {
	const root = await mkdtemp(join(tmpdir(), "grip-cancel-check-"));
	dirs.push(root);
	const path = join(root, "file.txt");
	await writeFile(path, "old");
	const reading = deferred();
	const held = deferred();
	const controller = new AbortController();
	const markSideEffectStarted = vi.fn();
	const context = {
		signal: controller.signal,
		markSideEffectStarted,
	} as unknown as RemoteWorkspaceServerRequestContext;
	const request = {
		method: "workspace.write",
		params: { path, expectedRevision: { sha256: createHash("sha256").update("old").digest("hex") } },
	} as RemoteWorkspaceTypedRequest;
	const operations = {
		readFile: async () => {
			reading.resolve();
			await held.promise;
			return Buffer.from("old");
		},
	} as unknown as ConfinedDaemonToolOperations;
	const action = vi.fn(() => withFileMutationQueue(path, () => writeFile(path, "new")));
	const attempt = withSharedRevisionGuard(request, root, operations, context, action);
	await reading.promise;
	controller.abort();
	held.resolve();
	await expect(attempt).rejects.toMatchObject({ code: "cancelled", executionState: "not_started" });
	expect(action).toHaveBeenCalledOnce();
	expect(markSideEffectStarted).not.toHaveBeenCalled();
	expect(await readFile(path, "utf8")).toBe("old");
});
