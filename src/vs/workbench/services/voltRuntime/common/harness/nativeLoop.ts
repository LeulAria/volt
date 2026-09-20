/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { ILaneBudget } from './lanes.js';
import { IDoomLoopState, recordToolBatch } from './doomLoop.js';
import { classifyProviderError, DEFAULT_RETRY_POLICY, IRetryPolicy, parseRetryAfter, retryDelayMs } from './sessionRetry.js';
import { IToolCall, IToolResult } from '../tools/tool.js';

export type NativeFinishReason = 'stop' | 'tool_calls' | 'length' | 'error' | 'abort';
export type NativeLoopOutcome = 'done' | 'abort' | 'fail' | 'budget';

export interface INativeLoopMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: IToolCall[];
	callId?: string;
	name?: string;
}

export interface INativeLoopHost {
	stream(messages: readonly INativeLoopMessage[], token: { isCancellationRequested: boolean }): AsyncIterable<IVoltEvent | { type: 'finish'; reason: NativeFinishReason }>;
	execute(calls: readonly IToolCall[]): Promise<readonly IToolResult[]>;
	emit(event: IVoltEvent): void;
}

/** What a step did, handed to the controller after the tools have run. */
export interface ILoopStep {
	readonly step: number;
	readonly calls: readonly IToolCall[];
	readonly results: readonly IToolResult[];
	readonly assistantText: string;
	/**
	 * The model produced no tool calls, or called `finish`. It is claiming the work is done, and
	 * the controller gets to test that claim before the loop honours it.
	 */
	readonly wantsToFinish: boolean;
	readonly tokens?: { readonly input: number; readonly output: number };
	/** The same tool batch repeated past the doom threshold. */
	readonly doomLoop?: boolean;
}

export type ILoopDirective =
	/** Nothing to do; carry on. */
	| { readonly kind: 'continue' }
	/** Prepend a user-role message to the next turn, optionally after a backoff. */
	| { readonly kind: 'inject'; readonly message: string; readonly cooldownMs?: number }
	/** End the run. */
	| { readonly kind: 'stop'; readonly reason?: string };

/**
 * The harness's hook into the loop. Optional: without one the loop behaves exactly as it did
 * before - stream, run tools, stop when the model stops.
 */
export interface ILoopController {
	afterStep(step: ILoopStep): ILoopDirective | Promise<ILoopDirective>;
}

export interface INativeLoopInput {
	readonly messages: INativeLoopMessage[];
	readonly budget: ILaneBudget;
	readonly token: { isCancellationRequested: boolean };
	readonly controller?: ILoopController;
	/** Injected so the backoff in a `retry` directive is testable. */
	readonly delay?: (ms: number) => Promise<void>;
	/**
	 * Called just before each model turn. Compaction, prompt-cache keys, and context reset
	 * all happen here so the loop itself never knows why the transcript shrank.
	 */
	readonly prepareTurn?: (messages: INativeLoopMessage[]) => INativeLoopMessage[] | Promise<INativeLoopMessage[]>;
	/** When true between steps, the loop waits instead of starting the next model turn. */
	readonly isPaused?: () => boolean;
	/** When any meter is exhausted the loop ends with `budget` rather than starting another turn. */
	readonly canContinue?: () => boolean;
	/** Mid-run steering. Claimed before each model turn (DeepSeek inbox). */
	readonly claimInbox?: () => readonly string[];
	/** Dual-target claim. When set, wins over `claimInbox`. */
	readonly claimInboxBatch?: () => { readonly texts: readonly string[]; readonly opensTurn: boolean };
	/** DeepSeek pre-step: rewrite or reject before a provider call. */
	readonly prepareStep?: (input: { messages: INativeLoopMessage[]; claimed: readonly string[]; step: number }) => { kind: 'enter'; messages: INativeLoopMessage[] } | { kind: 'reject'; reason: string } | Promise<{ kind: 'enter'; messages: INativeLoopMessage[] } | { kind: 'reject'; reason: string }>;
	/**
	 * DeepSeek additionalContexts. When set, extra tool context is queued for the next step
	 * instead of being spliced into the current transcript.
	 */
	readonly enqueueInbox?: (text: string) => void;
	/** OpenCode SessionRetry. Thrown stream errors may retry unless they are context overflow. */
	readonly retry?: IRetryPolicy;
	/** DeepSeek reconstruction check. Failures are emitted, never thrown. */
	readonly assertSurface?: (messages: readonly INativeLoopMessage[]) => void;
}

