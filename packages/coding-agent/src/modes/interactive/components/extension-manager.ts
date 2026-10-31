import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	type Keybinding,
	type SelectItem,
	SelectList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@greppleai/grip-tui";
import type { InstalledExtension } from "../../../core/extension-inventory.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { OfficialCatalogItem } from "../../../core/official-catalog-view.ts";
import {
	ExtensionManagerController,
	type ExtensionManagerList,
	type ExtensionManagerOptions,
	type ExtensionManagerState,
} from "../extension-manager.ts";
import type { Theme, ThemeColor } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatKeyText } from "./keybinding-hints.ts";

export interface ExtensionManagerComponentOptions extends Omit<ExtensionManagerOptions, "onChange"> {
	keybindings: KeybindingsManager;
	getTheme: () => Pick<Theme, "fg">;
	requestRender: () => void;
	/** Called only after the controller has settled and been disposed. */
	onClose: (reloadRequired: boolean) => void;
}

interface ManagerChoice extends SelectItem {
	run: () => void;
}

function plainText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Presentation only. The controller owns operations; the host owns runtime reconciliation. */
export class ExtensionManagerComponent implements Component, Focusable {
	private readonly options: ExtensionManagerComponentOptions;
	private readonly controller: ExtensionManagerController;
	private readonly searches: Record<ExtensionManagerList, Input> = { installed: new Input(), catalog: new Input() };
	private readonly gitInput = new Input();
	private readonly selections: Record<ExtensionManagerList, string | null> = { installed: null, catalog: null };
	private readonly border: DynamicBorder;
	private state: ExtensionManagerState;
	private choices: ManagerChoice[] = [];
	private list: SelectList;
	private viewKey = "";
	private _focused = false;
	private closing = false;
	private disposed = false;

	constructor(options: ExtensionManagerComponentOptions) {
		this.options = options;
		this.controller = new ExtensionManagerController({
			packageManager: options.packageManager,
			resourceLoader: options.resourceLoader,
			onChange: () => this.sync(),
		});
		this.state = this.controller.getState();
		this.border = new DynamicBorder((text) => this.options.getTheme().fg("border", text));
		this.list = this.createList([]);
		this.rebuild();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.updateFocus();
	}

	async initialize(): Promise<void> {
		if (!this.disposed && !this.closing) await this.controller.initialize();
	}

	private listPage(): ExtensionManagerList | null {
		return this.state.page === "installed" || this.state.page === "catalog" ? this.state.page : null;
	}

	private updateFocus(): void {
		const page = this.listPage();
		this.gitInput.focused =
			this._focused && !this.disposed && !this.closing && !this.state.activity && this.state.page === "git-input";
		for (const name of ["installed", "catalog"] as const) {
			this.searches[name].focused =
				this._focused && !this.disposed && !this.closing && !this.state.activity && page === name;
		}
	}

	private rememberSelection(): void {
		const page = this.listPage();
		if (page) this.selections[page] = this.list.getSelectedItem()?.value ?? null;
	}

	private sync(): void {
		if (this.disposed || this.closing) return;
		// Do not retain the placeholder Refresh selection after the first catalog arrives.
		const initialCatalogLoad = this.state.activity?.kind === "catalog" && this.state.catalog === null;
		this.rememberSelection();
		this.state = this.controller.getState();
		this.rebuild(initialCatalogLoad && this.state.activity === null);
		this.options.requestRender();
	}

	private createList(choices: ManagerChoice[]): SelectList {
		return new SelectList(choices, 8, {
			selectedPrefix: (text) => this.options.getTheme().fg("accent", text),
			selectedText: (text) => this.options.getTheme().fg("accent", text),
			description: (text) => this.options.getTheme().fg("muted", text),
			scrollInfo: (text) => this.options.getTheme().fg("dim", text),
			noMatch: (text) => this.options.getTheme().fg("muted", text),
		});
	}

