/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { RenderIndentGuides } from '../../../../../base/browser/ui/tree/abstractTree.js';
import { ITreeElement, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IMatch, matchesFuzzy, matchesWords } from '../../../../../base/common/filters.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { describeCron } from '../../../../services/voltRuntime/common/automations/automationCron.js';
import { AUTOMATION_EVENTS, AUTOMATION_PROVIDERS, AutomationProvider, eventLabel, IAutomationEventNode, providerLabel } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { getWorkflowNodeType, nodeDisplayName, nodeOutputs, workflowNodeTypes } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { IWorkflowDefinition, IWorkflowPosition, IWorkflowTrigger, WORKFLOW_NODE_CATEGORIES, WorkflowFieldKind, WorkflowNodeCategory, WorkflowNodeColor, WorkflowRecord } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { WorkflowEditorModel } from '../../common/workflows/workflowEditorModel.js';
import { clockIcon, providerIcon } from '../automations/automationIcons.js';
import { showTriggerMenu } from '../automations/automationPickers.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { createHomeSearchIcon } from '../home/agentHomeIcons.js';
import { IWorkflowFieldSources, workflowPortColorVar, workflowTypeIcon } from './workflowFieldEditors.js';

/**
 * Adding nodes: the "Add a node" panel (a tree of compact rows grouped by category, like the home
 * sidebar) and the hierarchical menu the canvas opens at the pointer (a row per
 * category with flyouts, nested by group: Git & GitHub > GitHub > Draft PR). Both list the same
 * blocks: every node type, the start node's triggers, and the user's own skills, MCP servers and
 * saved workflows as preconfigured nodes.
 */

//#region Blocks

/** `workflows`: the user's saved workflows (sub-workflow nodes), shown as a category of their own. */
export type WorkflowBlockCategory = WorkflowNodeCategory | 'workflows';

export interface IWorkflowBlock {
	readonly id: string;
	readonly category: WorkflowBlockCategory;
	/** Submenu inside the category ("GitHub", "Slack"). */
	readonly group?: string;
	/** The node type it adds. */
	readonly type?: string;
	/** A trigger row: sets the workflow's trigger (the start node) instead of adding a node. */
	readonly trigger?: IWorkflowTrigger;
	/** An event service row of the panel: its events open in a menu. */
	readonly provider?: AutomationProvider;
	readonly label: string;
	readonly description: string;
	readonly icon: ThemeIcon | (() => HTMLElement | SVGElement);
	readonly color?: WorkflowNodeColor;
	readonly badge?: string;
	readonly keywords?: string;
	/** Preset config (a skill, a server, a workflow already picked). */
	readonly config?: WorkflowRecord;
	readonly name?: string;
}

/** Where a new node goes and what it connects to. */
export interface IWorkflowAddRequest {
	/** Canvas (world) position of the new node. */
	readonly at: IWorkflowPosition;
	readonly from?: { readonly nodeId: string; readonly port: string };
	readonly splitEdgeId?: string;
}

const CATEGORY_ORDER: readonly { readonly id: WorkflowBlockCategory; readonly label: string; readonly icon: ThemeIcon }[] = [
	...WORKFLOW_NODE_CATEGORIES.flatMap(category => {
		const entry = { id: category.id as WorkflowBlockCategory, label: category.label, icon: categoryIcon(category.id) };
		// Saved workflows sit right after flow control (sub-workflows are a kind of flow).
		return category.id === 'flow' ? [entry, { id: 'workflows' as WorkflowBlockCategory, label: localize('voltWorkflows.yourWorkflows', "Your Workflows"), icon: Codicon.typeHierarchy }] : [entry];
	}),
];

function categoryIcon(category: WorkflowBlockCategory): ThemeIcon {
	switch (category) {
		case 'trigger': return Codicon.zap;
		case 'ai': return Codicon.robot;
		case 'flow': return Codicon.typeHierarchySub;
		case 'workflows': return Codicon.typeHierarchy;
		case 'scripts': return Codicon.terminal;
		case 'git': return Codicon.github;
		case 'mcp': return Codicon.server;
		case 'skills': return Codicon.symbolKeyword;
		case 'integrations': return Codicon.plug;
		case 'data': return Codicon.json;
		case 'outputs': return Codicon.output;
		case 'custom': return Codicon.tools;
	}
}

export function workflowCategoryLabel(category: WorkflowBlockCategory): string {
	return CATEGORY_ORDER.find(entry => entry.id === category)?.label ?? category;
}

const DEFAULT_SCHEDULE_CRON = '0 9 * * 1-5';

