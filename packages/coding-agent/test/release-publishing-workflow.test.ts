import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

interface CheckoutOptions {
	ref?: string;
	"persist-credentials"?: boolean;
}

interface WorkflowStep {
	name: string;
	run?: string;
	with?: CheckoutOptions;
}

interface NpmPublishJob {
	needs: string[];
	if: string;
	permissions: Record<string, string>;
	steps: WorkflowStep[];
}

interface ReleaseWorkflow {
	jobs: Record<"publish-npm", NpmPublishJob>;
}

it("publishes the four built npm packages from the release tag after binary verification", () => {
	const workflow = parse(
		readFileSync(new URL("../../../.github/workflows/release-please.yml", import.meta.url), "utf8"),
	) as ReleaseWorkflow;
	const job = workflow.jobs["publish-npm"];
	expect(job.needs).toEqual(["release-please", "publish-binary"]);
	expect(job.if).toContain("cli_release_created == 'true'");
	expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });

	const checkout = job.steps.find((step) => step.name === "Checkout release tag");
	expect(checkout?.with?.ref).toContain("needs.release-please.outputs.cli_tag");
	expect(checkout?.with?.["persist-credentials"]).toBe(false);
	const verify = job.steps.findIndex((step) => step.name === "Verify release package versions");
	const install = job.steps.findIndex((step) => step.name === "Install dependencies");
	const build = job.steps.findIndex((step) => step.name === "Build npm packages");
	const check = job.steps.findIndex((step) => step.name === "Check npm packages");
	const cli = job.steps.findIndex((step) => step.name === "Install npm CLI with trusted publishing support");
	const publish = job.steps.findIndex((step) => step.name === "Publish npm packages");
	expect(verify).toBeGreaterThan(-1);
	expect(install).toBeGreaterThan(verify);
	expect(build).toBeGreaterThan(install);
	expect(check).toBeGreaterThan(build);
	expect(cli).toBeGreaterThan(check);
	expect(publish).toBeGreaterThan(cli);
	expect(job.steps[install]?.run).toBe("npm ci --ignore-scripts");
	expect(job.steps[build]?.run).toBe("npm run build");
	expect(job.steps[check]?.run).toBe("npm run check");
	const command = job.steps[publish]?.run;
	expect(command).toContain("for package in packages/tui packages/ai packages/agent packages/coding-agent; do");
	expect(command).toContain('npm publish --workspace "$package" --access public --provenance --ignore-scripts');
	expect(command).toContain("publish_tag=next");
	expect(job.steps[cli]?.run).toContain("npm@11.6.4 --ignore-scripts");
});
