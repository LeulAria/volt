/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentEditor.css';
import { $, addDisposableListener, append, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../voltSettings/browser/voltSettingsEditorInput.js';
import { CONTEXT_IN_AGENT_INPUT } from './agentFindWidget.js';
import { OPEN_AGENT_SIDE_PANEL_COMMAND_ID } from './agentEditorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextResourceConfigurationService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentComposerLists } from './agentComposerLists.js';
import { AgentMentionController, IAgentDisplayMention, IAgentMention } from './agentMentions.js';
import { createModeIcon, createStrokeIcon, ModeIconId } from './agentModeIcons.js';
import { AgentModelPicker } from './agentModelPicker.js';
import { setAgentTooltip } from './agentTooltip.js';
import { normalizeVoltMode } from '../../../services/voltRuntime/common/modes.js';

export interface IBrowserComposerCallbacks {
	onSubmit(text: string): void;
	onPrefill(text: string): void;
	onHoverMention?(mention: IAgentMention | undefined): void;
	onRemoveMention?(mention: IAgentMention): void;
	onPlus?(): void;
	onMode?(id: string): void;
	onLayout?(): void;
	onBlur?(): void;
	onStop?(): void;
	onKeepExpanded?(): void;
	dock?: boolean;
}

function createPaperclipIcon(): HTMLElement {
	return createStrokeIcon('paperclip', ['M16 6v9.5a3.5 3.5 0 0 1-7 0V6a2.5 2.5 0 0 1 5 0v9']);
}

function createCubeIcon(): HTMLElement {
	return createStrokeIcon('cube', ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z', 'M12 12l8-4.5M12 12v9M12 12L4 7.5']);
}

function createPlugIcon(): HTMLElement {
	return createStrokeIcon('plug', ['M9 2v4M15 2v4M7 6h10v5a5 5 0 0 1-10 0V6Z', 'M12 16v6']);
}

function createChevronRightIcon(): HTMLElement {
	return createStrokeIcon('chevron-right', ['m9 6 6 6-6 6']);
}

const PLUS_MODES: { id: string; label: string; icon: ModeIconId; description: string }[] = [
	{ id: 'Plan', label: 'Plan', icon: 'plan', description: 'Generate an implementation plan' },
	{ id: 'Debug', label: 'Debug', icon: 'debug', description: 'Pinpoint the root cause of an issue' },
	{ id: 'Multitask', label: 'Multitask', icon: 'multitask', description: 'Orchestrate multiple subagents in parallel' },
	{ id: 'Ask', label: 'Ask', icon: 'ask', description: 'Answer questions without making edits' },
];

function createComposerPlusIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.plus');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 14 14');
	svg.setAttribute('width', '14');
	svg.setAttribute('height', '14');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M7 2.5v9M2.5 7h9');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.2');
	path.setAttribute('stroke-linecap', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createComposerChevronIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.chevron');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 7');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '7');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M8 6.5a.47.47 0 0 1-.35-.15l-4.5-4.5c-.2-.2-.2-.51 0-.71s.51-.2.71 0l4.15 4.15l4.14-4.14c.2-.2.51-.2.71 0s.2.51 0 .71l-4.5 4.5c-.1.1-.23.15-.35.15Z');
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createComposerSendIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.send');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M12 19V5M5 12l7-7 7 7');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '2.4');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createComposerStopIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.stop');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 384 512');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M0 128c0-35.3 28.7-64 64-64h256c35.3 0 64 28.7 64 64v256c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64z');
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

function createComposerMicIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.mic');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const mic = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
	mic.setAttribute('x', '9');
	mic.setAttribute('y', '3');
	mic.setAttribute('width', '6');
	mic.setAttribute('height', '11');
	mic.setAttribute('rx', '3');
	mic.setAttribute('fill', 'currentColor');
	const stem = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	stem.setAttribute('d', 'M7 11a5 5 0 0 0 10 0M12 16v3M9 19h6');
	stem.setAttribute('stroke', 'currentColor');
	stem.setAttribute('stroke-width', '1.8');
	stem.setAttribute('stroke-linecap', 'round');
	svg.appendChild(mic);
	svg.appendChild(stem);
	el.appendChild(svg);
	return el;
}

