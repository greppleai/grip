import { compare, prerelease } from "semver";
import { type OfficialManifest, type OfficialRelease, selectOfficialRelease } from "./official-catalog.ts";
import type { OfficialCatalogResult } from "./official-installer.ts";

/** Discovery metadata only: browsing never grants installation or removal ownership. */
export interface OfficialCatalogItem {
	id: string;
	manifest: OfficialManifest | null;
	compatibleVersion: string | null;
	unavailableReason: string | null;
}

export interface OfficialCatalogView extends Omit<OfficialCatalogResult, "catalog"> {
	extensions: OfficialCatalogItem[];
	offline: boolean;
}

interface OfficialCatalogViewInput {
	result: OfficialCatalogResult;
	gripVersion: string;
	offline: boolean;
}

/** Retain unavailable entries, but never advertise prereleases as installable. */
export function describeOfficialCatalog(input: OfficialCatalogViewInput): OfficialCatalogView {
	const extensions = input.result.catalog.extensions.map((entry): OfficialCatalogItem => {
		const compatible = selectOfficialRelease(entry, input.gripVersion);
		const latestStable = entry.releases.reduce<OfficialRelease | null>((latest, release) => {
			if (prerelease(release.manifest.version) !== null) return latest;
			return latest === null || compare(release.manifest.version, latest.manifest.version) > 0 ? release : latest;
		}, null);
		const manifest = compatible?.manifest ?? latestStable?.manifest ?? null;
		let unavailableReason: string | null = null;
		if (!compatible) {
			unavailableReason = latestStable
				? `No compatible stable release for Grip ${input.gripVersion}.`
				: "No published stable release is available.";
		}
		return {
			id: entry.id,
			manifest: manifest ? structuredClone(manifest) : null,
			compatibleVersion: compatible?.manifest.version ?? null,
			unavailableReason,
		};
	});
	return {
		extensions,
		fetchedAt: input.result.fetchedAt,
		stale: input.result.stale,
		error: input.result.error,
		offline: input.offline,
	};
}
