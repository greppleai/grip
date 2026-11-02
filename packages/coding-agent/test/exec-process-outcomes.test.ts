import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("shared process outcomes", () => {
	it("preserves normal zero and nonzero exits and both output streams", async () => {
		const success = await execCommand(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd());
		expect(success).toEqual({ stdout: "ok", stderr: "", code: 0, killed: false });
		const failure = await execCommand(
			process.execPath,
			["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7"],
			process.cwd(),
		);
		expect(failure).toEqual({ stdout: "out", stderr: "err", code: 7, killed: false });
	});

	it.skipIf(process.platform === "win32")("does not turn an external signal into success", async () => {
		for (const signal of ["SIGTERM", "SIGKILL"]) {
			const result = await execCommand(
				process.execPath,
				["-e", `process.kill(process.pid, '${signal}')`],
				process.cwd(),
				{ timeout: 5_000 },
			);
			expect(result).toMatchObject({ code: null, killed: false });
		}
	});

	it("reports spawn failure without inventing an exit status", async () => {
		const result = await execCommand(`${process.execPath}.missing-executable`, [], process.cwd());
		expect(result).toMatchObject({ stdout: "", code: null, killed: false });
		expect(result.stderr).toContain("ENOENT");
	});
});
