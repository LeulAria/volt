/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from '../hostTools.js';
import { IDE_GATEWAY_SCHEMA, IDE_GATEWAY_TOOL_NAME, ideGatewayDescription, isIdeGatewayReadOnly } from './ideCapabilities.js';

/**
 * The IDE as agent tools: VS Code's Testing, Debug and Tasks services behind three op-based tools
 * plus the `ide` gateway for every other capability (`ideCapabilities.ts`),
 * served by the window (`AgentIdeService`) to Volt's own loop and, over the volt MCP server, to
 * Claude Code, Codex and other agents. One tool per service keeps the tool list short (it is part
 * of every cached prompt); each op answers with the state the agent needs next, so a step costs one
 * call (a debugger step returns where it stopped and the locals there).
 */

/**
 * `voltModule.feature` of `extensions/volt-dev-environment`: off, these tools, the Testing view's
 * Volt tests and the Agent Sessions view go away.
 */
export const DEV_ENVIRONMENT_FEATURE_ID = 'devEnvironment';

export const TESTS_TOOL_NAME = 'tests';
export const DEBUG_TOOL_NAME = 'debug';
export const TASKS_TOOL_NAME = 'tasks';

export const IDE_TOOL_NAMES = [TESTS_TOOL_NAME, DEBUG_TOOL_NAME, TASKS_TOOL_NAME, IDE_GATEWAY_TOOL_NAME] as const;
export type IdeToolName = typeof IDE_TOOL_NAMES[number];

export function isIdeToolName(name: string): name is IdeToolName {
	return (IDE_TOOL_NAMES as readonly string[]).includes(name);
}

export const TEST_OPS = ['list', 'run', 'results'] as const;
export const DEBUG_OPS = ['start', 'attach', 'breakpoints', 'continue', 'step', 'pause', 'run_to', 'state', 'variables', 'evaluate', 'watch', 'output', 'stop'] as const;
export const TASK_OPS = ['list', 'run', 'status', 'output', 'stop'] as const;

const READ_ONLY_OPS: Readonly<Record<Exclude<IdeToolName, typeof IDE_GATEWAY_TOOL_NAME>, ReadonlySet<string>>> = {
	[TESTS_TOOL_NAME]: new Set(['list', 'results']),
	[DEBUG_TOOL_NAME]: new Set(['state', 'variables', 'output', 'watch']),
	[TASKS_TOOL_NAME]: new Set(['list', 'status', 'output']),
};

/** Whether a call only reads state (no code runs, nothing changes): such calls skip approval. */
export function isIdeReadOnlyCall(name: string, args: unknown): boolean {
	if (!isIdeToolName(name)) {
		return false;
	}
	if (name === IDE_GATEWAY_TOOL_NAME) {
		return isIdeGatewayReadOnly(args);
	}
	const op = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).op : undefined;
	if (name === DEBUG_TOOL_NAME && op === 'breakpoints') {
		const action = (args as Record<string, unknown>).action;
		return action === undefined || action === 'list';
	}
	return typeof op === 'string' && READ_ONLY_OPS[name].has(op);
}

