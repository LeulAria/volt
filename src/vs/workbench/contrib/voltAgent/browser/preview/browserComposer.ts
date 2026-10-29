/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentEditor.css';
import { $, addDisposableListener, append, getWindow, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { CONTEXT_IN_AGENT_INPUT } from '../editor/agentFindWidget.js';
import { OPEN_AGENT_SIDE_PANEL_COMMAND_ID } from '../editor/agentEditorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DropIntoEditorController } from '../../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorController.js';
import { getSimpleCodeEditorWidgetOptions } from '../../../codeEditor/browser/simpleEditorOptions.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextResourceConfigurationService } from '../../../../../editor/common/services/textResourceConfiguration.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentComposerLists } from '../composer/agentComposerLists.js';
import { AgentMentionController, IAgentDisplayMention, IAgentMention } from '../composer/agentMentions.js';
import { AgentPlusMenuAction, showAgentPlusMenu } from '../composer/agentPlusMenu.js';
import { AgentVoiceDictation } from '../composer/agentVoiceDictation.js';
import { AgentVoiceVisuals } from '../composer/agentVoiceVisuals.js';
import { AgentDictationText } from '../composer/agentDictationText.js';
import { VIDEO_EXTENSIONS } from '../composer/agentVideoAttachments.js';
import { IVoltMenuHandle } from '../ui/menu/voltMenu.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { createModeIcon, ModeIconId } from '../chrome/agentModeIcons.js';
import { AgentModelPicker } from '../picker/agentModelPicker.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { normalizeVoltMode } from '../../../../services/voltRuntime/common/modes.js';
import { VOLT_FONT_FAMILY } from '../../common/agentTypography.js';

export interface IBrowserComposerCallbacks {
	onSubmit(text: string): void;
	onPrefill(text: string): void;
	/** Pin the draft as its own comment. Does not send or clear other comments. */
	onComment?(): void;
	onHoverMention?(mention: IAgentMention | undefined): void;
	onRemoveMention?(mention: IAgentMention): void;
	onPlus?(): void;
	onMode?(id: string): void;
	onLayout?(): void;
	onBlur?(): void;
	onStop?(): void;
	onKeepExpanded?(): void;
	/** Escape in the text; true when it was used (a queued message being edited is put back). */
	onEscape?(): boolean;
	dock?: boolean;
	/**
	 * The chat's model (the design prompt): the model chip shows it until the user picks another for
	 * this draft, which then stays local to the prompt (it does not change the chat's or the app's model).
	 */
	chatModel?(): string | undefined;
	/**
	 * The design prompt's "Batch edits" switch: on, Send adds the annotation to the batch (sent later
	 * from the toolbar); off, it goes to the chat at once.
	 */
	batch?: { get(): boolean; set(on: boolean): void };
	/** Images and videos can be attached (+ menu, paste, drop): thumbnails above the text. On unless false. */
	images?: boolean;
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
	path.setAttribute('d', 'm19.03 9.47l-6.145-6.145a1.26 1.26 0 0 0-1.77 0L4.97 9.47l1.06 1.06l5.22-5.22V21h1.5V5.31l5.22 5.22z');
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.3');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

/** Send while "Batch edits" is on: the annotation is added to the batch, not sent. Same weight as the arrow. */
function createComposerAddIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.send.add');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '24');
	svg.setAttribute('height', '24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M11.25 4h1.5v7.25H20v1.5h-7.25V20h-1.5v-7.25H4v-1.5h7.25z');
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.3');
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
	private readonly plusButton: HTMLButtonElement;
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
	private sendKind: 'mic' | 'send' | 'stop' | undefined = 'mic';
	private syncBatch: (() => void) | undefined;
	private working = false;
	/** Something rides along without text (the browser tab's comments): Send works on an empty box. */
	private extraContent = false;
	/** Something waits on Send even while the agent works (the queue's picked multitasks): Send, not Stop. */
	private pendingSend = false;
	private currentMode = 'Agent';
	private plusMenu: IVoltMenuHandle | undefined;
	/** The model picked in this draft's chip; undefined follows the chat's model. */
	private pickedRef: string | undefined;
	/** Voice, as in the chat's composer: the transcript is written where the cursor was. */
	private readonly dictation: AgentVoiceDictation;
	private readonly dictatedText = new AgentDictationText(() => this.editor);

