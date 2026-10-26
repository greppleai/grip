/**
 * Settings Configuration
 *
 * Override settings using SettingsManager.
 */

import { GripAgent, InMemorySessionManager, SettingsManager } from "@greppleai/grip";

const cwd = process.cwd();

// Load current settings (merged global + project)
const settingsManagerFromDisk = SettingsManager.create(cwd);
console.log("Current settings:", JSON.stringify(settingsManagerFromDisk.getGlobalSettings(), null, 2));

// Override specific settings
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({
	enableJobs: true,
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

const customSettingsPi = await GripAgent.create({
	cwd,
	settingsManager,
	sessionManager: new InMemorySessionManager(cwd),
});
await customSettingsPi.createAgentSession();
console.log("Session created with custom settings");
await customSettingsPi.dispose();

// Setters update memory immediately and queue persistence writes.
// Call flush() when you need a durability boundary.
settingsManager.setDefaultThinkingLevel("low");
await settingsManager.flush();

// Surface settings I/O errors at the app layer.
const settingsErrors = settingsManager.drainErrors();
if (settingsErrors.length > 0) {
	for (const { scope, error } of settingsErrors) {
		console.warn(`Warning (${scope} settings): ${error.message}`);
	}
}

// For testing without file I/O:
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

const testPi = await GripAgent.create({
	cwd,
	settingsManager: inMemorySettings,
	sessionManager: new InMemorySessionManager(cwd),
});
await testPi.createAgentSession();
console.log("Test session created with in-memory settings");
await testPi.dispose();
