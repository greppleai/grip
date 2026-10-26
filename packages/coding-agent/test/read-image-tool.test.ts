import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultActiveToolNames } from "../src/core/agent-session.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import { WorkspaceToolHost } from "../src/core/tools/workspace-tool-host.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
	"base64",
);
const directories: string[] = [];

async function createWorkspace(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "read-image-tool-"));
	directories.push(cwd);
	return cwd;
}

async function executeImage(host: WorkspaceToolHost, path: string) {
	return await host.execute("read_image", {
		toolCallId: "read-image-test",
		arguments: { path },
	});
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("built-in read_image tool", () => {
	it("is available by default independently of the opt-in text read tool and returns image data", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "tiny.png");
		await writeFile(path, png);
		const host = new WorkspaceToolHost({
			cwd,
			toolNames: ["read_image"],
			tools: { read_image: { autoResizeImages: false } },
		});
		try {
			expect(getDefaultActiveToolNames()).toContain("read_image");
			expect(getDefaultActiveToolNames()).not.toContain("read");
			expect(host.getDefinition("read_image")).toBeDefined();
			expect(host.getDefinition("read")).toBeUndefined();
			const result = await executeImage(host, path);
			expect(result.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
		} finally {
			await host.dispose();
		}
	});

	it("rejects text files without returning their contents", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "secret.txt");
		await writeFile(path, "DO_NOT_EXPOSE_THIS_TEXT");
		const host = new WorkspaceToolHost({ cwd, toolNames: ["read_image"] });
		try {
			await expect(executeImage(host, path)).rejects.toThrow(/not a supported image file/i);
		} finally {
			await host.dispose();
		}
	});

	it("honors denied access and selects operations for the requested path", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "selected.png");
		const selectedOperations = new LocalToolOperations(cwd);
		const defaultOperations = new LocalToolOperations(cwd);
		defaultOperations.readFile = async () => {
			throw new Error("default must not be used");
		};
		selectedOperations.detectImageMimeType = async () => "image/png";
		selectedOperations.readFile = async () => png;
		await writeFile(path, "placeholder");
		const selectedPaths: string[] = [];
		const host = new WorkspaceToolHost({
			cwd,
			operations: defaultOperations,
			toolNames: ["read_image"],
			tools: {
				read_image: {
					autoResizeImages: false,
					operationsForPath: (selectedPath) => {
						selectedPaths.push(selectedPath);
						return selectedPath === path
							? { kind: "selection", operations: selectedOperations, path: selectedPath }
							: undefined;
					},
				},
			},
		});
		try {
			const result = await executeImage(host, path);
			expect(selectedPaths).toContain(path);
			expect(result.content).toContainEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
		} finally {
			await host.dispose();
		}

		const deniedOperations = new LocalToolOperations(cwd);
		deniedOperations.access = async () => {
			throw new Error("access denied");
		};
		deniedOperations.readFile = async () => {
			throw new Error("should not read file after denial");
		};
		const deniedHost = new WorkspaceToolHost({
			cwd,
			operations: deniedOperations,
			toolNames: ["read_image"],
		});
		try {
			await expect(executeImage(deniedHost, path)).rejects.toThrow("access denied");
		} finally {
			await deniedHost.dispose();
		}
	});

	it("inherits the read path selector in the workspace host when read_image options are omitted", async () => {
		const cwd = await createWorkspace();
		const path = join(cwd, "workspace.png");
		const routedOperations = new LocalToolOperations(cwd);
		routedOperations.detectImageMimeType = async () => "image/png";
		routedOperations.readFile = async () => png;
		await writeFile(path, "placeholder");
		const routedPaths: string[] = [];
		const host = new WorkspaceToolHost({
			cwd,
			toolNames: ["read_image"],
			tools: {
				read: {
					autoResizeImages: false,
					operationsForPath: (selectedPath) => {
						routedPaths.push(selectedPath);
						return { kind: "selection", operations: routedOperations, path: selectedPath };
					},
				},
			},
		});
		try {
			await executeImage(host, path);
			expect(routedPaths).toContain(path);
		} finally {
			await host.dispose();
		}
	});
});