/** A trigger picked from the Automations event catalog, as the workflow's trigger. */
export function workflowTriggerFromPick(provider: AutomationProvider, event: string, previous?: IWorkflowTrigger): IWorkflowTrigger {
	if (provider === 'schedule') {
		const cron = event === 'hourly' ? '0 * * * *' : event === 'daily' ? '0 9 * * *' : event === 'weekly' ? '0 9 * * 1' : DEFAULT_SCHEDULE_CRON;
		return { type: 'schedule', cron, ...(previous?.timezone ? { timezone: previous.timezone } : {}) };
	}
	return {
		type: 'event',
		provider,
		event,
		// The same service's sample payload still fits a different event of it often enough to keep.
		...(previous?.provider === provider && previous.samplePayload !== undefined ? { samplePayload: previous.samplePayload } : {}),
	};
}

function isProvider(value: string | undefined): value is AutomationProvider {
	return !!value && (AUTOMATION_PROVIDERS as readonly string[]).includes(value);
}

/** "Manual", "Weekdays at 09:00", "GitHub · Pull request opened". */
export function describeWorkflowTrigger(trigger: IWorkflowTrigger): string {
	switch (trigger.type) {
		case 'manual':
			return localize('voltWorkflows.manual', "Manual");
		case 'schedule':
			if (trigger.cron) {
				return describeCron(trigger.cron);
			}
			return trigger.everyMinutes ? localize('voltWorkflows.everyMinutes', "Every {0} minutes", trigger.everyMinutes) : localize('voltWorkflows.schedule', "Schedule");
		case 'event': {
			if (!isProvider(trigger.provider)) {
				return localize('voltWorkflows.event', "Event");
			}
			const service = providerLabel(trigger.provider);
			return trigger.event ? `${service} · ${eventLabel(trigger.provider, trigger.event)}` : service;
		}
	}
}

export function workflowTriggerIcon(trigger: IWorkflowTrigger): () => HTMLElement | SVGElement {
	if (trigger.type === 'schedule') {
		return () => clockIcon();
	}
	if (trigger.type === 'event' && isProvider(trigger.provider)) {
		const provider = trigger.provider;
		return () => providerIcon(provider);
	}
	return () => providerIcon('manual');
}

/** Sets the start node's trigger as one undo step. */
export function applyWorkflowTrigger(model: WorkflowEditorModel, trigger: IWorkflowTrigger, label = localize('voltWorkflows.changeTrigger', "Change trigger")): void {
	model.apply(label, definition => JSON.stringify(definition.trigger) === JSON.stringify(trigger) ? definition : { ...definition, trigger }, 'picker');
}

/** The Automations trigger menu (Scheduled > Daily; GitHub > Pull request… > Opened), setting the workflow's trigger. */
export function showWorkflowTriggerMenu(contextView: IContextViewService, anchor: HTMLElement, model: WorkflowEditorModel, onDidPick?: () => void): IVoltMenuHandle {
	return showTriggerMenu(contextView, anchor, pick => {
		applyWorkflowTrigger(model, workflowTriggerFromPick(pick.provider, pick.event, model.definition.trigger));
		onDidPick?.();
	});
}

/** Every node type plus the trigger rows; the start node is left out once the workflow has one. */
export function workflowCatalogBlocks(definition: IWorkflowDefinition): IWorkflowBlock[] {
	const blocks: IWorkflowBlock[] = [
		{
			id: 'trigger:manual', category: 'trigger', trigger: { type: 'manual' },
			label: localize('voltWorkflows.manualTrigger', "Manual"),
			description: localize('voltWorkflows.manualTriggerDesc', "Run from the builder, a chat or an automation."),
			icon: () => providerIcon('manual'), color: 'orange', keywords: 'manual run button',
		},
		{
			id: 'trigger:schedule', category: 'trigger', trigger: workflowTriggerFromPick('schedule', 'cron', definition.trigger),
			label: localize('voltWorkflows.scheduleTrigger', "Schedule"),
			description: localize('voltWorkflows.scheduleTriggerDesc', "Run on a cron schedule or every few minutes."),
			icon: () => clockIcon(), color: 'orange', keywords: 'cron schedule hourly daily weekly timer',
		},
		...AUTOMATION_PROVIDERS.filter(provider => provider !== 'schedule').map((provider): IWorkflowBlock => ({
			id: `trigger:provider:${provider}`, category: 'trigger', provider,
			label: providerLabel(provider),
			description: localize('voltWorkflows.providerTriggerDesc', "Start when {0} sends an event.", providerLabel(provider)),
			icon: () => providerIcon(provider), color: 'orange', badge: localize('voltWorkflows.eventBadge', "Event"),
			keywords: flatEventLabels(AUTOMATION_EVENTS[provider]),
		})),
	];
	for (const type of workflowNodeTypes()) {
		if (type.hidden || (type.singleton && definition.nodes.some(node => node.type === type.type))) {
			continue;
		}
		blocks.push({
			id: `type:${type.type}`,
			category: type.category,
			...(type.group ? { group: type.group } : {}),
			type: type.type,
			label: type.label,
			description: type.description,
			icon: ThemeIcon.fromId(type.icon),
			...(type.color ? { color: type.color } : {}),
			...(type.badge ? { badge: type.badge } : {}),
			keywords: [type.type, type.keywords, type.group].filter(Boolean).join(' '),
		});
	}
	return blocks;
}

