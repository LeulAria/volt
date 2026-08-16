/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
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
import { formatPredictionError, IVoltModelAccess } from '../../common/modelAccess.js';
import { DEFAULT_PREDICTION_SETTINGS, IEditPrediction, IPredictedEdit, IPredictionContext, IPredictionSettings, IVoltPredictionService, VOLT_PREDICTION_SETTINGS_STORAGE_KEY } from '../../common/prediction.js';
import { meetsConfidence, orderEdits, samePath } from '../../common/prediction/editGraph.js';
import { IParsedEdit, parseMultiEdit } from '../../common/prediction/multiEditParser.js';
import { postProcessInline } from '../../common/prediction/postProcess.js';
import { buildInlinePrompt, buildNextEditPrompt } from '../../common/prediction/predictionPrompt.js';
import { PredictionCache, predictionCacheKey } from '../../common/prediction/predictionCache.js';
import { IModelMessage } from '../../common/providers.js';
import { IAgentRuntimeService } from '../../common/runtime.js';

/** Hard cap so a runaway stream can never hold the editor hostage. */
const INLINE_TIMEOUT_MS = 10_000;
const NES_TIMEOUT_MS = 15_000;
const AGENT_TAB_TIMEOUT_MS = 30_000;
const ONESHOT_TIMEOUT_MS = 60_000;

export class VoltPredictionService extends Disposable implements IVoltPredictionService {

	declare readonly _serviceBrand: undefined;

	private settings: IPredictionSettings;
	private readonly inlineCache = new PredictionCache<string>(64);
	private inFlight: CancellationTokenSource | undefined;
	private lastFailure: string | undefined;

	private readonly _onDidChangeSettings = this._register(new Emitter<void>());
	readonly onDidChangeSettings: Event<void> = this._onDidChangeSettings.event;

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
			return raw ? { ...DEFAULT_PREDICTION_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_PREDICTION_SETTINGS };
		} catch {
			return { ...DEFAULT_PREDICTION_SETTINGS };
		}
	}

	// --- inline (ghost text) -------------------------------------------------------------------

	async predictInline(ctx: IPredictionContext, token: CancellationToken): Promise<IEditPrediction | undefined> {
		const modelRef = this.modelAccess.resolveTabModelRef();
		if (!modelRef) {
			this.logService.info('[volt prediction] nothing selected in the composer for Tab');
			return undefined;
		}
		this.logService.info(`[volt prediction] using ${modelRef}`);

		const cacheKey = predictionCacheKey(modelRef, ctx.uri.toString(), ctx.prefix, ctx.suffix);
		const cached = this.inlineCache.get(cacheKey);
		if (cached !== undefined) {
			return cached ? this.inlineResult(ctx, cached) : undefined;
		}

		const raw = await this.request(modelRef, buildInlinePrompt(ctx), modelRef.startsWith('agent:') ? AGENT_TAB_TIMEOUT_MS : INLINE_TIMEOUT_MS, token);
		if (raw === undefined) {
			return undefined;
		}
		const completion = postProcessInline({ raw, linePrefix: ctx.linePrefix, lineSuffix: ctx.lineSuffix }) ?? '';
		// Cache negatives too - retrying the same position would give the same nothing.
		this.inlineCache.set(cacheKey, completion);
		return completion ? this.inlineResult(ctx, completion) : undefined;
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
		const raw = await this.request(modelRef, buildNextEditPrompt(ctx, intent), modelRef.startsWith('agent:') ? Math.max(timeoutMs, AGENT_TAB_TIMEOUT_MS) : timeoutMs, token);
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
			range: new Range(edit.startLineNumber, edit.startColumn, edit.endLineNumber, edit.endColumn),
			replacement: edit.replacement,
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
	 * One stateless call: cancel whatever was in flight, race a timeout, collect text deltas.
	 * Returns undefined on cancellation (the caller shows nothing).
	 */
	private async request(modelRef: string, messages: IModelMessage[], timeoutMs: number, token: CancellationToken): Promise<string | undefined> {
		this.inFlight?.dispose(true);
		const cts = new CancellationTokenSource(token);
		this.inFlight = cts;

		if (this.settings.debounceMs > 0) {
			try {
				await timeout(this.settings.debounceMs, cts.token);
			} catch {
				return undefined; // cancelled while debouncing
			}
		}
		if (cts.token.isCancellationRequested) {
			return undefined;
		}

		const started = Date.now();
		const kill = setTimeout(() => cts.cancel(), timeoutMs);
		try {
			let text = '';
			for await (const event of this.modelAccess.streamModel(modelRef, messages, undefined, cts.token)) {
				if (cts.token.isCancellationRequested) {
					return undefined;
				}
				if (event.type === 'text.delta' && event.delta) {
					text += event.delta;
				} else if (event.type === 'error') {
					this.lastFailure = formatPredictionError(event.message);
					this.logService.warn(`[volt prediction] provider error: ${this.lastFailure}`);
					return undefined;
				}
			}
			if (cts.token.isCancellationRequested) {
				return undefined;
			}
			this.logService.info(`[volt prediction] ${modelRef} answered in ${Date.now() - started}ms (${text.length} chars)`);
			return text;
		} catch (err) {
			if (err instanceof CancellationError || cts.token.isCancellationRequested) {
				return undefined;
			}
			this.lastFailure = formatPredictionError(err);
			this.logService.warn(`[volt prediction] request failed: ${this.lastFailure}`);
			return undefined;
		} finally {
			clearTimeout(kill);
			if (this.inFlight === cts) {
				this.inFlight = undefined;
			}
			cts.dispose();
		}
	}

	override dispose(): void {
		this.inFlight?.dispose(true);
		super.dispose();
	}
}

registerSingleton(IVoltPredictionService, VoltPredictionService, InstantiationType.Delayed);
