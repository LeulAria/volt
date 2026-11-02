/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltDevtools.css';
import { $, addDisposableListener, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Orientation, Sash } from '../../../../base/browser/ui/sash/sash.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ITableColumn, ITableRenderer } from '../../../../base/browser/ui/table/table.js';
import { ITreeElement, ITreeNode, ITreeRenderer, ITreeDragAndDrop } from '../../../../base/browser/ui/tree/tree.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { WorkbenchObjectTree, WorkbenchTable } from '../../../../platform/list/browser/listService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { encodeVoltContextDrag, IVoltContextDrag, VOLT_CONTEXT_MIME, voltPartContext, voltSlotItemContext } from '../common/voltCustomizeContext.js';
import { allVoltCustomizeParts, IVoltCustomizePart, VOLT_CUSTOMIZE_PARTS } from '../common/voltCustomizeParts.js';
import { clampVoltLookValue, IVoltLookToken, VOLT_LOOK_TOKENS, voltLookAlias, voltLookToken } from '../common/voltLookTokens.js';
import { IVoltSlotService, unplacedVoltSlotItems, VOLT_SLOT_ITEMS, VOLT_SLOTS, VoltSlotId } from '../common/voltSlots.js';
import { IVoltCustomizeService } from './voltCustomizeService.js';

export const VOLT_DEVTOOLS_EDITOR_ID = 'workbench.editor.voltDevtools';
const VOLT_DEVTOOLS_INPUT_ID = 'workbench.input.voltDevtools';

/** The Playground devtools as a tab (it opens in the right panel beside the chat). */
export class VoltDevtoolsInput extends EditorInput {
	static readonly TypeID = VOLT_DEVTOOLS_INPUT_ID;
	readonly resource = URI.from({ scheme: 'volt-devtools', path: '/devtools' });
	override get typeId(): string { return VOLT_DEVTOOLS_INPUT_ID; }
	override get editorId(): string { return VOLT_DEVTOOLS_EDITOR_ID; }
	override getName(): string { return localize('voltDevtools.tab', "Customize"); }
	override getIcon(): ThemeIcon { return Codicon.symbolColor; }
	override matches(other: unknown): boolean { return other instanceof VoltDevtoolsInput; }
}

// --- Layers -----------------------------------------------------------------------------------

type LayerNode =
	| { readonly kind: 'group'; readonly id: string; readonly label: string; readonly icon: ThemeIcon }
	| { readonly kind: 'part'; readonly id: string; readonly part: IVoltCustomizePart }
	| { readonly kind: 'item'; readonly id: string; readonly itemId: string; readonly slot: VoltSlotId }
	| { readonly kind: 'plugin'; readonly id: string; readonly label: string; readonly detail: string; readonly icon: ThemeIcon };

function nodeLabel(node: LayerNode): string {
	switch (node.kind) {
		case 'part': return node.part.label;
		case 'item': return VOLT_SLOT_ITEMS.find(item => item.id === node.itemId)?.label ?? node.itemId;
		default: return node.label;
	}
}

function nodeIcon(node: LayerNode): ThemeIcon {
	switch (node.kind) {
		case 'part': return node.part.slot ? Codicon.layoutPanelLeft : node.part.children?.length ? Codicon.layout : Codicon.symbolField;
		case 'item': return Codicon.symbolEvent;
		default: return node.icon;
	}
}

function nodeDetail(node: LayerNode): string {
	switch (node.kind) {
		case 'part': return node.part.selector;
		case 'item': return node.itemId;
		case 'plugin': return node.detail;
		default: return '';
	}
}

/** The element(s) a layer stands for in this window. */
function nodeSelector(node: LayerNode): string | undefined {
	return node.kind === 'part' ? node.part.selector : node.kind === 'item' ? `[data-volt-item="${node.itemId}"]` : undefined;
}

class LayerDelegate implements IListVirtualDelegate<LayerNode> {
	getHeight(): number { return 26; }
	getTemplateId(): string { return 'layer'; }
}

interface ILayerTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly store: DisposableStore;
}

class LayerRenderer implements ITreeRenderer<LayerNode, void, ILayerTemplate> {
	readonly templateId = 'layer';

	constructor(private readonly host: VoltDevtoolsEditor) { }

	renderTemplate(container: HTMLElement): ILayerTemplate {
		const row = append(container, $('.volt-devtools-layer'));
		return { row, icon: append(row, $('span.icon')), label: append(row, $('span.label')), detail: append(row, $('span.detail')), store: new DisposableStore() };
	}

