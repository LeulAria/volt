/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { ICompressedTreeElement, ICompressedTreeNode } from '../../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { ICompressibleTreeRenderer } from '../../../../../base/browser/ui/tree/objectTree.js';
import { ITreeNode } from '../../../../../base/browser/ui/tree/tree.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, isAbsolute } from '../../../../../base/common/path.js';
import { dirname as parentUri, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchCompressibleObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IResourceLabel, ResourceLabels } from '../../../../browser/labels.js';
import { ITurnFileChange } from '../chrome/agentTimeline.js';
import { formatChangeStats } from '../review/fileChangePreviewModel.js';

type TurnFolderElement = { readonly type: 'folder'; readonly uri: URI; readonly name: string };
type TurnFileElement = { readonly type: 'file'; readonly uri: URI; readonly file: ITurnFileChange };
type TurnFilesElement = TurnFolderElement | TurnFileElement;

const ROW_HEIGHT = 26;

const identityProvider: IIdentityProvider<TurnFilesElement> = {
	getId: element => `${element.type}:${element.uri.toString()}`,
};

class TurnFilesDelegate implements IListVirtualDelegate<TurnFilesElement> {
	getHeight(): number {
		return ROW_HEIGHT;
	}

	getTemplateId(): string {
		return TurnFilesRenderer.ID;
	}
}

interface ITurnFilesTemplate {
	readonly label: IResourceLabel;
	readonly stats: HTMLElement;
	readonly add: HTMLElement;
	readonly del: HTMLElement;
}

/** The searchable class lets find-in-chat match file and folder names. */
const LABEL_CLASSES = ['volt-agent-searchable'];

class TurnFilesRenderer implements ICompressibleTreeRenderer<TurnFilesElement, void, ITurnFilesTemplate> {
	static readonly ID = 'agentTurnFile';
	readonly templateId = TurnFilesRenderer.ID;

	constructor(private readonly labels: ResourceLabels) { }

	renderTemplate(container: HTMLElement): ITurnFilesTemplate {
		const row = append(container, $('.volt-agent-turn-files-row'));
		const label = this.labels.create(row, { supportHighlights: false });
		const stats = append(row, $('span.volt-agent-turn-files-stats'));
		const add = append(stats, $('span.add'));
		const del = append(stats, $('span.del'));
		return { label, stats, add, del };
	}

	renderElement(node: ITreeNode<TurnFilesElement, void>, _index: number, template: ITurnFilesTemplate): void {
		const element = node.element;
		if (element.type === 'folder') {
			this.renderFolder(template, element.uri, element.name);
			return;
		}
		const file = element.file;
		template.label.setResource({ resource: element.uri, name: basename(file.path) }, {
			fileKind: FileKind.FILE,
			title: file.path,
			extraClasses: LABEL_CLASSES,
		});
		const stats = formatChangeStats(file.additions, file.deletions);
		template.add.textContent = stats.added ?? '';
		template.add.hidden = !stats.added;
		template.del.textContent = stats.removed ?? '';
		template.del.hidden = !stats.removed;
		template.stats.hidden = false;
	}

	/** A folder chain with one subfolder each ("src/vs") shares one row, as in the SCM tree. */
	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<TurnFilesElement>, void>, _index: number, template: ITurnFilesTemplate): void {
		const elements = node.element.elements;
		const last = elements[elements.length - 1];
		this.renderFolder(template, last.uri, elements.map(element => element.type === 'folder' ? element.name : basename(element.file.path)));
	}

	private renderFolder(template: ITurnFilesTemplate, uri: URI, name: string | string[]): void {
		template.label.setResource({ resource: uri, name }, {
			fileKind: FileKind.FOLDER,
			separator: '/',
			extraClasses: LABEL_CLASSES,
		});
		template.stats.hidden = true;
	}

	disposeTemplate(template: ITurnFilesTemplate): void {
		template.label.dispose();
	}
}

class TurnFilesAccessibilityProvider implements IListAccessibilityProvider<TurnFilesElement> {
	getWidgetAriaLabel(): string {
		return localize('voltAgent.turnFiles.aria', "Files Changed");
	}

	getAriaLabel(element: TurnFilesElement): string {
		if (element.type === 'folder') {
			return element.name;
		}
		const file = element.file;
		return localize('voltAgent.turnFiles.fileAria', "{0}, {1}, {2} added, {3} removed", basename(file.path), file.verb.toLowerCase(), file.additions, file.deletions);
	}
}

/**
 * The rows of the end-of-turn "N Files Changed" card: a workbench tree (twisties, indent guides, icon theme,
 * keyboard navigation) sized to its content so the transcript, not the card, scrolls.
 */
export class AgentTurnFilesTree extends Disposable {

