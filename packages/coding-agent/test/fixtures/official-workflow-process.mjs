import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { GripAgent } from "../../src/core/grip-agent.ts";
import { OFFICIAL_CATALOG_URL } from "../../src/core/official-catalog.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { InMemorySessionManager } from "../../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

// Each invocation is a fresh process: exercise the real pre-import runtime boundary, not a reset latch.
const [agentDir, operation] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(join(agentDir, "workflow-fixture.json"), "utf8"));
// Advance wall-clock freshness/backoff deterministically between processes, never sleep for policy.
Date.now = () => fixture.now;
const artifacts = new Map(fixture.artifacts);
const requests = [];
globalThis.fetch = async (input) => {
	const url = String(input);
	requests.push(url);
	if (url === OFFICIAL_CATALOG_URL) return new Response(JSON.stringify(fixture.catalog));
	const bytes = artifacts.get(url);
	if (!bytes) throw new Error(`Unexpected workflow request: ${url}`);
	return new Response(Buffer.from(bytes, "base64"));
};
const settingsManager = SettingsManager.create(agentDir, agentDir);
const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
const authStorage = AuthStorage.inMemory();
const runtime = await GripAgent.create({
	cwd: agentDir,
	agentDir,
	settingsManager,
	authStorage,
	// Network requests in this fixture belong solely to the official package workflow.
	modelRegistry: ModelRegistry.inMemory(authStorage),
	sessionManager: new InMemorySessionManager(agentDir),
	noTools: "all",
	hooks: false,
	resourceLoaderOptions: { noContextFiles: true },
});
try {
	await runtime.createAgentSession();
	await runtime.session.bindExtensions({});
	let browsed = null;
	if (operation === "install") {
		browsed = await manager.getOfficialCatalog({ refresh: true });
		await manager.installAndPersist("official:alpha");
		await manager.installAndPersist("official:beta");
		await runtime.session.reload();
	} else if (operation === "remove") {
		await manager.removeAndPersist("official:alpha");
		await runtime.session.reload();
	}
	const result = {
		browsed,
		requests,
		packages: settingsManager.getPackages(),
		inventory: await runtime.resourceLoader.getExtensionInventory(),
		commands: runtime.session.extensionRunner.getRegisteredCommands().map(({ name, description }) => ({ name, description })),
		diagnostics: runtime.diagnostics,
	};
	await writeFile(join(agentDir, "workflow-result.json"), JSON.stringify(result));
} finally {
	await runtime.dispose();
}