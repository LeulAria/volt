/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { formatPredictionError, IVoltModelAccess } from '../../common/models/modelAccess.js';
import { IVoltModelOptions, MODEL_OPTION_REASONING, MODEL_PARAM_MAX_OUTPUT } from '../../common/models/modelOptions.js';
import { DEFAULT_PREDICTION_SETTINGS, IComposerPredictionInput, IEditPrediction, IPredictedEdit, IPredictionContext, IPredictionSettings, IVoltPredictionService, VOLT_PREDICTION_SETTINGS_STORAGE_KEY } from '../../common/prediction.js';
import { buildComposerPrompt, cleanComposerCompletion } from '../../common/prediction/composerPredictor.js';
import { meetsConfidence, orderEdits, samePath } from '../../common/prediction/editGraph.js';
import { IParsedEdit, parseMultiEdit } from '../../common/prediction/multiEditParser.js';
import { capLines, dedupeLineEcho, dedupePrefixOverlap, firstLineOnly, partialInsertText, postProcessInline, repliedLineBreakOnly, stripFences, stripSpecialTokens, trimToBlock } from '../../common/prediction/postProcess.js';
import { buildInlinePrompt, buildNextEditPrompt, InlineWriting, inlineWritingKind } from '../../common/prediction/predictionPrompt.js';
import { PredictionCache, predictionCacheKey, typedSince, TypedThroughCache } from '../../common/prediction/predictionCache.js';
import { PredictionStats } from '../../common/prediction/predictionStats.js';
import { IModelMessage } from '../../common/providers.js';
import { IAgentRuntimeService } from '../../common/runtime.js';

/** Hard cap so a runaway stream can never hold the editor hostage. */
const INLINE_TIMEOUT_MS = 10_000;
const NES_TIMEOUT_MS = 15_000;
const AGENT_TAB_TIMEOUT_MS = 30_000;
const ONESHOT_TIMEOUT_MS = 60_000;
/** An agent call costs a whole prompt: wait for the typing to pause, but not long (Claude answers in under a second). */
const AGENT_EXTRA_DEBOUNCE_MS = 100;

/** Ghost text is a statement or a short block; anything longer was going to be cut anyway. */
const INLINE_MAX_OUTPUT_TOKENS = 256;
const NES_MAX_OUTPUT_TOKENS = 2_048;
/** The composer predicts the rest of a sentence: a handful of words. */
const COMPOSER_MAX_OUTPUT_TOKENS = 48;
const COMPOSER_TIMEOUT_MS = 8_000;

/** Reasoning levels from cheapest; a Tab request takes the first one the model offers. */
const CHEAPEST_REASONING = ['off', 'none', 'minimal', 'low'];

/** A failing provider is asked again after 1s, 2s, 4s ... up to this. */
const MAX_BACKOFF_MS = 60_000;

/** One inline request in progress, kept alive across keystrokes that type into its answer. */
interface IInlineFlight {
	readonly uri: string;
	readonly modelRef: string;
	/** Text before the cursor when it started. */
	readonly prefix: string;
	readonly suffix: string;
	readonly linePrefix: string;
	readonly writing: InlineWriting;
	readonly cts: CancellationTokenSource;
	readonly result: Promise<string | undefined>;
	/** The first whole lines of the answer as soon as they stream in; else the whole answer. */
	readonly first: Promise<string | undefined>;
	/**
	 * Written while the request runs (made before it starts: with no pause, the request goes out
	 * before the flight object exists).
	 */
	readonly progress: IFlightProgress;
}

interface IFlightProgress {
	/** The request went out; until then a newer keystroke replaces it at no cost. */
	sent: boolean;
	/** The reply so far, as it streams. */
	partial: string;
}

export class VoltPredictionService extends Disposable implements IVoltPredictionService {

	declare readonly _serviceBrand: undefined;

	private settings: IPredictionSettings;
	private readonly inlineCache = new PredictionCache<string>(64);
	private readonly typedThrough = new TypedThroughCache(8);
	private inlineFlight: IInlineFlight | undefined;
	private readonly composerCache = new PredictionCache<string>(64);
	private readonly composerTyped = new TypedThroughCache(8);
	private composerFlight: IInlineFlight | undefined;
	/**
	 * Calls so far, per lane. Callers wait without the editor's cancellation, so when a reused request
	 * answers, only the newest waiting call may start the next one.
	 */
	private inlineCalls = 0;
	private composerCalls = 0;
	private structuredInFlight: CancellationTokenSource | undefined;
	private lastFailure: string | undefined;
	/** Failed requests in a row, and when the provider may be asked again. */
	private failures = 0;
	private retryAt = 0;

