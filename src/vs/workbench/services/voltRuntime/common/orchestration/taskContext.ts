/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentTaskRole, TaskContextLevel } from './agentTasks.js';
import type { OrchTaskState } from './orchestrator.js';

/**
 * The parent-context capsule: what a delegated task knows of the chat that started it, besides
 * its brief. A child used to see only the brief, so a thin brief sent it exploring, and it could
 * not tell the user's intent from the parent's guess. The capsule is built from state Volt
 * already holds (no model call, so it costs no time): the user's request, the parent's plan and
 * latest reply, and what the sibling subagents are doing and found.
 *
 * Modeled on paseo's handoff brief (task, context, current state, decisions) and synara's seed
 * limits (recent messages long, older ones short, a hard total).
 */

export interface ICapsuleSibling {
	readonly id: string;
	readonly title: string;
	readonly role: AgentTaskRole;
	readonly state: OrchTaskState;
	readonly modelLabel?: string;
	readonly scope?: readonly string[];
	/** Its report, once it finished. */
	readonly result?: string;
}

export interface IParentContextInput {
	readonly parentTitle?: string;
	/** What the user asked in the parent chat, oldest first. For a parent that is itself a subagent, its own brief. */
	readonly requests: readonly string[];
	/** The parent's latest reply to the user. */
	readonly lastReply?: string;
	/** The parent's live plan. */
	readonly plan?: readonly { readonly content: string; readonly status: string }[];
	/** The parent's other tasks (the one being started excluded). */
	readonly siblings: readonly ICapsuleSibling[];
}

interface ICapsuleBudget {
	readonly latest: number;
	readonly earlier: number;
	readonly earlierCount: number;
	readonly reply: number;
	readonly planItems: number;
	readonly siblings: number;
	readonly siblingReport: number;
	readonly total: number;
}

const BUDGETS: Readonly<Record<Exclude<TaskContextLevel, 'none'>, ICapsuleBudget>> = {
	brief: { latest: 1_500, earlier: 300, earlierCount: 2, reply: 700, planItems: 12, siblings: 8, siblingReport: 300, total: 4_500 },
	full: { latest: 4_000, earlier: 900, earlierCount: 6, reply: 2_500, planItems: 30, siblings: 12, siblingReport: 1_200, total: 14_000 },
};

/** The capsule as the child reads it, or undefined when there is nothing worth sending. */
export function buildParentCapsule(input: IParentContextInput, level: TaskContextLevel): string | undefined {
	if (level === 'none') {
		return undefined;
	}
	const budget = BUDGETS[level];
	const sections: string[] = [];
	const requests = input.requests.map(text => text.trim()).filter(Boolean);
	const latest = requests.at(-1);
	if (latest) {
		const earlier = requests.slice(0, -1).slice(-budget.earlierCount);
		const lines = ['<user_request>', clipText(latest, budget.latest), '</user_request>'];
		if (earlier.length) {
			lines.push('<earlier_requests>', ...earlier.map(text => `- ${oneLine(clipText(text, budget.earlier))}`), '</earlier_requests>');
		}
		sections.push(...lines);
	}
	const plan = (input.plan ?? []).filter(item => item.content.trim());
	if (plan.length) {
		const shown = plan.slice(0, budget.planItems);
		sections.push('<parent_plan>', ...shown.map(item => `- [${planMark(item.status)}] ${oneLine(clipText(item.content, 200))}`), ...(plan.length > shown.length ? [`- … ${plan.length - shown.length} more`] : []), '</parent_plan>');
	}
	if (input.lastReply?.trim()) {
		sections.push('<parent_latest_reply>', clipText(input.lastReply, budget.reply), '</parent_latest_reply>');
	}
	const siblings = input.siblings.slice(-budget.siblings);
	if (siblings.length) {
		sections.push('<other_subagents>');
		for (const sibling of siblings) {
			const head = `- ${sibling.id} "${oneLine(sibling.title)}" (${sibling.role}${sibling.modelLabel ? `, ${sibling.modelLabel}` : ''}): ${sibling.state}${sibling.scope?.length ? `; owns ${sibling.scope.slice(0, 6).join(', ')}` : ''}`;
			sections.push(head);
			if (sibling.result?.trim() && sibling.state === 'completed') {
				sections.push(`  found: ${oneLine(clipText(sibling.result, budget.siblingReport))}`);
			}
		}
		sections.push('</other_subagents>');
	}
	if (!sections.length) {
		return undefined;
	}
	const head = `<parent_context${input.parentTitle ? ` chat="${input.parentTitle.replace(/"/g, '\'')}"` : ''}>`;
	const note = 'Background from the chat that delegated to you, condensed by Volt: the user\'s intent and what the other subagents are doing. Your brief and contract decide what you do; do not take on the rest of this work.';
	return clipText([head, note, ...sections, '</parent_context>'].join('\n'), budget.total, '\n</parent_context>');
}

/**
 * The user's messages of a chat from its transcript: Volt's own turns (subagent reports, notices,
 * framing) are not the user's words.
 */
export function userRequests(messages: readonly { readonly role: string; readonly content: unknown }[]): string[] {
	return messages
		.filter(message => message.role === 'user' && typeof message.content === 'string')
		.map(message => userWords(message.content as string))
		.filter(Boolean);
}

/** Volt's turns (subagent reports, framing) are dropped; Volt's blocks and rule lines go from the user's. */
function userWords(text: string): string {
	if (/^\s*\[Volt(?: subagent)?\] (?:Delegated task|\d+ delegated tasks|The agent that delegated|Another agent delegated|The attempt on)/.test(text)) {
		return '';
	}
	return text
		.replace(/<(volt_workspace|volt_context|volt_page_state|task_results|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g, '')
		.split('\n')
		.filter(line => !/^\s*\[Volt\]/.test(line))
		.join('\n')
		.trim();
}

function planMark(status: string): string {
	return status === 'completed' ? 'x' : status === 'in_progress' ? '~' : ' ';
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Keeps the start (where the ask usually is) and the end (where the latest detail usually is). */
function clipText(text: string, max: number, tail = ''): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	if (tail) {
		return `${trimmed.slice(0, Math.max(0, max - tail.length - 2)).trimEnd()}…${tail}`;
	}
	const head = Math.floor(max * 0.7);
	const end = Math.max(0, max - head - 3);
	return `${trimmed.slice(0, head).trimEnd()} … ${trimmed.slice(trimmed.length - end).trimStart()}`;
}