	private rebuild(resetSelection = false): void {
		const page = this.listPage();
		const key = JSON.stringify([this.state.page, this.state.target, this.state.confirmation]);
		let selected: string | null = null;
		if (!resetSelection) {
			selected = key === this.viewKey ? (this.list.getSelectedItem()?.value ?? null) : page && this.selections[page];
		}
		this.viewKey = key;
		this.choices = this.buildChoices().map((choice) => ({
			...choice,
			label: plainText(choice.label),
			description: plainText(choice.description ?? ""),
		}));
		this.list = this.createList(this.choices);
		this.list.setSelectedIndex(
			Math.max(
				0,
				this.choices.findIndex((choice) => choice.value === selected),
			),
		);
		this.updateFocus();
	}

	private back(): void {
		if (this.controller.back()) void this.close();
	}

	private async close(): Promise<void> {
		if (this.disposed || this.closing) return;
		this.closing = true;
		this.updateFocus();
		this.options.requestRender();
		const reloadRequired = await this.controller.dispose();
		if (this.disposed) return;
		this.disposed = true;
		this.options.onClose(reloadRequired);
	}

	async dispose(): Promise<boolean> {
		this.disposed = true;
		this.updateFocus();
		return this.controller.dispose();
	}

	private installedName(row: InstalledExtension): string {
		const item = this.state.catalog?.extensions.find((entry) => row.source === `official:${entry.id}`);
		return item?.manifest?.grip.official.displayName ?? row.source;
	}

	private catalogInstallation(item: OfficialCatalogItem): InstalledExtension | undefined {
		return this.state.inventory.find(
			(row) => row.source === `official:${item.id}` && row.scope === "user" && row.configured,
		);
	}

	private openGitInput(): void {
		this.gitInput.setValue("");
		this.controller.openGitInput();
	}

	private installedChoices(): ManagerChoice[] {
		const rows = fuzzyFilter(
			this.state.inventory,
			this.searches.installed.getValue(),
			(row) => `${this.installedName(row)} ${row.source} ${row.scope} ${row.status} ${row.version ?? ""}`,
		);
		return [
			{ value: "browse", label: "Install extension", run: () => void this.controller.openCatalog() },
			...this.gitInstallChoice(),
			...rows.map(
				(row): ManagerChoice => ({
					value: `installed:${row.identity}`,
					label: `${this.installedName(row)} (${row.version ?? "version unknown"})`,
					description: `${row.scope} | ${row.status} | ${row.removal ? "managed" : "manual/unmanaged"} | ${row.source}`,
					run: () => this.controller.showDetail({ kind: "installed", identity: row.identity }),
				}),
			),
			{ value: "inventory", label: "Refresh installed", run: () => void this.controller.initialize() },
		];
	}

	private catalogChoices(): ManagerChoice[] {
		const rows = fuzzyFilter(
			this.state.catalog?.extensions ?? [],
			this.searches.catalog.getValue(),
			(item) => `${item.id} ${item.manifest?.grip.official.displayName ?? ""} ${item.manifest?.description ?? ""}`,
		);
		return [
			...rows.map(
				(item): ManagerChoice => ({
					value: `catalog:${item.id}`,
					label: `${item.manifest?.grip.official.displayName ?? item.id} (${item.compatibleVersion ?? "unavailable"})`,
					description: `${this.catalogInstallation(item)?.status ?? "not installed"} | ${item.manifest?.description ?? item.unavailableReason ?? ""}`,
					run: () => this.controller.showDetail({ kind: "catalog", id: item.id }),
				}),
			),
			{ value: "refresh", label: "Refresh catalog", run: () => void this.controller.openCatalog(true) },
			...this.gitInstallChoice(),
			{ value: "back", label: "Back", run: () => this.back() },
		];
	}

	private gitInstallChoice(): ManagerChoice[] {
		return this.state.inventoryReady && !this.state.inventoryError
			? [
					{
						value: "git",
						label: "Install from Git URL",
						description: "Third-party / unverified",
						run: () => this.openGitInput(),
					},
				]
			: [];
	}

	private selectedInstallation(): InstalledExtension | undefined {
		const target = this.state.target;
		if (!target) return undefined;
		if (target.kind === "installed") return this.state.inventory.find((row) => row.identity === target.identity);
		return this.state.inventory.find(
			(row) => row.source === `official:${target.id}` && row.scope === "user" && row.configured,
		);
	}

