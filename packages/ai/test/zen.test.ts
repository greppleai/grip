import { describe, expect, it } from "vitest";
import { getModels, refreshModelCatalog } from "../src/models.ts";
import { complete } from "../src/stream.ts";

describe.skipIf(!process.env.OPENCODE_API_KEY)("OpenCode Models Smoke Test", () => {
	it("runs the available OpenCode models", async () => {
		await refreshModelCatalog();
		for (const provider of ["opencode", "opencode-go"] as const) {
			for (const model of getModels(provider)) {
				const response = await complete(model, {
					messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
				});
				expect(response.content).toBeTruthy();
				expect(response.stopReason).toBe("stop");
			}
		}
	}, 60000);
});
