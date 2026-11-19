/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** The voice Read Aloud speaks with: a system voice's name, or a downloaded voice as `kokoro:<id>`. Empty: the system's default voice. */
export const AGENT_READ_ALOUD_VOICE_SETTING = 'volt.agent.readAloud.voice';

/** Reading speed, 1 is the voice's normal pace. */
export const AGENT_READ_ALOUD_SPEED_SETTING = 'volt.agent.readAloud.speed';

export const AGENT_READ_ALOUD_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 2];

export function clampReadAloudSpeed(value: unknown): number {
	return typeof value === 'number' && isFinite(value) ? Math.max(0.5, Math.min(2, value)) : 1;
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.agent.readAloud',
	title: localize('voltAgent.readAloudConfigTitle', "Agent Read Aloud"),
	type: 'object',
	properties: {
		[AGENT_READ_ALOUD_VOICE_SETTING]: {
			type: 'string',
			default: '',
			description: localize('voltAgent.readAloudVoice', "The voice that reads an agent's reply aloud: a system voice by name (such as Samantha), or a downloaded voice as kokoro:af_heart. Empty uses the system's default voice."),
		},
		[AGENT_READ_ALOUD_SPEED_SETTING]: {
			type: 'number',
			default: 1,
			minimum: 0.5,
			maximum: 2,
			description: localize('voltAgent.readAloudSpeed', "How fast a reply is read aloud. 1 is the voice's normal pace."),
		},
	},
});

/**
 * Markdown as a person would read it out: no code blocks, no link targets, no markup signs.
 * Code blocks are left out (a voice reading braces helps nobody); inline code keeps its words.
 */
export function speakableMarkdown(markdown: string): string {
	let text = markdown.replace(/\r\n?/g, '\n');
	// Fenced code, closed or still open at the end.
	text = text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|$(?![\s\S]))/gm, '\n');
	text = text.replace(/<!--[\s\S]*?-->/g, ' ');
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	text = text.replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ');
	text = text.replace(/\bhttps?:\/\/\S+/g, ' ');
	const lines: string[] = [];
	for (let line of text.split('\n')) {
		// A table's `|---|---|` rule, and horizontal rules.
		if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) || /^\s*([-*_]\s*){3,}$/.test(line)) {
			continue;
		}
		line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>+\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
		if (/^\s*\|.*\|\s*$/.test(line)) {
			line = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()).filter(Boolean).join(', ');
		}
		line = line.replace(/`([^`\n]*)`/g, '$1').replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2').replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s).,;:!?])/g, '$1$2');
		line = line.replace(/[ \t]+/g, ' ').trim();
		if (!line) {
			lines.push('');
			continue;
		}
		// A heading or list item without end punctuation still gets a pause.
		lines.push(/[.!?:;,]$/.test(line) ? line : `${line}.`);
	}
	return lines.join('\n').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Speech in pieces of at most `max` characters, cut at sentence ends where possible. Short
 * pieces start sooner, and stopping or changing the voice takes effect at the next piece.
 */
export function splitSpeech(text: string, max = 240): string[] {
	const chunks: string[] = [];
	let current = '';
	const push = (piece: string) => {
		if (current && current.length + piece.length + 1 > max) {
			chunks.push(current);
			current = '';
		}
		current = current ? `${current} ${piece}` : piece;
	};
	for (const line of text.split('\n')) {
		// A sentence ends at a mark before a space; the dots inside `agentEditor.ts`, `3.5` or `e.g.` end nothing.
		for (const sentence of line.match(/.+?(?:[.!?]+(?<!\b\w\.\w\.)(?=\s|$)|$)/g) ?? []) {
			let piece = sentence.trim();
			while (piece.length > max) {
				const cut = piece.lastIndexOf(' ', max);
				const at = cut > max / 2 ? cut : max;
				push(piece.slice(0, at).trim());
				piece = piece.slice(at).trim();
			}
			if (piece) {
				push(piece);
			}
		}
	}
	if (current) {
		chunks.push(current);
	}
	return chunks;
}

/**
 * The piece sizes for a voice that is made on this computer, where a piece is heard only once
 * all of it is made: a short first piece so the first words come at once, then longer ones, each
 * made while the one before plays.
 */
export const QUICK_START_SIZES: readonly number[] = [48, 70, 100, 140];

/**
 * The pieces a downloaded voice is asked for. A voice that is made faster than it plays reads
 * whole sentences, which keeps a sentence's melody and puts the pauses where they belong; a slow
 * one starts with a short piece so the first words do not wait for a long sentence.
 */
export function localSpeechPieces(text: string, fast: boolean): string[] {
	return fast ? splitSpeech(text, 200) : splitSpeechQuickStart(text);
}

/**
 * Speech in pieces whose size limits follow `sizes` (the last one repeats). A piece ends at a
 * sentence end when one fits, else at a comma or other clause mark, else between two words.
 */
export function splitSpeechQuickStart(text: string, sizes: readonly number[] = QUICK_START_SIZES): string[] {
	const chunks: string[] = [];
	let rest = text.replace(/\s*\n\s*/g, ' ').trim();
	while (rest) {
		const max = sizes[Math.min(chunks.length, sizes.length - 1)];
		if (rest.length <= max) {
			chunks.push(rest);
			break;
		}
		const head = rest.slice(0, max + 1);
		// The last sentence end in reach; then the last clause mark; then the last space.
		let cut = -1;
		for (const match of head.matchAll(/[.!?]+(?<!\b\w\.\w\.)(?=\s)/g)) {
			cut = match.index + match[0].length;
		}
		if (cut < max / 3) {
			for (const match of head.matchAll(/[,;:\u2014](?=\s)/g)) {
				cut = Math.max(cut, match.index + 1);
			}
		}
		if (cut < max / 3) {
			cut = head.lastIndexOf(' ');
		}
		if (cut <= 0) {
			cut = max;
		}
		chunks.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	return chunks.filter(Boolean);
}
