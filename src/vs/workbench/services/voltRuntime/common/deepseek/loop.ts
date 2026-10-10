/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IVoltEvent } from '../events.js';
import { ILoopDetectorOptions, LoopDetector, LoopSignal, LoopVerdict } from '../harness/doomLoop.js';
import { INativeLoopMessage } from '../harness/nativeLoop.js';
import { toLoopStep } from '../harness/progress.js';
import { createLoopDetector } from '../harness/recovery.js';
import { describeArgIssues, isUnparsedArgs, normalizeArgs, validateArgs } from '../harness/toolPolicy.js';
import { ProviderError, providerRetryDelay } from '../providerError.js';
import type { IModelAssistantPart } from '../providers.js';
import { IToolCall, IToolResult, IVoltTool } from '../tools/tool.js';
import { turnWriteGate } from '../turnWriteGate.js';
import { ApprovalOutcome, StreamChunk } from './protocol.js';
import { DEEPSEEK_BUDGET } from './prompt.js';
import { presentCall, presentResult, toolEndFromView, toolStartFromView } from './presentation.js';

export interface IDeepseekStreamOptions {
	/** Raised after a turn was cut off at the output limit. */
	readonly maxOutputTokens?: number;
	/**
	 * Aborted when the loop gives up on this stream (it stalled, or the reply started repeating
	 * itself). Hosts should tear the request down when it fires.
	 */
	readonly signal?: AbortSignal;
}

/**
 * How long one model stream may stay silent, in ms; 0 turns a limit off. There is deliberately no
 * latency budget: the first chunk may take minutes (large prompts, silent reasoning, a local model
 * loading), so `firstChunkMs` only catches a dead connection. Once data flows, `idleMs` of silence
 * means the stream stalled.
 */
export interface IDeepseekStreamTimeouts {
	readonly firstChunkMs?: number;
	readonly idleMs?: number;
}

export const DEEPSEEK_STREAM_TIMEOUTS = { firstChunkMs: 600_000, idleMs: 120_000 } as const;

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
	/** The chat the run belongs to: writes wait for its turn gate (the checkpoint taken at send). */
	readonly sessionId?: string;
	/** Model window, reported with usage so the context meter is exact. */
	readonly contextWindow?: number;
	/** Largest output the model accepts; used after a cut-off turn. */
	readonly maxOutputTokens?: number;
	/** Stream watchdog. Defaults to `DEEPSEEK_STREAM_TIMEOUTS`. */
	readonly streamTimeouts?: IDeepseekStreamTimeouts;
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

/** What one step did, handed to the controller after its tools ran (or when the model wants to stop). */
export interface IDeepseekStep {
	readonly step: number;
	readonly calls: readonly IToolCall[];
	readonly results: readonly IToolResult[];
	/** Assistant text of this step. */
	readonly assistant: string;
	/** No tool calls, or a successful `finish`: the model claims the work is done. */
	readonly wantsToFinish: boolean;
	/** What Volt's loop detector made of this step. A `warn` is already being sent to the model. */
	readonly loop: LoopVerdict;
}

export type DeepseekDirective =
	| { readonly kind: 'continue' }
	/** Send this as a user message before the next model call. On a finishing step, it sends the model back to work. */
	| { readonly kind: 'inject'; readonly message: string }
	/** End the run. `outcome` defaults to `done`. */
	| { readonly kind: 'stop'; readonly reason: string; readonly outcome?: 'done' | 'fail' };

/**
 * The harness's hook into the live loop (the idea of `ILoopController` from the old native loop).
 * Called once per step; a controller that throws is ignored, never fatal.
 */
export interface IDeepseekLoopController {
	afterStep(step: IDeepseekStep): DeepseekDirective | Promise<DeepseekDirective>;
}

export interface IDeepseekLoopInput {
	messages: INativeLoopMessage[];
	token: { isCancellationRequested: boolean };
	budget?: { readonly maxToolCalls: number; readonly maxModelCalls: number };
	isPaused?: () => boolean;
	claimInbox?: () => readonly string[];
	/** Consulted after Volt's own loop detector on every step. */
	controller?: IDeepseekLoopController;
	/** Loop detector settings (the user's request is filled in from the transcript); `false` turns it off. */
	loopDetection?: ILoopDetectorOptions | false;
}

/** Why a run ended before the model finished. */
export interface IDeepseekStop {
	readonly by: 'loop' | 'controller';
	readonly reason: string;
	readonly signal?: LoopSignal;
	/** Steps that make up the loop. */
	readonly evidence?: readonly number[];
}

