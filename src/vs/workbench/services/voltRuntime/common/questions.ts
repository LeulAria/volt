/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Multiple-choice questions an agent asks the user mid-turn. Three wires carry them: Volt's own
 * `ask_question` MCP tool (any agent), Cursor's `cursor/ask_question` ACP extension, and ACP
 * form elicitations (Claude's AskUserQuestion, Codex's request-user-input). All become one
 * `IAgentQuestionRequest`, answered by the tray above the composer.
 */

import { attachmentSavedLine, IFileAttachmentInfo } from './fileAttachments.js';

export interface IAgentQuestionOption {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export interface IAgentQuestion {
	readonly id: string;
	readonly prompt: string;
	readonly options: readonly IAgentQuestionOption[];
	readonly multiple: boolean;
	/** False only when the wire has nowhere to put free text. */
	readonly allowOther: boolean;
}

export interface IAgentQuestionRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly title?: string;
	readonly questions: readonly IAgentQuestion[];
}

/** A file attached to one answer, already saved where the agent's tools can open it. */
export interface IAgentQuestionAttachment extends IFileAttachmentInfo {
	readonly path: string;
}

export interface IAgentQuestionAnswer {
	readonly questionId: string;
	readonly optionIds: readonly string[];
	readonly other?: string;
	/** Only on questions that take a custom answer; may be the whole answer. */
	readonly attachments?: readonly IAgentQuestionAttachment[];
}

export interface IAgentQuestionResponse {
	readonly outcome: 'answered' | 'skipped' | 'cancelled';
	readonly answers: readonly IAgentQuestionAnswer[];
	/** What the user typed in the composer under the tray ("Add more optional details..."). */
	readonly note?: string;
	/**
	 * With `cancelled`: the user closed the tray. The agent is told and carries on, where a
	 * cancel from Stop or a steer ends the question with the run.
	 */
	readonly dismissed?: boolean;
}

export type AgentQuestionDraft = Omit<IAgentQuestionRequest, 'id' | 'sessionId' | 'runId'>;

/** One answered question as the transcript's Answers card shows it. */
export interface IAgentAnsweredQuestion {
	readonly question: string;
	readonly answer: string;
	readonly attachments?: readonly IAgentQuestionAttachment[];
}

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function slug(text: string, fallback: string): string {
	const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
	return id || fallback;
}

function parseOptions(raw: unknown): IAgentQuestionOption[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	const options: IAgentQuestionOption[] = [];
	raw.forEach((item, index) => {
		const rec = asRecord(item);
		const label = rec ? str(rec.label ?? rec.title ?? rec.name ?? rec.const ?? rec.value) : str(item);
		if (!label) {
			return;
		}
		let id = rec ? str(rec.id ?? rec.value ?? rec.const) : '';
		id ||= slug(label, `option_${index + 1}`);
		while (seen.has(id)) {
			id = `${id}_${index + 1}`;
		}
		seen.add(id);
		const description = rec ? str(rec.description) : '';
		options.push({ id, label, ...(description && description !== label ? { description } : {}) });
	});
	return options;
}

/**
 * The questions of an `ask_question` tool call or a `cursor/ask_question` request. Accepts
 * `prompt` or `question` for the text and `allowMultiple`, `allow_multiple` or `multiSelect`.
 */
export function parseQuestionDraft(input: unknown): AgentQuestionDraft | undefined {
	const rec = asRecord(input);
	if (!rec) {
		return undefined;
	}
	const list = Array.isArray(rec.questions) ? rec.questions : undefined;
	if (!list?.length) {
		return undefined;
	}
	const seen = new Set<string>();
	const questions: IAgentQuestion[] = [];
	list.forEach((item, index) => {
		const q = asRecord(item);
		if (!q) {
			return;
		}
		const prompt = str(q.prompt ?? q.question ?? q.text ?? q.title);
		const options = parseOptions(q.options ?? q.choices);
		if (!prompt) {
			return;
		}
		let id = str(q.id) || `q${index + 1}`;
		while (seen.has(id)) {
			id = `${id}_${index + 1}`;
		}
		seen.add(id);
		questions.push({
			id,
			prompt,
			options,
			multiple: q.allowMultiple === true || q.allow_multiple === true || q.multiSelect === true || q.multiple === true,
			allowOther: q.allowOther !== false && q.allow_other !== false,
		});
	});
	if (!questions.length) {
		return undefined;
	}
	const title = str(rec.title);
	return { ...(title ? { title } : {}), questions };
}