function presetKey(type: string, kind: WorkflowFieldKind): string | undefined {
	return getWorkflowNodeType(type)?.fields.find(field => field.kind === kind)?.key;
}

/** The user's skills, MCP servers and saved workflows as preconfigured skill / MCP tool / sub-workflow nodes. */
export async function workflowDynamicBlocks(sources: IWorkflowFieldSources, workflowId: string | undefined): Promise<IWorkflowBlock[]> {
	const skillKey = presetKey('skill', 'skill');
	const mcpKey = presetKey('mcp_tool', 'mcpServer');
	const workflowKey = presetKey('subworkflow', 'workflow');
	const [skills, servers] = await Promise.all([
		skillKey ? sources.skills().catch(() => []) : Promise.resolve([]),
		mcpKey ? sources.mcpServers().catch(() => []) : Promise.resolve([]),
	]);
	const blocks: IWorkflowBlock[] = [];
	const skillType = getWorkflowNodeType('skill');
	for (const skill of skillKey ? skills : []) {
		blocks.push({
			id: `skill:${skill.name}`, category: 'skills', type: 'skill',
			label: `/${skill.name}`,
			description: skill.summary || localize('voltWorkflows.skillDesc', "Run the {0} skill.", skill.name),
			icon: ThemeIcon.fromId(skillType?.icon ?? 'symbol-keyword'), color: skillType?.color ?? 'teal',
			keywords: `${skill.name} ${skill.summary} ${skill.location ?? ''}`,
			name: skill.name, config: { [skillKey!]: skill.name },
		});
	}
	const mcpType = getWorkflowNodeType('mcp_tool');
	for (const server of mcpKey ? servers : []) {
		blocks.push({
			id: `mcp:${server.name}`, category: 'mcp', type: 'mcp_tool',
			label: server.name,
			description: server.scope === 'project' ? localize('voltWorkflows.mcpProjectDesc', "Call a tool on this project's {0} server.", server.name) : localize('voltWorkflows.mcpUserDesc', "Call a tool on your {0} server.", server.name),
			icon: ThemeIcon.fromId(mcpType?.icon ?? 'server'), color: mcpType?.color ?? 'blue', badge: 'MCP',
			keywords: `${server.name} mcp ${server.scope}`,
			name: server.name, config: { [mcpKey!]: server.name },
		});
	}
	const subType = getWorkflowNodeType('subworkflow');
	for (const summary of workflowKey ? sources.workflows() : []) {
		if (summary.id === workflowId) {
			continue;
		}
		blocks.push({
			id: `workflow:${summary.id}`, category: 'workflows', type: 'subworkflow',
			label: summary.name,
			description: summary.description || localize('voltWorkflows.subDesc', "Run this workflow and wait for it ({0} nodes).", summary.nodeCount),
			icon: ThemeIcon.fromId(subType?.icon ?? 'type-hierarchy'), color: subType?.color ?? 'pink',
			keywords: `${summary.id} ${summary.description ?? ''}`,
			name: summary.name, config: { [workflowKey!]: summary.id },
		});
	}
	return blocks;
}

/** Adds the block's node at the request (connected as asked), or sets the trigger. Returns the node to select. */
export function addWorkflowBlock(model: WorkflowEditorModel, block: IWorkflowBlock, request: IWorkflowAddRequest): string | undefined {
	if (block.trigger) {
		applyWorkflowTrigger(model, block.trigger);
		return model.definition.nodes.find(node => node.type === 'start')?.id;
	}
	if (!block.type || !getWorkflowNodeType(block.type)) {
		return undefined;
	}
	return model.addNode(block.type, request.at, {
		...(block.config ? { config: block.config } : {}),
		...(block.name ? { name: block.name } : {}),
		...(request.from ? { connectFrom: request.from } : {}),
		...(request.splitEdgeId ? { splitEdgeId: request.splitEdgeId } : {}),
	}, 'picker');
}

function flatEventLabels(nodes: readonly IAutomationEventNode[]): string {
	return nodes.map(node => node.children ? `${node.label} ${flatEventLabels(node.children)}` : node.label).join(' ');
}

//#endregion

//#region Menu

/** A compact menu row like the Add Trigger menu: a plain icon, the label, the description as its tooltip. */
function blockMenuItem(block: IWorkflowBlock, _twoLine?: boolean): IVoltMenuItem<IWorkflowBlock> {
	return {
		id: block.id,
		label: block.label,
		tooltip: block.description,
		icon: block.icon,
		keywords: `${block.keywords ?? ''} ${block.description} ${block.group ?? ''}`,
		data: block,
	};
}

