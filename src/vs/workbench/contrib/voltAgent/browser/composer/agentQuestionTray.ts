/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentQuestionTray.css';
import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IAgentQuestion, IAgentQuestionAnswer, IAgentQuestionRequest, IAgentQuestionResponse } from '../../../../services/voltRuntime/common/questions.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

export interface IAgentQuestionTrayOptions {
	/** The editor adds the composer text as the response's note and clears it. */
	onSubmit(requestId: string, response: IAgentQuestionResponse): void;
	/** The tray changed height; the composer relayouts. */
	onLayout(): void;
}

interface IDraftAnswer {
	readonly selected: Set<string>;
	other: string;
	/** The "Other..." row is an input right now. */
	editingOther: boolean;
}

/** Letter badges A, B, C…; past Z the rows count on (AA is never needed in practice). */
function badgeLetter(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * Cursor's questionnaire tray, docked above the composer while an agent waits on questions:
 * one question at a time, lettered options (single-select advances on pick, multi-select
 * toggles), an "Other..." row that turns into an input, a "‹ 1 of 3 ›" stepper, Skip and
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

	constructor(private readonly options: IAgentQuestionTrayOptions) {
		super();
		this.element = $('.volt-question-tray.hidden');
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('voltAgent.questions', "Questions"));
		this._register({ dispose: () => this.clearAdvance() });
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
			this.answers.set(question.id, { selected: new Set(), other: '', editingOther: false });
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
		return !!draft && (draft.selected.size > 0 || !!draft.other.trim());
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
			this.submit();
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
			}
		}
		this.next();
	}

	private submit(): void {
		const request = this.request;
		if (!request) {
			return;
		}
		const answers: IAgentQuestionAnswer[] = [];
		for (const question of request.questions) {
			const draft = this.answers.get(question.id);
			const other = draft?.other.trim();
			if (draft && (draft.selected.size || other)) {
				answers.push({ questionId: question.id, optionIds: question.options.filter(option => draft.selected.has(option.id)).map(option => option.id), ...(other ? { other } : {}) });
			}
		}
		this.options.onSubmit(request.id, { outcome: answers.length ? 'answered' : 'skipped', answers });
	}

	private clearAdvance(): void {
		if (this.advanceTimer !== undefined) {
			clearTimeout(this.advanceTimer);
			this.advanceTimer = undefined;
		}
	}

	private render(): void {
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
			this.collapsed = !this.collapsed;
			this.render();
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

	private syncFooter(question: IAgentQuestion): void {
		const primary = this.element.querySelector<HTMLButtonElement>('.volt-question-pill.primary');
		if (primary) {
			const ready = this.isAnswered(question);
			primary.classList.toggle('dimmed', !ready);
			primary.setAttribute('aria-disabled', String(!ready));
		}
	}
}
