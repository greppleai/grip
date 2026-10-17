import { readFileSync } from "node:fs";

export interface GripManifest {
	extensions?: string[];
	skills?: string[];
	rules?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "rules", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readGripManifest(packageJsonPath: string): GripManifest | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg) || !isObject(pkg.grip)) {
			return null;
		}

		const manifest: GripManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.grip[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
