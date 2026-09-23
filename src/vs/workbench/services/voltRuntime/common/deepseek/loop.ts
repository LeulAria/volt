/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { recordToolBatch, IDoomLoopState } from '../harness/doomLoop.js';
import { INativeLoopMessage } from '../harness/nativeLoop.js';
import { IToolCall, IToolResult, IVoltTool } from '../tools/tool.js';
import { ApprovalOutcome, StreamChunk } from './protocol.js';
import { DEEPSEEK_BUDGET } from './prompt.js';
import { presentCall, presentResult, toolEndFromView, toolStartFromView } from './presentation.js';

export interface IDeepseekHost {
	stream(messages: readonly INativeLoopMessage[], token: { isCancellationRequested: boolean }): AsyncIterable<StreamChunk>;
	execute(calls: readonly IToolCall[]): Promise<readonly IToolResult[]>;
	authorize(call: IToolCall): Promise<ApprovalOutcome>;
	emit(event: IVoltEvent): void;
	tool(name: string): IVoltTool | undefined;
	readonly cwd?: string;
}

export interface IDeepseekLoopInput {
	messages: INativeLoopMessage[];
	token: { isCancellationRequested: boolean };
	budget?: { readonly maxToolCalls: number; readonly maxModelCalls: number };
	isPaused?: () => boolean;
	claimInbox?: () => readonly string[];
}

export interface IDeepseekLoopResult {
	readonly outcome: 'done' | 'abort' | 'fail' | 'budget';
	readonly assistant: string;
	readonly messages: INativeLoopMessage[];
}

interface IOpenBlock {
	kind: 'text' | 'reasoning' | 'tool-call';
	id?: string;
	name?: string;
	args: string;
	started: boolean;
}

const LENGTH_HINT = 'Your previous response was cut off before the tool arguments were complete. Do not execute those tools. Continue from where you left off, or answer without tools.';
const TRUNCATED_TOOL = 'Tool call was truncated before the arguments were complete. It was not executed.';
const INTERRUPTED_TOOL = 'Tool call was interrupted before it was dispatched.';
const DOOM_ASK = 'You called the same tools with the same arguments three times. That is a doom loop. Try a different approach, or finish and say what is blocking you. Do not repeat those calls.';

/**
 * DeepSeek turn loop: stream, present, approve, execute, repeat.
 * No intent router, no prefetch, no invented plan. The model decides when the turn is over.
 * Live chunks are emitted as they arrive so the first token is not held for a durable message.
 */