export interface IDeepseekLoopResult {
	readonly outcome: 'done' | 'abort' | 'fail' | 'budget';
	readonly assistant: string;
	readonly messages: INativeLoopMessage[];
	readonly stopped?: IDeepseekStop;
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
const MAX_STALL_RECOVERIES = 2;
const MAX_COMPLETION_REVIEWS = 2;
const FALLBACK_MAX_OUTPUT = 128_000;
/** Streamed text is checked for runaway repetition each time it grows by this much. */
const TEXT_CHECK_CHARS = 1_024;
const TRUNCATED_TOOL = 'Tool call was truncated at the output limit before its arguments were complete. It was not executed.';
const INTERRUPTED_TOOL = 'Tool call was interrupted before it was dispatched.';
const STALL_HINT = 'Your last response was cut off because the model stream stalled. Continue exactly where you left off, without repeating what you already wrote. Tool calls in that response did not run; make them again if you still need them.';
const NO_LOOP: LoopVerdict = { kind: 'ok' };
const CONTINUE: DeepseekDirective = { kind: 'continue' };

/**
 * DeepSeek turn loop: stream, present, approve, execute, supervise, repeat.
 *
 * Fast paths: live chunks are emitted as they arrive; a read-only call whose arguments are
 * complete starts while the model is still writing; approvals are decided together; each card
 * completes when its own call does. Reliability: a failed stream is retried before anything was
 * shown, a stalled stream is abandoned and continued, an overflowing prompt is compacted once, and
 * a cut-off turn continues with a larger output limit. Supervision: the loop detector nudges a
 * looping model once per pattern and stops the run if it keeps going; a host controller sees every
 * step. The model decides when the turn is over; the host may send it back once or twice.
 */
export async function runDeepseekLoop(host: IDeepseekHost, input: IDeepseekLoopInput): Promise<IDeepseekLoopResult> {
	const messages = input.messages;
	const budget = input.budget ?? DEEPSEEK_BUDGET;
	const detector = input.loopDetection === false ? undefined : createLoopDetector({ request: latestRequest(messages), ...input.loopDetection });
	let toolCalls = 0;
	let modelCalls = 0;
	let lastAssistant = '';
	let lengthStreak = 0;
	let maxOutputTokens: number | undefined;
	let streamRetries = 0;
	let stallRecoveries = 0;
	let overflowRecovered = false;
	let reviews = 0;
	let gateInjections = 0;

	const stopped = (stop: IDeepseekStop, outcome: 'done' | 'fail'): IDeepseekLoopResult => ({ outcome, assistant: lastAssistant, messages, stopped: stop });

	/** The model wants to stop: completion review, then the controller, may send it back (bounded). */
	const finishing = async (step: Omit<IDeepseekStep, 'wantsToFinish' | 'loop'>): Promise<IDeepseekLoopResult | 'continue' | undefined> => {
		const directive = await consult(host, input.controller, { ...step, wantsToFinish: true, loop: NO_LOOP });
		if (directive.kind === 'stop') {
			return controllerStop(host, directive, stopped);
		}
		const nudge = await review(host, reviews, lastAssistant);
		const sendBack = directive.kind === 'inject' && gateInjections < MAX_COMPLETION_REVIEWS ? directive.message : undefined;
		if (nudge) {
			reviews++;
		}
		if (sendBack) {
			gateInjections++;
		}
		const back = [nudge, sendBack].filter((text): text is string => !!text);
		if (back.length) {
			messages.push({ role: 'user', content: back.join('\n\n') });
			return 'continue';
		}
		return undefined;
	};

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
		const streamed = await readChunks(host, messages, input.token, { maxOutputTokens }, call => eager.offer(call), eager, detector);
		host.emit({ type: 'step.end', step: modelCalls });

		if (streamed.kind === 'abort') {
			await eager.settle();
			lastAssistant = streamed.assistant || lastAssistant;
			return { outcome: 'abort', assistant: lastAssistant, messages };
		}
		if (streamed.kind === 'runaway') {
			await eager.settle();
			const verdict = streamed.verdict;
			const kept = streamed.channel === 'text' && verdict.text
				? streamed.assistant.slice(0, verdict.text.start + verdict.text.unit.length).trimEnd()
				: streamed.assistant.trimEnd();
			if (kept) {
				lastAssistant = kept;
				messages.push({ role: 'assistant', content: kept });
			}
			if (verdict.kind === 'stop') {
				host.emit({ type: 'error', message: loopStopMessage(verdict), retryable: false });
				return stopped({ by: 'loop', reason: verdict.reason, signal: verdict.signal, evidence: [modelCalls] }, 'fail');
			}
			host.emit(loopNotice(verdict));
			messages.push({ role: 'user', content: verdict.nudge });
			continue;
		}
		if (streamed.kind === 'stalled') {
			await eager.settle();
			if (stallRecoveries >= MAX_STALL_RECOVERIES) {
				host.emit({ type: 'error', message: localize('volt.loop.stalled', "The model stopped sending data for {0}s, again. Send \"continue\" to retry.", streamed.seconds), retryable: true });
				return { outcome: 'fail', assistant: lastAssistant, messages };
			}
			stallRecoveries++;
			lastAssistant = streamed.assistant || lastAssistant;
			const parts = streamed.parts.filter(part => part.type === 'text');
			if (streamed.assistant || parts.length) {
				messages.push({ role: 'assistant', content: streamed.assistant, ...(parts.length ? { parts } : {}) });
			}
			messages.push({ role: 'user', content: STALL_HINT });
			host.emit({ type: 'retry', attempt: stallRecoveries + 1, delayMs: 0, message: localize('volt.loop.stalledRetry', "The model stopped sending data for {0}s. Continuing from where it left off.", streamed.seconds) });
			continue;
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
			const gate = await finishing({ step: modelCalls, calls: [], results: [], assistant: streamed.assistant });
			if (gate === 'continue') {
				continue;
			}
			return gate ?? { outcome: 'done', assistant: lastAssistant, messages };
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
			const gate = await finishing({ step: modelCalls, calls, results: outcome.results, assistant: streamed.assistant });
			if (gate === 'continue') {
				continue;
			}
			if (gate) {
				return gate;
			}
			if (!lastAssistant.trim()) {
				const summary = finishSummary(finished.text);
				lastAssistant = summary;
				host.emit({ type: 'text.delta', id: 'finish', delta: summary });
			}
			return { outcome: 'done', assistant: lastAssistant, messages };
		}

		const verdict = detector?.observe(toLoopStep(modelCalls, calls, outcome.results, streamed.assistant)) ?? NO_LOOP;
		if (verdict.kind === 'stop') {
			host.emit({ type: 'error', message: loopStopMessage(verdict), retryable: false });
			return stopped({ by: 'loop', reason: verdict.reason, signal: verdict.signal, evidence: verdict.evidence }, 'fail');
		}
		const directive = await consult(host, input.controller, { step: modelCalls, calls, results: outcome.results, assistant: streamed.assistant, wantsToFinish: false, loop: verdict });
		if (directive.kind === 'stop') {
			return controllerStop(host, directive, stopped);
		}
		const notes: string[] = [];
		if (verdict.kind === 'warn') {
			host.emit(loopNotice(verdict));
			notes.push(verdict.nudge);
		}
		if (directive.kind === 'inject' && directive.message.trim()) {
			notes.push(directive.message);
		}
		if (notes.length) {
			messages.push({ role: 'user', content: notes.join('\n\n') });
		}
	}
	return { outcome: 'abort', assistant: lastAssistant, messages };
}