	readonly stats = new PredictionStats();

	private readonly _onDidChangeSettings = this._register(new Emitter<void>());
	readonly onDidChangeSettings: Event<void> = this._onDidChangeSettings.event;

	private readonly _onDidExtendInline = this._register(new Emitter<URI>());
	readonly onDidExtendInline: Event<URI> = this._onDidExtendInline.event;

	constructor(
		@IAgentRuntimeService private readonly modelAccess: IVoltModelAccess & IAgentRuntimeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.settings = this.loadSettings();
	}

	getSettings(): IPredictionSettings {
		return { ...this.settings };
	}

	resolveTabModelRef(): string | undefined {
		return this.modelAccess.resolveTabModelRef();
	}

	consumeLastFailure(): string | undefined {
		const message = this.lastFailure;
		this.lastFailure = undefined;
		return message;
	}

	updateSettings(update: Partial<IPredictionSettings>): void {
		this.settings = { ...this.settings, ...update };
		this.storageService.store(VOLT_PREDICTION_SETTINGS_STORAGE_KEY, JSON.stringify(this.settings), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangeSettings.fire();
	}

	private loadSettings(): IPredictionSettings {
		try {
			const raw = this.storageService.get(VOLT_PREDICTION_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
			return raw ? { ...DEFAULT_PREDICTION_SETTINGS, ...JSON.parse(raw) as Partial<IPredictionSettings> } : { ...DEFAULT_PREDICTION_SETTINGS };
		} catch {
			return { ...DEFAULT_PREDICTION_SETTINGS };
		}
	}

	// --- inline (ghost text) -------------------------------------------------------------------

	/**
	 * Answers in this order, cheapest first:
	 *   1. the user is typing through a suggestion already made: the rest of it, no model call;
	 *   2. the same spot was answered before;
	 *   3. a request for an earlier spot on the way here is still running: wait for it rather than
	 *      cancel it (core cancels on every keystroke; restarting would never let a slow model answer),
	 *      unless it is still waiting out its pause (replaced, for free) or what it has streamed so
	 *      far already disagrees with the typing (stopped, so no more of it is paid for);
	 *   4. a new request, shown as soon as its first whole lines stream in.
	 */
	async predictInline(ctx: IPredictionContext, token: CancellationToken): Promise<IEditPrediction | undefined> {
		const modelRef = this.modelAccess.resolveTabModelRef();
		if (!modelRef) {
			this.logService.trace('[volt prediction] nothing selected in the composer for Tab');
			return undefined;
		}
		const uri = ctx.uri.toString();

		const call = ++this.inlineCalls;
		const known = this.peekInline(ctx);
		if (known) {
			return known;
		}
		const cacheKey = predictionCacheKey(modelRef, uri, ctx.prefix, ctx.suffix);
		if (this.inlineCache.get(cacheKey) !== undefined) {
			// Asked here before, and the answer was nothing.
			return undefined;
		}
		if (this.backingOff()) {
			return undefined;
		}

		const flight = this.inlineFlight;
		const typed = flight && flight.modelRef === modelRef && flight.uri === uri && flight.suffix.slice(0, 64) === ctx.suffix.slice(0, 64)
			? typedSince(ctx.prefix, flight.prefix.slice(-200), 400)
			: undefined;
		if (flight && typed !== undefined) {
			if (!flight.progress.sent) {
				// Still waiting out its pause: this keystroke's own request takes its place.
				this.stats.bump('replaced');
			} else if (this.diverged(flight, typed)) {
				// What has streamed in disagrees with the typing: stop paying for the rest of it.
				flight.cts.cancel();
				this.stats.bump('aborted');
			} else {
				// The first lines may already cover the typing; else the whole answer may.
				for (const answer of [flight.first, flight.result]) {
					await raceCancellation(answer, token);
					if (token.isCancellationRequested) {
						return undefined;
					}
					const rest = this.typedThrough.lookup(uri, ctx.prefix, ctx.suffix);
					if (rest !== undefined) {
						return this.inlineResult(ctx, rest);
					}
				}
				// That request was for this very spot and found nothing, or the provider is failing:
				// asking again right away would only repeat it. A newer keystroke asks for its own spot.
				if (this.inlineCache.get(cacheKey) !== undefined || this.lastFailure || call !== this.inlineCalls || this.backingOff()) {
					return undefined;
				}
			}
		}

		const next = this.startInlineFlight(modelRef, ctx, cacheKey);
		const completion = await raceCancellation(next.first, token);
		if (token.isCancellationRequested || !completion) {
			return undefined;
		}
		return this.inlineResult(ctx, completion);
	}

	/**
	 * The typing since `flight` started no longer agrees with what its reply has streamed so far,
	 * so its answer can never serve the cursor. Code only: writing replies are respaced later.
	 */
	private diverged(flight: IInlineFlight, typed: string): boolean {
		if (!typed || !flight.progress.partial || flight.writing !== 'code') {
			return false;
		}
		const sofar = partialInsertText(flight.progress.partial, flight.prefix, flight.linePrefix);
		if (!sofar) {
			return false;
		}
		const n = Math.min(sofar.length, typed.length);
		return sofar.slice(0, n) !== typed.slice(0, n);
	}

	peekInline(ctx: IPredictionContext): IEditPrediction | undefined {
		const modelRef = this.modelAccess.resolveTabModelRef();
		if (!modelRef) {
			return undefined;
		}
		const uri = ctx.uri.toString();
		const typed = this.typedThrough.lookup(uri, ctx.prefix, ctx.suffix);
		if (typed !== undefined) {
			return this.inlineResult(ctx, typed);
		}
		const cached = this.inlineCache.get(predictionCacheKey(modelRef, uri, ctx.prefix, ctx.suffix));
		return cached ? this.inlineResult(ctx, cached) : undefined;
	}

	prefetchInline(ctx: IPredictionContext): void {
		const modelRef = this.modelAccess.resolveTabModelRef();
		if (!modelRef || this.inlineFlight || this.peekInline(ctx) || Date.now() < this.retryAt) {
			return;
		}
		const cacheKey = predictionCacheKey(modelRef, ctx.uri.toString(), ctx.prefix, ctx.suffix);
		if (this.inlineCache.get(cacheKey) === undefined) {
			this.startInlineFlight(modelRef, ctx, cacheKey);
		}
	}

	private startInlineFlight(modelRef: string, ctx: IPredictionContext, cacheKey: string): IInlineFlight {
		this.inlineFlight?.cts.dispose(true);
		const cts = new CancellationTokenSource();
		const uri = ctx.uri.toString();
		const agent = modelRef.startsWith('agent:');
		const writing = inlineWritingKind(ctx.languageId, ctx.linePrefix);
		// The first whole lines of a code reply are shown while the rest streams in.
		let early: string | undefined;
		let showFirst: (text: string | undefined) => void = () => { };
		const first = new Promise<string | undefined>(resolve => showFirst = resolve);
		const progress: IFlightProgress = { sent: false, partial: '' };
		const ask = (at: IPredictionContext, extraDebounceMs: number) => this.request(modelRef, buildInlinePrompt(at, writing), {
			timeoutMs: agent ? AGENT_TAB_TIMEOUT_MS : INLINE_TIMEOUT_MS,
			extraDebounceMs,
			options: this.tabOptions(modelRef, INLINE_MAX_OUTPUT_TOKENS),
			// Stop reading once the reply has run past the block (or sentence, or line) it completes.
			enough: text => inlineReplyIsComplete(text, at.prefix, at.linePrefix, writing, at.lineSuffix),
			onSent: () => progress.sent = true,
			onText: text => {
				progress.partial = text;
				if (early === undefined && writing === 'code' && at === ctx) {
					early = earlyLines(text, ctx);
					if (early !== undefined) {
						this.typedThrough.remember(uri, ctx.prefix, ctx.suffix, early);
						showFirst(early);
					}
				}
			},
		}, cts.token);
		const result = (async () => {
			let raw = await ask(ctx, (agent ? AGENT_EXTRA_DEBOUNCE_MS : 0) + (ctx.delayMs ?? 0));
			if (raw === undefined) {
				if (early !== undefined) {
					// Shown, then cut off: what was shown stays known for this spot.
					this.inlineCache.set(cacheKey, early);
				}
				return early;
			}
			if (writing === 'code') {
				// A reply stopped after its first line may have the start of the next one: not used.
				raw = firstLineOnly(raw, ctx.prefix, ctx.linePrefix, ctx.lineSuffix) ?? raw;
			}
			let completion = postProcessInline({ raw, linePrefix: ctx.linePrefix, lineSuffix: ctx.lineSuffix, prefix: ctx.prefix, suffix: ctx.suffix, writing }) ?? '';
			if (!completion && writing === 'prose' && ctx.linePrefix.trim() && !ctx.lineSuffix.trim() && repliedLineBreakOnly(raw)) {
				// "This line is finished" and nothing more: ask for the next line itself (Tab, Tab, Tab down a list).
				const next: IPredictionContext = { ...ctx, prefix: `${ctx.prefix}\n`, linePrefix: '' };
				const nextRaw = await ask(next, 0);
				const line = nextRaw === undefined ? undefined : postProcessInline({ raw: nextRaw, linePrefix: '', lineSuffix: ctx.lineSuffix, prefix: next.prefix, suffix: ctx.suffix, writing });
				completion = line && !line.startsWith('\n') ? `\n${line}` : '';
			}
			// Cache negatives too - retrying the same position would give the same nothing.
			this.inlineCache.set(cacheKey, completion);
			if (completion || early !== undefined) {
				// Replaces the early lines (an empty answer withdraws them).
				this.typedThrough.remember(uri, ctx.prefix, ctx.suffix, completion);
			}
			if (early !== undefined && completion !== early) {
				this._onDidExtendInline.fire(ctx.uri);
			}
			return completion || undefined;
		})().finally(() => {
			if (this.inlineFlight === flight) {
				this.inlineFlight = undefined;
			}
			cts.dispose();
		});
		void result.then(showFirst, () => showFirst(undefined));
		const flight: IInlineFlight = { uri, modelRef, prefix: ctx.prefix, suffix: ctx.suffix, linePrefix: ctx.linePrefix, writing, cts, result, first, progress };
		this.inlineFlight = flight;
		return flight;
	}

	private inlineResult(ctx: IPredictionContext, completion: string): IEditPrediction {
		const line = ctx.prefix.split('\n').length; // line within the excerpt is irrelevant; provider re-anchors at the live cursor
		return {
			kind: 'inline',
			confidence: 0.5,
			primary: {
				uri: ctx.uri,
				// Collapsed range at the cursor; the editor provider substitutes the live position.
				range: new Range(line, 1, line, 1),
				replacement: completion,
			},
			next: [],
		};
	}

	// --- composer (natural language) -------------------------------------------------------------

	peekComposer(input: IComposerPredictionInput): string | undefined {
		const modelRef = this.modelAccess.resolveTabModelRef();
		if (!modelRef) {
			return undefined;
		}
		const uri = input.uri.toString();
		const typed = this.composerTyped.lookup(uri, input.draft, input.after);
		if (typed !== undefined) {
			return typed;
		}
		return this.composerCache.get(predictionCacheKey(modelRef, uri, input.draft, input.after)) || undefined;
	}

	/** Same ladder as {@link predictInline}: typed-through, cached, a running request reused, then a new one. */
	async predictComposer(input: IComposerPredictionInput, token: CancellationToken): Promise<string | undefined> {
		const modelRef = this.modelAccess.resolveTabModelRef();
		if (!modelRef) {
			return undefined;
		}
		const call = ++this.composerCalls;
		const known = this.peekComposer(input);
		if (known) {
			return known;
		}
		const uri = input.uri.toString();
		const cacheKey = predictionCacheKey(modelRef, uri, input.draft, input.after);
		if (this.composerCache.get(cacheKey) !== undefined || this.backingOff()) {
			return undefined;
		}
		const flight = this.composerFlight;
		if (flight && flight.modelRef === modelRef && flight.uri === uri && flight.suffix === input.after
			&& typedSince(input.draft, flight.prefix.slice(-200), 200) !== undefined) {
			await raceCancellation(flight.result, token);
			if (token.isCancellationRequested) {
				return undefined;
			}
			const rest = this.peekComposer(input);
			if (rest || this.composerCache.get(cacheKey) !== undefined || this.lastFailure || call !== this.composerCalls || this.backingOff()) {
				return rest;
			}
		}
		const next = this.startComposerFlight(modelRef, input, cacheKey);
		const text = await raceCancellation(next.result, token);
		return token.isCancellationRequested ? undefined : text;
	}

	private startComposerFlight(modelRef: string, input: IComposerPredictionInput, cacheKey: string): IInlineFlight {
		this.composerFlight?.cts.dispose(true);
		const cts = new CancellationTokenSource();
		const uri = input.uri.toString();
		const agent = modelRef.startsWith('agent:');
		const progress: IFlightProgress = { sent: false, partial: '' };
		const result = (async () => {
			const raw = await this.request(modelRef, buildComposerPrompt(input), {
				timeoutMs: agent ? AGENT_TAB_TIMEOUT_MS : COMPOSER_TIMEOUT_MS,
				extraDebounceMs: 0,
				options: this.tabOptions(modelRef, COMPOSER_MAX_OUTPUT_TOKENS),
				// One sentence or one line is the whole answer.
				enough: text => text.includes('</insert>') || (/\S/.test(text) && (/\S[^\S\n]*\n/.test(text) || /[.!?]\s/.test(text))),
				onSent: () => progress.sent = true,
				onText: text => progress.partial = text,
			}, cts.token);
			if (raw === undefined) {
				return undefined;
			}
			const completion = cleanComposerCompletion(raw, input.draft, input.vocabulary) ?? '';
			this.composerCache.set(cacheKey, completion);
			if (completion) {
				this.composerTyped.remember(uri, input.draft, input.after, completion);
			}
			return completion || undefined;
		})().finally(() => {
			if (this.composerFlight === flight) {
				this.composerFlight = undefined;
			}
			cts.dispose();
		});
		const flight: IInlineFlight = { uri, modelRef, prefix: input.draft, suffix: input.after, linePrefix: '', writing: 'prose', cts, result, first: result, progress };
		this.composerFlight = flight;
		return flight;
	}

	// --- next-edit / multi-edit ---------------------------------------------------------------

	async predictNextEdit(ctx: IPredictionContext, token: CancellationToken): Promise<IEditPrediction | undefined> {
		return this.structuredPrediction(ctx, undefined, NES_TIMEOUT_MS, token);
	}

	async predictMultiEdit(ctx: IPredictionContext, intent: string, token: CancellationToken): Promise<IEditPrediction | undefined> {
		return this.structuredPrediction(ctx, intent, ONESHOT_TIMEOUT_MS, token);
	}

	private async structuredPrediction(ctx: IPredictionContext, intent: string | undefined, timeoutMs: number, token: CancellationToken): Promise<IEditPrediction | undefined> {
		const modelRef = this.modelAccess.resolveTabModelRef();
		if (!modelRef) {
			return undefined;
		}
		// Structured requests have their own lane: they never cancel the ghost text in flight.
		this.structuredInFlight?.dispose(true);
		const cts = new CancellationTokenSource(token);
		this.structuredInFlight = cts;
		let raw: string | undefined;
		try {
			raw = await this.request(modelRef, buildNextEditPrompt(ctx, intent), {
				timeoutMs: modelRef.startsWith('agent:') ? Math.max(timeoutMs, AGENT_TAB_TIMEOUT_MS) : timeoutMs,
				extraDebounceMs: 0,
				options: this.tabOptions(modelRef, NES_MAX_OUTPUT_TOKENS),
			}, cts.token);
		} finally {
			if (this.structuredInFlight === cts) {
				this.structuredInFlight = undefined;
			}
			cts.dispose();
		}
		if (raw === undefined) {
			return undefined;
		}
		const parsed = parseMultiEdit(raw);
		if (!parsed || !parsed.edits.length || !meetsConfidence(parsed.confidence)) {
			if (!parsed) {
				this.logService.trace('[volt prediction] structured response was not valid JSON');
			}
			return undefined;
		}
		const currentPath = ctx.uri.path;
		const { local, remote } = orderEdits(parsed.edits, currentPath);
		const ordered = [...local, ...remote];
		const primary = ordered[0];
		if (!primary) {
			return undefined;
		}
		return {
			kind: remote.length ? 'multi' : 'edit',
			confidence: parsed.confidence,
			primary: this.toPredictedEdit(primary, ctx.uri),
			next: ordered.slice(1).map(edit => this.toPredictedEdit(edit, ctx.uri)),
		};
	}

	private toPredictedEdit(edit: IParsedEdit, currentUri: URI): IPredictedEdit {
		return {
			uri: this.resolvePath(edit.path, currentUri),
			// Text-anchored edits get their range when they are placed in the live file.
			range: edit.find !== undefined
				? new Range(1, 1, 1, 1)
				: new Range(edit.startLineNumber, edit.startColumn, edit.endLineNumber, edit.endColumn),
			replacement: edit.replacement,
			...(edit.find !== undefined ? { find: edit.find } : {}),
			reason: edit.reason,
		};
	}

	/** Maps a model-returned path to a workspace URI; current file matches stay on its URI. */
	private resolvePath(path: string, currentUri: URI): URI {
		if (samePath(path, currentUri.path)) {
			return currentUri;
		}
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return currentUri.with({ path });
		}
		const relative = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
		return URI.joinPath(folder.uri, relative);
	}

	// --- model round-trip ----------------------------------------------------------------------

	/**
	 * Options for a Tab request: the cheapest reasoning level the model takes and an output cap.
	 * Agent CLIs pick their own and get nothing.
	 */
	private tabOptions(modelRef: string, maxOutputTokens: number): IVoltModelOptions | undefined {
		const item = this.modelAccess.resolveCatalogItem(modelRef);
		if (!item || item.kind !== 'model') {
			return undefined;
		}
		const options: IVoltModelOptions = { [MODEL_PARAM_MAX_OUTPUT]: String(maxOutputTokens) };
		const levels = item.optionDescriptors?.find(descriptor => descriptor.id === MODEL_OPTION_REASONING)?.options?.map(option => option.value) ?? [];
		const cheapest = CHEAPEST_REASONING.find(level => levels.includes(level));
		if (cheapest) {
			options[MODEL_OPTION_REASONING] = cheapest;
		}
		return options;
	}

	/** True while a failing provider is left alone (counted as a request not made). */
	private backingOff(): boolean {
		if (Date.now() >= this.retryAt) {
			return false;
		}
		this.stats.bump('backoff');
		return true;
	}

	private noteFailure(message: string): void {
		this.lastFailure = message;
		this.failures++;
		this.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (this.failures - 1));
	}

