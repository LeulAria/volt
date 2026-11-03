/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentResources.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { ICompressedTreeElement, ICompressedTreeNode } from '../../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { ICompressibleTreeRenderer } from '../../../../../base/browser/ui/tree/objectTree.js';
import { ITreeNode, ObjectTreeElementCollapseState } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchCompressibleObjectTree } from '../../../../../platform/list/browser/listService.js';
import { DEFAULT_LABELS_CONTAINER, IResourceLabel, ResourceLabels } from '../../../../browser/labels.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AGENT_RESOURCE_ECOSYSTEM_LABELS, agentResourceGroup, agentResourceScopeLabel } from '../../common/agentResources.js';
import { IAgentResource } from './agentResourcesService.js';

type FolderElement = { readonly type: 'folder'; readonly uri: URI; readonly name: string };
type FileElement = { readonly type: 'file'; readonly item: IAgentResource };
type ResourceElement = FolderElement | FileElement;

const ROW_HEIGHT = 22;

/** Opens a discovered file: a tab in the chat's right panel (the editor router sends it there). */
export function openAgentResource(editorService: IEditorService, item: IAgentResource, preserveFocus = false): void {
	void editorService.openEditor({ resource: item.resource, options: { pinned: true, preserveFocus } });
}

/** The file's own name, as the Explorer shows it; a skill's folder above it names the skill. */
function fileName(item: IAgentResource): string {
	return basename(item.resource);
}

const identityProvider: IIdentityProvider<ResourceElement> = {
	getId: element => element.type === 'folder' ? `d:${element.uri.toString()}` : `f:${element.item.resource.toString()}`,
};

class Delegate implements IListVirtualDelegate<ResourceElement> {
	getHeight(): number {
		return ROW_HEIGHT;
	}

	getTemplateId(): string {
		return Renderer.ID;
	}
}

interface ITemplate {
	readonly row: HTMLElement;
	readonly label: IResourceLabel;
	readonly status: HTMLElement;
}

/** The hover text of a file: where it is, whose it is, what it is, and anything wrong with it. */
export function agentResourceTitle(item: IAgentResource): string {
	const lines = [
		item.relativePath,
		`${AGENT_RESOURCE_ECOSYSTEM_LABELS[item.ecosystem]} · ${item.kind} · ${agentResourceScopeLabel(item.scope, item.relativePath)}`,
	];
	if (item.description) {
		lines.push(item.description);
	}
	if (item.status.message) {
		lines.push(item.status.message);
	}
	return lines.join('\n');
}

class Renderer implements ICompressibleTreeRenderer<ResourceElement, void, ITemplate> {
	static readonly ID = 'voltAgentResource';
	readonly templateId = Renderer.ID;

	constructor(private readonly labels: ResourceLabels, private readonly showGroup: () => boolean) { }

	renderTemplate(container: HTMLElement): ITemplate {
		const row = append(container, $('.volt-agent-resource-row'));
		const label = this.labels.create(row, { supportHighlights: false, supportDescriptionHighlights: false });
		const status = append(row, $('span.volt-agent-resource-status'));
		return { row, label, status };
	}

	renderElement(node: ITreeNode<ResourceElement, void>, _index: number, template: ITemplate): void {
		const element = node.element;
		if (element.type === 'folder') {
			this.renderFolder(template, element.uri, element.name);
			return;
		}
		const item = element.item;
		// The source says whose a file is; with every group listed, the group says what it is.
		const description = this.showGroup()
			? `${agentResourceGroup(item.group).label} · ${AGENT_RESOURCE_ECOSYSTEM_LABELS[item.ecosystem]}`
			: AGENT_RESOURCE_ECOSYSTEM_LABELS[item.ecosystem];
		template.label.setResource({ resource: item.resource, name: fileName(item), description }, {
			fileKind: FileKind.FILE,
			title: agentResourceTitle(item),
		});
		template.status.replaceChildren();
		template.status.className = `volt-agent-resource-status ${item.status.kind}`;
		if (item.status.kind !== 'ok') {
			template.status.appendChild(renderIcon(item.status.kind === 'error' ? Codicon.error : Codicon.warning));
			template.status.setAttribute('aria-label', item.status.message ?? '');
		}
	}

	/** A folder chain with one subfolder each (".claude/skills") shares one row, as in the Explorer. */
	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<ResourceElement>, void>, _index: number, template: ITemplate): void {
		const elements = node.element.elements as FolderElement[];
		this.renderFolder(template, elements[elements.length - 1].uri, elements.map(element => element.name));
	}

	private renderFolder(template: ITemplate, uri: URI, name: string | string[]): void {
		template.label.setResource({ resource: uri, name }, { fileKind: FileKind.FOLDER, separator: '/' });
		template.status.replaceChildren();
		template.status.className = 'volt-agent-resource-status ok';
	}

	disposeTemplate(template: ITemplate): void {
		template.label.dispose();
	}
}

