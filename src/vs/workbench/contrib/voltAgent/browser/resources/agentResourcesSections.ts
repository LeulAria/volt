/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { basename, dirname, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IAgentRuntimeService, IVoltMcpServerStatus } from '../../../../services/voltRuntime/common/runtime.js';
import { AGENT_RESOURCE_ECOSYSTEM_LABELS, AGENT_RESOURCE_SCOPE_KIND_DESCRIPTIONS, AGENT_RESOURCE_SCOPE_KIND_LABELS, AgentResourceEcosystem, AgentResourceGroupId, AgentResourceScopeKind, agentResourceScopeKind } from '../../common/agentResources.js';
import { agentResourceReaders, IAgentMcpServerEntry, IInstructionChain, IInstructionCreate, instructionChains } from '../../common/agentResourcesModel.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { kindInfo } from '../customize/agentCustomize.js';
import { itemNameError, showCustomizeConfirmDialog, showCustomizeInputDialog } from '../customize/agentCustomizeDialogs.js';
import { IAgentCustomizeService } from '../customize/agentCustomizeService.js';
import { createVoltDropdown } from '../ui/dropdown/voltDropdown.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { createSurfaceStrokeIcon } from '../workspace/agentSurfaceMenu.js';
import { agentResourceName, agentResourcePath, AgentResourceList, IAgentResourceChip, IAgentResourceListOptions, renderAgentResourceChips } from './agentResourceList.js';
import { AGENT_RESOURCES_SECTIONS, AgentResourcesSectionId, IAgentResourcesSectionContext } from './agentResourcesPage.js';
import { IAgentResource } from './agentResourcesService.js';

const SCOPE_ORDER: readonly AgentResourceScopeKind[] = ['workspace', 'global', 'external', 'managed'];
/** The harness the Load order card shows; kept while the window is open. */
let chainHarness: AgentResourceEcosystem | undefined;

/** A file a + New menu can create: where it goes and what it starts with. */
interface ICreatable {
	readonly id: string;
	readonly scope: 'workspace' | 'global';
	/** From the project or the home folder. `{name}` is replaced by the name the user types. */
	readonly path: string;
	readonly label: string;
	readonly description?: string;
	readonly template: (name: string) => string;
	/** A folder per item (skills): the whole folder is the item. */
	readonly needsName?: boolean;
}

const INSTRUCTION_TEMPLATES = {
	agents: () => `# AGENTS.md\n\nInstructions for coding agents working in this repository.\n\n## Setup\n\n## Testing\n\n## Conventions\n`,
	claude: () => `# CLAUDE.md\n\nWhat Claude Code should know about this project: how to build and test it, and the conventions to follow.\n\n@AGENTS.md\n`,
	claudeLocal: () => `# Local notes\n\nPersonal to you. Keep this file out of git (add it to .gitignore).\n`,
	gemini: () => `# GEMINI.md\n\nWhat Gemini CLI should know about this project.\n`,
	copilot: () => `# Copilot instructions\n\nHow GitHub Copilot should work in this repository.\n`,
	globalClaude: () => `# Personal memory\n\nHow you like Claude Code to work, in every project.\n`,
	globalAgents: () => `# Personal instructions\n\nHow you like Codex to work, in every project.\n`,
	globalGemini: () => `# Personal context\n\nHow you like Gemini CLI to work, in every project.\n`,
	cursorRule: (name: string) => `---\ndescription: ${name}\nglobs:\nalwaysApply: false\n---\n\nDescribe how the agent should behave when this rule applies.\n`,
};

/** A config folder's `{0}` read by `{1}`: the description of a destination in a + New menu. */
function readersText(dir: string, group: AgentResourceGroupId): string | undefined {
	const readers = agentResourceReaders({ group, ecosystem: 'agents', scope: 'project', relativePath: `${dir}/x/y` });
	return readers ? localize('agentResources.readByList', "Read by {0}", readers.map(reader => AGENT_RESOURCE_ECOSYSTEM_LABELS[reader]).join(', ')) : undefined;
}

const SKILL_DIRS = ['.agents/skills', '.claude/skills', '.volt/skills', '.cursor/skills', '.gemini/skills', '.github/skills'];
const AGENT_DIRS: readonly { dir: string; file: string }[] = [
	{ dir: '.claude/agents', file: '{name}.md' },
	{ dir: '.cursor/agents', file: '{name}.md' },
	{ dir: '.github/agents', file: '{name}.agent.md' },
	{ dir: '.gemini/agents', file: '{name}.md' },
	{ dir: '.volt/agents', file: '{name}.md' },
];
const COMMAND_DIRS: readonly { dir: string; file: string; ecosystem: AgentResourceEcosystem; globalOnly?: boolean; workspaceOnly?: boolean; toml?: boolean }[] = [
	{ dir: '.claude/commands', file: '{name}.md', ecosystem: 'claude' },
	{ dir: '.cursor/commands', file: '{name}.md', ecosystem: 'cursor' },
	{ dir: '.github/prompts', file: '{name}.prompt.md', ecosystem: 'copilot', workspaceOnly: true },
	{ dir: '.gemini/commands', file: '{name}.toml', ecosystem: 'gemini', toml: true },
	{ dir: '.codex/prompts', file: '{name}.md', ecosystem: 'codex', globalOnly: true },
	{ dir: '.volt/commands', file: '{name}.md', ecosystem: 'volt' },
];

/** The servers Volt's MCP host connects: its status, by name and where it was configured. */
interface IServerRow {
	readonly server: IAgentMcpServerEntry;
	readonly item: IAgentResource;
	readonly status?: IVoltMcpServerStatus;
	readonly voltLoads: boolean;
	/** Other files that define a server by this name. */
	readonly alsoIn: readonly IAgentResource[];
}

const SERVER_ROW_HEIGHT = 48;

class ServerDelegate implements IListVirtualDelegate<IServerRow> {
	getHeight(): number {
		return SERVER_ROW_HEIGHT;
	}
	getTemplateId(): string {
		return ServerRenderer.ID;
	}
}

