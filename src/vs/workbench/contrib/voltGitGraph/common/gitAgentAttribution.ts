/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which coding agents a commit says it was written with. Only what the commit records counts:
 * `Co-authored-by:` trailers and the "Generated with Claude Code" line agents append. The author
 * name alone never makes a commit an agent's, so a person named Claude stays a person.
 */

export type GitCodingAgentId =
	| 'claude' | 'cursor' | 'codex' | 'copilot' | 'gemini' | 'grok' | 'opencode' | 'amp'
	| 'devin' | 'aider' | 'jules' | 'windsurf' | 'kimi' | 'volt' | 'agent';

export interface IGitCodingAgent {
	readonly id: GitCodingAgentId;
	/** Display name: "Claude", "GitHub Copilot". */
	readonly name: string;
	/** The trailer the attribution came from, as written in the commit. */
	readonly evidence: string;
}

interface IAgentRule {
	readonly id: GitCodingAgentId;
	readonly name: string;
	readonly test: (name: string, email: string) => boolean;
}

/**
 * First match wins: specific products before the companies that make several. Names people also
 * have (Claude, Devin, Jules, Kimi) only count as the product's own trailer name or with the
 * vendor's email, so "Claude Monet" or "Devin Smith" stay people.
 */
const RULES: readonly IAgentRule[] = [
	{ id: 'claude', name: 'Claude', test: (n, e) => /^claude(\s+(code|agent|opus|sonnet|haiku|fable|\d)\b.*)?$/i.test(n) || /@anthropic\.com$/i.test(e) },
	{ id: 'cursor', name: 'Cursor', test: (n, e) => /^cursor( agent)?$/i.test(n) || /@cursor\.(com|sh)$/i.test(e) },
	{ id: 'copilot', name: 'GitHub Copilot', test: (n, e) => /copilot/i.test(n) || /copilot@users\.noreply\.github\.com$/i.test(e) },
	{ id: 'codex', name: 'Codex', test: (n, e) => /\bcodex\b/i.test(n) || /@openai\.com$/i.test(e) },
	{ id: 'jules', name: 'Jules', test: (n, e) => (/^jules$/i.test(n) && /google/i.test(e)) || /google-labs-jules/i.test(n) },
	{ id: 'gemini', name: 'Gemini', test: (n, e) => /^gemini(\s+(code|cli|agent|\d)\b.*)?$/i.test(n) || (/gemini/i.test(e) && /google/i.test(e)) },
	{ id: 'grok', name: 'Grok', test: (n, e) => /^grok(\s+(code|build|\d)\b.*)?$/i.test(n) || /@x\.ai$/i.test(e) },
	{ id: 'opencode', name: 'OpenCode', test: (n, e) => /\bopencode\b/i.test(n) || /@(opencode\.ai|sst\.dev)$/i.test(e) },
	{ id: 'amp', name: 'Amp', test: (n, e) => /^amp$/i.test(n) || /@ampcode\.com$/i.test(e) },
	{ id: 'devin', name: 'Devin', test: (n, e) => /^devin(-ai| ai)?(\[bot\])?$/i.test(n) || /devin-ai-integration|@cognition(-labs)?\.(ai|com)$/i.test(e) },
	{ id: 'aider', name: 'Aider', test: (n, e) => /^aider\b/i.test(n) || /@aider\.chat$/i.test(e) },
	{ id: 'windsurf', name: 'Windsurf', test: (n, e) => /^(windsurf|cascade|codeium)\b/i.test(n) || /@(codeium|windsurf)\.com$/i.test(e) },
	{ id: 'kimi', name: 'Kimi', test: (n, e) => /^kimi(\s+(code|k\d|cli)\b.*)?$/i.test(n) || /@moonshot\.(ai|cn)$/i.test(e) },
	{ id: 'volt', name: 'Volt', test: (n, e) => /^volt( agent)?$/i.test(n) || /@volt(adk)?\.(dev|app|ai)$/i.test(e) },
];

const TRAILER = /^co-authored-by:[ \t]*(.*?)[ \t]*<([^>\n]*)>[ \t]*$/gim;
const CLAUDE_CODE_MARK = /generated with \[?claude code\]?/i;

/**
 * The coding agents in `message`'s trailers, deduped by agent, in trailer order. A co-author that
 * no rule knows but whose name says "agent" or "bot" is kept as a generic agent.
 */
export function detectCodingAgents(message: string | undefined): readonly IGitCodingAgent[] {
	if (!message || message.length < 16) {
		return [];
	}
	const found: IGitCodingAgent[] = [];
	const add = (agent: IGitCodingAgent) => {
		if (!found.some(other => other.id === agent.id && (agent.id !== 'agent' || other.name === agent.name))) {
			found.push(agent);
		}
	};
	for (const match of message.matchAll(TRAILER)) {
		const name = match[1].trim();
		const email = match[2].trim();
		const rule = RULES.find(candidate => candidate.test(name, email));
		if (rule) {
			add({ id: rule.id, name: rule.name, evidence: match[0].trim() });
		} else if (/\b(agent|bot)\b|\[bot\]/i.test(name)) {
			add({ id: 'agent', name: name.replace(/\[bot\]$/i, '').trim() || name, evidence: match[0].trim() });
		}
	}
	if (!found.some(agent => agent.id === 'claude')) {
		const mark = CLAUDE_CODE_MARK.exec(message);
		if (mark) {
			add({ id: 'claude', name: 'Claude', evidence: mark[0] });
		}
	}
	return found;
}