/**
 * Compact agent follow-up composer. The selected node is an inline mention
 * pill in the Monaco input - same treatment as file chips.
 */
export class BrowserAgentComposer extends Disposable {

	readonly element: HTMLElement;

	private readonly monacoHost: HTMLElement;
	private readonly placeholderEl: HTMLElement;
	private readonly plusButton: HTMLButtonElement | undefined;
	private readonly modeChip: HTMLButtonElement | undefined;
	private readonly modelButton: HTMLButtonElement;
	private placeholderText = '';
	private readonly micButton: HTMLButtonElement;
	private readonly sendButton: HTMLButtonElement;
	private editor: CodeEditorWidget | undefined;
	private model: ITextModel | undefined;
	private mentionController: AgentMentionController | undefined;
	private composerLists: AgentComposerLists | undefined;
	private readonly modelPicker: AgentModelPicker;
	private sendKind: 'mic' | 'send' | 'stop' = 'mic';
	private working = false;
	private currentMode = 'Agent';
	private plusMenuOpen = false;
	private plusMenuEl: HTMLElement | undefined;
	private readonly plusMenuStore = this._register(new DisposableStore());

	constructor(
		private readonly callbacks: IBrowserComposerCallbacks,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ITextResourceConfigurationService private readonly textResourceConfigurationService: ITextResourceConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.volt-agent-input-box.follow-up.volt-browser-agent-composer.empty');
		if (callbacks.dock) {
			this.element.classList.add('dock');
			this.plusButton = append(this.element, $('button.volt-agent-plus.volt-browser-composer-plus')) as HTMLButtonElement;
			this.plusButton.type = 'button';
			setAgentTooltip(this.plusButton, localize('voltAgent.add', "Add"));
			this.plusButton.appendChild(createComposerPlusIcon());
			this._register(addDisposableListener(this.plusButton, 'pointerdown', e => {
				e.preventDefault();
				e.stopPropagation();
				this.ensureEditor();
				if (this.callbacks.onPlus) {
					this.callbacks.onPlus();
					return;
				}
				this.showPlusMenu();
			}));
			this.modeChip = append(this.element, $('button.volt-agent-mode.chip.hidden')) as HTMLButtonElement;
			this.modeChip.type = 'button';
			this._register(addDisposableListener(this.modeChip, 'click', e => {
				if ((e.target as HTMLElement).closest('.volt-agent-mode-close')) {
					e.preventDefault();
					e.stopPropagation();
					this.setComposerMode('Agent');
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.showPlusMenu();
			}));
		}
		this.monacoHost = append(this.element, $('.volt-agent-monaco.show-file-icons'));
		this.placeholderEl = append(this.monacoHost, $('.volt-agent-placeholder'));
		this.placeholderEl.setAttribute('aria-hidden', 'true');
		this.placeholderText = callbacks.dock
			? localize('voltBrowser.kickoffPlaceholder', "Let's kick something off")
			: localize('voltBrowser.promptPlaceholder', "Describe the change");
		this.placeholderEl.textContent = this.placeholderText;

		this.modelButton = append(this.element, $('button.volt-agent-model')) as HTMLButtonElement;
		this.modelButton.type = 'button';
		this.modelPicker = this._register(this.instantiationService.createInstance(AgentModelPicker, {
			onDidChange: () => this.updateModelButton(),
		}));
		this._register(addDisposableListener(this.modelButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.modelPicker.show(this.modelButton, () => this.editor?.focus());
		}));

		const actions = append(this.element, $('.volt-browser-composer-actions'));
		this.micButton = append(actions, $('button.volt-agent-icon-btn.volt-browser-composer-mic')) as HTMLButtonElement;
		this.micButton.type = 'button';
		setAgentTooltip(this.micButton, localize('voltBrowser.voice', "Voice"));
		this.micButton.appendChild(createComposerMicIcon());

		this.sendButton = append(actions, $('button.volt-agent-send')) as HTMLButtonElement;
		this.sendButton.type = 'button';
		this._register(addDisposableListener(this.sendButton, 'click', () => {
			if (this.working) {
				this.callbacks.onStop?.();
				return;
			}
			if (this.value.trim()) {
				this.submit();
			}
		}));

		this.updateModelButton();
		this.syncSend();
	}

