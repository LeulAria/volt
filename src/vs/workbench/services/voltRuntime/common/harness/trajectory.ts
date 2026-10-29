/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { StreamChunk, TokenUsage } from '../deepseek/protocol.js';
import { IToolCall, IToolResult, IToolSchema } from '../tools/tool.js';
import { estimateTokens } from './contextEngine.js';
import { INativeLoopMessage } from './nativeLoop.js';

/**
 * The API trajectory of a native run: every model request as it went on the wire (system prompt,
 * messages, tool schemas, options) and what came back (reasoning, text, tool calls, usage, finish),
 * with timings, plus the tool calls each answer started. The Trajectory panel reads these; nothing
 * here is sent anywhere. Messages are shallow copies, so their strings are shared with the transcript.
 */

export interface ITrajectoryToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
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
	readonly args: unknown;
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
	readonly system: string;
	readonly messages: readonly INativeLoopMessage[];
	readonly tools: readonly IToolSchema[];
	readonly options?: unknown;
	readonly maxOutputTokens?: number;
}

export function newTrajectoryRequest(input: ITrajectoryRequestInput, now = Date.now()): ITrajectoryRequest {
	return {
		...input,
		messages: input.messages.map(message => ({ ...message })),
		startedAt: now,
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
	run.result = result.text.length > RESULT_CHARS ? `${result.text.slice(0, RESULT_CHARS)}\n\n[${result.text.length - RESULT_CHARS} more characters]` : result.text;
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
