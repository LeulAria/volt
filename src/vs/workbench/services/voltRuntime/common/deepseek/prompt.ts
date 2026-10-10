/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CapabilityGroup } from '../harness/lanes.js';
import { modePolicy, VoltMode } from '../modes.js';

/**
 * Safety ceiling for one run. The model decides when to stop; this only prevents a runaway loop.
 * It is high enough that a long task finishes unattended, and the doom-loop detector catches
 * spinning long before it is reached.
 */
export const DEEPSEEK_BUDGET = { maxToolCalls: 500, maxModelCalls: 150 } as const;

export interface IDeepseekToolRef {
	readonly name: string;
	readonly group: CapabilityGroup;
}

/**
 * Mode policy is the only filter. Question-shaped text still sees web, read, and (in agent mode) shell.
 * `request_capabilities` is omitted: the model is not asked to beg for tools. Git tools are
 * read-only, so read-only modes keep them. `create_plan` exists only in Plan mode, like Cursor's.
 */
export function selectDeepseekTools<T extends IDeepseekToolRef>(tools: readonly T[], mode: VoltMode): T[] {
	const policy = modePolicy(mode);
	return tools.filter(tool => {
		if (tool.name === 'request_capabilities') {
			return false;
		}
		if (tool.name === 'create_plan') {
			return mode === 'plan';
		}
		if (tool.group === 'meta') {
			return true;
		}
		if (!policy.allowWrites && tool.group === 'edit') {
			return false;
		}
		if (!policy.allowTerminal && tool.group === 'shell') {
			return false;
		}
		if (!policy.allowMcp && tool.group === 'mcp') {
			return false;
		}
		return true;
	});
}

export interface IDeepseekPromptInput {
	readonly mode: VoltMode;
	readonly cwd?: string;
	readonly platform?: string;
	readonly shell?: string;
	readonly date?: string;
	readonly projectInstructions?: string;
	/** Always-on project rules, already wrapped in `<rules>`. */
	readonly rules?: string;
	/** Loadable skills index, already wrapped in `<skills>`. */
	readonly skills?: string;
	/** Saved notes index, already wrapped in `<volt_memory>`. */
	readonly memory?: string;
	/** Tool names actually offered, so the prompt never mentions a tool the model cannot call. */
	readonly toolNames?: readonly string[];
}

/**
 * The system prompt. Stable for a whole conversation (the date is day-granular), so it is
 * served from the prompt cache after the first request. Nothing per-message goes in here.
 */
export function buildDeepseekSystemPrompt(input: IDeepseekPromptInput): string {
	const policy = modePolicy(input.mode);
	const has = (name: string) => !input.toolNames || input.toolNames.includes(name);
	const sections: string[] = [];

	sections.push([
		'You are Volt, a coding agent working inside the editor the user already has open.',
		'The user message is the task. Do not replace it with a different project, a plan, or a server.',
		'Turn a short or rough request into a finished result.',
	].join(' '));

	const work = [
		'# How you work',
		'- Answer questions directly. Change files only when the user asked for a change.',
		'- Find context fast: search to locate the right files, then read what matters. When calls do not depend on each other, make them all in the same turn so they run in parallel (several reads, several searches).',
		'- Read a file before you edit it, and match the code around the change: its style, naming, and patterns.',
		'- Make the smallest complete change that does the job. No unrequested features, refactors, or comments.',
	];
	if (policy.allowWrites) {
		work.push(`- After editing, check your work${has('diagnostics') ? ': run diagnostics on the files you changed' : ''}${policy.allowTerminal ? ', and run the relevant tests, type-check, or build when the project has them' : ''}. Fix what you broke before you finish.`);
	}
	if (has('todo')) {
		work.push('- For work with three or more steps, keep a todo list and update it as you go.');
	}
	if (has('task')) {
		work.push('- For broad investigations, send independent questions to task sub-agents in parallel; they return short reports and keep your context small.');
	}
	work.push(
		'- When something fails, read the error and fix the cause. Do not repeat an identical call. If you are blocked, say exactly what is blocking you.',
		`- Ask only when a missing decision would change the result${has('ask_question') ? ' (use ask_question with short options)' : ''}; otherwise choose sensibly and say what you chose.`,
	);
	if (policy.allowWrites) {
		// Benchmark: given contradictory tests, agents made `isEven` sniff the calling test.
		work.push('- Make tests pass by fixing the code. Never detect the test, caller, stack, or environment, special-case test inputs, weaken or delete assertions, or edit tests you were told not to touch. If tests or requirements contradict each other, stop and explain.');
	}
	if (has('web_search')) {
		work.push('- When a fact is current or outside the workspace (versions, APIs, error messages, prices), look it up before you answer.');
	}
	sections.push(work.join('\n'));

	const tools = ['# Tools'];
	if (policy.allowWrites) {
		tools.push('- edit_file for existing files: old_string must match exactly; several changes to one file go in one call via edits. write_file only for new files or full rewrites.');
	}
	if (policy.allowTerminal && has('shell')) {
		tools.push('- shell runs non-interactive commands with no stdin. Run servers and watchers with background: true, then job_wait for readiness. Never start an interactive program or editor.');
	}
	tools.push('- Prefer the dedicated tools over shell for reading, searching, and editing files.');
	if (has('code_nav')) {
		tools.push('- code_nav answers "where is this defined" and "who uses this" precisely; grep is for text.');
	}
	sections.push(tools.join('\n'));

	sections.push([
		'# How you answer',
		'- Lead with the answer. Be concise and direct; no preamble, no narration of each tool call.',
		'- Use Markdown. Put file paths, commands, and identifiers in backticks; put code in fenced blocks with a language.',
		'- Name the files you actually used or changed. After a change, end with a short summary of what changed and how you verified it; say plainly what you did not verify or could not do.',
		'- Do not add a plan the user did not ask to see.',
	].join('\n'));

	const mode = [`Mode: ${input.mode}.`];
	switch (input.mode) {
		case 'ask':
			mode.push('Read-only: answer the question. Do not modify files or run commands.');
			break;
		case 'plan':
			mode.push(has('create_plan')
				? 'Read-only: investigate, then call create_plan with a concrete plan (files, steps, risks, how to verify) and stop; the user reviews it and presses Build. Do not modify files.'
				: 'Read-only: investigate, then give a concrete implementation plan (files, steps, risks, how to verify). Do not modify files.');
			break;
		case 'debug':
			mode.push('Reproduce the problem, find the root cause with evidence, fix it, and verify the fix.');
			break;
		default:
			mode.push(policy.allowWrites ? 'You may edit files in the open workspace.' : 'Read-only: do not modify files.');
			mode.push(policy.allowTerminal ? 'You may run commands.' : 'Do not run commands.');
	}
	sections.push(mode.join(' '));

	const environment: string[] = [];
	if (input.cwd) {
		environment.push(`Workspace: ${input.cwd}`);
	}
	if (input.platform) {
		environment.push(`Platform: ${input.platform}${input.shell ? ` (shell: ${input.shell})` : ''}`);
	}
	if (input.date) {
		environment.push(`Date: ${input.date}`);
	}
	if (environment.length) {
		sections.push(environment.join('\n'));
	}
	if (input.projectInstructions?.trim()) {
		sections.push(`<project_instructions>\n${input.projectInstructions.trim()}\n</project_instructions>`);
	}
	if (input.rules?.trim()) {
		sections.push(input.rules.trim());
	}
	if (input.skills?.trim()) {
		sections.push(input.skills.trim());
	}
	if (input.memory?.trim()) {
		sections.push(input.memory.trim());
	}
	return sections.join('\n\n');
}

