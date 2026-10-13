/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentTerminals.css';
import { $, addDisposableListener, append, Dimension, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { DataTransfers } from '../../../../../base/browser/dnd.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Action, Separator } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableMap, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import Severity from '../../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IMenu, IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ConfirmResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { TerminalExitReason, TerminalLocation, TerminalSettingId } from '../../../../../platform/terminal/common/terminal.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorExtensions, EditorInputCapabilities, GroupModelChangeKind, IEditorFactoryRegistry, IEditorIdentifier, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput, IEditorCloseHandler } from '../../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { isTerminalLive } from '../../../../services/voltRuntime/common/terminalTools.js';
import { ISerializedTerminalEditorInput, ITerminalConfigurationService, ITerminalEditorService, ITerminalInstance, ITerminalInstanceService, TerminalDataTransfers } from '../../../terminal/browser/terminal.js';
import { openContextMenu } from '../../../terminal/browser/terminalContextMenu.js';
import { TerminalEditorInput } from '../../../terminal/browser/terminalEditorInput.js';
import { ConfirmOnKill } from '../../../terminal/common/terminal.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createAgentTerminalIcon } from './agentTerminalIcon.js';
import { describeAgentTerminalStatus, IAgentTerminalsService, isAgentTerminal } from './agentTerminals.js';

export const AGENT_TERMINALS_EDITOR_ID = 'workbench.editor.voltAgentTerminals';
const AGENT_TERMINALS_INPUT_ID = 'workbench.input.voltAgentTerminals';
const AGENT_TERMINALS_SCHEME = 'volt-agent-terminals';
/** The list's width beside the terminal, shared by every Terminals tab. */
const LIST_WIDTH_KEY = 'volt.agent.terminals.listWidth';
const DEFAULT_LIST_WIDTH = 160;
const MIN_LIST_WIDTH = 96;
/** The terminal keeps at least this much when the list is dragged wider. */
const MIN_TERMINAL_WIDTH = 200;

/**
 * A chat's terminals in one tab, as the panel keeps them: the one in front fills the tab and a
 * list on the right switches between them once there are two. A new terminal joins this tab; it
 * gets a tab of its own only when the user drags it out of the list (or asks from its menu).
 */
export class AgentTerminalsEditorInput extends EditorInput implements IEditorCloseHandler {

	static readonly TypeID = AGENT_TERMINALS_INPUT_ID;

	override readonly closeHandler = this;
	readonly resource = URI.from({ scheme: AGENT_TERMINALS_SCHEME, path: `/${generateUuid()}` });

	private readonly _instances: ITerminalInstance[] = [];
	private _active: ITerminalInstance | undefined;
	private readonly listeners = this._register(new DisposableMap<ITerminalInstance>());
	private readonly _onDidChangeInstances = this._register(new Emitter<void>());
	/** A terminal joined, left, or came to the front, or one's title or state changed. */
	readonly onDidChangeInstances = this._onDidChangeInstances.event;
	private shuttingDown = false;

	constructor(
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		// A reload detaches the processes (each terminal's own editor input does that) to attach them again.
		this._register(lifecycleService.onWillShutdown(() => this.shuttingDown = true));
		this._register(this.terminalEditorService.onDidChangeInstances(() => this.prune()));
	}

	override get typeId(): string {
		return AgentTerminalsEditorInput.TypeID;
	}

	override get editorId(): string | undefined {
		return AGENT_TERMINALS_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// One view at a time: a terminal draws in one place, so a split moves the tab rather than copying it.
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		const count = this._instances.length;
		return count > 1
			? localize('voltAgent.terminals.tabMany', "Terminals ({0})", count)
			: this._active?.title || localize('voltAgent.terminals.tab', "Terminal");
	}

	override getIcon(): ThemeIcon {
		return Codicon.terminal;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other === this || (other instanceof AgentTerminalsEditorInput && other.resource.toString() === this.resource.toString());
	}

	get instances(): readonly ITerminalInstance[] {
		return this._instances;
	}

	get activeInstance(): ITerminalInstance | undefined {
		return this._active;
	}

	/** Adds a terminal to the tab; `activate` brings it to the front. Its process is untouched. */
	add(instance: ITerminalInstance, activate = true): void {
		if (instance.isDisposed || this.isDisposed()) {
			return;
		}
		if (!this._instances.includes(instance)) {
			// Known to the terminal editors (but not opened): dragging it out finds it, and a reload keeps its process.
			this.terminalEditorService.resolveResource(instance);
			this._instances.push(instance);
			const store = new DisposableStore();
			store.add(instance.onDisposed(() => this.remove(instance)));
			store.add(instance.onTitleChanged(() => this.changed()));
			store.add(instance.onExit(() => this.changed()));
			this.listeners.set(instance, store);
		}
		if (activate || !this._active) {
			this._active = instance;
		}
		this.changed();
	}

	/** Takes a terminal out of the tab without ending it. An empty tab closes. */
	remove(instance: ITerminalInstance): boolean {
		const index = this._instances.indexOf(instance);
		if (index < 0) {
			return false;
		}
		this._instances.splice(index, 1);
		this.listeners.deleteAndDispose(instance);
		if (this._active === instance) {
			this._active = this._instances[Math.min(index, this._instances.length - 1)];
		}
		this.changed();
		if (!this._instances.length) {
			// After the change that emptied it has run its course (a drag out is still opening its tab).
			setTimeout(() => {
				if (!this._instances.length && !this.isDisposed()) {
					this.dispose();
				}
			}, 0);
		}
		return true;
	}

	setActive(instance: ITerminalInstance): void {
		if (this._active !== instance && this._instances.includes(instance)) {
			this._active = instance;
			this.changed();
		}
	}

	/** Drops terminals that left: ended, moved to the panel, or opened in a tab of their own. */
	prune(): void {
		for (const instance of [...this._instances]) {
			if (instance.isDisposed || instance.target !== TerminalLocation.Editor || this.isOpenInOwnTab(instance)) {
				this.remove(instance);
			}
		}
	}

	isOpenInOwnTab(instance: ITerminalInstance): boolean {
		return this.editorGroupsService.groups.some(group => group.editors.some(editor => editor instanceof TerminalEditorInput && editor.terminalInstance === instance));
	}

	private changed(): void {
		this._onDidChangeInstances.fire();
		this._onDidChangeLabel.fire();
	}

	showConfirm(): boolean {
		if (this.shuttingDown) {
			return false;
		}
		const confirmOnKill = this.configurationService.getValue<ConfirmOnKill>(TerminalSettingId.ConfirmOnKill);
		return (confirmOnKill === 'editor' || confirmOnKill === 'always') && this._instances.some(instance => !isAgentTerminal(instance) && instance.hasChildProcesses);
	}

	async confirm(_editors: ReadonlyArray<IEditorIdentifier>): Promise<ConfirmResult> {
		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Warning,
			message: localize('voltAgent.terminals.confirmKill', "Do you want to terminate running processes?"),
			primaryButton: localize({ key: 'voltAgent.terminals.confirmKillButton', comment: ['&& denotes a mnemonic'] }, "&&Terminate"),
			detail: localize('voltAgent.terminals.confirmKillDetail', "Closing will terminate the running processes in these terminals. Terminals the agent started keep running."),
		});
		return confirmed ? ConfirmResult.DONT_SAVE : ConfirmResult.CANCEL;
	}

	/**
	 * Closing the tab ends the user's terminals, as closing a terminal tab does. The agent's keep
	 * running: they are still its chips, and a chip click shows them here again.
	 */
	override dispose(): void {
		const instances = this._instances.splice(0);
		this.listeners.clearAndDisposeAll();
		this._active = undefined;
		if (!this.shuttingDown) {
			for (const instance of instances) {
				if (instance.isDisposed) {
					continue;
				}
				if (isAgentTerminal(instance)) {
					if (instance.domElement.parentElement) {
						instance.detachFromElement();
					}
				} else {
					instance.dispose(TerminalExitReason.User);
				}
			}
		}
		super.dispose();
	}
}

