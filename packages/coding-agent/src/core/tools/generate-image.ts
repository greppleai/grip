import { randomUUID } from "node:crypto";
import { dirname, posix, resolve, win32 } from "node:path";
import { Text } from "@greppleai/grip-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import type { ToolBackendInfo, ToolOperations } from "./operations.ts";

const schema = Type.Object({
	prompt: Type.String({ description: "Description of the image to generate" }),
	outputPath: Type.Optional(Type.String({ description: "Output PNG path, relative to the workspace" })),
	size: Type.Optional(
		Type.Union([
			Type.Literal("auto"),
			Type.Literal("1024x1024"),
			Type.Literal("1536x1024"),
			Type.Literal("1024x1536"),
		]),
	),
	quality: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
	),
});

type Input = Static<typeof schema>;
interface Details {
	savedPath: string;
}
interface Account {
	chatgpt_account_id?: string;
}
interface Claims {
	"https://api.openai.com/auth"?: Account;
}
interface ImageData {
	b64_json?: unknown;
}
interface ImageResponse {
	data?: ImageData[];
}
function accountIdFromToken(token: string): string {
	let accountId: string | undefined;
	try {
		const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Claims;
		accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		/* reported below */
	}
	if (!accountId) throw new Error("Could not find chatgpt_account_id in Codex OAuth token.");
	return accountId;
}

async function readImage(response: Response): Promise<string> {
	let payload: ImageResponse;
	try {
		payload = (await response.json()) as ImageResponse;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new Error("Codex returned an invalid image response.");
	}
	const image = Array.isArray(payload?.data) ? payload.data[0]?.b64_json : undefined;
	if (
		typeof image !== "string" ||
		!image ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image)
	)
		throw new Error("Codex returned no valid image data.");
	return image;
}

async function saveImage(ops: ToolOperations, backend: ToolBackendInfo | undefined, outputPath: string, image: string) {
	const paths =
		backend?.type === "remote" && backend.configured
			? backend.workspace.pathFlavor === "windows"
				? win32
				: posix
			: undefined;
	const savedPath = paths ? paths.resolve(ops.cwd, outputPath) : resolve(ops.cwd, outputPath);
	const save = async () => {
		await ops.mkdir(paths ? paths.dirname(savedPath) : dirname(savedPath), { recursive: true });
		await ops.writeFile(savedPath, Buffer.from(image, "base64"));
	};
	if (backend?.type === "remote") await save();
	else await withFileMutationQueue(savedPath, save);
	return savedPath;
}

export function createGenerateImageToolDefinition(
	getOperations: () => ToolOperations,
	getToken: () => Promise<string | undefined>,
	getModel: () => string | undefined = () => undefined,
): ToolDefinition<typeof schema, Details> {
	return {
		name: "generate_image",
		label: "Generate image",
		description: "Generate an image using OpenAI Codex OAuth and save a PNG to the workspace.",
		promptSnippet: "Generate an image and save it to the workspace",
		parameters: schema,
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("generate_image"));
			if (typeof args?.prompt === "string") content += `\n${theme.fg("accent", args.prompt)}`;
			for (const key of ["outputPath", "size", "quality"] as const) {
				if (typeof args?.[key] === "string") content += `\n${theme.fg("muted", `${key}: ${args[key]}`)}`;
			}
			text.setText(content);
			return text;
		},
		async execute(_id, args: Input, signal) {
			const ops = getOperations();
			const backend = ops.getBackendInfo?.();
			if (backend?.type === "remote" && !backend.configured)
				throw new Error(
					"Remote backend is not configured. Configure it over RPC or with /sandbox before using tools.",
				);
			if (!args.prompt.trim()) throw new Error("prompt is required");
			const token = await getToken();
			if (!token) throw new Error("OpenAI Codex OAuth credentials required. Run /login and select OpenAI Codex.");
			const accountId = accountIdFromToken(token);
			const response = await fetch("https://chatgpt.com/backend-api/codex/images/generations", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"chatgpt-account-id": accountId,
					originator: "grip",
					accept: "application/json",
					"content-type": "application/json",
					"x-codex-image-turn-id": randomUUID(),
				},
				body: JSON.stringify({
					model: getModel() ?? "gpt-image-2",
					prompt: args.prompt,
					size: args.size ?? "auto",
					quality: args.quality ?? "auto",
				}),
				signal,
			});
			if (!response.ok) throw new Error(`Codex image request failed (${response.status}): ${await response.text()}`);
			const image = await readImage(response);
			if (signal?.aborted) throw new Error("Request was aborted");
			const savedPath = await saveImage(
				ops,
				backend,
				args.outputPath?.trim() || `generated-${randomUUID()}.png`,
				image,
			);
			return {
				content: [
					{ type: "text", text: `Generated image saved to ${savedPath}` },
					{ type: "image", data: image, mimeType: "image/png" },
				],
				details: { savedPath },
			};
		},
	};
}
