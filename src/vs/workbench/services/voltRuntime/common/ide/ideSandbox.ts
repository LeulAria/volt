/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { HostToolSandboxClass, IHostToolSandboxUse } from '../hostToolSandbox.js';
import { COVERAGE_REPORT_FILES } from './coverageReports.js';
import { IDE_GATEWAY_TOOL_NAME, ideOp } from './ideCapabilities.js';
import { DEBUG_TOOL_NAME, TASKS_TOOL_NAME, TESTS_TOOL_NAME } from './ideTools.js';

/**
 * The IDE tools for a chat in Volt's OS sandbox, op by op (`hostToolSandboxUse` asks here):
 *
 * - `tests`: listing and results are Volt's Testing state, filtered to the files the chat may read; a
 *   run executes the project's test command in the chat's sandbox (`sandboxed`), and only on Volt's
 *   own runner (an extension's controller runs tests in its extension host, outside the sandbox).
 * - `debug`: a debugger starts the program and its adapter outside the sandbox, and resuming,
 *   stepping, evaluating or a conditional breakpoint runs code in it: `escapes`. Reading the state of
 *   a session the chat itself started, and plain breakpoints, are Volt's state.
 * - `tasks`: a task runs its command in a task terminal outside the sandbox: `escapes`. Listing is
 *   Volt's state; status, output and stop serve only the chat's own tasks.
 * - `ide`: per capability and op (`IIdeOpSpec.sandbox` in `ideCapabilities.ts`).
 */
export function ideToolSandboxUse(name: string, args: Readonly<Record<string, unknown>>): IHostToolSandboxUse | undefined {
	const op = typeof args.op === 'string' ? args.op.trim() : '';
	switch (name) {
		case TESTS_TOOL_NAME:
			if (op === 'run') {
				return { kind: 'sandboxed' };
			}
			// list, results (and an unknown op, which the tool refuses before reading anything): the folder or file named.
			return { kind: 'reads', reads: pathsOr(args, ['path'], ['.']) };
		case DEBUG_TOOL_NAME:
			return { kind: debugClass(op, args) };
		case TASKS_TOOL_NAME:
			return { kind: op === 'run' ? 'escapes' : 'safe' };
		case IDE_GATEWAY_TOOL_NAME:
			return gatewayUse(args);
	}
	return undefined;
}

const DEBUG_READS = new Set(['state', 'variables', 'output', 'stop']);

function debugClass(op: string, args: Readonly<Record<string, unknown>>): HostToolSandboxClass {
	if (DEBUG_READS.has(op)) {
		return 'safe';
	}
	if (op === 'breakpoints') {
		// A condition or a logpoint is code the debuggee runs when the user debugs it next.
		return text(args.condition) || text(args.log) ? 'escapes' : 'safe';
	}
	// start, attach, continue, step, pause, run_to, evaluate, watch (evaluates its expressions), and anything unknown.
	return 'escapes';
}

/** Files the `remote info` op reads: the project's dev container config. */
export const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'] as const;

function gatewayUse(args: Readonly<Record<string, unknown>>): IHostToolSandboxUse {
	const capability = typeof args.capability === 'string' ? args.capability : '';
	const op = typeof args.op === 'string' ? args.op : '';
	const spec = ideOp(capability, op);
	if (!spec) {
		// help, or a capability or op that does not exist: the tool answers with its help, nothing runs.
		return { kind: 'safe' };
	}
	const opArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args as Readonly<Record<string, unknown>> : {};
	switch (spec.sandbox) {
		case 'reads': {
			const fixed = capability === 'coverage' ? ['.', ...COVERAGE_REPORT_FILES] : capability === 'remote' ? ['.', ...DEVCONTAINER_FILES] : [];
			const named = capability === 'coverage' ? [] : pathsOr(opArgs, ['path', 'paths', 'file'], fixed.length ? [] : ['.']);
			const use: IHostToolSandboxUse = { kind: 'reads', reads: [...fixed, ...named] };
			// A request's URL is judged here when the call names it; the capability judges it again once variables are filled in.
			return capability === 'http' && op === 'send' && text(opArgs.url) ? { ...use, urls: [text(opArgs.url)!] } : use;
		}
		case 'writes':
			return { kind: 'writes', writes: pathsOr(opArgs, ['path'], []) };
		default:
			return { kind: spec.sandbox };
	}
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The paths an op names in `keys` (strings or lists of strings), else `fallback`. */
function pathsOr(args: Readonly<Record<string, unknown>>, keys: readonly string[], fallback: readonly string[]): string[] {
	const out: string[] = [];
	for (const key of keys) {
		const value = args[key];
		for (const item of Array.isArray(value) ? value : [value]) {
			const path = text(item);
			if (path) {
				out.push(path);
			}
		}
	}
	return out.length ? out : [...fallback];
}

const SHELL_TESTS = 'Run the tests with your own shell tool instead: it runs inside the sandbox.';

/** What a sandboxed chat's model should do instead of an IDE op it was refused, or undefined for the gate's default. */
export function ideSandboxInstead(name: string, args: Readonly<Record<string, unknown>>): string | undefined {
	const op = typeof args.op === 'string' ? args.op.trim() : '';
	switch (name) {
		case TESTS_TOOL_NAME:
			return SHELL_TESTS;
		case DEBUG_TOOL_NAME:
			return op === 'start' || op === 'attach'
				? 'Run the program with your own shell tool instead (it runs inside the sandbox) and add logging where you need runtime values, or ask the user to debug it.'
				: 'It would run code in a debug session outside the sandbox. Ask the user to drive the debugger, or add logging and run the program with your own shell tool.';
		case TASKS_TOOL_NAME:
			return 'Run the task\'s command with your own shell tool instead (tasks.json or package.json says what it runs): it runs inside the sandbox.';
		case IDE_GATEWAY_TOOL_NAME: {
			const capability = typeof args.capability === 'string' ? args.capability : '';
			switch (`${capability}.${typeof args.op === 'string' ? args.op : ''}`) {
				case 'notebook.run': return 'The notebook\'s kernel runs outside the sandbox. Run the code with your own shell tool (for example `python script.py`) instead, or ask the user to run the cells.';
				case 'remote.hosts': return '~/.ssh is a credential folder the sandbox keeps out of reach. Ask the user which host to use.';
				case 'remote.exec': return 'ssh would run with the user\'s keys outside the sandbox. Ask the user to run the command on the host.';
				case 'extensions.run': return 'Editor and extension commands run outside the sandbox. Ask the user to run the command.';
			}
			return undefined;
		}
	}
	return undefined;
}
