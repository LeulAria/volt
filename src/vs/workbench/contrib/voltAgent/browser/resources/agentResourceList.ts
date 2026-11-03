/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename, relativePath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { AGENT_RESOURCE_ECOSYSTEM_LABELS, AGENT_RESOURCE_SCOPE_KIND_LABELS, agentResourceGroup, agentResourceScopeKind, agentResourceScopeLabel } from '../../common/agentResources.js';
import { agentResourceReaders } from '../../common/agentResourcesModel.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createEcosystemIcon } from './agentResourceBrands.js';
import { IAgentResource } from './agentResourcesService.js';

export const AGENT_RESOURCE_ROW_HEIGHT = 54;

/** A small label on a row: a problem, scripts, read-only. */
export interface IAgentResourceChip {
	readonly label: string;
	readonly tone?: 'scope-workspace' | 'scope-global' | 'scope-external' | 'scope-managed' | 'warning' | 'error' | 'ok' | 'muted';
	readonly title?: string;
	readonly icon?: ThemeIcon;
}

export interface IAgentResourceListOptions {
	readonly home: () => URI | undefined;
	readonly ariaLabel: string;
	readonly onOpen: (item: IAgentResource) => void;
	/** The row's More menu, under its button. */
	readonly onMenu: (item: IAgentResource, anchor: HTMLElement) => void;
	/** Pills after the name: a skill's scripts, a subagent's model. */
	readonly chips?: (item: IAgentResource) => readonly IAgentResourceChip[];
	/** The second line; the description, else the kind, by default. */
	readonly detail?: (item: IAgentResource) => string | undefined;
	/** A name better than the file's ("code-review" for a skill's SKILL.md). */
	readonly name?: (item: IAgentResource) => string;
	/** Rows from more than one scope: each says its own. */
	readonly showScope?: boolean;
}

/** Where the file is, as the user knows it: `~/.claude/CLAUDE.md`, `packages/api/AGENTS.md`, or a managed folder's full path. */
export function agentResourcePath(item: IAgentResource, home: URI | undefined): string {
	if (item.scope === 'managed') {
		return item.resource.fsPath;
	}
	if (home && (item.scope === 'global' || item.scope === 'external')) {
		const fromHome = relativePath(home, item.resource);
		if (fromHome !== undefined) {
			return `~/${fromHome}`;
		}
	}
	return item.relativePath;
}

/** A skill goes by its folder, the rest by their file name. */
export function agentResourceName(item: IAgentResource): string {
	if (item.group === 'skills') {
		const parts = item.relativePath.split('/');
		return parts[parts.length - 2] || basename(item.resource);
	}
	return basename(item.resource);
}

/** The scope pill, for lists that mix scopes. */
export function agentResourceScopeChip(item: IAgentResource): IAgentResourceChip {
	const kind = agentResourceScopeKind(item.scope);
	return { label: kind === 'workspace' ? agentResourceScopeLabel(item.scope, item.relativePath) : AGENT_RESOURCE_SCOPE_KIND_LABELS[kind], tone: `scope-${kind}` };
}

/** What the row must say out loud: a problem, a file Volt will not write. */
export function agentResourceChips(item: IAgentResource): IAgentResourceChip[] {
	const chips: IAgentResourceChip[] = [];
	if (item.status.kind !== 'ok') {
		chips.push({ label: item.status.kind === 'error' ? localize('agentResources.chip.error', "Error") : localize('agentResources.chip.check', "Check"), tone: item.status.kind === 'error' ? 'error' : 'warning', icon: item.status.kind === 'error' ? Codicon.error : Codicon.warning, title: item.status.message });
	}
	if (item.readOnly) {
		chips.push({ label: localize('agentResources.readOnlyChip', "Read-only"), tone: 'muted', icon: Codicon.lock, title: item.readOnly });
	}
	return chips;
}

/** The tile's hover: whose file it is and who reads it. */
export function agentResourceSourceText(item: IAgentResource): string {
	const parts = [AGENT_RESOURCE_ECOSYSTEM_LABELS[item.ecosystem], item.kind];
	const readers = agentResourceReaders(item);
	if (readers && (readers.length > 1 || readers[0] !== item.ecosystem)) {
		parts.push(localize('agentResources.readBy', "Read by {0}", readers.map(reader => AGENT_RESOURCE_ECOSYSTEM_LABELS[reader]).join(', ')));
	}
	return parts.join(' · ');
}

export function renderAgentResourceChips(parent: HTMLElement, chips: readonly IAgentResourceChip[]): void {
	for (const chip of chips) {
		const el = append(parent, $(`span.volt-ares-chip${chip.tone ? `.${chip.tone}` : ''}`));
		if (chip.icon) {
			el.appendChild(renderIcon(chip.icon));
		}
		append(el, $('span')).textContent = chip.label;
		if (chip.title) {
			setAgentTooltip(el, chip.title);
		}
	}
}

class Delegate implements IListVirtualDelegate<IAgentResource> {
	getHeight(): number {
		return AGENT_RESOURCE_ROW_HEIGHT;
	}

	getTemplateId(): string {
		return Renderer.ID;
	}
}

interface ITemplate {
	readonly row: HTMLElement;
	readonly tile: HTMLElement;
	readonly name: HTMLElement;
	readonly path: HTMLElement;
	readonly chips: HTMLElement;
	readonly detail: HTMLElement;
	readonly source: HTMLElement;
	readonly open: HTMLElement;
	readonly more: HTMLElement;
	readonly store: DisposableStore;
}

