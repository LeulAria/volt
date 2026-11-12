/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../voltAgent/browser/media/agentComposerInput.css';
import './media/agentAutomationComposer.css';
import { $, addDisposableListener, append, getDomNodePagePosition, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AutomationToolKind, IAutomationDraft } from '../../../services/voltRuntime/common/automations/automations.js';
import { AUTOMATION_PROVIDERS, eventLabel, providerLabel } from '../../../services/voltRuntime/common/automations/automationTriggers.js';
import { IAgentRuntimeService, IVoltMcpServerStatus } from '../../../services/voltRuntime/common/runtime.js';
import { IWorkflowService, IWorkflowSummary, IWorkflowTrigger } from '../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { createModeIcon, createStrokeIcon, ModeIconId } from '../../voltAgent/browser/chrome/agentModeIcons.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createSlashIcon } from '../../voltAgent/browser/composer/agentSkillHoverCard.js';
import { AgentSlashMenu, rankSlashItems } from '../../voltAgent/browser/composer/agentSlashMenu.js';
import { AgentVoiceDictation } from '../../voltAgent/browser/composer/agentVoiceDictation.js';
import { AgentVoiceVisuals } from '../../voltAgent/browser/composer/agentVoiceVisuals.js';
import { IAgentCustomizeService, IAgentSlashItem } from '../../voltAgent/browser/customize/agentCustomizeService.js';
import { AgentModelPicker } from '../../voltAgent/browser/picker/agentModelPicker.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuOptions, IVoltMenuSection, showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';
import { mcpIcon, memoriesIcon, providerIcon } from '../../voltAgent/browser/automations/automationIcons.js';

/** What the instructions box reads and changes on the automation's draft. */
export interface IAutomationComposerHost {
	readonly draft: () => IAutomationDraft;
	readonly update: (patch: Partial<Pick<IAutomationDraft, 'instructions' | 'modelRef' | 'mode' | 'workflowId'>>) => void;
	/** Adds the tool to Tools unless it is there (an MCP server by name). */
	readonly addTool: (tool: { readonly kind: AutomationToolKind; readonly server?: string }) => void;
	/** Where MCP servers are configured: the first repository, else the active project. */
	readonly mcpRoot: () => URI | undefined;
	/** Add a new MCP server (Agent Resources). */
	readonly newMcpServer: () => void;
	readonly newWorkflow: () => void;
	readonly openWorkflow: (id: string) => void;
	readonly relayout: () => void;
}

/** Snippets for `/` and the + menu. */
const SNIPPETS: readonly { readonly id: string; readonly label: string; readonly detail: string; readonly text: string }[] = [
	{ id: 'memory', label: '/memory', detail: localize('voltAutomations.cmdMemory', "Keep a memory across runs"), text: 'Before doing anything else, read MEMORIES.md. Skip anything already recorded there, and record what you report (one line each, with a link and today\'s date) before finishing.' },
	{ id: 'report', label: '/report', detail: localize('voltAutomations.cmdReport', "End with a short report"), text: '## Output\n\nEnd with a short report: what you checked, what you found, what you changed (with links). If nothing needed doing, say so in one line.' },
	{ id: 'pr', label: '/pr', detail: localize('voltAutomations.cmdPr', "Open a PR only when confident"), text: 'Only open a pull request when you are highly confident the change is correct and tested. One PR per run, with a clear description.' },
	{ id: 'quiet', label: '/quiet', detail: localize('voltAutomations.cmdQuiet', "Stay quiet when nothing is found"), text: 'If there is nothing worth reporting, do not send any message; finish with "Nothing to report."' },
	{ id: 'payload', label: '/payload', detail: localize('voltAutomations.cmdPayload', "Insert a webhook field"), text: '{{payload.}}' },
];

const PAYLOAD_TEXT = '{{payload.}}';

interface IModeChoice {
	readonly id: string;
	readonly label: string;
	readonly icon: ModeIconId;
	readonly description: string;
}

const MODES: readonly IModeChoice[] = [
	{ id: 'Agent', label: localize('voltAutomations.modeAgent', "Agent"), icon: 'agent', description: localize('voltAutomations.modeAgentDesc', "Plan, build and edit end to end") },
	{ id: 'Plan', label: localize('voltAutomations.modePlan', "Plan"), icon: 'plan', description: localize('voltAutomations.modePlanDesc', "Write an implementation plan, change nothing") },
	{ id: 'Ask', label: localize('voltAutomations.modeAsk', "Ask"), icon: 'ask', description: localize('voltAutomations.modeAskDesc', "Answer questions without making edits") },
];

/** Modes a chat can hand over that the menu does not offer: kept, and shown, as they are. */
const OTHER_MODE_ICONS: Readonly<Record<string, ModeIconId>> = { Debug: 'debug', Multitask: 'multitask' };

function modeChoice(id: string | undefined): IModeChoice {
	return MODES.find(mode => mode.id === (id ?? 'Agent')) ?? { id: id!, label: id!, icon: OTHER_MODE_ICONS[id!] ?? 'agent', description: '' };
}

/** What a tool row inserts, and the tool it adds. */
interface IToolInsert {
	readonly kind?: AutomationToolKind;
	readonly server?: string;
	readonly text: string;
}

