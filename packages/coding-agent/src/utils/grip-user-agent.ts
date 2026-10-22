export function getGripUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `grip/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
