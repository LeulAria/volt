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
import { isToolCallJunk, stripFences, stripSpecialTokens, taggedInsert } from './postProcess.js';

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
		return this.predictScored(draft)?.text;
	}

	/**
	 * The best instant continuation with how sure of it the model is, 0..1. A prompt sent before
	 * that the draft is typing out again is near-certain once a few words are typed; a phrase from
	 * the middle of one is likely; a finished word or the usual next words are a fair guess that the
	 * prediction model may still improve on.
	 */
	predictScored(draft: string): { readonly text: string; readonly confidence: number } | undefined {
		if (draft.trim().length < MIN_PARTIAL_WORD) {
			return undefined;
		}
		const history = this.fromHistory(draft);
		if (history) {
			// Three words of an old prompt typed again pick it out; `fix the ` could start anything.
			const sure = draft.trim().length >= 12 && tokens(draft).length >= 3;
			return { text: history, confidence: sure ? 0.9 : 0.6 };
		}
		const phrase = this.fromPhrase(draft);
		if (phrase) {
			return phrase;
		}
		const word = this.completeWord(draft) ?? this.nextWords(draft);
		return word ? { text: word, confidence: 0.5 } : undefined;
	}

	/**
	 * The draft's last words appear in a prompt sent before (anywhere in it; a draft that is the
	 * start of one is {@link fromHistory}): what followed them there, to the end of that clause.
	 * The last word may be half typed. Longer matches first, then newer prompts.
	 */
	fromPhrase(draft: string): { readonly text: string; readonly confidence: number } | undefined {
		const tail = draft.slice(-160);
		if (/\n\s*$/.test(tail)) {
			return undefined;
		}
		const words = tokens(tail);
		const partial = /[\p{L}\p{N}_'-]$/u.test(tail);
		for (let n = Math.min(6, words.length); n >= 3; n--) {
			const phrase = words.slice(-n);
			const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${phrase.map(escapeRegExp).join('[^\\p{L}\\p{N}_]+')}${partial ? '' : '(?![\\p{L}\\p{N}_])'}`, 'iu');
			for (const prompt of this.prompts) {
				const match = pattern.exec(prompt);
				if (!match) {
					continue;
				}
				let rest = prompt.slice(match.index + match[0].length);
				const stop = rest.search(/[.!?\n]/);
				if (stop >= 0) {
					rest = rest.slice(0, stop + (rest[stop] === '\n' ? 0 : 1));
				}
				if (!partial) {
					// The draft already ends with its own punctuation and space (`fix the bug, `).
					rest = rest.replace(/^[^\p{L}\p{N}_]+/u, '');
					rest = /\s$/.test(tail) ? rest : ` ${rest}`;
				}
				rest = clipAtWord(rest.trimEnd(), MAX_HISTORY_CHARS);
				if (rest.trim().length >= 2) {
					return { text: rest, confidence: n >= 4 ? 0.8 : 0.6 };
				}
			}
		}
		return undefined;
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
		// Keep what the user typed; take the rest from the remembered spelling, unless that was
		// shouted (`TEST WINDOW`) and the user types in lowercase.
		const shouted = spelled.length > 1 && spelled === spelled.toUpperCase() && partial === partial.toLowerCase();
		const rest = (shouted ? spelled.toLowerCase() : spelled).slice(partial.length);
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

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
	'When the text stops inside a word, start with the rest of that word; after a finished word, start with a space.',
	'Put the continuation between <insert> and </insert>, exactly as it goes into the message (a leading space counts): no quotes, no preamble, never an answer to the message.',
	'Nothing outside the tags is used. If no continuation is likely, reply <insert></insert>.',
	`Examples: \`rename the var${COMPOSER_CURSOR}\` -> <insert>iable to userCount</insert>; \`now run the${COMPOSER_CURSOR}\` -> <insert> tests again</insert>; \`can you check ${COMPOSER_CURSOR}\` -> <insert>why the build fails</insert>.`,
].join(' ');

export interface IComposerPromptInput {
	readonly draft: string;
	readonly after: string;
	readonly transcript: readonly string[];
	readonly vocabulary: readonly string[];
	readonly clipboard?: string;
	readonly activity?: readonly string[];
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
	if (input.activity?.length) {
		blocks.push(`## What the agent and the terminals are doing\n${input.activity.slice(-8).join('\n')}`);
	}
	const clipboard = input.clipboard?.trim();
	if (clipboard && clipboard.length <= 600) {
		blocks.push(`## Clipboard\n${clipboard}`);
	}
	blocks.push(`## The message being typed\n${input.draft}${COMPOSER_CURSOR}${input.after}`);
	blocks.push(`Continue at ${COMPOSER_CURSOR}. Reply with <insert>the continuation</insert> only.`);
	return [
		{ role: 'system', content: COMPOSER_SYSTEM_PROMPT, ephemeral: true },
		{ role: 'user', content: blocks.join('\n\n'), ephemeral: true },
	];
}

/** Words that are rarely the end of a longer one: after a whole word, a reply starting with one starts a new word. */
const STANDALONE_WORD = /^(the|a|an|and|or|but|to|in|on|at|of|for|with|from|by|it|its|this|that|these|those|is|are|was|be|so|if|then|than|when|all|my|your|our|their|them|me|us|you|we|they|not|no|now|also|too|again|please|instead|before|after|into)\b/i;

/** A reply about the task rather than the continuation (`Sure, ...`, `Here is ...`). Words like "make sure" stay valid. */
const META_REPLY = /^((sure|okay|ok)[,!.]|here('s| is| are)\b|(continuation|completion)\s*:|i (can|will|would|cannot|can't) (help|continue|complete)\b|as an ai\b|based on (the|your) (message|conversation|context)\b)/i;

/**
 * A model reply turned into ghost text for `draft`: one line, without an echo of what was typed,
 * cut after the sentence it finishes. Undefined when nothing usable is left.
 */
export function cleanComposerCompletion(raw: string, draft: string, vocabulary: readonly string[] = []): string | undefined {
	// Between the insert tags when there are any: the leading space of a new word survives there.
	const reply = stripSpecialTokens(raw.replace(/\r\n/g, '\n'));
	let text = stripSpecialTokens(stripFences(taggedInsert(reply) ?? reply));
	if (isToolCallJunk(text)) {
		return undefined;
	}
	// An HTML line break (`st<br>`) is a line break.
	text = text.split(COMPOSER_CURSOR).join('').replace(/<br\s*\/?>/gi, '\n');
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
		// No space first is the rest of the unfinished word (`bu` + `g in ...`), unless a whole word
		// was typed and the reply starts a common word of its own (`commit` + `the changes`).
		const partial = /[\p{L}\p{N}_]+$/u.exec(draft)?.[0];
		if (partial && partial.length >= 3 && STANDALONE_WORD.test(text)) {
			text = ` ${text}`;
		}
	}
	if (contradictsName(draft, text, vocabulary)) {
		return undefined;
	}
	if (/\s$/.test(draft)) {
		text = dropRestatedLastWord(text.replace(/^\s+/, ''), draft);
	}
	// A quote the draft never opened (`fix the bu` -> `bug" in ...`).
	if (countOf(text, '"') % 2 === 1 && countOf(draft, '"') % 2 === 0) {
		text = text.replace(/"/g, '');
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

/**
 * The word being typed starts a name from the chat (`agentCompo` -> `agentComposerChips.ts`) but
 * the reply finishes it as another word (`agentComponent`): the local completion is right.
 */
function contradictsName(draft: string, text: string, vocabulary: readonly string[]): boolean {
	const partial = /[\p{L}\p{N}_]+$/u.exec(draft)?.[0];
	if (!partial || partial.length < 3) {
		return false;
	}
	const word = partial + (/^[\p{L}\p{N}_]*/u.exec(text)?.[0] ?? '');
	const names = vocabulary.flatMap(entry => entry.match(NAME) ?? []).map(name => /^[\p{L}\p{N}_$]*/u.exec(name)![0]).filter(name => name.length > partial.length && name.startsWith(partial));
	return names.length > 0 && !names.some(name => name === word || name.startsWith(word) && word.length > partial.length);
}

/** After a space, a reply that starts with the draft's last word again (`test for ` + `for clamp`) loses it. */
function dropRestatedLastWord(text: string, draft: string): string {
	const last = /([\p{L}\p{N}_'-]+)[^\S\n]+$/u.exec(draft)?.[1];
	if (!last || !text.toLowerCase().startsWith(last.toLowerCase()) || /[\p{L}\p{N}_]/u.test(text[last.length] ?? '')) {
		return text;
	}
	return text.slice(last.length).replace(/^\s+/, '');
}

function countOf(text: string, ch: string): number {
	return text.split(ch).length - 1;
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