function optionLabels(question: IAgentQuestion, answer: IAgentQuestionAnswer | undefined): string[] {
	if (!answer) {
		return [];
	}
	const labels = answer.optionIds
		.map(id => question.options.find(option => option.id === id)?.label)
		.filter((label): label is string => !!label);
	const other = answer.other?.trim();
	if (other) {
		labels.push(other);
	}
	return labels;
}

/** `[Image "x.png" is saved at: /path]` per file attached to an answer. */
export function answerAttachmentLines(answer: IAgentQuestionAnswer | undefined): string[] {
	return (answer?.attachments ?? []).map(attachment => attachmentSavedLine(attachment)).filter((line): line is string => !!line);
}

/** The pairs the Answers card lists. Multi-select answers are comma-joined, like Cursor. */
export function answeredQuestions(request: Pick<IAgentQuestionRequest, 'questions'>, response: IAgentQuestionResponse): IAgentAnsweredQuestion[] {
	if (response.outcome !== 'answered') {
		return [];
	}
	const out: IAgentAnsweredQuestion[] = [];
	for (const question of request.questions) {
		const answer = response.answers.find(item => item.questionId === question.id);
		const labels = optionLabels(question, answer);
		const attachments = answer?.attachments?.length ? answer.attachments : undefined;
		if (labels.length || attachments) {
			out.push({ question: question.prompt, answer: labels.join(', '), ...(attachments ? { attachments } : {}) });
		}
	}
	return out;
}

/** Said to the agent when the user closes the tray without answering. */
export const QUESTIONS_DISMISSED_TEXT = 'The user dismissed the questions. Do not ask them again; continue with your best judgement or stop and wait for instructions.';

/** What the `ask_question` MCP tool hands back to the model. */
export function questionResponseText(request: Pick<IAgentQuestionRequest, 'questions'>, response: IAgentQuestionResponse): string {
	const note = response.note?.trim();
	if (response.outcome === 'cancelled') {
		return QUESTIONS_DISMISSED_TEXT;
	}
	const lines: string[] = [];
	if (response.outcome === 'skipped') {
		lines.push('The user skipped the questions. Continue with sensible defaults.');
	} else {
		lines.push('The user answered:');
		for (const question of request.questions) {
			const answer = response.answers.find(item => item.questionId === question.id);
			const labels = optionLabels(question, answer);
			const files = answerAttachmentLines(answer);
			lines.push(`- ${question.prompt} → ${labels.length ? labels.join(', ') : files.length ? '(see the attached files)' : '(no answer)'}`);
			lines.push(...files.map(line => `  ${line}`));
		}
	}
	if (note) {
		lines.push('', `Additional details from the user: ${note}`);
	}
	return lines.join('\n');
}

//#region Cursor `cursor/ask_question`

export interface ICursorAskQuestionResult {
	readonly outcome:
	| { readonly outcome: 'answered'; readonly answers: readonly { readonly questionId: string; readonly selectedOptionIds: readonly string[] }[] }
	| { readonly outcome: 'skipped'; readonly reason?: string }
	| { readonly outcome: 'cancelled' };
}

/**
 * Cursor's answer carries option ids only, so free text rides as one more "id" and the note is
 * appended to the last question: the model reads both verbatim.
 */
export function cursorAskQuestionResult(request: Pick<IAgentQuestionRequest, 'questions'>, response: IAgentQuestionResponse): ICursorAskQuestionResult {
	if (response.outcome === 'cancelled' && response.dismissed) {
		// Skipped, not cancelled: a cancelled ask ends cursor-agent's tool call as if the run stopped.
		return { outcome: { outcome: 'skipped', reason: QUESTIONS_DISMISSED_TEXT } };
	}
	if (response.outcome === 'cancelled') {
		return { outcome: { outcome: 'cancelled' } };
	}
	if (response.outcome === 'skipped') {
		const note = response.note?.trim();
		return { outcome: { outcome: 'skipped', reason: note ? `User skipped questions: ${note}` : 'User skipped questions' } };
	}
	const note = response.note?.trim();
	const answers = request.questions.map((question, index) => {
		const answer = response.answers.find(item => item.questionId === question.id);
		const ids = [...(answer?.optionIds ?? [])];
		if (answer?.other?.trim()) {
			ids.push(`Other: ${answer.other.trim()}`);
		}
		ids.push(...answerAttachmentLines(answer));
		if (note && index === request.questions.length - 1) {
			ids.push(`Additional details: ${note}`);
		}
		return { questionId: question.id, selectedOptionIds: ids };
	});
	return { outcome: { outcome: 'answered', answers } };
}

