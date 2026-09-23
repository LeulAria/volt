/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CapabilityGroup } from '../harness/lanes.js';
import { modePolicy, VoltMode } from '../modes.js';

/** Safety ceiling. The model decides when to stop; this only prevents a runaway loop. */
export const DEEPSEEK_BUDGET = { maxToolCalls: 200, maxModelCalls: 80 } as const;

export interface IDeepseekToolRef {
	readonly name: string;
	readonly group: CapabilityGroup;
}

/**
 * Mode policy is the only filter. Question-shaped text still sees web, read, and (in agent mode) shell.
 * `request_capabilities` is omitted: the model is not asked to beg for tools.
 */
export function selectDeepseekTools<T extends IDeepseekToolRef>(tools: readonly T[], mode: VoltMode): T[] {
	const policy = modePolicy(mode);
	return tools.filter(tool => {
		if (tool.name === 'request_capabilities') {
			return false;
		}
		if (tool.group === 'meta') {
			return true;
		}
		if (!policy.allowWrites && (tool.group === 'edit' || tool.group === 'git')) {
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
	readonly date?: string;
	readonly projectInstructions?: string;
}

/**
 * Ordered prompt sections, in the same spirit as DeepSeek's assembly:
 * identity, then how to implement, then how to present, then the live workspace.
 * The user message is not rewritten and is not copied in here.
 */
export function buildDeepseekSystemPrompt(input: IDeepseekPromptInput): string {
	const policy = modePolicy(input.mode);
	const sections = [
		[
			'You are Volt, a coding agent in the editor the user already has open.',
			'The user message is the task. Do not replace it with a different project, a plan, or a server.',
		].join(' '),
		[
			'Turn a short or rough request into a finished result.',
			'Read the files that matter before you change them. Match the code around the change.',
			'Make the smallest complete change that does the job, then check it.',
			'When a fact is current or outside the workspace, look it up before you answer.',
			'Ask only when a missing fact would change the result.',
		].join(' '),
		[
			'Lead with the answer. Name the files you actually used.',
			'Show the result, not a tour of your tools.',
			'Do not add a plan the user did not ask to see.',
		].join(' '),
		[
			'Use a tool when it changes the answer. Do not repeat an identical call.',
			`Mode: ${input.mode}.`,
			policy.allowWrites ? 'You may edit files in the open workspace.' : 'Read-only: do not modify files.',
			policy.allowTerminal ? 'You may run commands.' : 'Do not run commands.',
		].join(' '),
	];
	const environment: string[] = [];
	if (input.cwd) {
		environment.push(`Workspace: ${input.cwd}`);
	}
	if (input.platform) {
		environment.push(`Platform: ${input.platform}`);
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
	return sections.join('\n\n');
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
	return {
		prefetch: [],
		runPlan: false,
		classified: false,
		toolNames: selected.map(tool => tool.name),
		prompt: buildDeepseekSystemPrompt(input),
	};
}