	renderElement(element: ITreeNode<LayerNode, void>, _index: number, template: ILayerTemplate): void {
		const node = element.element;
		template.store.clear();
		clearNode(template.icon);
		template.icon.appendChild(renderIcon(nodeIcon(node)));
		template.label.textContent = nodeLabel(node);
		template.detail.textContent = nodeDetail(node);
		template.row.classList.toggle('group', node.kind === 'group');
		// Hovering a layer outlines what it is in the window and shows its config.
		template.store.add(addDisposableListener(template.row, 'mouseenter', () => this.host.highlight(node)));
		template.store.add(addDisposableListener(template.row, 'mouseleave', () => this.host.highlight(undefined)));
		template.store.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.row, () => ({ markdown: this.host.snippet(node), markdownNotSupportedFallback: nodeLabel(node) })));
	}

	disposeTemplate(template: ILayerTemplate): void {
		template.store.dispose();
	}
}

/** Dragging a layer carries its context; the chat's composer turns it into a chip. */
class LayerDragAndDrop implements ITreeDragAndDrop<LayerNode> {
	constructor(private readonly host: VoltDevtoolsEditor) { }
	getDragURI(node: LayerNode): string | null { return node.kind === 'group' ? null : `volt-part:${node.id}`; }
	getDragLabel(nodes: LayerNode[]): string | undefined { return nodes.map(nodeLabel).join(', '); }
	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const nodes = (data.getData() as LayerNode[] | undefined) ?? [];
		const drag = nodes.length ? this.host.contextFor(nodes[0]) : undefined;
		if (drag && originalEvent.dataTransfer) {
			originalEvent.dataTransfer.setData(VOLT_CONTEXT_MIME, encodeVoltContextDrag(drag));
			originalEvent.dataTransfer.effectAllowed = 'copy';
		}
	}
	onDragOver(): boolean { return false; }
	drop(): void { }
	dispose(): void { }
}

// --- Variables: a table -------------------------------------------------------------------------

const VARIABLE_ROW_HEIGHT = 28;

interface IVariableCell {
	readonly root: HTMLElement;
	readonly store: DisposableStore;
}

class VariableNameRenderer implements ITableRenderer<IVoltLookToken, IVariableCell> {
	static readonly ID = 'name';
	readonly templateId = VariableNameRenderer.ID;
	renderTemplate(container: HTMLElement): IVariableCell { return { root: append(container, $('.volt-devtools-cell.name')), store: new DisposableStore() }; }
	renderElement(token: IVoltLookToken, _index: number, cell: IVariableCell): void {
		cell.root.textContent = token.id;
		cell.root.title = token.description;
	}
	disposeTemplate(cell: IVariableCell): void { cell.store.dispose(); }
}

class VariableDefaultRenderer implements ITableRenderer<IVoltLookToken, IVariableCell> {
	static readonly ID = 'default';
	readonly templateId = VariableDefaultRenderer.ID;
	renderTemplate(container: HTMLElement): IVariableCell { return { root: append(container, $('.volt-devtools-cell.default')), store: new DisposableStore() }; }
	renderElement(token: IVoltLookToken, _index: number, cell: IVariableCell): void {
		cell.root.textContent = `${token.default}${token.unit === 'px' ? 'px' : ''}`;
	}
	disposeTemplate(cell: IVariableCell): void { cell.store.dispose(); }
}

/**
 * Up and down chevrons over the right end of a number input, in place of Chromium's spinner. A
 * step fires `change`, so it saves like typing a value and pressing Enter.
 */
function addStepper(host: HTMLElement, input: HTMLInputElement): DisposableStore {
	const store = new DisposableStore();
	host.classList.add('volt-devtools-stepper-host');
	const stepper = append(host, $('.volt-devtools-stepper'));
	store.add(toDisposable(() => stepper.remove()));
	for (const [icon, up, label] of [[Codicon.chevronUp, true, localize('voltDevtools.increase', "Increase")], [Codicon.chevronDown, false, localize('voltDevtools.decrease', "Decrease")]] as const) {
		const button = append(stepper, $('button.volt-devtools-step')) as HTMLButtonElement;
		button.type = 'button';
		button.tabIndex = -1;
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		// Keep focus where it is and keep the click from the list or table under it.
		store.add(addDisposableListener(button, 'mousedown', e => { e.preventDefault(); e.stopPropagation(); }));
		store.add(addDisposableListener(button, 'click', e => {
			e.stopPropagation();
			if (up) {
				input.stepUp();
			} else {
				input.stepDown();
			}
			input.dispatchEvent(new Event('change'));
		}));
	}
	return store;
}

interface IVariableValueCell extends IVariableCell {
	readonly input: HTMLInputElement;
	readonly template: DisposableStore;
}