interface IServerTemplate {
	readonly name: HTMLElement;
	readonly target: HTMLElement;
	readonly chips: HTMLElement;
	readonly detail: HTMLElement;
	readonly state: HTMLElement;
	readonly dot: HTMLElement;
}

class ServerRenderer implements IListRenderer<IServerRow, IServerTemplate> {
	static readonly ID = 'voltAgentResourceServer';
	readonly templateId = ServerRenderer.ID;

	constructor(private readonly home: () => URI | undefined) { }

	renderTemplate(container: HTMLElement): IServerTemplate {
		const row = append(container, $('.volt-ares-row.server'));
		const tile = append(row, $('span.volt-ares-tile'));
		tile.appendChild(renderIcon(Codicon.server));
		const dot = append(tile, $('span.volt-ares-tile-status'));
		const main = append(row, $('.volt-ares-row-main'));
		const first = append(main, $('.volt-ares-row-line'));
		const name = append(first, $('span.volt-ares-row-name'));
		const target = append(first, $('span.volt-ares-row-path'));
		const chips = append(first, $('span.volt-ares-row-chips'));
		const detail = append(main, $('.volt-ares-row-detail'));
		const state = append(row, $('span.volt-ares-row-source.volt-ares-server-state'));
		return { name, target, chips, detail, state, dot };
	}

	renderElement(row: IServerRow, _index: number, template: IServerTemplate): void {
		const { server, item } = row;
		template.name.textContent = server.name;
		template.target.textContent = server.target ?? '';
		const detail = [
			server.transport === 'http' ? 'HTTP' : server.transport === 'stdio' ? 'stdio' : undefined,
			agentResourcePath(item, this.home()),
			// Names only: the values may be secrets and stay where they are.
			server.envRefs.length ? localize('agentResources.envRefs', "uses {0}", server.envRefs.slice(0, 3).join(', ') + (server.envRefs.length > 3 ? ` +${server.envRefs.length - 3}` : '')) : undefined,
			server.hasHeaders ? localize('agentResources.headers', "sends headers") : undefined,
		].filter(Boolean).join(' · ');
		template.detail.textContent = detail;
		const chips: IAgentResourceChip[] = [{ label: AGENT_RESOURCE_SCOPE_KIND_LABELS[agentResourceScopeKind(item.scope)], tone: `scope-${agentResourceScopeKind(item.scope)}` }];
		if (row.alsoIn.length) {
			chips.push({ label: localize('agentResources.duplicate', "Duplicate"), tone: 'warning', title: localize('agentResources.alsoInTitle', "Also defined in {0}. Each harness keeps one by its own precedence.", row.alsoIn.map(other => agentResourcePath(other, this.home())).join(', ')) });
		}
		template.chips.replaceChildren();
		renderAgentResourceChips(template.chips, chips);
		let state: string;
		let tone: string;
		if (server.disabled) {
			state = localize('agentResources.server.disabled', "Disabled");
			tone = 'muted';
		} else if (!row.voltLoads) {
			state = localize('agentResources.server.notVolt', "Not in Volt");
			tone = 'muted';
		} else {
			switch (row.status?.state) {
				case 'ready': state = localize('agentResources.server.ready', "Connected"); tone = 'ok'; break;
				case 'connecting': state = localize('agentResources.server.connecting', "Connecting"); tone = 'muted'; break;
				case 'error': state = localize('agentResources.server.error', "Error"); tone = 'error'; break;
				default: state = localize('agentResources.server.idle', "On first run"); tone = 'muted';
			}
		}
		template.state.textContent = state;
		template.state.className = `volt-ares-row-source volt-ares-server-state ${tone}`;
		template.dot.className = `volt-ares-tile-status ${row.voltLoads && !server.disabled ? row.status?.state ?? 'idle' : 'off'}`;
		setAgentTooltip(template.state, row.voltLoads ? undefined : localize('agentResources.server.notVoltTitle', "Volt connects .mcp.json, .cursor/mcp.json, .vscode/mcp.json and .volt/mcp.json in the project, and ~/.cursor/mcp.json and ~/.volt/mcp.json. This file is read by {0}.", (agentResourceReaders(item) ?? [item.ecosystem]).map(reader => AGENT_RESOURCE_ECOSYSTEM_LABELS[reader]).join(', ')));
	}

	disposeTemplate(): void { }
}

/**
 * The page's sections. Each render makes a new instance with the page's context; lists and
 * listeners go on the context's store, cleared before the next render.
 */
export class AgentResourcesSections {

	constructor(
		private readonly ctx: IAgentResourcesSectionContext,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
	) { }

	render(section: Exclude<AgentResourcesSectionId, 'marketplace' | 'harness'>, container: HTMLElement): void {
		switch (section) {
			case 'overview': return this.renderOverview(container);
			case 'instructions': return this.renderInstructions(container);
			case 'skills': return this.renderSkills(container);
			case 'agents': return this.renderAgents(container);
			case 'integrations': return this.renderIntegrations(container);
			case 'workflows': return this.renderWorkflows(container);
		}
	}

	//#region Building blocks

	private of(group: AgentResourceGroupId, items = this.ctx.items): IAgentResource[] {
		return items.filter(item => item.group === group);
	}

	/** A titled block: the title, a muted line under it, and the block's actions on the right. */
	private block(container: HTMLElement, title: string, lead?: string, count?: number): { body: HTMLElement; actions: HTMLElement } {
		const block = append(container, $('.volt-ares-block'));
		const head = append(block, $('.volt-ares-block-head'));
		const copy = append(head, $('.volt-ares-block-copy'));
		const titleEl = append(copy, $('.volt-ares-block-title'));
		append(titleEl, $('span')).textContent = title;
		if (count !== undefined) {
			append(titleEl, $('span.volt-ares-count')).textContent = String(count);
		}
		if (lead) {
			append(copy, $('.volt-ares-block-lead')).textContent = lead;
		}
		const actions = append(head, $('.volt-ares-block-actions'));
		return { body: append(block, $('.volt-ares-block-body')), actions };
	}