class Renderer implements IListRenderer<IAgentResource, ITemplate> {
	static readonly ID = 'voltAgentResourceRow';
	readonly templateId = Renderer.ID;

	constructor(private readonly options: IAgentResourceListOptions) { }

	renderTemplate(container: HTMLElement): ITemplate {
		const row = append(container, $('.volt-ares-row'));
		const tile = append(row, $('span.volt-ares-tile'));
		const main = append(row, $('.volt-ares-row-main'));
		const first = append(main, $('.volt-ares-row-line'));
		const name = append(first, $('span.volt-ares-row-name'));
		const path = append(first, $('span.volt-ares-row-path'));
		const chips = append(first, $('span.volt-ares-row-chips'));
		const detail = append(main, $('.volt-ares-row-detail'));
		const source = append(row, $('span.volt-ares-row-source'));
		const actions = append(row, $('.volt-ares-row-actions'));
		// Spans, not buttons: the row is the list's. The list opens rows on its own pointer events.
		const open = append(actions, $('span.volt-ares-row-action'));
		open.setAttribute('role', 'button');
		open.appendChild(renderIcon(Codicon.goToFile));
		const more = append(actions, $('span.volt-ares-row-action'));
		more.setAttribute('role', 'button');
		more.appendChild(renderIcon(Codicon.ellipsis));
		return { row, tile, name, path, chips, detail, source, open, more, store: new DisposableStore() };
	}

	renderElement(item: IAgentResource, _index: number, template: ITemplate): void {
		template.store.clear();
		const home = this.options.home();
		const path = agentResourcePath(item, home);
		template.tile.replaceChildren(createEcosystemIcon(template.tile.ownerDocument, item.ecosystem, agentResourceGroup(item.group).icon, 16));
		setAgentTooltip(template.tile, agentResourceSourceText(item));
		template.name.textContent = this.options.name?.(item) ?? agentResourceName(item);
		template.path.textContent = path;
		setAgentTooltip(template.path, item.resource.fsPath);
		template.chips.replaceChildren();
		renderAgentResourceChips(template.chips, [...(this.options.showScope ? [agentResourceScopeChip(item)] : []), ...agentResourceChips(item), ...(this.options.chips?.(item) ?? [])]);
		const detail = this.options.detail ? this.options.detail(item) : (item.description || (item.status.kind !== 'ok' ? item.status.message : undefined) || item.kind);
		template.detail.textContent = detail ?? '';
		template.detail.classList.toggle('warning', item.status.kind !== 'ok' && detail === item.status.message);
		template.source.textContent = AGENT_RESOURCE_ECOSYSTEM_LABELS[item.ecosystem];
		const openLabel = localize('agentResources.openFile', "Open {0}", basename(item.resource));
		template.open.setAttribute('aria-label', openLabel);
		setAgentTooltip(template.open, openLabel);
		const moreLabel = localize('agentResources.more', "More Actions");
		template.more.setAttribute('aria-label', moreLabel);
		setAgentTooltip(template.more, moreLabel);
		for (const [button, run] of [[template.open, () => this.options.onOpen(item)], [template.more, () => this.options.onMenu(item, template.more)]] as const) {
			for (const type of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) {
				template.store.add(addDisposableListener(button, type, e => EventHelper.stop(e, true)));
			}
			template.store.add(addDisposableListener(button, 'click', e => {
				EventHelper.stop(e, true);
				run();
			}));
		}
		template.store.add(addDisposableListener(template.row, 'contextmenu', e => {
			EventHelper.stop(e, true);
			this.options.onMenu(item, template.more);
		}));
	}

	disposeTemplate(template: ITemplate): void {
		template.store.dispose();
	}
}

/**
 * A run of discovered files as VS Code list rows, square and edge to edge: the tool's mark, the
 * name and where it is, then what it does. Sized to its rows, so the page scrolls, not the list.
 */
export class AgentResourceList extends Disposable {

	private readonly list: WorkbenchList<IAgentResource>;
	private readonly host: HTMLElement;

	constructor(
		parent: HTMLElement,
		options: IAgentResourceListOptions,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.host = append(parent, $('.volt-ares-list'));
		this.list = this._register(instantiationService.createInstance(WorkbenchList<IAgentResource>, 'VoltAgentResourcesPage', this.host, new Delegate(), [new Renderer(options)], {
			identityProvider: { getId: (item: IAgentResource) => item.resource.toString() },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => options.ariaLabel,
				getAriaLabel: (item: IAgentResource) => `${options.name?.(item) ?? agentResourceName(item)}, ${agentResourcePath(item, options.home())}, ${AGENT_RESOURCE_ECOSYSTEM_LABELS[item.ecosystem]}${item.status.message ? `, ${item.status.message}` : ''}`,
			},
		}));
		this._register(this.list.onDidOpen(e => e.element && options.onOpen(e.element)));
		this._register(this.list.onDidBlur(() => this.list.setSelection([])));
	}

	setItems(items: readonly IAgentResource[]): void {
		const height = items.length * AGENT_RESOURCE_ROW_HEIGHT;
		this.host.style.height = `${height}px`;
		this.list.layout(height);
		this.list.splice(0, this.list.length, [...items]);
	}
}