function toolInserts(servers: readonly string[]): IVoltMenuItem<IToolInsert>[] {
	return [
		{ id: 'memories', label: localize('voltAutomations.memories', "Memories"), icon: () => memoriesIcon(), data: { kind: 'memories', text: 'MEMORIES.md' } },
		{ id: 'slack_send', label: localize('voltAutomations.sendSlack', "Send to Slack"), icon: () => providerIcon('slack'), data: { kind: 'slack_send', text: 'send a Slack message' } },
		{ id: 'slack_read', label: localize('voltAutomations.readSlack', "Read Public Slack Channels"), icon: () => providerIcon('slack'), data: { kind: 'slack_read', text: 'read the Slack channel' } },
		{ id: 'teams_send', label: localize('voltAutomations.sendTeams', "Send to Microsoft Teams"), icon: () => providerIcon('teams'), data: { kind: 'teams_send', text: 'send a Microsoft Teams message' } },
		{ id: 'teams_read', label: localize('voltAutomations.readTeams', "Read Microsoft Teams Channels"), icon: () => providerIcon('teams'), data: { kind: 'teams_read', text: 'read the Microsoft Teams channel' } },
		{ id: 'pr_comment', label: localize('voltAutomations.prComment', "PR Comment"), icon: () => providerIcon('github'), data: { text: 'comment on the pull request (pr_comment)' } },
		{ id: 'open_pr', label: localize('voltAutomations.pullRequest', "Pull Request"), icon: () => providerIcon('github'), data: { text: 'open a pull request (open_pr)' } },
		...servers.map((server): IVoltMenuItem<IToolInsert> => ({ id: `mcp:${server}`, label: server, icon: () => mcpIcon(), data: { kind: 'mcp', server, text: mcpPhrase(server) } })),
	];
}

function mcpPhrase(server: string): string {
	return `the ${server} MCP server`;
}

/** "Manual", "Cron 0 9 * * 1-5", "GitHub · Pull request opened": what starts the workflow on its own. */
function workflowTriggerLabel(trigger: IWorkflowTrigger): string {
	switch (trigger.type) {
		case 'schedule':
			return trigger.cron
				? localize('voltAutomations.wfCron', "Cron {0}", trigger.cron)
				: trigger.everyMinutes ? localize('voltAutomations.wfEvery', "Every {0} min", trigger.everyMinutes) : localize('voltAutomations.wfScheduled', "Scheduled");
		case 'event': {
			const provider = AUTOMATION_PROVIDERS.find(entry => entry === trigger.provider);
			if (!provider) {
				return localize('voltAutomations.wfEvent', "Event");
			}
			return trigger.event ? `${providerLabel(provider)} · ${eventLabel(provider, trigger.event)}` : providerLabel(provider);
		}
		default:
			return localize('voltAutomations.wfManual', "Manual");
	}
}

function nodeCountLabel(count: number): string {
	return count === 1 ? localize('voltAutomations.wfNode', "1 node") : localize('voltAutomations.wfNodes', "{0} nodes", count);
}

/** The composer's mic glyph. */
function createMicIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.mic');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 72 72');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('aria-hidden', 'true');
	const mic = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	mic.setAttribute('d', 'M52.251 34.646 57.501 34.727C57.339 45.515 49.239 54.134 38.625 55.352V65.354H33.375V55.331C22.128 53.927 14.499 43.826 14.499 34.688H19.749C19.749 42.05 26.439 50.252 36.045 50.252 45 50.252 52.119 43.397 52.251 34.646ZM35.999 6.646C41.699 6.646 46.337 11.284 46.337 16.981L46.307 34.654C46.307 40.351 41.684 44.989 35.999 44.989 30.302 44.989 25.664 40.351 25.664 34.654V16.981C25.664 11.284 30.302 6.646 35.999 6.646Z');
	mic.setAttribute('fill', 'currentColor');
	svg.appendChild(mic);
	el.appendChild(svg);
	return el;
}

function createPlusIcon(): HTMLElement {
	return createStrokeIcon('plus', ['M12 5v14M5 12h14'], '1.75');
}

/** The composer's skill mark: an outlined cube. */
function createSkillIcon(): HTMLElement {
	return createStrokeIcon('cube', ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'M12 12l8-4.5M12 12v9M12 12L4 7.5']);
}

/**
 * Where dictation writes in the textarea: each partial transcript replaces the last one, at the
 * caret where dictation started. Typing elsewhere meanwhile moves the spot to the new caret.
 */
class TextareaDictation {

	private start = -1;
	private written = '';
	private separator = '';

	constructor(private readonly area: HTMLTextAreaElement, private readonly onDidWrite: () => void) { }

	get writing(): boolean {
		return this.start >= 0;
	}

	write(text: string): void {
		const value = this.area.value;
		if (this.start < 0 || value.slice(this.start, this.start + this.written.length) !== this.written) {
			this.start = this.area.selectionEnd;
			this.written = '';
			const before = value.charAt(this.start - 1);
			this.separator = before && !/\s/.test(before) ? ' ' : '';
		}
		const insert = text ? this.separator + text : '';
		if (insert === this.written) {
			return;
		}
		this.area.setRangeText(insert, this.start, this.start + this.written.length, 'end');
		this.written = insert;
		this.onDidWrite();
	}

