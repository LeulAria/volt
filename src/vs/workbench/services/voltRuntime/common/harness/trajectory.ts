/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { StreamChunk, TokenUsage } from '../deepseek/protocol.js';
import type { IModelImage } from '../providers.js';
import { IToolCall, IToolResult, IToolSchema } from '../tools/tool.js';
import { estimateTokens } from './contextEngine.js';
import { INativeLoopMessage } from './nativeLoop.js';
import { resultText } from './supervisor.js';

/**
 * The API trajectory of a native run: every model request as it went on the wire (system prompt,
 * messages, tool schemas, options) and what came back (reasoning, text, tool calls, usage, finish),
 * with timings, plus the tool calls each answer started. The Trajectory panel reads these; nothing
 * here is sent anywhere. Messages are shallow copies, so their strings are shared with the transcript.
 */

export interface ITrajectoryToolCall {
	readonly id: string;
	readonly name: string;
	/** An agent may send a call's input after announcing it. */
	arguments: string;
}

export interface ITrajectoryResponse {
	text: string;
	reasoning: string;
	toolCalls: ITrajectoryToolCall[];
}

export interface ITrajectoryNote {
	readonly at: number;
	readonly kind: 'retry' | 'error' | 'notice';
	readonly text: string;
}

export interface ITrajectoryToolRun {
	readonly callId: string;
	readonly name: string;
	args: unknown;
	readonly startedAt: number;
	endedAt?: number;
	durationMs?: number;
	isError?: boolean;
	/** It never reported a result (the run was stopped, or the batch gave up on it). */
	cancelled?: boolean;
	/** What the model got back. */
	result?: string;
}

export interface ITrajectoryRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly runId: string;
	/** 1-based, per chat. */
	readonly index: number;
	readonly step?: number;
	readonly provider: string;
	readonly model: string;
	readonly modelLabel?: string;
	/** A subagent's name; the chat's own agent has none. */
	readonly agent?: string;
	/**
	 * The agent that ran the request when Volt does not run the model itself (Claude Code, Codex
	 * and other ACP agents). Its system prompt, tools and history stay inside it: `system` and
	 * `tools` are empty and `messages` holds only the input new to this request (the user's
	 * message, or the answer and tool results since the previous request).
	 */
	readonly harness?: string;
	readonly startedAt: number;
	firstChunkAt?: number;
	endedAt?: number;
	readonly system: string;
	readonly messages: readonly INativeLoopMessage[];
	readonly tools: readonly IToolSchema[];
	readonly options?: unknown;
	readonly maxOutputTokens?: number;
	readonly response: ITrajectoryResponse;
	usage?: TokenUsage;
	/** `usage` counts every request of the turn: agents report their usage once a turn. */
	usageScope?: 'turn';
	/** How full the agent said its context was after this request, and the window's size. */
	contextTokens?: number;
	contextWindow?: number;
	costUsd?: number;
	finish?: string;
	error?: string;
	readonly notes: ITrajectoryNote[];
	readonly toolRuns: ITrajectoryToolRun[];
}

export interface ITrajectoryRequestInput {
	readonly id: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly index: number;
	readonly step?: number;
	readonly provider: string;
	readonly model: string;
	readonly modelLabel?: string;
	readonly agent?: string;
	readonly harness?: string;
	readonly system: string;
	readonly messages: readonly INativeLoopMessage[];
	readonly tools: readonly IToolSchema[];
	readonly options?: unknown;
	readonly maxOutputTokens?: number;
	/** When it went out, if not now: an agent's next request starts when the tool results it waited on came back. */
	readonly startedAt?: number;
}

export function newTrajectoryRequest(input: ITrajectoryRequestInput, now = Date.now()): ITrajectoryRequest {
	return {
		...input,
		messages: input.messages.map(message => ({ ...message })),
		startedAt: input.startedAt ?? now,
		response: { text: '', reasoning: '', toolCalls: [] },
		notes: [],
		toolRuns: [],
	};
}

function noteText(event: IVoltEvent): ITrajectoryNote | undefined {
	switch (event.type) {
		case 'retry': return { at: Date.now(), kind: 'retry', text: `Retry ${event.attempt} in ${Math.round(event.delayMs / 100) / 10}s: ${event.message}` };
		case 'error': return { at: Date.now(), kind: 'error', text: event.message };
		case 'notice': return { at: Date.now(), kind: 'notice', text: event.description ? `${event.title} ${event.description}` : event.title };
		default: return undefined;
	}
}

