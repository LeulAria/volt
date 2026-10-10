/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ghost text for the agent composer: natural language, not code. Pure.
 *
 * The local layer answers on every keystroke, with no model call:
 *   1. history - the draft is the start of a prompt sent before: the rest of it (a shell's autosuggest);
 *   2. word - the word being typed, from the words of the user's prompts and the chat's names;
 *   3. next words - what usually follows the last words in the user's own prompts.
 * The model layer continues the sentence once the typing pauses (see `buildComposerPrompt`).
 */

import { IModelMessage } from '../providers.js';
import { stripFences, stripSpecialTokens } from './postProcess.js';

/** What the local layer learns from. */
export interface IComposerCorpus {
	/** Prompts the user sent, newest first. */
	readonly prompts: readonly string[];
	/** Other names worth completing: files in the chat, the project, words of recent replies. */
	readonly vocabulary: readonly string[];
}

/** Longest history suggestion, so a long old prompt does not fill the composer with grey text. */
const MAX_HISTORY_CHARS = 160;
/** Words chained after the cursor by the n-gram layer. */
const MAX_NEXT_WORDS = 4;
const MIN_PARTIAL_WORD = 2;

const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_'-]*/gu;
/** File names and identifiers stay whole for completion: `agentEditor.ts`, `src/vs/base`. */
const NAME = /[\p{L}\p{N}_$][\p{L}\p{N}_$.\/-]*[\p{L}\p{N}_$]/gu;

export class ComposerLanguageModel {

	private readonly prompts: readonly string[];
	/** Lowercased word -> how often it was used. */
	private readonly counts = new Map<string, number>();
	/** Lowercased word -> the spelling seen most recently (`GitHub`, `useEffect`). */
	private readonly spellings = new Map<string, string>();
	private readonly bigrams = new Map<string, Map<string, number>>();
	private readonly trigrams = new Map<string, Map<string, number>>();

	constructor(corpus: IComposerCorpus) {
		this.prompts = corpus.prompts.filter(prompt => prompt.trim());
		// Oldest first, so the newest spelling of a word wins.
		for (let i = this.prompts.length - 1; i >= 0; i--) {
			const words = tokens(this.prompts[i]);
			for (let w = 0; w < words.length; w++) {
				this.addWord(words[w], 2);
				if (w >= 1) {
					bump(this.bigrams, words[w - 1].toLowerCase(), words[w].toLowerCase());
				}
				if (w >= 2) {
					bump(this.trigrams, `${words[w - 2].toLowerCase()} ${words[w - 1].toLowerCase()}`, words[w].toLowerCase());
				}
			}
		}
		for (const text of corpus.vocabulary) {
			for (const match of text.matchAll(NAME)) {
				this.addWord(match[0], 1);
			}
		}
	}

	/** The best instant continuation of `draft` (all the text before the cursor), or undefined. */
	predict(draft: string): string | undefined {
		if (draft.trim().length < MIN_PARTIAL_WORD) {
			return undefined;
		}
		return this.fromHistory(draft) ?? this.completeWord(draft) ?? this.nextWords(draft);
	}

	/** The draft starts a prompt sent before: the rest of it, up to its first line break. */
	fromHistory(draft: string): string | undefined {
		const typed = draft.trimStart();
		if (typed.trim().length < 4 || typed.includes('\n')) {
			return undefined;
		}
		const lower = typed.toLowerCase();
		for (const prompt of this.prompts) {
			const candidate = prompt.trimStart();
			if (candidate.length <= typed.length || !candidate.toLowerCase().startsWith(lower)) {
				continue;
			}
			let rest = candidate.slice(typed.length);
			const newline = rest.indexOf('\n');
			if (newline >= 0) {
				rest = rest.slice(0, newline);
			}
			rest = clipAtWord(rest.trimEnd(), MAX_HISTORY_CHARS);
			if (rest.trim()) {
				return rest;
			}
		}
		return undefined;
	}

	/** The word under the cursor finished, plus the words that usually follow it when that is clear. */
	completeWord(draft: string): string | undefined {
		const partial = /[\p{L}\p{N}_$][\p{L}\p{N}_$.\/'-]*$/u.exec(draft)?.[0];
		if (!partial || partial.length < MIN_PARTIAL_WORD) {
			return undefined;
		}
		const lower = partial.toLowerCase();
		const previous = lastWords(draft.slice(0, draft.length - partial.length), 1)[0]?.toLowerCase();
		let best: { word: string; score: number } | undefined;
		for (const [word, count] of this.counts) {
			if (word.length <= lower.length || !word.startsWith(lower)) {
				continue;
			}
			// A word that followed the previous word before is far more likely than a frequent one.
			const score = count + (previous ? (this.bigrams.get(previous)?.get(word) ?? 0) * 4 : 0);
			if (!best || score > best.score || (score === best.score && word.length < best.word.length)) {
				best = { word, score };
			}
		}
		if (!best) {
			return undefined;
		}
		const spelled = this.spellings.get(best.word) ?? best.word;
		// Keep what the user typed; take the rest from the remembered spelling.
		const rest = spelled.slice(partial.length);
		const following = this.chain([previous, best.word].filter((word): word is string => !!word), MAX_NEXT_WORDS - 1);
		return following.length ? `${rest} ${following.join(' ')}` : rest;
	}

	/** After a space: the words that usually come next, while one choice clearly dominates. */
	nextWords(draft: string): string | undefined {
		if (!/\s$/.test(draft) || /\n\s*$/.test(draft)) {
			return undefined;
		}
		const context = lastWords(draft, 2).map(word => word.toLowerCase());
		if (!context.length) {
			return undefined;
		}
		const words = this.chain(context, MAX_NEXT_WORDS);
		return words.length ? words.join(' ') : undefined;
	}

	private chain(context: string[], max: number): string[] {
		const out: string[] = [];
		const window = context.slice(-2);
		for (let i = 0; i < max; i++) {
			const next = this.likelyNext(window);
			if (!next) {
				break;
			}
			out.push(this.spellings.get(next) ?? next);
			window.push(next);
			if (window.length > 2) {
				window.shift();
			}
		}
		return out;
	}

	/** The next word when it was seen at least twice and makes up most of what followed. */
	private likelyNext(context: readonly string[]): string | undefined {
		const tri = context.length >= 2 ? dominant(this.trigrams.get(`${context[context.length - 2]} ${context[context.length - 1]}`)) : undefined;
		if (tri) {
			return tri;
		}
		return context.length ? dominant(this.bigrams.get(context[context.length - 1])) : undefined;
	}

	private addWord(word: string, weight: number): void {
		if (word.length < 3) {
			return;
		}
		const lower = word.toLowerCase();
		this.counts.set(lower, (this.counts.get(lower) ?? 0) + weight);
		this.spellings.set(lower, word);
	}
}

function tokens(text: string): string[] {
	return [...text.matchAll(WORD)].map(match => match[0]);
}

function lastWords(text: string, count: number): string[] {
	const words = tokens(text.slice(-200));
	return words.slice(-count);
}

function bump(table: Map<string, Map<string, number>>, key: string, next: string): void {
	let row = table.get(key);
	if (!row) {
		row = new Map();
		table.set(key, row);
	}
	row.set(next, (row.get(next) ?? 0) + 1);
}

function dominant(row: Map<string, number> | undefined): string | undefined {
	if (!row) {
		return undefined;
	}
	let total = 0;
	let best: [string, number] | undefined;
	for (const entry of row) {
		total += entry[1];
		if (!best || entry[1] > best[1]) {
			best = entry;
		}
	}
	return best && best[1] >= 2 && best[1] / total >= 0.6 ? best[0] : undefined;
}

function clipAtWord(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const cut = text.lastIndexOf(' ', max);
	return text.slice(0, cut > max / 2 ? cut : max);
}

// --- model layer -----------------------------------------------------------------------------

export const COMPOSER_CURSOR = '<|cursor|>';

/** Ceiling for the chat context in the prompt: the last messages matter, the rest costs tokens. */
const COMPOSER_CONTEXT_CHARS = 2_400;

export const COMPOSER_SYSTEM_PROMPT = [
	'You autocomplete the message a developer is typing to an AI coding agent, like a phone keyboard that knows the conversation.',
	`Continue the text exactly where ${COMPOSER_CURSOR} is: the next few words, at most to the end of the sentence.`,
	'Write as the developer, in their language, tone and casing. Use names from the chat (files, functions, errors) when they fit.',
	`Begin the reply with the last word before ${COMPOSER_CURSOR}, completed if it is cut off, then continue.`,
	'Reply with that word and the continuation only: no quotes, no preamble, no answer to the message.',
	'If no continuation is likely, reply with nothing.',
].join(' ');

export interface IComposerPromptInput {
	readonly draft: string;
	readonly after: string;
	readonly transcript: readonly string[];
	readonly vocabulary: readonly string[];
	readonly clipboard?: string;
}

export function buildComposerPrompt(input: IComposerPromptInput): IModelMessage[] {
	const blocks: string[] = [];
	const transcript: string[] = [];
	let used = 0;
	// Newest first until the budget runs out, then shown oldest first.
	for (let i = input.transcript.length - 1; i >= 0; i--) {
		const message = input.transcript[i];
		if (used + message.length > COMPOSER_CONTEXT_CHARS) {
			break;
		}
		transcript.unshift(message);
		used += message.length;
	}
	if (transcript.length) {
		blocks.push(`## Conversation so far (oldest first)\n${transcript.join('\n---\n')}`);
	}
	if (input.vocabulary.length) {
		blocks.push(`## Names in this chat\n${input.vocabulary.slice(0, 40).join(', ')}`);
	}
	const clipboard = input.clipboard?.trim();
	if (clipboard && clipboard.length <= 600) {
		blocks.push(`## Clipboard\n${clipboard}`);
	}
	blocks.push(`## The message being typed\n${input.draft}${COMPOSER_CURSOR}${input.after}`);
	blocks.push(`Continue at ${COMPOSER_CURSOR}. Reply with the last word and the continuation only.`);
	return [
		{ role: 'system', content: COMPOSER_SYSTEM_PROMPT },
		{ role: 'user', content: blocks.join('\n\n') },
	];
}

/** A reply about the task rather than the continuation (`Sure, ...`, `Here is ...`). Words like "make sure" stay valid. */
const META_REPLY = /^((sure|okay|ok)[,!.]|here('s| is| are)\b|(continuation|completion)\s*:|i (can|will|would|cannot|can't) (help|continue|complete)\b|as an ai\b|based on (the|your) (message|conversation|context)\b)/i;

/**
 * A model reply turned into ghost text for `draft`: one line, without an echo of what was typed,
 * cut after the sentence it finishes. Undefined when nothing usable is left.
 */
export function cleanComposerCompletion(raw: string, draft: string): string | undefined {
	let text = stripSpecialTokens(stripFences(raw.replace(/\r\n/g, '\n')));
	text = text.split(COMPOSER_CURSOR).join('');
	// The first line only: the composer predicts the sentence being typed, not the next paragraph.
	text = text.replace(/^\n+/, '');
	const newline = text.indexOf('\n');
	if (newline >= 0) {
		text = text.slice(0, newline);
	}
	// allow-any-unicode-next-line
	text = text.replace(/^\s*(["'`“]+)/, '').replace(/(["'`”]+)\s*$/, '');
	if (!text.trim() || META_REPLY.test(text.trim())) {
		return undefined;
	}
	const restated = stripRestatedWord(text, draft);
	if (restated !== undefined) {
		text = restated;
	} else {
		text = dedupeEcho(text, draft);
		// Chat replies rarely keep a leading space: after a whole word, the continuation is a new one.
		if (/[\p{L}\p{N}_]$/u.test(draft) && /^[\p{L}\p{N}_(\[{"'`]/u.test(text)) {
			text = ` ${text}`;
		}
	}
	if (/\s$/.test(draft)) {
		text = text.replace(/^\s+/, '');
	}
	const sentence = /^(.*?[.!?])(\s|$)/.exec(text);
	if (sentence && sentence[1].trim().length >= 2) {
		text = sentence[1];
	}
	text = clipAtWord(text.trimEnd(), 140);
	return text.trim() ? text : undefined;
}

/**
 * The reply starts with the draft's last word (as asked), possibly completed: the part after what
 * was typed. `fix the bu` + `bug in the parser` -> `g in the parser`; `fix` + `fix the login` ->
 * ` the login`. Undefined when the reply does not start with that word.
 */
function stripRestatedWord(text: string, draft: string): string | undefined {
	const partial = /[\p{L}\p{N}_]+$/u.exec(draft)?.[0];
	const lead = text.trimStart();
	if (!partial || !lead.toLowerCase().startsWith(partial.toLowerCase())) {
		return undefined;
	}
	return lead.slice(partial.length);
}

/** Drops the start of `text` that repeats the end of `draft` (models restate the last words). */
function dedupeEcho(text: string, draft: string): string {
	const tail = draft.slice(-120);
	const lowerTail = tail.toLowerCase();
	const lowerText = text.toLowerCase();
	for (let len = Math.min(tail.length, text.length); len >= 3; len--) {
		if (!lowerTail.endsWith(lowerText.slice(0, len))) {
			continue;
		}
		// Only from a word boundary of the draft, so `prefix` + `fixes` is not cut to `es`.
		const start = tail.length - len;
		if (start === 0 || /[\s\p{P}]/u.test(tail[start - 1]) || /[\s\p{P}]/u.test(tail[start])) {
			return text.slice(len);
		}
	}
	return text;
}
