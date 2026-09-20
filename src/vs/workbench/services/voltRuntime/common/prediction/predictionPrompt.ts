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

/** Total character budget for the user prompt; blocks are dropped lowest-value-first. */
export const PROMPT_CHAR_BUDGET = 12_000;

function contextBlocks(ctx: IPredictionContext): string[] {
	const blocks: string[] = [];
	if (ctx.clipboard?.trim()) {
		blocks.push(`## Clipboard\n${ctx.clipboard.trim()}`);
	}
	if (ctx.recentEdits.length) {
		const edits = ctx.recentEdits.slice(-8).map(e => {
			const removed = e.removed ? `-${e.removed.replace(/\n/g, '\n-')}` : '';
			const inserted = e.inserted ? `+${e.inserted.replace(/\n/g, '\n+')}` : '';
			return `${e.uri.path}:${e.startLineNumber}\n${[removed, inserted].filter(Boolean).join('\n')}`;
		});
		blocks.push(`## Recent edits (oldest first)\n${edits.join('\n---\n')}`);
	}
	if (ctx.diagnostics.length) {
		blocks.push(`## Diagnostics near the cursor\n${ctx.diagnostics.slice(0, 6).join('\n')}`);
	}
	if (ctx.imports) {
		blocks.push(`## Imports of the current file\n${ctx.imports}`);
	}
	for (const sibling of ctx.siblings.slice(0, 3)) {
		blocks.push(`## Related open file: ${sibling.path}\n${sibling.excerpt}`);
	}
	return blocks;
}

/** Assembles blocks + the (mandatory) excerpt under PROMPT_CHAR_BUDGET. */
function assemble(excerptBlock: string, blocks: string[], instruction: string): string {
	const parts: string[] = [];
	let used = excerptBlock.length + instruction.length;
	for (const block of blocks) {
		if (used + block.length > PROMPT_CHAR_BUDGET) {
			continue;
		}
		parts.push(block);
		used += block.length;
	}
	parts.push(excerptBlock);
	parts.push(instruction);
	return parts.join('\n\n');
}

export function buildInlinePrompt(ctx: IPredictionContext): IModelMessage[] {
	const system = [
		'You are a fill-in-the-middle code completion engine. You output source code only.',
		`Insert code at ${CURSOR_MARKER}. Your entire reply is that insertion - no English, no markdown, no fences, no quotes, no apology.`,
		'Do not repeat code already left of the cursor. Match indentation and style.',
		'If the name is new, invent a short expression that type-checks against nearby code (a call, literal, or identifier).',
		'If you truly cannot complete, reply with exactly the empty string. Never write a sentence.',
	].join(' ');

	const excerpt = `## Current file: ${ctx.uri.path} (${ctx.languageId})\n${ctx.prefix}${CURSOR_MARKER}${ctx.suffix}`;
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: assemble(excerpt, contextBlocks(ctx), `CODE ONLY. Complete at ${CURSOR_MARKER}. Reply with the insertion and nothing else.`) },
	];
}

export const NES_JSON_SHAPE = '{"confidence": 0..1, "edits": [{"path": string, "startLine": number, "startColumn": number, "endLine": number, "endColumn": number, "replacement": string, "reason": string}]}';

export function buildNextEditPrompt(ctx: IPredictionContext, intent?: string): IModelMessage[] {
	const system = [
		'You are a next-edit prediction engine inside an editor.',
		'Given the user\'s recent edits, diagnostics, and code, predict the edits the user will make next.',
		`Respond with ONLY a JSON object of this exact shape: ${NES_JSON_SHAPE}.`,
		'Lines and columns are 1-based and refer to the CURRENT text of each file.',
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
