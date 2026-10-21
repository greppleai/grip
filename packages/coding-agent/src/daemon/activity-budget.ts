import { RemoteWorkspaceRequestError } from "../core/remote-workspace-protocol/session.ts";
import type { DaemonConfiguration } from "./config.ts";

/** Counts running handlers across every v1 socket and v2 channel in this daemon. */
export class DaemonActivityBudget {
	private requests = 0;
	private transfers = 0;
	private readonly limits: Pick<DaemonConfiguration, "maxGlobalRequests" | "maxGlobalTransfers">;
	constructor(limits: Pick<DaemonConfiguration, "maxGlobalRequests" | "maxGlobalTransfers">) {
		this.limits = limits;
	}

	async run<T>(method: string, action: () => Promise<T>): Promise<T> {
		const transfer = method.startsWith("transfer.") || method === "artifact.read";
		if (
			this.requests >= this.limits.maxGlobalRequests ||
			(transfer && this.transfers >= this.limits.maxGlobalTransfers)
		) {
			throw new RemoteWorkspaceRequestError({
				code: "limit_exceeded",
				message: "Daemon global active request or transfer limit reached",
				executionState: "not_started",
				retryable: true,
			});
		}
		this.requests++;
		if (transfer) this.transfers++;
		try {
			return await action();
		} finally {
			this.requests--;
			if (transfer) this.transfers--;
		}
	}
}