//#endregion

//#region ACP form elicitation

interface IElicitationField {
	readonly key: string;
	readonly schema: Record<string, unknown>;
}

const CUSTOM_SUFFIX = '_custom';

function enumOptions(schema: Record<string, unknown>): IAgentQuestionOption[] {
	const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (oneOf) {
		return parseOptions(oneOf.map(item => {
			const rec = asRecord(item) ?? {};
			return { id: str(rec.const), label: str(rec.title) || str(rec.const), description: rec.description };
		}));
	}
	const values = Array.isArray(schema.enum) ? schema.enum : undefined;
	if (values) {
		const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
		return parseOptions(values.map((value, index) => ({ id: str(value), label: str(names[index]) || str(value) })));
	}
	const items = asRecord(schema.items);
	if (items) {
		const anyOf = Array.isArray(items.anyOf) ? items.anyOf : Array.isArray(items.oneOf) ? items.oneOf : undefined;
		if (anyOf) {
			return enumOptions({ oneOf: anyOf });
		}
		return enumOptions(items);
	}
	return [];
}

/**
 * A form elicitation as questions: each enum field is a question, and a string field named
 * `<field>_custom` (claude-agent-acp's per-question "Other" box) folds into the question before it.
 * Forms with other kinds of fields are left to the agent's own fallback.
 */
export function elicitationToQuestions(params: unknown): AgentQuestionDraft | undefined {
	const rec = asRecord(params);
	const schema = asRecord(rec?.requestedSchema);
	const properties = asRecord(schema?.properties);
	if (!rec || !properties || (rec.mode !== undefined && rec.mode !== 'form')) {
		return undefined;
	}
	const fields: IElicitationField[] = Object.entries(properties)
		.map(([key, value]) => ({ key, schema: asRecord(value) ?? {} }));
	const message = str(rec.message);
	const questions: IAgentQuestion[] = [];
	const single = fields.filter(field => !field.key.endsWith(CUSTOM_SUFFIX)).length === 1;
	for (const field of fields) {
		if (field.key.endsWith(CUSTOM_SUFFIX) && properties[field.key.slice(0, -CUSTOM_SUFFIX.length)]) {
			continue;
		}
		const options = enumOptions(field.schema);
		if (!options.length) {
			if (field.schema.type === 'boolean') {
				questions.push({ id: field.key, prompt: str(field.schema.description) || str(field.schema.title) || message, options: [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }], multiple: false, allowOther: false });
				continue;
			}
			return undefined;
		}
		const prompt = (single ? message : '') || str(field.schema.description) || str(field.schema.title) || message;
		questions.push({
			id: field.key,
			prompt,
			options,
			multiple: field.schema.type === 'array',
			allowOther: !!properties[`${field.key}${CUSTOM_SUFFIX}`],
		});
	}
	if (!questions.length) {
		return undefined;
	}
	return { ...(message && !single ? { title: message } : {}), questions };
}

/**
 * A dismissed tray declines: claude-agent-acp turns `cancel` into an aborted tool call, which ends
 * the turn, while `decline` tells the model the user skipped and lets it carry on.
 */
export function elicitationResult(request: Pick<IAgentQuestionRequest, 'questions'>, response: IAgentQuestionResponse): { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } {
	if (response.outcome === 'cancelled') {
		return { action: response.dismissed ? 'decline' : 'cancel' };
	}
	if (response.outcome === 'skipped') {
		return { action: 'decline' };
	}
	const content: Record<string, unknown> = {};
	const note = response.note?.trim();
	request.questions.forEach((question, index) => {
		const answer = response.answers.find(item => item.questionId === question.id);
		const ids = answer?.optionIds ?? [];
		if (question.options.length === 2 && question.options[0].id === 'true' && question.options[1].id === 'false' && !question.allowOther) {
			if (ids[0]) {
				content[question.id] = ids[0] === 'true';
			}
			return;
		}
		if (question.multiple) {
			content[question.id] = [...ids];
		} else if (ids[0]) {
			content[question.id] = ids[0];
		}
		const other = [answer?.other?.trim(), ...answerAttachmentLines(answer), index === request.questions.length - 1 ? note : undefined].filter(Boolean).join('\n');
		if (other && question.allowOther) {
			content[`${question.id}${CUSTOM_SUFFIX}`] = other;
		}
	});
	return { action: 'accept', content };
}

//#endregion
