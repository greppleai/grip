import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OFFICIAL_CATALOG_URL } from "../../src/core/official-catalog.ts";
import { OfficialExtensionInstaller } from "../../src/core/official-installer.ts";
import { OfficialTransport } from "../../src/core/official-transport.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

// Run the actual source transaction in a separate Node process. No built Grip output or network.
const [agentDir, operation, idsArgument, holdPhase] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(join(agentDir, "startup-fixture.json"), "utf8"));
const artifacts = new Map(fixture.artifacts);
const settingsManager = SettingsManager.create(agentDir, agentDir);
await settingsManager.reload();
const installer = new OfficialExtensionInstaller(
	{ agentDir, settingsManager, gripVersion: "0.1.8" },
	{
		now: () => fixture.now,
		transport: new OfficialTransport(async (input) => {
			const url = String(input);
			process.send({ type: "request", url });
			if (url === OFFICIAL_CATALOG_URL) return new Response(JSON.stringify(fixture.catalog));
			const bytes = artifacts.get(url);
			if (!bytes) throw new Error(`Unexpected fixture request: ${url}`);
			return new Response(Buffer.from(bytes, "base64"));
		}),
		onProgress: async (event) => {
			if (event.id === "alpha" && event.phase === holdPhase) {
				const released = once(process, "message");
				process.send({ type: "paused", ...event });
				await released;
			}
			process.send({ type: "progress", ...event });
		},
	},
);
const started = once(process, "message");
process.send({ type: "ready" });
await started;
process.send({ type: "started" });
const ids = idsArgument.split(",");
const result = operation === "remove" ? await installer.remove(ids[0]) : await installer.startupUpdates(ids);
process.send({ type: "result", result: result ?? null });
process.disconnect();