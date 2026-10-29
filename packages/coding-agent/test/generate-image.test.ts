import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createGenerateImageToolDefinition } from "../src/core/tools/generate-image.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";

const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.x`;
const ctx = undefined as unknown as ExtensionContext;
const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("generate_image", () => {
	it("uses the selected image model at execution time", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] })),
			);
		vi.stubGlobal("fetch", fetchMock);
		const cwd = await mkdtemp(join(tmpdir(), "grip-image-"));
		directories.push(cwd);
		let model = "first-image";
		const tool = createGenerateImageToolDefinition(
			() => new LocalToolOperations(cwd),
			async () => token,
			() => model,
		);
		model = "second-image";
		await tool.execute("id", { prompt: "cat" }, undefined, undefined, ctx);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("second-image");
	});
	it("uses the Codex Images endpoint and writes the image locally", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "grip-image-"));
		directories.push(cwd);
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from("image").toString("base64") }] })),
			);
		vi.stubGlobal("fetch", fetchMock);
		const tool = createGenerateImageToolDefinition(
			() => new LocalToolOperations(cwd),
			async () => token,
		);
		const result = await tool.execute(
			"id",
			{ prompt: "a cat", outputPath: "out/cat.png" },
			undefined,
			undefined,
			ctx,
		);
		expect(await readFile(join(cwd, "out/cat.png"), "utf8")).toBe("image");
		expect(result.content[1]?.type).toBe("image");
		expect(fetchMock.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(fetchMock.mock.calls[0][1].headers["chatgpt-account-id"]).toBe("account");
		expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(`Bearer ${token}`);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			model: "gpt-image-2",
			prompt: "a cat",
			size: "auto",
			quality: "auto",
		});
	});
	it("saves remote images using the workspace path flavor and operations", async () => {
		for (const [cwd, pathFlavor, outputPath, savedPath, parent] of [
			["/remote/work", "posix", "../images/cat.png", "/remote/images/cat.png", "/remote/images"],
			["C:\\work", "windows", "images\\cat.png", "C:\\work\\images\\cat.png", "C:\\work\\images"],
		] as const) {
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValue(
						new Response(
							JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from("image").toString("base64") }] }),
						),
					),
			);
			const ops = new LocalToolOperations(cwd);
			vi.spyOn(ops, "getBackendInfo").mockReturnValue({
				type: "remote",
				cwd,
				configured: true,
				url: "ws://remote",
				protocol: "ws",
				workspace: { id: "remote", root: cwd, pathFlavor },
			});
			const mkdir = vi.spyOn(ops, "mkdir").mockResolvedValue();
			const write = vi.spyOn(ops, "writeFile").mockResolvedValue();
			const tool = createGenerateImageToolDefinition(
				() => ops,
				async () => token,
			);
			const result = await tool.execute("id", { prompt: "cat", outputPath }, undefined, undefined, ctx);
			expect(mkdir).toHaveBeenCalledWith(parent, { recursive: true });
			expect(write).toHaveBeenCalledWith(savedPath, Buffer.from("image"));
			expect(result.details?.savedPath).toBe(savedPath);
		}
	});
	it("propagates remote filesystem errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(
					async () =>
						new Response(
							JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from("image").toString("base64") }] }),
						),
				),
		);
		const ops = new LocalToolOperations("/remote/work");
		vi.spyOn(ops, "getBackendInfo").mockReturnValue({
			type: "remote",
			cwd: ops.cwd,
			configured: true,
			url: "ws://remote",
			protocol: "ws",
			workspace: { id: "remote", root: ops.cwd, pathFlavor: "posix" },
		});
		const mkdir = vi.spyOn(ops, "mkdir").mockResolvedValue();
		const write = vi.spyOn(ops, "writeFile").mockRejectedValue(new Error("remote write failed"));
		const tool = createGenerateImageToolDefinition(
			() => ops,
			async () => token,
		);
		await expect(
			tool.execute("id", { prompt: "cat", outputPath: "cat.png" }, undefined, undefined, ctx),
		).rejects.toThrow("remote write failed");
		mkdir.mockRejectedValue(new Error("remote mkdir failed"));
		write.mockClear();
		await expect(
			tool.execute("id", { prompt: "cat", outputPath: "cat.png" }, undefined, undefined, ctx),
		).rejects.toThrow("remote mkdir failed");
		expect(write).not.toHaveBeenCalled();
	});
	it("rejects HTTP errors, malformed JSON and missing or invalid image data", async () => {
		const ops = new LocalToolOperations(tmpdir());
		const write = vi.spyOn(ops, "writeFile");
		const tool = createGenerateImageToolDefinition(
			() => ops,
			async () => token,
		);
		for (const [response, message] of [
			[new Response("denied", { status: 403 }), "403"],
			[new Response("not json"), "invalid image response"],
			[new Response(JSON.stringify({ data: [] })), "no valid image data"],
			[new Response(JSON.stringify({ data: [{ b64_json: "!!!!" }] })), "no valid image data"],
		] as const) {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
			await expect(tool.execute("id", { prompt: "cat" }, undefined, undefined, ctx)).rejects.toThrow(message);
		}
		expect(write).not.toHaveBeenCalled();
	});
	it("rejects missing credentials and unconfigured remote workspaces without a request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const ops = new LocalToolOperations(tmpdir());
		const tool = createGenerateImageToolDefinition(
			() => ops,
			async () => undefined,
		);
		await expect(tool.execute("id", { prompt: "cat" }, undefined, undefined, ctx)).rejects.toThrow(
			"OAuth credentials",
		);
		vi.spyOn(ops, "getBackendInfo").mockReturnValue({ type: "remote", cwd: "/work", configured: false });
		await expect(tool.execute("id", { prompt: "cat" }, undefined, undefined, ctx)).rejects.toThrow(
			"Remote backend is not configured",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
