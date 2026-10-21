import { Box } from "@greppleai/grip-tui";

/** Message card with internal padding but no full-width background or trailing spaces. */
export class MessageCard extends Box {
	override render(width: number): string[] {
		return super.render(width).map((line) => line.trimEnd());
	}
}
