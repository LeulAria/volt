/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentQuestionTray.css';
import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { formatAttachmentSize } from '../../../../services/voltRuntime/common/fileAttachments.js';
import type { IAgentQuestion, IAgentQuestionAnswer, IAgentQuestionRequest, IAgentQuestionResponse } from '../../../../services/voltRuntime/common/questions.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import type { IAgentPreparedAttachment } from './agentAttachmentStore.js';

/** Saves what the user attaches to an answer (the composer's attachment store). */
export interface IAgentQuestionTrayAttachmentHost {
	pickFiles(): Promise<readonly URI[] | undefined>;
	prepare(source: File | URI): Promise<IAgentPreparedAttachment | undefined>;
}

export interface IAgentQuestionTrayOptions {
	/**
	 * The editor adds the composer text as the response's note and clears it. `media`: the
	 * images attached to answers, sent as images if the answers go out as the next prompt.
	 */
	onSubmit(requestId: string, response: IAgentQuestionResponse, media: readonly IAgentPreparedAttachment[]): void;
	/** The tray changed height; the composer relayouts. */
	onLayout(): void;
	/** Without it, answers take no attachments. */
	readonly attachments?: IAgentQuestionTrayAttachmentHost;
}

interface IDraftAnswer {
	readonly selected: Set<string>;
	other: string;
	/** The "Other..." row is an input right now. */
	editingOther: boolean;
	/** Files attached to this question's answer; each question keeps its own. */
	readonly attachments: IAgentPreparedAttachment[];
}