/** Passes the stream through untouched while it fills in `request`; `onChange` fires as it grows. */
export async function* recordStream(source: AsyncIterable<StreamChunk>, request: ITrajectoryRequest, onChange: () => void): AsyncGenerator<StreamChunk> {
	try {
		for await (const chunk of source) {
			if (request.firstChunkAt === undefined) {
				request.firstChunkAt = Date.now();
			}
			switch (chunk.type) {
				case 'text-delta':
					request.response.text += chunk.text;
					break;
				case 'reasoning-delta':
					request.response.reasoning += chunk.text;
					break;
				case 'block-end':
					if (chunk.block.type === 'tool-call') {
						request.response.toolCalls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments });
					} else if (chunk.block.type === 'reasoning' && !request.response.reasoning && chunk.block.text) {
						// A provider that hands reasoning over as one block, with no deltas.
						request.response.reasoning = chunk.block.text;
					}
					break;
				case 'usage':
					request.usage = chunk.usage;
					break;
				case 'event': {
					const note = noteText(chunk.event);
					if (note) {
						request.notes.push(note);
					}
					break;
				}
				case 'finish':
					request.finish = chunk.reason;
					break;
			}
			onChange();
			yield chunk;
		}
	} catch (err) {
		request.error = err instanceof Error ? err.message : String(err);
		throw err;
	} finally {
		request.endedAt = Date.now();
		if (!request.finish && !request.error) {
			request.finish = 'aborted';
		}
		onChange();
	}
}

const RESULT_CHARS = 20_000;

export function startToolRun(request: ITrajectoryRequest, call: IToolCall, now = Date.now()): void {
	request.toolRuns.push({ callId: call.id, name: call.name, args: call.args, startedAt: now });
}

export function endToolRun(request: ITrajectoryRequest, result: IToolResult, now = Date.now()): void {
	const run = request.toolRuns.find(candidate => candidate.callId === result.callId);
	if (!run) {
		return;
	}
	run.endedAt = now;
	run.durationMs = result.durationMs ?? now - run.startedAt;
	run.isError = result.isError;
	run.result = clipResult(result.text);
}

