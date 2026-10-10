/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { InlineCompletion, InlineCompletionContext, InlineCompletions, InlineCompletionsProvider } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IComposerPredictionInput, IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { composerContextFor, IComposerPredictionContext } from '../../../services/voltRuntime/common/prediction/composerContext.js';
import { ComposerLanguageModel } from '../../../services/voltRuntime/common/prediction/composerPredictor.js';

/** A composer longer than this is a pasted log or file, not a sentence being typed. */
const MAX_DRAFT_CHARS = 20_000;
/** Until the settings say otherwise: the pause before the model is asked. */
const DEFAULT_DELAY_MS = 1000;

/**
 * Ghost text in the agent composers (the prompt box, editing a sent message): the rest of the
 * word, the next words, the rest of the sentence. Guesses from the user's own prompts show on
 * every keystroke; once the typing pauses, the prediction model continues the sentence with the
 * chat in view, and its answer replaces the guess. Tab accepts.
 */
export class VoltComposerCompletionsProvider extends Disposable implements InlineCompletionsProvider<InlineCompletions> {

	readonly groupId = 'volt-composer';
	readonly displayName = 'Volt';
	/** Local guesses cost nothing: answer on each keystroke. The model waits for the pause below. */
	readonly debounceDelayMs = 0;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChangeInlineCompletions: Event<void> = this._onDidChange.event;

	private readonly pause: RunOnceScheduler;
	/** The last text ghost text was asked for, for the model call when the typing pauses. */
	private latest: { readonly model: ITextModel; readonly input: IComposerPredictionInput; readonly versionId: number } | undefined;
	private local: { readonly key: string; readonly model: ComposerLanguageModel } | undefined;
	private clipboard = '';
	private clipboardReadAt = 0;

	constructor(
		@IVoltPredictionService private readonly predictionService: IVoltPredictionService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		this.pause = this._register(new RunOnceScheduler(() => this.askModel(), DEFAULT_DELAY_MS));
	}

	async provideInlineCompletions(model: ITextModel, position: Position, _context: InlineCompletionContext, _token: CancellationToken): Promise<InlineCompletions | undefined> {
		const settings = this.predictionService.getSettings();
		if (!settings.enabled || !settings.composer || model.getValueLength() > MAX_DRAFT_CHARS) {
			this.pause.cancel();
			return undefined;
		}
		const offset = model.getOffsetAt(position);
		const text = model.getValue();
		const draft = text.slice(0, offset);
		const after = text.slice(offset);
		// At the end of what is typed only: a guess in the middle of a sentence gets in the way.
		if (after.trim() || !draft.trim() || typingCommandOrMention(draft)) {
			this.pause.cancel();
			return undefined;
		}
		void this.refreshClipboard();
		const chat = composerContextFor(model.uri);
		const input: IComposerPredictionInput = {
			uri: model.uri,
			draft,
			after,
			transcript: chat?.transcript ?? [],
			vocabulary: chat?.vocabulary ?? [],
			clipboard: this.clipboard,
		};
		this.latest = { model, input, versionId: model.getVersionId() };

		// The model's continuation, when known for this text (typed through, or asked before).
		const known = this.predictionService.peekComposer(input);
		if (known) {
			this.pause.cancel();
			return this.list(position, known);
		}
		// Each keystroke restarts the pause; the model is asked once the typing stops.
		this.pause.schedule(Math.max(0, settings.composerDelayMs));
		const guess = this.languageModel(chat).predict(draft);
		return guess ? this.list(position, guess) : undefined;
	}

	disposeInlineCompletions(): void {
		// Nothing retained per list.
	}

	/** The typing paused: ask for the continuation, and show it if the text is still where it was. */
	private askModel(): void {
		const latest = this.latest;
		if (!latest || latest.model.isDisposed() || latest.model.getVersionId() !== latest.versionId) {
			return;
		}
		void this.predictionService.predictComposer(latest.input, CancellationToken.None).then(answer => {
			const now = this.latest;
			if (!answer || !now || now.model.isDisposed() || now.model.getVersionId() !== now.versionId) {
				return;
			}
			// Typed on since: shown only when the answer still fits (the service's typed-through cache).
			if (this.predictionService.peekComposer(now.input)) {
				this._onDidChange.fire();
			}
		}, () => undefined);
	}

	/** The user's prompts and the chat's names as an n-gram model, rebuilt only when they change. */
	private languageModel(chat: IComposerPredictionContext | undefined): ComposerLanguageModel {
		const prompts = chat?.prompts ?? [];
		const vocabulary = [...(chat?.vocabulary ?? []), ...(chat?.transcript ?? [])];
		const key = `${prompts.length}|${prompts[0] ?? ''}|${vocabulary.length}|${vocabulary.at(-1)?.length ?? 0}`;
		if (this.local?.key !== key) {
			this.local = { key, model: new ComposerLanguageModel({ prompts, vocabulary }) };
		}
		return this.local.model;
	}

	private list(position: Position, text: string): InlineCompletions {
		const item: InlineCompletion = {
			insertText: text,
			range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
		};
		return { items: [item], enableForwardStability: true };
	}

	private async refreshClipboard(): Promise<void> {
		if (Date.now() - this.clipboardReadAt < 1000) {
			return;
		}
		this.clipboardReadAt = Date.now();
		try {
			this.clipboard = (await this.clipboardService.readText()).slice(0, 2_000);
		} catch {
			// No clipboard access: the prompt goes without it.
		}
	}
}

/** A slash command or an @ mention being typed: their own menus complete those. */
function typingCommandOrMention(draft: string): boolean {
	return /^\s*\/\S*$/.test(draft) || /(^|\s)@[^\s]*$/.test(draft);
}
