/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, getComputedStyle, isHTMLElement } from '../../../../../base/browser/dom.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../base/browser/ui/list/listWidget.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { editorBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { createBrandIcon } from '../../../../services/voltRuntime/browser/providers/providerBrands.js';
import {
	formatContextPercent,
	formatContextTokens,
	IContextUsageModelRow,
	IContextUsageProviderGroup,
} from './agentContextUsage.js';
import { bindTruncatedHoverTooltip } from '../chrome/agentTooltip.js';

type ContextModelGroupElement = { readonly type: 'group'; readonly family: string; readonly label: string };
type ContextModelRowElement = { readonly type: 'model'; readonly model: IContextUsageModelRow };
type ContextModelMessageElement = { readonly type: 'message'; readonly text: string };
type ContextModelElement = ContextModelGroupElement | ContextModelRowElement | ContextModelMessageElement;

const GROUP_HEIGHT = 22;
const MODEL_HEIGHT = 28;

const identityProvider: IIdentityProvider<ContextModelElement> = {
	getId(element) {
		switch (element.type) {
			case 'group': return `group:${element.family}`;
			case 'model': return `model:${element.model.ref}`;
			case 'message': return 'message';
		}
	}
};

interface IContextModelTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly text: HTMLElement;
	readonly badge: HTMLElement;
	readonly track: HTMLElement;
	readonly fill: HTMLElement;
	readonly window: HTMLElement;
	readonly pct: HTMLElement;
	readonly elementDisposables: DisposableStore;
}

class AgentContextModelDelegate implements IListVirtualDelegate<ContextModelElement> {
	getHeight(element: ContextModelElement): number {
		return element.type === 'model' ? MODEL_HEIGHT : GROUP_HEIGHT;
	}

	getTemplateId(): string {
		return AgentContextModelRenderer.ID;
	}
}

class AgentContextModelRenderer implements ITreeRenderer<ContextModelElement, void, IContextModelTemplate> {
	static readonly ID = 'agentContextModel';
	readonly templateId = AgentContextModelRenderer.ID;

	renderTemplate(container: HTMLElement): IContextModelTemplate {
		container.classList.add('volt-agent-context-model-row');
		const icon = append(container, $('span.icon'));
		const name = append(container, $('span.name'));
		const text = append(name, $('span.text'));
		const badge = append(name, $('span.badge'));
		const track = append(container, $('span.track'));
		const fill = append(track, $('span.fill'));
		const window = append(container, $('span.window'));
		const pct = append(container, $('span.pct'));
		return { container, icon, name, text, badge, track, fill, window, pct, elementDisposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<ContextModelElement, void>, _index: number, template: IContextModelTemplate): void {
		template.elementDisposables.clear();
		template.icon.replaceChildren();
		template.text.textContent = '';
		template.badge.textContent = '';
		template.window.textContent = '';
		template.pct.textContent = '';
		template.fill.style.width = '0';
		template.container.classList.remove('is-group', 'is-model', 'is-message', 'active', 'overflow');

		const element = node.element;
		if (element.type === 'group') {
			template.container.classList.add('is-group');
			template.icon.appendChild(createBrandIcon(element.family, 13));
			template.text.textContent = element.label;
			return;
		}
		if (element.type === 'message') {
			template.container.classList.add('is-message');
			template.text.textContent = element.text;
			return;
		}

		const model = element.model;
		template.container.classList.add('is-model');
		template.container.classList.toggle('active', model.active);
		template.container.classList.toggle('overflow', !model.fits);
		template.text.textContent = model.name;
		template.elementDisposables.add(bindTruncatedHoverTooltip(template.text, model.name, 1000));
		if (model.active) {
			template.badge.textContent = localize('voltAgent.contextActive', "Active");
		}
		template.fill.style.width = `${Math.min(100, model.percent)}%`;
		template.window.textContent = formatContextTokens(model.window);
		template.pct.textContent = formatContextPercent(Math.min(model.percent, 999));
	}

	disposeElement(_node: ITreeNode<ContextModelElement, void>, _index: number, template: IContextModelTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: IContextModelTemplate): void {
		template.elementDisposables.dispose();
	}
}

class AgentContextModelAccessibilityProvider implements IListAccessibilityProvider<ContextModelElement> {
	getWidgetAriaLabel(): string {
		return localize('voltAgent.contextModelsList', "Models");
	}

