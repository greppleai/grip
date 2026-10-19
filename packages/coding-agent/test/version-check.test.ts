import { afterEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import {
	checkForNewGripVersion,
	comparePackageVersions,
	getLatestGripRelease,
	getLatestGripVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.GRIP_SKIP_VERSION_CHECK;
const originalOffline = process.env.GRIP_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.GRIP_SKIP_VERSION_CHECK;
	} else {
		process.env.GRIP_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.GRIP_OFFLINE;
	} else {
		process.env.GRIP_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ "dist-tags": { latest: "1.2.3" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewGripVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewGripVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the npm package metadata api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ "dist-tags": { latest: "1.2.4" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestGripVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`https://registry.npmjs.org/${PACKAGE_NAME.replace("/", "%2f")}`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("ignores package redirects in npm metadata", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ "dist-tags": { latest: "1.2.4" }, packageName: "@unrelated/foreign-package" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestGripRelease("1.2.3")).resolves.toEqual({ version: "1.2.4" });
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ "dist-tags": { latest: "1.2.4" }, note: " **Read this** " }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestGripRelease("1.2.3")).resolves.toEqual({
			note: "**Read this**",
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.GRIP_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestGripVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
