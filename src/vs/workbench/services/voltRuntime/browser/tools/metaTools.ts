/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ALL_CAPABILITY_GROUPS, CapabilityGroup } from '../../common/harness/lanes.js';
import { AgentQuestionDraft, IAgentQuestionResponse, parseQuestionDraft, questionResponseText } from '../../common/questions.js';
import { asRecord, pickString } from '../../common/tools/args.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';

export type SubagentKind = 'explore' | 'research';

export interface ISubagentRequest {
	readonly description: string;
	readonly prompt: string;
	readonly kind: SubagentKind;
}

export interface IMetaToolHost {
	grantGroups(groups: readonly CapabilityGroup[], reason: string): readonly CapabilityGroup[];
	/** The skill or agent-requested rule body, or `undefined` when no such name exists. */
	loadSkill?(name: string): Promise<string | undefined>;
	/** Runs a read-only sub-agent and returns its final report. */
	runSubagent?(request: ISubagentRequest, ctx: IToolContext): Promise<{ readonly text: string; readonly isError?: boolean }>;
	/** Shows the questions in the chat's question tray and resolves with the user's answers. */
	askQuestion?(draft: AgentQuestionDraft, ctx: IToolContext): Promise<IAgentQuestionResponse>;
}

/** The plan tool. The editor draws a call to it as a plan card with Build (`isPlanTool`). */
export const CREATE_PLAN_TOOL_NAME = 'create_plan';
export const NATIVE_ASK_QUESTION_TOOL_NAME = 'ask_question';

/** A person may take a while to answer; the tool runtime's default of 10 minutes is too short. */
const QUESTION_TIMEOUT_MS = 24 * 60 * 60_000;