/** The value, edited in place: an input that fills its cell (square, no border of its own; the grid is the border). */
class VariableValueRenderer implements ITableRenderer<IVoltLookToken, IVariableValueCell> {
	static readonly ID = 'value';
	readonly templateId = VariableValueRenderer.ID;
	constructor(private readonly host: VoltDevtoolsEditor) { }
	renderTemplate(container: HTMLElement): IVariableValueCell {
		const root = append(container, $('.volt-devtools-cell.value'));
		const input = append(root, $('input')) as HTMLInputElement;
		input.type = 'number';
		return { root, input, store: new DisposableStore(), template: addStepper(root, input) };
	}
	renderElement(token: IVoltLookToken, _index: number, cell: IVariableValueCell): void {
		cell.store.clear();
		cell.input.step = token.unit === 'px' ? '1' : '0.05';
		cell.input.min = String(token.minimum);
		cell.input.max = String(token.maximum);
		cell.input.value = String(clampVoltLookValue(token, this.host.customize.lookValue('token', token.id)) ?? token.default);
		cell.input.setAttribute('aria-label', token.id);
		cell.root.classList.toggle('changed', Number(cell.input.value) !== token.default);
		// The table must not take the keys (arrows step the number) or the click (it would move focus).
		cell.store.add(addDisposableListener(cell.input, 'keydown', e => e.stopPropagation()));
		cell.store.add(addDisposableListener(cell.input, 'mousedown', e => e.stopPropagation()));
		cell.store.add(addDisposableListener(cell.input, 'change', () => void this.host.customize.setLookValue('token', token.id, clampVoltLookValue(token, cell.input.value))));
	}
	disposeElement(_token: IVoltLookToken, _index: number, cell: IVariableValueCell): void { cell.store.clear(); }
	disposeTemplate(cell: IVariableValueCell): void {
		cell.store.dispose();
		cell.template.dispose();
	}
}

// --- The editor ---------------------------------------------------------------------------------

const SPLIT_STORAGE_KEY = 'volt.devtools.split';
const DEFAULT_SPLIT = 0.45;
/** Neither the layers nor the inspector gets narrower (or shorter) than this. */
const MIN_PANE_SIZE = 160;

function clampSplit(value: number): number {
	return Math.min(0.85, Math.max(0.15, value));
}

/**
 * Customize devtools: the window's parts and Volt's buttons as layers (hover outlines them, drag
 * one into the chat to hand it to the agent), an inspector that edits the draft's tokens and colors
 * in place, and every token as a variable. Built from Volt's own list, tree and controls.
 */
export class VoltDevtoolsEditor extends EditorPane {

	private root!: HTMLElement;
	private tabs!: HTMLElement;
	private layersView!: HTMLElement;
	private variablesView!: HTMLElement;
	private treeHost!: HTMLElement;
	private inspector!: HTMLElement;
	private tree!: WorkbenchObjectTree<LayerNode, void>;
	private variables!: WorkbenchTable<IVoltLookToken>;
	/** Every layer by id, rebuilt with the tree: what reveal and the element picker look up. */
	private nodesById = new Map<string, LayerNode>();
	private picking = false;
	private pickButton: HTMLButtonElement | undefined;
	private readonly pickStore = this._register(new DisposableStore());
	private readonly flash = this._register(new MutableDisposable());
	/** Open devtools tabs, so a chip clicked in the chat can reveal its part in one. */
	static readonly live = new Set<VoltDevtoolsEditor>();
	/** A part to reveal once a devtools tab is up (set when the tab is still opening). */
	static pendingReveal: string | undefined;
	private selected: LayerNode | undefined;
	private highlighted: Element[] = [];
	private tab: 'layers' | 'variables' = 'layers';
	private readonly inspectorStore = this._register(new DisposableStore());
	private readonly tabsStore = this._register(new DisposableStore());
	private dimension: Dimension | undefined;
	/** The layers tree's share of the width (side by side) or height (stacked); the sash moves it. */
	private split: number;
	private sideBySide: boolean | undefined;
	private sash: Sash | undefined;
	private readonly sashStore = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVoltCustomizeService public readonly customize: IVoltCustomizeService,
		@IVoltSlotService private readonly slotService: IVoltSlotService,
		@IHoverService public readonly hoverService: IHoverService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(VOLT_DEVTOOLS_EDITOR_ID, group, telemetryService, themeService, storage);
		this.split = clampSplit(storage.getNumber(SPLIT_STORAGE_KEY, StorageScope.PROFILE, DEFAULT_SPLIT));
		VoltDevtoolsEditor.live.add(this);
		this._register({ dispose: () => VoltDevtoolsEditor.live.delete(this) });
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-devtools'));
		this.tabs = append(this.root, $('.volt-devtools-tabs'));
		this.renderTabs();