	/** Settles with the final text, or takes the partial back out when `text` is empty. */
	end(text: string): void {
		if (this.start >= 0 || text) {
			this.write(text);
		}
		this.start = -1;
		this.written = '';
		if (text) {
			this.area.focus();
		}
	}

	/** The instructions before where dictation writes, which the cleanup reads. */
	textBefore(): string {
		return this.area.value.slice(0, this.start >= 0 ? this.start : this.area.selectionStart);
	}
}

/** The `/` or `@` word before the caret. */
interface IAssistToken {
	readonly trigger: '/' | '@';
	/** Where the `/` or `@` is. */
	readonly start: number;
	readonly query: string;
}

type SlashPick =
	| { readonly kind: 'skill'; readonly name: string }
	| { readonly kind: 'mcp'; readonly server: string }
	| { readonly kind: 'snippet'; readonly text: string };

type PlusPick =
	| { readonly kind: 'none' }
	| { readonly kind: 'skill'; readonly name: string }
	| { readonly kind: 'mcp'; readonly server: string }
	| { readonly kind: 'new-mcp' }
	| { readonly kind: 'tool'; readonly tool: IToolInsert }
	| { readonly kind: 'snippet'; readonly text: string };

type WorkflowPick = { readonly kind: 'none' } | { readonly kind: 'workflow'; readonly id: string } | { readonly kind: 'new' } | { readonly kind: 'open'; readonly id: string };

const MIN_HEIGHT = 132;
const MAX_HEIGHT = 520;

/**
 * Agent Instructions in the chat composer's look: the text, then a toolbar with the + menu, the
 * mode, the model and the workflow on the left and dictation on the right. `/` at a word start
 * lists skills, MCP servers and snippets, `@` lists tools. Changes go to the draft through the host.
 */
export class AutomationComposer extends Disposable {

	readonly element: HTMLElement;
	readonly input: HTMLTextAreaElement;
	private readonly box: HTMLElement;
	private readonly modeButton: HTMLButtonElement;
	private readonly workflowButton: HTMLButtonElement;
	private readonly micButton: HTMLButtonElement;
	private readonly note: HTMLElement;

	private readonly menu = this._register(new MutableDisposable<IVoltMenuHandle>());
	private readonly slashMenu: AgentSlashMenu;
	private readonly slashPicks = new Map<string, SlashPick>();
	private readonly dictation: AgentVoiceDictation;
	private readonly dictated: TextareaDictation;

	private skills: readonly IAgentSlashItem[] | undefined;
	private skillsLoading: Promise<readonly IAgentSlashItem[]> | undefined;
	/** MCP servers, read again for each new `/`. */
	private servers: readonly IVoltMcpServerStatus[] | undefined;
	private token: IAssistToken | undefined;
	/** Escape closed the menu for the token starting here: it stays closed until another starts. */
	private dismissed: number | undefined;
	private slashGeneration = 0;

