/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { truncateAtWord } from './agentHistoryLog.js';

/**
 * Chat titles written by a model from the first message, the way T3 Code and OpenCode do it:
 * one small, tool-less call that runs beside the agent's first turn. The sidebar shows the
 * first-line title until it lands.
 */

const MAX_TITLE_LENGTH = 48;
/** Head and tail of a long first message; the middle is usually pasted logs or code. */
const MAX_INPUT_CHARS = 3000;

const TITLE_INSTRUCTIONS = [
	'You name coding chats so the user can find this one again weeks later in a sidebar list.',
	'Reply with the title only: one line, no quotes, no trailing period, no preamble.',
	'',
	'Rules:',
	'- 2 to 6 words, under 40 characters, sentence case.',
	'- Name the subject and the goal (what is being built, fixed or asked), not the user\'s wording.',
	'- Do not copy and truncate the message. Drop filler such as "please", "can you", "I want".',
	'- Keep exact names that identify the work: files, components, commands, error names.',
	'- Use the language the user wrote in.',
	'- Attached images usually show the UI being discussed; name that UI.',
	'- If the message is only a greeting or has no clear subject, reply with a short neutral title such as "Quick question".',
	'',
	'Examples:',
	'"the borders on the run command card look doubled, polish it" -> Run command card border fix',
	'"why does npm test hang on CI but not locally" -> CI test hang investigation',
	'"add oauth login with github to the settings page" -> GitHub OAuth login in settings',
].join('\n');

/** The whole prompt for one title. `attachments` are file or image names the user attached. */
export function buildTitlePrompt(message: string, attachments: readonly string[] = []): string {
	const text = clipMiddle(stripAttachmentLines(message), MAX_INPUT_CHARS);
	const parts = [TITLE_INSTRUCTIONS, '', 'User message:', text || '(no text)'];
	if (attachments.length) {
		parts.push('', `Attached: ${attachments.slice(0, 6).join(', ')}`);
	}
	return parts.join('\n');
}

/** A model's reply turned into a sidebar title, or undefined when nothing usable came back. */
export function sanitizeTitle(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	const withoutThinking = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
	let line = withoutThinking.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
	const json = /^\{[\s\S]*"title"\s*:\s*"([^"]+)"/.exec(line);
	if (json) {
		line = json[1];
	}
	line = line
		.replace(/^(?:\*\*)?title(?:\*\*)?\s*:\s*/i, '')
		.replace(/^[#>*\-\s]+/, '')
		.replace(/\*\*/g, '')
		.replace(/^["'`“‘]+|["'`”’]+$/g, '')
		.replace(/\s+/g, ' ')
		.replace(/[.!\s]+$/, '')
		.trim();
	if (!line || /^(new (chat|thread)|untitled)$/i.test(line)) {
		return undefined;
	}
	return truncateAtWord(line.charAt(0).toUpperCase() + line.slice(1), MAX_TITLE_LENGTH);
}

/**
 * The one-shot command an agent CLI runs a title through, or undefined when that agent has no
 * cheap print mode. Each one runs with no tools, no hooks and no saved session. `model` is a
 * model the user pinned for text generation; without one each CLI uses its cheapest default.
 */
export function titleCommandFor(providerId: string, command: string | undefined, prompt: string, model?: string): readonly string[] | undefined {
	switch (providerId) {
		case 'claude-code':
			return [command || 'claude', '-p', '--model', model || 'haiku', '--output-format', 'text', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', prompt];
		case 'codex':
			return [command || 'codex', 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', 'model_reasoning_effort="low"', ...(model ? ['-m', model] : []), prompt];
		case 'cursor-acp':
			return [command || 'cursor-agent', '-p', '--output-format', 'text', '--mode', 'ask', ...(model ? ['--model', model] : []), prompt];
		default:
			return undefined;
	}
}

/** Drops the `[Image #1 "a.png" is saved at: /path]` lines the composer adds for agents. */
function stripAttachmentLines(text: string): string {
	return text
		.replace(/^\[(?:Image|Video|File)\b[^\]\n]*\bsaved at:[^\]\n]*\]\s*$/gim, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function clipMiddle(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const half = Math.floor((max - 5) / 2);
	return `${text.slice(0, half)}\n...\n${text.slice(-half)}`;
}
