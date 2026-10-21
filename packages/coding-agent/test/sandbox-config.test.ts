import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
	allocateSandboxDaemonPort,
	DEFAULT_SANDBOX_LIMA_TEMPLATE,
	redactSecrets,
	resolveSandboxConfig,
} from "../src/core/sandbox/config.ts";
import type { SandboxSettings } from "../src/core/settings-manager.ts";

describe("Lima sandbox configuration", () => {
	it("resolves overrides, environment, settings and defaults in order", () => {
		const settings: SandboxSettings = {
			limaBinary: "settings-lima",
			limaTemplate: "template:settings",
			workspaceMountPath: "/settings-workspace",
			daemonPort: 9000,
			daemonHostBind: "127.0.0.2",
			cleanup: "remove",
		};
		const config = resolveSandboxConfig(
			settings,
			{
				GRIP_SANDBOX_LIMA: "env-lima",
				GRIP_SANDBOX_LIMA_TEMPLATE: "template:env",
				GRIP_SANDBOX_WORKSPACE_MOUNT: "/env-workspace",
				GRIP_SANDBOX_DAEMON_PORT: "9100",
				GRIP_SANDBOX_DAEMON_HOST_BIND: "127.0.0.3",
				GRIP_SANDBOX_CLEANUP: "stop",
			},
			{ daemonPort: 9200 },
		);
		expect(config).toMatchObject({
			limaBinary: "env-lima",
			limaTemplate: "template:env",
			workspaceMountPath: "/env-workspace",
			daemonPort: 9200,
			daemonHostBind: "127.0.0.3",
			cleanup: "stop",
		});
		expect(resolveSandboxConfig(undefined)).toMatchObject({
			limaTemplate: DEFAULT_SANDBOX_LIMA_TEMPLATE,
			limaBinary: "limactl",
			workspaceMountPath: "/workspace",
		});
		expect(() => resolveSandboxConfig(undefined, { GRIP_SANDBOX_DAEMON_PORT: "nope" })).toThrow("decimal integer");
		expect(redactSecrets("Authorization: Bearer secret GRIP_DAEMON_TOKEN=secret")).toBe(
			"Authorization: Bearer [REDACTED] GRIP_DAEMON_TOKEN=[REDACTED]",
		);
	});

	it("falls back if the preferred daemon port is occupied", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const address = blocker.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP listener address");
		try {
			const allocated = await allocateSandboxDaemonPort("127.0.0.1", address.port);
			expect(allocated).not.toBe(address.port);
			expect(allocated).toBeGreaterThan(0);
		} finally {
			await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