/** The user's latest typed turn: the loop detector lets repetition it asks for through. */
function latestRequest(messages: readonly INativeLoopMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === 'user' && message.turn) {
			return message.content;
		}
	}
	return [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
}

/** A controller that throws must not take the run down with it. */
async function consult(host: IDeepseekHost, controller: IDeepseekLoopController | undefined, step: IDeepseekStep): Promise<DeepseekDirective> {
	if (!controller) {
		return CONTINUE;
	}
	try {
		return await controller.afterStep(step);
	} catch (error) {
		host.emit({ type: 'notice', severity: 'warning', title: localize('volt.loop.controllerFailed', "A run check failed and was skipped."), description: errorText(error) });
		return CONTINUE;
	}
}

function controllerStop(host: IDeepseekHost, directive: Extract<DeepseekDirective, { kind: 'stop' }>, stopped: (stop: IDeepseekStop, outcome: 'done' | 'fail') => IDeepseekLoopResult): IDeepseekLoopResult {
	const outcome = directive.outcome ?? 'done';
	if (directive.reason.trim()) {
		host.emit(outcome === 'fail'
			? { type: 'error', message: directive.reason, retryable: false }
			: { type: 'notice', severity: 'warning', title: directive.reason });
	}
	return stopped({ by: 'controller', reason: directive.reason }, outcome);
}

function loopNotice(verdict: Extract<LoopVerdict, { kind: 'warn' }>): IVoltEvent {
	return {
		type: 'notice',
		severity: 'warning',
		title: verdict.signal === 'runaway'
			? localize('volt.loop.runawayTitle', "The reply started repeating itself, so Volt cut it off and asked the agent to continue")
			: localize('volt.loop.warnTitle', "The agent seems to be looping; Volt asked it to change approach"),
		description: describeLoop(verdict),
	};
}