interface ISerializedAgentTerminals {
	readonly terminals: readonly ISerializedTerminalEditorInput[];
	readonly active?: number;
}

/** The user's terminals come back after a reload, attached to the processes the pty host kept. */
export class AgentTerminalsEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: EditorInput): boolean {
		return input instanceof AgentTerminalsEditorInput && input.instances.some(persists);
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof AgentTerminalsEditorInput)) {
			return undefined;
		}
		const kept = input.instances.filter(persists);
		if (!kept.length) {
			return undefined;
		}
		const active = input.activeInstance ? kept.indexOf(input.activeInstance) : -1;
		const value: ISerializedAgentTerminals = { terminals: kept.map(toSerialized), ...(active >= 0 ? { active } : {}) };
		return JSON.stringify(value);
	}

	deserialize(instantiationService: IInstantiationService, raw: string): EditorInput | undefined {
		let value: ISerializedAgentTerminals;
		try {
			value = JSON.parse(raw) as ISerializedAgentTerminals;
		} catch {
			return undefined;
		}
		if (!Array.isArray(value?.terminals) || !value.terminals.length) {
			return undefined;
		}
		const instances = instantiationService.invokeFunction(accessor => accessor.get(ITerminalInstanceService));
		const input = instantiationService.createInstance(AgentTerminalsEditorInput);
		value.terminals.forEach((terminal, index) => {
			const instance = instances.createInstance({ attachPersistentProcess: { ...terminal, findRevivedId: true } }, TerminalLocation.Editor);
			input.add(instance, index === (value.active ?? 0));
		});
		if (!input.instances.length) {
			input.dispose();
			return undefined;
		}
		return input;
	}
}

