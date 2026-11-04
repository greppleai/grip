import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const globalModels = [{ model: "global/model", description: "Global" }];
const profileModels = [{ model: "profile/model", description: "Profile" }];
const runtimeModels = [{ model: "runtime/model", description: "Runtime" }];
const projectModels = [{ model: "project/model", description: "Project" }];

describe("job model catalog settings", () => {
	it("uses trusted global, profile and runtime layers, ignoring project settings", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				jobModels: globalModels,
				profiles: { work: { jobModels: profileModels }, empty: { jobModels: [] } },
			}),
		);
		storage.withLock("project", () => JSON.stringify({ jobModels: projectModels }));
		const settings = SettingsManager.fromStorage(storage);
		expect(settings.getJobModels()).toEqual(globalModels);
		settings.useProfile("work");
		expect(settings.getJobModels()).toEqual(profileModels);
		settings.useProfile("empty");
		expect(settings.getJobModels()).toEqual([]);
		settings.applyOverrides({ jobModels: runtimeModels });
		expect(settings.getJobModels()).toEqual(runtimeModels);
		settings.applyOverrides({ jobModels: [] });
		expect(settings.getJobModels()).toEqual([]);
	});

	it("persists independently to global and active profile, preserving concurrent fields", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ jobModel: "default/model", profiles: { work: { theme: "dark" } } }),
		);
		const settings = SettingsManager.fromStorage(storage);
		settings.setJobModels(globalModels);
		await settings.flush();
		settings.useProfile("work");
		storage.withLock("global", (current) => {
			const value = JSON.parse(current ?? "{}");
			value.profiles.work.theme = "light";
			return JSON.stringify(value);
		});
		settings.setJobModels(profileModels);
		await settings.flush();
		await settings.reload();
		expect(settings.getJobModels()).toEqual(profileModels);
		expect(settings.getJobModel()).toBe("default/model");
		expect(settings.getGlobalSettings().jobModels).toEqual(globalModels);
		expect(settings.getProfile("work")?.theme).toBe("light");
		expect(settings.drainErrors()).toEqual([]);
	});

	it("snapshots the trusted catalog, never the project catalog", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ jobModels: globalModels, profiles: { work: { jobModels: [] } } }),
		);
		storage.withLock("project", () => JSON.stringify({ jobModels: projectModels }));
		const settings = SettingsManager.fromStorage(storage);
		settings.setModelProfile("snapshot", []);
		expect(settings.getProfile("snapshot")?.jobModels).toEqual(globalModels);
		settings.useProfile("work");
		settings.setModelProfile("empty-snapshot", []);
		expect(settings.getProfile("empty-snapshot")?.jobModels).toEqual([]);
		settings.applyOverrides({ jobModels: runtimeModels });
		settings.setModelProfile("runtime-snapshot", []);
		await settings.flush();
		await settings.reload();
		expect(settings.getProfile("runtime-snapshot")?.jobModels).toEqual(runtimeModels);
	});

	it("clones setter input and getter results including entries", async () => {
		const settings = SettingsManager.inMemory();
		const input = [{ model: " model ", description: "Description" }];
		settings.setJobModels(input);
		input[0].model = "changed";
		input.push({ model: "extra", description: "Extra" });
		const output = settings.getJobModels();
		output[0].description = "changed";
		output.push({ model: "extra", description: "Extra" });
		expect(settings.getJobModels()).toEqual([{ model: " model ", description: "Description" }]);
		await settings.reload();
		expect(settings.getJobModels()).toEqual([{ model: " model ", description: "Description" }]);
	});

	it("filters malformed and blank entries without changing the default job model", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				jobModel: "default/model",
				jobModels: [
					null,
					{},
					{ model: " ", description: "x" },
					{ model: "x", description: " " },
					{ model: 2, description: "x" },
					{ model: "x", description: false },
					{ model: "valid", description: "Valid", extra: true },
				],
			}),
		);
		const settings = SettingsManager.fromStorage(storage);
		expect(settings.getJobModels()).toEqual([{ model: "valid", description: "Valid" }]);
		expect(settings.getJobModel()).toBe("default/model");
		settings.setJobModels([]);
		expect(settings.getJobModel()).toBe("default/model");
	});
});
