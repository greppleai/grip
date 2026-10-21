import { Box } from "@greppleai/grip-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";

/** Message card with internal padding, an optional one-cell stripe, and no trailing spaces. */
export class MessageCard extends Box {
	private readonly stripeColor?: ThemeColor;

	constructor(paddingX: number, paddingY: number, stripeColor?: ThemeColor) {
		super(paddingX, paddingY);
		this.stripeColor = stripeColor;
	}

	override render(width: number): string[] {
		if (!this.stripeColor) return super.render(width).map((line) => line.trimEnd());
		if (width < 1) return [];

		const marker = theme.bgFromFg(this.stripeColor, " ");
		return super.render(Math.max(1, width - 2)).map((line) => {
			if (width <= 2) return marker;
			const content = line.trimEnd();
			return content ? `${marker} ${content}` : marker;
		});
	}
}