/** A service's events as menu rows: leaves set the trigger, "Pull request…" opens a flyout. */
function eventSections(provider: AutomationProvider, nodes: readonly IAutomationEventNode[], previous: IWorkflowTrigger): IVoltMenuSection<IWorkflowBlock>[] {
	const sections: { id: string; title?: string; items: IVoltMenuItem<IWorkflowBlock>[] }[] = [{ id: `${provider}-main`, items: [] }];
	const item = (node: IAutomationEventNode): IVoltMenuItem<IWorkflowBlock> => {
		const block: IWorkflowBlock = node.event
			? { id: `trigger:${provider}:${node.event}`, category: 'trigger', trigger: workflowTriggerFromPick(provider, node.event, previous), label: node.label, description: providerLabel(provider), icon: provider === 'schedule' ? () => clockIcon() : () => providerIcon(provider), color: 'orange' }
			: { id: `trigger:${provider}:${node.label}`, category: 'trigger', label: node.label, description: providerLabel(provider), icon: () => providerIcon(provider) };
		return node.children
			? { id: block.id, label: node.label, submenu: { sections: eventSections(provider, node.children, previous), width: 220, className: 'volt-auto-menu volt-wfb-menu' }, data: block }
			: { id: block.id, label: node.label, data: block };
	};
	for (const node of nodes) {
		if (node.section) {
			sections.push({ id: `${provider}-${node.section}`, title: node.section, items: [] });
		}
		sections[sections.length - 1].items.push(item(node));
	}
	return sections.filter(section => section.items.length);
}

function triggerLeaves(provider: AutomationProvider, nodes: readonly IAutomationEventNode[], previous: IWorkflowTrigger, prefix: string): IWorkflowBlock[] {
	return nodes.flatMap(node => node.children
		? triggerLeaves(provider, node.children, previous, `${prefix}${node.label.replace(/…$/, '')} `)
		: node.event ? [{ id: `trigger:${provider}:${node.event}`, category: 'trigger' as const, trigger: workflowTriggerFromPick(provider, node.event, previous), label: `${providerLabel(provider)}: ${prefix}${node.label}`, description: localize('voltWorkflows.setsTrigger', "Sets the trigger"), icon: provider === 'schedule' ? () => clockIcon() : () => providerIcon(provider), color: 'orange' as const }] : []);
}

function categorySections(category: WorkflowBlockCategory, blocks: readonly IWorkflowBlock[], previous: IWorkflowTrigger): IVoltMenuSection<IWorkflowBlock>[] {
	if (category === 'trigger') {
		const manual = blocks.find(block => block.id === 'trigger:manual');
		const items: IVoltMenuItem<IWorkflowBlock>[] = [
			...(manual ? [blockMenuItem(manual, true)] : []),
			...AUTOMATION_PROVIDERS.map((provider): IVoltMenuItem<IWorkflowBlock> => ({
				id: `provider:${provider}`,
				label: providerLabel(provider),
				icon: provider === 'schedule' ? () => clockIcon() : () => providerIcon(provider),
				keywords: flatEventLabels(AUTOMATION_EVENTS[provider]),
				submenu: { sections: eventSections(provider, AUTOMATION_EVENTS[provider], previous), width: 220, className: 'volt-auto-menu volt-wfb-menu' },
				data: { id: `provider:${provider}`, category: 'trigger', label: providerLabel(provider), description: '', icon: () => providerIcon(provider) },
			})),
		];
		const nodeTypes = blocks.filter(block => block.type);
		return [{ id: 'triggers', items }, ...(nodeTypes.length ? [{ id: 'trigger-nodes', items: nodeTypes.map(block => blockMenuItem(block, true)) }] : [])];
	}
	const loose: IVoltMenuItem<IWorkflowBlock>[] = [];
	const groups = new Map<string, IWorkflowBlock[]>();
	for (const block of blocks) {
		if (block.group) {
			let members = groups.get(block.group);
			if (!members) {
				members = [];
				groups.set(block.group, members);
			}
			members.push(block);
		} else {
			loose.push(blockMenuItem(block, true));
		}
	}
	const groupItems = [...groups].map(([group, members]): IVoltMenuItem<IWorkflowBlock> => ({
		id: `group:${category}:${group}`,
		label: group,
		icon: members[0].icon,
		keywords: members.map(member => member.label).join(' '),
		submenu: { sections: [{ id: group, items: members.map(member => blockMenuItem(member, true)) }], width: 300, className: 'volt-auto-menu volt-wfb-menu' },
		data: { id: `group:${group}`, category, label: group, description: '', icon: Codicon.folder },
	}));
	return [
		...(loose.length ? [{ id: `${category}-loose`, items: loose }] : []),
		...(groupItems.length ? [{ id: `${category}-groups`, items: groupItems }] : []),
	];
}

export interface IWorkflowNodeMenuOptions {
	readonly definition: () => IWorkflowDefinition;
	readonly sources: IWorkflowFieldSources;
	readonly workflowId?: string;
	/** "Add after Review → done". */
	readonly title?: string;
	readonly position?: 'below' | 'above';
	readonly onPick: (block: IWorkflowBlock) => void;
	readonly onHide?: () => void;
}