	getAriaLabel(element: ContextModelElement): string {
		switch (element.type) {
			case 'group':
				return element.label;
			case 'message':
				return element.text;
			case 'model': {
				const usage = formatContextPercent(Math.min(element.model.percent, 999));
				const window = formatContextTokens(element.model.window);
				return element.model.active
					? localize('voltAgent.contextModelActiveAria', "{0}, active, {1} of {2}", element.model.name, usage, window)
					: localize('voltAgent.contextModelAria', "{0}, {1} of {2}", element.model.name, usage, window);
			}
		}
	}
}

/**
 * Provider-grouped model comparison list. Sized to its content so the
 * parent context panel is the only scroller.
 */
export class AgentContextModelsList extends Disposable {

	readonly element: HTMLElement;

	private readonly treeContainer: HTMLElement;
	private readonly tree: WorkbenchObjectTree<ContextModelElement>;
	private readonly collapsedGroups = new Set<string>();
	private lastWidth = 0;
	private lastHeight = 0;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.element = container;
		this.treeContainer = append(container, $('.volt-agent-context-models-tree'));

		this.tree = this._register(instantiationService.createInstance(
			WorkbenchObjectTree<ContextModelElement>,
			'AgentContextModels',
			this.treeContainer,
			new AgentContextModelDelegate(),
			[new AgentContextModelRenderer()],
			{
				accessibilityProvider: new AgentContextModelAccessibilityProvider(),
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (element: ContextModelElement) => {
						switch (element.type) {
							case 'group': return element.label;
							case 'model': return element.model.name;
							case 'message': return element.text;
						}
					}
				},
				identityProvider,
				multipleSelectionSupport: false,
				hideTwistiesOfChildlessElements: true,
				renderIndentGuides: RenderIndentGuides.Always,
				setRowLineHeight: false,
				horizontalScrolling: false,
				paddingBottom: GROUP_HEIGHT,
				overrideStyles: { listBackground: editorBackground },
			}
		));

		this._register(this.tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (element?.type === 'group') {
				if (e.node.collapsed) {
					this.collapsedGroups.add(element.family);
				} else {
					this.collapsedGroups.delete(element.family);
				}
			}
		}));
		this._register(this.tree.onDidChangeContentHeight(() => this.layout()));
		this._register(addDisposableListener(this.treeContainer, 'wheel', e => {
			const scroll = this.element.closest('.volt-agent-context-scroll');
			if (!isHTMLElement(scroll) || scroll.scrollHeight <= scroll.clientHeight) {
				return;
			}
			scroll.scrollTop += e.deltaY;
			e.preventDefault();
			e.stopPropagation();
		}, true));

		const observer = new ResizeObserver(() => this.layout());
		observer.observe(container);
		this._register(toDisposable(() => observer.disconnect()));
	}

	layout(): void {
		if (this.element.clientWidth <= 0 || getComputedStyle(this.element).display === 'none') {
			return;
		}
		const width = this.treeContainer.clientWidth || this.element.clientWidth;
		const height = Math.max(this.tree.contentHeight, 22);
		if (width === this.lastWidth && height === this.lastHeight) {
			return;
		}
		this.lastWidth = width;
		this.lastHeight = height;
		this.treeContainer.style.height = `${height}px`;
		this.tree.layout(height, width);
	}

	focus(): void {
		this.tree.domFocus();
	}

	setGroups(groups: readonly IContextUsageProviderGroup[]): void {
		const children: IObjectTreeElement<ContextModelElement>[] = [];
		let active: ContextModelRowElement | undefined;
		if (!groups.length) {
			children.push({
				element: { type: 'message', text: localize('voltAgent.contextNoModels', "No models match") },
				collapsible: false,
			});
		} else {
			for (const group of groups) {
				const models: IObjectTreeElement<ContextModelElement>[] = group.models.map(model => {
					const element: ContextModelRowElement = { type: 'model', model };
					if (model.active) {
						active = element;
					}
					return { element, collapsible: false };
				});
				children.push({
					element: { type: 'group', family: group.family, label: group.label },
					collapsible: true,
					collapsed: this.collapsedGroups.has(group.family),
					children: models,
				});
			}
		}
		this.tree.setChildren(null, children);
		if (active && this.tree.hasElement(active)) {
			this.tree.setSelection([active]);
			this.tree.setFocus([active]);
		} else {
			this.tree.setSelection([]);
			this.tree.setFocus([]);
		}
		this.lastWidth = 0;
		this.lastHeight = 0;
		this.layout();
	}

	clear(): void {
		this.tree.setChildren(null, []);
		this.tree.setSelection([]);
		this.tree.setFocus([]);
		this.treeContainer.style.height = '';
		this.lastWidth = 0;
		this.lastHeight = 0;
	}
}
