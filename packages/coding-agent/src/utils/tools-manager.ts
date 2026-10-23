import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
import { join } from "path";
import { getBinDir } from "../config.ts";

type SearchToolName = "fd" | "rg";

const SYSTEM_BINARY_NAMES: Record<SearchToolName, readonly string[]> = {
	fd: ["fd", "fdfind"],
	rg: ["rg"],
};

/** Resolve an existing executable without downloading or installing anything. */
export function getToolPath(tool: SearchToolName): string | undefined {
	for (const name of SYSTEM_BINARY_NAMES[tool]) {
		const result = spawnSync(name, ["--version"], { stdio: "ignore" });
		if (!result.error && result.status === 0) return name;
	}

	// Keep previously installed and manually supplied binaries usable.
	const localPath = join(getBinDir(), tool + (platform() === "win32" ? ".exe" : ""));
	return existsSync(localPath) ? localPath : undefined;
}