/**
 * The searchable node menu: a row per category with a flyout (nested by group); searching lists
 * every block and trigger flat. Picks go to `onPick` (add with {@link addWorkflowBlock}).
 */
export function showWorkflowNodeMenu(contextView: IContextViewService, anchor: HTMLElement, options: IWorkflowNodeMenuOptions): IVoltMenuHandle {
	let cached: IWorkflowBlock[] | undefined;
	const load = async () => {
		if (!cached) {
			const definition = options.definition();
			cached = [...workflowCatalogBlocks(definition), ...await workflowDynamicBlocks(options.sources, options.workflowId).catch(() => [])];
		}
		return cached;
	};
	return showVoltMenu<IWorkflowBlock>(contextView, {
		anchor,
		gap: 2,
		width: 300,
		position: options.position ?? 'below',
		className: 'volt-auto-menu volt-wfb-menu volt-wfb-node-menu',
		ariaLabel: options.title ?? localize('voltWorkflows.addNode', "Add a node"),
		...(options.title ? { heading: { title: options.title } } : {}),
		search: { placeholder: localize('voltWorkflows.searchBlocks', "Search nodes, triggers, skills"), icon: true },
		sections: async () => {
			const blocks = await load();
			const previous = options.definition().trigger;
			const rows: IVoltMenuItem<IWorkflowBlock>[] = [];
			for (const category of CATEGORY_ORDER) {
				const members = blocks.filter(block => block.category === category.id);
				if (!members.length) {
					continue;
				}
				rows.push({
					id: `category:${category.id}`,
					label: category.label,
					icon: category.icon,
					badge: category.id === 'trigger' ? undefined : String(members.length),
					keywords: members.map(member => member.label).join(' '),
					submenu: { sections: categorySections(category.id, members, previous), width: 300, maxListHeight: 420, className: 'volt-auto-menu volt-wfb-menu' },
					data: { id: category.id, category: category.id, label: category.label, description: '', icon: category.icon },
				});
			}
			// Flyout rows stay out of a search, so every leaf is also listed flat for it.
			const leaves = [
				...blocks.filter(block => !block.provider && (block.type || block.trigger)),
				...AUTOMATION_PROVIDERS.flatMap(provider => triggerLeaves(provider, AUTOMATION_EVENTS[provider], previous, '')),
			];
			return [
				{ id: 'categories', items: rows },
				{ id: 'search', searchOnly: true, items: leaves.map(block => ({ ...blockMenuItem(block, false), description: block.group ?? workflowCategoryLabel(block.category) })) },
			];
		},
		onPick: item => {
			if (item.data.type || item.data.trigger) {
				options.onPick(item.data);
			}
		},
		...(options.onHide ? { onHide: options.onHide } : {}),
	});
}

/** A 1px anchor at a point in `container` (a canvas context menu); removed when disposed. */
export function pointAnchor(container: HTMLElement, clientX: number, clientY: number): { readonly element: HTMLElement; dispose(): void } {
	const rect = container.getBoundingClientRect();
	const element = append(container, $('.volt-wfb-point-anchor'));
	element.style.left = `${clientX - rect.left}px`;
	element.style.top = `${clientY - rect.top}px`;
	return { element, dispose: () => element.remove() };
}

//#endregion

//#region Panel

type PickerElement =
	| { readonly kind: 'category'; readonly id: string; readonly category: WorkflowBlockCategory; readonly label: string; readonly count: number }
	| { readonly kind: 'block'; readonly id: string; readonly block: IWorkflowBlock; readonly matches?: IMatch[] };

/** One height for headers and blocks: the compact rows of Volt's menus and the home sidebar. */
const ROW_HEIGHT = 26;

class PickerDelegate implements IListVirtualDelegate<PickerElement> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(element: PickerElement): string {
		return element.kind;
	}
}

interface ICategoryTemplate {
	readonly label: HTMLElement;
	readonly count: HTMLElement;
}

/** A category: the home sidebar's group header (11px bold uppercase, count at the end); the tree draws the chevron. */
class CategoryRenderer implements ITreeRenderer<PickerElement, void, ICategoryTemplate> {
	readonly templateId = 'category';
	renderTemplate(container: HTMLElement): ICategoryTemplate {
		const element = append(container, $('.volt-wfb-picker-category'));
		return { label: append(element, $('span.label')), count: append(element, $('span.count')) };
	}
	renderElement(node: ITreeNode<PickerElement, void>, _index: number, template: ICategoryTemplate): void {
		const element = node.element;
		if (element.kind !== 'category') {
			return;
		}
		template.label.textContent = element.label;
		template.count.textContent = String(element.count);
	}
	disposeTemplate(): void { }
}

interface IBlockTemplate {
	readonly element: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HighlightedLabel;
	readonly description: HTMLElement;
	readonly chevron: HTMLElement;
}

