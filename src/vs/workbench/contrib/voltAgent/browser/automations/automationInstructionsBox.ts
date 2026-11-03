/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentComposerInput.css';
import { $, addDisposableListener, append, getDomNodePagePosition, getWindow } from '../../../../../base/browser/dom.js';
import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { AutomationToolKind } from '../../../../services/voltRuntime/common/automations/automations.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentSlashMenu, IAgentSlashMenuRow, rankSlashItems } from '../composer/agentSlashMenu.js';
import { AgentVoiceDictation } from '../composer/agentVoiceDictation.js';
import { AgentVoiceVisuals } from '../composer/agentVoiceVisuals.js';
import { IAgentCustomizeService, IAgentSlashItem } from '../customize/agentCustomizeService.js';
import { AgentModelPicker } from '../picker/agentModelPicker.js';
import { IVoltMenuHandle, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { IToolMenuOptions, ToolPick, toolMenuSections } from './automationPickers.js';

/** Snippets for `/`, listed above the skills: text an automation's instructions often need. */
const SNIPPETS: readonly { readonly name: string; readonly title: string; readonly summary: string; readonly text: string }[] = [
	{ name: 'memory', title: 'Memory', summary: localize('voltAutomations.cmdMemory', "Keep a memory across runs"), text: 'Before doing anything else, read MEMORIES.md. Skip anything already recorded there, and record what you report (one line each, with a link and today\'s date) before finishing.' },
	{ name: 'report', title: 'Report', summary: localize('voltAutomations.cmdReport', "End with a short report"), text: '## Output\n\nEnd with a short report: what you checked, what you found, what you changed (with links). If nothing needed doing, say so in one line.' },
	{ name: 'pr', title: 'Pull request', summary: localize('voltAutomations.cmdPr', "Open a PR only when confident"), text: 'Only open a pull request when you are highly confident the change is correct and tested. One PR per run, with a clear description.' },
	{ name: 'quiet', title: 'Quiet', summary: localize('voltAutomations.cmdQuiet', "Stay quiet when nothing is found"), text: 'If there is nothing worth reporting, do not send any message; finish with "Nothing to report."' },
	{ name: 'payload', title: 'Webhook field', summary: localize('voltAutomations.cmdPayload', "Insert a webhook field"), text: '{{payload.}}' },
];

/** What `@` offers: the run's tools, named as the agent sees them. Kinds are added to Tools when picked. */
const MENTIONS: readonly { readonly name: string; readonly title: string; readonly summary: string; readonly text: string; readonly kind?: AutomationToolKind }[] = [
	{ name: 'memories', title: 'Memories', summary: localize('voltAutomations.mentionMemories', "The notes the agent keeps across runs"), text: 'MEMORIES.md', kind: 'memories' },
	{ name: 'slack', title: 'Send to Slack', summary: localize('voltAutomations.mentionSlack', "Post a message with send_slack"), text: 'send a Slack message', kind: 'slack_send' },
	{ name: 'slack-read', title: 'Read Slack', summary: localize('voltAutomations.mentionSlackRead', "Read a public channel"), text: 'read the Slack channel', kind: 'slack_read' },
	{ name: 'teams', title: 'Send to Microsoft Teams', summary: localize('voltAutomations.mentionTeams', "Post a message with send_teams"), text: 'send a Microsoft Teams message', kind: 'teams_send' },
	{ name: 'teams-read', title: 'Read Microsoft Teams', summary: localize('voltAutomations.mentionTeamsRead', "Read a Teams channel"), text: 'read the Microsoft Teams channel', kind: 'teams_read' },
	{ name: 'pr-comment', title: 'PR Comment', summary: localize('voltAutomations.mentionPrComment', "Comment on the pull request"), text: 'comment on the pull request (pr_comment)' },
	{ name: 'pull-request', title: 'Pull Request', summary: localize('voltAutomations.mentionPullRequest', "Open a pull request"), text: 'open a pull request (open_pr)' },
];

const SNIPPET_PREFIX = 'automation-snippet:';
const MENTION_PREFIX = 'automation-tool:';

function snippetItem(snippet: typeof SNIPPETS[number]): IAgentSlashItem {
	return {
		id: `${SNIPPET_PREFIX}${snippet.name}`,
		name: snippet.name,
		type: 'command',
		title: snippet.title,
		description: `${snippet.summary}.\n\n${snippet.text}`,
		summary: snippet.summary,
		icon: 'command',
		sourceLabel: localize('voltAutomations.snippetSource', "Automation snippet"),
		builtin: false,
		canUseAsMode: false,
	};
}

function mentionItem(mention: { readonly name: string; readonly title: string; readonly summary: string }, server?: string): IAgentSlashItem {
	return {
		id: `${MENTION_PREFIX}${server ? `mcp:${server}` : mention.name}`,
		name: mention.name,
		type: 'command',
		title: mention.title,
		description: mention.summary,
		summary: mention.summary,
		icon: server ? 'customize' : 'command',
		sourceLabel: server ? localize('voltAutomations.mcpSource', "MCP server") : localize('voltAutomations.toolSource', "Automation tool"),
		builtin: false,
		canUseAsMode: false,
	};
}

function strokeIcon(className: string, viewBox: string, d: string, width = '1.2'): HTMLElement {
	const element = $(`span.volt-agent-svg-icon.${className}`);
	const document = element.ownerDocument;
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', viewBox);
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', d);
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', width);
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	element.appendChild(svg);
	return element;
}

/** The composer's mic: a filled capsule on a stand. */
function micIcon(): HTMLElement {
	const element = $('span.volt-agent-svg-icon.mic');
	const document = element.ownerDocument;
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const capsule = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
	capsule.setAttribute('x', '9');
	capsule.setAttribute('y', '3');
	capsule.setAttribute('width', '6');
	capsule.setAttribute('height', '11');
	capsule.setAttribute('rx', '3');
	capsule.setAttribute('fill', 'currentColor');
	const stem = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	stem.setAttribute('d', 'M7 11a5 5 0 0 0 10 0M12 16v3M9 19h6');
	stem.setAttribute('stroke', 'currentColor');
	stem.setAttribute('stroke-width', '1.8');
	stem.setAttribute('stroke-linecap', 'round');
	svg.appendChild(capsule);
	svg.appendChild(stem);
	element.appendChild(svg);
	return element;
}

/**
 * Where dictation writes in the textarea: the partial transcript replaces what the last partial
 * wrote, at the caret where dictation started (the textarea twin of AgentDictationText).
 */
class TextareaDictation {

	private start = -1;
	private shown = '';
	private separator = '';

	constructor(private readonly area: HTMLTextAreaElement, private readonly onEdit: () => void) { }

	get writing(): boolean {
		return this.start >= 0;
	}

	write(text: string): void {
		if (text === this.shown) {
			return;
		}
		if (this.start < 0) {
			this.start = this.area.selectionStart;
			const before = this.area.value.slice(0, this.start);
			this.separator = before && !/\s$/.test(before) ? ' ' : '';
		}
		const old = this.shown ? this.separator + this.shown : '';
		const insert = text ? this.separator + text : '';
		this.area.setRangeText(insert, this.start, Math.min(this.area.value.length, this.start + old.length), 'end');
		this.shown = text;
		this.onEdit();
	}

	end(text: string): void {
		this.write(text);
		this.start = -1;
		this.shown = '';
		if (text) {
			this.area.focus();
		}
	}

	textBefore(): string {
		return this.area.value.slice(0, this.start >= 0 ? this.start : this.area.selectionStart);
	}
}

export interface IInstructionsBoxOptions {
	readonly value: string;
	readonly onDidChange: (value: string) => void;
	readonly model: { get(): string | undefined; set(ref: string | undefined): void };
	/** What Add Tool or MCP lists (and which are added already); MCP servers for `@`. */
	readonly tools: () => IToolMenuOptions & { readonly mcp: readonly string[] };
	readonly onAddTool: (pick: ToolPick) => void;
}

type PlusPick =
	| { readonly kind: 'trigger'; readonly char: '/' | '@' }
	| { readonly kind: 'insert'; readonly text: string }
	| { readonly kind: 'voice' }
	| { readonly kind: 'tool'; readonly pick: ToolPick };

/**
 * The Agent Instructions box, built like the chat composer: the text, then a toolbar with +
 * (skills, tools, snippets), the model and the mic (dictation, as in the composer). `/` opens the composer's skills menu, with the automation snippets
 * on top; `@` lists the run's tools. Both menus leave focus in the text.
 */
export class AutomationInstructionsBox extends Disposable {

	readonly element: HTMLElement;
	readonly textarea: HTMLTextAreaElement;
	/** What the `/` menu spans: narrower than the box, so the skill card fits beside it. */
	private readonly menuAnchor: HTMLElement;
	private readonly micButton: HTMLButtonElement;
	private readonly slashMenu: AgentSlashMenu;
	private readonly dictation: AgentVoiceDictation;
	private readonly dictated: TextareaDictation;
	private readonly plusMenu = this._register(new MutableDisposable<IVoltMenuHandle>());
	private readonly modelStore = this._register(new DisposableStore());
	private skills: Promise<readonly IAgentSlashItem[]> | undefined;
	/** The `/` or `@` word being completed: where it starts and which menu. */
	private token: { readonly start: number; readonly char: '/' | '@' } | undefined;
	/** Escape closed the menu for this token; typing on keeps it closed. */
	private dismissedAt = -1;

	constructor(
		parent: HTMLElement,
		private readonly options: IInstructionsBoxOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@INotificationService notifications: INotificationService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
	) {
		super();
		this.element = append(parent, $('.volt-agent-input-box.volt-auto-instructions-box'));
		this.menuAnchor = append(this.element, $('.volt-auto-slash-anchor'));
		this.textarea = append(this.element, $('textarea.volt-auto-instructions-input')) as HTMLTextAreaElement;
		this.textarea.value = options.value;
		this.textarea.placeholder = localize('voltAutomations.instructionsPlaceholderComposer', "Describe what the agent should do. / for skills and commands, @ for tools");
		this.textarea.spellcheck = false;
		this.textarea.setAttribute('aria-label', localize('voltAutomations.instructions', "Agent Instructions"));

		const toolbar = append(this.element, $('.volt-agent-toolbar'));
		const start = append(toolbar, $('.volt-agent-toolbar-start'));
		const plus = append(start, $('button.volt-agent-plus')) as HTMLButtonElement;
		plus.type = 'button';
		plus.appendChild(strokeIcon('plus', '0 0 14 14', 'M7 2.5v9M2.5 7h9'));
		plus.setAttribute('aria-label', localize('voltAutomations.plus', "Add skills, tools and snippets"));
		setAgentTooltip(plus, localize('voltAutomations.plus', "Add skills, tools and snippets"));
		this._register(addDisposableListener(plus, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(plus, 'click', () => this.showPlusMenu(plus)));
		this.renderModel(start);

		const end = append(toolbar, $('.volt-agent-toolbar-end'));
		this.micButton = append(end, $('button.volt-agent-icon-btn.volt-agent-mic-btn')) as HTMLButtonElement;
		this.micButton.type = 'button';
		this.micButton.appendChild(micIcon());
		this.micButton.setAttribute('aria-label', localize('voltAutomations.voice', "Voice"));
		setAgentTooltip(this.micButton, localize('voltAutomations.voice', "Voice"), isMacintosh ? '⌘⇧Space' : 'Ctrl+Shift+Space');
		this._register(addDisposableListener(this.micButton, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(this.micButton, 'click', () => this.toggleDictation()));

		this.slashMenu = this._register(this.instantiationService.createInstance(AgentSlashMenu, {
			anchor: () => this.menuAnchor,
			cursor: () => {
				const page = getDomNodePagePosition(this.textarea);
				return { x: page.left, y: page.top, width: page.width, height: page.height };
			},
			pick: item => this.pick(item),
			onDidHide: () => this.token = undefined,
		}));
		this._register(this.customize.onDidChange(() => this.skills = undefined));

		this.dictation = this._register(this.instantiationService.createInstance(AgentVoiceDictation));
		this.dictated = new TextareaDictation(this.textarea, () => this.edited());
		this.dictation.textBefore = () => this.dictated.textBefore();
		this._register(this.dictation.onDidChange(() => this.syncDictation()));
		this._register(this.dictation.onDidCommit(text => {
			this.dictated.end(text);
			this.syncDictation();
		}));
		this._register(this.dictation.onDidFail(message => notifications.warn(message)));
		this._register(new AgentVoiceVisuals(this.element, this.micButton, this.dictation));

		this._register(addDisposableListener(this.textarea, 'input', () => {
			this.edited();
			this.syncMenu();
		}));
		this._register(addDisposableListener(this.textarea, 'click', () => this.syncMenu()));
		this._register(addDisposableListener(this.textarea, 'focus', () => this.element.classList.add('focused')));
		this._register(addDisposableListener(this.textarea, 'blur', () => {
			this.element.classList.remove('focused');
			if (!this.slashMenu.containsFocus) {
				this.slashMenu.hide();
			}
		}));
		this._register(addDisposableListener(this.textarea, 'keydown', e => this.onKeyDown(e)));
		this._register(addDisposableListener(this.textarea, 'keyup', e => {
			if (e.key === ' ' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift') {
				this.dictation.endHold();
			}
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
				this.syncMenu();
			}
		}));
		this._register(addDisposableListener(this.element, 'mousedown', e => {
			// A press on the box's padding or toolbar gap goes to the text, as in the composer.
			if (e.target === this.element || (e.target as HTMLElement).classList.contains('volt-agent-toolbar')) {
				e.preventDefault();
				this.textarea.focus();
			}
		}));
		getWindow(parent).requestAnimationFrame(() => this.fit());
	}

	focus(): void {
		this.textarea.focus();
	}

	/** The draft changed elsewhere (a template, an agent): show it unless the user is typing. */
	setValue(value: string): void {
		if (value !== this.textarea.value) {
			this.textarea.value = value;
			this.fit();
		}
	}

	private edited(): void {
		this.options.onDidChange(this.textarea.value);
		this.fit();
	}

	private fit(): void {
		const area = this.textarea;
		area.style.height = 'auto';
		area.style.height = `${Math.min(Math.max(area.scrollHeight, 150), 520)}px`;
	}

	//#region Model

	private renderModel(parent: HTMLElement): void {
		const button = append(parent, $('button.volt-agent-model.volt-auto-model-button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'dialog');
		button.setAttribute('aria-label', localize('voltAutomations.model', "Model"));
		// The composer's picker, kept on the draft: Auto leaves the run on the default model.
		const picker = this.modelStore.add(this.instantiationService.createInstance(AgentModelPicker, {
			binding: {
				get: () => this.options.model.get(),
				set: ref => this.options.model.set(ref),
				autoLabel: localize('voltAutomations.auto', "Auto"),
				autoDescription: localize('voltAutomations.autoDesc', "Run on the default model"),
			},
			position: AnchorPosition.ABOVE,
			onDidChange: () => paint(),
		}));
		const paint = () => {
			button.replaceChildren();
			picker.renderTrigger(button);
			button.appendChild(renderIcon(Codicon.chevronDown));
		};
		paint();
		this.modelStore.add(addDisposableListener(button, 'click', () => picker.show(button, () => paint())));
	}

	//#endregion

	//#region Keys

	private onKeyDown(e: KeyboardEvent): void {
		if (this.slashMenu.isVisible && !e.isComposing) {
			switch (e.key) {
				case 'ArrowDown':
				case 'ArrowUp':
					e.preventDefault();
					this.slashMenu.move(e.key === 'ArrowDown' ? 1 : -1);
					return;
				case 'Enter':
				case 'Tab':
					if (!e.shiftKey && this.slashMenu.hasSelection) {
						e.preventDefault();
						this.slashMenu.accept(false);
						return;
					}
					break;
				case 'Escape':
					e.preventDefault();
					e.stopPropagation();
					this.dismissedAt = this.token?.start ?? -1;
					this.slashMenu.hide();
					return;
			}
		}
		if (e.key === 'Escape' && this.dictation.active) {
			e.preventDefault();
			e.stopPropagation();
			this.dictation.cancel();
			return;
		}
		if (e.key === ' ' && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
			e.preventDefault();
			e.stopPropagation();
			this.dictation.beginHold();
		}
	}

	//#endregion

	//#region `/` and `@`

	/** Opens, filters or closes the menu for the word before the caret. */
	private syncMenu(): void {
		const area = this.textarea;
		if (area.selectionStart !== area.selectionEnd) {
			this.slashMenu.hide();
			return;
		}
		const before = area.value.slice(0, area.selectionStart);
		const match = /(^|\s)([/@])([\w.-]*)$/.exec(before);
		if (!match) {
			this.dismissedAt = -1;
			this.slashMenu.hide();
			return;
		}
		const char = match[2] as '/' | '@';
		const start = area.selectionStart - match[3].length - 1;
		if (start === this.dismissedAt) {
			return;
		}
		this.token = { start, char };
		const query = match[3];
		void this.rows(char, query).then(rows => {
			// Typing moved on while the skills loaded.
			if (this.token?.start !== start || this.textarea.value.slice(start, this.textarea.selectionStart) !== `${char}${query}`) {
				return;
			}
			if (rows.length) {
				this.slashMenu.show(rows);
			} else {
				this.slashMenu.hide();
			}
		});
	}

	private async rows(char: '/' | '@', query: string): Promise<IAgentSlashMenuRow[]> {
		if (char === '@') {
			const mcp = this.options.tools().mcp.map(server => mentionItem({ name: server, title: server, summary: localize('voltAutomations.mentionMcp', "Use the {0} MCP server", server) }, server));
			return rankSlashItems([...MENTIONS.map(mention => mentionItem(mention)), ...mcp], query);
		}
		this.skills ??= this.customize.getSlashItems().catch(() => []);
		// The composer's own commands (model, new chat, usage) act on a chat, not on a run.
		const skills = (await this.skills).filter(item => item.type !== 'builtin-command').map(item => item.canUseAsMode ? { ...item, canUseAsMode: false } : item);
		return [...rankSlashItems(SNIPPETS.map(snippetItem), query), ...rankSlashItems(skills, query)];
	}

	private pick(item: IAgentSlashItem): void {
		const token = this.token;
		this.slashMenu.hide();
		if (!token) {
			return;
		}
		let text: string;
		let caretBack = 0;
		let tool: ToolPick | undefined;
		if (item.id.startsWith(SNIPPET_PREFIX)) {
			text = SNIPPETS.find(snippet => snippet.name === item.name)?.text ?? '';
			caretBack = text === '{{payload.}}' ? 2 : 0;
		} else if (item.id.startsWith(MENTION_PREFIX)) {
			const server = item.id.slice(MENTION_PREFIX.length).startsWith('mcp:') ? item.name : undefined;
			const mention = MENTIONS.find(entry => entry.name === item.name);
			text = server ? `the ${server} MCP server` : mention?.text ?? item.title;
			tool = server ? undefined : mention?.kind ? { kind: mention.kind } : undefined;
		} else {
			text = `/${item.name} `;
		}
		this.replace(token.start, text, caretBack);
		if (tool) {
			this.options.onAddTool(tool);
		}
	}

	/** Replaces the token (from `start` to the caret) with `text`, as one edit the user can undo. */
	private replace(start: number, text: string, caretBack = 0): void {
		const area = this.textarea;
		area.focus();
		area.setSelectionRange(start, area.selectionStart);
		// execCommand keeps the native undo stack; setRangeText is the fallback.
		const doc = area.ownerDocument;
		if (!doc.execCommand('insertText', false, text)) {
			area.setRangeText(text, start, area.selectionEnd, 'end');
		}
		if (caretBack) {
			const at = area.selectionStart - caretBack;
			area.setSelectionRange(at, at);
		}
		this.edited();
	}

	/** Types `char` at the caret (with a space before it when needed) and opens its menu. */
	private startToken(char: '/' | '@'): void {
		const area = this.textarea;
		area.focus();
		const before = area.value.slice(0, area.selectionStart);
		this.replace(area.selectionStart, `${before && !/\s$/.test(before) ? ' ' : ''}${char}`);
		this.dismissedAt = -1;
		this.syncMenu();
	}

	//#endregion

	//#region + menu

	private showPlusMenu(anchor: HTMLElement): void {
		const tools = this.options.tools();
		const sections: IVoltMenuSection<PlusPick>[] = [
			{
				id: 'insert',
				items: [
					{ id: 'skill', label: localize('voltAutomations.plusSkill', "Skill or Command"), icon: Codicon.symbolKeyword, keybinding: '/', data: { kind: 'trigger', char: '/' } },
					{ id: 'tool', label: localize('voltAutomations.plusMention', "Mention a Tool"), icon: Codicon.mention, keybinding: '@', data: { kind: 'trigger', char: '@' } },
					{ id: 'voice', label: this.dictation.active ? localize('voltAutomations.plusStopVoice', "Stop Dictation") : localize('voltAutomations.plusVoice', "Dictate"), icon: Codicon.mic, keybinding: isMacintosh ? '⌘⇧Space' : 'Ctrl+Shift+Space', data: { kind: 'voice' } },
				],
			},
			{
				id: 'snippets',
				title: localize('voltAutomations.snippets', "Snippets"),
				items: SNIPPETS.map(snippet => ({ id: `snippet:${snippet.name}`, label: snippet.summary, icon: snippet.name === 'payload' ? Codicon.json : Codicon.note, data: { kind: 'insert' as const, text: snippet.text } })),
			},
			{
				id: 'tools',
				items: [{
					id: 'add-tool',
					label: localize('voltAutomations.addTool', "Add Tool or MCP"),
					icon: Codicon.tools,
					data: { kind: 'trigger', char: '@' },
					submenu: { width: 316, sections: toolMenuSections<PlusPick>(tools, pick => ({ kind: 'tool', pick })) },
				}],
			},
		];
		this.plusMenu.value = showVoltMenu<PlusPick>(this.contextView, {
			anchor,
			gap: 6,
			width: 280,
			className: 'volt-auto-menu',
			ariaLabel: localize('voltAutomations.plus', "Add skills, tools and snippets"),
			search: { placeholder: localize('voltAutomations.plusSearch', "Search skills, tools, snippets...") },
			sections,
			onPick: item => {
				const pick = item.data;
				switch (pick.kind) {
					case 'trigger':
						getWindow(this.element).setTimeout(() => this.startToken(pick.char));
						return;
					case 'insert': {
						const area = this.textarea;
						area.focus();
						const before = area.value.slice(0, area.selectionStart);
						const separator = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
						this.replace(area.selectionStart, `${separator}${pick.text}`, pick.text === '{{payload.}}' ? 2 : 0);
						return;
					}
					case 'voice':
						this.toggleDictation();
						return;
					case 'tool':
						this.options.onAddTool(pick.pick);
						return;
				}
			},
		});
	}

	//#endregion

	//#region Voice

	private toggleDictation(): void {
		this.textarea.focus();
		this.dictation.toggle();
	}

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
			setAgentTooltip(this.micButton, active ? localize('voltAutomations.voiceStop', "Stop dictation") : localize('voltAutomations.voice', "Voice"), isMacintosh ? '⌘⇧Space' : 'Ctrl+Shift+Space');
		}
	}

	//#endregion
}