	private selectedCatalogItem(): OfficialCatalogItem | undefined {
		const target = this.state.target;
		return target?.kind === "catalog"
			? this.state.catalog?.extensions.find((item) => item.id === target.id)
			: undefined;
	}

	private buildChoices(): ManagerChoice[] {
		if (this.state.page === "installed") return this.installedChoices();
		if (this.state.page === "catalog") return this.catalogChoices();
		const back: ManagerChoice = { value: "back", label: "Back", run: () => this.back() };
		if (this.state.page === "git-input") return [];
		if (this.state.page === "git-scope")
			return [
				{ value: "user", label: "User / active profile", run: () => void this.controller.prepareGit("user") },
				{ value: "project", label: "Project", run: () => void this.controller.prepareGit("project") },
				back,
			];
		if (this.state.page === "git-review")
			return [
				{ value: "cancel", label: "Cancel — do not install", run: () => this.back() },
				{
					value: "approve-git",
					label: "Trust and install this commit",
					run: () => {
						void this.controller.approveGit().then(async (completed) => {
							if (completed) await this.close();
						});
					},
				},
			];
		if (this.state.page === "confirm") {
			return [
				{ value: "cancel", label: "Cancel", run: () => this.back() },
				{
					value: "confirm",
					label: "Confirm",
					run: () => {
						void this.controller.confirm().then(async (action) => {
							if (action?.kind === "install") await this.close();
						});
					},
				},
			];
		}
		const choices: ManagerChoice[] = [];
		if (this.state.inventoryReady && !this.state.inventoryError) {
			const row = this.selectedInstallation();
			if (this.selectedCatalogItem()?.compatibleVersion && !row?.installedPath) {
				choices.push({ value: "install", label: "Install", run: () => this.controller.requestInstall() });
			}
			if (row?.removal) {
				choices.push({ value: "remove", label: "Uninstall", run: () => this.controller.requestRemove() });
			}
		}
		choices.push(back);
		return choices;
	}

	private text(value: string, width: number, color: ThemeColor = "text"): string[] {
		return wrapTextWithAnsi(this.options.getTheme().fg(color, plainText(value)), width);
	}

	private inventoryDetails(row: InstalledExtension, width: number): string[] {
		const lines = [
			...this.text(this.installedName(row), width, "accent"),
			...this.text(`Version: ${row.version ?? "unknown (not reported)"} | ${row.status} | ${row.scope}`, width),
			...this.text(`Source: ${row.source}`, width),
			...this.text(
				`Configured: ${row.configured ? "yes" : "no"} | Path: ${row.installedPath ?? "unavailable"}`,
				width,
			),
		];
		if (!row.source.startsWith("official:")) {
			lines.push(
				...this.text(
					"Third-party / unverified package. Not part of official automatic updates. Git installs from this manager are pinned; use the CLI install command with a new ref to change the commit.",
					width,
					"warning",
				),
			);
		}
		if (row.status === "failed")
			lines.push(
				...this.text(
					"Installation is not successful activation. Review the load/factory errors below; disable or uninstall this extension, then /reload or restart.",
					width,
					"warning",
				),
			);
		if (!row.removal) {
			lines.push(
				...this.text(
					"Manually maintained/unmanaged. Remove or disable it at its source; Grip will not delete these files.",
					width,
					"warning",
				),
			);
		}
		for (const entry of row.entries) {
			lines.push(
				...this.text(
					`Entry: ${entry.path} | ${entry.status} | ${entry.sourceInfo.scope}/${entry.sourceInfo.origin}`,
					width,
				),
			);
			for (const error of entry.errors) lines.push(...this.text(error, width, "error"));
		}
		for (const error of row.errors) lines.push(...this.text(error, width, "error"));
		return lines;
	}