class AccessibilityProvider implements IListAccessibilityProvider<ResourceElement> {
	getWidgetAriaLabel(): string {
		return localize('agentResources.tree.aria', "Agent Resources");
	}

	getAriaLabel(element: ResourceElement): string {
		if (element.type === 'folder') {
			return element.name;
		}
		const item = element.item;
		const parts = [fileName(item), AGENT_RESOURCE_ECOSYSTEM_LABELS[item.ecosystem], item.kind];
		if (item.status.message) {
			parts.push(item.status.message);
		}
		return parts.join(', ');
	}
}

/**
 * Agent resources as the Explorer draws them: folders from the project root down, file icons from
 * the icon theme, indent guides. Shared by the side toolbar's hover card and the files sidebar filter.
 */
export class AgentResourceTree extends Disposable {

	private readonly tree: WorkbenchCompressibleObjectTree<ResourceElement>;
	private readonly labels: ResourceLabels;
	private showGroup = false;
	/** What the tree last showed, to skip a rebuild that changes nothing. */
	private key: string | undefined;

	private readonly _onDidOpen = this._register(new Emitter<{ readonly item: IAgentResource; readonly sideBySide: boolean; readonly preserveFocus: boolean }>());
	readonly onDidOpen = this._onDidOpen.event;

	get onDidChangeContentHeight(): Event<number> {
		return this.tree.onDidChangeContentHeight;
	}

	constructor(
		container: HTMLElement,
		id: string,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// show-file-icons: the file icon theme only draws inside it; themable-tree aligns folders as the Explorer does.
		container.classList.add('volt-agent-resource-tree', 'file-icon-themable-tree', 'show-file-icons');
		this.labels = this._register(instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
		this.tree = this._register(instantiationService.createInstance(
			WorkbenchCompressibleObjectTree<ResourceElement>,
			id,
			container,
			new Delegate(),
			[new Renderer(this.labels, () => this.showGroup)],
			{
				accessibilityProvider: new AccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: element => element.type === 'folder' ? element.name : fileName(element.item),
					getCompressedNodeKeyboardNavigationLabel: elements => elements.map(element => element.type === 'folder' ? element.name : fileName(element.item)).join('/'),
				},
				identityProvider,
				compressionEnabled: true,
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				hideTwistiesOfChildlessElements: true,
				renderIndentGuides: RenderIndentGuides.Always,
				paddingBottom: 0,
			}
		));
		this._register(this.tree.onDidOpen(e => {
			if (e.element?.type === 'file') {
				this._onDidOpen.fire({ item: e.element.item, sideBySide: e.sideBySide, preserveFocus: !!e.editorOptions.preserveFocus });
			}
		}));
	}

	get contentHeight(): number {
		return this.tree.contentHeight;
	}

	/** `showGroup`: each file also names its group (the "All Agent Resources" filter). */
	setResources(folder: URI, items: readonly IAgentResource[], showGroup = false): void {
		// The same files with the same states: keep the tree as it is, scroll and all.
		const key = JSON.stringify([folder.toString(), showGroup, items.map(item => [item.resource.toString(), item.status.kind, item.status.message, item.kind, item.description])]);
		if (key === this.key) {
			return;
		}
		this.key = key;
		this.showGroup = showGroup;
		// Folders the user collapsed stay collapsed (the tree finds them by identity); new ones open.
		this.tree.setChildren(null, buildTree(folder, items));
	}

	layout(height: number, width?: number): void {
		this.tree.layout(height, width);
	}

	domFocus(): void {
		this.tree.domFocus();
	}
}

function buildTree(folder: URI, items: readonly IAgentResource[]): ICompressedTreeElement<ResourceElement>[] {
	interface IFolder { readonly uri: URI; readonly folders: Map<string, IFolder>; readonly files: IAgentResource[] }
	const root: IFolder = { uri: folder, folders: new Map(), files: [] };
	for (const item of items) {
		const segments = item.relativePath.split('/');
		segments.pop();
		let current = root;
		for (const segment of segments) {
			let child = current.folders.get(segment);
			if (!child) {
				child = { uri: joinPath(current.uri, segment), folders: new Map(), files: [] };
				current.folders.set(segment, child);
			}
			current = child;
		}
		current.files.push(item);
	}
	// Folders first, then files, each by name: the Explorer's order.
	const toElements = (current: IFolder): ICompressedTreeElement<ResourceElement>[] => [
		...[...current.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => ({
			element: { type: 'folder' as const, uri: child.uri, name },
			collapsible: true,
			collapsed: ObjectTreeElementCollapseState.PreserveOrExpanded,
			children: toElements(child),
		})),
		...[...current.files].sort((a, b) => fileName(a).localeCompare(fileName(b))).map(item => ({
			element: { type: 'file' as const, item },
			incompressible: true,
		})),
	];
	return toElements(root);
}
