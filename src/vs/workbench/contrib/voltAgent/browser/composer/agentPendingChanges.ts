/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentEdits.css';
import { $, addDisposableListener, append, EventHelper, getComputedStyle } from '../../../../../base/browser/dom.js';
import { IIdentityProvider, IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DEFAULT_LABELS_CONTAINER, IResourceLabel, ResourceLabels } from '../../../../browser/labels.js';
import { IAgentEditsService, IAgentPendingFile } from '../review/agentEditsService.js';

export interface IAgentPendingChangesOptions {
	onOpenFile(file: IAgentPendingFile): void;
	onReview(): void;
}

type PendingFolderElement = { readonly type: 'folder'; readonly uri: URI; readonly name: string };
type PendingFileElement = { readonly type: 'file'; readonly file: IAgentPendingFile };
type PendingElement = PendingFolderElement | PendingFileElement;

const ROW_HEIGHT = 26;
const MAX_LIST_HEIGHT = 168;

const identityProvider: IIdentityProvider<PendingElement> = {
	getId: element => element.type === 'folder' ? `folder:${element.uri.toString()}` : `file:${element.file.uri.toString()}`,
};

class PendingDelegate implements IListVirtualDelegate<PendingElement> {
	getHeight(): number {
		return ROW_HEIGHT;
	}

	getTemplateId(): string {
		return PendingRenderer.ID;
	}
}

interface IPendingTemplate {
	readonly row: HTMLElement;
	readonly label: IResourceLabel;
	readonly kind: HTMLElement;
	readonly stats: HTMLElement;
	readonly add: HTMLElement;
	readonly del: HTMLElement;
	readonly actions: HTMLElement;
	readonly store: DisposableStore;
	file?: IAgentPendingFile;
}

interface IPendingRendererHost {
	readonly sessionId: string | undefined;
	undoFile(file: IAgentPendingFile): void;
	keepFile(file: IAgentPendingFile): void;
}

class PendingRenderer implements IListRenderer<PendingElement, IPendingTemplate>, ITreeRenderer<PendingElement, void, IPendingTemplate> {
	static readonly ID = 'agentPendingFile';
	readonly templateId = PendingRenderer.ID;

	constructor(
		private readonly labels: ResourceLabels,
		private readonly host: IPendingRendererHost,
		private readonly modelService: IModelService,
		private readonly languageService: ILanguageService,
	) { }

	renderTemplate(container: HTMLElement): IPendingTemplate {
		const row = append(container, $('.volt-agent-pending-row'));
		const label = this.labels.create(row);
		const kind = append(row, $('span.volt-agent-pending-kind'));
		const stats = append(row, $('span.volt-agent-pending-stats'));
		const add = append(stats, $('span.add'));
		const del = append(stats, $('span.del'));
		const actions = append(row, $('.volt-agent-pending-row-actions'));
		const template: IPendingTemplate = { row, label, kind, stats, add, del, actions, store: new DisposableStore() };
		const rowButton = (codicon: typeof Codicon.check, tooltip: string, run: (file: IAgentPendingFile) => void) => {
			const el = append(actions, $('button.volt-agent-pending-row-action')) as HTMLButtonElement;
			el.type = 'button';
			el.appendChild(renderIcon(codicon));
			el.setAttribute('aria-label', tooltip);
			template.store.add(addDisposableListener(el, 'mousedown', e => EventHelper.stop(e, true)));
			template.store.add(addDisposableListener(el, 'click', e => {
				EventHelper.stop(e, true);
				if (template.file) {
					run(template.file);
				}
			}));
		};
		// This chat's entry: another chat may have pending edits in the same file.
		rowButton(Codicon.discard, localize('voltAgent.pending.undoFile', "Undo File"), file => this.host.undoFile(file));
		rowButton(Codicon.check, localize('voltAgent.pending.keepFile', "Keep File"), file => this.host.keepFile(file));
		return template;
	}

