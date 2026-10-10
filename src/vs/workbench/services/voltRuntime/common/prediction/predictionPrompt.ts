/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelMessage } from '../providers.js';
import { IPredictionContext } from '../prediction.js';

/**
 * Prompt builders for chat models (we do not ship a bespoke FIM/Zeta model; the selected
 * chat/local model does the work). Kept pure for unit testing.
 *
 * Shapes borrowed from Zed's edit-prediction providers: cursor marker in an editable
 * excerpt, recent edits as diffs, diagnostics inline, related files as separate blocks.
 */

export const CURSOR_MARKER = '<|cursor|>';

/** A line that ends here opens a block (or an argument list) whose body goes on the next lines. */
export const OPENS_BLOCK = /([:{([]|=>|\b(?:do|then))\s*$/;

/** Code (not only closers) follows the cursor on its line. */
export function hasCodeAfter(lineSuffix: string): boolean {
	return !!lineSuffix.trim() && !/^[\s)\]}>"'`;,]*$/.test(lineSuffix);
}

/**
 * Only the rest of the cursor's line is worth predicting: code follows the cursor (a pure insert
 * cannot span it), or a statement is being finished that opens no block. On an empty line, or at
 * the end of `if (x) {`, the lines that follow are wanted too.
 */
export function singleLineScope(linePrefix: string, lineSuffix: string): boolean {
	return !!linePrefix.trim() && (hasCodeAfter(lineSuffix) || !OPENS_BLOCK.test(linePrefix));
}

/** Total character budget for the user prompt; blocks are dropped lowest-value-first. */
export const PROMPT_CHAR_BUDGET = 12_000;

/** Ghost text runs on every pause in typing: about 1.8k tokens all in. */
export const INLINE_PROMPT_CHAR_BUDGET = 7_000;

interface IBlockLimits {
	readonly clipboardChars: number;
	readonly recentEdits: number;
	readonly editChars: number;
	/** Ghost text: edits the excerpt already shows are left out (the cursor's own typing, mostly). */
	readonly inline: boolean;
}

const NES_LIMITS: IBlockLimits = { clipboardChars: 2_000, recentEdits: 8, editChars: 400, inline: false };
const INLINE_LIMITS: IBlockLimits = { clipboardChars: 600, recentEdits: 4, editChars: 160, inline: true };

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/** A context block and how much it is worth when the budget runs short (higher stays longer). */
interface IBlock {
	readonly text: string;
	readonly priority: number;
}

/**
 * The context blocks in prompt order: what changes least first (definitions, related code,
 * imports), what changes on every keystroke last (recent edits), so providers that cache prompt
 * prefixes (OpenAI, DeepSeek, Gemini) reuse everything up to the first block that changed.
 */
function contextBlocks(ctx: IPredictionContext, limits: IBlockLimits = NES_LIMITS): IBlock[] {
	const blocks: IBlock[] = [];
	if (ctx.definitions?.length) {
		blocks.push({ text: `## Definitions of names near the cursor\n${ctx.definitions.join('\n')}`, priority: 5 });
	}
	ctx.siblings.slice(0, 3).forEach((sibling, i) => {
		blocks.push({ text: `## Related open file: ${sibling.path}\n${sibling.excerpt}`, priority: 1 - i * 0.1 });
	});
	if (ctx.imports) {
		blocks.push({ text: `## Imports of the current file\n${ctx.imports}`, priority: 2 });
	}
	if (ctx.running?.length) {
		blocks.push({ text: `## Terminal\n${ctx.running.join('\n')}`, priority: 2.5 });
	}
	if (ctx.clipboard?.trim()) {
		blocks.push({ text: `## Clipboard\n${clip(ctx.clipboard.trim(), limits.clipboardChars)}`, priority: 3 });
	}
	if (ctx.diagnostics.length) {
		blocks.push({ text: `## Diagnostics near the cursor\n${ctx.diagnostics.slice(0, 6).join('\n')}`, priority: 6 });
	}
	const visible = limits.inline ? ctx.excerptLines : undefined;
	const edits = visible
		? ctx.recentEdits.filter(e => e.uri.toString() !== ctx.uri.toString() || e.startLineNumber < visible.start || e.startLineNumber > visible.end)
		: ctx.recentEdits;
	if (edits.length) {
		const rendered = edits.slice(-limits.recentEdits).map(e => {
			const removed = e.removed ? `-${clip(e.removed, limits.editChars).replace(/\n/g, '\n-')}` : '';
			const inserted = e.inserted ? `+${clip(e.inserted, limits.editChars).replace(/\n/g, '\n+')}` : '';
			return `${e.uri.path}:${e.startLineNumber}\n${[removed, inserted].filter(Boolean).join('\n')}`;
		});
		blocks.push({ text: `## Recent edits (oldest first)\n${rendered.join('\n---\n')}`, priority: 4 });
	}
	return blocks;
}

/**
 * Assembles blocks + the (mandatory) excerpt under `budget`. Blocks are kept by priority until the
 * budget is spent, then written in their own order.
 */
function assemble(excerptBlock: string, blocks: IBlock[], instruction: string, budget = PROMPT_CHAR_BUDGET): string {
	let used = excerptBlock.length + instruction.length;
	const kept = new Set<IBlock>();
	for (const block of [...blocks].sort((a, b) => b.priority - a.priority)) {
		if (used + block.text.length + 2 > budget) {
			continue;
		}
		kept.add(block);
		used += block.text.length + 2;
	}
	return [...blocks.filter(block => kept.has(block)).map(block => block.text), excerptBlock, instruction].join('\n\n');
}

export const INLINE_SYSTEM_PROMPT = [
	'You are a fill-in-the-middle code completion engine. You output source code only.',
	`Insert code at ${CURSOR_MARKER}. Put the insertion between <insert> and </insert>, exactly as it goes into the file: a leading space, line break or indentation counts. Inside the tags: no English, no markdown, no fences, no quotes, no apology.`,
	'Nothing outside the tags is used. Do not repeat code already left of the cursor or the code that follows it. Match indentation and style.',
	'Finish the current statement; continue onto the next lines only when the code there is obvious, and stop at the end of the current block.',
	'If the name is new, invent a short expression that type-checks against nearby code (a call, literal, or identifier).',
	'If you truly cannot complete, reply <insert></insert>. Never write a sentence.',
].join(' ');

/**
 * What the cursor is in: code, a document written as text (Markdown, plain text, a commit message),
 * or a comment inside code. Text and comments are continued as writing, not as code.
 */
export type InlineWriting = 'code' | 'prose' | 'comment';

const PROSE_LANGUAGES = new Set(['markdown', 'mdx', 'plaintext', 'text', 'latex', 'tex', 'bibtex', 'restructuredtext', 'asciidoc', 'org', 'git-commit', 'scminput']);
/** Languages whose line comments start with `#`; elsewhere `#` is a preprocessor line or a selector. */
const HASH_COMMENT_LANGUAGES = new Set(['python', 'shellscript', 'ruby', 'yaml', 'perl', 'r', 'powershell', 'makefile', 'dockerfile', 'toml', 'coffeescript', 'elixir', 'julia', 'nim', 'properties', 'cmake', 'graphql', 'ignore', 'dotenv', 'terraform', 'hcl']);
/** Languages whose line comments start with `--`. */
const DASH_COMMENT_LANGUAGES = new Set(['sql', 'lua', 'haskell', 'ada', 'elm', 'purescript']);

export function inlineWritingKind(languageId: string, linePrefix: string): InlineWriting {
	if (PROSE_LANGUAGES.has(languageId)) {
		return 'prose';
	}
	return commentStart(languageId, linePrefix) >= 0 ? 'comment' : 'code';
}

/** Where a line comment (or a block comment's continuation line) starts before the cursor, or -1. */
function commentStart(languageId: string, linePrefix: string): number {
	// ` * text` and `/** text` lines of a block comment.
	if (/^\s*(\/\*+|\*(?!\/))(\s|$)/.test(linePrefix)) {
		return linePrefix.search(/\S/);
	}
	const hash = HASH_COMMENT_LANGUAGES.has(languageId);
	const dash = DASH_COMMENT_LANGUAGES.has(languageId);
	let quote: string | undefined;
	for (let i = 0; i < linePrefix.length; i++) {
		const ch = linePrefix[i];
		if (quote) {
			if (ch === '\\') {
				i++;
			} else if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
		} else if (hash ? ch === '#' && (i === 0 || /\s/.test(linePrefix[i - 1])) && linePrefix[i + 1] !== '!'
			: dash ? ch === '-' && linePrefix[i + 1] === '-'
				: ch === '/' && linePrefix[i + 1] === '/' && linePrefix[i - 1] !== ':') {
			return i;
		}
	}
	return -1;
}

export function buildInlinePrompt(ctx: IPredictionContext, writing: InlineWriting = inlineWritingKind(ctx.languageId, ctx.linePrefix)): IModelMessage[] {
	if (writing !== 'code') {
		return buildWritingPrompt(ctx, writing);
	}
	const excerpt = `## Current file: ${ctx.uri.path} (${ctx.languageId})\n${ctx.prefix}${CURSOR_MARKER}${ctx.suffix}`;
	// Saying how much is wanted saves the lines that would be cut anyway (and the wait for them).
	const scope = singleLineScope(ctx.linePrefix, ctx.lineSuffix)
		? 'Finish the current line only.'
		: 'Write the lines that obviously come next, up to the end of the current block.';
	return [
		{ role: 'system', content: INLINE_SYSTEM_PROMPT, ephemeral: true },
		{ role: 'user', content: assemble(excerpt, contextBlocks(ctx, INLINE_LIMITS), `CODE ONLY. Complete at ${CURSOR_MARKER}. ${scope} Reply with <insert>the inserted code</insert> only.`, INLINE_PROMPT_CHAR_BUDGET), ephemeral: true },
	];
}

export const WRITING_SYSTEM_PROMPT = [
	'You are the autocomplete of a text editor. Continue the text exactly at ' + CURSOR_MARKER + ', as its writer would.',
	'If the text stops inside a word, finish the word and go on; after a space, write the next words; on an empty line, write the next line the way the lines above go (the next list item, the text under a heading, the next sentence).',
	'Stop at the end of the sentence, or at the end of the line in a list or a heading.',
	'Match the language, tone, casing, punctuation and formatting of the document, and stay on its subject.',
	'Put the inserted text between <insert> and </insert>, exactly as it goes into the document: no quotes, no fences. Never repeat the text before the cursor.',
	'Nothing outside the tags is used. If nothing fits, reply <insert></insert>.',
	'Examples: `red\ngreen\n' + CURSOR_MARKER + '` -> <insert>blue</insert>. `We ship on Fri' + CURSOR_MARKER + '` -> <insert>day, after the review.</insert> `Monday\nTuesday' + CURSOR_MARKER + '` -> <insert>\nWednesday</insert>',
].join(' ');

/** Small models misjudge where in a word the cursor is: say it. */
function cursorSituation(linePrefix: string): string {
	if (!linePrefix.trim()) {
		return 'The cursor is at the start of a line.';
	}
	const word = /[\p{L}\p{N}_'-]+$/u.exec(linePrefix)?.[0];
	return word
		? `The cursor is at the end of the word \`${word}\`. If it is cut off, finish it. If the line is complete (a list item, a heading, a finished sentence), reply with a line break and then the whole next line; otherwise go on with a space and the next word.`
		: 'The cursor is after a space or punctuation: start the next word.';
}

/** Markdown, plain text and code comments: the writing around the cursor, continued as writing. */
function buildWritingPrompt(ctx: IPredictionContext, writing: 'prose' | 'comment'): IModelMessage[] {
	const what = writing === 'comment'
		? `## Comment being written in ${ctx.uri.path} (${ctx.languageId}). Continue the comment only, on its line, never code.`
		: `## Document: ${ctx.uri.path} (${ctx.languageId})`;
	const excerpt = `${what}\n${ctx.prefix}${CURSOR_MARKER}${ctx.suffix}`;
	const blocks = contextBlocks({ ...ctx, diagnostics: [], imports: writing === 'comment' ? ctx.imports : '', definitions: writing === 'comment' ? ctx.definitions : undefined, running: undefined }, INLINE_LIMITS);
	return [
		{ role: 'system', content: WRITING_SYSTEM_PROMPT, ephemeral: true },
		{ role: 'user', content: assemble(excerpt, blocks, `Continue at ${CURSOR_MARKER}. ${cursorSituation(ctx.linePrefix)} Reply with <insert>the inserted text</insert> only.`, INLINE_PROMPT_CHAR_BUDGET), ephemeral: true },
	];
}

/**
 * Edits are anchored on text, not positions: chat models cannot count lines or columns in an
 * excerpt reliably, but they copy a line exactly. Volt finds `find` in the file itself.
 */
export const NES_JSON_SHAPE = '{"confidence": 0..1, "edits": [{"path": string, "find": string, "replace": string, "reason": string}]}';

export function buildNextEditPrompt(ctx: IPredictionContext, intent?: string): IModelMessage[] {
	const system = [
		'You are a next-edit prediction engine inside an editor.',
		'Given the user\'s recent edits, diagnostics, and code, predict the edits the user will make next.',
		`Respond with ONLY a JSON object of this exact shape: ${NES_JSON_SHAPE}.`,
		'"find" is text copied EXACTLY from the current file contents (whole lines, including indentation), long enough to be unique; it is replaced by "replace".',
		'To insert, put the line before the insertion point in "find" and repeat it at the start of "replace". Never include the cursor marker.',
		'Only include edits you are confident about. Edits must not overlap. Use the current file\'s path for local edits and relative workspace paths for other files.',
		'If no follow-up edit is likely, respond {"confidence": 0, "edits": []}.',
	].join(' ');

	const excerpt = `## Current file: ${ctx.uri.path} (${ctx.languageId})\n${ctx.prefix}${CURSOR_MARKER}${ctx.suffix}`;
	const instruction = intent
		? `Apply this instruction and return the edits as JSON: ${intent}`
		: `Predict the user's next edits and return them as JSON.`;
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: assemble(excerpt, contextBlocks(ctx), instruction) },
	];
}