/** A block: a 16px icon, the label, its description muted on the same line, a chevron when it opens a menu. */
class BlockRenderer implements ITreeRenderer<PickerElement, void, IBlockTemplate> {
	readonly templateId = 'block';
	renderTemplate(container: HTMLElement): IBlockTemplate {
		const element = append(container, $('.volt-wfb-picker-block'));
		const icon = append(element, $('span.icon'));
		const label = new HighlightedLabel(append(element, $('span.label')));
		const description = append(element, $('span.description'));
		const chevron = append(element, $('span.chevron'));
		chevron.appendChild(renderIcon(Codicon.chevronRight));
		return { element, icon, label, description, chevron };
	}
	renderElement(node: ITreeNode<PickerElement, void>, _index: number, template: IBlockTemplate): void {
		const element = node.element;
		if (element.kind !== 'block') {
			return;
		}
		const block = element.block;
		clearNode(template.icon);
		template.icon.appendChild(ThemeIcon.isThemeIcon(block.icon) ? renderIcon(block.icon) : block.icon());
		template.label.set(block.label, element.matches);
		template.description.textContent = block.group ? `${block.group} · ${block.description}` : block.description;
		template.chevron.classList.toggle('hidden', !block.provider);
		template.element.title = block.description;
	}
	disposeTemplate(template: IBlockTemplate): void {
		template.label.dispose();
	}
}

export interface IWorkflowBlockPickerOptions {
	readonly sources: IWorkflowFieldSources;
	readonly workflowId: () => string | undefined;
	/** A node was added, or the trigger changed (the start node's id). */
	readonly onDidAdd: (nodeId: string | undefined) => void;
	readonly onDidClose: () => void;
	/** The list got taller or shorter (a search, a folded category): the host places it again. */
	readonly onDidChangeHeight: () => void;
}

/** The "Add a node" dropdown: a full-width search and a tree of blocks by category, sized to its rows. */
export class WorkflowBlockPicker extends Disposable {

	readonly element: HTMLElement;
	private readonly title: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly treeHost: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly head: HTMLElement;
	private readonly search: HTMLElement;
	private readonly foot: HTMLElement;
	private readonly tree: WorkbenchObjectTree<PickerElement, void>;
	private readonly menu = this._register(new MutableDisposable());
	/** Categories the user folded; remembered while the page lives. */
	private readonly collapsed = new Set<WorkflowBlockCategory>();
	private request: IWorkflowAddRequest | undefined;
	private dynamic: IWorkflowBlock[] = [];
	private opened = false;
	private loadToken = 0;

	constructor(
		container: HTMLElement,
		private readonly model: WorkflowEditorModel,
		private readonly options: IWorkflowBlockPickerOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextView: IContextViewService,
	) {
		super();
		this.element = append(container, $('.volt-wfb-picker'));
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('voltWorkflows.addNode', "Add a node"));
		this.head = append(this.element, $('.volt-wfb-picker-head'));
		this.title = append(this.head, $('.volt-wfb-picker-title'));
		const close = append(this.head, $('button.volt-wfb-icon-button')) as HTMLButtonElement;
		close.type = 'button';
		close.appendChild(renderIcon(Codicon.close));
		close.setAttribute('aria-label', localize('voltWorkflows.closePicker', "Close"));
		close.title = localize('voltWorkflows.closePickerTip', "Close (Esc)");
		this._register(addDisposableListener(close, 'click', () => this.close()));

		// The left sidebar's search: its icon, no box, the full width, a hairline under it.
		this.search = append(this.element, $('.volt-wfb-picker-search'));
		append(this.search, $('span.icon')).appendChild(createHomeSearchIcon());
		this.input = append(this.search, $('input.volt-wfb-picker-input')) as HTMLInputElement;
		this.input.type = 'text';
		this.input.spellcheck = false;
		this.input.placeholder = localize('voltWorkflows.searchBlocksLong', "Search nodes, triggers, skills and tools");
		this.input.setAttribute('aria-label', localize('voltWorkflows.searchBlocks', "Search nodes, triggers, skills"));
		this.input.setAttribute('role', 'combobox');
		this._register(addDisposableListener(this.input, 'input', () => this.render()));
		this._register(addDisposableListener(this.input, 'keydown', e => this.onInputKey(e)));