	renderElement(item: PendingElement | ITreeNode<PendingElement, void>, _index: number, template: IPendingTemplate): void {
		const element = 'type' in item ? item : item.element;
		template.kind.textContent = '';
		if (element.type === 'folder') {
			template.file = undefined;
			template.label.setLabel(element.name, undefined, {
				extraClasses: getIconClasses(this.modelService, this.languageService, element.uri, FileKind.FOLDER),
			});
			template.kind.hidden = true;
			template.stats.hidden = true;
			template.actions.hidden = true;
			return;
		}
		const file = element.file;
		template.file = file;
		template.label.setLabel(basename(file.uri), undefined, {
			extraClasses: getIconClasses(this.modelService, this.languageService, file.uri, FileKind.FILE),
		});
		if (file.renamedFrom) {
			template.kind.textContent = localize('voltAgent.pending.renamed', "renamed from {0}", basename(file.renamedFrom));
		} else if (file.binary) {
			template.kind.textContent = localize('voltAgent.pending.binary', "binary");
		} else if (file.kind === 'added' || file.kind === 'deleted') {
			template.kind.textContent = file.kind === 'added'
				? localize('voltAgent.pending.new', "new")
				: localize('voltAgent.pending.deleted', "deleted");
		}
		template.kind.hidden = !template.kind.textContent;
		template.stats.hidden = !!file.binary;
		template.add.textContent = `+${file.additions}`;
		template.del.textContent = `-${file.deletions}`;
		template.actions.hidden = false;
	}

	disposeTemplate(template: IPendingTemplate): void {
		template.store.dispose();
		template.label.dispose();
	}
}

class PendingAccessibilityProvider implements IListAccessibilityProvider<PendingElement> {
	getWidgetAriaLabel(): string {
		return localize('voltAgent.pending.aria', "Changed Files");
	}

	getAriaLabel(element: PendingElement): string {
		if (element.type === 'folder') {
			return element.name;
		}
		const file = element.file;
		return file.binary
			? basename(file.uri)
			: localize('voltAgent.pending.fileAria', "{0}, {1} added, {2} removed", basename(file.uri), file.additions, file.deletions);
	}
}

/**
 * The "mini file diff viewer": hidden for now. Set to true to show it above the composer again.
 */
export const MINI_FILE_DIFF_VIEWER_ENABLED = false;

/**
 * Mini file diff viewer. The files an agent changed that the user has not kept or undone, above the composer:
 * "2 Files · Undo All · Keep All · Review", then one row per file with its line counts.
 */
export class AgentPendingChanges extends Disposable implements IPendingRendererHost {

	readonly element: HTMLElement;

	private readonly headEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly listContainer: HTMLElement;
	private readonly treeContainer: HTMLElement;
	private readonly list: WorkbenchList<PendingElement>;
	private readonly tree: WorkbenchObjectTree<PendingElement>;
	private readonly headListeners = this._register(new DisposableStore());
	private _sessionId: string | undefined;
	private collapsed = true;
	private busy = false;
	private treeView = false;
	/** The tree is on and there are folders to show in it. */
	private showingTree = false;
	private readonly collapsedFolders = new Set<string>();
	private lastWidth = 0;
	private lastHeight = 0;

	get sessionId(): string | undefined {
		return this._sessionId;
	}

	constructor(
		private readonly options: IAgentPendingChangesOptions,
		@IAgentEditsService private readonly edits: IAgentEditsService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.element = $('.volt-agent-pending-card.hidden');
		this.headEl = append(this.element, $('.volt-agent-pending-head'));
		this.bodyEl = append(this.element, $('.volt-agent-pending-list.show-file-icons'));
		this.listContainer = append(this.bodyEl, $('.volt-agent-pending-widget.list'));
		this.treeContainer = append(this.bodyEl, $('.volt-agent-pending-widget.tree'));

		const labels = this._register(instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		const renderer = new PendingRenderer(labels, this, modelService, languageService);
		const accessibilityProvider = new PendingAccessibilityProvider();
		const keyboardNavigationLabelProvider = {
			getKeyboardNavigationLabel: (element: PendingElement) => element.type === 'folder' ? element.name : basename(element.file.uri),
		};

		this.list = this._register(instantiationService.createInstance(
			WorkbenchList<PendingElement>,
			'AgentPendingChanges',
			this.listContainer,
			new PendingDelegate(),
			[renderer],
			{
				accessibilityProvider,
				keyboardNavigationLabelProvider,
				identityProvider,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				setRowLineHeight: false,
			}
		));
		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<PendingElement>,
			'AgentPendingChangesTree',
			this.treeContainer,
			new PendingDelegate(),
			[renderer],
			{
				accessibilityProvider,
				keyboardNavigationLabelProvider,
				identityProvider,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				setRowLineHeight: false,
				hideTwistiesOfChildlessElements: true,
				renderIndentGuides: RenderIndentGuides.Always,
			}
		));