		this.layersView = append(this.root, $('.volt-devtools-layers'));
		this.treeHost = append(this.layersView, $('.volt-devtools-tree'));
		this.inspector = append(this.layersView, $('.volt-devtools-inspector'));
		this.tree = this._register(this.instantiationService.createInstance(WorkbenchObjectTree<LayerNode, void>, 'VoltDevtoolsLayers', this.treeHost, new LayerDelegate(), [new LayerRenderer(this)], {
			identityProvider: { getId: node => node.id },
			accessibilityProvider: { getAriaLabel: node => nodeLabel(node), getWidgetAriaLabel: () => localize('voltDevtools.layers', "Layers") },
			dnd: new LayerDragAndDrop(this),
			multipleSelectionSupport: false,
			horizontalScrolling: false,
		}));
		this._register(this.tree.onDidChangeSelection(e => {
			this.selected = e.elements[0] ?? undefined;
			this.renderInspector();
		}));

		this.variablesView = append(this.root, $('.volt-devtools-variables'));
		const column = (templateId: string, label: string, weight: number, minimumWidth: number): ITableColumn<IVoltLookToken, IVoltLookToken> => ({ label, templateId, weight, minimumWidth, project: token => token });
		this.variables = this._register(this.instantiationService.createInstance(WorkbenchTable<IVoltLookToken>, 'VoltDevtoolsVariables', this.variablesView,
			{ headerRowHeight: VARIABLE_ROW_HEIGHT, getHeight: () => VARIABLE_ROW_HEIGHT },
			[
				column(VariableNameRenderer.ID, localize('voltDevtools.col.name', "Name"), 3, 120),
				column(VariableDefaultRenderer.ID, localize('voltDevtools.col.default', "Default"), 1, 64),
				column(VariableValueRenderer.ID, localize('voltDevtools.col.value', "Value"), 1, 64),
			],
			[new VariableNameRenderer(), new VariableDefaultRenderer(), new VariableValueRenderer(this)],
			{
				identityProvider: { getId: (token: IVoltLookToken) => token.id },
				accessibilityProvider: { getAriaLabel: (token: IVoltLookToken) => token.id, getWidgetAriaLabel: () => localize('voltDevtools.variables', "Variables") },
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				openOnSingleClick: false,
			}));

