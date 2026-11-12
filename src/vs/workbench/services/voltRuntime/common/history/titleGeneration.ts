/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMarkupOnlyTitle, truncateAtWord } from './agentHistoryLog.js';

/**
 * Chat titles written by a model from the first message, the way T3 Code and OpenCode do it:
 * one small, tool-less call that runs beside the agent's first turn. A CLI agent's title call
 * (a process start) waits for the turn's first reply text, so it never slows the turn's startup.
 * The sidebar shows the first-line title until it lands. A first message that names little
 * ("hi", "fix this") is titled again, once, from the first two messages.
 */

const MAX_TITLE_LENGTH = 56;
/** Head and tail of a long first message; the middle is usually pasted logs or code. */
const MAX_INPUT_CHARS = 3000;
/** A first message with fewer words names too little to title the chat by. */
const VAGUE_MESSAGE_WORDS = 4;
/** What the model answers for a message with no subject (see the prompt), lowercased. */
const NEUTRAL_TITLES = new Set(['quick question', 'general question', 'quick chat', 'greeting', 'small talk', 'new task', 'help request']);

const TITLE_INSTRUCTIONS = [
	'You name coding chats so the user can find this one again weeks later in a sidebar list.',
	'Reply with the title only: one line, no quotes, no trailing period, no preamble.',
	'',
	'Rules:',
	'- Say what the task is. For a work request, start with a verb (Fix, Add, Speed up, Refactor, Debug, Explain, Compare, Write) and name the specific thing (component, file, command, error, feature) and the goal.',
	'- For a question, name what is asked, such as "How the stash restores chats" or "Why npm test hangs on CI".',
	'- 3 to 7 words, under 50 characters, sentence case.',
	'- When the message asks for several things, title the main task (the first or the largest), not a list.',
	'- Do not copy and truncate the message. Drop filler such as "please", "can you", "I want".',
	'- Keep exact names that identify the work: files, components, commands, error names.',
	'- Use the language the user wrote in.',
	'- Attached images usually show the UI being discussed; name that UI.',
	'- Given a first and a latest message, title the task they set together; a short first message often makes sense only with the latest.',
	'- If the message is only a greeting or has no clear subject, reply with a short neutral title such as "Quick question".',
	'',
	'Examples:',
	'"the borders on the run command card look doubled, polish it" -> Fix doubled run command card borders',
	'"npm test hangs on CI but not locally, find out why" -> Debug npm test hang on CI',
	'"add oauth login with github to the settings page" -> Add GitHub OAuth login to settings',
	'"how does the stash restore chats after a reload?" -> How the stash restores chats',
	'"rename getUser to fetchUser everywhere, then update the README and bump the version" -> Rename getUser to fetchUser',
	'"ok so whenever a chat finishes the sidebar list jumps back to the top, really annoying when I am scrolled down reading older chats, maybe the title update does it, not sure, can you look" -> Fix sidebar list jumping to top',
	'"hey" -> Quick question',
].join('\n');

/**
 * The whole prompt for one title. `messages` is the first message, or the first and the latest
 * when the first named little. `attachments` are file or image names the user attached.
 */
export function buildTitlePrompt(messages: string | readonly string[], attachments: readonly string[] = []): string {
	const [first = '', ...rest] = typeof messages === 'string' ? [messages] : messages;
	const parts = [TITLE_INSTRUCTIONS, ''];
	if (rest.length) {
		// The first message is short when it named little; the latest gets the room it leaves.
		const head = clipMiddle(stripAttachmentLines(first), MAX_INPUT_CHARS / 2);
		const latest = clipMiddle(stripAttachmentLines(rest[rest.length - 1]), MAX_INPUT_CHARS - head.length);
		parts.push('First message:', head || '(no text)', '', 'Latest message:', latest || '(no text)');
	} else {
		parts.push('User message:', clipMiddle(stripAttachmentLines(first), MAX_INPUT_CHARS) || '(no text)');
	}
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
		.replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019]+$/g, '')
		.replace(/\s+/g, ' ')
		.replace(/[.!\s]+$/, '')
		.trim();
	if (!line || /^(new (chat|thread)|untitled)$/i.test(line) || isMarkupOnlyTitle(line)) {
		return undefined;
	}
	return truncateAtWord(line.charAt(0).toUpperCase() + line.slice(1), MAX_TITLE_LENGTH);
}

/** A message too short to say what the chat is about ("hi", "continue", "fix this" under an image). */
export function isVagueMessage(message: string): boolean {
	const words = message
		// Attachment chips: `[Image #1: a.png]`, `[Image #1 "a.png" is saved at: /path]`.
		.replace(/\[(?:Image|Video|File)\b[^\]\n]*\]/g, ' ')
		.split(/\s+/)
		.filter(word => /[\p{L}\p{N}]/u.test(word));
	return words.length < VAGUE_MESSAGE_WORDS;
}

/** A title the prompt gives a message with no subject, such as "Quick question". */
export function isNeutralTitle(title: string): boolean {
	return NEUTRAL_TITLES.has(title.trim().toLowerCase());
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
