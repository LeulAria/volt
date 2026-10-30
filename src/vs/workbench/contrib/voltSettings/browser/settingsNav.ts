/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { ITreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';

export interface ISettingsNavNode {
	/** A section id, or a group's own id for rows that only fold (Extensions). */
	readonly id: string;
	readonly label: string;
	readonly icon?: ThemeIcon | (() => Element | undefined);
	/** A title between groups; not a page. */
	readonly heading?: boolean;
	/** Folds and unfolds on click instead of opening a page. */
	readonly folder?: boolean;
	readonly count?: string;
	readonly children?: readonly ISettingsNavNode[];
	readonly collapsed?: boolean;
}

const ROW_HEIGHT = 28;
/** How far a child row steps in from its parent. */
const NAV_INDENT = 12;

class NavDelegate implements IListVirtualDelegate<ISettingsNavNode> {
	getHeight(node: ISettingsNavNode): number {
		return node.heading ? 40 : ROW_HEIGHT;
	}
	getTemplateId(): string {
		return NavRenderer.ID;
	}
}

interface INavTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
}

class NavRenderer implements ITreeRenderer<ISettingsNavNode, void, INavTemplate> {
	static readonly ID = 'voltSettingsNav';
	readonly templateId = NavRenderer.ID;

	renderTemplate(container: HTMLElement): INavTemplate {
		const row = append(container, $('.volt-settings-nav-row'));
		return { row, icon: append(row, $('span.volt-settings-nav-icon')), label: append(row, $('span.volt-settings-nav-label')), count: append(row, $('span.volt-settings-nav-count')) };
	}

	renderElement(element: ITreeNode<ISettingsNavNode, void>, _index: number, template: INavTemplate): void {
		const node = element.element;
		template.row.classList.toggle('heading', !!node.heading);
		template.row.classList.toggle('folder', !!node.folder);
		// Rows are reused; the row itself says whether it paints hover and selection.
		template.row.closest('.monaco-list-row')?.classList.toggle('volt-settings-nav-static', !!node.heading);
		template.icon.replaceChildren();
		const glyph = typeof node.icon === 'function' ? node.icon() : node.icon ? renderIcon(node.icon) : undefined;
		if (glyph) {
			template.icon.appendChild(glyph);
		}
		// A row with no icon starts its label where a sibling's icon would, one indent in from the parent.
		template.icon.hidden = !!node.heading || !glyph;
		template.label.textContent = node.label;
		template.count.textContent = node.count ?? '';
	}

	disposeTemplate(): void { }
}

/**
 * The settings nav: a workbench tree with square rows that run edge to edge. Volt's pages fold
 * under Volt, extensions under Extensions; headings split the groups.
 */
export class SettingsNav extends Disposable {

	private readonly tree: WorkbenchObjectTree<ISettingsNavNode>;
	private readonly onDidOpenEmitter = this._register(new Emitter<string>());
	/** A page was picked (click or Enter). */
	readonly onDidOpen = this.onDidOpenEmitter.event;
	/** What the user folded or unfolded, kept across rebuilds. */
	private readonly collapsed = new Map<string, boolean>();
	private nodes: readonly ISettingsNavNode[] = [];
	private active: string | undefined;
	private expandAll = false;

	constructor(container: HTMLElement, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		const host = append(container, $('.volt-settings-nav'));
		this.tree = this._register(instantiationService.createInstance(WorkbenchObjectTree<ISettingsNavNode>, 'VoltSettingsNav', host, new NavDelegate(), [new NavRenderer()], {
			identityProvider: { getId: (node: ISettingsNavNode) => node.id },
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltSettings.nav', "Settings sections"),
				getAriaLabel: (node: ISettingsNavNode) => node.label,
				getRole: (node: ISettingsNavNode) => node.heading ? 'presentation' : 'treeitem',
			},
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			hideTwistiesOfChildlessElements: true,
			renderIndentGuides: RenderIndentGuides.None,
			// A click on a group folds or unfolds it; Volt also opens its own page.
			expandOnlyOnTwistieClick: false,
			findWidgetEnabled: false,
			paddingBottom: 8,
		}));
		// The workbench tree takes its indent and sticky rows from the user's tree settings. Children
		// step in a little, and no pinned parent row covers the rows under it.
		this.tree.updateOptions({ indent: NAV_INDENT, enableStickyScroll: false });
		this._register(this.tree.onDidChangeCollapseState(e => {
			const node = e.node.element;
			if (node && !this.expandAll) {
				this.collapsed.set(node.id, e.node.collapsed);
			}
		}));
		this._register(this.tree.onDidOpen(e => {
			const node = e.element;
			if (!node || node.heading || node.folder) {
				this.syncSelection();
				return;
			}
			this.onDidOpenEmitter.fire(node.id);
		}));
		const resize = new (getWindow(container).ResizeObserver)(() => this.tree.layout(host.clientHeight, host.clientWidth));
		resize.observe(host);
		this._register(toDisposable(() => resize.disconnect()));
	}

	/** Replaces the rows. `expandAll` unfolds every group (while a search is typed). */
	setNodes(nodes: readonly ISettingsNavNode[], expandAll: boolean): void {
		this.nodes = nodes;
		this.expandAll = expandAll;
		const toElements = (list: readonly ISettingsNavNode[]): ITreeElement<ISettingsNavNode>[] => list.map(node => ({
			element: node,
			children: node.children?.length ? toElements(node.children) : undefined,
			collapsible: !!node.children?.length,
			collapsed: expandAll ? false : this.collapsed.get(node.id) ?? !!node.collapsed,
		}));
		this.tree.setChildren(null, toElements(nodes));
		this.syncSelection();
	}

	/** Lights the open page, unfolding its group so it shows. */
	setActive(id: string): void {
		this.active = id;
		this.syncSelection();
	}

	private syncSelection(): void {
		const find = (list: readonly ISettingsNavNode[], parents: ISettingsNavNode[]): { node: ISettingsNavNode; parents: ISettingsNavNode[] } | undefined => {
			for (const node of list) {
				if (node.id === this.active) {
					return { node, parents };
				}
				const inner = node.children && find(node.children, [...parents, node]);
				if (inner) {
					return inner;
				}
			}
			return undefined;
		};
		const hit = this.active ? find(this.nodes, []) : undefined;
		if (!hit) {
			this.tree.setSelection([]);
			return;
		}
		for (const parent of hit.parents) {
			if (this.tree.isCollapsed(parent)) {
				this.tree.expand(parent);
			}
		}
		this.tree.setSelection([hit.node]);
		this.tree.setFocus([hit.node]);
		this.tree.reveal(hit.node);
	}

	focus(): void {
		this.tree.domFocus();
	}
}
