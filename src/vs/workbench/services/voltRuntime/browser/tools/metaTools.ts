/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ALL_CAPABILITY_GROUPS, CapabilityGroup } from '../../common/harness/lanes.js';
import { asRecord, pickString } from '../../common/tools/args.js';
import { IToolContext, IToolResult, IVoltTool } from '../../common/tools/tool.js';
import { objectSchema } from './schema.js';

export interface IMetaToolHost {
	grantGroups(groups: readonly CapabilityGroup[], reason: string): readonly CapabilityGroup[];
}

export function createMetaTools(host: IMetaToolHost): IVoltTool[] {
	return [
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
			snippet: 'todo - set or update the plan entries for this run',
			description: [
				'Replace the current plan with the given entries.',
				'Use for multi-step work so the user can see progress.',
				'Do not use for a single obvious edit.',
			].join(' '),
			schema: objectSchema({
				entries: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							content: { type: 'string' },
							status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
							priority: { type: 'string' },
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
			snippet: 'finish - structured completion (summary, changed, verified, remaining)',
			description: [
				'Mark the run complete with a structured result.',
				'Use when the user-visible work is done and you have evidence.',
				'Do not use mid-task, and do not use instead of answering a simple question in text.',
			].join(' '),
			schema: objectSchema({
				summary: { type: 'string' },
				changed: { type: 'array', items: { type: 'string' } },
				verified: { type: 'array', items: { type: 'string' } },
				remaining: { type: 'array', items: { type: 'string' } },
			}, ['summary']),
			execute: async args => runFinish(args),
		},
	];
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
		return [{ content, status, priority: typeof item.priority === 'string' ? item.priority : undefined }];
	}) : [];
	ctx.emit?.({ type: 'plan', entries });
	return {
		callId: '',
		name: 'todo',
		kind: 'think',
		text: entries.length ? entries.map(entry => `- [${entry.status}] ${entry.content}`).join('\n') : 'Plan cleared.',
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
