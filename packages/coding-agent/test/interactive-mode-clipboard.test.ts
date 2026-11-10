import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LocalToolOperations, type ToolOperations } from "../src/core/tools/operations.ts";
import type { ClipboardImage } from "../src/utils/clipboard-image.ts";

const mocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<ClipboardImage | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
	getToolOperations: vi.fn<() => ToolOperations>(),
	showError: vi.fn<(message: string) => void>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(async () => {}),
	readClipboardText: mocks.readClipboardText,
}));

vi.mock("../src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: (mimeType: string) => (mimeType === "image/jpeg" ? "jpg" : "png"),
	readClipboardImage: mocks.readClipboardImage,
}));

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ClipboardPasteEditor {
	insertTextAtCursor: (text: string) => void;
}

interface ClipboardPasteUI {
	requestRender: () => void;
}

interface ClipboardPasteContext {
	editor: ClipboardPasteEditor;
	ui: ClipboardPasteUI;
	session: Pick<InteractiveMode["session"], "getToolOperations">;
	showError: (message: string) => void;
}

interface KeyHandlerEditor {
	onAction: (action: string, handler: () => void) => void;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onChange?: (text: string) => void;
	onPasteImage?: () => void;
}

interface KeyHandlerUI {
	onDebug?: () => void;
}

interface SetupKeyHandlersContext {
	defaultEditor: KeyHandlerEditor;
	ui: KeyHandlerUI;
	handleClipboardPaste: () => Promise<void>;
}