	get value(): string {
		return this.model?.getValue() ?? '';
	}

	setSelectionChip(label: string, payload: string): IAgentMention | undefined {
		this.ensureEditor();
		const mention = this.mentionController?.addBrowserMention(label, payload);
		this.syncPlaceholder();
		this.syncSend();
		this.layout();
		this.editor?.focus();
		return mention;
	}

	private hasContent(): boolean {
		return !!this.value.trim() || (this.mentionController?.displayMentions().length ?? 0) > 0;
	}

	getSubmitText(): string {
		return this.mentionController?.serialize() || this.value.trim();
	}

	getDisplayText(): string {
		return this.value;
	}

	getDisplayMentions(): IAgentDisplayMention[] {
		return this.mentionController?.displayMentions() ?? [];
	}

	clear(): void {
		this.mentionController?.clear();
		if (this.model && !this.model.isDisposed()) {
			this.model.setValue('');
		}
		this.syncPlaceholder();
		this.syncSend();
		this.layout();
	}

	setDraft(text: string): void {
		this.ensureEditor();
		if (this.model && !this.model.isDisposed()) {
			this.model.setValue(text);
			const last = this.model.getLineCount();
			const column = this.model.getLineMaxColumn(last);
			this.editor?.setPosition({ lineNumber: last, column });
			this.editor?.revealPosition({ lineNumber: last, column });
		}
		this.syncPlaceholder();
		this.syncSend();
		this.layout();
		this.editor?.focus();
	}

	setPlaceholder(text: string): void {
		this.placeholderText = text;
		this.placeholderEl.textContent = this.placeholderForMode();
	}

	hasDraft(): boolean {
		return this.hasContent();
	}

	setWorking(working: boolean): void {
		if (this.working === working) {
			return;
		}
		this.working = working;
		this.element.classList.toggle('working', working);
		this.syncSend();
	}

	get mode(): string {
		return this.currentMode;
	}

	setMode(id: string): void {
		this.setComposerMode(id);
	}

	private setComposerMode(id: string): void {
		this.currentMode = id;
		this.updateModeChip();
		this.callbacks.onMode?.(id);
		this.placeholderEl.textContent = this.placeholderForMode();
	}

	private placeholderForMode(): string {
		if (this.currentMode === 'Plan') {
			return localize('voltAgent.planPlaceholder', "Plan changes");
		}
		if (this.currentMode === 'Ask') {
			return localize('voltAgent.askPlaceholder', "Ask anything");
		}
		if (this.currentMode === 'Debug') {
			return localize('voltAgent.debugPlaceholder', "Describe the issue");
		}
		if (this.currentMode === 'Multitask') {
			return localize('voltAgent.multitaskPlaceholder', "Describe the work to split up");
		}
		return this.placeholderText;
	}

	private updateModeChip(): void {
		if (!this.modeChip) {
			return;
		}
		const option = PLUS_MODES.find(item => item.id === this.currentMode);
		const chip = !!option;
		this.modeChip.classList.toggle('hidden', !chip);
		this.element.dataset.mode = normalizeVoltMode(this.currentMode);
		this.modeChip.replaceChildren();
		if (!option) {
			return;
		}
		this.modeChip.appendChild(createModeIcon(option.icon));
		append(this.modeChip, $('span.volt-agent-mode-label')).textContent = option.label;
		const close = append(this.modeChip, $('button.volt-agent-mode-close')) as HTMLButtonElement;
		setAgentTooltip(close, localize('voltAgent.clearMode', "Back to Agent"));
		close.appendChild(renderIcon(Codicon.close));
	}