export async function runDeepseekLoop(host: IDeepseekHost, input: IDeepseekLoopInput): Promise<IDeepseekLoopResult> {
	const messages = input.messages;
	const budget = input.budget ?? DEEPSEEK_BUDGET;
	let toolCalls = 0;
	let modelCalls = 0;
	let lastAssistant = '';
	let doom: IDoomLoopState = { repeats: 0 };
	let doomAsked = false;

	while (!input.token.isCancellationRequested) {
		while (input.isPaused?.() && !input.token.isCancellationRequested) {
			await sleep(50);
		}
		if (input.token.isCancellationRequested) {
			return { outcome: 'abort', assistant: lastAssistant, messages };
		}
		if (modelCalls >= budget.maxModelCalls || toolCalls >= budget.maxToolCalls) {
			return { outcome: 'budget', assistant: lastAssistant, messages };
		}
		const claimed = input.claimInbox?.() ?? [];
		for (const text of claimed) {
			messages.push({ role: 'user', content: text });
		}
		if (claimed.length) {
			host.emit({ type: 'inbox', claimed: claimed.length });
		}

		modelCalls++;
		host.emit({ type: 'step.start', step: modelCalls });
		const streamed = await readChunks(host, messages, input.token);
		host.emit({ type: 'step.end', step: modelCalls });
		if (streamed.kind === 'abort') {
			lastAssistant = streamed.assistant || lastAssistant;
			return { outcome: 'abort', assistant: lastAssistant, messages };
		}
		if (streamed.kind === 'error') {
			return { outcome: 'fail', assistant: lastAssistant, messages };
		}
		lastAssistant = streamed.assistant || lastAssistant;
		if (streamed.finish === 'error') {
			return { outcome: 'fail', assistant: lastAssistant, messages };
		}
		if (streamed.finish === 'length') {
			if (streamed.assistant) {
				messages.push({ role: 'assistant', content: streamed.assistant });
			}
			messages.push({ role: 'user', content: LENGTH_HINT });
			continue;
		}
		const calls = streamed.calls;
		if (!calls.length) {
			if (streamed.assistant) {
				messages.push({ role: 'assistant', content: streamed.assistant });
			}
			return { outcome: 'done', assistant: lastAssistant, messages };
		}

		const doomCheck = recordToolBatch(doom, calls);
		doom = doomCheck.state;
		if (doomCheck.looping) {
			host.emit({
				type: 'error',
				message: doomAsked
					? 'The same tools were called three times in a row with the same arguments. Stopping so this does not spin.'
					: 'The same tools were called three times in a row with the same arguments. Trying a different approach.',
				retryable: !doomAsked,
			});
			messages.push({ role: 'assistant', content: streamed.assistant, toolCalls: calls });
			for (const call of calls) {
				const denied = deniedResult(call, host.tool(call.name), 'Blocked: identical tool batch repeated three times (doom loop). Do not retry these exact calls.');
				host.emit(toolEndFromView(denied, { card: 'generic', title: call.name }));
				messages.push({ role: 'tool', content: denied.text, callId: call.id, name: call.name });
			}
			if (doomAsked) {
				return { outcome: 'fail', assistant: lastAssistant, messages };
			}
			doomAsked = true;
			doom = { repeats: 0 };
			messages.push({ role: 'user', content: DOOM_ASK });
			continue;
		}

		messages.push({ role: 'assistant', content: streamed.assistant, toolCalls: calls });
		const approved: { call: IToolCall; index: number }[] = [];
		const slots: (IToolResult | undefined)[] = new Array(calls.length);
		for (let index = 0; index < calls.length; index++) {
			const call = calls[index];
			const tool = host.tool(call.name);
			const view = tool ? presentCall(tool, call.args, host.cwd) : { card: 'generic' as const, title: call.name, rawInput: call.args };
			host.emit(toolStartFromView(call, tool, view));
			const outcome = tool ? await host.authorize(call) : 'rejected' as const;
			if (outcome !== 'allowed-once') {
				const denied = deniedResult(call, tool, outcome === 'cancelled' ? 'Cancelled.' : outcome === 'unavailable' ? 'Approval was unavailable.' : 'Blocked by Volt access policy.');
				slots[index] = denied;
				host.emit(toolEndFromView(denied, { card: 'generic', title: call.name }));
				continue;
			}
			approved.push({ call, index });
		}
		if (approved.length) {
			const executed = await host.execute(approved.map(entry => entry.call));
			toolCalls += executed.length;
			for (let i = 0; i < executed.length; i++) {
				const result = executed[i];
				const call = approved[i]?.call ?? { id: result.callId, name: result.name, args: {} };
				const tool = host.tool(result.name);
				const view = tool ? presentResult(tool, call.args, result) : { card: 'generic' as const, title: result.name };
				slots[approved[i]?.index ?? i] = result;
				host.emit(toolEndFromView(result, view));
			}
		}
		for (const result of slots) {
			if (!result) {
				continue;
			}
			messages.push({ role: 'tool', content: result.text, callId: result.callId, name: result.name });
			for (const extra of result.contexts ?? []) {
				if (extra.trim()) {
					messages.push({ role: 'user', content: extra });
				}
			}
		}
		const finished = slots.find(result => result?.name === 'finish' && !result.isError);
		if (finished) {
			if (!lastAssistant.trim()) {
				const summary = finishSummary(finished.text);
				lastAssistant = summary;
				host.emit({ type: 'text.delta', id: 'finish', delta: summary });
			}
			return { outcome: 'done', assistant: lastAssistant, messages };
		}
	}
	return { outcome: 'abort', assistant: lastAssistant, messages };
}

type ReadResult =
	| { kind: 'ok'; finish: 'stop' | 'tool_calls' | 'length' | 'error'; assistant: string; calls: IToolCall[] }
	| { kind: 'abort'; assistant: string }
	| { kind: 'error' };