		const open = (element: PendingElement | undefined) => {
			if (element?.type === 'file') {
				this.options.onOpenFile(element.file);
			}
		};
		this._register(this.list.onDidOpen(e => open(e.element)));
		this._register(this.tree.onDidOpen(e => open(e.element)));
		this._register(this.tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (element?.type !== 'folder') {
				return;
			}
			const key = element.uri.toString();
			if (e.node.collapsed) {
				this.collapsedFolders.add(key);
			} else {
				this.collapsedFolders.delete(key);
			}
		}));
		this._register(this.list.onDidChangeContentHeight(() => this.layout()));
		this._register(this.tree.onDidChangeContentHeight(() => this.layout()));
		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.bodyEl);
		this._register(toDisposable(() => observer.disconnect()));

		this._register(this.edits.onDidChange(() => this.render()));
	}

	setSessionId(sessionId: string | undefined): void {
		if (this._sessionId === sessionId) {
			return;
		}
		this._sessionId = sessionId;
		this.collapsed = true;
		this.collapsedFolders.clear();
		this.render();
	}

	undoFile(file: IAgentPendingFile): void {
		void this.edits.undoFile(file.uri, file.sessionId);
	}

	keepFile(file: IAgentPendingFile): void {
		void this.edits.keepFile(file.uri, file.sessionId);
	}

	private render(): void {
		const files = this._sessionId ? this.edits.getPendingFiles(this._sessionId) : [];
		// Files that all sit in one folder have no tree to show: list only, and no toggle.
		const treeElements = files.length ? this.buildTree(files) : [];
		const hasTree = treeElements.some(element => element.element.type === 'folder');
		this.showingTree = this.treeView && hasTree;
		this.element.classList.toggle('hidden', !MINI_FILE_DIFF_VIEWER_ENABLED || files.length === 0);
		this.element.classList.toggle('collapsed', this.collapsed);
		this.renderHead(files, hasTree);
		this.bodyEl.hidden = this.collapsed || !files.length;
		this.listContainer.hidden = this.showingTree;
		this.treeContainer.hidden = !this.showingTree;
		if (!files.length) {
			this.list.splice(0, this.list.length);
			this.tree.setChildren(null, []);
			return;
		}
		if (this.showingTree) {
			this.list.splice(0, this.list.length);
			this.tree.setChildren(null, treeElements);
		} else {
			this.tree.setChildren(null, []);
			this.list.splice(0, this.list.length, files.map(file => ({ type: 'file', file })));
		}
		this.lastWidth = 0;
		this.lastHeight = 0;
		this.layout();
	}

	private layout(): void {
		if (this.bodyEl.hidden || this.bodyEl.clientWidth <= 0 || getComputedStyle(this.element).display === 'none') {
			return;
		}
		const width = this.bodyEl.clientWidth;
		const contentHeight = this.showingTree ? this.tree.contentHeight : this.list.contentHeight;
		const height = Math.min(Math.max(contentHeight, ROW_HEIGHT), MAX_LIST_HEIGHT);
		if (width === this.lastWidth && height === this.lastHeight) {
			return;
		}
		this.lastWidth = width;
		this.lastHeight = height;
		const container = this.showingTree ? this.treeContainer : this.listContainer;
		container.style.height = `${height}px`;
		if (this.showingTree) {
			this.tree.layout(height, width);
		} else {
			this.list.layout(height, width);
		}
	}

	private renderHead(files: readonly IAgentPendingFile[], hasTree: boolean): void {
		this.headListeners.clear();
		this.headEl.replaceChildren();
		if (!files.length) {
			return;
		}

		const toggle = append(this.headEl, $('button.volt-agent-pending-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(!this.collapsed));
		append(toggle, renderIcon(this.collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		append(toggle, $('span')).textContent = files.length === 1
			? localize('voltAgent.pending.oneFile', "1 File")
			: localize('voltAgent.pending.files', "{0} Files", files.length);
		this.headListeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			this.collapsed = !this.collapsed;
			this.render();
		}));

		if (hasTree) {
			const viewToggle = append(this.headEl, $('button.volt-agent-pending-view-toggle')) as HTMLButtonElement;
			viewToggle.type = 'button';
			const viewLabel = this.treeView
				? localize('voltAgent.pending.viewList', "View as List")
				: localize('voltAgent.pending.viewTree', "View as Tree");
			viewToggle.setAttribute('aria-label', viewLabel);
			viewToggle.setAttribute('aria-pressed', String(this.treeView));
			viewToggle.appendChild(renderIcon(this.treeView ? Codicon.listFlat : Codicon.listTree));
			this.headListeners.add(addDisposableListener(viewToggle, 'click', () => {
				this.treeView = !this.treeView;
				this.render();
				this.headEl.querySelector<HTMLButtonElement>('.volt-agent-pending-view-toggle')?.focus();
			}));
		}

		const actions = append(this.headEl, $('.volt-agent-pending-actions'));
		const button = (label: string, className: string, run: () => Promise<void> | void) => {
			const el = append(actions, $(`button.volt-agent-pending-action.${className}`)) as HTMLButtonElement;
			el.type = 'button';
			el.textContent = label;
			el.disabled = this.busy;
			this.headListeners.add(addDisposableListener(el, 'click', async e => {
				e.preventDefault();
				e.stopPropagation();
				if (this.busy) {
					return;
				}
				this.busy = true;
				try {
					await run();
				} finally {
					this.busy = false;
					this.render();
				}
			}));
		};
		const sessionId = this._sessionId!;
		button(localize('voltAgent.pending.undoAll', "Undo All"), 'undo', () => this.edits.undoAll(sessionId));
		button(localize('voltAgent.pending.keepAll', "Keep All"), 'keep', () => this.edits.keepAll(sessionId));
		button(localize('voltAgent.pending.review', "Review"), 'review', () => this.options.onReview());
	}

	private buildTree(files: readonly IAgentPendingFile[]): IObjectTreeElement<PendingElement>[] {
		interface Folder {
			uri?: URI;
			folders: Map<string, Folder>;
			files: IAgentPendingFile[];
		}
		const root: Folder = { folders: new Map(), files: [] };
		// Unknown worktrees use their common ancestor, never the machine's full directory chain.
		let common = dirname(files[0].uri);
		for (const file of files) {
			while (common.path !== '/' && (relativePath(common, file.uri)?.startsWith('../') ?? true)) {
				const parent = dirname(common);
				if (parent.path === common.path) { break; }
				common = parent;
			}
		}
		const multipleRoots = new Set(files.map(file => (this.workspaceContextService.getWorkspaceFolder(file.uri)?.uri ?? common).toString())).size > 1;
		for (const file of files) {
			const workspace = this.workspaceContextService.getWorkspaceFolder(file.uri);
			const base = workspace?.uri ?? common;
			const path = relativePath(base, file.uri) ?? basename(file.uri);
			const segments = path.split('/').slice(0, -1);
			if (multipleRoots) { segments.unshift(workspace?.name ?? basename(base)); }
			let folder = root;
			for (let index = 0; index < segments.length; index++) {
				const segment = segments[index];
				let child = folder.folders.get(segment);
				if (!child) {
					let uri = dirname(file.uri);
					for (let remaining = index + 1; remaining < segments.length; remaining++) { uri = dirname(uri); }
					child = { uri, folders: new Map(), files: [] };
					folder.folders.set(segment, child);
				}
				folder = child;
			}
			folder.files.push(file);
		}
		const toElements = (folder: Folder): IObjectTreeElement<PendingElement>[] => {
			const children: IObjectTreeElement<PendingElement>[] = [];
			for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
				children.push({
					element: { type: 'folder', uri: child.uri!, name },
					collapsible: true,
					collapsed: this.collapsedFolders.has(child.uri!.toString()),
					children: toElements(child),
				});
			}
			for (const file of [...folder.files].sort((a, b) => basename(a.uri).localeCompare(basename(b.uri)))) {
				children.push({ element: { type: 'file', file }, collapsible: false });
			}
			return children;
		};
		return toElements(root);
	}
}
