import { execFile } from "node:child_process";
import type { ExecResult } from "@greppleai/grip";

interface HostCliExecutionOptions {
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal | undefined;
}

/** Deliberate host execution. Call only after validating the host-owned argv policy. */
export function executeHostCli(name: string, args: string[], options: HostCliExecutionOptions): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			name,
			args,
			{
				cwd: options.cwd,
				signal: options.signal,
				timeout: options.timeoutMs,
				killSignal: "SIGKILL",
				shell: false,
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
			},
			(error, stdout, stderr) => {
				let code: number | null = 0;
				if (error) {
					code = typeof error.code === "number" ? error.code : null;
					stderr += `\n[Host process error: ${error.code ?? error.name}]`;
				}
				resolve({
					stdout,
					stderr,
					code,
					killed: Boolean(error?.killed || error?.signal || options.signal?.aborted),
				});
			},
		);
	});
}
