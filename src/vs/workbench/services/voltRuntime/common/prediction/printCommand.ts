/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelMessage } from '../providers.js';

/**
 * The one-shot command an agent CLI answers a prediction through, the way chat titles run
 * (`titleCommandFor`): print mode, no tools, no hooks, no saved session, and for Claude the
 * prediction's own short system prompt in place of the agent's. Nothing carries over between
 * requests, so every ghost text costs one small prompt. Undefined when the agent has no print mode;
 * the caller then uses an agent session instead. `model` undefined: the CLI's cheapest default.
 */
export function predictionCommandFor(providerId: string, command: string | undefined, messages: readonly IModelMessage[], model?: string): readonly string[] | undefined {
	const { system, user } = splitPrompt(messages);
	const combined = system ? `${system}\n\n${user}` : user;
	switch (providerId) {
		case 'claude-code':
			return [
				command || 'claude', '-p', '--model', model || 'haiku', '--output-format', 'text',
				...claudeQuietFlags(system),
				user,
			];
		case 'codex':
			return [command || 'codex', 'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', 'model_reasoning_effort="low"', ...(model ? ['-m', model] : []), combined];
		case 'cursor-acp':
			return [command || 'cursor-agent', '-p', '--output-format', 'text', '--mode', 'ask', ...(model ? ['--model', model] : []), combined];
		default:
			return undefined;
	}
}

/**
 * The same Claude call with the prompt read from stdin as one stream-json message, so the process
 * can be started before the request and its start-up (about two seconds) is off the critical path.
 * Undefined for agents without that mode.
 */
export function warmPredictionCommandFor(providerId: string, command: string | undefined, messages: readonly IModelMessage[], model?: string): { readonly argv: readonly string[]; readonly input: string } | undefined {
	if (providerId !== 'claude-code') {
		return undefined;
	}
	const { system, user } = splitPrompt(messages);
	return {
		argv: [
			command || 'claude', '-p', '--model', model || 'haiku',
			'--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
			...claudeQuietFlags(system),
		],
		input: `${JSON.stringify({ type: 'user', message: { role: 'user', content: user } })}\n`,
	};
}

function splitPrompt(messages: readonly IModelMessage[]): { system: string; user: string } {
	return {
		system: messages.filter(message => message.role === 'system').map(message => message.content).filter(Boolean).join('\n\n'),
		user: messages.filter(message => message.role !== 'system').map(message => message.content).filter(Boolean).join('\n\n'),
	};
}

/**
 * No tools, hooks, MCP servers or saved session, and the prediction's own system prompt. Low
 * effort: otherwise Haiku thinks for up to a second and a half before writing a few characters.
 */
function claudeQuietFlags(system: string): string[] {
	return [
		'--effort', 'low',
		...(system ? ['--system-prompt', system] : []),
		'--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--settings', '{"disableAllHooks":true}',
	];
}