function clipResult(text: string): string {
	return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n\n[${text.length - RESULT_CHARS} more characters]` : text;
}

/** Calls of an earlier request still open when the next one goes out never finished. */
export function closeOpenToolRuns(request: ITrajectoryRequest, now = Date.now()): void {
	for (const run of request.toolRuns) {
		if (run.endedAt === undefined) {
			run.endedAt = now;
			run.durationMs = now - run.startedAt;
			run.cancelled = true;
		}
	}
}

// --- agents Volt does not run itself ---------------------------------------------------------

/** Where an {@link AgentTrajectoryRecorder} puts its requests: the trajectory service, for one chat. */
export interface IAgentTrajectorySink {
	begin(input: Omit<ITrajectoryRequestInput, 'id' | 'index'>): ITrajectoryRequest | undefined;
	changed(): void;
}

export interface IAgentTrajectoryTarget {
	readonly sessionId: string;
	readonly runId: string;
	readonly provider: string;
	readonly model: string;
	readonly modelLabel?: string;
	/** The agent's name, e.g. Claude Code. */
	readonly harness: string;
}

function parseToolInput(input: string | undefined): unknown {
	if (!input) {
		return {};
	}
	try {
		return JSON.parse(input);
	} catch {
		return input;
	}
}

/**
 * The trajectory of an agent Volt does not run itself (Claude Code, Codex, Cursor and other ACP
 * agents), read from the events it streams. Its model requests stay inside it, so a request here
 * is one answer of its model: it ends where the answer asks for tools, and the next starts when
 * the model speaks again after a tool result came back. Its input is what Volt saw go in (the
 * prompt, or the answer and tool results since the previous request). Agents report tokens once
 * a turn, on its last request, and their context size along the way, on the request it followed.
 */
export class AgentTrajectoryRecorder {

	private current: ITrajectoryRequest | undefined;
	private readonly turn: ITrajectoryRequest[] = [];
	/** The request whose answer started each tool call. */
	private readonly calls = new Map<string, ITrajectoryRequest>();
	/** Tool results back since the current request's answer: the next request's input. */
	private results: INativeLoopMessage[] = [];
	private textId: string | undefined;
	private usage: { input: number; output: number; cache: number; cacheWrite: number } | undefined;
	private lastError: string | undefined;
	private model: string;
	private readonly subagents = new Map<string, AgentTrajectoryRecorder>();
	private done = false;

	constructor(
		private readonly sink: IAgentTrajectorySink,
		private readonly target: IAgentTrajectoryTarget,
		private readonly agent?: string,
		private readonly now: () => number = Date.now,
	) {
		this.model = target.model;
	}

	/** The prompt went out: the turn's first request. */
	prompt(text: string, images?: readonly IModelImage[]): void {
		if (!this.done && !this.current) {
			this.open([{ role: 'user', content: text, ...(images?.length ? { images: [...images] } : {}) }], this.now());
		}
	}

	event(event: IVoltEvent): void {
		if (this.done) {
			return;
		}
		const now = this.now();
		switch (event.type) {
			case 'text.delta':
			case 'reasoning.delta': {
				if (!event.delta) {
					return;
				}
				const request = this.answering(now);
				if (!request) {
					return;
				}
				if (event.type === 'text.delta') {
					// Another message of the same answer is another paragraph, as the transcript shows it.
					if (this.textId !== undefined && event.id !== this.textId && request.response.text && !request.response.text.endsWith('\n')) {
						request.response.text += '\n\n';
					}
					this.textId = event.id;
					request.response.text += event.delta;
				} else {
					request.response.reasoning += event.delta;
				}
				// Still answering.
				request.endedAt = undefined;
				request.finish = undefined;
				break;
			}
			case 'reasoning.block': {
				const request = this.answering(now);
				if (!request || request.response.reasoning || !event.text) {
					return;
				}
				request.response.reasoning = event.text;
				break;
			}
			case 'tool.start': {
				if (this.calls.has(event.callId)) {
					return;
				}
				const request = this.answering(now);
				if (!request) {
					return;
				}
				request.response.toolCalls.push({ id: event.callId, name: event.name, arguments: event.input ?? '' });
				request.toolRuns.push({ callId: event.callId, name: event.name, args: parseToolInput(event.input), startedAt: now });
				this.calls.set(event.callId, request);
				// The answer is out once it asks for a tool; more calls of the same answer move its end.
				request.endedAt = now;
				request.finish = 'tool_calls';
				break;
			}
			case 'tool.input.delta': {
				const request = this.calls.get(event.callId);
				const call = request?.response.toolCalls.find(candidate => candidate.id === event.callId);
				const run = request?.toolRuns.find(candidate => candidate.callId === event.callId);
				if (!call || !run || !event.delta) {
					return;
				}
				call.arguments = event.append ? call.arguments + event.delta : event.delta;
				run.args = parseToolInput(call.arguments);
				break;
			}
			case 'tool.end': {
				const run = this.calls.get(event.callId)?.toolRuns.find(candidate => candidate.callId === event.callId);
				if (!run || run.endedAt !== undefined) {
					return;
				}
				const output = resultText(event.result) || event.output || '';
				run.endedAt = now;
				run.durationMs = event.durationMs ?? now - run.startedAt;
				run.isError = !!event.error;
				run.result = clipResult(event.error && !output.includes(event.error) ? [event.error, output].filter(Boolean).join('\n') : output);
				this.results.push({ role: 'tool', content: run.result, callId: run.callId, name: run.name, ...(run.isError ? { isError: true } : {}) });
				break;
			}
			case 'usage': {
				const request = this.current;
				if (request && event.used !== undefined) {
					request.contextTokens = event.used;
				}
				if (request && event.size !== undefined) {
					request.contextWindow = event.size;
				}
				const cache = event.cache ?? 0, cacheWrite = event.cacheWrite ?? 0;
				if (event.input + event.output + cache + cacheWrite > 0) {
					const usage = this.usage ??= { input: 0, output: 0, cache: 0, cacheWrite: 0 };
					usage.input += event.input;
					usage.output += event.output;
					usage.cache += cache;
					usage.cacheWrite += cacheWrite;
				}
				break;
			}
			case 'model.reported':
				this.model = event.model;
				return;
			case 'retry':
			case 'error':
			case 'notice': {
				const note = noteText(event);
				if (event.type === 'error') {
					this.lastError = event.message;
				}
				if (!note || !this.current) {
					return;
				}
				this.current.notes.push(note);
				break;
			}
			case 'subagent.spawned': {
				if (this.subagents.has(event.childId)) {
					return;
				}
				const model = event.model ?? this.target.model;
				const child = new AgentTrajectoryRecorder(this.sink, { ...this.target, model, modelLabel: model === this.target.model ? this.target.modelLabel : undefined }, event.title || event.kind || 'subagent', this.now);
				this.subagents.set(event.childId, child);
				child.prompt(event.prompt ?? event.title);
				return;
			}
			case 'subagent.event':
				this.subagents.get(event.childId)?.event(event.event);
				return;
			case 'subagent.completed':
				this.subagents.get(event.childId)?.end(event.status === 'completed' ? 'done' : event.status === 'cancelled' ? 'abort' : 'fail', event.error);
				return;
			default:
				return;
		}
		this.sink.changed();
	}

	/** The turn is over: its last request ends and gets the turn's tokens. */
	end(reason: 'done' | 'abort' | 'fail', error?: string): void {
		if (this.done) {
			return;
		}
		this.done = true;
		for (const child of this.subagents.values()) {
			child.end(reason, error);
		}
		const now = this.now();
		const last = this.current;
		if (last) {
			last.endedAt ??= now;
			if (reason === 'abort') {
				last.finish ??= 'aborted';
			} else if (reason === 'fail') {
				last.finish = 'error';
				last.error ??= error ?? this.lastError ?? 'The turn failed.';
			} else {
				last.finish ??= 'stop';
			}
			if (this.usage) {
				last.usage = { input: this.usage.input, output: this.usage.output, cache: this.usage.cache, cacheWrite: this.usage.cacheWrite };
				if (this.turn.length > 1) {
					last.usageScope = 'turn';
				}
			}
		}
		// The turn moved on without these results (stopped, or the agent never reported them).
		for (const request of this.turn) {
			closeOpenToolRuns(request, now);
		}
		this.sink.changed();
	}

	/** The request the model is answering in: the current one, or the next once a tool result came back. */
	private answering(now: number): ITrajectoryRequest | undefined {
		const current = this.current;
		if (current && !current.toolRuns.some(run => run.endedAt !== undefined)) {
			current.firstChunkAt ??= now;
			return current;
		}
		// It went out when the results it carries were in.
		const ready = current ? Math.max(current.endedAt ?? current.startedAt, ...current.toolRuns.map(run => run.endedAt ?? 0)) : now;
		const input: INativeLoopMessage[] = current ? [{
			role: 'assistant',
			content: current.response.text,
			...(current.response.toolCalls.length ? { toolCalls: current.response.toolCalls.map(call => ({ id: call.id, name: call.name, args: parseToolInput(call.arguments) })) } : {}),
		}, ...this.results] : [];
		const request = this.open(input, Math.min(ready, now));
		if (request) {
			request.firstChunkAt = now;
		}
		return request;
	}

	private open(messages: INativeLoopMessage[], startedAt: number): ITrajectoryRequest | undefined {
		const request = this.sink.begin({
			sessionId: this.target.sessionId,
			runId: this.target.runId,
			provider: this.target.provider,
			model: this.model,
			...(this.model === this.target.model && this.target.modelLabel ? { modelLabel: this.target.modelLabel } : {}),
			...(this.agent ? { agent: this.agent } : {}),
			harness: this.target.harness,
			system: '',
			messages,
			tools: [],
			startedAt,
		});
		if (!request) {
			// Recording is off.
			this.done = true;
			return undefined;
		}
		this.current = request;
		this.turn.push(request);
		this.results = [];
		this.textId = undefined;
		return request;
	}
}

// --- syncing to a window -------------------------------------------------------------------

/** Changes whenever a recorded request grows (stream chunk, usage, tool result); compared by value. */
export function trajectoryRevision(request: ITrajectoryRequest): string {
	const ended = request.toolRuns.filter(run => run.endedAt !== undefined).length;
	const args = request.response.toolCalls.reduce((sum, call) => sum + call.arguments.length, 0);
	return [
		request.firstChunkAt ?? '', request.endedAt ?? '', request.response.text.length, request.response.reasoning.length, request.response.toolCalls.length, args,
		request.usage ? JSON.stringify(request.usage) : '', request.usageScope ?? '', request.contextTokens ?? '', request.contextWindow ?? '',
		request.costUsd ?? '', request.finish ?? '', request.error ?? '', request.notes.length, request.toolRuns.length, ended,
	].join('|');
}

/** The parts of a request fixed when it went out, sent to a window only the first time. */
type TrajectoryRequestHead = 'system' | 'messages' | 'tools' | 'options';

export type ITrajectoryRequestUpdate = Omit<ITrajectoryRequest, TrajectoryRequestHead> & Partial<Pick<ITrajectoryRequest, TrajectoryRequestHead>>;

/** A chat's requests as a window that already holds some of them needs them. */
export interface ITrajectorySync {
	/** Every request id of the chat, oldest first. */
	readonly ids: readonly string[];
	/** Requests the window did not have, whole, and ones that changed, without their head. */
	readonly requests: readonly ITrajectoryRequestUpdate[];
	readonly revisions: Readonly<Record<string, string>>;
}

/** What a window holding `known` (request id to revision) is missing of `requests`. */
export function syncTrajectory(requests: readonly ITrajectoryRequest[], known: Readonly<Record<string, string>>): ITrajectorySync {
	const revisions: Record<string, string> = {};
	const updates: ITrajectoryRequestUpdate[] = [];
	for (const request of requests) {
		const revision = revisions[request.id] = trajectoryRevision(request);
		if (!Object.prototype.hasOwnProperty.call(known, request.id)) {
			updates.push(request);
		} else if (known[request.id] !== revision) {
			const { system: _system, messages: _messages, tools: _tools, options: _options, ...rest } = request;
			updates.push(rest);
		}
	}
	return { ids: requests.map(request => request.id), requests: updates, revisions };
}

/** `previous` brought up to date with a {@link syncTrajectory} result. */
export function applyTrajectorySync(previous: readonly ITrajectoryRequest[], sync: ITrajectorySync): ITrajectoryRequest[] {
	const byId = new Map(previous.map(request => [request.id, request]));
	for (const update of sync.requests) {
		const old = byId.get(update.id);
		if (old) {
			byId.set(update.id, { ...old, ...update, system: update.system ?? old.system, messages: update.messages ?? old.messages, tools: update.tools ?? old.tools });
		} else if (update.messages && update.tools && update.system !== undefined) {
			byId.set(update.id, update as ITrajectoryRequest);
		}
	}
	return sync.ids.map(id => byId.get(id)).filter((request): request is ITrajectoryRequest => !!request);
}

// --- reading -------------------------------------------------------------------------------

/** Whole prompt the provider counted: uncached input plus cache reads and writes. */
export function promptTokens(usage: TokenUsage | undefined): number | undefined {
	if (!usage) {
		return undefined;
	}
	return usage.used ?? usage.input + (usage.cache ?? 0) + (usage.cacheWrite ?? 0);
}

/** Share of the prompt read from the provider cache, 0..1. */
export function cacheHitRatio(usage: TokenUsage | undefined): number | undefined {
	const prompt = promptTokens(usage);
	if (!usage || !prompt) {
		return undefined;
	}
	return (usage.cache ?? 0) / prompt;
}

export function messageText(message: INativeLoopMessage): string {
	const calls = message.toolCalls?.length
		? message.toolCalls.map(call => `${call.name}(${typeof call.args === 'string' ? call.args : JSON.stringify(call.args)})`).join('\n')
		: '';
	return calls ? (message.content ? `${message.content}\n${calls}` : calls) : message.content;
}

export interface IContextBreakdown {
	readonly system: number;
	readonly tools: number;
	readonly user: number;
	readonly assistant: number;
	readonly toolResults: number;
	readonly images: number;
	readonly total: number;
}

/** Where the prompt's tokens go, estimated the same way compaction does. */
export function contextBreakdown(request: ITrajectoryRequest): IContextBreakdown {
	const system = estimateTokens(request.system);
	const tools = estimateTokens(JSON.stringify(request.tools));
	let user = 0, assistant = 0, toolResults = 0, images = 0;
	for (const message of request.messages) {
		const tokens = estimateTokens(messageText(message));
		images += (message.images?.length ?? 0) * 1_500;
		switch (message.role) {
			case 'user': user += tokens; break;
			case 'assistant': assistant += tokens; break;
			case 'tool': toolResults += tokens; break;
			case 'system': user += tokens; break;
		}
	}
	return { system, tools, user, assistant, toolResults, images, total: system + tools + user + assistant + toolResults + images };
}

export interface IRequestDiff {
	readonly systemChanged: boolean;
	readonly toolsAdded: readonly string[];
	readonly toolsRemoved: readonly string[];
	readonly toolsChanged: readonly string[];
	/** Messages identical to the previous request's, from the start. */
	readonly sharedPrefix: number;
	/** Messages of the previous request that changed or went (compaction, cleared tool results). */
	readonly rewritten: number;
	/** Messages after the shared prefix. */
	readonly added: number;
	/** Why the provider cache could not reuse the previous prefix, when it could not. */
	readonly cacheBreak?: string;
}

function sameMessage(a: INativeLoopMessage, b: INativeLoopMessage): boolean {
	return a.role === b.role && a.content === b.content && a.callId === b.callId
		&& (a.toolCalls?.length ?? 0) === (b.toolCalls?.length ?? 0)
		&& (a.toolCalls ?? []).every((call, i) => call.id === b.toolCalls![i].id)
		&& (a.images?.length ?? 0) === (b.images?.length ?? 0);
}

export function diffRequests(previous: ITrajectoryRequest, next: ITrajectoryRequest): IRequestDiff {
	const systemChanged = previous.system !== next.system;
	const before = new Map(previous.tools.map(tool => [tool.name, tool]));
	const after = new Map(next.tools.map(tool => [tool.name, tool]));
	const toolsAdded = [...after.keys()].filter(name => !before.has(name));
	const toolsRemoved = [...before.keys()].filter(name => !after.has(name));
	const toolsChanged = [...after.keys()].filter(name => {
		const old = before.get(name);
		const now = after.get(name)!;
		return !!old && (old.description !== now.description || JSON.stringify(old.parameters) !== JSON.stringify(now.parameters));
	});
	let sharedPrefix = 0;
	while (sharedPrefix < previous.messages.length && sharedPrefix < next.messages.length && sameMessage(previous.messages[sharedPrefix], next.messages[sharedPrefix])) {
		sharedPrefix++;
	}
	const rewritten = previous.messages.length - sharedPrefix;
	const added = next.messages.length - sharedPrefix;
	const cacheBreak = previous.model !== next.model ? `the model changed (${previous.model} to ${next.model})`
		: systemChanged ? 'the system prompt changed'
			: toolsAdded.length || toolsRemoved.length || toolsChanged.length ? 'the tool list changed'
				: rewritten > 0 ? `${rewritten} earlier message${rewritten === 1 ? '' : 's'} changed (compaction or cleared tool results)`
					: undefined;
	return { systemChanged, toolsAdded, toolsRemoved, toolsChanged, sharedPrefix, rewritten, added, ...(cacheBreak ? { cacheBreak } : {}) };
}

export interface ITrajectorySummary {
	readonly requests: number;
	readonly input: number;
	readonly output: number;
	readonly cache: number;
	readonly cacheWrite: number;
	readonly costUsd?: number;
	readonly modelMs: number;
	readonly toolCalls: number;
	readonly toolErrors: number;
	readonly errors: number;
	readonly retries: number;
}

export function summarize(requests: readonly ITrajectoryRequest[]): ITrajectorySummary {
	let input = 0, output = 0, cache = 0, cacheWrite = 0, cost = 0, hasCost = false, modelMs = 0, toolCalls = 0, toolErrors = 0, errors = 0, retries = 0;
	for (const request of requests) {
		input += request.usage?.input ?? 0;
		output += request.usage?.output ?? 0;
		cache += request.usage?.cache ?? 0;
		cacheWrite += request.usage?.cacheWrite ?? 0;
		if (request.costUsd !== undefined) {
			cost += request.costUsd;
			hasCost = true;
		}
		modelMs += (request.endedAt ?? Date.now()) - request.startedAt;
		toolCalls += request.toolRuns.length;
		toolErrors += request.toolRuns.filter(run => run.isError).length;
		errors += request.error || request.finish === 'error' ? 1 : 0;
		retries += request.notes.filter(note => note.kind === 'retry').length;
	}
	return { requests: requests.length, input, output, cache, cacheWrite, ...(hasCost ? { costUsd: cost } : {}), modelMs, toolCalls, toolErrors, errors, retries };
}

/** One JSON document per request, for pasting into a bug report or an eval. */
export function exportTrajectory(requests: readonly ITrajectoryRequest[]): string {
	return JSON.stringify(requests.map(request => ({
		...request,
		messages: request.messages.map(message => message.images?.length
			? { ...message, images: message.images.map(image => ({ mediaType: image.mediaType, bytes: Math.round(image.data.length * 0.75) })) }
			: message),
	})), undefined, 2);
}