	/** Customize's pills: `primary` is the white one (Customize's Manage), `secondary` outlined, `ghost` text only. */
	private button(parent: HTMLElement, label: string, run: (anchor: HTMLElement) => void, kind: 'primary' | 'secondary' | 'ghost' = 'secondary', icon?: ThemeIcon): void {
		const button = append(parent, $(`button.volt-ares-btn.${kind}`)) as HTMLButtonElement;
		button.type = 'button';
		if (icon) {
			button.appendChild(renderIcon(icon));
		}
		append(button, $('span')).textContent = label;
		this.ctx.store.add(addDisposableListener(button, 'click', () => run(button)));
	}

	private empty(container: HTMLElement, text: string): void {
		append(container, $('.volt-ares-empty')).textContent = text;
	}

	/** Lists the items in a card per scope: Workspace, Global, External, Managed. */
	private scopedLists(container: HTMLElement, items: readonly IAgentResource[], options: Partial<IAgentResourceListOptions> = {}, emptyText?: string): void {
		if (!items.length) {
			this.empty(container, emptyText ?? localize('agentResources.none', "Nothing here yet."));
			return;
		}
		for (const kind of SCOPE_ORDER) {
			const scoped = items.filter(item => agentResourceScopeKind(item.scope) === kind);
			if (!scoped.length) {
				continue;
			}
			const card = append(container, $(`.volt-ares-card.scope-${kind}`));
			const head = append(card, $('.volt-ares-card-head'));
			append(head, $(`span.volt-ares-scope-dot.scope-${kind}`));
			const title = append(head, $('span.volt-ares-card-title'));
			title.textContent = kind === 'workspace' && this.ctx.folder
				? localize('agentResources.workspaceOf', "Workspace · {0}", basename(this.ctx.folder))
				: AGENT_RESOURCE_SCOPE_KIND_LABELS[kind];
			setAgentTooltip(title, AGENT_RESOURCE_SCOPE_KIND_DESCRIPTIONS[kind]);
			append(head, $('span.volt-ares-count')).textContent = String(scoped.length);
			this.list(card, scoped, options);
		}
	}

	private list(container: HTMLElement, items: readonly IAgentResource[], options: Partial<IAgentResourceListOptions> = {}): AgentResourceList {
		const list = this.ctx.store.add(this.instantiationService.createInstance(AgentResourceList, container, {
			home: () => this.ctx.home,
			ariaLabel: localize('agentResources.listAria', "Agent resources"),
			onOpen: item => this.ctx.openResource(item.resource),
			onMenu: (item, anchor) => this.showItemMenu(item, anchor),
			...options,
		}));
		list.setItems(items);
		return list;
	}

	//#endregion

	//#region Overview

	private renderOverview(container: HTMLElement): void {
		const all = this.ctx.allItems;
		const grid = append(container, $('.volt-ares-overview-grid'));
		const groupsOf: Partial<Record<AgentResourcesSectionId, readonly AgentResourceGroupId[]>> = {
			instructions: ['instructions'], skills: ['skills'], agents: ['subagents'], integrations: ['integrations'], workflows: ['commands', 'hooks'], harness: ['config'],
		};
		for (const section of AGENT_RESOURCES_SECTIONS) {
			const groups = groupsOf[section.id];
			if (!groups) {
				continue;
			}
			const items = all.filter(item => groups.includes(item.group));
			const issues = items.filter(item => item.status.kind !== 'ok').length;
			const card = append(grid, $('button.volt-ares-tile-card')) as HTMLButtonElement;
			card.type = 'button';
			const head = append(card, $('.volt-ares-tile-card-head'));
			append(head, $('span.volt-ares-tile.large')).appendChild(createSurfaceStrokeIcon(card.ownerDocument, section.icon));
			const copy = append(head, $('.volt-ares-tile-card-copy'));
			append(copy, $('span.volt-ares-tile-card-title')).textContent = section.label;
			append(copy, $('span.volt-ares-tile-card-count')).textContent = items.length
				? localize('agentResources.tileFiles', "{0} files", items.length)
				: localize('agentResources.tileEmpty', "None yet");
			if (issues) {
				const warn = append(head, $('span.volt-ares-chip.warning'));
				warn.appendChild(renderIcon(Codicon.warning));
				append(warn, $('span')).textContent = String(issues);
				setAgentTooltip(warn, localize('agentResources.tileIssues', "{0} need attention", issues));
			}
			// How the files split by scope, as a thin bar with the counts under it.
			const bar = append(card, $('.volt-ares-scope-bar'));
			const legend = append(card, $('.volt-ares-scope-legend'));
			for (const kind of SCOPE_ORDER) {
				const count = items.filter(item => agentResourceScopeKind(item.scope) === kind).length;
				if (!count) {
					continue;
				}
				append(bar, $(`span.scope-${kind}`)).style.flexGrow = String(count);
				const entry = append(legend, $('span.volt-ares-scope-legend-entry'));
				append(entry, $(`span.volt-ares-scope-dot.scope-${kind}`));
				append(entry, $('span')).textContent = `${count} ${AGENT_RESOURCE_SCOPE_KIND_LABELS[kind].toLowerCase()}`;
			}
			bar.classList.toggle('empty', !items.length);
			this.ctx.store.add(addDisposableListener(card, 'click', () => this.ctx.navigate(section.id)));
		}
		const attention = this.ctx.items.filter(item => item.status.kind !== 'ok');
		const issues = this.block(container, localize('agentResources.attention', "Needs attention"), localize('agentResources.attentionLead', "Files an agent may skip or misread: no description, invalid JSON, a rule that never applies."), attention.length);
		if (attention.length) {
			this.list(append(issues.body, $('.volt-ares-card')), attention, { showScope: true });
		} else {
			this.empty(issues.body, localize('agentResources.attentionNone', "Nothing needs attention."));
		}
		const scopes = this.block(container, localize('agentResources.scopes', "Scopes"), localize('agentResources.scopesLead', "Every file says where it lives, so your own setup never mixes with a repository's."));
		const table = append(scopes.body, $('.volt-ares-card.volt-ares-scope-table'));
		for (const kind of SCOPE_ORDER) {
			const row = append(table, $('.volt-ares-scope-row'));
			append(row, $(`span.volt-ares-scope-dot.scope-${kind}`));
			const copy = append(row, $('.volt-ares-scope-copy'));
			append(copy, $('span.volt-ares-scope-name')).textContent = AGENT_RESOURCE_SCOPE_KIND_LABELS[kind];
			append(copy, $('span.volt-ares-scope-desc')).textContent = AGENT_RESOURCE_SCOPE_KIND_DESCRIPTIONS[kind];
			append(row, $('span.volt-ares-scope-count')).textContent = String(all.filter(item => agentResourceScopeKind(item.scope) === kind).length);
		}
	}