function loopStopMessage(verdict: Extract<LoopVerdict, { kind: 'stop' }>): string {
	return localize('volt.loop.stopped', "Stopped: the agent kept looping after Volt asked it to change approach. {0}", describeLoop(verdict));
}

/** What repeated, for people, with the steps it happened in. */
function describeLoop(verdict: Exclude<LoopVerdict, { kind: 'ok' }>): string {
	const steps = verdict.evidence.join(', ');
	switch (verdict.signal) {
		case 'repeat':
			return localize('volt.loop.repeat', "{0} ran {1} times with the same result (steps {2}).", verdict.subject, verdict.count, steps);
		case 'near-repeat':
			return localize('volt.loop.nearRepeat', "{0} was called {1} times with nearly identical arguments and the same result (steps {2}).", verdict.subject, verdict.count, steps);
		case 'oscillation':
			return localize('volt.loop.oscillation', "{0} was changed back and forth (steps {1}).", verdict.subject, steps);
		case 'repeated-error':
			return localize('volt.loop.repeatedError', "The same error came back {0} times (steps {1}): {2}", verdict.count, steps, verdict.subject);
		case 'no-progress':
			return localize('volt.loop.noProgress', "{0} steps in a row produced nothing new (steps {1}).", verdict.count, steps);
		case 'text-repeat':
			return localize('volt.loop.textRepeat', "The agent wrote the same message {0} times (steps {1}).", verdict.count, steps);
		case 'runaway':
			return localize('volt.loop.runaway', "The reply repeated \"{0}\" {1} times.", verdict.subject, verdict.count);
	}
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
	const slots: (IToolResult | undefined)[] = new Array<IToolResult | undefined>(calls.length);
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
		// Early reads were earlier in the batch; a write after them must see them finish first. A
		// write also waits for the turn's gate: the checkpoint taken at send may still be running.
		if (approved.some(entry => !entry.prepared.tool.parallelSafe)) {
			await Promise.all([eager.settle(), turnWriteGate(host.sessionId)]);
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
	| { kind: 'error'; error: unknown; visible: boolean }
	/** Output had already been shown when the stream went silent. */
	| { kind: 'stalled'; assistant: string; parts: IModelAssistantPart[]; seconds: number }
	/** The reply or its reasoning started repeating itself; the stream was cut. */
	| { kind: 'runaway'; assistant: string; channel: 'text' | 'reasoning'; verdict: Exclude<LoopVerdict, { kind: 'ok' }> };

const STALLED = Symbol('stalled');

async function readChunks(
	host: IDeepseekHost,
	messages: readonly INativeLoopMessage[],
	token: { isCancellationRequested: boolean },
	options: IDeepseekStreamOptions,
	onToolReady: (call: IToolCall) => void,
	eager: EagerDispatch,
	detector: LoopDetector | undefined,
): Promise<ReadResult> {
	const blocks = new Map<number, IOpenBlock>();
	const parts = new Map<number, IModelAssistantPart>();
	let assistant = '';
	let reasoning = '';
	let checkedText = 0;
	let checkedReasoning = 0;
	let visible = false;
	let finish: 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted' = 'stop';
	const firstChunkMs = host.streamTimeouts?.firstChunkMs ?? DEEPSEEK_STREAM_TIMEOUTS.firstChunkMs;
	const idleMs = host.streamTimeouts?.idleMs ?? DEEPSEEK_STREAM_TIMEOUTS.idleMs;
	const abort = new AbortController();
	const iterator = host.stream(messages, token, { ...options, signal: abort.signal })[Symbol.asyncIterator]();
	const watchdog = new StreamWatchdog();
	let completed = false;
	let received = false;
	let graceMs = 0;
	const orderedParts = () => [...parts.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
	/** Cuts the stream on a runaway repetition; `undefined` while the text looks fine. */
	const runaway = (final: boolean): ReadResult | undefined => {
		if (!detector) {
			return undefined;
		}
		for (const channel of ['text', 'reasoning'] as const) {
			const text = channel === 'text' ? assistant : reasoning;
			const checked = channel === 'text' ? checkedText : checkedReasoning;
			if (text.length - checked < TEXT_CHECK_CHARS && !(final && text.length > checked)) {
				continue;
			}
			if (channel === 'text') {
				checkedText = text.length;
			} else {
				checkedReasoning = text.length;
			}
			const verdict = detector.checkText(text);
			if (verdict.kind !== 'ok') {
				abort.abort();
				closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
				return { kind: 'runaway', assistant, channel, verdict };
			}
		}
		return undefined;
	};
	try {
		while (true) {
			const limit = received ? idleMs : firstChunkMs;
			const next = await watchdog.next(iterator, limit > 0 ? limit + graceMs : 0);
			if (next === STALLED) {
				abort.abort();
				closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
				const seconds = Math.round((limit + graceMs) / 1000);
				return visible
					? { kind: 'stalled', assistant, parts: orderedParts(), seconds }
					: { kind: 'error', error: new ProviderError(`The model sent no data for ${seconds}s; the stream timed out.`), visible: false };
			}
			if (next.done) {
				completed = true;
				break;
			}
			const chunk = next.value;
			received = true;
			graceMs = 0;
			if (token.isCancellationRequested) {
				closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
				return { kind: 'abort', assistant };
			}
			if (chunk.type === 'event') {
				host.emit(chunk.event);
				if (chunk.event.type === 'retry') {
					// The provider waits, then opens a new request: its first chunk gets the full allowance.
					received = false;
					graceMs = chunk.event.delayMs;
				}
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
				if (event.type === 'reasoning.delta' && event.delta) {
					reasoning += event.delta;
				}
				if (event.type === 'tool.start' || event.type === 'tool.input.delta') {
					visible = true;
				}
			}
			if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
				const cut = runaway(false);
				if (cut) {
					return cut;
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
		completed = true;
		closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
		return { kind: 'error', error, visible };
	} finally {
		watchdog.dispose();
		if (!completed) {
			// Abandoned mid-stream: let the generator clean up once its pending read settles.
			void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
		}
	}
	if (finish === 'aborted' || token.isCancellationRequested) {
		closeOpenCalls(host, blocks, INTERRUPTED_TOOL, eager);
		return { kind: 'abort', assistant };
	}
	const calls = callsFromBlocks(blocks);
	if (finish === 'length') {
		// A degenerate reply runs into the output limit; continuing it would only repeat more.
		const cut = runaway(true);
		if (cut) {
			return cut;
		}
		const truncated = [...blocks.values()].find(block => block.kind === 'tool-call' && block.id && !eager.has(block.id));
		closeOpenCalls(host, blocks, TRUNCATED_TOOL, eager);
		return { kind: 'ok', finish: 'length', assistant, calls: [], parts: orderedParts(), truncatedTool: truncated?.name };
	}
	if (finish === 'error') {
		closeOpenCalls(host, blocks, 'The model stream failed before this tool could run.', eager);
		return { kind: 'ok', finish: 'error', assistant, calls: [], parts: orderedParts() };
	}
	return { kind: 'ok', finish: calls.length ? 'tool_calls' : 'stop', assistant, calls, parts: orderedParts() };
}

/**
 * The stream's silence watchdog. One timer serves the whole stream instead of one per chunk: each
 * read only moves the deadline, and the timer is re-armed when it fires before that deadline (or
 * when a read needs an earlier one than the armed timer, e.g. the first chunk's long allowance
 * giving way to the idle limit).
 */
class StreamWatchdog {

	private deadline = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private armedAt = 0;
	private stall: (() => void) | undefined;

	/** The next chunk, or `STALLED` when none arrives within `ms` (0 waits forever). */
	next<T>(iterator: AsyncIterator<T>, ms: number): Promise<IteratorResult<T> | typeof STALLED> {
		const next = iterator.next();
		if (ms <= 0) {
			return next;
		}
		this.deadline = Date.now() + ms;
		return new Promise((resolve, reject) => {
			let settled = false;
			const settle = () => {
				settled = true;
				this.stall = undefined;
			};
			this.stall = () => {
				if (!settled) {
					settle();
					next.catch(() => undefined);
					resolve(STALLED);
				}
			};
			this.arm();
			next.then(value => {
				if (!settled) {
					settle();
					resolve(value);
				}
			}, error => {
				if (!settled) {
					settle();
					reject(error);
				}
			});
		});
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.stall = undefined;
	}

	private arm(): void {
		if (this.timer !== undefined && this.armedAt <= this.deadline) {
			return;
		}
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.armedAt = this.deadline;
		this.timer = setTimeout(() => this.fire(), Math.max(0, this.deadline - Date.now()));
	}

	private fire(): void {
		this.timer = undefined;
		if (!this.stall) {
			return;
		}
		if (this.deadline > Date.now()) {
			this.arm();
			return;
		}
		this.stall();
	}
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
