/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ALL_CAPABILITY_GROUPS, CapabilityGroup } from '../../common/harness/lanes.js';
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
}

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
	];
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