export function createMetaTools(host: IMetaToolHost): IVoltTool[] {
	const tools: IVoltTool[] = [
		{
			name: 'request_capabilities',
			group: 'meta',
			kind: 'think',
			parallelSafe: true,
			snippet: 'request_capabilities - ask the harness for more tool groups',
			description: [
				'Ask Volt to grant additional capability groups for this session.',
				'Use when the task is larger than the current lane (e.g. you need shell from a small edit).',
				'Do not use to work around a denied access prompt - that is a user decision.',
			].join(' '),
			schema: objectSchema({
				groups: { type: 'array', items: { type: 'string', enum: [...ALL_CAPABILITY_GROUPS] } },
				reason: { type: 'string' },
			}, ['groups', 'reason']),
			execute: async args => runGrant(host, args),
		},
		{
			name: 'todo',
			group: 'meta',
			kind: 'think',
			parallelSafe: true,
			snippet: 'todo - set or update the task list for this run',
			description: [
				'Replace the visible task list. Use for work with three or more steps: add the steps up front,',
				'keep exactly one in_progress, and mark each completed as soon as it is done.',
				'Do not use for a single obvious edit or a question.',
			].join(' '),
			schema: objectSchema({
				entries: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							content: { type: 'string' },
							status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
						},
						required: ['content', 'status'],
					},
				},
			}, ['entries']),
			execute: async (args, ctx) => runTodo(args, ctx),
		},
		{
			name: 'finish',
			group: 'meta',
			kind: 'think',
			parallelSafe: true,
			snippet: 'finish - end a multi-step task with what changed and how it was verified',
			description: [
				'End a multi-step coding task with a structured result: summary, files changed, how it was verified, and anything left.',
				'Use only when the work is done. For a question or a small answer, just reply in text instead.',
			].join(' '),
			schema: objectSchema({
				summary: { type: 'string' },
				changed: { type: 'array', items: { type: 'string' } },
				verified: { type: 'array', items: { type: 'string' }, description: 'Commands or checks that passed' },
				remaining: { type: 'array', items: { type: 'string' }, description: 'Anything not done or not verified' },
			}, ['summary']),
			execute: async args => runFinish(args),
		},
		{
			name: CREATE_PLAN_TOOL_NAME,
			group: 'meta',
			kind: 'think',
			parallelSafe: true,
			snippet: 'create_plan - hand the user an implementation plan to review and build',
			description: [
				'Present an implementation plan for the user to review. The editor shows it as a plan card with a Build button.',
				'Use once, after investigating, when you are asked to plan. Then stop: do not implement until the user builds it.',
			].join(' '),
			schema: objectSchema({
				name: { type: 'string', description: 'Short title, e.g. "Add dark mode toggle"' },
				plan: { type: 'string', description: 'The plan in Markdown: approach, files to change, steps, risks, how to verify' },
				todos: { type: 'array', items: { type: 'string' }, description: 'Concrete implementation steps, in order' },
			}, ['name', 'plan']),
			execute: async args => runCreatePlan(args),
		},
	];
	if (host.askQuestion) {
		const ask = host.askQuestion.bind(host);
		tools.push({
			name: NATIVE_ASK_QUESTION_TOOL_NAME,
			group: 'meta',
			kind: 'think',
			parallelSafe: false,
			snippet: 'ask_question - ask the user multiple-choice questions and wait for the answers',
			description: [
				'Ask the user one or more multiple-choice questions and wait for the answers. Use it when a decision only the user can make',
				'(requirements, preferences, trade-offs) would change the result, instead of writing the options into your reply.',
				'Keep options short and mutually exclusive. Every question automatically gets a free-text "Other" choice; do not add one.',
			].join(' '),
			schema: objectSchema({
				title: { type: 'string', description: 'Optional short heading for the questions' },
				questions: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							prompt: { type: 'string', description: 'The question' },
							options: {
								type: 'array',
								items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] },
							},
							allow_multiple: { type: 'boolean', description: 'True when several options may be picked' },
						},
						required: ['id', 'prompt', 'options'],
					},
				},
			}, ['questions']),
			timeoutMs: QUESTION_TIMEOUT_MS,
			execute: async (args, ctx) => runAskQuestion(ask, args, ctx),
		});
	}
	if (host.loadSkill) {
		const load = host.loadSkill.bind(host);
		tools.push({
			name: 'skill',
			group: 'meta',
			kind: 'think',
			parallelSafe: true,
			idempotent: true,
			snippet: 'skill - load a listed skill or rule by name',
			description: 'Load the full instructions of a skill or rule listed under <skills> in the system prompt. Load it before doing the task it describes, then follow it.',
			schema: objectSchema({
				name: { type: 'string' },
			}, ['name']),
			execute: async args => {
				const name = pickString(args, 'name', 'skill') ?? '';
				const body = name ? await load(name) : undefined;
				return body
					? { callId: '', name: 'skill', kind: 'think', text: body }
					: { callId: '', name: 'skill', kind: 'think', text: `No skill named "${name}". Use a name from the <skills> list.`, isError: true };
			},
		});
	}
	if (host.runSubagent) {
		const run = host.runSubagent.bind(host);
		tools.push({
			name: 'task',
			group: 'meta',
			kind: 'think',
			parallelSafe: true,
			snippet: 'task - delegate a read-only investigation to a sub-agent',
			description: [
				'Start a sub-agent with its own context to investigate and report back. It can read, search, and navigate code',
				'(agent "explore") and also search and fetch the web (agent "research"); it cannot edit or run commands.',
				'Use for broad searches ("where and how is X handled across the codebase"), comparing approaches, or researching docs,',
				'especially several independent questions at once: call task several times in one turn and they run in parallel.',
				'Give a complete, self-contained prompt and say exactly what to return. Only its final report comes back.',
				'Do not use for a single known file or a one-off grep; do those directly.',
			].join(' '),
			schema: objectSchema({
				description: { type: 'string', description: 'Three-to-six word label shown to the user' },
				prompt: { type: 'string', description: 'Everything the sub-agent needs to know, and what to report' },
				agent: { type: 'string', enum: ['explore', 'research'], description: 'Default explore' },
			}, ['description', 'prompt']),
			timeoutMs: 15 * 60_000,
			execute: async (args, ctx) => {
				const prompt = pickString(args, 'prompt') ?? '';
				const description = pickString(args, 'description') ?? 'Sub-agent task';
				const kind: SubagentKind = pickString(args, 'agent') === 'research' ? 'research' : 'explore';
				try {
					const report = await run({ description, prompt, kind }, ctx);
					return { callId: '', name: 'task', kind: 'think', text: report.text, ...(report.isError ? { isError: true } : {}) };
				} catch (err) {
					return { callId: '', name: 'task', kind: 'think', text: err instanceof Error ? err.message : String(err), isError: true };
				}
			},
		});
	}
	return tools;
}

