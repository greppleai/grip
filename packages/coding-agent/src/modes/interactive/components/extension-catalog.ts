import { Container, SelectList, Spacer, Text, truncateToWidth } from "@greppleai/grip-tui";
import {
	getOfficialExtensionTarget,
	type OfficialExtension,
	type OfficialExtensionState,
} from "../../../core/official-extensions.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ExtensionCatalogChoice {
	value: string;
	label: string;
	description: string;
	details: readonly string[];
}

export interface ExtensionCatalogOptions {
	title: string;
	choices: readonly ExtensionCatalogChoice[];
	onSelect: (value: string) => void;
	onCancel: () => void;
}

function singleLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function officialExtensionStatus(state: OfficialExtensionState): string {
	if (state.conflict) return "conflict";
	if (state.loadedOwners.length > 0) return "loaded";
	const pkg = state.installations[0];
	if (!pkg) return "not installed";
	if (pkg.installed) return "installed";
	return pkg.root ? "configured / unverified" : "configured / missing";
}

export function officialExtensionChoice(
	entry: OfficialExtension,
	state: OfficialExtensionState,
): ExtensionCatalogChoice {
	const target = getOfficialExtensionTarget(entry);
	const status = officialExtensionStatus(state);
	const details = [entry.description, `Repository: ${entry.repository}`];
	if (target) details.push(`Approved target: ${target.source}`, `Version/revision: ${target.revision}`);
	else
		details.push(`Unavailable: ${entry.unavailableReason ?? "No reviewed exact installation target is available."}`);
	for (const pkg of state.installations) {
		details.push(
			`${pkg.scope}: ${pkg.source}`,
			`Files: ${pkg.root ?? "missing"}; local version: ${pkg.version ?? "unverified"}`,
		);
		if (pkg.kind === "local") details.push("Local/unmanaged source; no automatic file upgrades or deletion.");
		if (pkg.filtered) details.push("Resource filters configured; retained when upgrading in this scope.");
	}
	for (const owner of state.loadedOwners) details.push(`Loaded: ${owner.path} (${owner.scope}: ${owner.source})`);
	if (state.conflict) details.push(state.conflict);
	return { value: entry.id, label: `${entry.name} — ${status}`, description: entry.description, details };
}

/** Also used for action/scope/confirmation menus; put Cancel first for default-cancel consent. */
export class ExtensionCatalogComponent extends Container {
	private readonly list: SelectList;
	private readonly hints: Text;

	constructor(options: ExtensionCatalogOptions) {
		super();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", singleLine(options.title)), 1, 0));
		this.addChild(new Spacer(1));
		this.list = new SelectList(
			options.choices.map((choice) => ({
				value: choice.value,
				label: singleLine(choice.label),
				description: singleLine(choice.description),
			})),
			6,
			getSelectListTheme(),
		);
		const details = new Text("", 1, 0);
		const showDetails = (value: string | undefined) => {
			const choice = options.choices.find((item) => item.value === value);
			details.setText(choice ? choice.details.map(singleLine).join("\n") : "No official extensions available.");
		};
		this.list.onSelect = (item) => options.onSelect(item.value);
		this.list.onCancel = options.onCancel;
		this.list.onSelectionChange = (item) => showDetails(item.value);
		showDetails(this.list.getSelectedItem()?.value);
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(details);
		this.addChild(new Spacer(1));
		this.hints = new Text("", 1, 0);
		this.addChild(this.hints);
		this.addChild(new DynamicBorder());
		this.invalidate();
	}

	override invalidate(): void {
		this.hints.setText(
			[
				keyHint("tui.select.up", "up"),
				keyHint("tui.select.down", "down"),
				keyHint("tui.select.confirm", "select"),
				keyHint("tui.select.cancel", "back"),
			].join("  "),
		);
		super.invalidate();
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	override render(width: number): string[] {
		return super.render(Math.max(1, width)).map((line) => truncateToWidth(line, Math.max(0, width), ""));
	}
}