	/**
	 * One stateless call: race a timeout, collect text deltas, stop early once `enough` says so.
	 * Returns undefined on cancellation (the caller shows nothing). `onSent` runs once the pause is
	 * over and the request leaves; `onText` with the reply so far, on each delta.
	 */
	private async request(modelRef: string, messages: IModelMessage[], opts: { timeoutMs: number; extraDebounceMs: number; options: IVoltModelOptions | undefined; enough?: (text: string) => boolean; onSent?: () => void; onText?: (text: string) => void }, token: CancellationToken): Promise<string | undefined> {
		const cts = new CancellationTokenSource(token);
		const debounce = this.settings.debounceMs + opts.extraDebounceMs;
		if (debounce > 0) {
			try {
				await timeout(debounce, cts.token);
			} catch {
				cts.dispose();
				return undefined; // cancelled while debouncing
			}
		}
		if (cts.token.isCancellationRequested) {
			cts.dispose();
			return undefined;
		}

		opts.onSent?.();
		this.stats.bump('requests');
		this.stats.bump('promptChars', messages.reduce((sum, message) => sum + message.content.length, 0));
		const started = Date.now();
		let firstAt = 0;
		const kill = setTimeout(() => cts.cancel(), opts.timeoutMs);
		let text = '';
		let stoppedEarly = false;
		try {
			for await (const event of this.modelAccess.streamModel(modelRef, messages, opts.options, cts.token)) {
				if (cts.token.isCancellationRequested) {
					return undefined;
				}
				if (event.type === 'text.delta' && event.delta) {
					firstAt ||= Date.now();
					text += event.delta;
					opts.onText?.(text);
					if (opts.enough?.(text)) {
						stoppedEarly = true;
						break;
					}
				} else if (event.type === 'error') {
					this.noteFailure(formatPredictionError(event.message));
					this.logService.warn(`[volt prediction] provider error: ${this.lastFailure}`);
					return undefined;
				}
			}
			if (cts.token.isCancellationRequested && !stoppedEarly) {
				return undefined;
			}
			this.failures = 0;
			this.retryAt = 0;
			this.stats.bump('replyChars', text.length);
			if (firstAt) {
				this.stats.answeredIn(firstAt - started);
			}
			this.logService.trace(`[volt prediction] ${modelRef} answered in ${Date.now() - started}ms, first text after ${firstAt ? firstAt - started : '-'}ms (${text.length} chars${stoppedEarly ? ', cut short' : ''})`);
			return text;
		} catch (err) {
			if (stoppedEarly) {
				return text;
			}
			if (err instanceof CancellationError || cts.token.isCancellationRequested) {
				return undefined;
			}
			this.noteFailure(formatPredictionError(err));
			this.logService.warn(`[volt prediction] request failed: ${this.lastFailure}`);
			return undefined;
		} finally {
			clearTimeout(kill);
			if (stoppedEarly) {
				// The rest of the reply is not needed: stop the provider streaming it.
				cts.cancel();
			}
			cts.dispose();
		}
	}

