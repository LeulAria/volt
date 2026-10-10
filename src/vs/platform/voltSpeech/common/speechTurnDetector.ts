/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** What to do with the audio heard so far: keep it open, send it for its final transcript, or drop it as silence. */
export type TurnDecision = 'continue' | 'commit' | 'discard';

export interface ISpeechTurnDetectorOptions {
	/** A pause this long after speech ends the utterance. */
	readonly endSilenceMs: number;
	/** Past this length a shorter pause ends it, so a long monologue still settles piece by piece. */
	readonly longTurnMs: number;
	readonly longTurnSilenceMs: number;
	/** An utterance this long ends even without a pause. */
	readonly maxTurnMs: number;
	/** Less voice than this is noise (a click, a breath). */
	readonly minSpeechMs: number;
	/** Audio without voice this long is dropped instead of transcribed. */
	readonly silentTurnMs: number;
}

export const DEFAULT_TURN_DETECTOR_OPTIONS: ISpeechTurnDetectorOptions = {
	endSilenceMs: 650,
	longTurnMs: 15_000,
	longTurnSilenceMs: 250,
	maxTurnMs: 28_000,
	minSpeechMs: 150,
	silentTurnMs: 8_000,
};

/** Voice is this many times louder than the room. */
const SPEECH_FACTOR = 3.5;
const MIN_THRESHOLD = 0.008;
const MAX_THRESHOLD = 0.08;

/**
 * Client-side voice activity detection for realtime transcription sessions that leave turns to the
 * client (`turn_detection: null`): an energy threshold over an adaptive noise floor decides where
 * one utterance ends, so its transcript can be committed and become final while the user keeps talking.
 */
export class SpeechTurnDetector {

	private noiseFloor = 0.003;
	private turnMs = 0;
	private speechMs = 0;
	private silenceMs = 0;

	constructor(private readonly options: ISpeechTurnDetectorOptions = DEFAULT_TURN_DETECTOR_OPTIONS) { }

	/** The current utterance holds voice, not only room noise. */
	get hasSpeech(): boolean {
		return this.speechMs >= this.options.minSpeechMs;
	}

	/** Feeds one block of audio by its RMS level (0 to 1) and length. */
	push(rms: number, durationMs: number): TurnDecision {
		this.turnMs += durationMs;
		if (rms >= this.threshold()) {
			this.speechMs += durationMs;
			this.silenceMs = 0;
			// A steady noise louder than the first guess still lifts the floor, slowly.
			this.noiseFloor += (Math.min(rms, MAX_THRESHOLD) - this.noiseFloor) * 0.002;
		} else {
			this.silenceMs += durationMs;
			this.noiseFloor += (Math.min(rms, MAX_THRESHOLD) - this.noiseFloor) * 0.05;
		}
		if (!this.hasSpeech) {
			return this.turnMs >= this.options.silentTurnMs ? 'discard' : 'continue';
		}
		if (this.silenceMs >= this.options.endSilenceMs
			|| (this.turnMs >= this.options.longTurnMs && this.silenceMs >= this.options.longTurnSilenceMs)
			|| this.turnMs >= this.options.maxTurnMs) {
			return 'commit';
		}
		return 'continue';
	}

	/** The next audio starts a new utterance. The noise floor carries over. */
	reset(): void {
		this.turnMs = 0;
		this.speechMs = 0;
		this.silenceMs = 0;
	}

	private threshold(): number {
		return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, this.noiseFloor * SPEECH_FACTOR));
	}
}