	hidePlusMenu(): void {
		this.plusMenuStore.clear();
		this.plusMenuEl?.remove();
		this.plusMenuEl = undefined;
		this.plusMenuOpen = false;
		this.element.classList.remove('plus-open');
		this.layout();
	}

	isPlusMenuOpen(): boolean {
		return this.plusMenuOpen;
	}

	focus(): void {
		this.ensureEditor();
		this.editor?.focus();
	}

	layout(): void {
		if (!this.editor) {
			return;
		}
		const measure = () => {
			if (!this.editor) {
				return;
			}
			const multiline = (this.model?.getLineCount() ?? 1) > 1;
			this.element.classList.toggle('multiline', multiline);
			const contentHeight = this.callbacks.dock && !multiline
				? 22
				: Math.min(Math.max(this.editor.getContentHeight(), 22), 120);
			this.monacoHost.style.height = `${contentHeight}px`;
			this.editor.layout({ width: Math.max(this.monacoHost.clientWidth, 0), height: contentHeight });
			this.callbacks.onLayout?.();
		};
		measure();
		getWindow(this.element).requestAnimationFrame(measure);
	}

	override dispose(): void {
		if (this.model && !this.model.isDisposed()) {
			this.model.dispose();
		}
		super.dispose();
	}

	private showPlusMenu(): void {
		if (this.plusMenuOpen) {
			this.hidePlusMenu();
			return;
		}
		this.callbacks.onKeepExpanded?.();
		this.plusMenuStore.clear();
		this.plusMenuEl?.remove();
		this.plusMenuOpen = true;
		this.element.classList.add('plus-open');
		const menu = $('.volt-agent-plus-menu.volt-browser-plus-menu');
		this.plusMenuEl = menu;
		this.element.insertBefore(menu, this.element.firstChild);
		const search = append(menu, $('input.volt-agent-plus-search')) as HTMLInputElement;
		search.type = 'text';
		search.placeholder = localize('voltAgent.plusSearch', "Search skills, context, chats...");
		const list = append(menu, $('.volt-agent-plus-list'));
		const itemsStore = this.plusMenuStore.add(new DisposableStore());

		const renderItems = (query: string) => {
			itemsStore.clear();
			list.replaceChildren();
			const q = query.trim().toLowerCase();
			const modes = PLUS_MODES.filter(option =>
				!q
				|| option.label.toLowerCase().includes(q)
				|| option.description.toLowerCase().includes(q)
			);
			for (const option of modes) {
				const item = append(list, $('button.volt-agent-plus-chip.plus-mode')) as HTMLButtonElement;
				if (option.id === this.currentMode) {
					item.classList.add('active');
				}
				item.appendChild(createModeIcon(option.icon));
				append(item, $('span.label')).textContent = option.label;
				setAgentTooltip(item, option.description);
				itemsStore.add(addDisposableListener(item, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.setComposerMode(option.id);
					this.hidePlusMenu();
					this.editor?.focus();
				}));
			}
			const actions = ([
				{ id: 'files' as const, label: localize('voltAgent.plusFiles', "Files"), keys: ['files', 'file', 'attach'] },
				{ id: 'model' as const, label: localize('voltAgent.plusModel', "Model"), keys: ['model'] },
				{ id: 'mcp' as const, label: localize('voltAgent.plusMcp', "MCP"), keys: ['mcp'] },
			]).filter(action =>
				!q
				|| action.label.toLowerCase().includes(q)
				|| action.keys.some(key => key.includes(q) || q.includes(key))
			);
			if (modes.length && actions.length) {
				append(list, $('.volt-agent-dropdown-sep'));
			}
			for (const action of actions) {
				const item = append(list, $('button.volt-agent-plus-chip.plus-action')) as HTMLButtonElement;
				item.appendChild(action.id === 'files'
					? createPaperclipIcon()
					: action.id === 'model'
						? createCubeIcon()
						: createPlugIcon());
				append(item, $('span.label')).textContent = action.label;
				if (action.id === 'model') {
					const selected = this.modelPicker.selectedModel();
					const name = this.modelPicker.modelAuto
						? localize('voltAgent.auto', "Auto")
						: selected
							? selected.name
							: '';
					if (name) {
						append(item, $('span.desc')).textContent = name;
					}
				}
				if (action.id === 'mcp') {
					append(item, createChevronRightIcon());
				}
				itemsStore.add(addDisposableListener(item, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.hidePlusMenu();
					if (action.id === 'files') {
						this.mentionController?.openFilePicker();
						this.editor?.focus();
						return;
					}
					if (action.id === 'model') {
						scheduleAtNextAnimationFrame(getWindow(this.modelButton), () => this.modelPicker.show(this.modelButton, () => this.editor?.focus()));
						return;
					}
					void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
				}));
			}
		};

		renderItems('');
		this.plusMenuStore.add(addDisposableListener(search, 'input', () => renderItems(search.value)));
		this.plusMenuStore.add(addDisposableListener(getWindow(menu).document, 'mousedown', e => {
			if (!(e.target instanceof Node)) {
				return;
			}
			if (menu.contains(e.target) || this.plusButton?.contains(e.target) || this.modeChip?.contains(e.target)) {
				return;
			}
			this.hidePlusMenu();
		}, true));
		this.plusMenuStore.add(addDisposableListener(getWindow(menu), 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				this.hidePlusMenu();
				this.editor?.focus();
			}
		}));
		this.plusMenuStore.add(toDisposable(() => {
			menu.remove();
			this.element.classList.remove('plus-open');
			if (this.plusMenuEl === menu) {
				this.plusMenuEl = undefined;
				this.plusMenuOpen = false;
			}
		}));
		this.layout();
		scheduleAtNextAnimationFrame(getWindow(menu), () => search.focus());
	}

	private submit(): void {
		const text = this.getSubmitText();
		if (!text) {
			return;
		}
		this.callbacks.onSubmit(text);
		this.clear();
	}

	private ensureEditor(): void {
		if (this.editor) {
			return;
		}
		const modelUri = URI.from({ scheme: 'volt-agent-input', path: `browser-${Date.now()}` });
		this.model = this._register(this.modelService.createModel('', null, modelUri, true));
		this.editor = this._register(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.monacoHost,
			this.getEditorOptions(),
			{ contextKeyValues: { [CONTEXT_IN_AGENT_INPUT.key]: true } }
		));
		this.editor.setModel(this.model);
		this.mentionController = this._register(this.instantiationService.createInstance(AgentMentionController, this.editor));
		this.composerLists = this._register(new AgentComposerLists(this.editor));
		this.mentionController.onDidHoverMention = mention => this.callbacks.onHoverMention?.(mention);
		this.mentionController.onDidRemoveMention = mention => this.callbacks.onRemoveMention?.(mention);
		this.mentionController.bindDropTarget(this.element);
		this._register(this.editor.onDidFocusEditorText(() => this.element.classList.add('focused')));
		this._register(this.editor.onDidBlurEditorText(() => {
			this.element.classList.remove('focused');
			this.callbacks.onBlur?.();
		}));
		this._register(this.editor.onDidChangeModelContent(() => {
			this.syncPlaceholder();
			this.syncSend();
			this.layout();
		}));
		this._register(this.editor.onDidContentSizeChange(e => {
			if (e.contentHeightChanged) {
				this.layout();
			}
		}));
		this._register(this.editor.onKeyDown(e => {
			if (e.keyCode === KeyCode.Enter && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && this.composerLists?.tryHandleEnter()) {
				e.preventDefault();
				e.stopPropagation();
				this.layout();
				return;
			}
			if (e.keyCode === KeyCode.Enter && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();
				this.submit();
				return;
			}
			if (e.keyCode === KeyCode.KeyL && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				void this.commandService.executeCommand(OPEN_AGENT_SIDE_PANEL_COMMAND_ID);
			}
		}));
		this.syncPlaceholder();
		this.syncSend();
	}

	private syncPlaceholder(): void {
		this.placeholderEl.classList.toggle('hidden', this.hasContent());
	}

	/** Empty composer stays a single-line pill; a mention or typed text reveals model + send. */
	private syncSend(): void {
		const hasContent = this.hasContent();
		this.element.classList.toggle('empty', !hasContent && !this.working);
		this.element.classList.toggle('has-content', hasContent || this.working);
		const kind: 'mic' | 'send' | 'stop' = this.working ? 'stop' : hasContent ? 'send' : 'mic';
		if (this.sendKind === kind && this.sendButton.childElementCount) {
			return;
		}
		this.sendKind = kind;
		this.sendButton.replaceChildren();
		this.sendButton.classList.toggle('stop', kind === 'stop');
		setAgentTooltip(this.sendButton, kind === 'stop'
			? localize('voltBrowser.stop', "Stop")
			: kind === 'send'
				? localize('voltBrowser.send', "Send to chat")
				: localize('voltBrowser.voice', "Voice"));
		this.sendButton.appendChild(kind === 'stop'
			? createComposerStopIcon()
			: kind === 'send'
				? createComposerSendIcon()
				: createComposerMicIcon());
	}

	private updateModelButton(): void {
		this.modelButton.replaceChildren();
		const selected = this.modelPicker.selectedModel();
		const label = append(this.modelButton, $('span.volt-agent-model-label'));
		if (this.modelPicker.modelAuto) {
			label.textContent = localize('voltAgent.auto', "Auto");
		} else if (selected) {
			label.textContent = this.modelPicker.modelOptionsLabel(selected) || selected.name;
		} else {
			label.textContent = localize('voltAgent.connectModel', "Connect a model");
		}
		this.modelButton.appendChild(createComposerChevronIcon());
	}

	private getEditorOptions(): ICodeEditorOptions {
		const editorConfiguration = this.textResourceConfigurationService.getValue<ICodeEditorOptions>(this.model?.uri, 'editor');
		return {
			...editorConfiguration,
			fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif',
			fontSize: 14,
			fontWeight: '300',
			lineHeight: 22,
			padding: { top: 0, bottom: 0 },
			wordWrap: 'on',
			cursorStyle: 'line',
			cursorWidth: 1,
			renderLineHighlight: 'none',
			renderLineHighlightOnlyWhenFocus: false,
			guides: {
				indentation: false,
				highlightActiveIndentation: false,
				bracketPairs: false,
				bracketPairsHorizontal: false,
			},
			lineNumbers: 'off',
			lineNumbersMinChars: 1,
			lineDecorationsWidth: 0,
			glyphMargin: false,
			folding: false,
			overviewRulerLanes: 0,
			fixedOverflowWidgets: true,
			automaticLayout: false,
			dropIntoEditor: { enabled: true },
			scrollBeyondLastLine: false,
			acceptSuggestionOnEnter: 'off',
			quickSuggestions: { other: 'off', comments: 'off', strings: 'off' },
			suggestOnTriggerCharacters: false,
			ariaLabel: localize('voltBrowser.inputAria', "Browser selection input"),
			scrollbar: {
				vertical: 'auto',
				horizontal: 'hidden',
				verticalScrollbarSize: 10,
				useShadows: false,
				alwaysConsumeMouseWheel: false,
				handleMouseWheel: true,
			},
			minimap: { enabled: false },
			stickyScroll: { enabled: false },
			editContext: false,
		};
	}
}
