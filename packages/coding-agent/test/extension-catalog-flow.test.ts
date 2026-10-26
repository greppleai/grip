import { describe, expect, it, vi } from "vitest";
import { OFFICIAL_EXTENSIONS, type OfficialExtension } from "../src/core/official-extensions.ts";
import type { ConfiguredPackage, PackageScopeOptions } from "../src/core/package-manager.ts";
import type { ExtensionCatalogChoice } from "../src/modes/interactive/components/extension-catalog.ts";
import {
	type CatalogTerminalHost,
	type ExtensionCatalogHost,
	OfficialExtensionCatalog,
	runCatalogPackageOperation,
} from "../src/modes/interactive/extension-catalog.ts";

const pin = "1234567890abcdef1234567890abcdef12345678";
const source = `git:github.com/greppleai/planner@${pin}`;
const entry: OfficialExtension = {
	...OFFICIAL_EXTENSIONS[0],
	target: { source, revision: pin },
	unavailableReason: null,
};

function fixture(replies: (string | undefined)[]) {
	const configured: ConfiguredPackage[] = [];
	const install = vi.fn(async (target: string, options?: PackageScopeOptions) => {
		configured.splice(0, configured.length, {
			source: target,
			scope: options?.local ? "project" : "user",
			filtered: false,
		});
	});
	const remove = vi.fn(async () => {
		configured.splice(0);
		return true;
	});
	const choose = vi.fn(async (_title: string, _choices: readonly ExtensionCatalogChoice[]) => replies.shift());
	const notify = vi.fn();
	const reload = vi.fn(async () => {});
	const host: ExtensionCatalogHost = {
		packages: {
			listConfiguredPackages: () => configured,
			getInstalledPath: (_target, scope) => `/extension-host/${scope}/packages/planner`,
			installAndPersist: install,
			removeAndPersist: remove,
		},
		hostCwd: "/extension-host/workspace",
		settingsPath: (scope) => `/extension-host/${scope}/settings.json`,
		runtimeOwners: () => [],
		choose,
		notify,
		reload,
		isIdle: () => true,
		projectAvailable: () => true,
		contextKey: () => "session:/extension-host/workspace",
		configurationKey: () => JSON.stringify(configured),
		runOperation: async (operation) => operation(),
	};
	return {
		host,
		configured,
		install,
		remove,
		choose,
		notify,
		reload,
		catalog: new OfficialExtensionCatalog(host, [entry]),
	};
}

