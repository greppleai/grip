import { describe, expect, it } from "vitest";
import { getModel, getModels } from "../src/models.ts";

describe("Xiaomi MiMo models", () => {
	it("keeps mimo-v2.6-flash on the API billing provider", () => {
		expect(getModel("xiaomi", "mimo-v2.6-flash")).toMatchObject({
			provider: "xiaomi",
			baseUrl: "https://api.xiaomimimo.com/v1",
		});
	});

	it.each([
		["xiaomi-token-plan-cn", "https://token-plan-cn.xiaomimimo.com/v1"],
		["xiaomi-token-plan-ams", "https://token-plan-ams.xiaomimimo.com/v1"],
		["xiaomi-token-plan-sgp", "https://token-plan-sgp.xiaomimimo.com/v1"],
	] as const)("keeps mimo-v2.6-flash on the separate %s endpoint", (provider, baseUrl) => {
		expect(getModels(provider).find((model) => model.id === "mimo-v2.6-flash")).toMatchObject({ provider, baseUrl });
	});
});
