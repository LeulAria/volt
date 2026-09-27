/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { recordToolBatch, IDoomLoopState } from '../harness/doomLoop.js';
import { INativeLoopMessage } from '../harness/nativeLoop.js';
import { describeArgIssues, isUnparsedArgs, normalizeArgs, validateArgs } from '../harness/toolPolicy.js';
import { ProviderError, providerRetryDelay } from '../providerError.js';
import type { IModelAssistantPart } from '../providers.js';
import { IToolCall, IToolResult, IVoltTool } from '../tools/tool.js';
import { ApprovalOutcome, StreamChunk } from './protocol.js';
import { DEEPSEEK_BUDGET } from './prompt.js';
import { presentCall, presentResult, toolEndFromView, toolStartFromView } from './presentation.js';

export interface IDeepseekStreamOptions {
	/** Raised after a turn was cut off at the output limit. */
	readonly maxOutputTokens?: number;
}

export interface IDeepseekHost {
	stream(messages: readonly INativeLoopMessage[], token: { isCancellationRequested: boolean }, options?: IDeepseekStreamOptions): AsyncIterable<StreamChunk>;
	/** Runs a batch; `onResult` fires as each call finishes so its card completes immediately. */
	execute(calls: readonly IToolCall[], onResult?: (result: IToolResult) => void): Promise<readonly IToolResult[]>;
	authorize(call: IToolCall): Promise<ApprovalOutcome>;
	/** The decision when policy settles it without a person; `undefined` when someone must be asked. */
	preauthorize?(call: IToolCall): ApprovalOutcome | undefined;
	emit(event: IVoltEvent): void;
	tool(name: string): IVoltTool | undefined;
	readonly cwd?: string;
	/** Model window, reported with usage so the context meter is exact. */
	readonly contextWindow?: number;
	/** Largest output the model accepts; used after a cut-off turn. */
	readonly maxOutputTokens?: number;
	/** Before each model call. Compaction happens here, in place, at a single boundary. */
	prepareTurn?(messages: INativeLoopMessage[], step: number): Promise<void>;
	/** The provider said the prompt no longer fits. Returns true when the transcript shrank. */
	recoverOverflow?(messages: INativeLoopMessage[]): Promise<boolean>;
	/**
	 * The model wants to stop. Returns a message that sends it back to work (new errors in files
	 * it changed, an unverified change), or `undefined` to accept the answer.
	 */
	reviewCompletion?(input: { readonly attempt: number; readonly assistant: string }): Promise<string | undefined>;
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
	ready?: boolean;
}

const MAX_STREAM_RETRIES = 3;
const MAX_LENGTH_RECOVERIES = 2;
const MAX_COMPLETION_REVIEWS = 2;
const FALLBACK_MAX_OUTPUT = 128_000;
const TRUNCATED_TOOL = 'Tool call was truncated at the output limit before its arguments were complete. It was not executed.';
const INTERRUPTED_TOOL = 'Tool call was interrupted before it was dispatched.';
const DOOM_ASK = 'You called the same tools with the same arguments three times. That is a doom loop. Try a different approach, or finish and say what is blocking you. Do not repeat those calls.';

/**
 * DeepSeek turn loop: stream, present, approve, execute, repeat.
 *
 * Fast paths: live chunks are emitted as they arrive; a read-only call whose arguments are
 * complete starts while the model is still writing; approvals are decided together; each card
 * completes when its own call does. Reliability: a failed stream is retried before anything was
 * shown, an overflowing prompt is compacted once, and a cut-off turn continues with a larger
 * output limit. The model decides when the turn is over; the host may send it back once or twice.
 */