	constructor(
		parent: HTMLElement,
		private readonly host: IAutomationComposerHost,
		@IContextViewService private readonly contextView: IContextViewService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IWorkflowService private readonly workflows: IWorkflowService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.element = append(parent, $('.volt-auto-composer-wrap'));
		this.box = append(this.element, $('.volt-auto-composer'));

		const area = this.input = append(this.box, $('textarea.volt-auto-composer-input')) as HTMLTextAreaElement;
		area.value = host.draft().instructions;
		area.placeholder = localize('voltAutomations.instructionsPlaceholder2', "Describe what the agent should do. Type / for skills, MCP and snippets, @ for tools");
		area.spellcheck = false;
		area.setAttribute('aria-label', localize('voltAutomations.instructions', "Agent Instructions"));

		const toolbar = append(this.box, $('.volt-auto-composer-toolbar'));
		const start = append(toolbar, $('.volt-auto-composer-start'));
		const end = append(toolbar, $('.volt-auto-composer-end'));

		const plus = this.toolbarButton(start, 'volt-auto-composer-plus', localize('voltAutomations.insert', "Insert skill, tool or snippet"));
		plus.appendChild(createPlusIcon());
		setAgentTooltip(plus, localize('voltAutomations.insertTooltip', "Insert a skill, MCP server, tool or snippet"));
		this._register(addDisposableListener(plus, 'click', () => this.showPlusMenu(plus)));

		this.modeButton = this.toolbarButton(start, 'volt-auto-composer-ghost.mode', localize('voltAutomations.mode', "Mode"));
		this.modeButton.setAttribute('aria-haspopup', 'menu');
		this._register(addDisposableListener(this.modeButton, 'click', () => this.showModeMenu()));
		this.paintMode();

		// The composer's picker, kept on the draft: Auto leaves the run on the default model.
		const modelButton = this.toolbarButton(start, 'volt-auto-composer-ghost.model', localize('voltAutomations.model', "Model"));
		modelButton.setAttribute('aria-haspopup', 'dialog');
		const picker = this._register(instantiationService.createInstance(AgentModelPicker, {
			binding: {
				get: () => this.host.draft().modelRef,
				set: ref => this.host.update({ modelRef: ref }),
				autoLabel: localize('voltAutomations.auto', "Auto"),
				autoDescription: localize('voltAutomations.autoDesc', "Run on the default model"),
			},
			position: AnchorPosition.ABOVE,
			onDidChange: () => paintModel(),
		}));
		const paintModel = () => {
			modelButton.replaceChildren();
			picker.renderTrigger(modelButton);
			modelButton.appendChild(renderIcon(Codicon.chevronDown));
		};
		paintModel();
		this._register(addDisposableListener(modelButton, 'click', () => {
			modelButton.classList.add('open');
			picker.show(modelButton, () => {
				modelButton.classList.remove('open');
				paintModel();
			});
		}));

		this.workflowButton = this.toolbarButton(start, 'volt-auto-composer-ghost.workflow', localize('voltAutomations.workflow', "Workflow"));
		this.workflowButton.setAttribute('aria-haspopup', 'menu');
		this._register(addDisposableListener(this.workflowButton, 'click', () => this.showWorkflowMenu()));

		this.micButton = this.toolbarButton(end, 'volt-agent-icon-btn.volt-agent-mic-btn.volt-auto-composer-mic', localize('voltAutomations.voice', "Voice"));
		this.micButton.setAttribute('aria-pressed', 'false');
		this.micButton.appendChild(createMicIcon());
		setAgentTooltip(this.micButton, localize('voltAutomations.voice', "Voice"));

		this.note = append(this.element, $('.volt-auto-composer-note'));
		this.note.hidden = true;

		// Dictation as in the chat composer: the transcript streams in at the caret.
		this.dictation = this._register(instantiationService.createInstance(AgentVoiceDictation));
		this.dictated = new TextareaDictation(area, () => this.textChanged());
		this.dictation.textBefore = () => this.dictated.textBefore();
		this._register(this.dictation.onDidChange(() => this.syncDictation()));
		this._register(this.dictation.onDidCommit(text => this.dictated.end(text)));
		this._register(this.dictation.onDidFail(message => this.notifications.warn(message)));
		this._register(new AgentVoiceVisuals(this.box, this.micButton, this.dictation));
		this.micButton.hidden = !this.dictation.available;
		this._register(addDisposableListener(this.micButton, 'click', () => this.dictation.toggle()));

		this.slashMenu = this._register(instantiationService.createInstance(AgentSlashMenu, {
			anchor: () => this.box,
			cursor: () => {
				const page = getDomNodePagePosition(this.box);
				return { x: page.left, y: page.top, width: page.width, height: page.height };
			},
			pick: (item: IAgentSlashItem) => this.pickSlash(item),
			onDidHide: () => { this.slashGeneration++; },
		}));
		this._register(this.customize.onDidChange(() => {
			this.skills = undefined;
			this.skillsLoading = undefined;
		}));

		// Before any other key listener: Enter and Escape that drive the menu must not reach the text.
		this._register(addDisposableListener(area, 'keydown', e => this.onKeyDown(e)));
		this._register(addDisposableListener(area, 'input', () => {
			this.textChanged();
			this.refreshToken(true);
		}));
		this._register(addDisposableListener(area, 'keyup', e => {
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
				this.refreshToken(false);
			}
		}));
		this._register(addDisposableListener(area, 'click', () => this.refreshToken(false)));
		this._register(addDisposableListener(area, 'blur', () => this.slashMenu.hide()));
		this._register(addDisposableListener(area, 'scroll', () => this.syncOverflow()));
		this._register(addDisposableListener(this.box, 'mousedown', e => {
			// A press on the box's empty space (around the toolbar) puts the caret in the text.
			if (e.target === this.box || (e.target as HTMLElement).classList?.contains('volt-auto-composer-toolbar')) {
				e.preventDefault();
				area.focus();
			}
		}));