function persists(instance: ITerminalInstance): boolean {
	return !instance.isDisposed && typeof instance.persistentProcessId === 'number' && instance.shouldPersist;
}

/** As `TerminalInputSerializer` writes a terminal tab. */
function toSerialized(instance: ITerminalInstance): ISerializedTerminalEditorInput {
	return {
		id: instance.persistentProcessId!,
		pid: instance.processId || 0,
		title: instance.title,
		titleSource: instance.titleSource,
		cwd: '',
		icon: instance.icon,
		color: instance.color,
		hasChildProcesses: instance.hasChildProcesses,
		isFeatureTerminal: instance.shellLaunchConfig.isFeatureTerminal,
		hideFromUser: instance.shellLaunchConfig.hideFromUser,
		reconnectionProperties: instance.shellLaunchConfig.reconnectionProperties,
		shellIntegrationNonce: instance.shellIntegrationNonce,
	};
}

interface IListRow {
	readonly element: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly store: DisposableStore;
	agent: boolean | undefined;
}

/**
 * Shows a {@link AgentTerminalsEditorInput}: the terminal in front, and the list of the tab's
 * terminals on the right (the agent's marked with Volt's terminal icon). Rows switch, drag out to
 * a tab of their own, and end their terminal from the trash button or the row's menu.
 */
export class AgentTerminalsEditor extends EditorPane {

	static readonly ID = AGENT_TERMINALS_EDITOR_ID;

