/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { AgentVoiceDictation } from './agentVoiceDictation.js';

const WAVE_BARS = 18;
/** One bar per microphone slice. Slices arrive four at a time and are drawn at this pace so the wave scrolls evenly. */
const WAVE_STEP_MS = 32;
/** Slices waiting to be drawn; more means the wave lags the voice, so older ones are dropped. */
const MAX_PENDING_SLICES = 12;

/** Microphone RMS as 0-1 loudness the way it sounds: speech sits around 0.02-0.2 RMS. */
export function voiceLoudness(rms: number): number {
	return Math.min(1, Math.sqrt(Math.max(0, rms)) * 2.4);
}

/**
 * Dictation on the composer: a colored glow rising from the bottom of the input box that swells
 * with the voice, and a scrolling waveform in place of the mic icon.
 */
export class AgentVoiceVisuals extends Disposable {

	private readonly waveElement: HTMLElement;
	private readonly glow: HTMLElement;
	private readonly bars: HTMLElement[] = [];
	private readonly heights: number[] = new Array(WAVE_BARS).fill(0);
	private readonly pending: number[] = [];
	private frame: number | undefined;
	private lastStep = 0;

	constructor(private readonly inputBox: HTMLElement, micButton: HTMLElement, private readonly dictation: AgentVoiceDictation) {
		super();
		this.glow = $('.volt-agent-voice-glow');
		this.glow.setAttribute('aria-hidden', 'true');
		append(this.glow, $('.volt-agent-voice-aurora'));
		inputBox.prepend(this.glow);

		this.waveElement = append(micButton, $('.volt-agent-voice-wave'));
		this.waveElement.setAttribute('aria-hidden', 'true');
		for (let i = 0; i < WAVE_BARS; i++) {
			this.bars.push(append(this.waveElement, $('span.volt-agent-voice-wave-bar')));
		}
		append(micButton, $('span.volt-agent-voice-stop')).setAttribute('aria-hidden', 'true');

		this._register(dictation.onDidChange(() => this.render()));
		this._register(dictation.onDidHear(levels => this.hear(levels)));
		this._register(toDisposable(() => this.cancelFrame()));
		this.render();
	}

	private render(): void {
		const active = this.dictation.active;
		this.inputBox.classList.toggle('voice-active', active);
		this.inputBox.classList.toggle('voice-transcribing', this.dictation.state === 'transcribing');
		// On the glow, not the input box: a custom property set there would restyle the whole editor.
		const level = this.dictation.state === 'listening' ? voiceLoudness(this.dictation.level) : 0;
		this.glow.style.setProperty('--volt-voice-level', level.toFixed(3));
		if (!active) {
			this.cancelFrame();
			this.pending.length = 0;
			this.heights.fill(0);
			this.drawBars();
		}
	}

	private hear(levels: readonly number[]): void {
		for (const level of levels) {
			this.pending.push(voiceLoudness(level));
		}
		if (this.pending.length > MAX_PENDING_SLICES) {
			this.pending.splice(0, this.pending.length - MAX_PENDING_SLICES);
		}
		if (this.frame === undefined) {
			this.lastStep = 0;
			this.frame = getWindow(this.waveElement).requestAnimationFrame(now => this.step(now));
		}
	}

	private step(now: number): void {
		this.frame = undefined;
		const steps = this.lastStep ? Math.min(this.pending.length, Math.floor((now - this.lastStep) / WAVE_STEP_MS)) : 1;
		if (steps > 0) {
			this.lastStep = now;
			for (let i = 0; i < steps; i++) {
				this.heights.shift();
				this.heights.push(this.pending.shift()!);
			}
			this.drawBars();
		}
		if (this.pending.length) {
			this.frame = getWindow(this.waveElement).requestAnimationFrame(next => this.step(next));
		}
	}

	private drawBars(): void {
		for (let i = 0; i < WAVE_BARS; i++) {
			const height = this.heights[i];
			this.bars[i].style.transform = `scaleY(${(0.3 + height * 0.7).toFixed(3)})`;
			this.bars[i].style.opacity = (0.35 + height * 0.65).toFixed(3);
		}
	}

	private cancelFrame(): void {
		if (this.frame !== undefined) {
			getWindow(this.waveElement).cancelAnimationFrame(this.frame);
			this.frame = undefined;
		}
	}
}