	constructor(
		private readonly callbacks: IBrowserComposerCallbacks,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IModelService private readonly modelService: IModelService,
		@ITextResourceConfigurationService private readonly textResourceConfigurationService: ITextResourceConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		this.element = $('.volt-agent-input-box.follow-up.volt-browser-agent-composer.empty');
		// "+" before the model, as in the chat's composer: modes (the dock), files, images, videos.
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
		if (callbacks.dock) {
			this.element.classList.add('dock');
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
		const chatModel = callbacks.chatModel;
		this.modelPicker = this._register(this.instantiationService.createInstance(AgentModelPicker, {
			onDidChange: () => this.updateModelButton(),
			...(chatModel ? {
				binding: {
					get: () => this.pickedRef ?? chatModel(),
					set: (ref: string | undefined) => { this.pickedRef = ref; },
					autoLabel: localize('voltBrowser.modelAuto', "Auto"),
					autoDescription: localize('voltBrowser.modelAutoDesc', "Follow the chat's model."),
				},
			} : {}),
		}));
		this._register(addDisposableListener(this.modelButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.modelPicker.show(this.modelButton, () => this.editor?.focus());
		}));

		const actions = append(this.element, $('.volt-browser-composer-actions'));
		this.micButton = append(actions, $('button.volt-agent-icon-btn.volt-agent-mic-btn.volt-browser-composer-mic')) as HTMLButtonElement;
		this.micButton.type = 'button';
		setAgentTooltip(this.micButton, localize('voltBrowser.voice', "Voice"));
		this.micButton.appendChild(createComposerMicIcon());
		this._register(addDisposableListener(this.micButton, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(this.micButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.toggleDictation();
		}));
		this.dictation = this._register(this.instantiationService.createInstance(AgentVoiceDictation));
		this.dictation.textBefore = () => this.dictatedText.textBefore();
		this._register(this.dictation.onDidChange(() => this.syncDictation()));
		this._register(this.dictation.onDidCommit(text => {
			this.dictatedText.end(text);
			this.syncDictation();
		}));
		this._register(this.dictation.onDidFail(message => notificationService.warn(message)));
		this._register(new AgentVoiceVisuals(this.element, this.micButton, this.dictation));

		if (!callbacks.dock && callbacks.batch) {
			const batch = callbacks.batch;
			const toggle = append(this.element, $('button.volt-browser-composer-batch')) as HTMLButtonElement;
			toggle.type = 'button';
			toggle.setAttribute('role', 'switch');
			append(toggle, $('span.label')).textContent = localize('voltBrowser.batchEdits', "Batch edits");
			append(toggle, $('span.switch')).appendChild($('span.thumb'));
			setAgentTooltip(toggle, localize('voltBrowser.batchEditsHint', "Collect annotations and send them together from the toolbar"));
			const sync = () => {
				const on = batch.get();
				toggle.classList.toggle('on', on);
				toggle.setAttribute('aria-checked', String(on));
				this.element.classList.toggle('batching', on);
				this.sendKind = undefined;
				this.syncSend();
			};
			this.syncBatch = sync;
			this._register(addDisposableListener(toggle, 'mousedown', e => e.preventDefault()));
			this._register(addDisposableListener(toggle, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				batch.set(!batch.get());
				sync();
			}));
		}

		this.sendButton = append(actions, $('button.volt-agent-send')) as HTMLButtonElement;
		this.sendButton.type = 'button';
		// Keep the text focused: a blur here reflows the box under the pointer and the click misses.
		this._register(addDisposableListener(this.sendButton, 'mousedown', e => e.preventDefault()));
		this._register(addDisposableListener(this.sendButton, 'click', () => {
			if (this.working && !this.pendingSend) {
				this.callbacks.onStop?.();
				return;
			}
			if (this.sendKind === 'mic') {
				this.toggleDictation();
				return;
			}
			if (this.value.trim() || this.extraContent || this.pendingSend) {
				this.submit();
			}
		}));
		// The text line is only 22px of the box: a click on the rest of it focuses the input too.
		const blankSurfaces = new Set<EventTarget>([this.element, this.monacoHost, this.placeholderEl, actions]);
		this._register(addDisposableListener(this.element, 'mousedown', e => {
			if (e.button === 0 && e.target && blankSurfaces.has(e.target)) {
				e.preventDefault();
				this.focus();
			}
		}));

