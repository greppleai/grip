import type { GitExtensionPreparation } from "../../src/core/git-extension-installer.ts";
import type { InstalledSourceScope } from "../../src/core/package-manager.ts";

export const GIT_EXTENSION_URL = "https://example.com/author/extension";

export function gitExtensionReview(scope: InstalledSourceScope = "user"): GitExtensionPreparation {
	return {
		id: "review-fixture",
		source: GIT_EXTENSION_URL,
		requestedRef: "main",
		commit: "a".repeat(40),
		scope,
		profile: "work",
		name: "Third-party fixture",
		version: "1.0",
		entries: ["extension.ts"],
		warning:
			"Dependency scripts and extensions run with full user permissions. Validation is not sandboxing or publisher authentication; packages may supply skills, rules, prompts and themes.",
	};
}
