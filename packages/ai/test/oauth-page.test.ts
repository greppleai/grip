import { describe, expect, it } from "vitest";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/utils/oauth/oauth-page.ts";

describe("OAuth callback pages", () => {
	it.each([oauthSuccessHtml("Signed in"), oauthErrorHtml("Sign-in failed")])(
		"embeds the Grepple logo without fetching an external asset",
		(html) => {
			expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
			expect(html).toContain('fill="#04bd88"');
			expect(html).toContain('fill="#03815e"');
			expect(html).not.toContain("<img");
		},
	);
});