describe("interactive extension catalog flow", () => {
	it.each([[], ["planner", "back"], ["planner", "install", "cancel"], ["planner", "install", "user", "cancel"]])(
		"cancels without mutation at any dialog: %j",
		async (...replyValues) => {
			const f = fixture(replyValues);
			await f.catalog.show();
			expect(f.install).not.toHaveBeenCalled();
			expect(f.remove).not.toHaveBeenCalled();
			expect(f.reload).not.toHaveBeenCalled();
		},
	);

	it("keeps an unavailable entry browsable without offering installation", async () => {
		const f = fixture(["planner", "install"]);
		const unavailable: OfficialExtension = { ...entry, target: null, unavailableReason: "Release not yet available" };
		await new OfficialExtensionCatalog(f.host, [unavailable]).show();
		const choices = f.choose.mock.calls[1][1];
		expect(choices.map((choice) => choice.value)).toEqual(["back"]);
		expect(choices[0].details.join("\n")).toContain("not yet available");
		expect(f.install).not.toHaveBeenCalled();
	});

	it("uses the shipped exact Git subdirectory target only after explicit scope and consent", async () => {
		const f = fixture(["planner", "install", "user", "proceed", "later"]);
		await new OfficialExtensionCatalog(f.host).show();
		expect(f.install).toHaveBeenCalledExactlyOnceWith(OFFICIAL_EXTENSIONS[0].target?.source, { local: false });
		expect(f.choose.mock.calls[3][1][0].details.join("\n")).toContain("lifecycle scripts are skipped");
	});

	it.each(["user", "project"])("requires explicit %s scope and default-cancel script consent", async (scope) => {
		const f = fixture(["planner", "install", scope, "proceed", "later"]);
		await f.catalog.show();
		expect(f.install).toHaveBeenCalledExactlyOnceWith(source, { local: scope === "project" });
		const scopeChoices = f.choose.mock.calls[2][1];
		expect(scopeChoices[0].value).toBe("cancel");
		const confirmation = f.choose.mock.calls[3][1];
		expect(confirmation[0].value).toBe("cancel");
		const details = confirmation[0].details.join("\n");
		expect(details).toContain(source);
		expect(details).toContain(`/extension-host/${scope}/settings.json`);
		expect(details).toContain(`/extension-host/${scope}/packages/planner`);
		expect(details).toContain("Host project: /extension-host/workspace");
		expect(details).toContain("lifecycle scripts");
		expect(details).toContain("full host access");
		expect(details).toContain("cannot be cancelled or rolled back");
		expect(f.reload).not.toHaveBeenCalled();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("unchanged until you reload"), false);
	});

	it("does not offer unavailable host project scope or accept a stale project choice", async () => {
		const f = fixture(["planner", "install", "project", "proceed"]);
		f.host.projectAvailable = () => false;
		await f.catalog.show();
		expect(f.choose.mock.calls[2][1].map((choice) => choice.value)).toEqual(["cancel", "user"]);
		expect(f.install).not.toHaveBeenCalled();
	});

	it("upgrades only the existing scope and offers removal of an unavailable configured package", async () => {
		const f = fixture(["planner", "upgrade", "proceed", "later"]);
		f.configured.push({ source: "git:github.com/greppleai/planner@old", scope: "project", filtered: true });
		await f.catalog.show();
		expect(f.install).toHaveBeenCalledExactlyOnceWith(source, { local: true });
		expect(f.choose.mock.calls[2][0]).toContain("Confirm upgrade");
		const removal = fixture(["planner", "remove", "proceed", "later"]);
		removal.configured.push({ source: "npm:@greppleai/planner", scope: "user", filtered: false });
		await new OfficialExtensionCatalog(removal.host).show();
		expect(removal.remove).toHaveBeenCalledExactlyOnceWith("npm:@greppleai/planner", { local: false });
		expect(removal.install).not.toHaveBeenCalled();
		expect(removal.choose.mock.calls[2][1][0].details.join("\n")).toContain(".planner data are preserved");
	});

	it("blocks unknown loaded owners, including registrations not active as tools", async () => {
		const f = fixture(["planner", "back"]);
		f.host.runtimeOwners = () => [
			{ path: "<factory>", source: "local", scope: "temporary", commands: [], tools: ["planner_done"] },
		];
		await f.catalog.show();
		expect(f.choose.mock.calls[1][1].map((choice) => choice.value)).toEqual(["back"]);
		expect(f.choose.mock.calls[1][1][0].details.join("\n")).toContain("unknown runtime");
		expect(f.install).not.toHaveBeenCalled();
	});

	it("reports partial failure, refreshes state and never retries or reloads automatically", async () => {
		const f = fixture(["planner", "install", "user", "proceed"]);
		f.install.mockImplementationOnce(async (target) => {
			f.configured.push({ source: target, scope: "user", filtered: false });
			throw new Error("settings persistence failed after installing files");
		});
		await f.catalog.show();
		expect(f.install).toHaveBeenCalledOnce();
		expect(f.reload).not.toHaveBeenCalled();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("may already have changed"), true);
		expect(f.choose.mock.calls[4][1][0].label).toContain("configured / missing");
	});

	it.each(["later", undefined])("defers reload when the user chooses %s", async (reloadChoice) => {
		const f = fixture(["planner", "install", "user", "proceed", reloadChoice]);
		await f.catalog.show();
		expect(f.reload).not.toHaveBeenCalled();
		expect(f.choose.mock.calls[4][1][0].value).toBe("later");
	});

	it("reloads only on explicit request without claiming that a caught internal reload error succeeded", async () => {
		const f = fixture(["planner", "install", "user", "proceed", "now"]);
		await f.catalog.show();
		expect(f.reload).toHaveBeenCalledOnce();
		expect(f.notify).toHaveBeenCalledTimes(1);
		expect(f.notify.mock.calls[0][0]).not.toContain("reloaded");
	});

	it("keeps package success separate from a thrown reload failure", async () => {
		const f = fixture(["planner", "install", "user", "proceed", "now"]);
		f.reload.mockRejectedValueOnce(new Error("resource loading failed"));
		await f.catalog.show();
		expect(f.install).toHaveBeenCalledOnce();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("changes remain in place; reload failed"), true);
		expect(f.remove).not.toHaveBeenCalled();
	});

	it.each(["activity", "context", "settings", "ownership"])(
		"revalidates %s before explicit reload",
		async (change) => {
			const f = fixture(["planner", "install", "user", "proceed"]);
			f.choose.mockImplementation(async (title) => {
				if (title !== "Reload resources?")
					return ["planner", "install", "user", "proceed"][f.choose.mock.calls.length - 1];
				if (change === "activity") f.host.isIdle = () => false;
				if (change === "context") f.host.contextKey = () => "another session";
				if (change === "settings") f.host.configurationKey = () => "new resource filters";
				if (change === "ownership")
					f.host.runtimeOwners = () => [
						{ path: "<factory>", source: "local", scope: "temporary", commands: ["planner"], tools: [] },
					];
				return "now";
			});
			await f.catalog.show();
			expect(f.reload).not.toHaveBeenCalled();
			expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("reload was deferred"), true);
		},
	);

	it("serializes the whole dialog flow and releases its guard on cancellation", async () => {
		const f = fixture([]);
		let close: (value: string | undefined) => void = () => {
			throw new Error("not awaiting menu");
		};
		f.choose.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					close = resolve;
				}),
		);
		const pending = f.catalog.show();
		await f.catalog.show();
		expect(f.choose).toHaveBeenCalledOnce();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("already open"), true);
		close(undefined);
		await pending;
		await f.catalog.show();
		expect(f.choose).toHaveBeenCalledTimes(2);
	});
});