export async function runDeepseekLoop(host: IDeepseekHost, input: IDeepseekLoopInput): Promise<IDeepseekLoopResult> {
	const messages = input.messages;
	const budget = input.budget ?? DEEPSEEK_BUDGET;
	let toolCalls = 0;
	let modelCalls = 0;
	let lastAssistant = '';
	let doom: IDoomLoopState = { repeats: 0 };
	let doomAsked = false;
	let lengthStreak = 0;
	let maxOutputTokens: number | undefined;
	let streamRetries = 0;
	let overflowRecovered = false;
	let reviews = 0;

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
		await host.prepareTurn?.(messages, modelCalls + 1);

		modelCalls++;
		host.emit({ type: 'step.start', step: modelCalls });
		const eager = new EagerDispatch(host, input.token);
		const streamed = await readChunks(host, messages, input.token, { maxOutputTokens }, call => eager.offer(call), eager);
		host.emit({ type: 'step.end', step: modelCalls });

		if (streamed.kind === 'abort') {
			await eager.settle();
			lastAssistant = streamed.assistant || lastAssistant;
			return { outcome: 'abort', assistant: lastAssistant, messages };
		}
		if (streamed.kind === 'error') {
			await eager.settle();
			const error = streamed.error;
			if (error instanceof ProviderError && error.overflow && !overflowRecovered && host.recoverOverflow && await host.recoverOverflow(messages)) {
				overflowRecovered = true;
				modelCalls--;
				continue;
			}
			const retryable = error instanceof ProviderError ? error.retryable : true;
			if (retryable && !streamed.visible && streamRetries < MAX_STREAM_RETRIES && !input.token.isCancellationRequested) {
				streamRetries++;
				const delayMs = providerRetryDelay(streamRetries, error instanceof ProviderError ? error.retryAfterMs : undefined);
				host.emit({ type: 'retry', attempt: streamRetries + 1, delayMs, message: `${errorText(error)} Retrying.` });
				await sleep(delayMs);
				modelCalls--;
				continue;
			}
			host.emit({ type: 'error', message: errorText(error), retryable });
			return { outcome: 'fail', assistant: lastAssistant, messages };
		}
		streamRetries = 0;
		lastAssistant = streamed.assistant || lastAssistant;
		if (streamed.finish === 'error') {
			await eager.settle();
			return { outcome: 'fail', assistant: lastAssistant, messages };
		}
		if (streamed.finish === 'length') {
			await eager.settle();
			lengthStreak++;
			if (lengthStreak > MAX_LENGTH_RECOVERIES) {
				host.emit({ type: 'error', message: 'The model kept hitting its output limit. Ask for a smaller step.', retryable: true });
				return { outcome: 'fail', assistant: lastAssistant, messages };
			}
			maxOutputTokens = host.maxOutputTokens ?? FALLBACK_MAX_OUTPUT;
			const parts = streamed.parts.filter(part => part.type !== 'tool_call');
			if (streamed.assistant || parts.length) {
				messages.push({ role: 'assistant', content: streamed.assistant, ...(parts.length ? { parts } : {}) });
			}
			messages.push({ role: 'user', content: lengthHint(streamed.truncatedTool) });
			continue;
		}
		lengthStreak = 0;
		const calls = streamed.calls;
		if (!calls.length) {
			if (streamed.assistant || streamed.parts.length) {
				messages.push({ role: 'assistant', content: streamed.assistant, ...(streamed.parts.length ? { parts: streamed.parts } : {}) });
			}
			const nudge = await review(host, reviews, lastAssistant);
			if (nudge) {
				reviews++;
				messages.push({ role: 'user', content: nudge });
				continue;
			}
			return { outcome: 'done', assistant: lastAssistant, messages };
		}

		const doomCheck = recordToolBatch(doom, calls);
		doom = doomCheck.state;
		if (doomCheck.looping) {
			await eager.settle();
			host.emit({
				type: 'error',
				message: doomAsked
					? 'The same tools were called three times in a row with the same arguments. Stopping so this does not spin.'
					: 'The same tools were called three times in a row with the same arguments. Trying a different approach.',
				retryable: !doomAsked,
			});
			messages.push({ role: 'assistant', content: streamed.assistant, toolCalls: calls, ...(streamed.parts.length ? { parts: streamed.parts } : {}) });
			for (const call of calls) {
				const denied = errorResult(call, host.tool(call.name), 'Blocked: identical tool batch repeated three times (doom loop). Do not retry these exact calls.');
				if (!eager.has(call.id)) {
					host.emit(toolEndFromView(denied, { card: 'generic', title: call.name }));
				}
				messages.push({ role: 'tool', content: denied.text, callId: call.id, name: call.name, isError: true });
			}
			if (doomAsked) {
				return { outcome: 'fail', assistant: lastAssistant, messages };
			}
			doomAsked = true;
			doom = { repeats: 0 };
			messages.push({ role: 'user', content: DOOM_ASK });
			continue;
		}

		messages.push({ role: 'assistant', content: streamed.assistant, toolCalls: calls, ...(streamed.parts.length ? { parts: streamed.parts } : {}) });
		const outcome = await runCalls(host, calls, eager);
		toolCalls += outcome.executed;
		const contexts: string[] = [];
		for (const result of outcome.results) {
			messages.push({
				role: 'tool',
				content: result.text,
				callId: result.callId,
				name: result.name,
				...(result.isError ? { isError: true } : {}),
				...(result.image ? { images: [imagePart(result.image)] } : {}),
			});
			contexts.push(...(result.contexts ?? []).filter(extra => extra.trim()));
		}
		// Results first, then any injected context: providers want every result for a turn together.
		for (const extra of contexts) {
			messages.push({ role: 'user', content: extra });
		}
		const finished = outcome.results.find(result => result?.name === 'finish' && !result.isError);
		if (finished) {
			const nudge = await review(host, reviews, lastAssistant);
			if (nudge) {
				reviews++;
				messages.push({ role: 'user', content: nudge });
				continue;
			}
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

async function review(host: IDeepseekHost, reviews: number, assistant: string): Promise<string | undefined> {
	if (!host.reviewCompletion || reviews >= MAX_COMPLETION_REVIEWS) {
		return undefined;
	}
	try {
		return await host.reviewCompletion({ attempt: reviews + 1, assistant });
	} catch {
		return undefined;
	}
}

// --- calls ---------------------------------------------------------------------------------

interface IPreparedCall {
	readonly call: IToolCall;
	readonly tool: IVoltTool;
	readonly error?: string;
}

/** Aliases mapped and scalars coerced before validation, so the model is never rejected for a key the tool accepts. */
function prepareCall(tool: IVoltTool, call: IToolCall): IPreparedCall {
	const args = normalizeArgs(tool.schema, call.args);
	const prepared: IToolCall = { ...call, args };
	if (isUnparsedArgs(args)) {
		return { call: prepared, tool, error: describeArgIssues(tool, args, []) };
	}
	const check = validateArgs(tool.schema, args);
	return check.ok ? { call: prepared, tool } : { call: prepared, tool, error: describeArgIssues(tool, args, check.issues) };
}

/**
 * Read-only calls start the moment their arguments are complete, while the model keeps writing.
 * Order is preserved: once a mutating call has streamed, nothing after it starts early.
 */
class EagerDispatch {

	private readonly started = new Map<string, { readonly call: IToolCall; readonly promise: Promise<IToolResult> }>();
	private blocked = false;

	constructor(private readonly host: IDeepseekHost, private readonly token: { isCancellationRequested: boolean }) { }

	offer(raw: IToolCall): void {
		if (this.blocked || this.token.isCancellationRequested || !this.host.preauthorize) {
			return;
		}
		const tool = this.host.tool(raw.name);
		if (!tool) {
			return;
		}
		if (!tool.parallelSafe) {
			this.blocked = true;
			return;
		}
		const prepared = prepareCall(tool, raw);
		if (prepared.error || this.host.preauthorize(prepared.call) !== 'allowed-once') {
			return;
		}
		this.host.emit(toolStartFromView(prepared.call, tool, presentCall(tool, prepared.call.args, this.host.cwd)));
		const promise = this.host.execute([prepared.call], result => emitEnd(this.host, prepared.call, result))
			.then(results => results[0] ?? errorResult(prepared.call, tool, 'The tool returned no result.'))
			.catch(err => errorResult(prepared.call, tool, err instanceof Error ? err.message : String(err)));
		this.started.set(raw.id, { call: prepared.call, promise });
	}

	has(callId: string): boolean {
		return this.started.has(callId);
	}

	result(callId: string): Promise<IToolResult> | undefined {
		return this.started.get(callId)?.promise;
	}

	get count(): number {
		return this.started.size;
	}

	async settle(): Promise<void> {
		await Promise.all([...this.started.values()].map(entry => entry.promise));
	}
}

async function runCalls(host: IDeepseekHost, calls: readonly IToolCall[], eager: EagerDispatch): Promise<{ results: IToolResult[]; executed: number }> {
	const slots: (IToolResult | undefined)[] = new Array(calls.length);
	const pending: { prepared: IPreparedCall; index: number }[] = [];
	for (let index = 0; index < calls.length; index++) {
		const call = calls[index];
		if (eager.has(call.id)) {
			continue;
		}
		const tool = host.tool(call.name);
		if (!tool) {
			const unknown = errorResult(call, undefined, `Unknown tool: ${call.name}.`);
			host.emit(toolStartFromView(call, undefined, { card: 'generic', title: call.name, rawInput: call.args }));
			host.emit(toolEndFromView(unknown, { card: 'generic', title: call.name }));
			slots[index] = unknown;
			continue;
		}
		const prepared = prepareCall(tool, call);
		host.emit(toolStartFromView(prepared.call, tool, presentCall(tool, prepared.call.args, host.cwd)));
		if (prepared.error) {
			const invalid = errorResult(prepared.call, tool, prepared.error);
			host.emit(toolEndFromView(invalid, { card: 'generic', title: call.name }));
			slots[index] = invalid;
			continue;
		}
		pending.push({ prepared, index });
	}

	const decisions = await Promise.all(pending.map(async entry => entry.prepared.tool.group === 'meta'
		? 'allowed-once' as const
		: host.preauthorize?.(entry.prepared.call) ?? await host.authorize(entry.prepared.call)));
	const approved: { prepared: IPreparedCall; index: number }[] = [];
	pending.forEach((entry, i) => {
		const decision = decisions[i];
		if (decision === 'allowed-once') {
			approved.push(entry);
			return;
		}
		const denied = errorResult(entry.prepared.call, entry.prepared.tool, decision === 'cancelled' ? 'Cancelled.' : decision === 'unavailable' ? 'Approval was unavailable.' : 'Blocked by Volt access policy.');
		host.emit(toolEndFromView(denied, { card: 'generic', title: entry.prepared.call.name }));
		slots[entry.index] = denied;
	});

	if (approved.length) {
		// Early reads were earlier in the batch; a write after them must see them finish first.
		if (approved.some(entry => !entry.prepared.tool.parallelSafe)) {
			await eager.settle();
		}
		const byId = new Map(approved.map(entry => [entry.prepared.call.id, entry]));
		const ended = new Set<string>();
		const executed = await host.execute(approved.map(entry => entry.prepared.call), result => {
			const entry = byId.get(result.callId);
			if (entry && !ended.has(result.callId)) {
				ended.add(result.callId);
				emitEnd(host, entry.prepared.call, result);
			}
		});
		executed.forEach((result, i) => {
			const entry = approved[i];
			if (!entry) {
				return;
			}
			if (!ended.has(entry.prepared.call.id)) {
				ended.add(entry.prepared.call.id);
				emitEnd(host, entry.prepared.call, result);
			}
			slots[entry.index] = result;
		});
	}

	for (let index = 0; index < calls.length; index++) {
		const early = eager.result(calls[index].id);
		if (early) {
			slots[index] = await early;
		}
	}
	const results = slots.map((result, index) => result ?? errorResult(calls[index], host.tool(calls[index].name), INTERRUPTED_TOOL));
	return { results, executed: approved.length + eager.count };
}

function emitEnd(host: IDeepseekHost, call: IToolCall, result: IToolResult): void {
	const tool = host.tool(result.name);
	const view = tool ? presentResult(tool, call.args, result) : { card: 'generic' as const, title: result.name };
	host.emit(toolEndFromView(result, view));
}

// --- stream --------------------------------------------------------------------------------

type ReadResult =
	| { kind: 'ok'; finish: 'stop' | 'tool_calls' | 'length' | 'error'; assistant: string; calls: IToolCall[]; parts: IModelAssistantPart[]; truncatedTool?: string }
	| { kind: 'abort'; assistant: string }
	| { kind: 'error'; error: unknown; visible: boolean };

async function readChunks(
	host: IDeepseekHost,
	messages: readonly INativeLoopMessage[],
	token: { isCancellationRequested: boolean },
	options: IDeepseekStreamOptions,
	onToolReady: (call: IToolCall) => void,
	eager: EagerDispatch,
): Promise<ReadResult> {
	const blocks = new Map<number, IOpenBlock>();
	const parts = new Map<number, IModelAssistantPart>();
	let assistant = '';
	let visible = false;
	let finish: 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted' = 'stop';
	try {
		for await (const chunk of host.stream(messages, token, options)) {
			if (token.isCancellationRequested) {
				closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
				return { kind: 'abort', assistant };
			}
			if (chunk.type === 'event') {
				host.emit(chunk.event);
				continue;
			}
			if (chunk.type === 'usage') {
				const used = chunk.usage.used ?? chunk.usage.input + (chunk.usage.cache ?? 0) + (chunk.usage.cacheWrite ?? 0);
				host.emit({
					type: 'usage',
					input: chunk.usage.input,
					output: chunk.usage.output,
					used,
					...(chunk.usage.cache !== undefined ? { cache: chunk.usage.cache } : {}),
					...(chunk.usage.cacheWrite !== undefined ? { cacheWrite: chunk.usage.cacheWrite } : {}),
					...(host.contextWindow ? { size: host.contextWindow } : {}),
				});
				continue;
			}
			for (const event of eventsFromChunk(chunk, blocks)) {
				if (event.type !== 'finish') {
					host.emit(event);
				}
				if (event.type === 'text.delta' && event.delta) {
					assistant += event.delta;
					visible = true;
				}
				if (event.type === 'tool.start' || event.type === 'tool.input.delta') {
					visible = true;
				}
			}
			if (chunk.type === 'finish') {
				finish = chunk.reason;
			}
			if (chunk.type === 'block-end') {
				const block = chunk.block;
				if (block.type === 'text' && block.text) {
					parts.set(chunk.index, { type: 'text', text: block.text });
				} else if (block.type === 'reasoning' && block.provider && block.model) {
					parts.set(chunk.index, { type: 'reasoning', block: { provider: block.provider, model: block.model, text: block.text, ...(block.opaque !== undefined ? { opaque: block.opaque } : {}) } });
				} else if (block.type === 'tool-call') {
					const open = blocks.get(chunk.index);
					if (open) {
						open.args = block.arguments || open.args;
						open.name = block.name || open.name;
						open.id = block.id || open.id;
						open.ready = true;
						if (open.id) {
							parts.set(chunk.index, { type: 'tool_call', callId: open.id });
							const args = parseArgs(open.args);
							if (!isUnparsedArgs(args)) {
								onToolReady({ id: open.id, name: open.name || 'tool', args });
							}
						}
					}
				}
			}
		}
	} catch (error) {
		closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
		return { kind: 'error', error, visible };
	}
	if (finish === 'aborted' || token.isCancellationRequested) {
		closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
		return { kind: 'abort', assistant };
	}
	const orderedParts = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
	const calls = callsFromBlocks(blocks);
	if (finish === 'length') {
		const truncated = [...blocks.values()].find(block => block.kind === 'tool-call' && block.id && !eager.has(block.id));
		closeOpenCalls(host, blocks, TRUNCATED_TOOL, eager);
		return { kind: 'ok', finish: 'length', assistant, calls: [], parts: orderedParts, truncatedTool: truncated?.name };
	}
	if (finish === 'error') {
		closeOpenCalls(host, blocks, 'The model stream failed before this tool could run.', eager);
		return { kind: 'ok', finish: 'error', assistant, calls: [], parts: orderedParts };
	}
	return { kind: 'ok', finish: calls.length ? 'tool_calls' : 'stop', assistant, calls, parts: orderedParts };
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
				events.push({ type: 'tool.input.delta', callId: block.id ?? chunk.id, delta: chunk.argumentsDelta, append: true });
			}
			return events;
		}
		case 'finish':
			return [{ type: 'finish', reason: chunk.reason === 'aborted' ? 'abort' : chunk.reason === 'tool_calls' ? 'tool_calls' : chunk.reason === 'length' ? 'length' : chunk.reason === 'error' ? 'error' : 'stop' }];
		default:
			return [];
	}
}

