/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Plan mode: the agent investigates read-only, then presents its plan for the user to approve,
 * revise or edit. Every provider ends up calling one plan tool: `propose_plan` (Volt's host MCP
 * tool, for agents without a plan tool of their own) or the native `create_plan`. The editor draws
 * either call as the plan card.
 */

export const PROPOSE_PLAN_TOOL_NAME = 'propose_plan';

/** Where a plan is saved, relative to the chat's folder. */
export const PLANS_FOLDER = '.volt/plans';

export interface IPlanProposal {
	readonly title?: string;
	readonly markdown: string;
	readonly openQuestions: readonly string[];
}

/** What a plan tool's arguments say: `propose_plan` ({ title, plan, open_questions }) or `create_plan` ({ name, plan, todos }). */
export function planProposalFromArgs(args: Record<string, unknown> | undefined): IPlanProposal {
	const record = args ?? {};
	const title = firstString(record, 'title', 'name')?.trim() || undefined;
	const markdown = firstString(record, 'plan', 'markdown', 'body') ?? '';
	const openQuestions = stringList(record.open_questions ?? record.openQuestions);
	return { title, markdown: markdown.trim(), openQuestions };
}

/** A plan's file name in `.volt/plans`: the title as a slug. */
export function planSlug(title: string | undefined): string {
	const slug = (title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
	return slug || 'plan';
}

/** `name.md`, or `name-2.md` when `taken` already has the first. */
export function planFileName(title: string | undefined, taken: ReadonlySet<string> = new Set()): string {
	const base = planSlug(title);
	let name = `${base}.md`;
	for (let index = 2; taken.has(name); index++) {
		name = `${base}-${index}.md`;
	}
	return name;
}

/** The Markdown document a saved plan is: its title, the plan, and the open questions. */
export function planDocument(plan: IPlanProposal): string {
	const parts: string[] = [];
	const body = plan.markdown.trim();
	if (plan.title && !/^#\s/.test(body)) {
		parts.push(`# ${plan.title}`);
	}
	parts.push(body);
	if (plan.openQuestions.length) {
		parts.push(['## Open questions', ...plan.openQuestions.map(question => `- ${question}`)].join('\n'));
	}
	return `${parts.filter(Boolean).join('\n\n')}\n`;
}

/**
 * Added to the text of a plan-mode turn (not to the transcript bubble): the agent presents its
 * plan through `propose_plan` and stops, so the user can approve, revise or edit it first.
 */
export function planModeInstruction(): string {
	return [
		'[Plan mode: this chat is read-only. Investigate the code, then present your plan by calling the propose_plan tool with a short title and the plan in Markdown: the approach, the files to change, ordered steps, risks, and how to verify. Use open_questions for anything only the user can decide. Use propose_plan instead of any built-in plan or exit-plan tool. Then stop and wait: do not implement the plan. When the user asks for changes, call propose_plan again with the revised plan.]',
	].join('\n');
}

/** The turn text for a plan-mode message: the user's text with the instruction, unless it has it already. */
export function withPlanModeInstruction(text: string): string {
	const instruction = planModeInstruction();
	return text.includes(instruction) ? text : `${text}\n\n${instruction}`;
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}
	return undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()) : [];
}