type InteractiveModePrivate = {
	handleClipboardPaste(this: ClipboardPasteContext): Promise<void>;
	setupKeyHandlers(this: SetupKeyHandlersContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

describe("InteractiveMode clipboard paste", () => {
	beforeEach(() => {
		mocks.readClipboardImage.mockReset();
		mocks.readClipboardText.mockReset();
		mocks.getToolOperations.mockReset().mockReturnValue(new LocalToolOperations(process.cwd()));
		mocks.showError.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("wires the clipboard shortcut callback to the async paste handler", () => {
		const handleClipboardPaste = vi.fn(async () => {});
		const context: SetupKeyHandlersContext = {
			defaultEditor: { onAction: vi.fn() },
			ui: {},
			handleClipboardPaste,
		};
		interactiveModePrototype.setupKeyHandlers.call(context);

		context.defaultEditor.onPasteImage?.();

		expect(handleClipboardPaste).toHaveBeenCalledOnce();
	});

	test("pastes clipboard text when no image is available", async () => {
		mocks.readClipboardImage.mockResolvedValue(null);
		mocks.readClipboardText.mockResolvedValue("first line\nsecond line");
		const insertTextAtCursor = vi.fn<(text: string) => void>();
		const requestRender = vi.fn<() => void>();
		const context: ClipboardPasteContext = {
			editor: { insertTextAtCursor },
			ui: { requestRender },
			session: { getToolOperations: mocks.getToolOperations },
			showError: mocks.showError,
		};

		await interactiveModePrototype.handleClipboardPaste.call(context);

		expect(mocks.readClipboardImage).toHaveBeenCalledOnce();
		expect(mocks.readClipboardText).toHaveBeenCalledOnce();
		expect(insertTextAtCursor).toHaveBeenCalledWith("first line\nsecond line");
		expect(requestRender).toHaveBeenCalledOnce();
	});

	test("keeps image paste ahead of the text fallback", async () => {
		mocks.readClipboardImage.mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/jpeg" });
		mocks.readClipboardText.mockResolvedValue("clipboard text");
		const insertTextAtCursor = vi.fn<(text: string) => void>();
		const requestRender = vi.fn<() => void>();
		const context: ClipboardPasteContext = {
			editor: { insertTextAtCursor },
			ui: { requestRender },
			session: { getToolOperations: mocks.getToolOperations },
			showError: mocks.showError,
		};

		await interactiveModePrototype.handleClipboardPaste.call(context);

		expect(mocks.readClipboardText).not.toHaveBeenCalled();
		expect(insertTextAtCursor).toHaveBeenCalledOnce();
		const imagePath = insertTextAtCursor.mock.calls[0]?.[0];
		expect(imagePath).toMatch(/grip-clipboard-[0-9a-f-]+\.jpg$/);
		if (!imagePath) {
			throw new Error("Expected an inserted clipboard image path");
		}
		try {
			expect(Array.from(readFileSync(imagePath))).toEqual([1, 2, 3]);
		} finally {
			rmSync(imagePath, { force: true });
		}
		expect(requestRender).toHaveBeenCalledOnce();
	});

	test("does not modify or render the editor for an empty clipboard", async () => {
		mocks.readClipboardImage.mockResolvedValue(null);
		mocks.readClipboardText.mockResolvedValue(null);
		const insertTextAtCursor = vi.fn<(text: string) => void>();
		const requestRender = vi.fn<() => void>();
		const context: ClipboardPasteContext = {
			editor: { insertTextAtCursor },
			ui: { requestRender },
			session: { getToolOperations: mocks.getToolOperations },
			showError: mocks.showError,
		};

		await interactiveModePrototype.handleClipboardPaste.call(context);

		expect(insertTextAtCursor).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});
	test.each([
		["/workspace/project", "/workspace/project/.grip/clipboard/", "posix"],
		["C:\\workspace\\project", "C:\\workspace\\project\\.grip\\clipboard\\", "windows"],
	] as const)("saves image bytes in the remote workspace at %s", async (cwd, prefix, pathFlavor) => {
		mocks.readClipboardImage.mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" });
		const operations = new LocalToolOperations(cwd);
		vi.spyOn(operations, "getBackendInfo").mockReturnValue({
			type: "remote",
			cwd,
			configured: true,
			url: "ws://localhost:8787/grip/workspace",
			protocol: "ws",
			workspace: { id: "test", root: cwd, pathFlavor },
		});
		const mkdir = vi.spyOn(operations, "mkdir").mockResolvedValue();
		const writeFile = vi.spyOn(operations, "writeFile").mockResolvedValue();
		mocks.getToolOperations.mockReturnValue(operations);
		const insertTextAtCursor = vi.fn<(text: string) => void>();
		const requestRender = vi.fn<() => void>();
		const context: ClipboardPasteContext = {
			editor: { insertTextAtCursor },
			ui: { requestRender },
			session: { getToolOperations: mocks.getToolOperations },
			showError: mocks.showError,
		};

		await interactiveModePrototype.handleClipboardPaste.call(context);

		const imagePath = insertTextAtCursor.mock.calls[0]?.[0];
		expect(imagePath?.startsWith(prefix)).toBe(true);
		expect(imagePath).toMatch(/grip-clipboard-[0-9a-f-]+\.png$/);
		expect(mkdir).toHaveBeenCalledWith(prefix.slice(0, -1), { recursive: true });
		expect(writeFile).toHaveBeenCalledWith(imagePath, Buffer.from([1, 2, 3]));
		expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(insertTextAtCursor.mock.invocationCallOrder[0] ?? 0);
		expect(requestRender).toHaveBeenCalledOnce();
		expect(mocks.readClipboardText).not.toHaveBeenCalled();
		expect(mocks.showError).not.toHaveBeenCalled();
	});

	test.each(["mkdir", "writeFile"] as const)(
		"reports remote %s failure without inserting a host path",
		async (operation) => {
			mocks.readClipboardImage.mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), mimeType: "image/png" });
			const operations = new LocalToolOperations("/workspace");
			vi.spyOn(operations, "getBackendInfo").mockReturnValue({
				type: "remote",
				cwd: "/workspace",
				configured: false,
			});
			const mkdir = vi.spyOn(operations, "mkdir").mockResolvedValue();
			const writeFile = vi.spyOn(operations, "writeFile").mockResolvedValue();
			if (operation === "mkdir") mkdir.mockRejectedValue(new Error("backend unavailable"));
			else writeFile.mockRejectedValue(new Error("backend unavailable"));
			mocks.getToolOperations.mockReturnValue(operations);
			const insertTextAtCursor = vi.fn<(text: string) => void>();
			const requestRender = vi.fn<() => void>();
			const context: ClipboardPasteContext = {
				editor: { insertTextAtCursor },
				ui: { requestRender },
				session: { getToolOperations: mocks.getToolOperations },
				showError: mocks.showError,
			};

			await interactiveModePrototype.handleClipboardPaste.call(context);

			expect(insertTextAtCursor).not.toHaveBeenCalled();
			expect(requestRender).not.toHaveBeenCalled();
			expect(mocks.readClipboardText).not.toHaveBeenCalled();
			expect(mocks.showError).toHaveBeenCalledWith("Failed to save clipboard image: backend unavailable");
			if (operation === "mkdir") expect(writeFile).not.toHaveBeenCalled();
		},
	);
});
