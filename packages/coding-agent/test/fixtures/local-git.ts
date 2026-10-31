import { spawnSync } from "node:child_process";

export interface CommandOptions {
	cwd: string;
}

export type NpmCommand = (args: string[], options: CommandOptions) => Promise<void>;

export function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	if (result.status !== 0) throw new Error(`Git failed: ${result.stderr}`);
	return result.stdout;
}