function runGrant(host: IMetaToolHost, args: unknown): IToolResult {
	const record = asRecord(args);
	const requested = Array.isArray(record.groups)
		? record.groups.filter((group): group is CapabilityGroup => typeof group === 'string' && (ALL_CAPABILITY_GROUPS as readonly string[]).includes(group))
		: [];
	const reason = pickString(args, 'reason') ?? '';
	if (!requested.length) {
		return { callId: '', name: 'request_capabilities', kind: 'think', text: 'No valid groups were requested.', isError: true };
	}
	const granted = host.grantGroups(requested, reason);
	return {
		callId: '',
		name: 'request_capabilities',
		kind: 'think',
		text: `Granted groups: ${granted.join(', ') || '(none - mode policy blocked the request)'}. The next step will see the new tools.`,
	};
}

function runTodo(args: unknown, ctx: IToolContext): IToolResult {
	const record = asRecord(args);
	const entries = Array.isArray(record.entries) ? record.entries.flatMap(entry => {
		const item = asRecord(entry);
		const content = typeof item.content === 'string' ? item.content.trim() : '';
		if (!content) {
			return [];
		}
		const status = item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending';
		return [{ content, status }];
	}) : [];
	ctx.emit?.({ type: 'plan', entries });
	const done = entries.filter(entry => entry.status === 'completed').length;
	return {
		callId: '',
		name: 'todo',
		kind: 'think',
		text: entries.length ? `Task list updated (${done}/${entries.length} done).` : 'Task list cleared.',
	};
}

async function runAskQuestion(ask: NonNullable<IMetaToolHost['askQuestion']>, args: unknown, ctx: IToolContext): Promise<IToolResult> {
	const draft = parseQuestionDraft(args);
	if (!draft) {
		return { callId: '', name: NATIVE_ASK_QUESTION_TOOL_NAME, kind: 'think', text: 'ask_question needs a non-empty `questions` array, each with `id`, `prompt` and `options` ({ id, label }).', isError: true };
	}
	if (ctx.signal.aborted) {
		return { callId: '', name: NATIVE_ASK_QUESTION_TOOL_NAME, kind: 'think', text: 'Cancelled.', isError: true };
	}
	// Stop must not leave the tool waiting on a tray nobody will answer.
	const cancelled = new Promise<IAgentQuestionResponse>(resolve => ctx.signal.addEventListener('abort', () => resolve({ outcome: 'cancelled', answers: [] }), { once: true }));
	try {
		const response = await Promise.race([ask(draft, ctx), cancelled]);
		return { callId: '', name: NATIVE_ASK_QUESTION_TOOL_NAME, kind: 'think', text: questionResponseText(draft, response) };
	} catch (err) {
		return { callId: '', name: NATIVE_ASK_QUESTION_TOOL_NAME, kind: 'think', text: err instanceof Error ? err.message : String(err), isError: true };
	}
}

function runCreatePlan(args: unknown): IToolResult {
	const name = pickString(args, 'name', 'title')?.trim() ?? '';
	const plan = pickString(args, 'plan', 'markdown')?.trim() ?? '';
	if (!plan) {
		return { callId: '', name: CREATE_PLAN_TOOL_NAME, kind: 'think', text: 'plan is required: the plan in Markdown.', isError: true };
	}
	const todos = stringList(asRecord(args).todos);
	return {
		callId: '',
		name: CREATE_PLAN_TOOL_NAME,
		kind: 'think',
		text: `Plan${name ? ` "${name}"` : ''} is ready for review${todos.length ? ` (${todos.length} steps)` : ''}. Stop here: the user will press Build or ask for changes. Do not start implementing.`,
	};
}

function runFinish(args: unknown): IToolResult {
	const record = asRecord(args);
	const summary = pickString(args, 'summary') ?? 'Done.';
	const payload = {
		summary,
		changed: stringList(record.changed),
		verified: stringList(record.verified),
		remaining: stringList(record.remaining),
	};
	return { callId: '', name: 'finish', kind: 'think', text: JSON.stringify(payload) };
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
}