	//#endregion

	//#region Instructions & Rules

	private renderInstructions(container: HTMLElement): void {
		const chains = instructionChains(this.ctx.allItems);
		const present = (chain: IInstructionChain<IAgentResource>) => chain.steps.reduce((sum, step) => sum + step.items.length, 0);
		const harness = chainHarness && chains.some(chain => chain.ecosystem === chainHarness)
			? chainHarness
			: [...chains].sort((a, b) => present(b) - present(a))[0].ecosystem;
		const chain = chains.find(candidate => candidate.ecosystem === harness)!;
		const order = this.block(container, localize('agentResources.loadOrder', "Load order"), chain.merge);
		createVoltDropdown(order.actions, this.contextViewService, {
			options: chains.map(candidate => ({
				id: candidate.ecosystem,
				label: AGENT_RESOURCE_ECOSYSTEM_LABELS[candidate.ecosystem],
				description: localize('agentResources.chainFiles', "{0} files read", present(candidate)),
			})),
			value: harness,
			ariaLabel: localize('agentResources.chainHarness', "Harness"),
			align: 'right',
			onChange: value => {
				chainHarness = value;
				this.ctx.rerender();
			},
		}, this.ctx.store);
		const steps = append(order.body, $('ol.volt-ares-chain'));
		chain.steps.forEach((step, index) => {
			const li = append(steps, $(`li.volt-ares-chain-step${step.items.length ? '.found' : ''}`));
			append(li, $('span.volt-ares-chain-index')).textContent = String(index + 1);
			const body = append(li, $('.volt-ares-chain-body'));
			const head = append(body, $('.volt-ares-chain-head'));
			append(head, $('span.volt-ares-chain-label')).textContent = step.label;
			append(head, $('span.volt-ares-chain-where')).textContent = step.where;
			const files = append(body, $('.volt-ares-chain-files'));
			for (const item of step.items) {
				this.fileLink(files, item);
			}
			for (const item of step.skipped) {
				this.fileLink(files, item, true);
			}
			if (!step.items.length && !step.skipped.length) {
				append(files, $('span.volt-ares-chain-missing')).textContent = localize('agentResources.chainMissing', "Not set");
			}
			if (step.note) {
				append(body, $('.volt-ares-chain-note')).textContent = step.note;
			}
			if (step.create) {
				const create = step.create;
				const actions = append(li, $('.volt-ares-chain-actions'));
				this.button(actions, localize('agentResources.create', "Create"), () => void this.createFromStep(create, harness), 'ghost', Codicon.add);
			}
		});
		if (chain.footnote) {
			append(order.body, $('.volt-ares-footnote')).textContent = chain.footnote;
		}

		const items = this.of('instructions');
		const files = this.block(container, localize('agentResources.instructionFiles', "Instruction files"), localize('agentResources.instructionFilesLead', "Each file stays its own, even when two do the same job. Compare one with another from its menu."), items.length);
		this.button(files.actions, localize('agentResources.new', "New"), anchor => this.showCreateMenu(anchor, this.instructionCreatables(), localize('agentResources.newInstructions', "New instructions")), 'primary', Codicon.add);
		this.scopedLists(files.body, items, {}, localize('agentResources.noInstructions', "No instruction files. Create an AGENTS.md to give every agent the same project notes."));
	}

	private fileLink(parent: HTMLElement, item: IAgentResource, skipped = false): void {
		const link = append(parent, $(`button.volt-ares-file-link${skipped ? '.skipped' : ''}`)) as HTMLButtonElement;
		link.type = 'button';
		append(link, $('span')).textContent = agentResourcePath(item, this.ctx.home);
		if (item.status.kind !== 'ok') {
			link.appendChild(renderIcon(Codicon.warning));
			setAgentTooltip(link, item.status.message);
		} else if (skipped) {
			setAgentTooltip(link, localize('agentResources.skippedFile', "Found, but not read by this harness"));
		}
		this.ctx.store.add(addDisposableListener(link, 'click', () => this.ctx.openResource(item.resource)));
	}

	private instructionCreatables(): ICreatable[] {
		return [
			{ id: 'agents', scope: 'workspace', path: 'AGENTS.md', label: 'AGENTS.md', description: localize('agentResources.newAgentsDesc', "Shared by Codex, Cursor, Copilot and others"), template: INSTRUCTION_TEMPLATES.agents },
			{ id: 'claude', scope: 'workspace', path: 'CLAUDE.md', label: 'CLAUDE.md', description: localize('agentResources.newClaudeDesc', "Claude Code; imports AGENTS.md"), template: INSTRUCTION_TEMPLATES.claude },
			{ id: 'claudeLocal', scope: 'workspace', path: 'CLAUDE.local.md', label: 'CLAUDE.local.md', description: localize('agentResources.newClaudeLocalDesc', "Claude Code, personal to you"), template: INSTRUCTION_TEMPLATES.claudeLocal },
			{ id: 'gemini', scope: 'workspace', path: 'GEMINI.md', label: 'GEMINI.md', description: 'Gemini CLI', template: INSTRUCTION_TEMPLATES.gemini },
			{ id: 'copilot', scope: 'workspace', path: '.github/copilot-instructions.md', label: '.github/copilot-instructions.md', description: 'GitHub Copilot', template: INSTRUCTION_TEMPLATES.copilot },
			{ id: 'cursorRule', scope: 'workspace', path: '.cursor/rules/{name}.mdc', label: localize('agentResources.newCursorRule', "Cursor rule"), description: '.cursor/rules/<name>.mdc', template: INSTRUCTION_TEMPLATES.cursorRule, needsName: true },
			{ id: 'globalClaude', scope: 'global', path: '.claude/CLAUDE.md', label: '~/.claude/CLAUDE.md', description: localize('agentResources.newGlobalClaudeDesc', "Claude Code, every project"), template: INSTRUCTION_TEMPLATES.globalClaude },
			{ id: 'globalAgents', scope: 'global', path: '.codex/AGENTS.md', label: '~/.codex/AGENTS.md', description: localize('agentResources.newGlobalCodexDesc', "Codex, every project"), template: INSTRUCTION_TEMPLATES.globalAgents },
			{ id: 'globalGemini', scope: 'global', path: '.gemini/GEMINI.md', label: '~/.gemini/GEMINI.md', description: localize('agentResources.newGlobalGeminiDesc', "Gemini CLI, every project"), template: INSTRUCTION_TEMPLATES.globalGemini },
		];
	}

