/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSidePanel.css';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { DraggedEditorGroupIdentifier, DraggedEditorIdentifier } from '../../../browser/dnd.js';
import { IEditorPartsView } from '../../../browser/parts/editor/editor.js';
import { EditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { GroupModelChangeKind } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { AgentEditor } from './agentEditor.js';
import { AgentEditorInput } from './agentEditorInput.js';
import { SidebarEditorPart } from './sidebarEditorPart.js';

export class AgentSidePanel extends ViewPane {

	private hostEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private editorPart: EditorPart | undefined;
	private didSeedDefault = false;
	private collapsingGroups = false;
	private readonly groupListeners = this._register(new DisposableStore());
	private readonly partOptions = this._register(new MutableDisposable<IDisposable>());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		container.classList.add('volt-agent-side-panel');

		this.hostEl = append(container, $('.part.editor.volt-agent-side-host', { role: 'main' }));
		this.hostEl.style.position = 'relative';

		this.emptyEl = append(container, $('.volt-agent-empty'));
		const action = append(this.emptyEl, $('button.volt-agent-empty-action')) as HTMLButtonElement;
		action.appendChild(renderIcon(Codicon.add));
		append(action, $('span')).textContent = localize('voltAgent.sidePanel.newAgent', "New Agent");

		this._register(addDisposableListener(action, 'click', () => void this.openNewAgent()));

		const editorPartsView = this.editorGroupsService as unknown as IEditorPartsView;
		this.editorPart = this._register(this.instantiationService.createInstance(SidebarEditorPart, editorPartsView));
		this._register(editorPartsView.registerPart(this.editorPart));
		this.editorPart.create(this.hostEl, { restorePreviousState: true });
		this.applyPartOptions(false);

		this.bindAgentOnlyGroups();
		this.bindAgentOnlyDrop(container);
		this._register(this.editorPart.onDidAddGroup(() => {
			this.bindAgentOnlyGroups();
			this.syncAgentLayout();
		}));
		this._register(this.editorPart.onDidRemoveGroup(() => this.syncAgentLayout()));

		const observer = new ResizeObserver(() => this.layoutEditor());
		observer.observe(this.hostEl);
		this._register(toDisposable(() => observer.disconnect()));

		this._register(this.onDidChangeBodyVisibility(visible => {
			this.editorPart?.setVisible(visible);
			this.updateAuxiliaryBarClass(visible);
			if (visible) {
				this.layoutEditor();
				void this.seedDefaultAgent();
			}
		}));
		this.editorPart.setVisible(this.isBodyVisible());
		this.updateAuxiliaryBarClass(this.isBodyVisible());
		queueMicrotask(() => this.updateAuxiliaryBarClass(this.isBodyVisible()));

		void this.editorPart.whenRestored.then(() => {
			void this.seedDefaultAgent();
			this.syncAgentLayout();
			this.layoutEditor();
		});
	}

	protected override layoutBody(_height: number, _width: number): void {
		this.layoutEditor();
	}

	override focus(): void {
		if (this.isEmpty()) {
			(this.emptyEl.querySelector('button') as HTMLButtonElement | null)?.focus();
			return;
		}
		this.editorPart?.activeGroup.focus();
	}

	private layoutEditor(): void {
		if (!this.editorPart || !this.hostEl) {
			return;
		}
		const width = this.hostEl.clientWidth;
		const height = this.hostEl.clientHeight;
		if (width <= 0 || height <= 0) {
			return;
		}
		this.editorPart.layout(width, height, 0, 0);
	}

	private updateAuxiliaryBarClass(visible: boolean): void {
		this.element.closest('.part.auxiliarybar')?.classList.toggle('volt-agent-editor-tabs', visible);
	}

	private isEmpty(): boolean {
		return (this.editorPart?.groups ?? []).every(group => group.count === 0);
	}

	private async seedDefaultAgent(): Promise<void> {
		if (this.didSeedDefault || !this.editorPart) {
			return;
		}
		await this.editorPart.whenRestored;
		this.didSeedDefault = true;
		if (this.isEmpty()) {
			await this.openNewAgent();
		}
		this.syncAgentLayout();
	}

	async openNewAgent(_options?: { asTab?: boolean }): Promise<void> {
		if (!this.editorPart) {
			return;
		}
		const input = this.instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		await this.editorPart.activeGroup.openEditor(input, { pinned: true });
		this.syncAgentLayout();
		this.editorPart.activeGroup.focus();
	}

	getActiveAgentEditor(): AgentEditor | undefined {
		const pane = this.editorPart?.activeGroup.activeEditorPane;
		return pane instanceof AgentEditor ? pane : undefined;
	}

	private uniqueAgentCount(): number {
		const ids = new Set<string>();
		for (const group of this.editorPart?.groups ?? []) {
			for (const editor of group.editors) {
				if (editor instanceof AgentEditorInput) {
					ids.add(editor.resource.toString());
				}
			}
		}
		return ids.size;
	}

	private applyPartOptions(canSplit: boolean): void {
		if (!this.editorPart) {
			return;
		}
		this.partOptions.value = this.editorPart.enforcePartOptions({
			closeEmptyGroups: true,
			showTabs: 'multiple',
			splitOnDragAndDrop: canSplit,
		});
	}

	private syncEmptyState(): void {
		const empty = this.isEmpty();
		this.emptyEl.classList.toggle('hidden', !empty);
		this.element.classList.toggle('is-empty', empty);
	}

	private syncAgentLayout(): void {
		if (!this.editorPart || this.collapsingGroups) {
			return;
		}
		const canSplit = this.uniqueAgentCount() >= 2;
		this.hostEl.classList.toggle('single-agent', !canSplit);
		this.element.classList.toggle('single-agent', !canSplit);
		this.applyPartOptions(canSplit);
		if (!canSplit && this.occupiedGroups().length > 1) {
			this.collapseToSingleGroup();
		}
		this.syncEmptyState();
		this.layoutEditor();
	}

	private occupiedGroups(): IEditorGroup[] {
		return (this.editorPart?.groups ?? []).filter(group => group.count > 0);
	}

	private collapseToSingleGroup(): void {
		if (!this.editorPart) {
			return;
		}
		const occupied = this.occupiedGroups();
		if (occupied.length < 2) {
			return;
		}
		this.collapsingGroups = true;
		try {
			const active = this.editorPart.activeGroup;
			const target = occupied.includes(active) ? active : occupied[0];
			for (const group of occupied) {
				if (group.id !== target.id) {
					this.editorPart.mergeGroup(group.id, target.id);
				}
			}
		} finally {
			this.collapsingGroups = false;
		}
	}

	private bindAgentOnlyGroups(): void {
		this.groupListeners.clear();
		for (const group of this.editorPart?.groups ?? []) {
			this.groupListeners.add(group.onDidModelChange(e => {
				if (e.kind === GroupModelChangeKind.EDITOR_OPEN && e.editor && !(e.editor instanceof AgentEditorInput)) {
					this.bounceNonAgent(group, e.editor);
				}
				this.syncAgentLayout();
			}));
			this.groupListeners.add(group.onDidCloseEditor(() => this.syncAgentLayout()));
		}
	}

	private bounceNonAgent(group: IEditorGroup, editor: EditorInput): void {
		const target = this.editorGroupsService.mainPart.activeGroup;
		if (target && target !== group) {
			group.moveEditor(editor, target);
		} else {
			void group.closeEditor(editor);
		}
	}

	private bindAgentOnlyDrop(container: HTMLElement): void {
		const onDrag = (e: DragEvent, accept: boolean) => {
			if (!this.isDraggedAgent()) {
				if (e.dataTransfer && this.isDraggedEditor()) {
					e.dataTransfer.dropEffect = 'none';
				}
				container.classList.remove('drop-target');
				return;
			}
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}
			container.classList.toggle('drop-target', accept);
		};
		this._register(addDisposableListener(container, 'dragenter', e => onDrag(e, true)));
		this._register(addDisposableListener(container, 'dragover', e => onDrag(e, true)));
		this._register(addDisposableListener(container, 'dragleave', e => {
			if (!container.contains(e.relatedTarget as Node)) {
				container.classList.remove('drop-target');
			}
		}));
		this._register(addDisposableListener(container, 'drop', e => {
			container.classList.remove('drop-target');
			if (!this.isDraggedAgent()) {
				e.preventDefault();
				e.stopPropagation();
			}
		}));
	}

	private isDraggedEditor(): boolean {
		return LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().hasData(DraggedEditorIdentifier.prototype)
			|| LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>().hasData(DraggedEditorGroupIdentifier.prototype);
	}

	private isDraggedAgent(): boolean {
		const editors = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>().getData(DraggedEditorIdentifier.prototype) ?? [];
		if (editors.length) {
			return editors.every(item => item.identifier.editor instanceof AgentEditorInput);
		}
		const groups = LocalSelectionTransfer.getInstance<DraggedEditorGroupIdentifier>().getData(DraggedEditorGroupIdentifier.prototype) ?? [];
		if (!groups.length) {
			return false;
		}
		return groups.every(item => {
			const group = this.editorGroupsService.getGroup(item.identifier);
			return !!group && group.editors.every(editor => editor instanceof AgentEditorInput);
		});
	}
}