		this._register(this.workflows.onDidChange(() => this.syncWorkflow()));
		void this.workflows.whenReady.then(() => {
			if (!this._store.isDisposed) {
				this.syncWorkflow();
			}
		});
		this.syncWorkflow();
		getWindow(area).requestAnimationFrame(() => this.fit());
	}

	focus(): void {
		this.input.focus();
	}

	private toolbarButton(parent: HTMLElement, className: string, label: string): HTMLButtonElement {
		const button = append(parent, $(`button.${className}`)) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-label', label);
		// Keep the caret in the text while a toolbar button is pressed.
		this._register(addDisposableListener(button, 'mousedown', e => e.preventDefault()));
		return button;
	}

	//#region Text

	private textChanged(): void {
		this.host.update({ instructions: this.input.value });
		this.fit();
	}

	private fit(): void {
		const area = this.input;
		area.style.height = 'auto';
		area.style.height = `${Math.min(Math.max(area.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
		this.syncOverflow();
		this.host.relayout();
	}

	private syncOverflow(): void {
		const area = this.input;
		this.box.classList.toggle('overflowing', area.scrollHeight > MAX_HEIGHT && area.scrollTop + area.clientHeight < area.scrollHeight - 4);
	}

	/**
	 * Puts `text` in place of `from`..`to` (the caret's selection by default) and leaves the caret
	 * after it, or `caret` characters into it.
	 */
	private insert(text: string, from = this.input.selectionStart, to = this.input.selectionEnd, caret?: number): void {
		const area = this.input;
		const value = area.value;
		let lead = '';
		// Words go in as words: a space before them when the caret touches the previous word.
		const before = value.charAt(from - 1);
		if (before && !/\s/.test(before) && !/^\s/.test(text)) {
			lead = ' ';
		}
		// A snippet that starts a section starts its own paragraph.
		if (text.startsWith('#') && from > 0 && value.slice(0, from).trimEnd().length) {
			lead = value.charAt(from - 1) === '\n' ? (value.charAt(from - 2) === '\n' ? '' : '\n') : '\n\n';
		}
		const full = lead + text;
		area.focus();
		area.setRangeText(full, from, to, 'end');
		if (caret !== undefined) {
			const at = from + lead.length + caret;
			area.setSelectionRange(at, at);
		}
		this.textChanged();
	}

	//#endregion

	//#region `/` and `@`

	private onKeyDown(e: KeyboardEvent): void {
		if (e.isComposing) {
			return;
		}
		if (this.slashMenu.isVisible && !e.metaKey && !e.ctrlKey && !e.altKey) {
			switch (e.key) {
				case 'ArrowDown':
				case 'ArrowUp':
					e.preventDefault();
					e.stopPropagation();
					this.slashMenu.move(e.key === 'ArrowDown' ? 1 : -1);
					return;
				case 'Enter':
				case 'Tab':
					if (e.shiftKey) {
						break;
					}
					if (!this.slashMenu.hasSelection) {
						this.dismiss();
						break;
					}
					// Stop the key first: the pick edits the text.
					e.preventDefault();
					e.stopPropagation();
					this.slashMenu.accept(false);
					return;
				case 'Escape':
					e.preventDefault();
					e.stopPropagation();
					this.dismiss();
					return;
			}
		}
		if (e.key === 'Escape' && this.dictation.active) {
			e.preventDefault();
			e.stopPropagation();
			this.dictation.cancel();
		}
	}

	/** Reads the `/` or `@` word before the caret. Only typing opens a menu; moving the caret only updates or closes it. */
	private refreshToken(allowOpen: boolean): void {
		const area = this.input;
		const caret = area.selectionStart;
		const match = area.selectionStart === area.selectionEnd ? /(^|\s)([@/])([\w.:-]*)$/.exec(area.value.slice(0, caret)) : null;
		if (!match) {
			this.token = undefined;
			this.dismissed = undefined;
			this.closeAssist();
			return;
		}
		const token: IAssistToken = { trigger: match[2] as '/' | '@', start: caret - match[3].length - 1, query: match[3] };
		const isNew = this.token?.start !== token.start || this.token.trigger !== token.trigger;
		if (this.dismissed === token.start || (isNew && !allowOpen)) {
			this.token = isNew ? undefined : token;
			this.closeAssist();
			return;
		}
		this.dismissed = undefined;
		this.token = token;
		if (token.trigger === '/') {
			if (isNew) {
				this.servers = undefined;
			}
			this.paintSlash();
		} else if (isNew) {
			this.showToolMenu(token);
		}
	}

	private dismiss(): void {
		this.dismissed = this.token?.start;
		this.closeAssist();
	}

	private closeAssist(): void {
		this.slashGeneration++;
		this.slashMenu.hide();
	}

	private paintSlash(): void {
		const token = this.token;
		if (!token || token.trigger !== '/') {
			return;
		}
		const generation = ++this.slashGeneration;
		if (!this.skills || !this.servers) {
			void Promise.all([this.loadSkills(), this.loadServers()]).then(() => {
				if (generation === this.slashGeneration && this.token === token && !this._store.isDisposed) {
					this.paintSlash();
				}
			});
			return;
		}
		this.slashPicks.clear();
		const servers = this.servers.map((server): IAgentSlashItem => {
			const item: IAgentSlashItem = {
				id: `mcp:${server.name}`,
				name: server.name,
				type: 'command',
				title: server.name,
				description: localize('voltAutomations.slashMcpDesc', "Inserts \"{0}\" and adds the server to Tools, so runs can call it.", mcpPhrase(server.name)),
				summary: localize('voltAutomations.slashMcp', "MCP server"),
				icon: 'customize',
				sourceLabel: server.scope === 'project' ? localize('voltAutomations.slashMcpProject', "MCP server in the project") : localize('voltAutomations.slashMcpUser', "MCP server in your home folder"),
				builtin: false,
				canUseAsMode: false,
			};
			this.slashPicks.set(item.id, { kind: 'mcp', server: server.name });
			return item;
		});
		const snippets = SNIPPETS.map((snippet): IAgentSlashItem => {
			const item: IAgentSlashItem = {
				id: `snippet:${snippet.id}`,
				name: snippet.id,
				type: 'command',
				title: snippet.label,
				description: snippet.text,
				summary: snippet.detail,
				icon: 'command',
				sourceLabel: localize('voltAutomations.slashSnippet', "Automation snippet"),
				builtin: false,
				canUseAsMode: false,
			};
			this.slashPicks.set(item.id, { kind: 'snippet', text: snippet.text });
			return item;
		});
		const skills = this.skills.map(skill => {
			this.slashPicks.set(skill.id, { kind: 'skill', name: skill.name });
			return { ...skill, canUseAsMode: false };
		});
		// Servers and snippets first (few rows), then skills (often many); a query ranks them together.
		const rows = token.query
			? rankSlashItems([...servers, ...snippets, ...skills], token.query)
			: [...rankSlashItems(servers, ''), ...snippets.map(item => ({ item, summary: item.summary })), ...rankSlashItems(skills, '')];
		if (!rows.length) {
			this.slashMenu.hide();
			return;
		}
		this.slashMenu.show(rows);
	}

	private pickSlash(item: IAgentSlashItem): void {
		const token = this.token;
		const pick = this.slashPicks.get(item.id);
		this.token = undefined;
		this.closeAssist();
		if (!token || !pick) {
			return;
		}
		const to = token.start + 1 + token.query.length;
		switch (pick.kind) {
			case 'skill':
				this.insert(`/${pick.name} `, token.start, to);
				return;
			case 'mcp':
				this.insert(`${mcpPhrase(pick.server)} `, token.start, to);
				this.host.addTool({ kind: 'mcp', server: pick.server });
				return;
			case 'snippet':
				this.insert(pick.text, token.start, to, pick.text === PAYLOAD_TEXT ? PAYLOAD_TEXT.length - 2 : undefined);
				return;
		}
	}

	/** `@`: tools, with a search field; picking one inserts a phrase for it and adds it to Tools. */
	private showToolMenu(token: IAssistToken): void {
		const servers = this.host.draft().tools.filter(tool => tool.kind === 'mcp' && tool.server).map(tool => tool.server!);
		this.showMenu<IToolInsert>({
			anchor: this.box,
			gap: 4,
			width: 300,
			className: 'volt-auto-menu volt-auto-composer-menu',
			ariaLabel: localize('voltAutomations.tools', "Tools"),
			search: { placeholder: localize('voltAutomations.searchTools', "Search tools...") },
			sections: [{ id: 'tools', items: toolInserts(servers) }],
			onPick: item => {
				const to = token.start + 1 + token.query.length;
				this.token = undefined;
				this.insertTool(item.data, token.start, to);
			},
		});
	}

	private insertTool(tool: IToolInsert, from?: number, to?: number): void {
		this.insert(tool.text, from, to);
		if (tool.kind) {
			this.host.addTool({ kind: tool.kind, ...(tool.server ? { server: tool.server } : {}) });
		}
	}

	/**
	 * Opens a Volt menu (it takes focus for its keys) and gives focus back when it closes: to the
	 * text or the button that had it, so Escape leaves a keyboard user where they were.
	 */
	private showMenu<T>(options: IVoltMenuOptions<T>): void {
		const targetWindow = getWindow(this.input);
		const previous = targetWindow.document.activeElement;
		this.menu.value = showVoltMenu<T>(this.contextView, {
			...options,
			onHide: () => {
				const active = targetWindow.document.activeElement;
				if (active && active !== targetWindow.document.body && !this.contextView.getContextViewElement().contains(active)) {
					return;
				}
				const back = isHTMLElement(previous) && previous.isConnected && this.element.contains(previous) ? previous : this.input;
				back.focus();
			},
		});
	}

	private loadSkills(): Promise<readonly IAgentSlashItem[]> {
		if (this.skills) {
			return Promise.resolve(this.skills);
		}
		if (!this.skillsLoading) {
			const loading: Promise<readonly IAgentSlashItem[]> = this.customize.getSlashItems().then(items => {
				// App commands (/model, /new) act in a chat; a run's instructions only use what the agent can.
				const skills = items.filter(item => item.type !== 'builtin-command');
				if (this.skillsLoading === loading) {
					this.skills = skills;
				}
				return skills;
			}, () => {
				if (this.skillsLoading === loading) {
					this.skillsLoading = undefined;
				}
				return [];
			});
			this.skillsLoading = loading;
		}
		return this.skillsLoading;
	}

	private async loadServers(): Promise<readonly IVoltMcpServerStatus[]> {
		if (!this.servers) {
			this.servers = await this.runtime.listMcpServers(this.host.mcpRoot()).catch(() => []);
		}
		return this.servers;
	}

	//#endregion

	//#region + menu

	private showPlusMenu(anchor: HTMLElement): void {
		const document = this.element.ownerDocument;
		this.showMenu<PlusPick>({
			anchor,
			gap: 6,
			width: 264,
			className: 'volt-auto-menu volt-auto-composer-menu',
			ariaLabel: localize('voltAutomations.insertMenu', "Insert"),
			search: { placeholder: localize('voltAutomations.searchInsert', "Search skills, tools, snippets...") },
			sections: [{
				id: 'insert',
				items: [
					{
						id: 'skill', label: localize('voltAutomations.plusSkill', "Skill"), keywords: 'slash command subagent rule', icon: createSkillIcon, data: { kind: 'none' },
						submenu: {
							width: 300,
							className: 'volt-auto-menu volt-auto-composer-menu',
							search: { placeholder: localize('voltAutomations.searchSkills', "Search skills...") },
							emptyMessage: localize('voltAutomations.noSkills', "No skills found."),
							sections: async () => {
								const skills = await this.loadSkills();
								return [{
									id: 'skills',
									items: [...skills].sort((a, b) => a.name.localeCompare(b.name)).map((skill): IVoltMenuItem<PlusPick> => ({
										id: skill.id, label: skill.name, detail: skill.summary, keywords: skill.description, tooltip: skill.description,
										icon: () => createSlashIcon(skill, undefined, document), data: { kind: 'skill', name: skill.name },
									})),
								}];
							},
						},
					},
					{
						id: 'mcp', label: localize('voltAutomations.mcpServer', "MCP Server"), keywords: 'mcp server connection', icon: () => mcpIcon(), data: { kind: 'none' },
						submenu: {
							width: 240,
							className: 'volt-auto-menu volt-auto-composer-menu',
							emptyMessage: localize('voltAutomations.noMcp', "No MCP servers configured."),
							sections: async (): Promise<IVoltMenuSection<PlusPick>[]> => {
								const servers = await this.runtime.listMcpServers(this.host.mcpRoot()).catch(() => []);
								const item = (server: IVoltMcpServerStatus): IVoltMenuItem<PlusPick> => ({ id: `mcp:${server.name}`, label: server.name, icon: () => mcpIcon(), data: { kind: 'mcp', server: server.name } });
								return [
									{ id: 'new', items: [{ id: 'new', label: localize('voltAutomations.newConnection', "New Connection"), icon: Codicon.add, data: { kind: 'new-mcp' } }] },
									{ id: 'user', title: localize('voltAutomations.mcpUser', "User"), items: servers.filter(server => server.scope === 'user').map(item) },
									{ id: 'project', title: localize('voltAutomations.mcpProject', "Project"), items: servers.filter(server => server.scope === 'project').map(item) },
								];
							},
						},
					},
					{
						id: 'tool', label: localize('voltAutomations.plusTool', "Tool"), keywords: 'slack teams memories pull request comment', icon: Codicon.tools, data: { kind: 'none' },
						submenu: {
							width: 280,
							className: 'volt-auto-menu volt-auto-composer-menu',
							sections: [{ id: 'tools', items: toolInserts([]).map((item): IVoltMenuItem<PlusPick> => ({ id: item.id, label: item.label, icon: item.icon, data: { kind: 'tool', tool: item.data } })) }],
						},
					},
					{
						id: 'payload', label: localize('voltAutomations.plusPayload', "Payload Value"), detail: '{{payload.…}}', keywords: 'webhook field variable template', icon: Codicon.json,
						tooltip: localize('voltAutomations.plusPayloadHelp', "A field of the webhook that started the run, filled in when it runs"),
						data: { kind: 'snippet', text: PAYLOAD_TEXT },
					},
					{
						id: 'snippet', label: localize('voltAutomations.plusSnippet', "Snippet"), keywords: 'memory report pr quiet', icon: Codicon.symbolSnippet, data: { kind: 'none' },
						submenu: {
							width: 300,
							className: 'volt-auto-menu volt-auto-composer-menu',
							sections: [{ id: 'snippets', items: SNIPPETS.filter(snippet => snippet.text !== PAYLOAD_TEXT).map((snippet): IVoltMenuItem<PlusPick> => ({ id: snippet.id, label: snippet.label, detail: snippet.detail, tooltip: snippet.text, data: { kind: 'snippet', text: snippet.text } })) }],
						},
					},
				],
			}],
			onPick: item => this.pickPlus(item.data),
		});
	}

	private pickPlus(pick: PlusPick): void {
		switch (pick.kind) {
			case 'skill':
				this.insert(`/${pick.name} `);
				return;
			case 'mcp':
				this.insert(`${mcpPhrase(pick.server)} `);
				this.host.addTool({ kind: 'mcp', server: pick.server });
				return;
			case 'new-mcp':
				this.host.newMcpServer();
				return;
			case 'tool':
				this.insertTool(pick.tool);
				return;
			case 'snippet':
				this.insert(pick.text, undefined, undefined, pick.text === PAYLOAD_TEXT ? PAYLOAD_TEXT.length - 2 : undefined);
				return;
		}
	}

	//#endregion

	//#region Mode

	private paintMode(): void {
		const mode = modeChoice(this.host.draft().mode);
		this.modeButton.replaceChildren();
		this.modeButton.appendChild(createModeIcon(mode.icon));
		append(this.modeButton, $('span.label')).textContent = mode.label;
		this.modeButton.appendChild(renderIcon(Codicon.chevronDown));
		this.modeButton.dataset.mode = mode.id.toLowerCase();
		setAgentTooltip(this.modeButton, mode.description ? `${mode.label} · ${mode.description}` : mode.label);
	}

	private showModeMenu(): void {
		const current = modeChoice(this.host.draft().mode);
		const modes = MODES.some(mode => mode.id === current.id) ? MODES : [...MODES, current];
		this.showMenu<string>({
			anchor: this.modeButton,
			gap: 6,
			width: 280,
			className: 'volt-auto-menu volt-auto-composer-menu',
			ariaLabel: localize('voltAutomations.mode', "Mode"),
			sections: [{
				id: 'modes',
				items: modes.map(mode => ({ id: mode.id, label: mode.label, ...(mode.description ? { subtitle: mode.description } : {}), icon: () => createModeIcon(mode.icon), checked: mode.id === current.id, data: mode.id })),
			}],
			onPick: item => {
				// Agent is the default: left off the draft so the stored mode clears.
				this.host.update({ mode: item.data === 'Agent' ? undefined : item.data });
				this.paintMode();
			},
		});
	}

	//#endregion

	//#region Workflow

	private workflowSummary(id: string | undefined): IWorkflowSummary | undefined {
		return id ? this.workflows.list().find(workflow => workflow.id === id) : undefined;
	}

	/** The chip's label and the note under the box, from the draft's workflow. */
	syncWorkflow(): void {
		const id = this.host.draft().workflowId;
		const summary = this.workflowSummary(id);
		const name = summary?.name ?? id;
		const button = this.workflowButton;
		button.replaceChildren();
		button.appendChild(renderIcon(Codicon.typeHierarchySub));
		append(button, $('span.prefix')).textContent = localize('voltAutomations.workflowPrefix', "Workflow:");
		append(button, $('span.label')).textContent = name ?? localize('voltAutomations.workflowNone', "None");
		button.appendChild(renderIcon(Codicon.chevronDown));
		button.classList.toggle('picked', !!id);
		button.classList.toggle('missing', !!id && !summary && this.workflows.list().length > 0);
		setAgentTooltip(button, id
			? localize('voltAutomations.workflowTooltip', "Runs the workflow {0}", name)
			: localize('voltAutomations.workflowNoneTooltip', "No workflow: runs send these instructions to the agent"));
		this.note.hidden = !id;
		this.note.textContent = id ? localize('voltAutomations.workflowNote', "Runs {0}; these instructions become its task input.", name) : '';
		this.box.classList.toggle('has-workflow', !!id);
		this.host.relayout();
	}

	private showWorkflowMenu(): void {
		const current = this.host.draft().workflowId;
		const workflows = [...this.workflows.list()].sort((a, b) => b.updatedAt - a.updatedAt);
		this.showMenu<WorkflowPick>({
			anchor: this.workflowButton,
			gap: 6,
			width: 320,
			className: 'volt-auto-menu volt-auto-composer-menu',
			ariaLabel: localize('voltAutomations.workflow', "Workflow"),
			search: { placeholder: localize('voltAutomations.searchWorkflows', "Search workflows...") },
			sections: [
				{
					id: 'none',
					items: [{ id: 'none', label: localize('voltAutomations.workflowNone', "None"), detail: localize('voltAutomations.workflowNoneDetail', "Run the instructions"), icon: Codicon.circleSlash, checked: !current, data: { kind: 'none' } }],
				},
				{
					id: 'workflows',
					title: localize('voltAutomations.workflows', "Workflows"),
					emptyMessage: localize('voltAutomations.noWorkflowsYet', "No workflows yet."),
					items: workflows.map((workflow): IVoltMenuItem<WorkflowPick> => ({
						id: workflow.id,
						label: workflow.name,
						subtitle: `${workflowTriggerLabel(workflow.trigger)} · ${nodeCountLabel(workflow.nodeCount)}`,
						keywords: `${workflow.id} ${workflow.description ?? ''}`,
						...(workflow.description ? { tooltip: workflow.description } : {}),
						icon: Codicon.typeHierarchySub,
						checked: workflow.id === current,
						data: { kind: 'workflow', id: workflow.id },
					})),
				},
			],
			footer: [
				{ id: 'new', label: localize('voltAutomations.newWorkflow', "New Workflow"), icon: Codicon.add, data: { kind: 'new' } },
				...(current ? [{ id: 'open', label: localize('voltAutomations.openInBuilder', "Open in Builder"), icon: Codicon.linkExternal, data: { kind: 'open' as const, id: current } }] : []),
			],
			onPick: item => {
				const pick = item.data;
				switch (pick.kind) {
					case 'none':
						this.host.update({ workflowId: undefined });
						this.syncWorkflow();
						return;
					case 'workflow':
						this.host.update({ workflowId: pick.id });
						this.syncWorkflow();
						return;
					case 'new':
						this.host.newWorkflow();
						return;
					case 'open':
						this.host.openWorkflow(pick.id);
						return;
				}
			},
		});
	}

	//#endregion

	//#region Dictation

	private syncDictation(): void {
		const active = this.dictation.active;
		if (active) {
			this.dictated.write(this.dictation.partial);
		} else if (this.dictated.writing) {
			// Cancelled or failed: take the partial transcript back out.
			this.dictated.end('');
		}
		if (this.micButton.classList.contains('recording') !== active) {
			this.micButton.classList.toggle('recording', active);
			this.micButton.setAttribute('aria-pressed', String(active));
			const label = active ? localize('voltAutomations.voiceStop', "Stop dictation") : localize('voltAutomations.voice', "Voice");
			this.micButton.setAttribute('aria-label', label);
			setAgentTooltip(this.micButton, label);
		}
	}

	//#endregion
}
