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
import { IComposerPredictionInput, IVoltPredictionService } from '../../../services/voltRuntime/common/prediction.js';
import { composerContextFor, IComposerPredictionContext } from '../../../services/voltRuntime/common/prediction/composerContext.js';
import { ComposerLanguageModel } from '../../../services/voltRuntime/common/prediction/composerPredictor.js';
import { LOCAL_SURE } from '../../../services/voltRuntime/common/prediction/localPredictor.js';
import { ClipboardWatch } from './clipboardWatch.js';
import { TerminalCommandTracker } from './terminalCommandTracker.js';

/** A composer longer than this is a pasted log or file, not a sentence being typed. */
const MAX_DRAFT_CHARS = 20_000;
/** Until the settings say otherwise: the pause before the model is asked. */
const DEFAULT_DELAY_MS = 300;
/** A clipboard copied this recently rides along; an older one only when the draft names something in it. */
const CLIPBOARD_FRESH_MS = 5 * 60_000;
/** Terminal commands this recent are part of what the message may be about. */
const TERMINAL_RECENT_MS = 15 * 60_000;

/**
 * Ghost text in the agent composers (the prompt box, editing a sent message): the rest of the
 * word, the next words, the rest of the sentence. Guesses from the user's own prompts show on
 * every keystroke; a sure one (a prompt sent before being typed again) is the answer, with no
 * model call. Otherwise, once the typing pauses, the prediction model continues the sentence with
 * the chat, the agent's activity and the terminals in view, and its answer replaces the guess
 * (the change event makes the editor ask again, and the answer is then known). Tab accepts.
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

	constructor(
		private readonly terminals: TerminalCommandTracker,
		private readonly clipboard: ClipboardWatch,
		@IVoltPredictionService private readonly predictionService: IVoltPredictionService,
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
		this.clipboard.refresh();
		const chat = composerContextFor(model.uri);
		const terminals = this.terminals.recent(TERMINAL_RECENT_MS);
		const input: IComposerPredictionInput = {
			uri: model.uri,
			draft,
			after,
			transcript: chat?.transcript ?? [],
			vocabulary: chat?.vocabulary ?? [],
			clipboard: this.clipboard.recent(CLIPBOARD_FRESH_MS, text => draftNamesClipboard(draft, text)),
			activity: [...(chat?.activity ?? []), ...terminals],
		};
		this.latest = { model, input, versionId: model.getVersionId() };

		// The model's continuation, when known for this text (typed through, or asked before).
		const known = this.predictionService.peekComposer(input);
		if (known) {
			this.pause.cancel();
			this.predictionService.stats.bump('instant');
			return this.list(position, known, true);
		}
		const guess = this.languageModel(chat).predictScored(draft);
		if (guess && guess.confidence >= LOCAL_SURE) {
			// A prompt sent before, typed out again: nothing for the model to add.
			this.pause.cancel();
			this.predictionService.stats.bump('local');
			return this.list(position, guess.text, true);
		}
		// Each keystroke restarts the pause; the model is asked once the typing stops.
		this.pause.schedule(Math.max(0, settings.composerDelayMs));
		// Not forward-stable: the editor would keep showing it over the model's answer.
		return guess ? this.list(position, guess.text, false) : undefined;
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

	private list(position: Position, text: string, stable: boolean): InlineCompletions {
		const item: InlineCompletion = {
			insertText: text,
			range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
		};
		return { items: [item], enableForwardStability: stable };
	}

}

/** A slash command or an @ mention being typed: their own menus complete those. */
function typingCommandOrMention(draft: string): boolean {
	return /^\s*\/\S*$/.test(draft) || /(^|\s)@[^\s]*$/.test(draft);
}

/** The draft names something from an older clipboard: an identifier, a path, a long word. */
function draftNamesClipboard(draft: string, clipboard: string): boolean {
	const words = new Set(draft.slice(-400).match(/[\p{L}\p{N}_$.\/-]{4,}/gu) ?? []);
	for (const word of words) {
		const name = word.length >= 8 || /[A-Z_.\/$\d-]/.test(word.slice(1));
		if (name && clipboard.includes(word)) {
			return true;
		}
	}
	return false;
}