export interface INativeLoopResult {
	readonly outcome: NativeLoopOutcome;
	readonly messages: INativeLoopMessage[];
	readonly assistant: string;
}

const LENGTH_HINT = 'Your previous response was cut off before the tool arguments were complete. Do not execute those tools. Continue from where you left off, or answer without tools.';
const DOOM_ASK = 'You called the same tools with the same arguments three times. That is a doom loop. Try a different approach, or finish and say what is blocking you. Do not repeat those calls.';

/**
 * Stream → tools → stop. Parallel-safe execution is the host's job. This function owns budgets,
 * doom-loop detection, `length` batch-fail, and the continue/stop decision.
 */
export async function runNativeLoop(host: INativeLoopHost, input: INativeLoopInput): Promise<INativeLoopResult> {
	const messages = input.messages.slice();
	let toolCalls = 0;
	let modelCalls = 0;
	let turn = 1;
	let doom: IDoomLoopState = { repeats: 0 };
	let doomAsked = false;
	let lastAssistant = '';
	let lastTokens: { input: number; output: number } | undefined;

	const done = (outcome: NativeLoopOutcome): INativeLoopResult => {
		host.emit({ type: 'turn.end', turn });
		return { outcome, messages, assistant: lastAssistant };
	};

	host.emit({ type: 'turn.start', turn });

	while (!input.token.isCancellationRequested) {
		while (input.isPaused?.() && !input.token.isCancellationRequested) {
			await (input.delay ?? sleep)(50);
		}
		if (input.token.isCancellationRequested) {
			return done('abort');
		}
		if (modelCalls >= input.budget.maxModelCalls || toolCalls >= input.budget.maxToolCalls || input.canContinue?.() === false) {
			return done('budget');
		}
		const batch = input.claimInboxBatch?.() ?? { texts: input.claimInbox?.() ?? [], opensTurn: modelCalls > 0 };
		if (batch.texts.length) {
			if (modelCalls > 0 && batch.opensTurn) {
				host.emit({ type: 'turn.end', turn });
				turn++;
				host.emit({ type: 'turn.start', turn });
			}
			for (const text of batch.texts) {
				messages.push({ role: 'user', content: text });
			}
			host.emit({ type: 'inbox', claimed: batch.texts.length });
		}
		if (input.prepareStep) {
			try {
				const decision = await input.prepareStep({ messages, claimed: batch.texts, step: modelCalls });
				if (decision.kind === 'reject') {
					host.emit({ type: 'decision', title: 'pre-step', detail: decision.reason });
					return done(modelCalls === 0 ? 'done' : 'fail');
				}
				if (decision.messages !== messages) {
					messages.length = 0;
					messages.push(...decision.messages);
				}
			} catch (error) {
				host.emit({ type: 'error', message: `prepareStep failed: ${error instanceof Error ? error.message : String(error)}`, retryable: true });
			}
		}
		modelCalls++;
		if (input.prepareTurn) {
			try {
				const next = await input.prepareTurn(messages);
				if (next !== messages) {
					messages.length = 0;
					messages.push(...next);
				}
			} catch (error) {
				host.emit({ type: 'error', message: `prepareTurn failed: ${error instanceof Error ? error.message : String(error)}`, retryable: true });
			}
		}
		// Pi: steering that arrived during a long prepareTurn (compaction) is claimed here.
		const late = input.claimInboxBatch?.() ?? { texts: [], opensTurn: false };
		if (late.texts.length) {
			for (const text of late.texts) {
				messages.push({ role: 'user', content: text });
			}
			host.emit({ type: 'inbox', claimed: late.texts.length });
		}
		if (input.assertSurface) {
			try {
				input.assertSurface(messages);
			} catch (error) {
				host.emit({ type: 'error', message: `surface invariant: ${error instanceof Error ? error.message : String(error)}`, retryable: false });
			}
		}
		host.emit({ type: 'step.start', step: modelCalls });

		const streamed = await streamTurn(host, messages, input);
		if (streamed.kind === 'abort') {
			settleAbort(host, messages, streamed.assistant, streamed.calls);
			lastAssistant = streamed.assistant || lastAssistant;
			return done('abort');
		}

		const { finish, assistant, collected, tokens, sawTextEnd } = streamed;
		lastTokens = tokens;
		host.emit({ type: 'step.end', step: modelCalls });
		lastAssistant = assistant || lastAssistant;
		if (assistant && !sawTextEnd) {
			host.emit({ type: 'text.end', id: 'assistant', delta: assistant });
		}

		if (finish === 'error') {
			return done('fail');
		}
		if (finish === 'length') {
			failLengthBatch(host, messages, assistant, collected);
			continue;
		}

		const calls = collected.length && (finish === 'tool_calls' || finish === 'stop') ? collected : [];
		if (!calls.length) {
			if (assistant) {
				messages.push({ role: 'assistant', content: assistant });
			}
			// The model stopped. The controller may send it back - that is the completion gate,
			// and it is the only place the loop overrides the model's own decision to finish.
			const directive = await consult(host, input, { step: modelCalls, calls, results: [], assistantText: assistant, wantsToFinish: true, ...(tokens ? { tokens } : {}) });
			if (directive.kind === 'inject') {
				messages.push({ role: 'user', content: directive.message });
				continue;
			}
			return done('done');
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
			messages.push({ role: 'assistant', content: assistant, toolCalls: calls });
			const blocked = syntheticResults(calls, 'Blocked: identical tool batch repeated three times (doom loop). Do not retry these exact calls.', 'other');
			appendToolResults(host, messages, blocked);
			if (doomAsked) {
				return done('fail');
			}
			doomAsked = true;
			doom = { repeats: 0 };
			const directive = await consult(host, input, {
				step: modelCalls,
				calls,
				results: blocked,
				assistantText: assistant,
				wantsToFinish: false,
				doomLoop: true,
				...(tokens ? { tokens } : {}),
			});
			if (directive.kind === 'stop') {
				return done('fail');
			}
			messages.push({ role: 'user', content: directive.kind === 'inject' ? directive.message : DOOM_ASK });
			continue;
		}

		messages.push({ role: 'assistant', content: assistant, toolCalls: calls });
		const results = await host.execute(calls);
		toolCalls += results.length;
		appendToolResults(host, messages, results);
		appendAdditionalContexts(host, messages, results, input.enqueueInbox);

		const finished = results.find(result => result.name === 'finish' && !result.isError);
		const directive = await consult(host, input, {
			step: modelCalls,
			calls,
			results,
			assistantText: assistant,
			wantsToFinish: !!finished,
			...(lastTokens ? { tokens: lastTokens } : {}),
		});

		if (finished) {
			lastAssistant = assistant || finished.text;
			// `finish` is a claim like any other, so it goes through the same gate.
			if (directive.kind !== 'inject') {
				return done('done');
			}
		}
		if (directive.kind === 'stop') {
			return done('done');
		}
		if (directive.kind === 'inject') {
			if (directive.cooldownMs) {
				await (input.delay ?? sleep)(directive.cooldownMs);
			}
			messages.push({ role: 'user', content: directive.message });
		}
	}

	return done('abort');
}