export const IDE_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: TESTS_TOOL_NAME,
		title: 'Tests',
		group: 'ide',
		description: [
			'The editor\'s test runner (the Testing view: installed test extensions plus Volt\'s runner for vitest, jest, mocha, pytest, go test and cargo test). Runs show live in the Test Explorer for the user.',
			'op list: frameworks and tests (filter by path or query). op run: runs targets and returns pass/fail counts plus each failure with its message, expected/actual and the stack frames in the workspace;',
			'targets are files, folders, file:line (the test at that line) or test names; omit targets to run everything; failed: true reruns the last failures.',
			'op results: the last run again, or one test\'s full messages and output (target).',
			'Prefer it over running the test command in shell: it targets single tests, returns structured failures and is visible to the user.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				op: { type: 'string', enum: [...TEST_OPS] },
				targets: { type: 'array', items: { type: 'string' }, description: 'Files, folders, file:line or test names' },
				path: { type: 'string', description: 'list: only tests under this path' },
				query: { type: 'string', description: 'list: only tests whose name contains this' },
				failed: { type: 'boolean', description: 'run: rerun the tests that failed last time' },
				coverage: { type: 'boolean', description: 'run: collect coverage when a coverage profile exists' },
				target: { type: 'string', description: 'results: one test (name or file:line) for its full output' },
			},
			required: ['op'],
			additionalProperties: false,
		},
		approvalInReadOnlyModes: 'runs the project\'s tests',
	},
	{
		name: DEBUG_TOOL_NAME,
		title: 'Debugger',
		group: 'ide',
		description: [
			'The editor\'s debugger (Debug Adapter Protocol: Node/JS/TS built in, Python, Go and others through their extensions). The user watches the session in the Run and Debug view.',
			'op start: launch a debug session from a launch.json config (config), a file (program), or a shell command whose Node processes are debugged (command, e.g. "npm test"); breakpoints set first; waits until it pauses or ends.',
			'op attach: attach to a running process (port, or pid). op breakpoints: action set|remove|list|clear with path + line (condition, log for a logpoint), or exceptions: all|uncaught|none.',
			'op continue / step (kind over|into|out) / run_to (path + line) / pause: resume and wait for the next pause; each returns where it stopped, the stack and the locals.',
			'op state: the paused location, stack, locals and source. op variables: expand a variable (path like "user.address", frame). op evaluate: an expression in a frame.',
			'op watch: add expressions to the Watch view (expression, or none to read) and get their values at the current pause. op output: the debug console. op stop.',
			'Use it when a failure depends on runtime values: set a breakpoint near the failure, start, inspect, step.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				op: { type: 'string', enum: [...DEBUG_OPS] },
				config: { type: 'string', description: 'start: launch.json configuration name' },
				program: { type: 'string', description: 'start: file to run under the debugger' },
				command: { type: 'string', description: 'start: shell command to debug (Node processes it starts are attached)' },
				args: { type: 'array', items: { type: 'string' }, description: 'start: program arguments' },
				cwd: { type: 'string' },
				stop_on_entry: { type: 'boolean' },
				port: { type: 'integer', description: 'attach: inspector/debug port' },
				pid: { type: 'integer', description: 'attach: process id' },
				language: { type: 'string', description: 'attach/start: node, python, go, ... (default from the file)' },
				action: { type: 'string', enum: ['set', 'remove', 'list', 'clear'], description: 'breakpoints' },
				breakpoints: { type: 'array', items: { type: 'string' }, description: 'start/breakpoints: "path:line" entries to set' },
				path: { type: 'string' },
				line: { type: 'integer' },
				condition: { type: 'string', description: 'breakpoints: break only when this expression is true' },
				log: { type: 'string', description: 'breakpoints: logpoint message ({expr} interpolates) instead of pausing' },
				exceptions: { type: 'string', enum: ['all', 'uncaught', 'none'], description: 'breakpoints: pause on exceptions' },
				kind: { type: 'string', enum: ['over', 'into', 'out'], description: 'step' },
				expression: { type: 'string', description: 'evaluate' },
				frame: { type: 'integer', description: 'Stack frame index from state (default 0, the top)' },
				variable: { type: 'string', description: 'variables: dotted path to expand, e.g. "req.body"' },
				session: { type: 'string', description: 'Session name or id (default: this chat\'s latest)' },
				wait_ms: { type: 'integer', description: 'How long to wait for a pause (default 20000)' },
			},
			required: ['op'],
			additionalProperties: false,
		},
		approvalInReadOnlyModes: 'runs code under the debugger',
	},
	{
		name: TASKS_TOOL_NAME,
		title: 'Tasks',
		group: 'ide',
		description: [
			'The editor\'s tasks (tasks.json plus detected npm scripts, make, gulp...), with their problem matchers.',
			'op list: the tasks. op run: runs one (name) and waits until it exits or, for a watch task, until its first build is done; returns the exit code, problems found and the output tail.',
			'op status: what is running. op output: a task\'s latest output. op stop.',
			'Use it for the project\'s own build/watch tasks; use shell for one-off commands.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				op: { type: 'string', enum: [...TASK_OPS] },
				name: { type: 'string', description: 'Task label (or part of it)' },
				wait_ms: { type: 'integer', description: 'run: how long to wait (default 120000)' },
			},
			required: ['op'],
			additionalProperties: false,
		},
		approvalInReadOnlyModes: 'runs a project task',
	},
	{
		name: IDE_GATEWAY_TOOL_NAME,
		title: 'IDE',
		group: 'ide',
		description: ideGatewayDescription(),
		inputSchema: IDE_GATEWAY_SCHEMA,
		approvalInReadOnlyModes: 'acts on the workspace or its services',
	},
];
