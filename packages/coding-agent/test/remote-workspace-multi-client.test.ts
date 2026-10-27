import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRemoteToolOperations, DeferredRemoteToolOperations } from "../src/core/tools/operations.ts";
import { WorkspaceToolHost } from "../src/core/tools/workspace-tool-host.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";

it("keeps both clients usable after a rejected attachment and a peer disconnect", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "grip-multi-client-"));
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => reservation.once("listening", resolve));
	const address = reservation.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	await new Promise<void>((resolve) => reservation.close(() => resolve()));
	const token = Buffer.alloc(32, 8).toString("base64");
	const command = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-cwd",
			workspace,
			"--daemon-port",
			String(address.port),
			"--daemon-allow-root",
			"--daemon-allow-insecure-transport",
			"--daemon-allow-process-exec",
			"--daemon-allow-full-filesystem",
		],
		{ GRIP_DAEMON_TOKEN: token },
		workspace,
	);
	if (!command.configuration) throw new Error("Missing daemon configuration");
	const server = createDaemonServer(command.configuration);
	const clients: DeferredRemoteToolOperations[] = [];
	try {
		const endpoint = await server.listen();
		const firstProject = join(workspace, "grip");
		const project = join(workspace, "web");
		await mkdir(firstProject);
		await mkdir(project);
		await writeFile(join(firstProject, "sample.txt"), "still connected\n");
		await writeFile(join(project, "sample.txt"), "child connected\n");
		for (const selectedRoot of [firstProject, project]) {
			const client = new DeferredRemoteToolOperations(selectedRoot);
			clients.push(client);
			if (selectedRoot !== workspace) {
				await expect(client.configureRemote(endpoint.url, { token, expectedCwd: selectedRoot })).rejects.toThrow(
					"workspace root mismatch",
				);
			}
			await client.configureRemote(endpoint.url, {
				token,
				expectedCwd: selectedRoot,
				hostWorkspaceRoot: selectedRoot,
			});
			expect(client.getBackendInfo()).toMatchObject({ cwd: selectedRoot, workspace: { root: selectedRoot } });
		}
		const outside = new DeferredRemoteToolOperations(tmpdir());
		try {
			await expect(
				outside.configureRemote(endpoint.url, { token, expectedCwd: tmpdir(), hostWorkspaceRoot: tmpdir() }),
			).rejects.toThrow("workspace root mismatch");
		} finally {
			await outside.dispose();
		}
		expect(await clients[1]!.mapWorkspaceDirectoryToHost(project)).toBe(project);
		await symlink(workspace, join(project, "escape"));
		await expect(clients[1]!.mapWorkspaceDirectoryToHost(join(project, "escape"))).rejects.toThrow(
			"outside the mounted workspace",
		);
		let output = "";
		await clients[1]!.exec("pwd", {
			onData: (data) => {
				output += data.toString();
			},
		});
		expect(output.trim()).toBe(project);
		await expect(createRemoteToolOperations(endpoint.url, { token: "wrong-token" })).rejects.toThrow();
		const hosts = clients.map((operations) => new WorkspaceToolHost({ cwd: operations.cwd, operations }));
		const results = await Promise.all(
			hosts.map((host) => host.execute("read", { toolCallId: "same-id", arguments: { path: "sample.txt" } })),
		);
		for (const [index, result] of results.entries()) {
			expect(result.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining(index === 0 ? "still connected" : "child connected"),
					}),
				]),
			);
		}
		await clients[1]!.dispose();
		await expect(
			hosts[0]!.execute("read", { toolCallId: "after-peer-close", arguments: { path: "sample.txt" } }),
		).resolves.toMatchObject({
			content: expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("still connected") }),
			]),
		});
	} finally {
		await Promise.all(clients.map((client) => client.dispose()));
		await server.close();
		await rm(workspace, { recursive: true, force: true });
	}
});