const CONTINUE: ILoopDirective = { kind: 'continue' };

/**
 * Asks the controller what to do. A controller that throws must not take the run down with it:
 * the harness is an optimisation on top of the loop, never a dependency of it.
 */
async function consult(host: INativeLoopHost, input: INativeLoopInput, step: ILoopStep): Promise<ILoopDirective> {
	if (!input.controller) {
		return CONTINUE;
	}
	try {
		return await input.controller.afterStep(step);
	} catch (error) {
		host.emit({ type: 'error', message: `Harness controller failed: ${error instanceof Error ? error.message : String(error)}`, retryable: true });
		return CONTINUE;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

type StreamedTurn =
	| { kind: 'ok'; finish: NativeFinishReason; assistant: string; collected: IToolCall[]; tokens?: { input: number; output: number }; sawTextEnd: boolean }
	| { kind: 'abort'; assistant: string; calls: IToolCall[] };

async function streamTurn(host: INativeLoopHost, messages: readonly INativeLoopMessage[], input: INativeLoopInput): Promise<StreamedTurn> {
	const policy = input.retry ?? DEFAULT_RETRY_POLICY;
	const classify = policy.classify ?? classifyProviderError;
	const maxAttempts = Math.max(1, policy.maxAttempts);
	let attempt = 0;

	while (true) {
		attempt++;
		try {
			return await readStream(host, messages, input.token);
		} catch (error) {
			if (input.token.isCancellationRequested) {
				return { kind: 'abort', assistant: '', calls: [] };
			}
			const kind = classify(error);
			if (kind !== 'retry' || attempt >= maxAttempts) {
				host.emit({
					type: 'error',
					message: error instanceof Error ? error.message : String(error),
					retryable: kind === 'retry',
				});
				return { kind: 'ok', finish: 'error', assistant: '', collected: [], sawTextEnd: false };
			}
			const delayMs = retryDelayMs(attempt, parseRetryAfter(error));
			host.emit({ type: 'retry', attempt, delayMs, message: error instanceof Error ? error.message : String(error) });
			await (input.delay ?? sleep)(delayMs);
		}
	}
}

async function readStream(
	host: INativeLoopHost,
	messages: readonly INativeLoopMessage[],
	token: { isCancellationRequested: boolean },
): Promise<StreamedTurn> {
	const argText = new Map<string, string>();
	const names = new Map<string, string>();
	let finish: NativeFinishReason = 'stop';
	let assistant = '';
	let sawTextEnd = false;
	let input = 0;
	let output = 0;
	let sawUsage = false;

	for await (const event of host.stream(messages, token)) {
		if (token.isCancellationRequested) {
			return { kind: 'abort', assistant, calls: collectedCalls(names, argText) };
		}
		if (event.type === 'finish') {
			finish = event.reason;
			continue;
		}
		host.emit(event);
		if (event.type === 'text.delta' && event.delta) {
			assistant += event.delta;
		}
		if (event.type === 'text.end') {
			sawTextEnd = true;
			if (event.delta && !assistant) {
				assistant = event.delta;
			}
		}
		if (event.type === 'usage') {
			input += event.input;
			output += event.output;
			sawUsage = true;
		}
		if (event.type === 'tool.start') {
			names.set(event.callId, event.name);
			if (event.input) {
				argText.set(event.callId, event.input);
			}
		}
		if (event.type === 'tool.input.delta') {
			argText.set(event.callId, (argText.get(event.callId) ?? '') + event.delta);
		}
	}

	if (finish === 'abort' || token.isCancellationRequested) {
		return { kind: 'abort', assistant, calls: collectedCalls(names, argText) };
	}
	return {
		kind: 'ok',
		finish,
		assistant,
		collected: collectedCalls(names, argText),
		sawTextEnd,
		...(sawUsage ? { tokens: { input, output } } : {}),
	};
}

function collectedCalls(names: Map<string, string>, argText: Map<string, string>): IToolCall[] {
	return [...names].map(([id, name]) => ({
		id,
		name,
		args: parseArgs(argText.get(id)),
	}));
}

function failLengthBatch(host: INativeLoopHost, messages: INativeLoopMessage[], assistant: string, collected: readonly IToolCall[]): void {
	if (collected.length) {
		messages.push({ role: 'assistant', content: assistant, toolCalls: collected.slice() });
		appendToolResults(host, messages, syntheticResults(
			collected,
			'Tool call was truncated (finish reason: length). Arguments are incomplete and were not executed. Retry with a smaller payload, or continue without this tool.',
			'other',
		));
	} else if (assistant) {
		messages.push({ role: 'assistant', content: assistant });
	}
	messages.push({ role: 'user', content: LENGTH_HINT });
}

function settleAbort(host: INativeLoopHost, messages: INativeLoopMessage[], assistant: string, calls: readonly IToolCall[]): void {
	if (calls.length) {
		messages.push({ role: 'assistant', content: assistant, toolCalls: calls.slice() });
		appendToolResults(host, messages, syntheticResults(calls, 'Tool call was interrupted before it was dispatched.', 'other'));
		return;
	}
	if (assistant) {
		messages.push({ role: 'assistant', content: assistant });
	}
}

export function syntheticResults(calls: readonly IToolCall[], text: string, kind: IToolResult['kind'] = 'other'): IToolResult[] {
	return calls.map(call => ({ callId: call.id, name: call.name, kind, text, isError: true }));
}

function appendToolResults(host: INativeLoopHost, messages: INativeLoopMessage[], results: readonly IToolResult[]): void {
	for (const result of results) {
		host.emit({
			type: 'tool.end',
			callId: result.callId,
			result: result.text,
			error: result.isError ? result.text : undefined,
			durationMs: result.durationMs,
		});
		messages.push({
			role: 'tool',
			content: result.text,
			callId: result.callId,
			name: result.name,
		});
	}
}

function appendAdditionalContexts(host: INativeLoopHost, messages: INativeLoopMessage[], results: readonly IToolResult[], enqueue?: (text: string) => void): void {
	const extras = results.flatMap(result => result.contexts ?? []).filter(text => text.trim());
	for (const text of extras) {
		if (enqueue) {
			enqueue(text);
		} else {
			messages.push({ role: 'user', content: text });
		}
	}
	if (extras.length) {
		host.emit({ type: 'inbox', claimed: extras.length });
	}
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
