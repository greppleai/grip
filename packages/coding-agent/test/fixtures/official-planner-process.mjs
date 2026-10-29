import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { GripAgent } from "../../src/core/grip-agent.ts";
import { OFFICIAL_CATALOG_URL } from "../../src/core/official-catalog.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { InMemorySessionManager } from "../../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { LocalToolOperations } from "../../src/core/tools/operations.ts";

// Each invocation is a fresh process so installed code is loaded through the normal startup boundary.
const [agentDir, workspace, operation] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(join(agentDir, "planner-fixture.json"), "utf8"));
Date.now = () => fixture.now;
const artifacts = new Map(fixture.artifacts);
const requests = [];
globalThis.fetch = async (input) => {
	const url = String(input);
	requests.push(url);
	if (url === OFFICIAL_CATALOG_URL) return new Response(JSON.stringify(fixture.catalog));
	const bytes = artifacts.get(url);
	if (!bytes) throw new Error(`Unexpected planner lifecycle request: ${url}`);
	return new Response(Buffer.from(bytes, "base64"));
};

const settingsManager = SettingsManager.create(agentDir, agentDir);
if (operation === "missing") {
	settingsManager.setPackages(["official:planner"]);
	await settingsManager.flush();
}
if (operation === "unselected") {
	settingsManager.setPackages([]);
	await settingsManager.flush();
}
const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
const authStorage = AuthStorage.inMemory();
const runtime = await GripAgent.create({
	cwd: agentDir,
	agentDir,
	settingsManager,
	authStorage,
	modelRegistry: ModelRegistry.inMemory(authStorage),
	sessionManager: new InMemorySessionManager(agentDir),
	toolOperations: new LocalToolOperations(workspace),
	noTools: "builtin",
	hooks: false,
	resourceLoaderOptions: { noContextFiles: true },
});
try {
	await runtime.createAgentSession();
	await runtime.session.bindExtensions({});
	let browsed = null;
	let prepared = null;
	if (operation === "install") {
		browsed = await manager.getOfficialCatalog({ refresh: true });
		await manager.installAndPersist("official:planner");
		await runtime.session.reload();
		const tool = runtime.session.extensionRunner
			.getAllRegisteredTools()
			.find(({ definition }) => definition.name === "planner_prepare");
		if (!tool) throw new Error("planner_prepare was not registered");
		prepared = await tool.definition.execute(
			"planner-lifecycle-prepare",
			{ planName: "lifecycle-plan", name: "Lifecycle Plan" },
			undefined,
			() => {},
			runtime.session.extensionRunner.createContext(),
		);
	} else if (operation === "reload") {
		await runtime.session.reload();
	} else if (operation === "uninstall") {
		await manager.removeAndPersist("official:planner");
		await runtime.session.reload();
	}
	const extensions = runtime.resourceLoader.getExtensions().extensions;
	const skills = runtime.resourceLoader.getSkills().skills;
	const tools = runtime.session.extensionRunner.getAllRegisteredTools();
	const result = {
		browsed,
		prepared,
		requests,
		packages: settingsManager.getPackages(),
		extensions: extensions.map(({ path, sourceInfo }) => ({ path, sourceInfo })),
		skills: skills.map(({ name, sourceInfo }) => ({ name, sourceInfo })),
		tools: tools.map(({ definition }) => definition.name),
	};
	await writeFile(join(agentDir, "planner-result.json"), JSON.stringify(result));
} finally {
	await runtime.dispose();
}