async function readChunks(host: IDeepseekHost, messages: readonly INativeLoopMessage[], token: { isCancellationRequested: boolean }): Promise<ReadResult> {
	const blocks = new Map<number, IOpenBlock>();
	let assistant = '';
	let finish: 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted' = 'stop';
	try {
		for await (const chunk of host.stream(messages, token)) {
			if (token.isCancellationRequested) {
				closeOpenCalls(host, blocks, INTERRUPTED_TOOL);
				return { kind: 'abort', assistant };
			}
			for (const event of eventsFromChunk(chunk, blocks)) {
				if (event.type !== 'finish') {
					host.emit(event);
				}
				if (event.type === 'text.delta' && event.delta) {
					assistant += event.delta;
				}
			}
			if (chunk.type === 'finish') {
				finish = chunk.reason;
			}
			if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
				const block = blocks.get(chunk.index);
				if (block) {
					block.args = chunk.block.arguments || block.args;
					block.name = chunk.block.name || block.name;
					block.id = chunk.block.id || block.id;
				}
			}
		}
	} catch (error) {
		host.emit({ type: 'error', message: error instanceof Error ? error.message : String(error), retryable: true });
		closeOpenCalls(host, blocks, INTERRUPTED_TOOL);
		return { kind: 'error' };
	}
	if (finish === 'aborted' || token.isCancellationRequested) {
		closeOpenCalls(host, blocks, INTERRUPTED_TOOL);
		return { kind: 'abort', assistant };
	}
	const calls = callsFromBlocks(blocks);
	if (finish === 'length') {
		closeOpenCalls(host, blocks, TRUNCATED_TOOL);
		return { kind: 'ok', finish: 'length', assistant, calls: [] };
	}
	if (finish === 'error') {
		closeOpenCalls(host, blocks, 'The model stream failed before this tool could run.');
		return { kind: 'ok', finish: 'error', assistant, calls: [] };
	}
	return { kind: 'ok', finish: calls.length ? 'tool_calls' : 'stop', assistant, calls };
}

function eventsFromChunk(chunk: StreamChunk, blocks: Map<number, IOpenBlock>): IVoltEvent[] {
	switch (chunk.type) {
		case 'text-delta':
			return [{ type: 'text.delta', id: `b${chunk.index}`, delta: chunk.text }];
		case 'reasoning-delta':
			return [{ type: 'reasoning.delta', id: `b${chunk.index}`, delta: chunk.text }];
		case 'tool-call-delta': {
			const block = blocks.get(chunk.index) ?? { kind: 'tool-call' as const, args: '', started: false };
			blocks.set(chunk.index, block);
			const events: IVoltEvent[] = [];
			if (!block.started) {
				block.started = true;
				block.id = chunk.id;
				block.name = chunk.name ?? 'tool';
				events.push({ type: 'tool.start', callId: chunk.id, name: block.name, input: '' });
			}
			if (chunk.name) {
				block.name = chunk.name;
			}
			block.id = chunk.id || block.id;
			block.args += chunk.argumentsDelta;
			if (chunk.argumentsDelta) {
				events.push({ type: 'tool.input.delta', callId: block.id ?? chunk.id, delta: chunk.argumentsDelta });
			}
			return events;
		}
		case 'usage':
			return [{ type: 'usage', input: chunk.usage.input, output: chunk.usage.output, ...(chunk.usage.cache !== undefined ? { cache: chunk.usage.cache } : {}) }];
		case 'finish':
			return [{ type: 'finish', reason: chunk.reason === 'aborted' ? 'abort' : chunk.reason === 'tool_calls' ? 'tool_calls' : chunk.reason === 'length' ? 'length' : chunk.reason === 'error' ? 'error' : 'stop' }];
		default:
			return [];
	}
}

function closeOpenCalls(host: IDeepseekHost, blocks: ReadonlyMap<number, IOpenBlock>, text: string): void {
	for (const call of callsFromBlocks(blocks)) {
		host.emit(toolEndFromView(deniedResult(call, undefined, text), { card: 'generic', title: call.name }));
	}
}

function finishSummary(text: string): string {
	try {
		const parsed = JSON.parse(text) as { summary?: unknown };
		if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
			return parsed.summary;
		}
	} catch {
		// The tool already returned plain text.
	}
	return text;
}

function callsFromBlocks(blocks: ReadonlyMap<number, IOpenBlock>): IToolCall[] {
	const calls: IToolCall[] = [];
	for (const block of blocks.values()) {
		if (block.kind !== 'tool-call' || !block.id) {
			continue;
		}
		calls.push({ id: block.id, name: block.name || 'tool', args: parseArgs(block.args) });
	}
	return calls;
}

function deniedResult(call: IToolCall, tool: IVoltTool | undefined, text: string): IToolResult {
	return { callId: call.id, name: call.name, kind: tool?.kind ?? 'other', text, isError: true };
}

function parseArgs(input: string | undefined): unknown {
	if (!input) {
		return {};
	}
	try {
		return JSON.parse(input);
	} catch {
		return { raw: input };
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
