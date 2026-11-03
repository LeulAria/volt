/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { evaluateExpression, isTruthy, stringifyValue } from './workflowExpressions.js';
import { IWorkflowFieldDef, IWorkflowIssue, IWorkflowNode, IWorkflowNodeContext, IWorkflowNodeResult, IWorkflowNodeType, IWorkflowPortDef, WorkflowIssueSeverity, WorkflowNodeError, WorkflowPortKind, WorkflowRecord, WorkflowValue } from './workflowTypes.js';

/**
 * Every node type, in picker order. Ports, fields and output docs here are what the YAML, the
 * inspector, the engine and the executors agree on. `simulate` gives realistic mock results with
 * no side effects (the engine handles pinned outputs and failure injection); for `pure` types it
 * is the real behaviour, so they run the same in simulations and real runs.
 */

//#region Helpers

const IN: readonly IWorkflowPortDef[] = [{ id: 'in', label: 'In' }];

function port(id: string, kind: WorkflowPortKind = 'neutral', label = id): IWorkflowPortDef {
	return { id, label, kind };
}

const NEXT = (): readonly IWorkflowPortDef[] => [{ id: 'next', label: 'Next' }];
const DONE_FAILED = (): readonly IWorkflowPortDef[] => [port('done', 'success'), port('failed', 'failure')];
const pair = (ok: string, failed: string) => (): readonly IWorkflowPortDef[] => [port(ok, 'success'), port(failed, 'failure')];

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()).map(entry => entry.trim()) : [];
}

function str(value: WorkflowValue | undefined): string {
	return typeof value === 'string' ? value : value === undefined || value === null ? '' : stringifyValue(value);
}

function isRecord(value: unknown): value is WorkflowRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First line, trimmed and shortened, for canvas subtitles. */
function clip(value: WorkflowValue | undefined, max = 40): string | undefined {
	const line = str(value).split('\n').map(part => part.trim()).find(Boolean);
	if (!line) {
		return undefined;
	}
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `{{ nodes.find.files }}` reads as `nodes.find.files` in a subtitle. */
function bare(value: WorkflowValue | undefined): string | undefined {
	const text = str(value).trim();
	const match = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(text);
	return clip(match ? match[1] : text);
}

function modelShort(value: WorkflowValue | undefined): string | undefined {
	return typeof value === 'string' && value ? value.split(':').pop() : undefined;
}

function host(value: WorkflowValue | undefined): string | undefined {
	const text = str(value).trim();
	if (!text) {
		return undefined;
	}
	const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(text);
	return clip(match ? match[1] : text, 32);
}

function joinSummary(...parts: (string | undefined | false)[]): string | undefined {
	return parts.filter(Boolean).join(' · ') || undefined;
}

function issue(node: IWorkflowNode, code: string, message: string, field?: string, severity: WorkflowIssueSeverity = 'error'): IWorkflowIssue {
	return { severity, code, message, nodeId: node.id, field };
}

/** Port names come from config (verdicts, cases, categories): unique, not reserved, YAML-friendly. */
function checkPortNames(node: IWorkflowNode, field: string, names: readonly string[], reserved: readonly string[]): IWorkflowIssue[] {
	const issues: IWorkflowIssue[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (reserved.includes(name)) {
			issues.push(issue(node, 'reserved-port', `"${name}" is already an output of this node`, field));
		} else if (seen.has(name)) {
			issues.push(issue(node, 'duplicate-port', `"${name}" is listed twice`, field));
		} else if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
			issues.push(issue(node, 'port-name', `"${name}": use letters, digits, spaces, - and _`, field, 'warning'));
		}
		seen.add(name);
	}
	return issues;
}

function checkUrl(node: IWorkflowNode, field: string, schemes: RegExp): IWorkflowIssue[] {
	const value = node.config[field];
	if (typeof value !== 'string' || !value.trim() || value.includes('{{')) {
		return [];
	}
	return schemes.test(value.trim()) ? [] : [issue(node, 'invalid-url', `Not a valid URL: ${clip(value, 60)}`, field)];
}

const DURATION_UNITS: { readonly [unit: string]: number } = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A duration field in milliseconds: `"30s"`, `"5m"`, `"1h30m"`, `"500ms"`, `"2d"`; a bare number
 * (or numeric text) means seconds. Undefined when it does not parse.
 */
export function parseWorkflowDuration(value: WorkflowValue | undefined): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
	}
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}
	const text = value.trim().toLowerCase().replace(/\s+/g, '');
	if (/^\d+(\.\d+)?$/.test(text)) {
		return Number(text) * 1000;
	}
	if (!/^(\d+(\.\d+)?(ms|s|m|h|d))+$/.test(text)) {
		return undefined;
	}
	let total = 0;
	for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
		total += Number(match[1]) * DURATION_UNITS[match[2]];
	}
	return total;
}

/** `90000` → `"1m 30s"`. */
export function formatWorkflowDuration(ms: number): string {
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	const parts: string[] = [];
	let rest = Math.round(ms / 1000);
	for (const [unit, size] of [['d', 86_400], ['h', 3_600], ['m', 60], ['s', 1]] as const) {
		if (rest >= size) {
			parts.push(`${Math.floor(rest / size)}${unit}`);
			rest %= size;
		}
	}
	return parts.slice(0, 2).join(' ');
}

/** A `keyValue` field as a record: a map, a list of `{ key, value }`, or `"key=value"` / `"key: value"` lines. */
export function keyValueRecord(value: WorkflowValue | undefined): WorkflowRecord {
	if (isRecord(value)) {
		return value;
	}
	const record: Record<string, WorkflowValue> = {};
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (isRecord(entry) && typeof entry.key === 'string') {
				record[entry.key] = entry.value ?? null;
			} else if (typeof entry === 'string') {
				const match = /^\s*([^=:]+?)\s*[=:]\s*([\s\S]*)$/.exec(entry);
				if (match) {
					record[match[1]] = match[2];
				}
			}
		}
	}
	return record;
}

/**
 * A list for for-each and filter: lists as they are; text as a JSON list or one item per non-empty
 * line (agent output listing files); nothing as an empty list. Undefined for anything else.
 */
export function workflowItemsList(value: WorkflowValue | undefined): readonly WorkflowValue[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (value === undefined || value === null) {
		return [];
	}
	if (typeof value === 'string') {
		const text = value.trim();
		if (text.startsWith('[')) {
			try {
				const parsed = JSON.parse(text);
				if (Array.isArray(parsed)) {
					return parsed;
				}
			} catch {
				// Not JSON: fall back to lines.
			}
		}
		return text ? text.split('\n').map(line => line.trim()).filter(Boolean) : [];
	}
	return undefined;
}