	private details(width: number): string[] {
		const lines: string[] = [];
		const item = this.selectedCatalogItem();
		if (item) {
			lines.push(...this.text(item.manifest?.grip.official.displayName ?? item.id, width, "accent"));
			lines.push(...this.text(`Source: official:${item.id} | user scope`, width));
			lines.push(...this.text(item.manifest?.description ?? "No published stable metadata.", width));
			lines.push(...this.text(`Compatible stable version: ${item.compatibleVersion ?? "none"}`, width));
			if (item.manifest) lines.push(...this.text(`Supported Grip: ${item.manifest.engines.grip}`, width));
			if (item.unavailableReason) lines.push(...this.text(item.unavailableReason, width, "warning"));
		}
		const row = this.selectedInstallation();
		if (row) lines.push(...this.inventoryDetails(row, width));
		if (this.state.page === "confirm") {
			if (this.state.confirmation?.kind === "install") {
				lines.push(
					...this.text(
						"Extensions run with full access to your files, commands, network, and credentials as your user. They are not sandboxed. Install only code you trust.",
						width,
						"warning",
					),
				);
				lines.push(...this.text(`Install official:${this.state.confirmation.id} globally?`, width));
			} else if (row?.removal) {
				lines.push(
					...this.text(`Uninstall ${row.removal.source} from ${row.removal.scope} scope?`, width, "warning"),
				);
				lines.push(
					...this.text(
						"Only this managed package selection/install is removed. Manually maintained files and user configuration/data outside the managed installation are preserved. Running code remains until reload/restart.",
						width,
					),
				);
			}
		}
		return lines;
	}

	private gitDetails(width: number): string[] {
		const review = this.state.gitPreparation;
		if (this.state.page === "git-scope")
			return [
				...this.text(`Source: ${this.state.gitSource}`, width),
				...this.text(
					"Choose the install destination. User uses the active profile when one is selected. Preparation does not approve or execute extension code.",
					width,
				),
			];
		if (this.state.page !== "git-review" || !review) return [];
		return [
			...this.text("Third-party / unverified Git package — not official", width, "warning"),
			...this.text(`${review.name ?? "Unnamed package"} | ${review.version ?? "version unknown"}`, width),
			...this.text(`Source: ${review.source}`, width),
			...this.text(`Requested ref: ${review.requestedRef ?? "default branch"}`, width),
			...this.text(`Resolved commit: ${review.commit}`, width),
			...this.text(`Destination: ${review.scope} | user profile: ${review.profile ?? "default"}`, width),
			...review.entries.flatMap((entry) => this.text(`Entry: ${entry}`, width)),
			...this.text(review.warning, width, "warning"),
			...this.text(
				"Approval permits dependency install scripts and extension code with full filesystem, network and credential access as your user. A Git host, commit hash or valid manifest does not establish trust. Install only code you trust.",
				width,
				"warning",
			),
			...this.text(
				"The reviewed commit will be pinned, not automatically updated. Saving is not activation: after idle reload/restart, use /extensions to inspect load/factory errors. Disable or uninstall failed extensions before /reload.",
				width,
			),
		];
	}

	private catalogStatus(width: number): string[] {
		const catalog = this.state.catalog;
		const lines: string[] = [];
		if (catalog) {
			const freshness = catalog.stale ? "stale cache" : "current catalog";
			lines.push(
				...this.text(
					`${catalog.offline ? "Offline | " : ""}${freshness} | fetched: ${catalog.fetchedAt ?? "never"}`,
					width,
					"muted",
				),
			);
			if (catalog.error) lines.push(...this.text(`${catalog.error.code}: ${catalog.error.message}`, width, "error"));
			if (catalog.extensions.length === 0)
				lines.push(...this.text("No official extensions are currently published.", width));
		} else if (!this.state.activity) {
			lines.push(
				...this.text(
					"Catalog unavailable. Check connectivity/offline mode and retry Refresh catalog.",
					width,
					"warning",
				),
			);
		}
		return lines;
	}

	private hint(keybinding: Keybinding, label: string): string {
		return `${formatKeyText(this.options.keybindings.getKeys(keybinding).join("/")) || "unbound"} ${label}`;
	}

