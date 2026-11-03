/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface CodingAgent {
	readonly id: string;
	readonly name: string;
	readonly email?: string;
}

interface CodingAgentMatcher {
	readonly id: string;
	readonly name: string;
	readonly matches: (name: string, email: string) => boolean;
}

// Order matters: the first matcher that accepts a trailer wins.
const CODING_AGENT_MATCHERS: readonly CodingAgentMatcher[] = [
	// A person named Claude ("Claude Monet") is not the agent: only its own trailer names, or Anthropic's email.
	{ id: 'claude', name: 'Claude', matches: (name, email) => /^claude(\s+(code|agent|opus|sonnet|haiku|fable|\d)\b.*)?$/.test(name) || email.endsWith('@anthropic.com') },
	{ id: 'cursor', name: 'Cursor', matches: (name, email) => email === 'cursoragent@cursor.com' || name === 'cursor' || name === 'cursor agent' },
	{ id: 'copilot', name: 'GitHub Copilot', matches: (name, email) => name.includes('copilot') || email.includes('copilot@users.noreply.github.com') },
	{ id: 'codex', name: 'Codex', matches: (name, email) => name.includes('codex') || email.endsWith('@openai.com') },
	{ id: 'gemini', name: 'Gemini', matches: (name, email) => name.includes('gemini') || (email.endsWith('@google.com') && email.includes('gemini')) },
	{ id: 'devin', name: 'Devin', matches: (name, email) => name.includes('devin-ai') || name === 'devin' || name === 'devin ai' || email.endsWith('@cognition.ai') || email.endsWith('@cognition-labs.com') || email.includes('devin-ai-integration') },
	{ id: 'aider', name: 'Aider', matches: (name, email) => name.startsWith('aider') || email.endsWith('@aider.chat') },
	{ id: 'grok', name: 'Grok', matches: (name, email) => name.includes('grok') || email.endsWith('@x.ai') },
	{ id: 'opencode', name: 'OpenCode', matches: (name, email) => name.includes('opencode') || email.endsWith('@opencode.ai') || email.endsWith('@sst.dev') },
	{ id: 'amp', name: 'Amp', matches: (name, email) => name === 'amp' || name.startsWith('amp ') || email.endsWith('ampcode.com') },
	{ id: 'jules', name: 'Jules', matches: (name, email) => (name === 'jules' && email.includes('google')) || name.includes('google-labs-jules') || (email.includes('jules') && email.includes('google')) },
	{ id: 'windsurf', name: 'Windsurf', matches: (name, email) => name.includes('windsurf') || name.includes('cascade') || email.endsWith('@windsurf.com') || email.endsWith('@codeium.com') },
	{ id: 'volt', name: 'Volt', matches: (name, email) => name === 'volt' || name.startsWith('volt ') || name.startsWith('volt agent') || email.endsWith('@volt.dev') || email.startsWith('volt@') || email.startsWith('voltagent@') },
];

// `Co-authored-by: Name <email>` (the email part is optional), on its own line
const CO_AUTHORED_BY_REGEX = /^[ \t]*co-authored-by[ \t]*:[ \t]*(.*?)[ \t]*(?:<([^>\r\n]*)>)?[ \t]*$/gim;

/**
 * Finds the coding agents credited in the `Co-authored-by:` trailers of a commit message.
 * Only trailers count as evidence. Agents are deduplicated and returned in trailer order.
 */
export function detectCodingAgents(message: string): CodingAgent[] {
	if (!message || !/co-authored-by/i.test(message)) {
		return [];
	}

	const result: CodingAgent[] = [];
	const seen = new Set<string>();

	for (const match of message.matchAll(CO_AUTHORED_BY_REGEX)) {
		const rawName = match[1].trim();
		const rawEmail = match[2]?.trim();
		const name = rawName.toLowerCase();
		const email = (rawEmail ?? '').toLowerCase();

		if (!name && !email) {
			continue;
		}

		const matcher = CODING_AGENT_MATCHERS.find(m => m.matches(name, email));
		if (!matcher || seen.has(matcher.id)) {
			continue;
		}

		seen.add(matcher.id);
		result.push({ id: matcher.id, name: matcher.name, email: rawEmail || undefined });
	}

	return result;
}
