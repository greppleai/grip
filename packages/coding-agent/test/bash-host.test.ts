import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";

const command = "printf secret";
const description = "User asked for host diagnostics; may inspect host configuration";

function setup() {
	const tool = createBashToolDefinition(new LocalToolOperations(process.cwd()), {
		commandPrefix: "printf guest-prefix;",
	});
	const execHostCommand = vi.fn().mockResolvedValue({
		output: "SECRET_TOKEN",
		exitCode: 0,
		cancelled: false,
		fullOutputPath: "/host/private.log",
	});
	const notify = vi.fn();
	const ctx = { isSandbox: () => true, execHostCommand, hasUI: true, ui: { notify } } as unknown as ExtensionContext;
	return { tool, execHostCommand, notify, ctx };
}

describe("bash host execution", () => {
	it("requires a description only for host: true", async () => {
		const { tool, execHostCommand, ctx } = setup();
		expect(JSON.stringify(tool.parameters.properties.host)).toContain("boolean");
		await expect(tool.execute("bad", { command, host: true }, undefined, undefined, ctx)).rejects.toThrow(
			"requires a non-empty description",
		);
		await expect(
			tool.execute("blank", { command, host: true, description: " \t" }, undefined, undefined, ctx),
		).rejects.toThrow("requires a non-empty description");
		expect(execHostCommand).not.toHaveBeenCalled();
		const guest = await tool.execute("guest", { command: "printf guest", host: false }, undefined, undefined, ctx);
		expect(guest.content[0]).toMatchObject({ text: "guest-prefixguest" });
	});

	it("calls only Grip's approved host API with an exact command and separate deadlines", async () => {
		const { tool, execHostCommand, ctx } = setup();
		const updates = vi.fn();
		const result = await tool.execute("host", { command, host: true, description }, undefined, updates, ctx);
		expect(execHostCommand).toHaveBeenCalledWith(command, {
			question: expect.stringContaining(`Unverified agent description: ${description}`),
			signal: undefined,
			approvalTimeoutMs: 60_000,
			timeout: 120,
		});
		expect(updates).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN|private\.log/);
		await tool.execute("custom-timeout", { command, host: true, description, timeout: 9 }, undefined, undefined, ctx);
		expect(execHostCommand.mock.calls[1]?.[1].timeout).toBe(9);
	});

	it("fails closed without a sandbox or approval and keeps host output out of errors", async () => {
		const { tool, execHostCommand, notify, ctx } = setup();
		await expect(
			tool.execute(
				"no-context",
				{ command, host: true, description },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			),
		).rejects.toThrow("sandbox");
		await expect(
			tool.execute("disconnected", { command, host: true, description }, undefined, undefined, {
				...ctx,
				isSandbox: () => false,
			}),
		).rejects.toThrow("sandbox");
		expect(execHostCommand).not.toHaveBeenCalled();
		execHostCommand.mockRejectedValueOnce(new Error("Host command was not approved"));
		await expect(
			tool.execute("denied", { command, host: true, description }, undefined, undefined, ctx),
		).rejects.toThrow("not approved");
		execHostCommand.mockResolvedValueOnce({ output: "SECRET_TOKEN", exitCode: 7, cancelled: false });
		await expect(
			tool.execute("failed", { command, host: true, description }, undefined, undefined, ctx),
		).rejects.toThrow("exit code 7); output withheld");
		expect(notify).toHaveBeenCalledWith("Host command output:\nSECRET_TOKEN", "error");
	});
});