		this._register(this.customize.onDidChange(() => this.refresh()));
		this._register(this.slotService.onDidChange(() => this.refresh()));
		this.refresh();
	}

	override async setInput(input: VoltDevtoolsInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.refresh();
	}

	private renderTabs(): void {
		this.tabsStore.clear();
		clearNode(this.tabs);
		// Inspect element: point at something in the window to select its layer.
		const pick = this.pickButton = append(this.tabs, $('button.volt-devtools-tab.icon')) as HTMLButtonElement;
		pick.type = 'button';
		pick.appendChild(renderIcon(Codicon.inspect));
		const pickLabel = localize('voltDevtools.inspect', "Inspect an element in the window (Esc to stop)");
		pick.setAttribute('aria-label', pickLabel);
		pick.title = pickLabel;
		pick.classList.toggle('active', this.picking);
		pick.setAttribute('aria-pressed', String(this.picking));
		this.tabsStore.add(addDisposableListener(pick, 'click', () => this.togglePicking()));
		const tab = (id: 'layers' | 'variables', label: string) => {
			const button = append(this.tabs, $('button.volt-devtools-tab')) as HTMLButtonElement;
			button.type = 'button';
			button.textContent = label;
			button.classList.toggle('active', this.tab === id);
			button.setAttribute('aria-pressed', String(this.tab === id));
			this.tabsStore.add(addDisposableListener(button, 'click', () => {
				this.tab = id;
				this.renderTabs();
				this.syncTab();
			}));
		};
		tab('layers', localize('voltDevtools.layersTab', "Layers"));
		tab('variables', localize('voltDevtools.variablesTab', "Variables"));
		const playground = this.customize.playground;
		if (playground?.role === 'develop' && !this.customize.previewElsewhere) {
			const spacer = append(this.tabs, $('span.spacer'));
			spacer.setAttribute('aria-hidden', 'true');
			const popOut = this.tabsStore.add(createVoltButton(this.tabs, 'ghost'));
			popOut.label = localize('voltDevtools.popOut', "Pop Out Preview");
			this.tabsStore.add(popOut.onDidClick(() => void this.customize.openPreviewWindow()));
		}
	}

	private syncTab(): void {
		this.layersView.classList.toggle('hidden', this.tab !== 'layers');
		this.variablesView.classList.toggle('hidden', this.tab !== 'variables');
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	private refresh(): void {
		if (!this.tree) {
			return;
		}
		this.renderTabs();
		const elements = this.layerElements();
		this.nodesById.clear();
		const index = (items: readonly ITreeElement<LayerNode>[]) => {
			for (const item of items) {
				this.nodesById.set(item.element.id, item.element);
				index([...(item.children ?? [])]);
			}
		};
		index(elements);
		// Keep the selection on the same layer across a rebuild (a saved file redraws the tree).
		const selectedId = this.selected?.id;
		this.tree.setChildren(null, elements);
		if (selectedId && this.nodesById.has(selectedId)) {
			this.selected = this.nodesById.get(selectedId);
			this.tree.setSelection([this.selected!]);
		}
		if (VoltDevtoolsEditor.pendingReveal) {
			const id = VoltDevtoolsEditor.pendingReveal;
			VoltDevtoolsEditor.pendingReveal = undefined;
			this.reveal(id);
		}
		this.variables.splice(0, this.variables.length, [...VOLT_LOOK_TOKENS]);
		this.syncTab();
		this.renderInspector();
	}

	private layerElements(): ITreeElement<LayerNode>[] {
		const placement = this.slotService.placement;
		const item = (itemId: string, slot: VoltSlotId): ITreeElement<LayerNode> => ({ element: { kind: 'item', id: `item:${itemId}`, itemId, slot } });
		const part = (entry: IVoltCustomizePart): ITreeElement<LayerNode> => ({
			element: { kind: 'part', id: `part:${entry.id}`, part: entry },
			collapsed: false,
			children: [
				...(entry.slot ? placement[entry.slot].map(itemId => item(itemId, entry.slot!)) : []),
				...(entry.children ?? []).map(part),
			],
		});
		const plugin = (kind: 'layout' | 'look') => (entry: { id: string; label: string; source: string }): ITreeElement<LayerNode> => ({
			element: { kind: 'plugin', id: `${kind}:${entry.id}`, label: entry.label, detail: `${kind} · ${entry.id}`, icon: kind === 'layout' ? Codicon.layout : Codicon.symbolColor },
		});
		const bySource = (source: string) => [
			...this.customize.layouts.filter(entry => sourceGroup(entry.source) === source).map(plugin('layout')),
			...this.customize.looks.filter(entry => sourceGroup(entry.source) === source).map(plugin('look')),
		];
		return [
			{ element: { kind: 'group', id: 'group:window', label: localize('voltDevtools.window', "Agent window"), icon: Codicon.window }, collapsed: false, children: VOLT_CUSTOMIZE_PARTS.map(part) },
			{ element: { kind: 'group', id: 'group:hidden', label: localize('voltDevtools.hidden', "Hidden buttons"), icon: Codicon.eyeClosed }, collapsed: false, children: placement.hidden.map(itemId => item(itemId, 'hidden')) },
			// Buttons with no slot of their own (the activity bar's views): pick a slot for one to show it.
			{ element: { kind: 'group', id: 'group:more', label: localize('voltDevtools.more', "More buttons (not shown)"), icon: Codicon.add }, collapsed: false, children: unplacedVoltSlotItems(placement).map(itemId => item(itemId, 'hidden')) },
			{
				element: { kind: 'group', id: 'group:plugins', label: localize('voltDevtools.plugins', "Plugins"), icon: Codicon.extensions }, collapsed: false, children: [
					{ element: { kind: 'group', id: 'group:volt', label: localize('voltDevtools.core', "Volt"), icon: Codicon.zap }, collapsed: true, children: bySource('volt') },
					{ element: { kind: 'group', id: 'group:extensions', label: localize('voltDevtools.extensions', "Extensions"), icon: Codicon.extensions }, collapsed: false, children: bySource('extension') },
					{ element: { kind: 'group', id: 'group:home', label: localize('voltDevtools.yours', "Yours (~/.volt/customize)"), icon: Codicon.home }, collapsed: false, children: bySource('home') },
				],
			},
		];
	}

	/**
	 * Shows a part (its chip's id: `composer`, `volt.settings`, `layout:home/desk`) on the Layers
	 * tab: selected, scrolled to, outlined in the window for a moment.
	 */
	reveal(id: string): boolean {
		const node = this.nodesById.get(`part:${id}`) ?? this.nodesById.get(`item:${id}`) ?? this.nodesById.get(id);
		if (!node) {
			return false;
		}
		if (this.tab !== 'layers') {
			this.tab = 'layers';
			this.renderTabs();
			this.syncTab();
		}
		this.selectNode(node);
		this.highlight(node);
		this.flash.value = disposableTimeout(() => this.highlight(undefined), 1200);
		return true;
	}

	private selectNode(node: LayerNode): void {
		this.tree.setSelection([node]);
		this.tree.setFocus([node]);
		this.tree.reveal(node);
		this.tree.domFocus();
	}

	// --- Inspect element ---

	/** Picks a part by pointing at it in the window, like a browser's element picker. Esc stops. */
	private togglePicking(): void {
		if (this.picking) {
			this.stopPicking();
		} else {
			this.startPicking();
		}
	}

	private startPicking(): void {
		this.picking = true;
		this.pickButton?.classList.add('active');
		this.pickButton?.setAttribute('aria-pressed', 'true');
		let hovered: LayerNode | undefined;
		for (const container of this.layoutService.containers) {
			container.classList.add('volt-devtools-picking');
			const inDevtools = (target: EventTarget | null) => target instanceof Element && !!target.closest('.volt-devtools');
			this.pickStore.add(addDisposableListener(container, 'mousemove', e => {
				if (inDevtools(e.target)) {
					return;
				}
				hovered = this.nodeAt(e.target);
				this.highlight(hovered);
			}, true));
			// Nothing under the pointer reacts while picking: the press picks.
			for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
				this.pickStore.add(addDisposableListener(container, type, e => {
					if (!inDevtools(e.target)) {
						e.preventDefault();
						e.stopPropagation();
					}
				}, true));
			}
			this.pickStore.add(addDisposableListener(container, 'click', e => {
				if (inDevtools(e.target)) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				const node = this.nodeAt(e.target) ?? hovered;
				this.stopPicking();
				if (node) {
					if (this.tab !== 'layers') {
						this.tab = 'layers';
						this.renderTabs();
						this.syncTab();
					}
					this.selectNode(node);
				}
			}, true));
			this.pickStore.add(addDisposableListener(container, 'keydown', e => {
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					this.stopPicking();
				}
			}, true));
		}
	}

	private stopPicking(): void {
		this.picking = false;
		this.pickStore.clear();
		this.highlight(undefined);
		this.pickButton?.classList.remove('active');
		this.pickButton?.setAttribute('aria-pressed', 'false');
		for (const container of this.layoutService.containers) {
			container.classList.remove('volt-devtools-picking');
		}
	}

	/** The innermost layer at an element: a Volt button if it is one, else the nearest part. */
	private nodeAt(target: EventTarget | null): LayerNode | undefined {
		if (!(target instanceof Element)) {
			return undefined;
		}
		const item = target.closest('[data-volt-item]');
		const itemNode = item ? this.nodesById.get(`item:${item.getAttribute('data-volt-item')}`) : undefined;
		if (itemNode) {
			return itemNode;
		}
		let best: { node: LayerNode; depth: number } | undefined;
		for (const part of allVoltCustomizeParts()) {
			const element = target.closest(part.selector);
			if (!element) {
				continue;
			}
			let depth = 0;
			for (let at: Element | null = target; at && at !== element; at = at.parentElement) {
				depth++;
			}
			const node = this.nodesById.get(`part:${part.id}`);
			// The closest element wins; on a tie the more specific (later, deeper) part.
			if (node && (!best || depth <= best.depth)) {
				best = { node, depth };
			}
		}
		return best?.node;
	}

	/** Outlines what a layer stands for in the window (cleared when the pointer leaves). */
	highlight(node: LayerNode | undefined): void {
		for (const element of this.highlighted) {
			element.classList.remove('volt-devtools-highlight');
		}
		this.highlighted = [];
		const selector = node ? nodeSelector(node) : undefined;
		if (!selector) {
			return;
		}
		for (const container of this.layoutService.containers) {
			for (const element of Array.from(container.querySelectorAll(selector)).slice(0, 24)) {
				element.classList.add('volt-devtools-highlight');
				this.highlighted.push(element);
			}
		}
	}

	/** The layer's config as a snippet: what a hover shows. */
	snippet(node: LayerNode): MarkdownString {
		const md = new MarkdownString(undefined, { supportThemeIcons: true });
		md.appendMarkdown(`**${nodeLabel(node)}**\n\n`);
		if (node.kind === 'part') {
			md.appendMarkdown(`${node.part.description}\n\n`);
			const tokens: Record<string, unknown> = {};
			for (const id of node.part.tokens ?? []) {
				tokens[id] = this.customize.lookValue('token', id);
			}
			const colors: Record<string, unknown> = {};
			for (const id of node.part.colors ?? []) {
				colors[id] = this.customize.lookValue('color', id) ?? '(theme)';
			}
			md.appendCodeblock('jsonc', JSON.stringify({ element: node.part.selector, tokens, colors, layout: node.part.layout, slot: node.part.slot }, undefined, 2));
		} else if (node.kind === 'item') {
			const item = VOLT_SLOT_ITEMS.find(entry => entry.id === node.itemId);
			md.appendMarkdown(`${item?.description ?? ''}\n\n`);
			md.appendCodeblock('jsonc', JSON.stringify({ item: node.itemId, slot: node.slot, defaultSlot: item?.defaultSlot }, undefined, 2));
		} else if (node.kind === 'plugin') {
			md.appendMarkdown(node.detail);
		}
		md.appendMarkdown(`\n\n_${localize('voltDevtools.dragHint', "Drag into the chat to ask the agent about it.")}_`);
		return md;
	}

	/** The chip a layer becomes in the composer. */
	contextFor(node: LayerNode): IVoltContextDrag | undefined {
		switch (node.kind) {
			case 'part': return { label: node.part.label, value: voltPartContext(node.part, setting => this.configurationService.getValue(setting), node.part.slot ? this.slotService.placement[node.part.slot] : undefined) };
			case 'item': return { label: nodeLabel(node), value: voltSlotItemContext(node.itemId, node.slot) };
			case 'plugin': return { label: node.label, value: `<volt_part id="${node.id}" label="${node.label}">\n${node.detail}. Change it by writing your own file that "extends" it (see AGENTS.md).\n</volt_part>` };
			default: return undefined;
		}
	}

	/** Adds the layer to the chat on screen as a chip. */
	private addToChat(node: LayerNode): void {
		const drag = this.contextFor(node);
		if (!drag) {
			return;
		}
		for (const pane of this.editorService.visibleEditorPanes) {
			const chat = pane as unknown as { addContextMention?(label: string, value: string): boolean };
			if (typeof chat.addContextMention === 'function' && chat.addContextMention(drag.label, drag.value)) {
				return;
			}
		}
	}

	private renderInspector(): void {
		this.inspectorStore.clear();
		clearNode(this.inspector);
		const node = this.selected;
		if (!node || node.kind === 'group') {
			append(this.inspector, $('.volt-devtools-empty')).textContent = localize('voltDevtools.pick', "Pick a layer to see and change what styles it. Drag a layer into the chat to ask the agent about it.");
			return;
		}
		const head = append(this.inspector, $('.volt-devtools-inspector-head'));
		append(head, $('.title')).textContent = nodeLabel(node);
		append(head, $('.detail')).textContent = nodeDetail(node);
		const add = this.inspectorStore.add(createVoltButton(head, 'secondary'));
		add.label = localize('voltDevtools.addToChat', "Add to Chat");
		this.inspectorStore.add(add.onDidClick(() => this.addToChat(node)));

		if (node.kind === 'item') {
			this.renderSlotControls(node);
			return;
		}
		if (node.kind !== 'part') {
			return;
		}
		append(this.inspector, $('.volt-devtools-desc')).textContent = node.part.description;
		const tokens = (node.part.tokens ?? []).filter(id => voltLookToken(id));
		if (tokens.length) {
			append(this.inspector, $('.volt-devtools-section')).textContent = localize('voltDevtools.tokens', "Sizes");
			for (const id of tokens) {
				this.renderTokenRow(id);
			}
		}
		const aliases = (node.part.tokens ?? []).filter(id => voltLookAlias(id));
		for (const id of aliases) {
			const row = append(this.inspector, $('.volt-devtools-prop'));
			append(row, $('span.name')).textContent = id;
			append(row, $('span.readonly')).textContent = String(this.customize.lookValue('token', id) ?? '');
		}
		if (node.part.colors?.length) {
			append(this.inspector, $('.volt-devtools-section')).textContent = localize('voltDevtools.colors', "Colors");
			for (const id of node.part.colors) {
				this.renderColorRow(id);
			}
		}
		if (node.part.layout?.length) {
			append(this.inspector, $('.volt-devtools-section')).textContent = localize('voltDevtools.layoutFields', "Layout");
			append(this.inspector, $('.volt-devtools-desc')).textContent = localize('voltDevtools.layoutHint', "Placed by layout.json: {0}. Ask the agent, or edit the file.", node.part.layout.join(', '));
		}
	}

	private renderTokenRow(id: string): void {
		const token = voltLookToken(id)!;
		const row = append(this.inspector, $('.volt-devtools-prop'));
		const name = append(row, $('span.name'));
		name.textContent = id;
		name.title = `${id}: ${token.description}`;
		const box = this.inspectorStore.add(new InputBox(append(row, $('.input')), this.contextViewService, { type: 'number', ariaLabel: id, inputBoxStyles: defaultInputBoxStyles }));
		box.inputElement.step = token.unit === 'px' ? '1' : '0.05';
		box.inputElement.min = String(token.minimum);
		box.inputElement.max = String(token.maximum);
		box.value = String(clampVoltLookValue(token, this.customize.lookValue('token', id)) ?? token.default);
		this.inspectorStore.add(addStepper(box.element, box.inputElement));
		append(row, $('span.unit')).textContent = token.unit === 'px' ? 'px' : '';
		this.inspectorStore.add(addDisposableListener(box.inputElement, 'change', () => void this.customize.setLookValue('token', id, clampVoltLookValue(token, box.value))));
		const reset = this.inspectorStore.add(createVoltButton(row, 'ghost'));
		reset.label = localize('voltDevtools.reset', "Reset");
		this.inspectorStore.add(reset.onDidClick(() => void this.customize.setLookValue('token', id, undefined)));
	}

	private renderColorRow(id: string): void {
		const row = append(this.inspector, $('.volt-devtools-prop'));
		append(row, $('span.name')).textContent = id;
		const current = this.customize.lookValue('color', id);
		const swatch = append(row, $('span.swatch'));
		swatch.style.background = typeof current === 'string' ? current : `var(--vscode-${id.replace(/\./g, '-')})`;
		const box = this.inspectorStore.add(new InputBox(append(row, $('.input')), this.contextViewService, { placeholder: localize('voltDevtools.theme', "theme"), ariaLabel: id, inputBoxStyles: defaultInputBoxStyles }));
		box.value = typeof current === 'string' ? current : '';
		this.inspectorStore.add(addDisposableListener(box.inputElement, 'change', () => {
			const value = box.value.trim();
			if (!value || /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
				void this.customize.setLookValue('color', id, value || undefined);
			}
		}));
	}

	/** A button: which slot it sits in, changed right here (the draft's layout.json `slots`). */
	private renderSlotControls(node: Extract<LayerNode, { kind: 'item' }>): void {
		const item = VOLT_SLOT_ITEMS.find(entry => entry.id === node.itemId);
		append(this.inspector, $('.volt-devtools-desc')).textContent = item?.description ?? '';
		const row = append(this.inspector, $('.volt-devtools-prop'));
		append(row, $('span.name')).textContent = localize('voltDevtools.slot', "Slot");
		createVoltDropdown(append(row, $('.input')), this.contextViewService, {
			options: VOLT_SLOTS.map(slot => ({ id: slot.id, label: slot.label, description: slot.description })),
			value: node.slot,
			ariaLabel: localize('voltDevtools.slot', "Slot"),
			onChange: slot => void this.customize.moveSlotItem(node.itemId, slot),
		}, this.inspectorStore);
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		const tabsHeight = this.tabs?.offsetHeight ?? 32;
		const height = Math.max(0, dimension.height - tabsHeight);
		// Wide enough: layers beside the inspector; narrow: layers above it.
		const sideBySide = dimension.width >= 560;
		this.layersView?.classList.toggle('side', sideBySide);
		if (sideBySide !== this.sideBySide) {
			this.sideBySide = sideBySide;
			this.createSash(sideBySide);
		}
		if (this.tab === 'layers') {
			const first = this.treeSize(sideBySide ? dimension.width : height);
			if (sideBySide) {
				this.treeHost.style.width = `${first}px`;
				this.treeHost.style.height = `${height}px`;
				this.inspector.style.height = `${height}px`;
				this.tree?.layout(height, first);
			} else {
				this.treeHost.style.width = '';
				this.treeHost.style.height = `${first}px`;
				this.inspector.style.height = `${height - first}px`;
				this.tree?.layout(first, dimension.width);
			}
			this.sash?.layout();
		} else {
			this.variablesView.style.height = `${height}px`;
			this.variables?.layout(height, dimension.width);
		}
	}

	/** The tree's size along the split, leaving both sides at least MIN_PANE_SIZE. */
	private treeSize(total: number): number {
		return Math.max(Math.min(MIN_PANE_SIZE, total / 2), Math.min(total - MIN_PANE_SIZE, Math.round(total * this.split)));
	}

	/** A sash between the layers and the inspector; double-click puts it back. */
	private createSash(sideBySide: boolean): void {
		const total = () => sideBySide ? this.dimension?.width ?? 0 : Math.max(0, (this.dimension?.height ?? 0) - (this.tabs?.offsetHeight ?? 0));
		const disposables = new DisposableStore();
		const position = () => this.treeSize(total());
		const sash = disposables.add(sideBySide
			? new Sash(this.layersView, { getVerticalSashLeft: position }, { orientation: Orientation.VERTICAL })
			: new Sash(this.layersView, { getHorizontalSashTop: position }, { orientation: Orientation.HORIZONTAL }));
		let start = 0;
		disposables.add(sash.onDidStart(() => start = this.treeSize(total())));
		disposables.add(sash.onDidChange(e => {
			const size = total();
			if (size > 0 && this.dimension) {
				this.split = clampSplit((start + (sideBySide ? e.currentX - e.startX : e.currentY - e.startY)) / size);
				this.layout(this.dimension);
			}
		}));
		disposables.add(sash.onDidEnd(() => this.storage.store(SPLIT_STORAGE_KEY, this.split, StorageScope.PROFILE, StorageTarget.USER)));
		disposables.add(sash.onDidReset(() => {
			this.split = DEFAULT_SPLIT;
			this.storage.remove(SPLIT_STORAGE_KEY, StorageScope.PROFILE);
			if (this.dimension) {
				this.layout(this.dimension);
			}
		}));
		this.sashStore.value = disposables;
		this.sash = sash;
	}

	override clearInput(): void {
		this.stopPicking();
		this.highlight(undefined);
		super.clearInput();
	}
}

function sourceGroup(source: string): 'volt' | 'home' | 'extension' {
	return source === 'volt' ? 'volt' : source === 'home' ? 'home' : 'extension';
}
