import { expect, it } from "vitest";
import { DaemonActivityBudget } from "../src/daemon/activity-budget.ts";

it("shares running-request and transfer quotas and releases capacity on completion or failure", async () => {
	const budget = new DaemonActivityBudget({ maxGlobalRequests: 2, maxGlobalTransfers: 1 });
	let releaseTransfer!: () => void;
	const stalled = new Promise<void>((resolve) => {
		releaseTransfer = resolve;
	});
	const transfer = budget.run("transfer.upload", async () => {
		await stalled;
	});
	await expect(budget.run("transfer.download", async () => "unexpected")).rejects.toMatchObject({
		code: "limit_exceeded",
	});
	const reader = budget.run("workspace.read", async () => {
		throw new Error("reader failed");
	});
	await expect(budget.run("workspace.stat", async () => "unexpected")).rejects.toMatchObject({
		code: "limit_exceeded",
	});
	await expect(reader).rejects.toThrow("reader failed");
	await expect(budget.run("workspace.stat", async () => "ok")).resolves.toBe("ok");
	releaseTransfer();
	await transfer;
	await expect(budget.run("transfer.download", async () => "ok")).resolves.toBe("ok");
});