	render(width: number): string[] {
		if (width <= 0 || this.disposed) return [];
		const lines = [...this.border.render(width), "", ...this.text("Extensions", width, "accent")];
		if (this.closing) {
			lines.push(...this.text("Closing; waiting for management work to settle...", width));
		} else {
			if (this.state.reloadRequired)
				lines.push(
					...this.text("Reload/restart pending; running extensions have not been replaced.", width, "warning"),
				);
			if (this.state.inventoryError)
				lines.push(
					...this.text(
						`Inventory unavailable: ${this.state.inventoryError}. Retry Refresh installed before making changes.`,
						width,
						"error",
					),
				);
			if (this.state.notice) lines.push(...this.text(this.state.notice, width, "warning"));
			if (this.state.page === "catalog") lines.push(...this.catalogStatus(width));
			if (this.state.page === "detail" || this.state.page === "confirm") lines.push(...this.details(width));
			lines.push(...this.gitDetails(width));
			lines.push(...this.renderControls(width));
		}
		lines.push("", ...this.border.render(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderControls(width: number): string[] {
		const activity = this.state.activity;
		if (activity) {
			const cancellation = activity.cancelable
				? this.hint("tui.select.cancel", "request cancellation")
				: "Wait for this operation to settle.";
			return [
				...this.text(`${activity.kind}: ${activity.phase ?? "working"}`, width, "accent"),
				...this.text(
					activity.cancelRequested
						? "Cancellation requested; waiting for settlement and inventory reconciliation."
						: cancellation,
					width,
					"muted",
				),
			];
		}
		if (this.state.page === "git-input")
			return [
				...this.text("Install from Git URL — HTTPS or SSH only (optional @ref)", width, "accent"),
				...this.text(
					"No npm specs, local paths or shorthand URLs. Do not embed credentials; use your Git credential helper or SSH keys.",
					width,
				),
				...this.gitInput.render(width),
				...this.text(
					`${this.hint("tui.input.submit", "continue to destination")} | ${this.hint("tui.select.cancel", "back")}`,
					width,
					"dim",
				),
			];
		const lines: string[] = [];
		const page = this.listPage();
		if (page) {
			lines.push(
				...this.text(page === "catalog" ? "Official catalog — search:" : "Installed/configured — search:", width),
			);
			lines.push("", ...this.searches[page].render(width), "");
			if (page === "installed" && this.state.inventoryReady && this.state.inventory.length === 0)
				lines.push(...this.text("No installed or configured remote extensions.", width));
		}
		lines.push(...this.list.render(Math.max(8, width)), "");
		lines.push(
			this.options
				.getTheme()
				.fg(
					"dim",
					[
						this.hint("tui.select.up", "up"),
						this.hint("tui.select.down", "down"),
						this.hint("tui.select.confirm", "select"),
						this.hint("tui.select.cancel", "back"),
					].join(" | "),
				),
		);
		return lines;
	}

	private navigate(data: string): boolean {
		const selected = this.list.getSelectedItem()?.value;
		const current = this.choices.findIndex((choice) => choice.value === selected);
		const count = this.choices.length;
		for (const [binding, step] of [
			["tui.select.up", -1],
			["tui.select.down", 1],
			["tui.select.pageUp", -8],
			["tui.select.pageDown", 8],
		] as const) {
			if (!this.options.keybindings.matches(data, binding)) continue;
			if (count > 0)
				this.list.setSelectedIndex(
					Math.abs(step) === 1
						? (current + step + count) % count
						: Math.max(0, Math.min(count - 1, current + step)),
				);
			this.rememberSelection();
			return true;
		}
		return false;
	}

	handleInput(data: string): void {
		if (this.disposed || this.closing) return;
		if (this.options.keybindings.matches(data, "tui.select.cancel")) {
			this.back();
			this.options.requestRender();
			return;
		}
		if (this.state.activity) return;
		if (this.state.page === "git-input") {
			if (this.options.keybindings.matches(data, "tui.input.submit"))
				this.controller.requestGitPreparation(this.gitInput.getValue());
			else this.gitInput.handleInput(data);
		} else if (this.options.keybindings.matches(data, "tui.select.confirm")) {
			this.choices.find((choice) => choice.value === this.list.getSelectedItem()?.value)?.run();
		} else if (!this.navigate(data)) {
			const page = this.listPage();
			if (page) {
				const before = this.searches[page].getValue();
				this.searches[page].handleInput(data);
				if (before !== this.searches[page].getValue()) this.rebuild(true);
			}
		}
		this.options.requestRender();
	}

	invalidate(): void {
		this.list.invalidate();
		this.searches.installed.invalidate();
		this.searches.catalog.invalidate();
		this.gitInput.invalidate();
		this.border.invalidate();
	}
}
