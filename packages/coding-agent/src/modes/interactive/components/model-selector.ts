import { type Api, type Model, modelsAreEqual } from "@greppleai/grip-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@greppleai/grip-tui";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<Api>;
}

interface ScopedModelItem {
	model: Model<Api>;
	thinkingLevel?: string;
}

interface ProviderItem {
	id: string;
	name: string;
	models: ModelItem[];
}

type ModelScope = "all" | "scoped";
type PickerView = "providers" | "models" | "search";

/** Native provider/model navigation, with a global model-search entry point. */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private providers: ProviderItem[] = [];
	private filteredProviders: ProviderItem[] = [];
	private selectedProvider: ProviderItem | null = null;
	private providerQuery = "";
	private providerIndex = 0;
	private view: PickerView;
	private selectedIndex = 0;
	private currentModel: Model<Api> | undefined;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<Api>) => void;
	private onCancelCallback: () => void;
	private errorMessage: string | undefined;
	private loading = true;
	private listWidth = 80;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope;
	private scopeText: Text;
	private navigationText: Text;
	private readonly persistDefault: boolean;

	constructor(
		tui: TUI,
		currentModel: Model<Api> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<Api>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		persistDefault = true,
	) {
		super();
		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.view = initialSearchInput ? "search" : "providers";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.persistDefault = persistDefault;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.scopeText = new Text("", 0, 0);
		this.addChild(this.scopeText);
		this.navigationText = new Text("", 0, 0);
		this.addChild(this.navigationText);
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.setValue(initialSearchInput ?? "");
		this.searchInput.onSubmit = () => this.confirmSelection();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateList();
		void this.loadModels();
	}

	private async loadModels(): Promise<void> {
		try {
			// Refresh without introducing provider/network validation.
			this.modelRegistry.refresh();
			this.errorMessage = this.modelRegistry.getError();
			const available = await this.modelRegistry.getAvailable();
			this.allModels = available.map((model) => ({ provider: model.provider, id: model.id, model }));
			this.allModels.sort((a, b) => {
				const aCurrent = modelsAreEqual(this.currentModel, a.model);
				const bCurrent = modelsAreEqual(this.currentModel, b.model);
				if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
				return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
			});
			const registered = new Map<string, Map<string, Model<Api>>>();
			for (const model of this.modelRegistry.getAll()) {
				let models = registered.get(model.provider);
				if (!models) {
					models = new Map();
					registered.set(model.provider, models);
				}
				if (!models.has(model.id)) models.set(model.id, model);
			}
			// Keep scoped order, reconciling stale instances after registry refresh.
			this.scopedModelItems = this.scopedModels.map(({ model }) => ({
				provider: model.provider,
				id: model.id,
				model: registered.get(model.provider)?.get(model.id) ?? model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
		}
		this.loading = false;
		this.rebuildProviders();
		this.selectCurrent();
		this.filterItems(this.searchInput.getValue());
		this.tui.requestRender();
	}

	private rebuildProviders(): void {
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const groups = new Map<string, ProviderItem>();
		for (const item of this.activeModels) {
			let provider = groups.get(item.provider);
			if (!provider) {
				provider = {
					id: item.provider,
					name: this.modelRegistry.getProviderDisplayName(item.provider),
					models: [],
				};
				groups.set(item.provider, provider);
			}
			provider.models.push(item);
		}
		this.providers = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	}

	private selectCurrent(): void {
		const index =
			this.view === "providers"
				? this.providers.findIndex((item) => item.id === this.currentModel?.provider)
				: this.getModelItems().findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = Math.max(0, index);
	}

	private getModelItems(): ModelItem[] {
		return this.view === "models" ? (this.selectedProvider?.models ?? []) : this.activeModels;
	}

	private filterItems(query: string): void {
		if (this.view === "providers") {
			this.filteredProviders = query
				? fuzzyFilter(this.providers, query, ({ id, name }) => `${name} ${id}`)
				: this.providers;
		} else {
			const items = this.getModelItems();
			this.filteredModels = query
				? fuzzyFilter(
						items,
						query,
						({ id, provider, model }) => `${id} ${provider} ${provider}/${id} ${model.name}`,
					)
				: items;
		}
		// Query edits select the best match; clearing only clamps the position (7209).
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.itemCount() - 1));
		this.updateList();
	}

	private itemCount(): number {
		return this.view === "providers" ? this.filteredProviders.length : this.filteredModels.length;
	}

	private updateHeader(): void {
		const all = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scoped = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		const scopeHint =
			this.scopedModels.length > 0 ? ` · ${keyHint("tui.input.tab", "scope")} (${all}/${scoped})` : "";
		const title =
			this.view === "providers"
				? "Providers"
				: this.view === "search"
					? "Search all providers"
					: `${this.selectedProvider?.name} [${this.selectedProvider?.id}]`;
		this.scopeText.setText(theme.fg("muted", title) + scopeHint);
		this.navigationText.setText(
			keyHint("tui.select.up", "up") +
				" · " +
				keyHint("tui.select.down", "down") +
				" · " +
				keyHint("tui.select.confirm", this.view === "providers" ? "models" : "select") +
				" · " +
				keyHint("tui.select.cancel", this.view === "models" ? "providers" : "cancel"),
		);
	}

	private updateList(): void {
		this.updateHeader();
		this.listContainer.clear();
		const count = this.itemCount();
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
		const end = Math.min(start + maxVisible, count);
		for (let i = start; i < end; i++) {
			let label: string;
			let current: boolean;
			if (this.view === "providers") {
				const item = this.filteredProviders[i];
				label = `${item.name} [${item.id}] (${item.models.length} models)`;
				current = item.id === this.currentModel?.provider;
			} else {
				const item = this.filteredModels[i];
				label = `${item.id} [${item.provider}]`;
				current = modelsAreEqual(this.currentModel, item.model);
			}
			const selected = i === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const marker = current ? theme.fg("success", " ✓") : "";
			this.addListLine(prefix + (selected ? theme.fg("accent", label) : label) + marker);
		}
		if (start > 0 || end < count) this.addListLine(theme.fg("muted", `  (${this.selectedIndex + 1}/${count})`));
		this.appendListStatus(count);
	}

	private appendListStatus(count: number): void {
		if (this.loading) {
			this.addListLine(theme.fg("muted", "  Loading models…"));
		} else if (count === 0) {
			const empty =
				this.view === "providers" ? "No matching providers. Use /login to add providers." : "No matching models";
			this.addListLine(theme.fg("muted", `  ${empty}`));
		} else if (this.view !== "providers") {
			this.listContainer.addChild(new Spacer(1));
			this.addListLine(theme.fg("muted", `  Model Name: ${this.filteredModels[this.selectedIndex].model.name}`));
		}
		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) this.addListLine(theme.fg("error", line));
		}
	}

	private addListLine(line: string): void {
		this.listContainer.addChild(new Text(truncateToWidth(line, this.listWidth), 0, 0));
	}

	override render(width: number): string[] {
		if (this.listWidth !== width) {
			this.listWidth = width;
			this.updateList();
		}
		return super.render(width);
	}

	private toggleModelScope(): void {
		if (this.scopedModels.length === 0) return;
		this.scope = this.scope === "all" ? "scoped" : "all";
		if (this.view !== "search") {
			this.view = "providers";
			this.selectedProvider = null;
			this.providerQuery = "";
			this.providerIndex = 0;
			this.searchInput.setValue("");
		}
		this.rebuildProviders();
		this.selectCurrent();
		this.filterItems(this.searchInput.getValue());
	}

	private moveSelection(delta: number): void {
		const count = this.itemCount();
		if (count === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.updateList();
	}

	private confirmSelection(): void {
		if (this.loading) return;
		if (this.view === "providers") {
			const provider = this.filteredProviders[this.selectedIndex];
			if (!provider) return;
			this.providerQuery = this.searchInput.getValue();
			this.providerIndex = this.selectedIndex;
			this.selectedProvider = provider;
			this.view = "models";
			this.searchInput.setValue("");
			this.selectCurrent();
			this.filterItems("");
			return;
		}
		const item = this.filteredModels[this.selectedIndex];
		if (!item) return;
		if (this.persistDefault) this.settingsManager.setDefaultModelAndProvider(item.provider, item.id);
		this.onSelectCallback(item.model);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			this.toggleModelScope();
		} else if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.moveSelection(-Math.min(10, Math.max(0, this.itemCount() - 1)));
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.moveSelection(Math.min(10, Math.max(0, this.itemCount() - 1)));
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.view === "models") {
				this.view = "providers";
				this.selectedProvider = null;
				this.searchInput.setValue(this.providerQuery);
				this.filterItems(this.providerQuery);
				this.selectedIndex = Math.min(this.providerIndex, Math.max(0, this.itemCount() - 1));
				this.updateList();
			} else {
				this.onCancelCallback();
			}
		} else {
			const query = this.searchInput.getValue();
			this.searchInput.handleInput(keyData);
			if (query !== this.searchInput.getValue()) this.filterItems(this.searchInput.getValue());
		}
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
