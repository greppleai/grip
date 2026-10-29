import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.ts";

describe("model profile settings", () => {
	it("persists image model in the active profile and clears inherited values", async () => {
		const manager = SettingsManager.inMemory({ imageModel: "global-image", profiles: { work: { theme: "dark" } } });
		manager.useProfile("work");
		manager.setImageModel("custom-image-1");
		await manager.flush();
		await manager.reload();
		expect(manager.getImageModel()).toBe("custom-image-1");
		expect(manager.getGlobalSettings().imageModel).toBe("global-image");
		expect(manager.getProfile("work")?.theme).toBe("dark");
		manager.setImageModel(undefined);
		await manager.flush();
		await manager.reload();
		expect(manager.getImageModel()).toBeUndefined();
		expect(() => manager.setImageModel("bad/model")).toThrow();
	});
	it("stores independent named model snapshots", async () => {
		const manager = SettingsManager.inMemory();

		manager.setModelProfile("fast", ["openai/gpt-5-mini", "google/gemini-flash"]);
		manager.setModelProfile("deep", ["anthropic/claude-opus:high"]);
		await manager.flush();
		await manager.reload();

		expect(manager.getModelProfiles()).toEqual({
			fast: ["openai/gpt-5-mini", "google/gemini-flash"],
			deep: ["anthropic/claude-opus:high"],
		});
	});
	it("omits inherited enabledModels when a profile has no scoped models", async () => {
		const manager = SettingsManager.inMemory({
			enabledModels: ["openai/*"],
			defaultProvider: "openai",
			defaultModel: "gpt-5",
		});
		manager.setModelProfile("work", [], { provider: "openai", id: "gpt-5" });
		await manager.flush();
		await manager.reload();
		expect(Object.hasOwn(manager.getGlobalSettings().profiles?.work ?? {}, "enabledModels")).toBe(false);
		expect(manager.getModelProfiles()).toEqual({ work: [] });
		manager.useProfile("work");
		expect(manager.getDefaultModel()).toBe("gpt-5");
		expect(manager.getEnabledModels()).toEqual(["openai/*"]);
	});

	it("does not retain an old scope when replacing a profile without scoped models", async () => {
		const manager = SettingsManager.inMemory({ profiles: { work: { enabledModels: ["openai/*"] } } });
		manager.setModelProfile("work", []);
		await manager.flush();
		await manager.reload();
		expect(Object.hasOwn(manager.getProfile("work") ?? {}, "enabledModels")).toBe(false);
	});

	it("returns a defensive copy", () => {
		const manager = SettingsManager.inMemory({ modelProfiles: { work: ["openai/gpt-5"] } });
		const profiles = manager.getModelProfiles();

		profiles.work?.push("anthropic/claude-opus");

		expect(manager.getModelProfiles().work).toEqual(["openai/gpt-5"]);
	});

	it("ignores malformed stored profiles and rejects unsafe names", () => {
		const manager = SettingsManager.inMemory({
			modelProfiles: { valid: ["openai/gpt-5"], broken: null },
		} as unknown as Settings);

		expect(manager.getModelProfiles()).toEqual({ valid: ["openai/gpt-5"] });
		expect(() => manager.setModelProfile("__proto__", ["openai/gpt-5"])).toThrow("Invalid model profile name");
	});
	it("applies a whole-settings profile including model and job model, persisting active edits only in that profile", async () => {
		const manager = SettingsManager.inMemory({
			defaultProvider: "anthropic",
			defaultModel: "base",
			jobModel: "anthropic/base",
			terminal: { showImages: true },
			profiles: {
				work: {
					defaultProvider: "openai",
					defaultModel: "work-model",
					jobModel: "openai/job",
					terminal: { imageWidthCells: 42 },
					enableJobs: false,
				},
			},
		});
		manager.useProfile("work");
		expect(manager.getDefaultModel()).toBe("work-model");
		expect(manager.getDefaultProvider()).toBe("openai");
		expect(manager.getJobModel()).toBe("openai/job");
		expect(manager.getShowImages()).toBe(true);
		expect(manager.getImageWidthCells()).toBe(42);
		expect(manager.getEnableJobs()).toBe(false);
		manager.setJobModel("openai/new-job");
		manager.setDefaultModelAndProvider("openai", "new-model");
		manager.setShowImages(false);
		await manager.flush();
		await manager.reload();
		expect(manager.getActiveProfile()).toBe("work");
		expect(manager.getJobModel()).toBe("openai/new-job");
		expect(manager.getDefaultModel()).toBe("new-model");
		expect(manager.getShowImages()).toBe(false);
		expect(manager.getImageWidthCells()).toBe(42);
		expect(manager.getGlobalSettings().defaultModel).toBe("base");
		expect(manager.getGlobalSettings().jobModel).toBe("anthropic/base");
		manager.setJobModel(undefined);
		await manager.flush();
		await manager.reload();
		expect(manager.getJobModel()).toBeUndefined();
	});

	it("chooses the longest directory ancestor without matching sibling prefixes", () => {
		const settings: Settings = {
			// An obsolete saved selection must not override the directory rule.
			activeProfile: "personal",
			profiles: {
				personal: { jobModel: "test/personal" },
				work: { jobModel: "test/work" },
				project: { jobModel: "test/project" },
			},
			profileDirectories: { "/home/user/work": "work", "/home/user/work/repo": "project" },
		};
		const nested = SettingsManager.inMemory(settings, "/home/user/work/repo/src");
		expect(nested.getActiveProfile()).toBe("project");
		expect(nested.getJobModel()).toBe("test/project");
		expect(SettingsManager.inMemory(settings, "/home/user/work/other").getActiveProfile()).toBe("work");
		expect(SettingsManager.inMemory(settings, "/home/user/workshop").getActiveProfile()).toBeUndefined();
		nested.useProfile("personal");
		expect(nested.getActiveProfile()).toBe("personal");
	});

	it("layers ordinary project settings above profiles but ignores untrusted project job models", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				jobModel: "test/global",
				profiles: { work: { jobModel: "test/profile", terminal: { showImages: false } } },
				// A saved selection is ignored; the active profile is session-only.
				activeProfile: "work",
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({ terminal: { imageWidthCells: 80 }, jobModel: "test/project" }),
		);
		const manager = SettingsManager.fromStorage(storage);
		manager.useProfile("work");
		expect(manager.getJobModel()).toBe("test/profile");
		expect(manager.getShowImages()).toBe(false);
		expect(manager.getImageWidthCells()).toBe(80);
		manager.applyOverrides({ jobModel: "test/runtime" });
		expect(manager.getJobModel()).toBe("test/runtime");
	});

	it("does not snapshot untrusted project model settings into a trusted profile", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ jobModel: "test/trusted", compressionDetectionModel: "test/detector" }),
		);
		storage.withLock("project", () =>
			JSON.stringify({ jobModel: "test/untrusted", compressionDetectionModel: "test/untrusted" }),
		);
		const manager = SettingsManager.fromStorage(storage);
		manager.setModelProfile("safe", ["test/model"]);
		await manager.flush();
		manager.useProfile("safe");
		expect(manager.getJobModel()).toBe("test/trusted");
		expect(manager.getCompressionDetectionModel()).toBe("test/detector");
		expect(manager.getProfile("safe")?.jobModel).toBe("test/trusted");
		expect(manager.getProfile("safe")?.compressionDetectionModel).toBe("test/detector");
	});

	it("preserves external edits to other fields in the same profile", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ profiles: { work: { theme: "dark" } } }));
		const manager = SettingsManager.fromStorage(storage);
		manager.useProfile("work");
		storage.withLock("global", (current) =>
			JSON.stringify({ ...JSON.parse(current!), profiles: { work: { theme: "light" } } }),
		);
		manager.setJobModel("test/job");
		await manager.flush();
		const fresh = SettingsManager.fromStorage(storage);
		fresh.useProfile("work");
		expect(fresh.getTheme()).toBe("light");
		expect(fresh.getJobModel()).toBe("test/job");
	});

	it("loads a directory profile from disk for nested startups and leaves siblings on the fallback", () => {
		const root = mkdtempSync(join(tmpdir(), "grip-profile-"));
		try {
			const agentDir = join(root, "agent");
			const workDir = join(root, "work");
			const child = join(workDir, "repo", "src");
			const sibling = join(root, "workshop");
			mkdirSync(agentDir);
			mkdirSync(child, { recursive: true });
			mkdirSync(sibling);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					// Saved activeProfile is ignored even if present from an older release.
					activeProfile: "personal",
					profiles: {
						personal: { defaultModel: "personal", jobModel: "test/personal", defaultSandbox: "personal-vm" },
						work: { defaultModel: "work", jobModel: "test/work", defaultSandbox: "work-vm" },
					},
					profileDirectories: { [workDir]: "work" },
				}),
			);
			const work = SettingsManager.create(child, agentDir);
			expect(work.getActiveProfile()).toBe("work");
			expect(work.getDefaultModel()).toBe("work");
			expect(work.getJobModel()).toBe("test/work");
			expect(work.getAutoConnectSandbox(child)).toBe("work-vm");
			const personal = SettingsManager.create(sibling, agentDir);
			expect(personal.getActiveProfile()).toBeUndefined();
			expect(personal.getAutoConnectSandbox(sibling)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("assigns directory rules and migrates legacy snapshots on activation", async () => {
		const manager = SettingsManager.inMemory({ modelProfiles: { work: ["test/model"] } });
		manager.setProfileDirectory("/home/user/work", "work");
		manager.useProfile("work");
		manager.setJobModel("test/job");
		await manager.flush();
		await manager.reload();
		expect(manager.getModelProfiles().work).toEqual(["test/model"]);
		expect(manager.getJobModel()).toBe("test/job");
		expect(manager.getGlobalSettings().profileDirectories).toEqual({ "/home/user/work": "work" });
		expect(() => manager.setProfileDirectory("/home/user/workshop", "missing")).toThrow("Unknown profile");
		expect(() => manager.setProfileDirectory("relative", "work")).toThrow("absolute path");
	});
	it("resolves trusted profile sandbox defaults without allowing project injection", async () => {
		const cwd = realpathSync(process.cwd());
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				// The sandbox follows the session's active profile, not a saved fallback.
				activeProfile: "work",
				defaultSandboxes: { [cwd]: "directory-vm" },
				profiles: { work: { defaultSandbox: "work-vm", autoConnectSandbox: true } },
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				defaultSandbox: "project-vm",
				autoConnectSandbox: false,
				profiles: { work: { defaultSandbox: "project-vm" } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage, cwd);
		manager.useProfile("work");
		expect(manager.getAutoConnectSandbox(cwd)).toBe("work-vm");
		manager.setModelProfile("copy", ["test/model"]);
		await manager.flush();
		expect(manager.getProfile("copy")?.defaultSandbox).toBe("work-vm");
		expect(manager.getProfile("copy")?.autoConnectSandbox).toBe(true);
		manager.useProfile("copy");
		expect(manager.getAutoConnectSandbox(cwd)).toBe("work-vm");
	});

	it("uses directory defaults when no profile VM is assigned, unless the profile opts out", () => {
		const cwd = realpathSync(process.cwd());
		const settings: Settings = {
			defaultSandboxes: { [cwd]: "directory-vm" },
			profiles: { work: { theme: "light" }, disabled: { autoConnectSandbox: false } },
			activeProfile: "work", // Ignored: selection must be made in this session.
		};
		const manager = SettingsManager.inMemory(settings, cwd);
		manager.useProfile("work");
		expect(manager.getAutoConnectSandbox(cwd)).toBe("directory-vm");
		manager.useProfile("disabled");
		expect(manager.getDefaultSandbox(cwd)).toBe("directory-vm");
		expect(manager.getAutoConnectSandbox(cwd)).toBeUndefined();
		expect(
			SettingsManager.inMemory({ defaultSandboxes: { [cwd]: "directory-vm" } }, cwd).getAutoConnectSandbox(cwd),
		).toBe("directory-vm");
	});
	it("does not save a manual profile selection and removes obsolete saved selections", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				activeProfile: "work",
				defaultModel: "global-model",
				profiles: { work: { defaultModel: "work-model" } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getActiveProfile()).toBeUndefined();
		manager.useProfile("work");
		expect(manager.getActiveProfile()).toBe("work");
		expect(manager.getDefaultModel()).toBe("work-model");
		await manager.flush();
		let savedJson: string | undefined;
		storage.withLock("global", (content) => {
			savedJson = content;
			return undefined;
		});
		const saved = JSON.parse(savedJson!);
		expect(Object.hasOwn(saved, "activeProfile")).toBe(false);
		const nextSession = SettingsManager.fromStorage(storage);
		expect(nextSession.getActiveProfile()).toBeUndefined();
		expect(nextSession.getDefaultModel()).toBe("global-model");
	});
	it("switches an existing profile without changing the settings file", async () => {
		const storage = new InMemorySettingsStorage();
		const original = JSON.stringify({ profiles: { work: { jobModel: "test/work" } } });
		storage.withLock("global", () => original);
		const manager = SettingsManager.fromStorage(storage);
		manager.useProfile("work");
		await manager.flush();
		let saved: string | undefined;
		storage.withLock("global", (content) => {
			saved = content;
			return undefined;
		});
		expect(saved).toBe(original);
		expect(manager.getJobModel()).toBe("test/work");
		const nextSession = SettingsManager.fromStorage(storage);
		expect(nextSession.getActiveProfile()).toBeUndefined();
		expect(nextSession.getJobModel()).toBeUndefined();
	});

	it("updates profile sandbox fields without overwriting unrelated edits or legacy model scopes", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ profiles: { work: { theme: "dark" } }, modelProfiles: { old: ["test/model"] } }),
		);
		const manager = SettingsManager.fromStorage(storage);
		storage.withLock("global", (content) =>
			JSON.stringify({
				...JSON.parse(content!),
				profiles: { work: { theme: "light" } },
			}),
		);
		manager.setProfileSandboxOptions("work", { defaultSandbox: "my-vm", autoConnectSandbox: false });
		await manager.flush();
		const fresh = SettingsManager.fromStorage(storage);
		expect(fresh.getProfile("work")).toMatchObject({
			theme: "light",
			defaultSandbox: "my-vm",
			autoConnectSandbox: false,
		});
		expect(() => manager.setProfileSandbox("work", "bad vm")).toThrow("Profile sandbox");
		fresh.setProfileSandbox("old", "legacy-vm");
		await fresh.flush();
		expect(SettingsManager.fromStorage(storage).getProfile("old")).toMatchObject({
			enabledModels: ["test/model"],
			defaultSandbox: "legacy-vm",
		});
	});
});
