import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExpectedWorkspaceRevision } from "../core/remote-workspace-protocol/contract.ts";
import {
	RemoteWorkspaceRequestError,
	type RemoteWorkspaceServerRequestContext,
	type RemoteWorkspaceTypedRequest,
} from "../core/remote-workspace-protocol/session.ts";
import { withFileMutationGuard } from "../core/tools/file-mutation-queue.ts";
import type { ConfinedDaemonToolOperations } from "./workspace-runtime.ts";

type SharedRevisionErrorCode = "invalid_request" | "conflict";

function revisionError(code: SharedRevisionErrorCode, message: string): RemoteWorkspaceRequestError {
	return new RemoteWorkspaceRequestError({ code, message, executionState: "not_started", retryable: false });
}
function requireActiveMutation(context: RemoteWorkspaceServerRequestContext): void {
	if (context.signal.aborted)
		throw new RemoteWorkspaceRequestError({
			code: "cancelled",
			message: "Shared mutation was cancelled before starting",
			executionState: "not_started",
			retryable: false,
		});
}

function missing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function checkRevision(
	filePath: string,
	target: string,
	revision: ExpectedWorkspaceRevision,
	operations: ConfinedDaemonToolOperations,
	context: RemoteWorkspaceServerRequestContext,
): Promise<void> {
	requireActiveMutation(context);
	if (resolve(filePath) !== target)
		throw revisionError("invalid_request", "Shared mutation path does not match its revision precondition");
	if ("sha256" in revision || "absent" in revision) {
		let actual: Buffer | undefined;
		try {
			actual = await operations.readFile(target);
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if ("sha256" in revision && (!actual || createHash("sha256").update(actual).digest("hex") !== revision.sha256)) {
			throw revisionError("conflict", "Workspace file changed since the expected revision");
		}
		if ("absent" in revision && actual) throw revisionError("conflict", "Workspace file already exists");
	}
	requireActiveMutation(context);
	context.markSideEffectStarted();
}
/** v2-only CAS checked inside the same process-wide per-file queue as edit/write. */
export function withSharedRevisionGuard<T>(
	request: RemoteWorkspaceTypedRequest,
	root: string,
	operations: ConfinedDaemonToolOperations,
	context: RemoteWorkspaceServerRequestContext,
	action: () => Promise<T>,
): Promise<T> {
	const params = request.params as Record<string, unknown>;
	const toolName = request.method === "tool.invoke" ? params.toolName : undefined;
	if (request.method !== "workspace.write" && toolName !== "edit" && toolName !== "write") return action();
	const args = toolName ? (params.arguments as { path?: unknown }) : params;
	if (typeof args?.path !== "string" || !args.path)
		throw revisionError("invalid_request", "Shared mutation requires a file path");
	const revision = params.expectedRevision as ExpectedWorkspaceRevision | undefined;
	if (!revision || (toolName === "edit" && !("sha256" in revision))) {
		throw revisionError(
			"invalid_request",
			"Shared edit requires expected SHA-256; shared write requires expected SHA-256, expected absence or explicit unsafeOverwrite",
		);
	}
	const options = params.executionOptions as { cwd?: string } | undefined;
	const target = resolve(options?.cwd ?? root, args.path);
	return withFileMutationGuard((filePath) => checkRevision(filePath, target, revision, operations, context), action);
}