function closeOpenCalls(host: IDeepseekHost, blocks: ReadonlyMap<number, IOpenBlock>, text: string, eager: EagerDispatch): void {
	for (const call of callsFromBlocks(blocks)) {
		if (!eager.has(call.id)) {
			host.emit(toolEndFromView(errorResult(call, undefined, text), { card: 'generic', title: call.name }));
		}
	}
}

function lengthHint(truncatedTool: string | undefined): string {
	return truncatedTool
		? `Your last response reached the output limit while writing the arguments for ${truncatedTool}, so that call did not run. Continue. Split large content into several smaller edit_file calls (a few hundred lines each) instead of one large write.`
		: 'Your last response reached the output limit. Continue exactly where you left off, without repeating what you already wrote.';
}

/** The `finish` payload as the reply: summary, then what was verified and what is left. */
function finishSummary(text: string): string {
	try {
		const parsed = JSON.parse(text) as { summary?: unknown; changed?: unknown; verified?: unknown; remaining?: unknown };
		const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
		const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
		const sections = [summary];
		const changed = list(parsed.changed);
		const verified = list(parsed.verified);
		const remaining = list(parsed.remaining);
		if (changed.length) {
			sections.push(`**Changed**\n${changed.map(item => `- \`${item.replace(/`/g, '')}\``).join('\n')}`);
		}
		if (verified.length) {
			sections.push(`**Verified**\n${verified.map(item => `- ${item}`).join('\n')}`);
		}
		if (remaining.length) {
			sections.push(`**Not done yet**\n${remaining.map(item => `- ${item}`).join('\n')}`);
		}
		const out = sections.filter(Boolean).join('\n\n');
		if (out) {
			return out;
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

function errorResult(call: IToolCall, tool: IVoltTool | undefined, text: string): IToolResult {
	return { callId: call.id, name: call.name, kind: tool?.kind ?? 'other', text, isError: true };
}

function imagePart(image: string): { mediaType: string; data: string } {
	const match = /^data:([^;]+);base64,(.*)$/s.exec(image);
	return match ? { mediaType: match[1], data: match[2] } : { mediaType: 'image/png', data: image };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