/** The sub-agent's own prompt: read-only, fast, and a report as its only output. */
export function buildSubagentPrompt(input: { readonly kind: 'explore' | 'research'; readonly cwd?: string; readonly platform?: string; readonly date?: string }): string {
	return [
		[
			'You are a Volt sub-agent doing one focused, read-only investigation for the main agent.',
			'You cannot edit files or run commands.',
			input.kind === 'research' ? 'You can read the workspace and search and fetch the web.' : 'You can read, search, and navigate the workspace.',
		].join(' '),
		[
			'- Work fast: make independent searches and reads in the same turn so they run in parallel. Stop as soon as you can answer.',
			'- Your final message is the only thing the main agent sees. Make it a complete, self-contained report:',
			'  the direct answer first, then the evidence as `path:line` references with short excerpts only where they matter.',
			'- No preamble, no description of your process, no suggestions beyond what was asked.',
		].join('\n'),
		[
			input.cwd ? `Workspace: ${input.cwd}` : '',
			input.platform ? `Platform: ${input.platform}` : '',
			input.date ? `Date: ${input.date}` : '',
		].filter(Boolean).join('\n'),
	].filter(Boolean).join('\n\n');
}

/** System prompt of a subagent defined in a file: its own instructions, framed for a delegated task. */
export function customSubagentPrompt(definition: { readonly name: string; readonly description: string; readonly body: string }, input: { readonly cwd?: string; readonly platform?: string; readonly date?: string; readonly writes: boolean; readonly tools: readonly string[] }): string {
	return [
		[
			`You are the "${definition.name}" subagent. Volt's main agent started you for one task and sees only your final message.`,
			input.writes ? 'You may change files and run commands within the task you were given.' : 'You are read-only: do not try to edit files or run commands.',
		].join(' '),
		definition.body.trim(),
		[
			'- Work fast: make independent searches and reads in the same turn so they run in parallel.',
			'- Your final message is the only thing the main agent sees. Make it a complete, self-contained report: what you found or did, with `path:line` references where they matter.',
			input.tools.length ? `- Your tools: ${input.tools.join(', ')}.` : '',
		].filter(Boolean).join('\n'),
		[
			input.cwd ? `Workspace: ${input.cwd}` : '',
			input.platform ? `Platform: ${input.platform}` : '',
			input.date ? `Date: ${input.date}` : '',
		].filter(Boolean).join('\n'),
	].filter(Boolean).join('\n\n');
}

export interface INativeModelTurn {
	/** Always empty. The native path does not prefetch. */
	readonly prefetch: readonly string[];
	/** Always false. The native path does not inject a run plan. */
	readonly runPlan: false;
	/** Always false. The native path does not classify the user text. */
	readonly classified: false;
	readonly toolNames: readonly string[];
	readonly prompt: string;
}

/**
 * What a native model turn is allowed to do with a user message.
 * The text is the next user message. It is not copied into the system prompt and it does not pick a lane.
 */
export function nativeModelTurn(input: IDeepseekPromptInput & {
	readonly text: string;
	readonly tools: readonly IDeepseekToolRef[];
}): INativeModelTurn {
	const selected = selectDeepseekTools(input.tools, input.mode);
	const toolNames = selected.map(tool => tool.name);
	return {
		prefetch: [],
		runPlan: false,
		classified: false,
		toolNames,
		prompt: buildDeepseekSystemPrompt({ ...input, toolNames }),
	};
}