	private root!: HTMLElement;
	private view!: HTMLElement;
	/** Where terminals attach; the terminal styles key off `.terminal-editor`. */
	private guard!: HTMLElement;
	private sash!: HTMLElement;
	private list!: HTMLElement;
	private readonly rowData = new Map<ITerminalInstance, IListRow>();
	private readonly inputStore = this._register(new DisposableStore());
	private readonly shownStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly instanceMenu: IMenu;
	/** The terminal attached to this pane now. */
	private shown: ITerminalInstance | undefined;
	private dimension: Dimension | undefined;
	private listWidth: number;
	private dragging = false;
	private cancelContextMenu = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@ITerminalConfigurationService private readonly terminalConfigurationService: ITerminalConfigurationService,
		@IAgentTerminalsService private readonly agentTerminals: IAgentTerminalsService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(AgentTerminalsEditor.ID, group, telemetryService, themeService, storage);
		this.instanceMenu = this._register(menuService.createMenu(MenuId.TerminalInstanceContext, contextKeyService));
		this.listWidth = storage.getNumber(LIST_WIDTH_KEY, StorageScope.APPLICATION, DEFAULT_LIST_WIDTH);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-agent-terminals'));
		this.view = append(this.root, $('.volt-agent-terminals-view'));
		this.guard = append(this.view, $('.terminal-overflow-guard.terminal-editor'));
		this.sash = append(this.root, $('.volt-agent-terminals-sash'));
		this.list = append(this.root, $('.volt-agent-terminals-list'));
		this.list.setAttribute('role', 'listbox');
		this.list.setAttribute('aria-label', localize('voltAgent.terminals.list', "Terminals"));
		this.registerTerminalMouse();
		this._register(addDisposableListener(this.sash, 'pointerdown', e => this.beginResize(e)));
		// A row dropped on this group's tab bar opens as a tab here: it leaves the list at once.
		this._register(this.group.onDidModelChange(e => {
			if (e.kind === GroupModelChangeKind.EDITOR_OPEN && e.editor instanceof TerminalEditorInput) {
				this.terminalsInput()?.prune();
			}
		}));
	}

	override async setInput(input: AgentTerminalsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		this.inputStore.add(input.onDidChangeInstances(() => this.render()));
		// The agent's terminals show their state on their row.
		this.inputStore.add(this.agentTerminals.onDidChange(() => this.renderList()));
		input.prune();
		this.render();
	}

	override clearInput(): void {
		this.inputStore.clear();
		this.detachShown();
		this.clearRows();
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.shown?.focus(true);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (this.shown && this.ownsShown()) {
			this.shown.setVisible(visible);
		}
	}

	layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.layoutParts();
	}

	private terminalsInput(): AgentTerminalsEditorInput | undefined {
		return this.input instanceof AgentTerminalsEditorInput ? this.input : undefined;
	}

	private render(): void {
		const active = this.terminalsInput()?.activeInstance;
		if (this.shown !== active) {
			this.detachShown();
			if (active) {
				this.attach(active);
			}
		}
		this.renderList();
		this.layoutParts();
	}

	private attach(instance: ITerminalInstance): void {
		this.shown = instance;
		const store = new DisposableStore();
		this.shownStore.value = store;
		instance.setParentContextKeyService(this.group.scopedContextKeyService);
		instance.attachToElement(this.guard);
		instance.setVisible(this.isVisible());
		// As a terminal tab does: focus makes it the active terminal, so its commands and keys reach it.
		store.add(instance.onDidFocus(() => this.terminalEditorService.setActiveInstance(instance)));
		if (this.isVisible() && this.group.isActive(this.input!)) {
			this.terminalEditorService.setActiveInstance(instance);
		}
	}

	/** This pane still holds the shown terminal: it has not been opened in a tab of its own. */
	private ownsShown(): boolean {
		return !!this.shown && !this.shown.isDisposed && this.shown.domElement.parentElement === this.guard;
	}

	private detachShown(): void {
		const instance = this.shown;
		const owned = this.ownsShown();
		this.shown = undefined;
		this.shownStore.clear();
		if (instance && owned) {
			instance.detachFromElement();
			instance.setVisible(false);
		}
	}

	private layoutParts(): void {
		const dimension = this.dimension;
		if (!dimension || !this.root) {
			return;
		}
		const withList = this.root.classList.contains('has-list');
		const listWidth = withList ? this.clampListWidth(dimension.width) : 0;
		this.root.style.setProperty('--volt-agent-terminals-list-width', `${listWidth}px`);
		if (this.ownsShown()) {
			this.shown!.layout({ width: Math.max(0, dimension.width - listWidth), height: dimension.height });
		}
	}

	private clampListWidth(total: number): number {
		return Math.max(MIN_LIST_WIDTH, Math.min(this.listWidth, total - MIN_TERMINAL_WIDTH));
	}

	// --- The list ----------------------------------------------------------------------------------

	private renderList(): void {
		const input = this.terminalsInput();
		const instances = input?.instances ?? [];
		this.root.classList.toggle('has-list', instances.length > 1);
		for (const [instance, row] of [...this.rowData]) {
			if (!instances.includes(instance)) {
				row.element.remove();
				row.store.dispose();
				this.rowData.delete(instance);
			}
		}
		const order = instances.map(instance => this.rowFor(instance).element);
		// Moving a row while it is being dragged ends the drag: rows only move between drags.
		const children = [...this.list.children];
		if (!this.dragging && (children.length !== order.length || order.some((element, index) => children[index] !== element))) {
			for (const element of order) {
				this.list.appendChild(element);
			}
		}
		for (const instance of instances) {
			this.updateRow(instance, this.rowFor(instance), instance === input?.activeInstance);
		}
	}

	private rowFor(instance: ITerminalInstance): IListRow {
		const existing = this.rowData.get(instance);
		if (existing) {
			return existing;
		}
		const store = new DisposableStore();
		const element = $('.volt-agent-terminals-row');
		element.setAttribute('role', 'option');
		element.draggable = true;
		const icon = append(element, $('span.volt-agent-terminals-row-icon'));
		const label = append(element, $('span.volt-agent-terminals-row-label'));
		append(element, $('span.volt-agent-terminals-row-dot'));
		const kill = append(element, $('button.volt-agent-terminals-row-action')) as HTMLButtonElement;
		kill.type = 'button';
		kill.appendChild(renderIcon(Codicon.trash));
		const killLabel = localize('voltAgent.terminals.kill', "Kill Terminal");
		kill.setAttribute('aria-label', killLabel);
		setAgentTooltip(kill, killLabel);
		store.add(addDisposableListener(element, 'click', () => {
			this.terminalsInput()?.setActive(instance);
			instance.focus(true);
		}));
		store.add(addDisposableListener(kill, 'click', e => {
			EventHelper.stop(e, true);
			instance.dispose(TerminalExitReason.User);
		}));
		store.add(addDisposableListener(element, 'contextmenu', e => {
			EventHelper.stop(e, true);
			this.showRowMenu(instance, e);
		}));
		store.add(addDisposableListener(element, 'dragstart', e => {
			if (!e.dataTransfer) {
				return;
			}
			this.dragging = true;
			// What the terminal panel's list puts on a drag: a tab bar or an editor area opens it as a tab.
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData(TerminalDataTransfers.Terminals, JSON.stringify([instance.resource.toString()]));
			e.dataTransfer.setData(DataTransfers.TEXT, instance.title);
			element.classList.add('dragging');
		}));
		store.add(addDisposableListener(element, 'dragend', () => {
			this.dragging = false;
			element.classList.remove('dragging');
			// Dropped in another group or window: its tab opens there after the drop.
			const window = getWindow(this.root);
			for (const delay of [0, 300]) {
				window.setTimeout(() => this.terminalsInput()?.prune(), delay);
			}
			this.renderList();
		}));
		const row: IListRow = { element, icon, label, store, agent: undefined };
		this.rowData.set(instance, row);
		return row;
	}

	private updateRow(instance: ITerminalInstance, row: IListRow, active: boolean): void {
		const info = this.agentTerminals.forInstance(instance);
		const agent = !!info || isAgentTerminal(instance);
		if (row.agent !== agent) {
			row.agent = agent;
			row.icon.replaceChildren(agent ? createAgentTerminalIcon(row.icon.ownerDocument) : renderIcon(Codicon.terminal));
			row.element.classList.toggle('agent', agent);
		}
		const title = info?.label ?? instance.title;
		if (row.label.textContent !== title) {
			row.label.textContent = title;
		}
		row.element.classList.toggle('active', active);
		row.element.setAttribute('aria-selected', String(active));
		row.element.classList.toggle('exited', instance.exitCode !== undefined && !(info && isTerminalLive(info.status)));
		if (info) {
			row.element.dataset.status = info.status;
		} else {
			delete row.element.dataset.status;
		}
		const tooltip = info
			? localize('voltAgent.terminals.agentRow', "{0} \u00b7 started by the agent ({1}) \u00b7 {2}", title, info.id, describeAgentTerminalStatus(info))
			: agent ? localize('voltAgent.terminals.agentRowDone', "{0} \u00b7 started by the agent", title) : title;
		setAgentTooltip(row.element, tooltip);
	}

	private clearRows(): void {
		for (const row of this.rowData.values()) {
			row.element.remove();
			row.store.dispose();
		}
		this.rowData.clear();
	}

	private showRowMenu(instance: ITerminalInstance, e: MouseEvent): void {
		const ownTab = new Action('volt.terminals.ownTab', localize('voltAgent.terminals.ownTab', "Move into Its Own Tab"), undefined, true, () => this.moveToOwnTab(instance));
		const kill = new Action('volt.terminals.kill', localize('voltAgent.terminals.kill', "Kill Terminal"), undefined, true, async () => instance.dispose(TerminalExitReason.User));
		const anchor = new StandardMouseEvent(getWindow(this.root), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [ownTab, new Separator(), kill],
			onHide: () => {
				ownTab.dispose();
				kill.dispose();
			},
		});
	}

	/** What dragging a row onto the tab bar does, without the drag. */
	private async moveToOwnTab(instance: ITerminalInstance): Promise<void> {
		if (instance.isDisposed) {
			return;
		}
		if (this.shown === instance) {
			this.detachShown();
		}
		this.terminalsInput()?.remove(instance);
		const editor = this.terminalEditorService.getInputFromResource(this.terminalEditorService.resolveResource(instance));
		editor.setGroup(this.group);
		await this.group.openEditor(editor, { pinned: true });
	}

	// --- Terminal mouse, as the terminal editor handles it --------------------------------------------

	private registerTerminalMouse(): void {
		this._register(addDisposableListener(this.view, 'mousedown', async (event: MouseEvent) => {
			const instance = this.shown;
			if (instance && this.ownsShown()) {
				const result = await instance.handleMouseEvent(event, this.instanceMenu);
				if (typeof result === 'object' && result.cancelContextMenu) {
					this.cancelContextMenu = true;
				}
			}
		}));
		this._register(addDisposableListener(this.view, 'contextmenu', (event: MouseEvent) => {
			const rightClickBehavior = this.terminalConfigurationService.config.rightClickBehavior;
			if (rightClickBehavior === 'nothing' && !event.shiftKey) {
				event.preventDefault();
				event.stopImmediatePropagation();
			} else if (!this.cancelContextMenu && rightClickBehavior !== 'copyPaste' && rightClickBehavior !== 'paste') {
				openContextMenu(getWindow(this.view), event, this.shown, this.instanceMenu, this.contextMenuService);
				event.preventDefault();
				event.stopImmediatePropagation();
			}
			this.cancelContextMenu = false;
		}));
	}

	// --- Resizing the list ---------------------------------------------------------------------------

	private beginResize(e: PointerEvent): void {
		if (e.button !== 0 || !this.dimension) {
			return;
		}
		EventHelper.stop(e, true);
		const sash = this.sash;
		sash.setPointerCapture(e.pointerId);
		sash.classList.add('active');
		const right = this.root.getBoundingClientRect().right;
		const store = new DisposableStore();
		store.add(addDisposableListener(sash, 'pointermove', (move: PointerEvent) => {
			const total = this.dimension?.width ?? 0;
			this.listWidth = Math.max(MIN_LIST_WIDTH, Math.min(right - move.clientX, total - MIN_TERMINAL_WIDTH));
			this.layoutParts();
		}));
		const end = () => {
			sash.classList.remove('active');
			store.dispose();
			this.storage.store(LIST_WIDTH_KEY, Math.round(this.listWidth), StorageScope.APPLICATION, StorageTarget.USER);
		};
		store.add(addDisposableListener(sash, 'pointerup', end));
		store.add(addDisposableListener(sash, 'pointercancel', end));
	}

	override dispose(): void {
		this.detachShown();
		this.clearRows();
		super.dispose();
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentTerminalsEditor, AGENT_TERMINALS_EDITOR_ID, localize('voltAgent.terminals.editorLabel', "Terminals")),
	[new SyncDescriptor(AgentTerminalsEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AgentTerminalsEditorInput.TypeID, AgentTerminalsEditorInputSerializer);