describe("catalog terminal handoff", () => {
	function terminal(): CatalogTerminalHost {
		return { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn(), isShuttingDown: () => false };
	}

	it("releases and restores terminal ownership around inherited output", async () => {
		const host = terminal();
		await runCatalogPackageOperation(host, async () => {
			expect(host.stop).toHaveBeenCalledOnce();
			expect(host.start).not.toHaveBeenCalled();
		});
		expect(host.start).toHaveBeenCalledOnce();
		expect(host.requestRender).toHaveBeenCalledOnce();
	});

	it("attempts terminal restoration if stopping it partially fails", async () => {
		const host = terminal();
		host.stop = () => {
			throw new Error("terminal stop failed");
		};
		const operation = vi.fn(async () => {});
		await expect(runCatalogPackageOperation(host, operation)).rejects.toThrow("terminal stop failed");
		expect(operation).not.toHaveBeenCalled();
		expect(host.start).toHaveBeenCalledOnce();
		expect(host.requestRender).toHaveBeenCalledOnce();
	});

	it("restores the terminal when package work fails", async () => {
		const host = terminal();
		await expect(
			runCatalogPackageOperation(host, async () => {
				throw new Error("installer failed");
			}),
		).rejects.toThrow("installer failed");
		expect(host.start).toHaveBeenCalledOnce();
		expect(host.requestRender).toHaveBeenCalledOnce();
	});

	it("never starts package work or the terminal when already shutting down", async () => {
		const host = terminal();
		host.isShuttingDown = () => true;
		const operation = vi.fn(async () => {});
		await expect(runCatalogPackageOperation(host, operation)).rejects.toThrow("shutting down");
		expect(operation).not.toHaveBeenCalled();
		expect(host.stop).not.toHaveBeenCalled();
		expect(host.start).not.toHaveBeenCalled();
	});

	it("does not resurrect the terminal if shutdown begins while package work is running", async () => {
		const host = terminal();
		await runCatalogPackageOperation(host, async () => {
			host.isShuttingDown = () => true;
		});
		expect(host.stop).toHaveBeenCalledOnce();
		expect(host.start).not.toHaveBeenCalled();
		expect(host.requestRender).not.toHaveBeenCalled();
	});
});
