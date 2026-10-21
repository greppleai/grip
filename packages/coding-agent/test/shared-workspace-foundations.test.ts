import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS } from "../src/core/remote-workspace-protocol/contract.ts";
import {
	parseSharedWorkspaceClientEnvelope,
	parseSharedWorkspaceClientFrame,
	parseSharedWorkspaceServerFrame,
} from "../src/core/remote-workspace-protocol/shared-transport.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { SharedWorkspaceRoots } from "../src/daemon/shared-roots.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("shared workspace root binding", () => {
	it("binds parent, existing siblings, newly created children and duplicate roots", async () => {
		const parent = await mkdtemp(join(tmpdir(), "grip-shared-"));
		dirs.push(parent);
		const roots = await SharedWorkspaceRoots.fromParent(parent);
		await mkdir(join(parent, "grip"));
		expect(await roots.bind(parent)).toBe(parent);
		expect(await roots.bind(join(parent, "grip"))).toBe(join(parent, "grip"));
		await mkdir(join(parent, "grepple"));
		expect(await roots.bind(join(parent, "grepple"))).toBe(join(parent, "grepple"));
		expect(await roots.bind(join(parent, "grip"))).toBe(join(parent, "grip"));
	});

	it("rejects outside paths, symlink escapes, non-directories and nonexistent roots", async () => {
		const parent = await mkdtemp(join(tmpdir(), "grip-shared-"));
		const outside = await mkdtemp(join(tmpdir(), "grip-outside-"));
		dirs.push(parent, outside);
		const roots = await SharedWorkspaceRoots.fromParent(parent);
		await symlink(outside, join(parent, "escape"), "dir");
		await writeFile(join(parent, "file"), "hi");
		for (const path of [
			outside,
			join(parent, "escape"),
			join(parent, "file"),
			join(parent, "absent"),
			"relative/path",
			`${parent}\0bad`,
		]) {
			await expect(roots.bind(path)).rejects.toThrow();
		}
	});
});

describe("shared daemon parent configuration", () => {
	it("is opt-in, requires an existing canonical parent matching daemon cwd", async () => {
		const parent = await mkdtemp(join(tmpdir(), "grip-shared-config-"));
		dirs.push(parent);
		const args = ["--daemon", "--daemon-allow-root", "--daemon-cwd", parent];
		const plain = await parseDaemonCommand(args, {}, parent);
		expect(plain.configuration?.sharedParentRoot).toBeUndefined();
		const shared = await parseDaemonCommand([...args, "--daemon-shared-parent", parent], {}, parent);
		expect(shared.configuration?.sharedParentRoot).toBe(parent);
		expect(shared.configuration?.workspaceRoot).toBe(parent);
		await mkdir(join(parent, "child"));
		await expect(
			parseDaemonCommand([...args, "--daemon-shared-parent", join(parent, "child")], {}, parent),
		).rejects.toThrow("must equal");
		await expect(
			parseDaemonCommand([...args, "--daemon-shared-parent", join(parent, "missing")], {}, parent),
		).rejects.toThrow("existing directory");
		await expect(parseDaemonCommand(args, { GRIP_DAEMON_SHARED_PARENT: "" }, parent)).rejects.toThrow(
			"must not be empty",
		);
	});
});

describe("v2 frame contract", () => {
	const limits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS;
	const channelId = "0123456789abcdef01234567";
	it("accepts controls and a strictly validated inner v1 message", () => {
		expect(
			parseSharedWorkspaceClientFrame(JSON.stringify({ type: "hello", id: "a", version: 2 }), limits),
		).toMatchObject({ type: "hello" });
		expect(
			parseSharedWorkspaceClientFrame(JSON.stringify({ type: "open", id: "b", root: "/workspace/grip" }), limits),
		).toMatchObject({ type: "open" });
		expect(
			parseSharedWorkspaceClientFrame(
				JSON.stringify({ type: "channel", channelId, payload: { type: "cancel", id: "req" } }),
				limits,
			),
		).toMatchObject({ type: "channel" });
		expect(parseSharedWorkspaceServerFrame(JSON.stringify({ type: "closed", channelId }), limits)).toMatchObject({
			type: "closed",
		});
		expect(
			parseSharedWorkspaceServerFrame(
				JSON.stringify({
					type: "closed",
					channelId,
					reason: { code: "protocol_error", message: "Unknown request ID" },
				}),
				limits,
			),
		).toMatchObject({
			type: "closed",
			reason: { code: "protocol_error" },
		});
		expect(() =>
			parseSharedWorkspaceServerFrame(
				JSON.stringify({ type: "closed", channelId, reason: { code: "invented", message: "bad" } }),
				limits,
			),
		).toThrow();
	});

	it("defers inner validation only for a valid outer channel envelope", () => {
		const malformedInner = JSON.stringify({ type: "channel", channelId, payload: { type: "unknown" } });
		expect(parseSharedWorkspaceClientEnvelope(malformedInner, limits)).toMatchObject({ type: "channel", channelId });
		expect(() => parseSharedWorkspaceClientFrame(malformedInner, limits)).toThrow();
		for (const frame of [
			{ type: "cancel", id: "req" },
			{ type: "channel", channelId, payload: null, extra: true },
		]) {
			expect(() => parseSharedWorkspaceClientEnvelope(JSON.stringify(frame), limits)).toThrow();
		}
	});

	it("rejects v1 frames, unknown controls, extra fields and malformed inner payloads", () => {
		for (const frame of [
			{ type: "cancel", id: "req" },
			{ type: "hello", id: "a", version: 1 },
			{ type: "hello", id: "a", version: 2, token: "secret" },
			{ type: "channel", channelId, payload: { type: "cancel", id: "req", forged: true } },
			{ type: "channel", channelId, payload: { type: "unknown" } },
		])
			expect(() => parseSharedWorkspaceClientFrame(JSON.stringify(frame), limits)).toThrow();
	});
});
