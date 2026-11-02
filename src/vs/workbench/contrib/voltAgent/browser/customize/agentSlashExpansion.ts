/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentCustomizeService, IAgentSlashItem } from './agentCustomizeService.js';

/** `/name` at the start or after white space, ending at white space or the end. */
const SLASH_TOKEN = /(^|\s)\/([A-Za-z0-9][\w.:-]*)(?=\s|$)/g;

/**
 * `/name` tokens in text written outside the composer (automation instructions, workflow node
 * prompts), sent the way the composer sends them: each known skill, command, subagent or rule
 * reads `[/name skill]` in the text (a bare leading `/name` would be taken by CLI agents for one
 * of their own commands) and its instructions follow the prompt. Unknown names, paths and
 * built-in commands stay as written.
 */
export async function expandSlashPrompt(customize: IAgentCustomizeService, text: string): Promise<string> {
	const names = new Set<string>();
	for (const match of text.matchAll(SLASH_TOKEN)) {
		names.add(match[2].toLowerCase());
	}
	if (!names.size) {
		return text;
	}
	const items = new Map<string, IAgentSlashItem>();
	for (const name of names) {
		const item = await customize.findSlashItem(name).catch(() => undefined);
		if (item && item.type !== 'builtin-command') {
			items.set(name, item);
		}
	}
	if (!items.size) {
		return text;
	}
	const replaced = text.replace(SLASH_TOKEN, (whole, lead: string, name: string) => {
		const item = items.get(name.toLowerCase());
		return item ? `${lead}[/${item.name} ${item.type}]` : whole;
	});
	// A command's `$ARGUMENTS`: the rest of the text, without the tokens.
	const args = text.replace(SLASH_TOKEN, (whole, lead: string, name: string) => items.has(name.toLowerCase()) ? lead : whole).trim();
	const blocks: string[] = [];
	for (const item of items.values()) {
		const block = await customize.resolveSlashPrompt(item, args).catch(() => undefined);
		if (block) {
			blocks.push(block);
		}
	}
	return [replaced.trim(), ...blocks].filter(Boolean).join('\n\n');
}