	override dispose(): void {
		this.inlineFlight?.cts.dispose(true);
		this.composerFlight?.cts.dispose(true);
		this.structuredInFlight?.dispose(true);
		super.dispose();
	}
}

/**
 * True once a streamed ghost-text reply has gone past the block the cursor is in, or past the
 * line cap: what is left would be cut by post-processing anyway. Writing and comments end with
 * their line.
 */
export function inlineReplyIsComplete(raw: string, prefix: string, linePrefix: string, writing: InlineWriting = 'code', lineSuffix = ''): boolean {
	if (/<\|(?:endoftext|end_of_text|file_separator|im_end|eot_id|end)\|>|<EOT>|<\/s>/.test(raw)) {
		return true;
	}
	if (writing === 'code') {
		if (raw.includes('</insert>')) {
			// The insert is closed: that is the whole answer.
			return true;
		}
		if (firstLineOnly(raw, prefix, linePrefix, lineSuffix) !== undefined) {
			// Only the cursor's line can be used, and it is complete.
			return true;
		}
		raw = raw.replace(/^\s*<insert>/, '');
	}
	// Only whole lines count: the last one may still be streaming.
	const newline = raw.lastIndexOf('\n');
	if (newline < 0) {
		return false;
	}
	const whole = raw.slice(0, newline);
	if (writing !== 'code') {
		// Writing is one line: done once a line with text has ended, or the insert is closed.
		const text = stripSpecialTokens(whole).replace(/^\s*<insert>/, '').replace(/^\n+/, '');
		return whole.includes('</insert>') || /\S/.test(text.split('\n')[0]);
	}
	if (/^\s*```[^\n]*\n[\s\S]*\n```\s*$/.test(whole)) {
		// A closed fence: the code inside is the whole answer.
		return true;
	}
	// The same steps post-processing takes before cutting at the block, so an echo of the lines
	// above the cursor is not mistaken for the end of the block.
	let text = stripSpecialTokens(stripFences(whole));
	if (linePrefix.trim()) {
		text = text.replace(/^\n+/, '');
	}
	text = dedupePrefixOverlap(dedupeLineEcho(text, prefix, linePrefix), linePrefix);
	return capLines(text) !== text || trimToBlock(text, linePrefix) !== text;
}

/**
 * The whole lines a streaming code reply has so far, cleaned like the finished reply, when there
 * are some and the reply is still open. Undefined while the lines may be an echo of the code above
 * the cursor (dropped later; showing them would flash the wrong text).
 */
function earlyLines(raw: string, ctx: IPredictionContext): string | undefined {
	const reply = stripSpecialTokens(raw.replace(/\r\n/g, '\n'));
	const cut = reply.lastIndexOf('\n');
	// Tagged and still open: an untagged reply may be a preamble or a fence so far.
	if (cut < 0 || !/^\s*<insert>/.test(reply) || reply.includes('</insert>') || /<insert>\s*```/.test(reply)) {
		return undefined;
	}
	const text = postProcessInline({ raw: reply.slice(0, cut), linePrefix: ctx.linePrefix, lineSuffix: ctx.lineSuffix, prefix: ctx.prefix, suffix: ctx.suffix, writing: 'code' });
	const head = text?.split('\n').find(line => line.trim())?.trim();
	if (!text || !head || ctx.prefix.split('\n').slice(-7, -1).some(line => line.trim() === head)) {
		return undefined;
	}
	return text;
}

registerSingleton(IVoltPredictionService, VoltPredictionService, InstantiationType.Delayed);