/** JSON in agent output often comes fenced (```json … ```). */
function stripFences(text: string): string {
	const match = /^\s*```[a-z]*\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
	return match ? match[1] : text;
}

/** A short deterministic hex id from text, so simulated shas and threads look real but repeat. */
function fakeHash(seed: string, length = 7): string {
	let hash = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
	}
	let out = '';
	while (out.length < length) {
		hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
		out += (hash >>> 0).toString(16).padStart(8, '0');
	}
	return out.slice(0, length);
}

function simulatedAgent(context: IWorkflowNodeContext, prompt: string, extra: WorkflowRecord = {}): IWorkflowNodeResult {
	const threadId = `sim-${fakeHash(context.stepId + prompt, 8)}`;
	const costUsd = Math.round((0.004 + prompt.length / 400_000) * 10_000) / 10_000;
	return {
		output: { summary: `Simulated result for: ${clip(prompt, 80) ?? 'the task'}`, threadId, costUsd, ...extra },
		tokens: { input: 1200 + prompt.length, output: 380, costUsd },
	};
}

const MODEL_FIELD: IWorkflowFieldDef = { key: 'model', label: 'Model', kind: 'model', description: 'The workflow default when empty.' };
const TIMEOUT_DOCS = 'Gives up after this long (5m, 1h).';

//#endregion

export const WORKFLOW_NODE_TYPES: readonly IWorkflowNodeType[] = [

	//#region Trigger

	{
		type: 'start',
		category: 'trigger',
		label: 'Start',
		description: 'Entry point: receives the trigger payload and the workflow inputs.',
		icon: 'debug-start',
		color: 'orange',
		shape: 'card',
		keywords: 'trigger begin entry manual schedule event',
		control: 'start',
		singleton: true,
		inputs: [],
		outputs: NEXT,
		fields: [],
		outputDocs: [
			{ key: 'payload', description: 'The trigger payload (event, schedule slot or manual input).' },
			{ key: 'inputs', description: 'The workflow inputs.' },
		],
		permissions: [],
	},

	//#endregion

	//#region AI

	{
		type: 'agent',
		category: 'ai',
		label: 'Agent',
		description: 'One agent session: a prompt, a model, skills and MCP tools, in the repository.',
		icon: 'robot',
		color: 'purple',
		keywords: 'ai llm claude codex prompt chat model',
		control: 'task',
		inputs: IN,
		outputs: (config: WorkflowRecord) => [
			...strings(config.verdicts).map((verdict): IWorkflowPortDef => ({ id: verdict, label: verdict, kind: 'neutral' })),
			{ id: 'done', label: 'done', kind: 'success' },
			{ id: 'failed', label: 'failed', kind: 'failure' },
		],
		fields: [
			{ key: 'prompt', label: 'Prompt', kind: 'prompt', required: true, templates: true, default: '{{ inputs.task }}', placeholder: 'Type / for skills, @ for tools, {{ for values' },
			MODEL_FIELD,
			{ key: 'mode', label: 'Mode', kind: 'select', default: 'Agent', options: [{ value: 'Agent', label: 'Agent' }, { value: 'Plan', label: 'Plan' }, { value: 'Ask', label: 'Ask' }] },
			{ key: 'skill', label: 'Skill', kind: 'skill' },
			{ key: 'mcpServers', label: 'MCP servers', kind: 'list', description: 'MCP servers the agent should use.' },
			{ key: 'verdicts', label: 'Verdicts', kind: 'list', description: 'Each verdict becomes an output port; the agent ends by naming one.', advanced: true },
			{ key: 'session', label: 'Session', kind: 'select', default: 'fresh', advanced: true, options: [{ value: 'fresh', label: 'Fresh session' }, { value: 'continue', label: 'Continue previous agent' }] },
		],
		outputDocs: [
			{ key: 'summary', description: 'The agent\'s final message.' },
			{ key: 'verdict', description: 'The verdict it named, when the node has verdicts.' },
			{ key: 'threadId', description: 'The chat it ran in.' },
			{ key: 'costUsd', description: 'What the turn cost, when the provider reports it.' },
		],
		permissions: ['agent'],
		summary: config => joinSummary(modelShort(config.model), typeof config.skill === 'string' && config.skill ? `/${config.skill}` : undefined),
		validate: node => checkPortNames(node, 'verdicts', strings(node.config.verdicts), ['done', 'failed']),
		simulate: context => {
			const verdict = strings(context.config.verdicts)[0];
			const result = simulatedAgent(context, str(context.config.prompt), verdict ? { verdict } : {});
			return { ...result, port: verdict ?? 'done' };
		},
	},
	{
		type: 'ask_user',
		category: 'ai',
		label: 'Ask User',
		description: 'Asks you a question and continues with the answer.',
		icon: 'comment-discussion',
		color: 'purple',
		keywords: 'question human input prompt choose answer',
		control: 'task',
		inputs: IN,
		outputs: () => [port('answered', 'success'), port('timeout', 'failure')],
		fields: [
			{ key: 'question', label: 'Question', kind: 'multiline', required: true, templates: true, placeholder: 'Ship {{ nodes.pr.title }}?' },
			{ key: 'options', label: 'Options', kind: 'list', description: 'Choices to pick from; free text when empty.' },
			{ key: 'timeout', label: 'Timeout', kind: 'duration', advanced: true, placeholder: '1h', description: TIMEOUT_DOCS },
		],
		outputDocs: [
			{ key: 'answer', description: 'The answer (the option picked, or the text typed).' },
			{ key: 'option', description: 'The picked option\'s index, when there are options.' },
		],
		permissions: [],
		summary: config => clip(config.question),
		simulate: context => {
			const options = strings(context.config.options);
			return { output: { answer: options[0] ?? 'Yes', option: options.length ? 0 : null }, port: 'answered' };
		},
	},
	{
		type: 'subtask',
		category: 'ai',
		label: 'Subtask',
		description: 'Delegates a task to a separate agent chat, optionally in its own worktree.',
		icon: 'type-hierarchy-sub',
		color: 'purple',
		keywords: 'delegate parallel worktree background agent',
		control: 'task',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [
			{ key: 'prompt', label: 'Prompt', kind: 'prompt', required: true, templates: true, placeholder: 'What the subtask should do' },
			MODEL_FIELD,
			{ key: 'worktree', label: 'Own worktree', kind: 'boolean', default: false, description: 'Runs in a new git worktree so it cannot touch your checkout.' },
		],
		outputDocs: [
			{ key: 'summary', description: 'The subtask\'s final message.' },
			{ key: 'threadId', description: 'The chat it ran in.' },
			{ key: 'worktree', description: 'The worktree path, when it had one.' },
			{ key: 'branch', description: 'The worktree\'s branch.' },
		],
		permissions: ['agent'],
		summary: config => joinSummary(modelShort(config.model), config.worktree === true && 'worktree'),
		simulate: context => simulatedAgent(context, str(context.config.prompt), context.config.worktree === true ? { worktree: `.volt/worktrees/${fakeHash(context.stepId)}`, branch: `volt/${fakeHash(context.stepId)}` } : {}),
	},
	{
		type: 'classify',
		category: 'ai',
		label: 'Classify',
		description: 'Sorts text into one of your categories, one output per category.',
		icon: 'tag',
		color: 'purple',
		keywords: 'categorize triage route label sentiment intent',
		control: 'task',
		inputs: IN,
		outputs: config => [...strings(config.categories).map(category => port(category)), port('other')],
		fields: [
			{ key: 'text', label: 'Text', kind: 'multiline', required: true, templates: true, default: '{{ input }}' },
			{ key: 'categories', label: 'Categories', kind: 'list', required: true, description: 'Each category becomes an output port.' },
			{ key: 'instructions', label: 'Instructions', kind: 'multiline', advanced: true, placeholder: 'How to tell the categories apart' },
			MODEL_FIELD,
		],
		outputDocs: [
			{ key: 'category', description: 'The category picked ("other" when none fit).' },
			{ key: 'confidence', description: 'How sure the model was, 0 to 1.' },
			{ key: 'reason', description: 'One sentence on why.' },
		],
		permissions: ['agent'],
		summary: config => clip(strings(config.categories).join(' · ')),
		validate: node => checkPortNames(node, 'categories', strings(node.config.categories), ['other']),
		simulate: context => {
			const category = strings(context.config.categories)[0] ?? 'other';
			return { output: { category, confidence: 0.82, reason: `Simulated: reads like "${category}".` }, port: category, tokens: { input: 400, output: 40 } };
		},
	},
	{
		type: 'summarize',
		category: 'ai',
		label: 'Summarize',
		description: 'Condenses text (a diff, logs, an agent\'s output) into a short summary.',
		icon: 'note',
		color: 'purple',
		keywords: 'tldr digest condense report changelog',
		control: 'task',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [
			{ key: 'text', label: 'Text', kind: 'multiline', required: true, templates: true, default: '{{ input }}' },
			{ key: 'instructions', label: 'Instructions', kind: 'multiline', placeholder: 'Three bullet points for the PR description' },
			MODEL_FIELD,
		],
		outputDocs: [{ key: 'summary', description: 'The summary.' }],
		permissions: ['agent'],
		summary: config => modelShort(config.model) ?? clip(config.instructions),
		simulate: context => ({ output: { summary: `Summary (simulated): ${clip(context.config.text, 120) ?? 'nothing to summarize'}` }, tokens: { input: 300 + str(context.config.text).length, output: 120 } }),
	},

	//#endregion

	//#region Flow

	{
		type: 'end',
		category: 'flow',
		label: 'End',
		description: 'Finishes the run as a success or a failure.',
		icon: 'pass-filled',
		color: 'green',
		shape: 'round',
		keywords: 'finish stop return result done',
		control: 'end',
		inputs: IN,
		outputs: () => [],
		fields: [
			{ key: 'status', label: 'Status', kind: 'select', default: 'success', options: [{ value: 'success', label: 'Succeeds' }, { value: 'failure', label: 'Fails' }] },
			{ key: 'output', label: 'Output', kind: 'multiline', templates: true, placeholder: '{{ nodes.work.summary }}', description: 'What the run returns (sub-workflow callers read it).' },
		],
		outputDocs: [],
		permissions: [],
		summary: config => config.status === 'failure' ? 'fails' : 'succeeds',
	},
	{
		type: 'if',
		category: 'flow',
		label: 'If',
		description: 'Takes the true or the false path depending on a condition.',
		icon: 'symbol-boolean',
		color: 'yellow',
		keywords: 'condition branch when check boolean else',
		control: 'if',
		inputs: IN,
		outputs: () => [port('true'), port('false')],
		fields: [
			{ key: 'condition', label: 'Condition', kind: 'expression', required: true, placeholder: 'nodes.check.exitCode == 0', description: 'An expression; empty text, 0, null, false and empty lists are false.' },
		],
		outputDocs: [{ key: 'result', description: 'The condition\'s value as true or false.' }],
		permissions: [],
		summary: config => clip(config.condition),
	},
	{
		type: 'switch',
		category: 'flow',
		label: 'Switch',
		description: 'Picks the output whose case matches a value; default when none does.',
		icon: 'symbol-enum',
		color: 'yellow',
		keywords: 'case match route branch multiple',
		control: 'switch',
		inputs: IN,
		outputs: config => [...strings(config.cases).map(entry => port(entry)), port('default')],
		fields: [
			{ key: 'value', label: 'Value', kind: 'expression', required: true, placeholder: 'nodes.triage.category' },
			{ key: 'cases', label: 'Cases', kind: 'list', required: true, description: 'Each case becomes an output port; compared as text.' },
		],
		outputDocs: [
			{ key: 'value', description: 'The value that was compared.' },
			{ key: 'case', description: 'The case that matched ("default" when none).' },
		],
		permissions: [],
		summary: config => clip(config.value),
		validate: node => checkPortNames(node, 'cases', strings(node.config.cases), ['default']),
	},
	{
		type: 'loop',
		category: 'flow',
		label: 'Loop',
		description: 'Repeats the nodes wired to "repeat" until a condition stops or the limit is reached.',
		icon: 'sync',
		color: 'teal',
		keywords: 'repeat retry until while iterate again',
		control: 'loop',
		inputs: IN,
		// Exhausted first: a disabled loop passes on instead of repeating, and the repeat edge (drawn back under the node) never crosses it.
		outputs: () => [port('exhausted'), port('repeat', 'loop')],
		fields: [
			{ key: 'max', label: 'Max passes', kind: 'number', default: 3, min: 1, max: 1000, required: true },
			{ key: 'while', label: 'While', kind: 'expression', placeholder: 'nodes.check.exitCode != 0', description: 'Repeats only while this is true; leave empty to repeat up to the limit.' },
		],
		outputDocs: [
			{ key: 'iteration', description: 'Passes started so far.' },
			{ key: 'max', description: 'The limit.' },
		],
		permissions: [],
		summary: config => joinSummary(`up to ${typeof config.max === 'number' ? config.max : 3}×`, clip(config.while, 28)),
	},
	{
		type: 'for_each',
		category: 'flow',
		label: 'For Each',
		description: 'Runs the nodes wired to "item" once per list item, then continues with every result.',
		icon: 'list-ordered',
		color: 'teal',
		keywords: 'iterate list map each array batch',
		control: 'forEach',
		inputs: IN,
		outputs: () => [port('item', 'loop'), port('done', 'success')],
		fields: [
			{ key: 'items', label: 'Items', kind: 'json', required: true, templates: true, placeholder: '{{ nodes.find.files }}', description: 'A list: a template like {{ nodes.find.files }}, a YAML list, or text with one item per line.' },
			{ key: 'maxItems', label: 'Max items', kind: 'number', default: 50, min: 1, max: 1000, advanced: true },
		],
		outputDocs: [
			{ key: 'items', description: 'The items it went through.' },
			{ key: 'results', description: 'Each item\'s result (the last output of its pass).' },
			{ key: 'count', description: 'How many items ran.' },
		],
		permissions: [],
		summary: config => joinSummary(bare(config.items), typeof config.maxItems === 'number' && config.maxItems !== 50 && `max ${config.maxItems}`),
	},
	{
		type: 'fork',
		category: 'flow',
		label: 'Parallel',
		description: 'Runs two to four branches at the same time.',
		icon: 'repo-forked',
		color: 'blue',
		keywords: 'fork parallel split fan out concurrent branches',
		control: 'fork',
		inputs: IN,
		outputs: config => {
			const count = Math.max(2, Math.min(4, typeof config.branches === 'number' ? Math.trunc(config.branches) : 2));
			return Array.from({ length: count }, (_, i) => port(`branch${i + 1}`, 'neutral', `branch ${i + 1}`));
		},
		fields: [{ key: 'branches', label: 'Branches', kind: 'number', default: 2, min: 2, max: 4 }],
		outputDocs: [],
		permissions: [],
		summary: config => `${typeof config.branches === 'number' ? Math.max(2, Math.min(4, config.branches)) : 2} branches`,
	},
	{
		type: 'join',
		category: 'flow',
		label: 'Join',
		description: 'Waits for parallel branches and continues with their outputs together.',
		icon: 'merge',
		color: 'blue',
		keywords: 'merge wait all any combine gather',
		control: 'join',
		inputs: IN,
		outputs: NEXT,
		fields: [
			{ key: 'mode', label: 'Wait for', kind: 'select', default: 'all', options: [{ value: 'all', label: 'All branches', description: 'Every branch that runs; branches not taken are not waited for.' }, { value: 'any', label: 'First branch' }] },
		],
		outputDocs: [{ key: '<node id>', description: 'Each branch\'s output, by the id of the node that led into the join.' }],
		permissions: [],
		summary: config => config.mode === 'any' ? 'first branch' : 'all branches',
	},
	{
		type: 'wait',
		category: 'flow',
		label: 'Wait',
		description: 'Pauses the run for a while.',
		icon: 'watch',
		color: 'orange',
		keywords: 'delay sleep pause timer',
		control: 'wait',
		inputs: IN,
		outputs: NEXT,
		fields: [{ key: 'duration', label: 'Duration', kind: 'duration', required: true, default: '1m', placeholder: '30s, 5m, 1h' }],
		outputDocs: [{ key: 'waitedMs', description: 'How long it waited.' }],
		permissions: [],
		summary: config => {
			const ms = parseWorkflowDuration(config.duration);
			return ms === undefined ? clip(config.duration) : formatWorkflowDuration(ms);
		},
		validate: node => node.config.duration !== undefined && !str(node.config.duration).includes('{{') && parseWorkflowDuration(node.config.duration) === undefined ? [issue(node, 'invalid-duration', 'Use a duration like 30s, 5m or 1h', 'duration')] : [],
	},
	{
		type: 'approval',
		category: 'flow',
		label: 'Approval',
		description: 'Waits for you to approve or reject before continuing.',
		icon: 'verified',
		color: 'orange',
		keywords: 'human review gate confirm approve reject manual',
		control: 'approval',
		inputs: IN,
		outputs: () => [port('approved', 'success'), port('rejected', 'failure')],
		fields: [
			{ key: 'title', label: 'Title', kind: 'text', required: true, templates: true, default: 'Approve to continue?' },
			{ key: 'detail', label: 'Detail', kind: 'multiline', templates: true, placeholder: '{{ nodes.review.summary }}' },
			{ key: 'timeout', label: 'Timeout', kind: 'duration', advanced: true, placeholder: '24h', description: 'Rejects after this long.' },
		],
		outputDocs: [
			{ key: 'decision', description: 'approve, reject or timeout.' },
			{ key: 'decidedAt', description: 'When it was decided (epoch ms).' },
		],
		permissions: [],
		summary: config => clip(config.title),
	},
	{
		type: 'subworkflow',
		category: 'flow',
		label: 'Run Workflow',
		description: 'Runs another saved workflow and continues with its result.',
		icon: 'type-hierarchy',
		color: 'pink',
		keywords: 'subworkflow call nested reuse child',
		control: 'subworkflow',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [
			{ key: 'workflow', label: 'Workflow', kind: 'workflow', required: true },
			{ key: 'inputs', label: 'Inputs', kind: 'keyValue', templates: true, description: 'The called workflow\'s inputs.' },
		],
		outputDocs: [
			{ key: 'output', description: 'What its End node returned.' },
			{ key: 'status', description: 'How its run finished.' },
			{ key: 'runId', description: 'Its run.' },
		],
		permissions: [],
		summary: config => clip(config.workflow),
		validate: (node, definition) => node.config.workflow === definition.id ? [issue(node, 'subworkflow-self', 'Calls its own workflow; it stops at the nesting limit', 'workflow', 'warning')] : [],
	},
	{
		type: 'set_variables',
		category: 'flow',
		label: 'Set Variables',
		description: 'Sets run variables that later nodes read as {{ vars.name }}.',
		icon: 'symbol-variable',
		color: 'default',
		keywords: 'variable assign store state counter',
		control: 'setVariables',
		inputs: IN,
		outputs: NEXT,
		fields: [{ key: 'variables', label: 'Variables', kind: 'keyValue', required: true, templates: true }],
		outputDocs: [],
		permissions: [],
		summary: config => clip(Object.keys(keyValueRecord(config.variables)).join(', ')),
	},

	//#endregion

	//#region Scripts

	{
		type: 'shell',
		category: 'scripts',
		label: 'Shell',
		description: 'Runs a command in the repository; passes on exit code 0.',
		icon: 'terminal',
		color: 'blue',
		keywords: 'command bash script test build lint check npm make',
		control: 'task',
		inputs: IN,
		outputs: pair('passed', 'failed'),
		fields: [
			{ key: 'command', label: 'Command', kind: 'code', required: true, templates: true, language: 'shellscript', placeholder: 'npm test' },
			{ key: 'cwd', label: 'Folder', kind: 'text', advanced: true, placeholder: 'Repository root', description: 'Relative to the repository.' },
			{ key: 'timeout', label: 'Timeout', kind: 'duration', advanced: true, default: '10m', description: TIMEOUT_DOCS },
			{ key: 'env', label: 'Environment', kind: 'keyValue', advanced: true, templates: true },
			{ key: 'successCodes', label: 'Passing exit codes', kind: 'list', advanced: true, description: 'Exit codes that count as passed (0 when empty).' },
		],
		outputDocs: [
			{ key: 'exitCode', description: 'The exit code.' },
			{ key: 'stdout', description: 'Standard output (the end of it, when long).' },
			{ key: 'stderr', description: 'Standard error.' },
			{ key: 'durationMs', description: 'How long it ran.' },
		],
		permissions: ['shell'],
		summary: config => clip(config.command),
		simulate: context => ({ output: { exitCode: 0, stdout: `$ ${clip(context.config.command, 120) ?? ''}\nok (simulated)`, stderr: '', durationMs: 1840 }, port: 'passed' }),
	},
	{
		type: 'http',
		category: 'scripts',
		label: 'HTTP Request',
		description: 'Calls a URL and continues with the response.',
		icon: 'globe',
		color: 'blue',
		keywords: 'api rest request fetch get post curl url',
		control: 'task',
		inputs: IN,
		outputs: pair('success', 'fail'),
		fields: [
			{ key: 'method', label: 'Method', kind: 'select', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(value => ({ value, label: value })) },
			{ key: 'url', label: 'URL', kind: 'text', required: true, templates: true, placeholder: 'https://api.example.com/items' },
			{ key: 'headers', label: 'Headers', kind: 'keyValue', templates: true },
			{ key: 'query', label: 'Query', kind: 'keyValue', templates: true, advanced: true },
			{ key: 'body', label: 'Body', kind: 'json', templates: true, language: 'json', visibleWhen: { key: 'method', equals: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
			{ key: 'timeout', label: 'Timeout', kind: 'duration', advanced: true, default: '30s', description: TIMEOUT_DOCS },
			{ key: 'expectStatus', label: 'Success status', kind: 'text', advanced: true, placeholder: '2xx', description: 'Status codes that count as success: 200, 2xx, 200-299 (2xx when empty).' },
		],
		outputDocs: [
			{ key: 'status', description: 'The HTTP status code.' },
			{ key: 'ok', description: 'Whether the status counted as success.' },
			{ key: 'headers', description: 'Response headers (lower-case names).' },
			{ key: 'body', description: 'The response body (parsed when JSON).' },
			{ key: 'durationMs', description: 'How long the request took.' },
		],
		permissions: ['network'],
		summary: config => joinSummary(`${str(config.method) || 'GET'} ${host(config.url) ?? ''}`.trim()),
		validate: node => checkUrl(node, 'url', /^https?:\/\/\S+$/i),
		simulate: context => {
			const expected = /^\d{3}$/.exec(str(context.config.expectStatus).trim());
			const status = expected ? Number(expected[0]) : context.config.method === 'POST' ? 201 : 200;
			return { output: { status, ok: true, headers: { 'content-type': 'application/json' }, body: { ok: true, simulated: true }, durationMs: 182 }, port: 'success' };
		},
	},
	{
		type: 'webhook',
		category: 'scripts',
		label: 'Send Webhook',
		description: 'Posts a JSON payload to a webhook URL.',
		icon: 'radio-tower',
		color: 'blue',
		keywords: 'post notify callback hook zapier',
		control: 'task',
		inputs: IN,
		outputs: pair('sent', 'failed'),
		fields: [
			{ key: 'url', label: 'URL', kind: 'text', required: true, templates: true, placeholder: 'https://example.com/hooks/volt' },
			{ key: 'payload', label: 'Payload', kind: 'json', templates: true, language: 'json', default: '{{ input }}' },
		],
		outputDocs: [{ key: 'status', description: 'The HTTP status code.' }],
		permissions: ['network'],
		summary: config => host(config.url),
		validate: node => checkUrl(node, 'url', /^https?:\/\/\S+$/i),
		simulate: () => ({ output: { status: 200 }, port: 'sent' }),
	},

	//#endregion

	//#region Git

	{
		type: 'git_commit',
		category: 'git',
		group: 'Git',
		label: 'Commit',
		description: 'Commits the repository\'s changes.',
		icon: 'git-commit',
		color: 'orange',
		keywords: 'git commit save changes stage',
		control: 'task',
		inputs: IN,
		outputs: () => [port('committed', 'success'), port('nothing', 'neutral', 'nothing to commit'), port('failed', 'failure')],
		fields: [
			{ key: 'message', label: 'Message', kind: 'text', required: true, templates: true, placeholder: 'fix: {{ inputs.task }}' },
			{ key: 'addAll', label: 'Stage all changes', kind: 'boolean', default: true },
		],
		outputDocs: [
			{ key: 'sha', description: 'The new commit.' },
			{ key: 'message', description: 'Its message.' },
			{ key: 'files', description: 'How many files it changed.' },
		],
		permissions: ['git'],
		summary: config => clip(config.message),
		simulate: context => ({ output: { sha: fakeHash(context.stepId + str(context.config.message)), message: str(context.config.message), files: 3 }, port: 'committed' }),
	},
	{
		type: 'git_push',
		category: 'git',
		group: 'Git',
		label: 'Push',
		description: 'Pushes the current branch to its remote.',
		icon: 'repo-push',
		color: 'orange',
		keywords: 'git push upload remote origin',
		control: 'task',
		inputs: IN,
		outputs: pair('pushed', 'failed'),
		fields: [{ key: 'setUpstream', label: 'Set upstream', kind: 'boolean', default: true, description: 'Tracks the remote branch when it is new.' }],
		outputDocs: [
			{ key: 'branch', description: 'The branch pushed.' },
			{ key: 'remote', description: 'The remote it went to.' },
		],
		permissions: ['git'],
		summary: () => 'origin',
		simulate: () => ({ output: { branch: 'volt/workflow', remote: 'origin' }, port: 'pushed' }),
	},
	{
		type: 'git_sync',
		category: 'git',
		group: 'Git',
		label: 'Sync with Base',
		description: 'Brings the branch up to date with its base branch.',
		icon: 'repo-pull',
		color: 'orange',
		keywords: 'git pull rebase merge update main conflict',
		control: 'task',
		inputs: IN,
		outputs: () => [port('synced', 'success'), port('conflict', 'failure')],
		fields: [
			{ key: 'base', label: 'Base branch', kind: 'text', default: 'main', templates: true },
			{ key: 'strategy', label: 'Strategy', kind: 'select', default: 'rebase', advanced: true, options: [{ value: 'rebase', label: 'Rebase' }, { value: 'merge', label: 'Merge' }] },
		],
		outputDocs: [
			{ key: 'base', description: 'The base branch.' },
			{ key: 'behind', description: 'Commits it was behind.' },
			{ key: 'conflicts', description: 'Conflicting files, on conflict.' },
		],
		permissions: ['git'],
		summary: config => `onto ${str(config.base) || 'main'}`,
		simulate: context => ({ output: { base: str(context.config.base) || 'main', behind: 2, conflicts: [] }, port: 'synced' }),
	},
	{
		type: 'git_branch',
		category: 'git',
		group: 'Git',
		label: 'Create Branch',
		description: 'Creates a branch and switches to it.',
		icon: 'git-branch',
		color: 'orange',
		keywords: 'git branch checkout switch new',
		control: 'task',
		inputs: IN,
		outputs: pair('created', 'failed'),
		fields: [
			{ key: 'name', label: 'Name', kind: 'text', required: true, templates: true, placeholder: 'volt/{{ run.id }}' },
			{ key: 'from', label: 'From', kind: 'text', advanced: true, placeholder: 'The current branch' },
		],
		outputDocs: [{ key: 'branch', description: 'The branch created.' }],
		permissions: ['git'],
		summary: config => clip(config.name),
		simulate: context => ({ output: { branch: str(context.config.name) || 'volt/workflow' }, port: 'created' }),
	},
	{
		type: 'github_pr',
		category: 'git',
		group: 'GitHub',
		label: 'Open Pull Request',
		description: 'Opens a pull request for the current branch.',
		icon: 'git-pull-request',
		color: 'default',
		keywords: 'github pr pull request review open create',
		control: 'task',
		inputs: IN,
		outputs: pair('opened', 'failed'),
		fields: [
			{ key: 'title', label: 'Title', kind: 'text', required: true, templates: true, placeholder: '{{ inputs.task }}' },
			{ key: 'body', label: 'Description', kind: 'multiline', templates: true, placeholder: '{{ nodes.summary.summary }}' },
			{ key: 'draft', label: 'Draft', kind: 'boolean', default: false },
			{ key: 'base', label: 'Base branch', kind: 'text', advanced: true, placeholder: 'The default branch' },
		],
		outputDocs: [
			{ key: 'number', description: 'The pull request number.' },
			{ key: 'url', description: 'Its URL.' },
			{ key: 'title', description: 'Its title.' },
		],
		permissions: ['git', 'network'],
		summary: config => joinSummary(config.draft === true && 'draft', typeof config.base === 'string' && config.base && `into ${config.base}`) ?? clip(config.title),
		simulate: context => ({ output: { number: 42, url: 'https://github.com/owner/repo/pull/42', title: str(context.config.title) }, port: 'opened' }),
	},
	{
		type: 'github_wait_ci',
		category: 'git',
		group: 'GitHub',
		label: 'Wait for CI',
		description: 'Waits for the pull request\'s checks to finish.',
		icon: 'github-action',
		color: 'default',
		keywords: 'github actions checks ci build status wait',
		control: 'task',
		inputs: IN,
		outputs: () => [port('passed', 'success'), port('failed', 'failure'), port('timeout', 'failure')],
		fields: [{ key: 'timeout', label: 'Timeout', kind: 'duration', default: '30m', description: TIMEOUT_DOCS }],
		outputDocs: [
			{ key: 'conclusion', description: 'success, failure or timed_out.' },
			{ key: 'checks', description: 'Each check: name and conclusion.' },
			{ key: 'failed', description: 'Names of the checks that failed.' },
		],
		permissions: ['git', 'network'],
		summary: config => `up to ${formatWorkflowDuration(parseWorkflowDuration(config.timeout) ?? 1_800_000)}`,
		simulate: () => ({ output: { conclusion: 'success', checks: [{ name: 'build', conclusion: 'success' }, { name: 'test', conclusion: 'success' }], failed: [] }, port: 'passed' }),
	},
	{
		type: 'github_pr_comment',
		category: 'git',
		group: 'GitHub',
		label: 'Comment on PR',
		description: 'Adds a comment to the pull request.',
		icon: 'comment',
		color: 'default',
		keywords: 'github comment review reply pr',
		control: 'task',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [{ key: 'body', label: 'Comment', kind: 'multiline', required: true, templates: true }],
		outputDocs: [{ key: 'url', description: 'The comment\'s URL.' }],
		permissions: ['git', 'network'],
		summary: config => clip(config.body),
		simulate: () => ({ output: { url: 'https://github.com/owner/repo/pull/42#issuecomment-1' }, port: 'done' }),
	},
	{
		type: 'github_update_pr',
		category: 'git',
		group: 'GitHub',
		label: 'Update PR',
		description: 'Marks the pull request ready, adds labels or requests reviewers.',
		icon: 'git-pull-request-draft',
		color: 'default',
		keywords: 'github ready review label reviewer assign',
		control: 'task',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [
			{ key: 'ready', label: 'Ready for review', kind: 'boolean', default: false },
			{ key: 'labels', label: 'Labels', kind: 'list' },
			{ key: 'reviewers', label: 'Reviewers', kind: 'list' },
		],
		outputDocs: [
			{ key: 'number', description: 'The pull request number.' },
			{ key: 'url', description: 'Its URL.' },
		],
		permissions: ['git', 'network'],
		summary: config => joinSummary(config.ready === true && 'ready', strings(config.labels).length > 0 && clip(strings(config.labels).join(', '), 24), strings(config.reviewers).length > 0 && `@${strings(config.reviewers)[0]}`),
		simulate: () => ({ output: { number: 42, url: 'https://github.com/owner/repo/pull/42' }, port: 'done' }),
	},
	{
		type: 'github_issue_comment',
		category: 'git',
		group: 'GitHub',
		label: 'Comment on Issue',
		description: 'Adds a comment to an issue.',
		icon: 'issues',
		color: 'default',
		keywords: 'github issue comment reply triage',
		control: 'task',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [
			{ key: 'issue', label: 'Issue', kind: 'text', required: true, templates: true, placeholder: '{{ trigger.payload.issue.number }}' },
			{ key: 'body', label: 'Comment', kind: 'multiline', required: true, templates: true },
		],
		outputDocs: [{ key: 'url', description: 'The comment\'s URL.' }],
		permissions: ['git', 'network'],
		summary: config => {
			const issueRef = bare(config.issue);
			return issueRef && /^\d+$/.test(issueRef) ? `#${issueRef}` : issueRef;
		},
		simulate: context => ({ output: { issue: context.config.issue ?? null, url: 'https://github.com/owner/repo/issues/7#issuecomment-1' }, port: 'done' }),
	},

	//#endregion

	//#region MCP, skills

	{
		type: 'mcp_tool',
		category: 'mcp',
		label: 'MCP Tool',
		description: 'Calls one tool of an MCP server, with fixed arguments or instructions for an agent.',
		icon: 'mcp',
		color: 'teal',
		badge: 'MCP',
		keywords: 'mcp tool server call integration',
		control: 'task',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [
			{ key: 'server', label: 'Server', kind: 'mcpServer', required: true },
			{ key: 'tool', label: 'Tool', kind: 'text', required: true, placeholder: 'search_issues' },
			{ key: 'arguments', label: 'Arguments', kind: 'json', templates: true, language: 'json' },
			{ key: 'instructions', label: 'Instructions', kind: 'multiline', templates: true, advanced: true, description: 'When set, an agent calls the tool and picks the arguments from these instructions.' },
		],
		outputDocs: [
			{ key: 'result', description: 'The tool\'s result (parsed when JSON).' },
			{ key: 'text', description: 'The result\'s text content.' },
		],
		permissions: ['agent', 'network'],
		summary: config => joinSummary(clip(config.server, 20), clip(config.tool, 24)),
		simulate: context => ({ output: { result: { ok: true, simulated: true }, text: `${str(context.config.tool) || 'tool'} returned (simulated)` }, port: 'done' }),
	},
	{
		type: 'skill',
		category: 'skills',
		label: 'Skill',
		description: 'Runs one of your skills as an agent session.',
		icon: 'lightbulb',
		color: 'pink',
		keywords: 'skill slash command review recipe',
		control: 'task',
		inputs: IN,
		outputs: DONE_FAILED,
		fields: [
			{ key: 'skill', label: 'Skill', kind: 'skill', required: true },
			{ key: 'prompt', label: 'Prompt', kind: 'prompt', templates: true, placeholder: 'Extra instructions for the skill' },
			MODEL_FIELD,
		],
		outputDocs: [
			{ key: 'summary', description: 'The agent\'s final message.' },
			{ key: 'threadId', description: 'The chat it ran in.' },
		],
		permissions: ['agent'],
		summary: config => joinSummary(typeof config.skill === 'string' && config.skill ? `/${config.skill}` : undefined, modelShort(config.model)),
		simulate: context => simulatedAgent(context, `/${str(context.config.skill)} ${str(context.config.prompt)}`.trim()),
	},

	//#endregion

	//#region Integrations

	{
		type: 'slack_message',
		category: 'integrations',
		group: 'Slack',
		label: 'Slack Message',
		description: 'Posts a message to Slack through an incoming webhook.',
		icon: 'mention',
		color: 'pink',
		keywords: 'slack message chat notify post channel',
		control: 'task',
		inputs: IN,
		outputs: pair('sent', 'failed'),
		fields: [
			{ key: 'webhookUrl', label: 'Webhook URL', kind: 'text', required: true, placeholder: 'https://hooks.slack.com/services/…' },
			{ key: 'text', label: 'Message', kind: 'multiline', required: true, templates: true },
			{ key: 'channel', label: 'Channel', kind: 'text', advanced: true, placeholder: '#releases' },
		],
		outputDocs: [{ key: 'ok', description: 'Whether Slack accepted it.' }],
		permissions: ['messaging', 'network'],
		summary: config => typeof config.channel === 'string' && config.channel ? config.channel : clip(config.text),
		validate: node => checkUrl(node, 'webhookUrl', /^https:\/\/\S+$/i),
		simulate: context => ({ output: { ok: true, channel: context.config.channel ?? null }, port: 'sent' }),
	},
	{
		type: 'teams_message',
		category: 'integrations',
		group: 'Microsoft Teams',
		label: 'Teams Message',
		description: 'Posts a message to a Microsoft Teams channel through a webhook.',
		icon: 'organization',
		color: 'blue',
		keywords: 'teams microsoft message chat notify channel',
		control: 'task',
		inputs: IN,
		outputs: pair('sent', 'failed'),
		fields: [
			{ key: 'webhookUrl', label: 'Webhook URL', kind: 'text', required: true, placeholder: 'https://….webhook.office.com/…' },
			{ key: 'text', label: 'Message', kind: 'multiline', required: true, templates: true },
		],
		outputDocs: [{ key: 'ok', description: 'Whether Teams accepted it.' }],
		permissions: ['messaging', 'network'],
		summary: config => clip(config.text),
		validate: node => checkUrl(node, 'webhookUrl', /^https:\/\/\S+$/i),
		simulate: () => ({ output: { ok: true }, port: 'sent' }),
	},

	//#endregion

	//#region Data

	{
		type: 'transform',
		category: 'data',
		label: 'Transform',
		description: 'Builds a new record from fields you define with templates.',
		icon: 'symbol-structure',
		color: 'green',
		keywords: 'map set fields reshape rename object data',
		control: 'task',
		pure: true,
		inputs: IN,
		outputs: NEXT,
		fields: [{ key: 'fields', label: 'Fields', kind: 'keyValue', required: true, templates: true, description: 'Each field of the output, e.g. title: {{ nodes.pr.title }}.' }],
		outputDocs: [],
		permissions: [],
		summary: config => clip(Object.keys(keyValueRecord(config.fields)).join(', ')),
		simulate: context => ({ output: keyValueRecord(context.config.fields) }),
	},
	{
		type: 'filter',
		category: 'data',
		label: 'Filter',
		description: 'Keeps the list items for which a condition holds.',
		icon: 'filter',
		color: 'green',
		keywords: 'where select keep remove list array',
		control: 'task',
		pure: true,
		inputs: IN,
		outputs: () => [port('next', 'success', 'Next'), port('empty')],
		fields: [
			{ key: 'items', label: 'Items', kind: 'json', required: true, templates: true, placeholder: '{{ nodes.issues.body }}' },
			{ key: 'condition', label: 'Keep when', kind: 'expression', required: true, placeholder: 'item.state == \'open\'', description: 'Read the item as item, its position as loop.index.' },
		],
		outputDocs: [
			{ key: 'items', description: 'The items kept.' },
			{ key: 'count', description: 'How many were kept.' },
			{ key: 'removed', description: 'How many were removed.' },
		],
		permissions: [],
		summary: config => clip(config.condition),
		simulate: context => {
			const items = workflowItemsList(context.config.items);
			if (!items) {
				throw new WorkflowNodeError('Items must be a list');
			}
			const condition = str(context.config.condition);
			const kept = items.filter((item, index) => isTruthy(evaluateExpression(condition, { ...context.scope, item, loop: { index, iteration: index + 1, max: items.length } })));
			return { output: { items: kept, count: kept.length, removed: items.length - kept.length }, port: kept.length ? 'next' : 'empty' };
		},
	},
	{
		type: 'parse_json',
		category: 'data',
		label: 'Parse JSON',
		description: 'Reads JSON from text (an agent\'s answer, a command\'s output).',
		icon: 'json',
		color: 'green',
		keywords: 'json parse decode object extract',
		control: 'task',
		pure: true,
		inputs: IN,
		outputs: () => [port('parsed', 'success'), port('invalid', 'failure')],
		fields: [{ key: 'text', label: 'Text', kind: 'multiline', required: true, templates: true, default: '{{ input.summary }}' }],
		outputDocs: [
			{ key: 'value', description: 'The parsed value.' },
			{ key: 'error', description: 'Why it did not parse (invalid only).' },
		],
		permissions: [],
		simulate: (context): IWorkflowNodeResult => {
			const text = context.config.text;
			if (typeof text !== 'string') {
				return { output: { value: text ?? null }, port: 'parsed' };
			}
			try {
				return { output: { value: JSON.parse(stripFences(text)) }, port: 'parsed' };
			} catch (error) {
				return { output: { error: error instanceof Error ? error.message : String(error), text: text.slice(0, 2000) }, port: 'invalid' };
			}
		},
	},
	{
		type: 'template',
		category: 'data',
		label: 'Text Template',
		description: 'Writes text from a template, for prompts, messages and reports.',
		icon: 'symbol-snippet',
		color: 'green',
		keywords: 'text format string compose message markdown',
		control: 'task',
		pure: true,
		inputs: IN,
		outputs: NEXT,
		fields: [{ key: 'text', label: 'Text', kind: 'multiline', required: true, templates: true, placeholder: 'Tests {{ nodes.check.exitCode == 0 ? \'passed\' : \'failed\' }}' }],
		outputDocs: [{ key: 'text', description: 'The text written.' }],
		permissions: [],
		summary: config => clip(config.text),
		simulate: context => ({ output: { text: str(context.config.text) } }),
	},

	//#endregion

	//#region Outputs

	{
		type: 'notify',
		category: 'outputs',
		label: 'Notify',
		description: 'Shows a Volt notification.',
		icon: 'bell',
		color: 'yellow',
		keywords: 'notification alert toast message tell',
		control: 'task',
		inputs: IN,
		outputs: NEXT,
		fields: [
			{ key: 'title', label: 'Title', kind: 'text', required: true, templates: true },
			{ key: 'message', label: 'Message', kind: 'multiline', templates: true },
			{ key: 'severity', label: 'Severity', kind: 'select', default: 'info', options: [{ value: 'info', label: 'Info' }, { value: 'warning', label: 'Warning' }, { value: 'error', label: 'Error' }] },
		],
		outputDocs: [],
		permissions: [],
		summary: config => clip(config.title),
		simulate: context => ({ output: { title: str(context.config.title), message: str(context.config.message), severity: str(context.config.severity) || 'info' } }),
	},
	{
		type: 'log',
		category: 'outputs',
		label: 'Log',
		description: 'Writes a line to the run\'s log.',
		icon: 'output',
		color: 'default',
		keywords: 'log print debug trace echo',
		control: 'task',
		pure: true,
		inputs: IN,
		outputs: NEXT,
		fields: [
			{ key: 'message', label: 'Message', kind: 'multiline', required: true, templates: true },
			{ key: 'level', label: 'Level', kind: 'select', default: 'info', options: [{ value: 'debug', label: 'Debug' }, { value: 'info', label: 'Info' }, { value: 'warn', label: 'Warning' }, { value: 'error', label: 'Error' }] },
		],
		outputDocs: [{ key: 'message', description: 'The line written.' }],
		permissions: [],
		summary: config => joinSummary(config.level !== 'info' && typeof config.level === 'string' && config.level, clip(config.message, 32)),
		simulate: context => {
			const level = context.config.level === 'debug' || context.config.level === 'warn' || context.config.level === 'error' ? context.config.level : 'info';
			const message = str(context.config.message);
			context.log(level, message);
			return { output: { message, level } };
		},
	},
	{
		type: 'write_file',
		category: 'outputs',
		label: 'Write File',
		description: 'Writes text to a file in the repository.',
		icon: 'save',
		color: 'default',
		keywords: 'file save write report output markdown',
		control: 'task',
		inputs: IN,
		outputs: pair('written', 'failed'),
		fields: [
			{ key: 'path', label: 'Path', kind: 'text', required: true, templates: true, placeholder: 'reports/{{ run.id }}.md', description: 'Relative to the repository.' },
			{ key: 'content', label: 'Content', kind: 'multiline', required: true, templates: true },
			{ key: 'mode', label: 'If it exists', kind: 'select', default: 'overwrite', options: [{ value: 'overwrite', label: 'Overwrite' }, { value: 'append', label: 'Append' }, { value: 'create', label: 'Fail' }] },
		],
		outputDocs: [
			{ key: 'path', description: 'The file written.' },
			{ key: 'bytes', description: 'How many bytes were written.' },
		],
		permissions: ['filesystem'],
		summary: config => clip(config.path),
		validate: node => {
			const path = str(node.config.path);
			return /^([a-z]:)?[\\/]|(^|[\\/])\.\.([\\/]|$)/i.test(path) && !path.includes('{{') ? [issue(node, 'path-outside', 'The path must stay inside the repository', 'path', 'warning')] : [];
		},
		simulate: context => ({ output: { path: str(context.config.path), bytes: new TextEncoder().encode(str(context.config.content)).length }, port: 'written' }),
	},

	//#endregion

	//#region Custom

	{
		type: 'package_script',
		category: 'custom',
		label: 'Package Script',
		description: 'Runs a script from package.json with the project\'s package manager.',
		icon: 'package',
		color: 'default',
		keywords: 'npm yarn pnpm bun script test build lint run',
		control: 'task',
		inputs: IN,
		outputs: pair('passed', 'failed'),
		fields: [
			{ key: 'script', label: 'Script', kind: 'text', required: true, placeholder: 'test' },
			{ key: 'args', label: 'Arguments', kind: 'text', templates: true, advanced: true, placeholder: '--coverage' },
		],
		outputDocs: [
			{ key: 'exitCode', description: 'The exit code.' },
			{ key: 'stdout', description: 'Standard output (the end of it, when long).' },
			{ key: 'stderr', description: 'Standard error.' },
			{ key: 'durationMs', description: 'How long it ran.' },
		],
		permissions: ['shell'],
		summary: config => clip(`${str(config.script)} ${str(config.args)}`.trim()),
		simulate: context => ({ output: { exitCode: 0, stdout: `> ${str(context.config.script)}\nok (simulated)`, stderr: '', durationMs: 2600 }, port: 'passed' }),
	},

	//#endregion
];