	private async createFromStep(create: IInstructionCreate, harness: AgentResourceEcosystem): Promise<void> {
		const match = this.instructionCreatables().find(candidate => candidate.scope === create.scope && candidate.path === create.path);
		const template = match?.template ?? (() => `# ${basename(URI.file(create.path))}\n`);
		await this.createFile({ id: create.path, scope: create.scope, path: create.path, label: create.path, template }, '');
		chainHarness = harness;
	}

	//#endregion

	//#region Skills, agents, workflows

	private renderSkills(container: HTMLElement): void {
		const items = this.of('skills');
		const withScripts = items.filter(item => item.skill?.hasScripts).length;
		const block = this.block(container, localize('agentResources.installedSkills', "Installed"), withScripts
			? localize('agentResources.scriptsLead', "{0} of these run scripts. Read a skill's files before you trust it.", withScripts)
			: localize('agentResources.skillsLead2', "Each skill is a folder with a SKILL.md. Agents load it when its description matches the task."), items.length);
		this.button(block.actions, localize('agentResources.newSkill', "New Skill"), anchor => this.showCreateMenu(anchor, this.folderCreatables('skills', SKILL_DIRS.map(dir => ({ dir, file: '{name}/SKILL.md' })), name => kindInfo('skill').template(name)), localize('agentResources.newSkill', "New Skill")), 'primary', Codicon.add);
		this.button(block.actions, localize('agentResources.discover', "Discover"), () => this.ctx.navigate('marketplace'), 'ghost', Codicon.search);
		this.scopedLists(block.body, items, {
			name: item => item.name || agentResourceName(item),
			chips: item => {
				const chips: IAgentResourceChip[] = [];
				if (item.skill?.hasScripts) {
					chips.push({ label: localize('agentResources.runsScripts', "Runs scripts"), tone: 'warning', icon: Codicon.terminal, title: localize('agentResources.runsScriptsTitle', "This skill ships scripts an agent can run. Review them like any package you install.") });
				}
				if (item.skill?.files) {
					chips.push({ label: localize('agentResources.skillFiles', "{0} more files", item.skill.files), tone: 'muted' });
				}
				return chips;
			},
		}, localize('agentResources.noSkills', "No skills yet. Create one, or discover skills on skills.sh."));
	}

	private renderAgents(container: HTMLElement): void {
		const items = this.of('subagents');
		const block = this.block(container, localize('agentResources.subagents', "Subagents"), localize('agentResources.agentsLead2', "Agents your agent can hand work to. Each runs in its own context with the model and tools its file names."), items.length);
		this.button(block.actions, localize('agentResources.newAgent', "New Agent"), anchor => this.showCreateMenu(anchor, this.folderCreatables('subagents', AGENT_DIRS, name => kindInfo('subagent').template(name)), localize('agentResources.newAgent', "New Agent")), 'primary', Codicon.add);
		this.scopedLists(block.body, items, {
			name: item => item.name || agentResourceName(item),
			chips: item => [
				...(item.model ? [{ label: localize('agentResources.model', "Model {0}", item.model), tone: 'muted' as const }] : []),
				...(item.tools ? [{ label: localize('agentResources.tools', "Tools {0}", item.tools), tone: 'muted' as const }] : []),
			],
		}, localize('agentResources.noAgents', "No subagents. Create one to give a recurring kind of work its own context."));
	}

	private renderWorkflows(container: HTMLElement): void {
		const commands = this.of('commands');
		const commandBlock = this.block(container, localize('agentResources.commandsPrompts', "Commands & Prompts"), localize('agentResources.commandsLead', "Reusable prompts you run by name, such as /review."), commands.length);
		this.button(commandBlock.actions, localize('agentResources.newCommand', "New Command"), anchor => this.showCreateMenu(anchor, this.commandCreatables(), localize('agentResources.newCommand', "New Command")), 'primary', Codicon.add);
		this.scopedLists(commandBlock.body, commands, {}, localize('agentResources.noCommands', "No commands or prompts."));

		const hooks = this.of('hooks').filter(item => item.kind !== localize('agentResources.kind.workflow', "Agent workflow"));
		const workflows = this.of('hooks').filter(item => !hooks.includes(item));
		const hookBlock = this.block(container, localize('agentResources.hooks', "Hooks"), localize('agentResources.hooksLead', "Code that runs around agent actions: before a tool, after an edit, when a session starts. Every source runs."), hooks.length);
		this.button(hookBlock.actions, localize('agentResources.newHooks', "New"), anchor => this.showCreateMenu(anchor, this.hookCreatables(), localize('agentResources.newHooksTitle', "New hooks")), 'primary', Codicon.add);
		this.button(hookBlock.actions, localize('agentResources.hookLog', "Execution Log"), () => void this.commandService.executeCommand('workbench.action.voltAgent.customize'), 'ghost', Codicon.output);
		this.scopedLists(hookBlock.body, hooks, {
			detail: item => item.hookEvents?.length ? item.hookEvents.join(' · ') : item.description || item.kind,
		}, localize('agentResources.noHooks', "No hooks."));

		const ci = this.block(container, localize('agentResources.agentWorkflows', "Agent workflows"), localize('agentResources.agentWorkflowsLead', "CI workflows that run an agent, such as a pull request review."), workflows.length);
		this.scopedLists(ci.body, workflows, {}, localize('agentResources.noWorkflows', "No CI workflow runs an agent."));
	}