		this.treeHost = append(this.element, $('.volt-wfb-picker-tree'));
		this.empty = append(this.element, $('.volt-wfb-picker-empty.hidden'));
		this.tree = this._register(instantiationService.createInstance(WorkbenchObjectTree<PickerElement, void>, 'VoltWorkflowBlocks', this.treeHost, new PickerDelegate(), [new CategoryRenderer(), new BlockRenderer()], {
			identityProvider: { getId: (element: PickerElement) => element.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			setRowLineHeight: false,
			indent: 0,
			renderIndentGuides: RenderIndentGuides.None,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltWorkflows.blocks', "Nodes"),
				getAriaLabel: (element: PickerElement) => element.kind === 'category' ? `${element.label}, ${element.count}` : `${element.block.label}, ${element.block.description}`,
			},
		}));
		this._register(this.tree.onDidOpen(e => {
			const element = e.element;
			if (element?.kind === 'block') {
				this.pick(element.block);
			}
		}));
		this._register(this.tree.onDidChangeCollapseState(e => {
			const element = e.node.element;
			if (element?.kind === 'category' && !this.input.value.trim()) {
				if (e.node.collapsed) {
					this.collapsed.add(element.category);
				} else {
					this.collapsed.delete(element.category);
				}
			}
		}));
		this._register(this.tree.onKeyDown(e => {
			// Letters typed in the tree go to the search field.
			if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
				this.input.focus();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.close();
			}
		}));
		this._register(this.tree.onDidChangeContentHeight(() => {
			if (this.opened) {
				this.options.onDidChangeHeight();
			}
		}));
		this.foot = append(this.element, $('.volt-wfb-picker-foot'));
		this.foot.textContent = localize('voltWorkflows.pickerHint', "↑↓ move · Enter add · Esc close");
		this.element.classList.add('hidden');
	}

	get isOpen(): boolean {
		return this.opened;
	}

	/** Opens for `request` (where the node goes); a port request titles it "Add after …". */
	open(request: IWorkflowAddRequest): void {
		this.request = request;
		this.opened = true;
		this.element.classList.remove('hidden');
		this.renderTitle();
		this.input.value = '';
		this.render();
		// Laid out while hidden, the tree had no height (no rows, no scrolling): the host sizes it now.
		this.options.onDidChangeHeight();
		this.input.focus();
		const token = ++this.loadToken;
		void workflowDynamicBlocks(this.options.sources, this.options.workflowId()).then(blocks => {
			if (token === this.loadToken && this.opened) {
				this.dynamic = blocks;
				this.render();
			}
		}, () => undefined);
	}

	/** Re-targets an open panel (another port "+") without clearing the search. */
	retarget(request: IWorkflowAddRequest): void {
		this.request = request;
		this.renderTitle();
	}

	close(): void {
		if (!this.opened) {
			return;
		}
		this.opened = false;
		this.menu.clear();
		this.element.classList.add('hidden');
		this.options.onDidClose();
	}

	/**
	 * Sizes the list to its rows, up to `maxHeight` for the whole picker (`fill`: exactly that, the
	 * docked panel); returns the height used.
	 */
	layout(maxHeight: number, fill = false): number {
		if (!this.opened) {
			return 0;
		}
		const chrome = this.head.offsetHeight + this.search.offsetHeight + this.foot.offsetHeight + this.empty.offsetHeight;
		const treeHeight = Math.max(0, fill ? maxHeight - chrome : Math.min(this.tree.contentHeight, maxHeight - chrome));
		this.treeHost.style.height = `${treeHeight}px`;
		this.tree.layout(treeHeight);
		return chrome + treeHeight;
	}

	focus(): void {
		this.input.focus();
	}

	private renderTitle(): void {
		clearNode(this.title);
		const from = this.request?.from;
		const node = from ? this.model.node(from.nodeId) : undefined;
		if (node && from) {
			// "Add after [icon] Review the diff > (dot) done": the node and the port the new one hangs off.
			append(this.title, $('span.muted')).textContent = localize('voltWorkflows.addAfter', "Add after");
			const source = append(this.title, $('span.source'));
			append(source, $('span.icon')).appendChild(renderIcon(workflowTypeIcon(node.type)));
			append(source, $('span.node')).textContent = nodeDisplayName(node);
			this.title.appendChild(renderIcon(Codicon.chevronRight)).classList.add('arrow');
			const port = nodeOutputs(node).find(entry => entry.id === from.port);
			const chip = append(this.title, $('span.port'));
			chip.style.setProperty('--volt-wfb-port', workflowPortColorVar(port?.kind));
			append(chip, $('span.dot'));
			append(chip, $('span')).textContent = port?.label ?? from.port;
		} else if (this.request?.splitEdgeId) {
			append(this.title, $('span')).textContent = localize('voltWorkflows.insertInto', "Insert into connection");
		} else {
			append(this.title, $('span')).textContent = localize('voltWorkflows.addNode', "Add a node");
		}
	}

	/**
	 * How well a block answers the query: the label (start, then words, then fuzzy) counts most,
	 * then whole words of the description, group, keywords or category. Scattered letters in long
	 * keyword lists ("a…g…e…n…t") do not count, so searching "agent" finds agents, not GitHub.
	 */
	private score(query: string, block: IWorkflowBlock, categoryLabel: string): { readonly score: number; readonly matches?: IMatch[] } {
		const label = block.label.replace(/^\//, '');
		if (label.toLowerCase().startsWith(query.toLowerCase())) {
			return { score: 4, matches: [{ start: block.label.length - label.length, end: block.label.length - label.length + query.length }] };
		}
		const words = matchesWords(query, block.label, true);
		if (words) {
			return { score: 3, matches: words };
		}
		const fuzzy = query.length > 2 ? matchesFuzzy(query, block.label, false) : null;
		if (fuzzy) {
			return { score: 2, matches: fuzzy };
		}
		const extra = `${block.description} ${block.group ?? ''} ${block.keywords ?? ''} ${categoryLabel}`;
		return { score: matchesWords(query, extra, true) ? 1 : 0 };
	}

	private render(): void {
		const query = this.input.value.trim();
		const blocks = [...workflowCatalogBlocks(this.model.definition), ...this.dynamic];
		const groups: { category: typeof CATEGORY_ORDER[number]; best: number; members: { block: IWorkflowBlock; score: number; matches?: IMatch[] }[] }[] = [];
		for (const category of CATEGORY_ORDER) {
			const members: { block: IWorkflowBlock; score: number; matches?: IMatch[] }[] = [];
			for (const block of blocks) {
				if (block.category !== category.id) {
					continue;
				}
				if (!query) {
					members.push({ block, score: 0 });
					continue;
				}
				const match = this.score(query, block, category.label);
				if (match.score > 0) {
					members.push({ block, score: match.score, ...(match.matches ? { matches: match.matches } : {}) });
				}
			}
			if (!members.length) {
				continue;
			}
			// Searching: best matches first. Browsing: grouped blocks follow the loose ones, group by group.
			members.sort((a, b) => query ? b.score - a.score : (a.block.group ?? '').localeCompare(b.block.group ?? ''));
			groups.push({ category, best: Math.max(...members.map(member => member.score)), members });
		}
		if (query) {
			// The category with the best match comes first (stable otherwise).
			groups.sort((a, b) => b.best - a.best);
		}
		const children: ITreeElement<PickerElement>[] = groups.map(({ category, members }) => ({
			element: { kind: 'category', id: `c:${category.id}`, category: category.id, label: category.label, count: members.length },
			collapsible: true,
			// A search shows every match; browsing keeps what the user folded.
			collapsed: !query && this.collapsed.has(category.id),
			children: members.map(member => ({ element: { kind: 'block' as const, id: member.block.id, block: member.block, ...(member.matches ? { matches: member.matches } : {}) } })),
		}));
		this.tree.setChildren(null, children);
		this.empty.classList.toggle('hidden', children.length > 0);
		this.empty.textContent = children.length ? '' : localize('voltWorkflows.noBlocks', "No nodes match \"{0}\".", query);
		const first = this.firstBlock();
		if (first) {
			this.tree.setFocus([first]);
			this.tree.reveal(first);
		}
	}

	private firstBlock(): PickerElement | undefined {
		for (const category of this.tree.getNode(null).children) {
			if (!category.collapsed && category.children.length) {
				return category.children[0].element ?? undefined;
			}
		}
		return undefined;
	}

	private onInputKey(e: KeyboardEvent): void {
		switch (e.key) {
			case 'ArrowDown':
				this.tree.focusNext(1, true, undefined, node => node.element?.kind === 'block');
				this.revealFocus();
				break;
			case 'ArrowUp':
				this.tree.focusPrevious(1, true, undefined, node => node.element?.kind === 'block');
				this.revealFocus();
				break;
			case 'Enter': {
				const focused = this.tree.getFocus()[0];
				if (focused?.kind === 'block') {
					this.pick(focused.block);
				} else if (focused?.kind === 'category') {
					this.tree.toggleCollapsed(focused);
				}
				break;
			}
			case 'Escape':
				if (this.input.value) {
					this.input.value = '';
					this.render();
				} else {
					this.close();
				}
				break;
			default:
				return;
		}
		e.preventDefault();
		e.stopPropagation();
	}

	private revealFocus(): void {
		const focused = this.tree.getFocus()[0];
		if (focused) {
			this.tree.reveal(focused);
		}
	}

	private pick(block: IWorkflowBlock): void {
		if (block.provider) {
			this.showEvents(block);
			return;
		}
		const request = this.request ?? { at: { x: 0, y: 0 } };
		const id = addWorkflowBlock(this.model, block, request);
		this.close();
		this.options.onDidAdd(id);
	}

	/** An event service row: its events (and flyouts) in a menu beside the row. */
	private showEvents(block: IWorkflowBlock): void {
		const provider = block.provider!;
		const row = this.treeHost.querySelector<HTMLElement>('.monaco-list-row.focused');
		this.menu.value = showVoltMenu<IWorkflowBlock>(this.contextView, {
			anchor: isHTMLElement(row) ? row : this.input,
			gap: 2,
			width: 240,
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: providerLabel(provider),
			sections: eventSections(provider, AUTOMATION_EVENTS[provider], this.model.definition.trigger),
			onPick: item => {
				if (item.data.trigger) {
					const id = addWorkflowBlock(this.model, item.data, this.request ?? { at: { x: 0, y: 0 } });
					this.close();
					this.options.onDidAdd(id);
				}
			},
			onHide: () => getWindow(this.element).requestAnimationFrame(() => this.opened && this.tree.domFocus()),
		});
	}
}

//#endregion