	private readonly tree: WorkbenchCompressibleObjectTree<TurnFilesElement>;
	private lastWidth = 0;
	private lastHeight = 0;

	constructor(
		private readonly container: HTMLElement,
		labels: ResourceLabels,
		onOpen: (path: string) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.tree = this._register(instantiationService.createInstance(
			WorkbenchCompressibleObjectTree<TurnFilesElement>,
			'AgentTurnFiles',
			container,
			new TurnFilesDelegate(),
			[new TurnFilesRenderer(labels)],
			{
				accessibilityProvider: new TurnFilesAccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: element => element.type === 'folder' ? element.name : basename(element.file.path),
					getCompressedNodeKeyboardNavigationLabel: elements => elements.map(element => element.type === 'folder' ? element.name : basename(element.file.path)).join('/'),
				},
				identityProvider,
				compressionEnabled: true,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				setRowLineHeight: false,
				hideTwistiesOfChildlessElements: true,
				renderIndentGuides: RenderIndentGuides.Always,
				// The card is as tall as its rows: wheel events belong to the transcript.
				alwaysConsumeMouseWheel: false,
				paddingBottom: 0,
			}
		));
		this._register(this.tree.onDidOpen(e => {
			if (e.element?.type === 'file') {
				onOpen(e.element.file.path);
			}
		}));
		// Opening a file moves focus to its editor; the card should not keep a selected row behind.
		this._register(this.tree.onDidBlur(() => this.tree.setSelection([])));
		this._register(this.tree.onDidChangeContentHeight(() => this.layout()));
		const observer = new ResizeObserver(() => this.layout());
		observer.observe(container);
		this._register(toDisposable(() => observer.disconnect()));
	}

	setFiles(files: readonly ITurnFileChange[], asTree: boolean): void {
		const elements = asTree
			? this.buildTree(files)
			: files.map(file => ({ element: { type: 'file' as const, uri: this.fileUri(file.path), file }, incompressible: true }));
		// A tree with no folders has no twisties to line up with: drop the gutter as in list view.
		this.container.classList.toggle('flat', elements.every(e => e.element.type === 'file'));
		this.tree.setChildren(null, elements);
		this.layout();
	}

	private layout(): void {
		const width = this.container.clientWidth;
		if (width <= 0) {
			return;
		}
		const height = this.tree.contentHeight;
		if (width === this.lastWidth && height === this.lastHeight) {
			return;
		}
		this.lastWidth = width;
		this.lastHeight = height;
		this.container.style.height = `${height}px`;
		this.tree.layout(height, width);
	}

	private buildTree(files: readonly ITurnFileChange[]): ICompressedTreeElement<TurnFilesElement>[] {
		interface Folder { readonly uri?: URI; readonly folders: Map<string, Folder>; readonly files: ITurnFileChange[] }
		const root: Folder = { folders: new Map(), files: [] };
		for (const file of files) {
			const segments = this.fileFolders(file.path);
			let uri = this.fileUri(file.path);
			const uris = segments.map(() => (uri = parentUri(uri))).reverse();
			let folder = root;
			segments.forEach((segment, index) => {
				let child = folder.folders.get(segment);
				if (!child) {
					child = { uri: uris[index], folders: new Map(), files: [] };
					folder.folders.set(segment, child);
				}
				folder = child;
			});
			folder.files.push(file);
		}
		const toElements = (folder: Folder): ICompressedTreeElement<TurnFilesElement>[] => [
			...[...folder.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => ({
				element: { type: 'folder' as const, uri: child.uri!, name },
				collapsible: true,
				children: toElements(child),
			})),
			...[...folder.files].sort((a, b) => basename(a.path).localeCompare(basename(b.path))).map(file => ({
				element: { type: 'file' as const, uri: this.fileUri(file.path), file },
				// A folder holding one file keeps its own row.
				incompressible: true,
			})),
		];
		return toElements(root);
	}

	private fileUri(path: string): URI {
		if (isAbsolute(path)) {
			return URI.file(path);
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder ? joinPath(folder.uri, path) : URI.file(`/${path}`);
	}

	/** Folder names from the workspace root down to the file; outside the workspace, from the filesystem root. */
	private fileFolders(path: string): string[] {
		let dir = dirname(path);
		if (isAbsolute(path)) {
			for (const folder of this.workspaceContextService.getWorkspace().folders) {
				const rootPath = folder.uri.fsPath;
				if (dir === rootPath) {
					return [];
				}
				if (dir.startsWith(rootPath + '/')) {
					dir = dir.slice(rootPath.length + 1);
					break;
				}
			}
		}
		return dir === '.' ? [] : dir.split('/').filter(Boolean);
	}
}