		this.updateModelButton();
		this.syncSend();
		this.syncBatch?.();
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
		this.revealCursor();
		return mention;
	}

	/**
	 * Scrolls the chip just added (it goes in at the cursor) into view. Past five lines the box
	 * scrolls inside itself, and layout settles its height a frame later, so reveal again then.
	 */
	private revealCursor(): void {
		const reveal = () => {
			const position = this.editor?.getPosition();
			if (position) {
				this.editor?.revealPosition(position);
			}
		};
		reveal();
		getWindow(this.element).requestAnimationFrame(() => getWindow(this.element).requestAnimationFrame(reveal));
	}

	/** A saved draft's images, videos and files, back in the box. */
	addMedia(mentions: readonly IAgentDisplayMention[]): void {
		this.ensureEditor();
		this.mentionController?.addMediaMentions(mentions);
		this.syncPlaceholder();
		this.syncSend();
		this.layout();
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
		this.resetModel();
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

	/** Replaces the draft: its text and chips (a queued message loaded for editing, or the draft it stood in for). */
	setContent(text: string, mentions: readonly IAgentDisplayMention[] | undefined): void {
		this.ensureEditor();
		this.mentionController?.clear();
		this.setDraft(text);
		if (mentions?.length) {
			this.mentionController?.restoreMentions(mentions);
			this.syncPlaceholder();
			this.syncSend();
			this.layout();
		}
	}

	appendPlainText(text: string): void {
		const extra = text.trim();
		if (!extra) {
			return;
		}
		this.ensureEditor();
		const model = this.model;
		if (!model || model.isDisposed()) {
			return;
		}
		const endLine = model.getLineCount();
		const endColumn = model.getLineMaxColumn(endLine);
		const prefix = model.getValue().length ? ' ' : '';
		model.applyEdits([{
			range: { startLineNumber: endLine, startColumn: endColumn, endLineNumber: endLine, endColumn },
			text: `${prefix}${extra}`,
		}]);
		const last = model.getLineCount();
		const column = model.getLineMaxColumn(last);
		this.editor?.setPosition({ lineNumber: last, column });
		this.syncPlaceholder();
		this.syncSend();
		this.layout();
	}

	/**
	 * The model picked in this draft's chip when it is not the chat's own (send it to a subagent on
	 * that model); undefined when the chip shows the chat's model.
	 */
	pickedModel(): { readonly ref: string; readonly label: string } | undefined {
		const ref = this.pickedRef;
		if (!ref || ref === this.callbacks.chatModel?.()) {
			return undefined;
		}
		const option = this.modelPicker.catalog.find(item => item.ref === ref);
		return { ref, label: option?.name ?? ref };
	}

	/** The chip follows the chat's model again (a new draft, or the chat changed its model). */
	resetModel(): void {
		if (!this.callbacks.chatModel) {
			return;
		}
		this.pickedRef = undefined;
		this.modelPicker.syncCatalog();
		this.updateModelButton();
	}

	/** "+" > Image / Video / File...: pick files from disk and attach them at the cursor, as the chat's composer does. */
	private async pickMedia(kind: 'image' | 'video' | 'attachFile'): Promise<void> {
		const resources = await this.fileDialogService.showOpenDialog({
			title: kind === 'video' ? localize('voltAgent.pickVideosTitle', "Attach Videos")
				: kind === 'image' ? localize('voltAgent.pickImagesTitle', "Attach Images")
					: localize('voltAgent.pickFilesTitle', "Attach Files"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			defaultUri: await this.fileDialogService.defaultFilePath(),
			filters: kind === 'video'
				? [{ name: localize('voltAgent.videoFilter', "Videos"), extensions: [...VIDEO_EXTENSIONS] }]
				: kind === 'image'
					// HEIC photos are converted to JPEG on the way in.
					? [{ name: localize('voltAgent.imageFilter', "Images"), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'] }]
					: undefined,
		});
		if (!resources?.length) {
			return;
		}
		this.ensureEditor();
		await this.mentionController?.addAttachmentFiles(resources);
		this.editor?.focus();
	}

	setPlaceholder(text: string): void {
		this.placeholderText = text;
		this.placeholderEl.textContent = this.placeholderForMode();
	}

	setExtraContent(on: boolean): void {
		if (this.extraContent !== on) {
			this.extraContent = on;
			this.syncSend();
		}
	}

	/** On, Send is ready with an empty box and wins over Stop while the agent works. */
	setPendingSend(on: boolean): void {
		if (this.pendingSend !== on) {
			this.pendingSend = on;
			this.syncSend();
		}
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
		this.plusMenu?.dispose();
		this.plusMenu = undefined;
	}

	isPlusMenuOpen(): boolean {
		return !!this.plusMenu;
	}

	focus(): void {
		this.ensureEditor();
		this.editor?.focus();
	}

	blur(): void {
		const active = getWindow(this.element).document.activeElement;
		if (isHTMLElement(active) && this.element.contains(active)) {
			active.blur();
		}
	}

	hasFocus(): boolean {
		return !!this.editor?.hasTextFocus();
	}

	layout(): void {
		if (!this.editor) {
			return;
		}
		const measure = () => {
			if (!this.editor) {
				return;
			}
			// The dock's one-line bar opens into rows when images ride along (thumbnails above the text).
			const multiline = (this.model?.getLineCount() ?? 1) > 1 || (!!this.callbacks.dock && !!this.mentionController?.hasMedia);
			this.element.classList.toggle('multiline', multiline);
			// The design prompt grows to five lines, then scrolls inside itself.
			const contentHeight = this.callbacks.dock && !multiline
				? 22
				: Math.min(Math.max(this.editor.getContentHeight(), 22), this.callbacks.dock ? 120 : 5 * 22);
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
		if (this.plusMenu) {
			this.hidePlusMenu();
			return;
		}
		this.callbacks.onKeepExpanded?.();
		const selected = this.modelPicker.selectedModel();
		const actions: AgentPlusMenuAction[] = this.callbacks.images === false ? ['files', 'model', 'mcp'] : ['files', 'attachFile', 'image', 'video', 'model', 'mcp'];
		const handle: IVoltMenuHandle = showAgentPlusMenu(this.contextViewService, {
			anchor: this.element,
			// A comment's prompt has no modes: it is a note for the agent, not a run.
			modes: this.callbacks.dock ? PLUS_MODES : [],
			currentMode: this.currentMode,
			actions,
			modelName: this.modelPicker.modelAuto ? localize('voltAgent.auto', "Auto") : selected?.name,
			onMode: id => {
				this.setComposerMode(id);
				this.editor?.focus();
			},
			onAction: action => {
				if (action === 'files') {
					this.mentionController?.openFilePicker();
					this.editor?.focus();
				} else if (action === 'image' || action === 'video' || action === 'attachFile') {
					void this.pickMedia(action);
				} else if (action === 'model') {
					scheduleAtNextAnimationFrame(getWindow(this.modelButton), () => this.modelPicker.show(this.modelButton, () => this.editor?.focus()));
				} else {
					void this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
				}
			},
			onHide: () => {
				if (this.plusMenu === handle) {
					this.plusMenu = undefined;
				}
			},
		});
		this.plusMenu = handle;
	}

	private submit(): void {
		const text = this.getSubmitText();
		if (!text && !this.extraContent && !this.pendingSend) {
			return;
		}
		this.callbacks.onSubmit(text);
		this.clear();
	}

	private ensureEditor(): void {
		if (this.editor) {
			return;
		}
		const modelUri = URI.from({ scheme: 'volt-agent-input', path: `browser-${generateUuid()}` });
		this.model = this._register(this.modelService.createModel('', null, modelUri, true));
		// The chat composer's editor: Monaco's own paste and drop handlers would type an image's name.
		const widgetOptions = getSimpleCodeEditorWidgetOptions();
		widgetOptions.contextKeyValues = { [CONTEXT_IN_AGENT_INPUT.key]: true };
		widgetOptions.contributions = [
			...(widgetOptions.contributions ?? []),
			...EditorExtensionsRegistry.getSomeEditorContributions([DropIntoEditorController.ID]),
		];
		this.editor = this._register(this.instantiationService.createInstance(
			CodeEditorWidget,
			this.monacoHost,
			this.getEditorOptions(),
			widgetOptions
		));
		this.editor.setModel(this.model);
		this.mentionController = this._register(this.instantiationService.createInstance(AgentMentionController, this.editor));
		this.composerLists = this._register(new AgentComposerLists(this.editor));
		this.mentionController.onDidHoverMention = mention => this.callbacks.onHoverMention?.(mention);
		this.mentionController.onDidRemoveMention = mention => this.callbacks.onRemoveMention?.(mention);
		this.mentionController.bindDropTarget(this.element);
		this.mentionController.setHost({ anchor: this.element });
		if (this.callbacks.images !== false) {
			this.mentionController.bindImageStrip(this.element, this.monacoHost);
			this._register(this.mentionController.onDidChangeMedia(() => {
				this.element.classList.toggle('has-media', !!this.mentionController?.hasMedia);
				this.syncPlaceholder();
				this.syncSend();
				this.layout();
			}));
		}
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
		this._register(this.editor.onKeyUp(e => {
			if (e.keyCode === KeyCode.Space || e.keyCode === KeyCode.Meta || e.keyCode === KeyCode.Ctrl || e.keyCode === KeyCode.Shift) {
				this.dictation.endHold();
			}
		}));
		this._register(this.editor.onKeyDown(e => {
			// The @ panel already used this key.
			if (e.browserEvent.defaultPrevented) {
				return;
			}
			if (e.keyCode === KeyCode.Escape && this.dictation.active) {
				e.preventDefault();
				e.stopPropagation();
				this.dictation.cancel();
				return;
			}
			if (e.keyCode === KeyCode.Escape && this.callbacks.onEscape?.()) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.keyCode === KeyCode.Space && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				this.dictation.beginHold();
				return;
			}
			if (e.keyCode === KeyCode.Enter && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && this.composerLists?.tryHandleEnter()) {
				e.preventDefault();
				e.stopPropagation();
				this.layout();
				return;
			}
			if (e.keyCode === KeyCode.Enter && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();
				if (this.callbacks.onComment) {
					if (!this.mentionController?.isMenuOpen) {
						this.callbacks.onComment();
					}
					return;
				}
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

	private toggleDictation(): void {
		this.ensureEditor();
		this.editor?.focus();
		this.dictation.toggle();
	}

	private syncDictation(): void {
		const active = this.dictation.active;
		if (active) {
			this.dictatedText.write(this.dictation.partial);
		} else if (this.dictatedText.writing) {
			// Cancelled or failed: take the partial transcript back out.
			this.dictatedText.end('');
		}
		if (this.micButton.classList.contains('recording') !== active) {
			this.micButton.classList.toggle('recording', active);
			setAgentTooltip(this.micButton, active ? localize('voltAgent.voiceStop', "Stop dictation") : localize('voltBrowser.voice', "Voice"));
			this.syncPlaceholder();
			this.syncSend();
			this.layout();
		}
	}

	private syncPlaceholder(): void {
		this.placeholderEl.classList.toggle('hidden', this.hasContent());
	}

	/** Empty composer stays a single-line pill; a mention or typed text reveals model + send. */
	private syncSend(): void {
		const hasContent = this.hasContent() || this.extraContent || this.pendingSend || this.dictation?.active || !!this.mentionController?.hasMedia;
		this.element.classList.toggle('empty', !hasContent && !this.working);
		this.element.classList.toggle('has-content', hasContent || this.working);
		const kind: 'mic' | 'send' | 'stop' = this.pendingSend ? 'send' : this.working ? 'stop' : hasContent ? 'send' : 'mic';
		if (this.sendKind === kind && this.sendButton.childElementCount) {
			return;
		}
		this.sendKind = kind;
		this.sendButton.replaceChildren();
		this.sendButton.classList.toggle('stop', kind === 'stop');
		setAgentTooltip(this.sendButton, kind === 'stop'
			? localize('voltBrowser.stop', "Stop")
			: kind === 'send'
				? (this.callbacks.batch?.get() ? localize('voltBrowser.addToBatch', "Add to batch") : localize('voltBrowser.send', "Send to chat"))
				: localize('voltBrowser.voice', "Voice"));
		this.sendButton.appendChild(kind === 'stop'
			? createComposerStopIcon()
			: kind === 'send'
				? (this.callbacks.batch?.get() ? createComposerAddIcon() : createComposerSendIcon())
				: createComposerMicIcon());
	}

	private updateModelButton(): void {
		this.modelButton.replaceChildren();
		this.modelPicker.renderTrigger(this.modelButton);
		this.modelButton.appendChild(createComposerChevronIcon());
	}

	private getEditorOptions(): ICodeEditorOptions {
		const editorConfiguration = this.textResourceConfigurationService.getValue<ICodeEditorOptions>(this.model?.uri, 'editor');
		return {
			...editorConfiguration,
			fontFamily: VOLT_FONT_FAMILY,
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