	/** + New destinations for a kind kept in a config folder, for this project and for you. */
	private folderCreatables(group: AgentResourceGroupId, dirs: readonly { dir: string; file: string; workspaceOnly?: boolean; globalOnly?: boolean }[], template: (name: string) => string): ICreatable[] {
		const out: ICreatable[] = [];
		for (const scope of ['workspace', 'global'] as const) {
			for (const { dir, file, workspaceOnly, globalOnly } of dirs) {
				if ((scope === 'global' && (workspaceOnly || dir.startsWith('.github'))) || (scope === 'workspace' && globalOnly)) {
					continue;
				}
				out.push({
					id: `${scope}:${dir}`,
					scope,
					path: `${dir}/${file}`,
					label: scope === 'global' ? `~/${dir}` : dir,
					description: readersText(dir, group),
					template,
					needsName: true,
				});
			}
		}
		return out;
	}

	private commandCreatables(): ICreatable[] {
		return this.folderCreatables('commands', COMMAND_DIRS, name => `# ${name}\n\nWhat this command asks the agent to do. $ARGUMENTS stands for what follows the command.\n`).map(creatable => {
			const dir = COMMAND_DIRS.find(candidate => creatable.id.endsWith(`:${candidate.dir}`))!;
			return {
				...creatable,
				description: AGENT_RESOURCE_ECOSYSTEM_LABELS[dir.ecosystem],
				template: dir.toml ? (name: string) => `description = "${name}"\nprompt = """\nWhat this command asks Gemini to do. {{args}} stands for what follows the command.\n"""\n` : creatable.template,
			};
		});
	}

	private hookCreatables(): ICreatable[] {
		const hooks = () => kindInfo('hook').template('');
		const claude = () => `{\n\t"hooks": {\n\t}\n}\n`;
		return [
			{ id: 'cursorHooks', scope: 'workspace', path: '.cursor/hooks.json', label: '.cursor/hooks.json', description: 'Cursor', template: hooks },
			{ id: 'voltHooks', scope: 'workspace', path: '.volt/hooks.json', label: '.volt/hooks.json', description: 'Volt', template: hooks },
			{ id: 'claudeHooks', scope: 'workspace', path: '.claude/settings.json', label: '.claude/settings.json', description: localize('agentResources.claudeHooksDesc', "Claude Code (hooks live in settings)"), template: claude },
			{ id: 'globalCursorHooks', scope: 'global', path: '.cursor/hooks.json', label: '~/.cursor/hooks.json', description: 'Cursor', template: hooks },
			{ id: 'globalClaudeHooks', scope: 'global', path: '.claude/settings.json', label: '~/.claude/settings.json', description: localize('agentResources.claudeHooksDesc', "Claude Code (hooks live in settings)"), template: claude },
		];
	}

	//#endregion

	//#region MCP & Integrations