/** Letter badges A, B, C…; past Z the rows count on (AA is never needed in practice). */
function badgeLetter(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * Cursor's questionnaire tray, docked above the composer while an agent waits on questions:
 * one question at a time, lettered options (single-select advances on pick, multi-select
 * toggles), an "Other..." row that turns into an input, a "< 1 of 3 >" stepper, Skip and
 * Next/Continue. The composer below stays live and its text goes along as extra details.
 */
export class AgentQuestionTray extends Disposable {

	readonly element: HTMLElement;

	private readonly render_ = this._register(new DisposableStore());
	private request: IAgentQuestionRequest | undefined;
	private step = 0;
	private collapsed = false;
	private answers = new Map<string, IDraftAnswer>();
	private advanceTimer: ReturnType<typeof setTimeout> | undefined;
	/** Attachments still being saved; Continue waits for them. */
	private readonly pending = new Set<Promise<void>>();
	private submitting = false;

	constructor(private readonly options: IAgentQuestionTrayOptions) {
		super();
		this.element = $('.volt-question-tray.hidden');
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('voltAgent.questions', "Questions"));
		this._register({ dispose: () => this.clearAdvance() });
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, e => {
			// The Other input handles its own Escape (it leaves the input); anywhere else in the tray it dismisses.
			if (e.key === 'Escape' && this.request && !e.defaultPrevented) {
				e.preventDefault();
				e.stopPropagation();
				this.dismiss();
			}
		}));
		this._register(addDisposableListener(this.element, 'paste', (e: ClipboardEvent) => {
			const question = this.currentQuestion();
			const files = Array.from(e.clipboardData?.items ?? []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file);
			if (question && files.length && this.canAttach(question)) {
				e.preventDefault();
				e.stopPropagation();
				this.attach(question, files);
			}
		}));
		const dragging = (e: DragEvent) => {
			const question = this.currentQuestion();
			if (question && this.canAttach(question) && e.dataTransfer?.types.includes('Files')) {
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = 'copy';
				this.element.classList.add('drop-target');
			}
		};
		this._register(addDisposableListener(this.element, EventType.DRAG_ENTER, dragging));
		this._register(addDisposableListener(this.element, EventType.DRAG_OVER, dragging));
		this._register(addDisposableListener(this.element, EventType.DRAG_LEAVE, (e: DragEvent) => {
			if (!e.relatedTarget || !this.element.contains(e.relatedTarget as Node)) {
				this.element.classList.remove('drop-target');
			}
		}));
		this._register(addDisposableListener(this.element, EventType.DROP, (e: DragEvent) => {
			this.element.classList.remove('drop-target');
			const question = this.currentQuestion();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (question && files.length && this.canAttach(question)) {
				e.preventDefault();
				e.stopPropagation();
				this.attach(question, files);
			}
		}));
	}

	get active(): boolean {
		return !!this.request;
	}

	get requestId(): string | undefined {
		return this.request?.id;
	}

	/** Shows `request`, keeping in-progress answers when it is the one already shown. */
	setRequest(request: IAgentQuestionRequest | undefined): void {
		if (request?.id === this.request?.id) {
			return;
		}
		this.clearAdvance();
		this.request = request;
		this.step = 0;
		this.collapsed = false;
		this.answers = new Map();
		for (const question of request?.questions ?? []) {
			this.answers.set(question.id, { selected: new Set(), other: '', editingOther: false, attachments: [] });
		}
		this.render();
	}

	/**
	 * Keys typed while the composer is empty (or nothing is focused): a letter picks that
	 * option, as in Cursor. Returns true when the tray used the key.
	 */
	handleKey(e: KeyboardEvent): boolean {
		const question = this.currentQuestion();
		if (!question || this.collapsed || e.metaKey || e.ctrlKey || e.altKey) {
			return false;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			this.advance();
			return true;
		}
		if (e.key.length !== 1) {
			return false;
		}
		const index = e.key.toUpperCase().charCodeAt(0) - 65;
		if (index < 0 || index > 25) {
			return false;
		}
		if (index < question.options.length) {
			this.pick(question, question.options[index].id);
			return true;
		}
		if (index === question.options.length && question.allowOther) {
			this.editOther(question);
			return true;
		}
		return false;
	}

	/** Enter from the composer: Next, or Continue on the last question. */
	advance(): void {
		const question = this.currentQuestion();
		if (!question || !this.isAnswered(question)) {
			return;
		}
		this.next();
	}

	private currentQuestion(): IAgentQuestion | undefined {
		return this.request?.questions[this.step];
	}

	private isLastStep(): boolean {
		return !!this.request && this.step >= this.request.questions.length - 1;
	}

	private isAnswered(question: IAgentQuestion): boolean {
		const draft = this.answers.get(question.id);
		return !!draft && (draft.selected.size > 0 || !!draft.other.trim() || draft.attachments.length > 0);
	}

	/** Like T3: only questions that take a custom answer take files. */
	private canAttach(question: IAgentQuestion): boolean {
		return !!this.options.attachments && question.allowOther;
	}

	/** "Attach files": the OS file dialog. */
	private async pickAttachments(question: IAgentQuestion): Promise<void> {
		const resources = await this.options.attachments?.pickFiles();
		if (resources?.length && this.currentQuestion() === question) {
			this.attach(question, resources);
		}
	}

	/** Saves `sources` and adds them to `question`'s answer; Continue waits until they are saved. */
	private attach(question: IAgentQuestion, sources: readonly (File | URI)[]): void {
		const host = this.options.attachments;
		const draft = this.answers.get(question.id);
		if (!host || !draft || !question.allowOther) {
			return;
		}
		const work = (async () => {
			for (const source of sources) {
				const prepared = await host.prepare(source);
				if (prepared && this.answers.get(question.id) === draft) {
					draft.attachments.push(prepared);
				}
			}
		})().catch(() => undefined);
		this.pending.add(work);
		this.render();
		void work.finally(() => {
			this.pending.delete(work);
			if (this.answers.get(question.id) === draft && !this._store.isDisposed) {
				this.render();
			}
		});
	}

	private removeAttachment(question: IAgentQuestion, id: string): void {
		const draft = this.answers.get(question.id);
		const index = draft?.attachments.findIndex(attachment => attachment.id === id) ?? -1;
		if (draft && index >= 0) {
			draft.attachments.splice(index, 1);
			this.render();
		}
	}

	/** The x button and Escape: the agent hears the questions were dismissed and carries on. */
	dismiss(): void {
		const request = this.request;
		if (!request) {
			return;
		}
		this.clearAdvance();
		this.options.onSubmit(request.id, { outcome: 'cancelled', dismissed: true, answers: [] }, []);
	}

	private pick(question: IAgentQuestion, optionId: string): void {
		const draft = this.answers.get(question.id);
		if (!draft) {
			return;
		}
		if (question.multiple) {
			if (draft.selected.has(optionId)) {
				draft.selected.delete(optionId);
			} else {
				draft.selected.add(optionId);
			}
			this.render();
			return;
		}
		draft.selected.clear();
		draft.selected.add(optionId);
		draft.editingOther = false;
		draft.other = '';
		this.render();
		// A single choice answers the question: move on, but let the pick show first.
		if (!this.isLastStep()) {
			this.clearAdvance();
			this.advanceTimer = setTimeout(() => {
				this.advanceTimer = undefined;
				if (this.currentQuestion() === question) {
					this.next();
				}
			}, 140);
		}
	}

	private editOther(question: IAgentQuestion): void {
		const draft = this.answers.get(question.id);
		if (!draft) {
			return;
		}
		draft.editingOther = true;
		this.render();
		this.element.querySelector<HTMLInputElement>('.volt-question-other-input')?.focus();
	}

	private next(): void {
		this.clearAdvance();
		if (this.isLastStep()) {
			void this.submit();
			return;
		}
		this.step++;
		this.render();
	}

	private back(): void {
		this.clearAdvance();
		if (this.step > 0) {
			this.step--;
			this.render();
		}
	}

	/** Skip leaves this question unanswered; on the last one it sends whatever was answered. */
	private skip(): void {
		const question = this.currentQuestion();
		if (question) {
			const draft = this.answers.get(question.id);
			draft?.selected.clear();
			if (draft) {
				draft.other = '';
				draft.editingOther = false;
				draft.attachments.length = 0;
			}
		}
		this.next();
	}

	private async submit(): Promise<void> {
		const request = this.request;
		if (!request || this.submitting) {
			return;
		}
		if (this.pending.size) {
			// Files still being saved: send once they are on disk.
			this.submitting = true;
			try {
				await Promise.all([...this.pending]);
			} finally {
				this.submitting = false;
			}
			if (this.request !== request) {
				return;
			}
		}
		const answers: IAgentQuestionAnswer[] = [];
		const media: IAgentPreparedAttachment[] = [];
		for (const question of request.questions) {
			const draft = this.answers.get(question.id);
			const other = draft?.other.trim();
			const attachments = draft?.attachments.map(({ kind, name, mime, size, path }) => ({ kind, name, mime, size, path })) ?? [];
			if (draft && (draft.selected.size || other || attachments.length)) {
				answers.push({
					questionId: question.id,
					optionIds: question.options.filter(option => draft.selected.has(option.id)).map(option => option.id),
					...(other ? { other } : {}),
					...(attachments.length ? { attachments } : {}),
				});
				media.push(...draft.attachments.filter(attachment => attachment.kind === 'image' && attachment.bytes));
			}
		}
		this.options.onSubmit(request.id, { outcome: answers.length ? 'answered' : 'skipped', answers }, media);
	}

	private clearAdvance(): void {
		if (this.advanceTimer !== undefined) {
			clearTimeout(this.advanceTimer);
			this.advanceTimer = undefined;
		}
	}

	private render(): void {
		// A re-render (an attachment finished saving) must not take the caret out of the Other input.
		const typing = this.element.ownerDocument.activeElement?.classList.contains('volt-question-other-input') && this.element.contains(this.element.ownerDocument.activeElement);
		this.render_.clear();
		this.element.replaceChildren();
		const request = this.request;
		const question = this.currentQuestion();
		this.element.classList.toggle('hidden', !request || !question);
		this.element.classList.toggle('collapsed', this.collapsed);
		if (!request || !question) {
			this.options.onLayout();
			return;
		}

		const header = append(this.element, $('.volt-question-tray-header'));
		const title = append(header, $('.volt-question-tray-title'));
		title.textContent = localize('voltAgent.questions', "Questions");
		const collapse = append(header, $('button.volt-question-tray-icon-btn')) as HTMLButtonElement;
		collapse.type = 'button';
		collapse.setAttribute('aria-label', this.collapsed ? localize('voltAgent.questions.expand', "Expand questionnaire") : localize('voltAgent.questions.collapse', "Collapse questionnaire"));
		setAgentTooltip(collapse, this.collapsed ? localize('voltAgent.questions.expandShort', "Expand") : localize('voltAgent.questions.collapseShort', "Collapse"));
		collapse.appendChild(renderIcon(this.collapsed ? Codicon.chevronUp : Codicon.dash));
		this.render_.add(addDisposableListener(collapse, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.collapsed = !this.collapsed;
			this.render();
		}));
		const dismiss = append(header, $('button.volt-question-tray-icon-btn.dismiss')) as HTMLButtonElement;
		dismiss.type = 'button';
		dismiss.setAttribute('aria-label', localize('voltAgent.questions.dismiss', "Dismiss questions"));
		setAgentTooltip(dismiss, localize('voltAgent.questions.dismissTooltip', "Dismiss (Esc). The agent continues without your answers."));
		dismiss.appendChild(renderIcon(Codicon.close));
		this.render_.add(addDisposableListener(dismiss, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.dismiss();
		}));
		if (this.collapsed) {
			this.render_.add(addDisposableListener(header, EventType.CLICK, () => {
				this.collapsed = false;
				this.render();
			}));
			this.options.onLayout();
			return;
		}

		const body = append(this.element, $('.volt-question-tray-body'));
		const step = append(body, $('.volt-question-step'));
		step.setAttribute('role', 'group');
		const prompt = append(step, $('p.volt-question-prompt'));
		prompt.textContent = question.prompt;
		const list = append(step, $('.volt-question-options'));
		list.setAttribute('role', question.multiple ? 'group' : 'radiogroup');
		const draft = this.answers.get(question.id)!;

		question.options.forEach((option, index) => {
			const selected = draft.selected.has(option.id);
			const row = append(list, $('button.volt-question-option')) as HTMLButtonElement;
			row.type = 'button';
			row.setAttribute('role', question.multiple ? 'checkbox' : 'radio');
			row.setAttribute('aria-checked', String(selected));
			row.classList.toggle('selected', selected);
			append(row, $('span.volt-question-badge')).textContent = badgeLetter(index);
			const label = append(row, $('span.volt-question-label'));
			label.textContent = option.label;
			if (option.description) {
				append(row, $('span.volt-question-desc')).textContent = option.description;
			}
			this.render_.add(addDisposableListener(row, EventType.CLICK, e => {
				e.preventDefault();
				this.pick(question, option.id);
			}));
		});

		if (question.allowOther) {
			const otherIndex = question.options.length;
			const hasOther = !!draft.other.trim();
			const row = append(list, $(draft.editingOther ? 'div.volt-question-option.other.editing' : 'button.volt-question-option.other'));
			row.classList.toggle('selected', hasOther);
			append(row, $('span.volt-question-badge')).textContent = badgeLetter(otherIndex);
			if (draft.editingOther) {
				const input = append(row, $('input.volt-question-other-input')) as HTMLInputElement;
				input.type = 'text';
				input.value = draft.other;
				input.placeholder = localize('voltAgent.questions.otherPlaceholder', "Type your answer...");
				input.setAttribute('aria-label', localize('voltAgent.questions.other', "Other"));
				this.render_.add(addDisposableListener(input, EventType.INPUT, () => {
					const had = !!draft.other.trim();
					draft.other = input.value;
					if (!question.multiple && input.value.trim()) {
						draft.selected.clear();
					}
					const has = !!draft.other.trim();
					row.classList.toggle('selected', has);
					if (had !== has) {
						this.syncFooter(question);
						for (const option of list.querySelectorAll<HTMLElement>('.volt-question-option:not(.other)')) {
							if (!question.multiple && has) {
								option.classList.remove('selected');
								option.setAttribute('aria-checked', 'false');
							}
						}
					}
				}));
				this.render_.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
					e.stopPropagation();
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						this.advance();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						draft.editingOther = false;
						this.render();
					}
				}));
				this.render_.add(addDisposableListener(input, EventType.BLUR, () => {
					if (!draft.other.trim() && draft.editingOther) {
						draft.editingOther = false;
						// Blur fires while a click elsewhere in the tray is still landing: redraw after it.
						setTimeout(() => {
							if (this.currentQuestion() === question && !draft.editingOther) {
								this.render();
							}
						}, 0);
					}
				}));
			} else {
				const label = append(row, $('span.volt-question-label'));
				if (hasOther) {
					label.textContent = draft.other.trim();
				} else {
					label.classList.add('placeholder');
					label.textContent = localize('voltAgent.questions.otherRow', "Other...");
				}
				(row as HTMLButtonElement).type = 'button';
				this.render_.add(addDisposableListener(row, EventType.CLICK, e => {
					e.preventDefault();
					this.editOther(question);
				}));
			}
		}

		if (draft.attachments.length || (this.pending.size && this.canAttach(question))) {
			this.renderAttachments(step, question, draft);
		}
		if (typing && draft.editingOther) {
			this.element.querySelector<HTMLInputElement>('.volt-question-other-input')?.focus();
		}

		const footer = append(this.element, $('.volt-question-tray-footer'));
		if (request.questions.length > 1) {
			const stepper = append(footer, $('.volt-question-stepper'));
			const prev = append(stepper, $('button.volt-question-tray-icon-btn')) as HTMLButtonElement;
			prev.type = 'button';
			prev.disabled = this.step === 0;
			prev.setAttribute('aria-label', localize('voltAgent.questions.previous', "Previous question"));
			prev.appendChild(renderIcon(Codicon.chevronLeft));
			append(stepper, $('span.volt-question-count')).textContent = localize('voltAgent.questions.count', "{0} of {1}", this.step + 1, request.questions.length);
			const nextBtn = append(stepper, $('button.volt-question-tray-icon-btn')) as HTMLButtonElement;
			nextBtn.type = 'button';
			nextBtn.disabled = this.isLastStep();
			nextBtn.setAttribute('aria-label', localize('voltAgent.questions.nextStep', "Next question"));
			nextBtn.appendChild(renderIcon(Codicon.chevronRight));
			this.render_.add(addDisposableListener(prev, EventType.CLICK, e => {
				e.preventDefault();
				this.back();
			}));
			this.render_.add(addDisposableListener(nextBtn, EventType.CLICK, e => {
				e.preventDefault();
				this.clearAdvance();
				this.step = Math.min(this.step + 1, request.questions.length - 1);
				this.render();
			}));
		}
		if (this.canAttach(question)) {
			const attach = append(footer, $('button.volt-question-tray-icon-btn.attach')) as HTMLButtonElement;
			attach.type = 'button';
			attach.setAttribute('aria-label', localize('voltAgent.questions.attach', "Attach files"));
			setAgentTooltip(attach, localize('voltAgent.questions.attachTooltip', "Attach files to this answer. You can also paste or drop them here."));
			attach.appendChild(renderIcon(Codicon.attach));
			this.render_.add(addDisposableListener(attach, EventType.CLICK, e => {
				e.preventDefault();
				void this.pickAttachments(question);
			}));
		}
		append(footer, $('.volt-question-footer-spacer'));
		const skip = append(footer, $('button.volt-question-pill.ghost')) as HTMLButtonElement;
		skip.type = 'button';
		skip.textContent = localize('voltAgent.questions.skip', "Skip");
		this.render_.add(addDisposableListener(skip, EventType.CLICK, e => {
			e.preventDefault();
			this.skip();
		}));
		const primary = append(footer, $('button.volt-question-pill.primary')) as HTMLButtonElement;
		primary.type = 'button';
		append(primary, $('span.volt-question-pill-label')).textContent = this.isLastStep()
			? localize('voltAgent.questions.continue', "Continue")
			: localize('voltAgent.questions.next', "Next");
		append(primary, $('span.volt-question-pill-key')).textContent = '⏎';
		this.render_.add(addDisposableListener(primary, EventType.CLICK, e => {
			e.preventDefault();
			this.advance();
		}));
		this.syncFooter(question);
		this.options.onLayout();
	}

	/** Chips for the files attached to this question's answer, with a remove button each. */
	private renderAttachments(parent: HTMLElement, question: IAgentQuestion, draft: IDraftAnswer): void {
		const row = append(parent, $('.volt-question-attachments'));
		for (const attachment of draft.attachments) {
			const chip = append(row, $('span.volt-question-attachment'));
			chip.appendChild(renderIcon(attachment.kind === 'image' ? Codicon.fileMedia : Codicon.file));
			const name = append(chip, $('span.volt-question-attachment-name'));
			name.textContent = attachment.name;
			append(chip, $('span.volt-question-attachment-size')).textContent = formatAttachmentSize(attachment.size);
			setAgentTooltip(chip, attachment.path);
			const remove = append(chip, $('button.volt-question-attachment-remove')) as HTMLButtonElement;
			remove.type = 'button';
			remove.setAttribute('aria-label', localize('voltAgent.questions.removeAttachment', "Remove {0}", attachment.name));
			remove.appendChild(renderIcon(Codicon.close));
			this.render_.add(addDisposableListener(remove, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.removeAttachment(question, attachment.id);
			}));
		}
		if (this.pending.size) {
			const chip = append(row, $('span.volt-question-attachment.pending'));
			chip.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			append(chip, $('span.volt-question-attachment-name')).textContent = localize('voltAgent.questions.attaching', "Attaching...");
		}
	}

	private syncFooter(question: IAgentQuestion): void {
		const primary = this.element.querySelector<HTMLButtonElement>('.volt-question-pill.primary');
		if (primary) {
			const ready = this.isAnswered(question);
			primary.classList.toggle('dimmed', !ready);
			primary.setAttribute('aria-disabled', String(!ready));
		}
	}
}
