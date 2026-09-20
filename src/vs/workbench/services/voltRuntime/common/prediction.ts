/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IVoltPredictionService = createDecorator<IVoltPredictionService>('voltPredictionService');

/** One concrete text replacement the model predicted. */
export interface IPredictedEdit {
	uri: URI;
	range: IRange;
	replacement: string;
	/** Model-supplied rationale, surfaced in hovers/receipts. Never invented by Volt. */
	reason?: string;
}

export type PredictionKind = 'inline' | 'edit' | 'multi';

export interface IEditPrediction {
	kind: PredictionKind;
	/** 0..1. Model-reported for structured predictions, heuristic for inline ghost text. */
	confidence: number;
	primary: IPredictedEdit;
	/** Follow-up edits, ordered: same-file first, then per-file (cross-file jump targets). */
	next: IPredictedEdit[];
}

/** A recent workspace text change; the strongest signal for next-edit prediction. */
export interface IRecentEdit {
	uri: URI;
	/** 1-based line the change started on. */
	startLineNumber: number;
	/** Text removed by the change (truncated). */
	removed: string;
	/** Text inserted by the change (truncated). */
	inserted: string;
	timestamp: number;
}

export interface ISiblingExcerpt {
	path: string;
	excerpt: string;
}

/**
 * Everything a prediction prompt may draw on. Deliberately small (D24): no repo scan,
 * no embeddings - excerpt, imports, diagnostics, recent edits, and open siblings only.
 */
export interface IPredictionContext {
	uri: URI;
	languageId: string;
	/** Text before the cursor, budget-limited. */
	prefix: string;
	/** Text after the cursor, budget-limited. */
	suffix: string;
	/** The current line up to the cursor. */
	linePrefix: string;
	/** The current line after the cursor. */
	lineSuffix: string;
	/** Import/require block of the current file. */
	imports: string;
	/** Rendered diagnostics near the cursor, e.g. `12: Property 'nme' does not exist`. */
	diagnostics: string[];
	recentEdits: IRecentEdit[];
	siblings: ISiblingExcerpt[];
	/** Latest clipboard text (truncated). Cursor-style Tab uses this as a first-class signal. */
	clipboard?: string;
	/** Text-model version the context was built from; stale contexts are discarded. */
	modelVersionId: number;
}

export interface IPredictionSettings {
	enabled: boolean;
	/** Extra debounce before dispatching a model request (core already debounces rendering). */
	debounceMs: number;
	/** eager: predict as you type. subtle: only on explicit trigger. */
	mode: 'eager' | 'subtle';
	/** Glob patterns that never receive predictions (secrets, lockfiles). */
	disabledGlobs: string[];
}

export const DEFAULT_PREDICTION_SETTINGS: IPredictionSettings = {
	enabled: true,
	debounceMs: 0,
	mode: 'eager',
	disabledGlobs: ['**/.env*', '**/*.lock', '**/package-lock.json', '**/secrets*'],
};

export const VOLT_PREDICTION_SETTINGS_STORAGE_KEY = 'volt.prediction.settings';

/**
 * The Prediction Runtime (D20): ephemeral, cancellable, no Session/Run, never ACP.
 * Each call is one stateless model round-trip through `IVoltModelAccess.streamModel()`.
 */
export interface IVoltPredictionService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeSettings: Event<void>;
	getSettings(): IPredictionSettings;
	updateSettings(update: Partial<IPredictionSettings>): void;

	/** Catalog ref the Tab path will call, or undefined when no chat model is available. */
	resolveTabModelRef(): string | undefined;

	/** Last failed Tab request, for a one-shot warning in the editor. */
	consumeLastFailure(): string | undefined;

	/** Ghost text at the cursor. Multiline capable. */
	predictInline(ctx: IPredictionContext, token: CancellationToken): Promise<IEditPrediction | undefined>;

	/** Next-edit prediction: a structured edit near (or after) the cursor, plus follow-ups. */
	predictNextEdit(ctx: IPredictionContext, token: CancellationToken): Promise<IEditPrediction | undefined>;

	/** One-shot multi-location edit for an explicit user intent (Volt: AI Edit). */
	predictMultiEdit(ctx: IPredictionContext, intent: string, token: CancellationToken): Promise<IEditPrediction | undefined>;
}