	private renderIntegrations(container: HTMLElement): void {
		const items = this.of('integrations');
		const configs = items.filter(item => item.servers !== undefined || /mcp|\.claude\.json|config\.toml|settings/.test(item.relativePath));
		const plugins = items.filter(item => !configs.includes(item));
		// Settings files that also define MCP servers (Gemini, Codex) count as server sources.
		const sources = [...configs, ...this.ctx.items.filter(item => item.group === 'config' && item.servers?.length)];
		const rows: IServerRow[] = [];
		for (const item of sources) {
			for (const server of item.servers ?? []) {
				const readers = agentResourceReaders(item);
				rows.push({
					server,
					item,
					voltLoads: !!readers?.includes('volt'),
					alsoIn: sources.filter(other => other !== item && other.servers?.some(candidate => candidate.name === server.name)),
				});
			}
		}
		const servers = this.block(container, localize('agentResources.servers', "Servers"), localize('agentResources.serversLead', "Every MCP server defined for this project and for you, and whether Volt connects it. Credentials stay in the environment."), rows.length);
		this.button(servers.actions, localize('agentResources.addServer', "Add Server"), anchor => this.showCreateMenu(anchor, this.mcpCreatables(), localize('agentResources.addServer', "Add Server")), 'primary', Codicon.add);
		if (rows.length) {
			const host = append(servers.body, $('.volt-ares-list.volt-ares-card'));
			const list = this.ctx.store.add(this.instantiationService.createInstance(WorkbenchList<IServerRow>, 'VoltAgentResourceServers', host, new ServerDelegate(), [new ServerRenderer(() => this.ctx.home)], {
				identityProvider: { getId: (row: IServerRow) => `${row.item.resource.toString()}#${row.server.name}` },
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				alwaysConsumeMouseWheel: false,
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('agentResources.serversAria', "MCP servers"),
					getAriaLabel: (row: IServerRow) => `${row.server.name}, ${row.server.target ?? ''}, ${agentResourcePath(row.item, this.ctx.home)}`,
				},
			}));
			this.ctx.store.add(list.onDidOpen(e => e.element && this.ctx.openResource(e.element.item.resource)));
			const height = rows.length * SERVER_ROW_HEIGHT;
			host.style.height = `${height}px`;
			list.layout(height);
			list.splice(0, 0, rows);
			// Volt's own status for the servers it connects, by name.
			const store = this.ctx.store;
			void this.runtime.listMcpServers(this.ctx.folder).then(statuses => {
				if (store.isDisposed) {
					return;
				}
				list.splice(0, list.length, rows.map(row => ({ ...row, status: statuses.find(status => status.name === row.server.name && (status.scope === 'user') === (row.item.scope === 'global')) })));
			}, () => undefined);
		} else {
			this.empty(servers.body, localize('agentResources.noServers', "No MCP servers. Add one to give agents a new tool."));
		}
		const files = this.block(container, localize('agentResources.configFiles', "Configuration files"), localize('agentResources.configFilesLead', "Where the servers above are defined. Files Claude Code or Cursor rewrite are read-only here."), configs.length);
		this.scopedLists(files.body, configs, {
			detail: item => item.servers ? (item.servers.length ? item.servers.map(server => server.name).join(', ') : localize('agentResources.noServersInFile', "No servers")) : item.description || item.kind,
		}, localize('agentResources.noConfigFiles', "No MCP configuration files."));
		const external = this.block(container, localize('agentResources.pluginsExtensions', "Plugins & extensions"), localize('agentResources.pluginsLead', "Bundles installed through Volt, Claude Code, Cursor or Gemini CLI. Their manager owns them."), plugins.length);
		this.button(external.actions, localize('agentResources.browse', "Browse"), () => this.ctx.navigate('marketplace'), 'ghost', Codicon.search);
		this.scopedLists(external.body, plugins, { name: item => item.source ? `${item.source} · ${agentResourceName(item)}` : agentResourceName(item) }, localize('agentResources.noPlugins', "No plugins or extensions installed."));
	}

	private mcpCreatables(): ICreatable[] {
		const mcp = () => `{\n\t"mcpServers": {\n\t}\n}\n`;
		return [
			{ id: 'voltMcp', scope: 'workspace', path: '.volt/mcp.json', label: '.volt/mcp.json', description: localize('agentResources.mcpVolt', "Volt"), template: mcp },
			{ id: 'claudeMcp', scope: 'workspace', path: '.mcp.json', label: '.mcp.json', description: localize('agentResources.mcpClaude', "Claude Code and Volt; shared with the team"), template: mcp },
			{ id: 'cursorMcp', scope: 'workspace', path: '.cursor/mcp.json', label: '.cursor/mcp.json', description: localize('agentResources.mcpCursor', "Cursor and Volt"), template: mcp },
			{ id: 'vscodeMcp', scope: 'workspace', path: '.vscode/mcp.json', label: '.vscode/mcp.json', description: localize('agentResources.mcpVscode', "VS Code Copilot and Volt"), template: () => `{\n\t"servers": {\n\t}\n}\n` },
			{ id: 'globalVoltMcp', scope: 'global', path: '.volt/mcp.json', label: '~/.volt/mcp.json', description: localize('agentResources.mcpVolt', "Volt"), template: mcp },
			{ id: 'globalCursorMcp', scope: 'global', path: '.cursor/mcp.json', label: '~/.cursor/mcp.json', description: localize('agentResources.mcpCursor', "Cursor and Volt"), template: mcp },
		];
	}

	//#endregion

	//#region Creating files

	/** A menu of where a new file can go: this project first, then the home folder. Existing files open instead. */
	private showCreateMenu(anchor: HTMLElement, creatables: readonly ICreatable[], title: string): void {
		const base = (creatable: ICreatable) => creatable.scope === 'global' ? this.ctx.home : this.ctx.folder;
		const exists = (creatable: ICreatable) => !creatable.needsName && this.ctx.allItems.some(item => {
			const root = base(creatable);
			return !!root && item.resource.toString() === joinPath(root, creatable.path).toString();
		});
		const toItem = (creatable: ICreatable): IVoltMenuItem<ICreatable> => ({
			id: creatable.id,
			label: creatable.label,
			description: exists(creatable) ? localize('agentResources.exists', "Exists, opens it") : creatable.description,
			icon: creatable.scope === 'global' ? Codicon.account : Codicon.folder,
			disabled: !base(creatable),
			data: creatable,
		});
		const sections: IVoltMenuSection<ICreatable>[] = [];
		const workspace = creatables.filter(creatable => creatable.scope === 'workspace');
		const global = creatables.filter(creatable => creatable.scope === 'global');
		if (workspace.length) {
			sections.push({ id: 'workspace', title: this.ctx.folder ? localize('agentResources.inProject', "Workspace · {0}", basename(this.ctx.folder)) : AGENT_RESOURCE_SCOPE_KIND_LABELS.workspace, items: workspace.map(toItem) });
		}
		if (global.length) {
			sections.push({ id: 'global', title: localize('agentResources.inGlobal', "Global · every project"), items: global.map(toItem) });
		}
		showVoltMenu<ICreatable>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			width: 340,
			ariaLabel: title,
			sections,
			onPick: async item => {
				const creatable = item.data;
				if (!creatable.needsName) {
					await this.createFile(creatable, '');
					return;
				}
				const name = await showCustomizeInputDialog(this.layoutService.activeContainer, {
					title,
					subtitle: creatable.scope === 'global' ? `~/${creatable.path}` : creatable.path,
					placeholder: localize('agentResources.namePlaceholder', "name-in-kebab-case"),
					confirmLabel: localize('agentResources.createConfirm', "Create"),
					validate: value => itemNameError(value.trim()),
				});
				if (name?.trim()) {
					await this.createFile(creatable, name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
				}
			},
		});
	}

	/** Writes the file from its template unless it is there already, then opens it. */
	private async createFile(creatable: ICreatable, name: string): Promise<void> {
		const root = creatable.scope === 'global' ? this.ctx.home : this.ctx.folder;
		if (!root) {
			return;
		}
		if (creatable.id === 'voltMcp' || creatable.id === 'globalVoltMcp') {
			// Customize's template, so both places start Volt's MCP file the same way.
			this.ctx.openResource(await this.customize.ensureMcpConfig(root));
			return;
		}
		const target = joinPath(root, creatable.path.replace('{name}', name));
		try {
			if (!await this.fileService.exists(target)) {
				await this.fileService.writeFile(target, VSBuffer.fromString(creatable.template(name)));
			}
			this.ctx.openResource(target);
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	//#endregion

	//#region Row menu

	private showItemMenu(item: IAgentResource, anchor: HTMLElement): void {
		const actions: IVoltMenuItem<() => void>[] = [
			{ id: 'open', label: localize('agentResources.menu.open', "Open"), icon: Codicon.goToFile, data: () => this.ctx.openResource(item.resource) },
			{ id: 'reveal', label: localize('agentResources.menu.reveal', "Reveal in Finder"), icon: Codicon.folderOpened, data: () => void this.commandService.executeCommand('revealFileInOS', item.resource) },
			{ id: 'copyPath', label: localize('agentResources.menu.copyPath', "Copy Path"), icon: Codicon.copy, data: () => void this.clipboardService.writeText(item.resource.fsPath) },
		];
		const sections: IVoltMenuSection<() => void>[] = [{ id: 'file', items: actions }];
		const peers = this.ctx.allItems.filter(other => other !== item && other.group === item.group);
		if (peers.length) {
			// Same-named files first: a project CLAUDE.md beside your global one is the usual comparison.
			const sorted = [...peers].sort((a, b) => Number(basename(b.resource) === basename(item.resource)) - Number(basename(a.resource) === basename(item.resource)));
			sections.push({
				id: 'compare',
				items: [{
					id: 'compare',
					label: localize('agentResources.menu.compare', "Compare With"),
					icon: Codicon.diff,
					data: () => undefined,
					submenu: {
						sections: [{
							id: 'peers', items: sorted.slice(0, 30).map(other => ({
								id: other.resource.toString(),
								label: agentResourceName(other),
								description: agentResourcePath(other, this.ctx.home),
								// allow-any-unicode-next-line
								data: () => this.ctx.openDiff(item.resource, other.resource, localize('agentResources.diffLabel', "{0} ↔ {1}", agentResourcePath(item, this.ctx.home), agentResourcePath(other, this.ctx.home))),
							})),
						}],
						width: 360,
					},
				}],
			});
		}
		const twin = this.scopeTwin(item);
		const manage: IVoltMenuItem<() => void>[] = [];
		if (twin) {
			const exists = this.ctx.allItems.some(other => other.resource.toString() === twin.target.toString());
			manage.push({
				id: 'copyScope',
				label: twin.scope === 'global' ? localize('agentResources.menu.copyGlobal', "Copy to Global") : localize('agentResources.menu.copyWorkspace', "Copy to Workspace"),
				description: exists ? localize('agentResources.menu.alreadyThere', "Already there") : twin.label,
				icon: twin.scope === 'global' ? Codicon.account : Codicon.folder,
				disabled: exists,
				data: () => void this.copyToScope(item, twin),
			});
		}
		if (item.readOnly) {
			manage.push({ id: 'readOnly', label: localize('agentResources.menu.readOnly', "Read-only"), subtitle: item.readOnly, icon: Codicon.lock, disabled: true, data: () => undefined });
		} else if (agentResourceScopeKind(item.scope) === 'workspace' || item.scope === 'global') {
			manage.push({ id: 'trash', label: item.group === 'skills' ? localize('agentResources.menu.trashSkill', "Move Skill to Trash") : localize('agentResources.menu.trash', "Move to Trash"), icon: Codicon.trash, className: 'danger', data: () => void this.trash(item) });
		}
		if (manage.length) {
			sections.push({ id: 'manage', items: manage });
		}
		showVoltMenu<() => void>(this.contextViewService, {
			anchor,
			align: 'right',
			gap: 4,
			width: 280,
			ariaLabel: localize('agentResources.menu.aria', "Actions for {0}", agentResourceName(item)),
			sections,
			onPick: picked => picked.data(),
		});
	}

	/**
	 * The same item in the other scope: a project's `.claude/skills/x` is `~/.claude/skills/x` for
	 * you. Only items in a config folder have one; a project's CLAUDE.md has no global path twin.
	 */
	private scopeTwin(item: IAgentResource): { scope: 'global' | 'workspace'; source: URI; target: URI; label: string } | undefined {
		if (item.readOnly || !['skills', 'subagents', 'commands', 'instructions'].includes(item.group)) {
			return undefined;
		}
		const first = item.relativePath.split('/')[0];
		if (!first.startsWith('.') || first === '.github' || item.relativePath.split('/').length < 3) {
			return undefined;
		}
		const isSkill = item.group === 'skills';
		const source = isSkill ? dirname(item.resource) : item.resource;
		const path = isSkill ? item.relativePath.split('/').slice(0, -1).join('/') : item.relativePath;
		if (item.scope === 'project' && this.ctx.home) {
			return { scope: 'global', source, target: joinPath(this.ctx.home, path), label: `~/${path}` };
		}
		if (item.scope === 'global' && this.ctx.folder) {
			return { scope: 'workspace', source, target: joinPath(this.ctx.folder, path), label: `${basename(this.ctx.folder)}/${path}` };
		}
		return undefined;
	}

	private async copyToScope(item: IAgentResource, twin: { source: URI; target: URI; label: string }): Promise<void> {
		try {
			if (await this.fileService.exists(twin.target)) {
				return;
			}
			await this.fileService.copy(twin.source, twin.target, false);
			this.notificationService.info(localize('agentResources.copied', "Copied {0} to {1}.", agentResourceName(item), twin.label));
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	private async trash(item: IAgentResource): Promise<void> {
		const target = item.group === 'skills' ? dirname(item.resource) : item.resource;
		const name = item.group === 'skills' ? `${agentResourceName(item)}/` : basename(item.resource);
		const confirmed = await showCustomizeConfirmDialog(this.layoutService.activeContainer, {
			title: localize('agentResources.trashTitle', "Move {0} to the Trash?", name),
			message: localize('agentResources.trashMessage', "{0} goes to the Trash; you can restore it from there.", relativePath(this.ctx.home ?? dirname(target), target) ?? target.fsPath),
			confirmLabel: localize('agentResources.trashConfirm', "Move to Trash"),
			destructive: true,
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.fileService.del(target, { useTrash: true, recursive: true });
		} catch (error) {
			this.notificationService.error(error);
		}
	}

	//#endregion
}

/** The page header's filter: which scopes are listed. */
export function agentResourceScopeFilterOptions(): { id: 'all' | AgentResourceScopeKind; label: string; description?: string }[] {
	return [
		{ id: 'all', label: localize('agentResources.allScopes', "All scopes") },
		...SCOPE_ORDER.map(kind => ({ id: kind, label: AGENT_RESOURCE_SCOPE_KIND_LABELS[kind], description: AGENT_RESOURCE_SCOPE_KIND_DESCRIPTIONS[kind] })),
	];
}
