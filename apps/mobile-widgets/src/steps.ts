/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EditsEntryLike, IRuntimeEnvelopeLike, RuntimeEventLike } from './serverShapes.ts';

// The live step of a turn, the way the agent window's status line words it
// (agentSessionController.ts `apply`/`settleCall`): "Thinking", "Running npm", the tool's title,
// "Planning"... folded from runtime events. The app folds the `runtime.event` topic with it while
// it is open; the agent server folds the same events when it pushes Live Activity updates.

export interface IStepState {
	/** The phrase now. */
	readonly step: string;
	/** Calls still running, oldest first: when one ends the line falls back to the newest. */
	readonly running: readonly { readonly callId: string; readonly label: string }[];
	/** A notice or compaction holds the line until the next call starts. */
	readonly pinned: boolean;
	/** Paths this turn changed. */
	readonly files: readonly string[];
	/** Tool calls this turn. */
	readonly calls: number;
}

export const THINKING = 'Thinking';

export function emptyStepState(): IStepState {
	return { step: THINKING, running: [], pinned: false, files: [], calls: 0 };
}

const MAX_STEP = 64;

/** `npm` from `npm run test -- --watch`, `node` from `/usr/local/bin/node x.js` (agentBlocks.ts firstCommandName). */
export function firstCommandName(command: string): string {
	const stripped = command.replace(/^\s*[$#>]\s+/, '');
	const tokens = stripped.match(/"[^"]*"|'[^']*'|[^\s;|&]+/g) ?? [];
	const word = tokens.find(part => part && !part.startsWith('-') && (/^["']/.test(part) || !part.includes('='))) ?? '';
	const program = word.replace(/^(["'])([\s\S]*)\1$/, '$2');
	const app = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(program);
	if (app) {
		return app[1];
	}
	if (program.startsWith('/') || program.startsWith('~/')) {
		return program.slice(program.lastIndexOf('/') + 1);
	}
	return program.replace(/^\.\//, '');
}

/**
 * A step short enough for the Lock Screen: absolute paths become file names, whitespace collapses,
 * long text ends in an ellipsis.
 */
export function compactStep(text: string, max = MAX_STEP): string {
	const collapsed = text
		.replace(/(?:~|\/[^\s/]+)(?:\/[^\s/]+)+\/([^\s/]+)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

export function pathOf(uri: { readonly path?: string; readonly fsPath?: string } | string | undefined): string | undefined {
	if (!uri) {
		return undefined;
	}
	if (typeof uri === 'string') {
		return uri.replace(/^file:\/\//, '') || undefined;
	}
	return uri.fsPath || uri.path || undefined;
}

function withFile(state: IStepState, path: string | undefined): readonly string[] {
	return path && !state.files.includes(path) ? [...state.files, path] : state.files;
}

function toolLabel(event: Extract<RuntimeEventLike, { type: 'tool.start' }>): string {
	if (event.card === 'terminal') {
		const ran = firstCommandName(event.title || event.input || '');
		return ran ? `Running ${ran}` : 'Running command';
	}
	return event.title || event.name;
}

/** Folds one runtime event into a turn's step state. Pure; returns the same object when nothing changed. */
export function foldStep(state: IStepState, event: RuntimeEventLike): IStepState {
	switch (event.type) {
		case 'run.start':
			return emptyStepState();
		case 'tool.start': {
			const e = event as Extract<RuntimeEventLike, { type: 'tool.start' }>;
			const label = compactStep(toolLabel(e));
			const diffPath = e.card === 'diff' ? (e.diffs?.[0]?.path || e.locations?.[0]?.path) : undefined;
			return {
				step: label,
				running: [...state.running.filter(call => call.callId !== e.callId), { callId: e.callId, label }],
				pinned: false,
				files: withFile(state, diffPath),
				calls: state.calls + (state.running.some(call => call.callId === e.callId) ? 0 : 1),
			};
		}
		case 'tool.update': {
			const e = event as Extract<RuntimeEventLike, { type: 'tool.update' }>;
			if (!e.title || !state.running.some(call => call.callId === e.callId)) {
				return state;
			}
			const label = compactStep(e.title);
			const running = state.running.map(call => call.callId === e.callId ? { callId: call.callId, label } : call);
			const newest = running.at(-1)?.callId === e.callId;
			return { ...state, running, step: newest && !state.pinned ? label : state.step };
		}
		case 'tool.end': {
			const e = event as Extract<RuntimeEventLike, { type: 'tool.end' }>;
			if (!state.running.some(call => call.callId === e.callId)) {
				return state;
			}
			const running = state.running.filter(call => call.callId !== e.callId);
			return { ...state, running, step: state.pinned ? state.step : (running.at(-1)?.label ?? THINKING) };
		}
		case 'file.change': {
			const e = event as Extract<RuntimeEventLike, { type: 'file.change' }>;
			const files = withFile(state, pathOf(e.uri));
			return files === state.files ? state : { ...state, files };
		}
		case 'lifecycle': {
			const phase = (event as Extract<RuntimeEventLike, { type: 'lifecycle' }>).phase;
			const step = phase === 'planning' ? 'Planning' : phase === 'verifying' ? 'Verifying' : phase === 'waiting' || phase === 'paused' ? 'Waiting' : undefined;
			return step ? { ...state, step } : state;
		}
		case 'clarify':
			return { ...state, step: 'Needs a decision' };
		case 'decision':
			return { ...state, step: compactStep((event as Extract<RuntimeEventLike, { type: 'decision' }>).title) };
		case 'notice':
			return { ...state, step: compactStep((event as Extract<RuntimeEventLike, { type: 'notice' }>).title), pinned: true };
		case 'context.compaction': {
			const e = event as Extract<RuntimeEventLike, { type: 'context.compaction' }>;
			if (e.status === 'running' || e.status === undefined) {
				return { ...state, step: e.trigger === 'auto' ? 'Compacting context automatically' : 'Compacting context', pinned: true };
			}
			return { ...state, step: state.running.at(-1)?.label ?? THINKING, pinned: false };
		}
		case 'question.ask':
			return { ...state, step: 'Waiting for your answer' };
		case 'access.ask':
			return { ...state, step: 'Waiting for approval' };
		case 'reasoning.start':
		case 'text.start':
			return state.running.length || state.pinned || state.step === THINKING ? state : { ...state, step: THINKING };
		default:
			return state;
	}
}

/** Step state per chat, fed by runtime envelopes. Subagent events stay with their own chat. */
export class StepTracker {

	private readonly states = new Map<string, IStepState>();

	/** Applies an envelope; returns true when the chat's state changed. */
	apply(envelope: IRuntimeEnvelopeLike): boolean {
		const before = this.states.get(envelope.sessionId) ?? emptyStepState();
		const after = foldStep(before, envelope.event);
		if (after === before && this.states.has(envelope.sessionId)) {
			return false;
		}
		this.states.set(envelope.sessionId, after);
		return after !== before;
	}

	get(chatId: string): IStepState | undefined {
		return this.states.get(chatId);
	}

	forget(chatId: string): void {
		this.states.delete(chatId);
	}
}

/**
 * Files changed in each chat's current turn, from the `edits` collection: the server journals
 * every agent edit (`file`, `baseline`, `binary`) and a `finished` mark when a run ends. Entries
 * are keyed by zero-padded ids, so key order is time order. A desktop window acks (deletes)
 * entries it applied, so files are remembered as they arrive rather than recounted.
 */
export class EditsFileCounter {

	private readonly files = new Map<string, Set<string>>();
	/** Chats whose last run finished: the count stays (the ended activity shows it) until the next edit. */
	private readonly closed = new Set<string>();
	private readonly seen = new Set<string>();

	/** Feeds entries (key → entry), in any order; only unseen keys count. Returns chats that changed. */
	add(entries: Iterable<readonly [string, EditsEntryLike]>): Set<string> {
		const changed = new Set<string>();
		const sorted = [...entries].filter(([key]) => !this.seen.has(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
		for (const [key, entry] of sorted) {
			this.seen.add(key);
			if (entry.kind === 'finished') {
				this.closed.add(entry.sessionId);
				continue;
			}
			const path = pathOf(entry.uri);
			if (!path) {
				continue;
			}
			let set = this.files.get(entry.sessionId);
			const afterFinish = this.closed.delete(entry.sessionId);
			if (!set || afterFinish) {
				set = new Set();
				this.files.set(entry.sessionId, set);
			}
			if (!set.has(path)) {
				set.add(path);
				changed.add(entry.sessionId);
			}
		}
		return changed;
	}

	count(chatId: string): number {
		return this.files.get(chatId)?.size ?? 0;
	}

	/** A new turn starts counting from zero. */
	reset(chatId: string): void {
		this.files.delete(chatId);
		this.closed.delete(chatId);
	}
}
