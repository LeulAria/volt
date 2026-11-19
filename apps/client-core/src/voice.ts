/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Voice chat over the agent server (`voice.*`, src/vs/server/node/voltAgent/serverVoice.ts): the
// phone streams the audio to the voice provider itself; the server runs the voice's tools.

/** The realtime socket the phone opens: a short-lived secret in its subprotocols, never the key. */
export interface IVoiceSession {
	readonly provider: string;
	readonly url: string;
	readonly protocols: readonly string[];
	readonly expiresAt: number;
	readonly model: string;
}

export interface IVoiceSettings {
	readonly voice: string;
	readonly speed: number;
	/** `auto`, or a code such as `de` or `pt-BR`. */
	readonly language: string;
}

export interface IVoiceStart {
	readonly callId: string;
	readonly session: IVoiceSession;
	/** The `session.update` event to send on the socket as it opens (instructions, tools, voice). */
	readonly sessionUpdate: Record<string, unknown>;
	/** `response.instructions` for the greeting when the caller stays quiet. */
	readonly greeting: string;
	readonly provider: string;
	readonly settings: IVoiceSettings;
}

export interface IVoiceToolResult {
	readonly output: unknown;
	readonly respond: boolean;
	readonly instructions?: string;
	/** `end_the_call`: hang up once the goodbye has been spoken. */
	readonly end?: boolean;
}

export interface IVoiceTurn {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'note';
	readonly text: string;
	readonly at: number;
}

/** A call as saved on the computer. */
export interface IVoiceCallRecord {
	readonly id: string;
	readonly startedAt: number;
	readonly connectedAt?: number;
	readonly endedAt?: number;
	readonly lastHeardAt?: number;
	readonly status: 'ongoing' | 'ended' | 'failed';
	readonly chatIds: readonly string[];
	readonly anchors?: Readonly<Record<string, { readonly turnId: string }>>;
	readonly turns: readonly IVoiceTurn[];
}

/** `voice` topic events for the phone that runs the call. */
export type VoiceServerEvent =
	| { readonly callId: string; readonly kind: 'note'; readonly text: string }
	| { readonly callId: string; readonly kind: 'chat'; readonly chatId: string }
	| { readonly callId: string; readonly kind: 'ended' };

/** The voices xAI offers (Cursor's list). */
export const VOICE_NAMES: readonly string[] = [
	'altair', 'ara', 'atlas', 'aurora', 'carina', 'castor', 'celeste', 'cosmo', 'eve', 'helios', 'helix', 'iris', 'kepler', 'leo', 'liora', 'lumen', 'luna',
	'lux', 'naksh', 'orion', 'perseus', 'rex', 'rigel', 'sal', 'sirius', 'ursa', 'zagan', 'zenith',
];

export const VOICE_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 2];

export const VOICE_LANGUAGES: readonly { readonly id: string; readonly label: string }[] = [
	{ id: 'auto', label: 'Auto-detect' }, { id: 'en', label: 'English' }, { id: 'ar-EG', label: 'Arabic (Egypt)' }, { id: 'ar-SA', label: 'Arabic (Saudi Arabia)' },
	{ id: 'ar-AE', label: 'Arabic (United Arab Emirates)' }, { id: 'bn', label: 'Bengali' }, { id: 'ca', label: 'Catalan' }, { id: 'zh', label: 'Chinese (Simplified)' },
	{ id: 'da', label: 'Danish' }, { id: 'nl', label: 'Dutch' }, { id: 'fi', label: 'Finnish' }, { id: 'fr', label: 'French' }, { id: 'de', label: 'German' },
	{ id: 'hi', label: 'Hindi' }, { id: 'hu', label: 'Hungarian' }, { id: 'id', label: 'Indonesian' }, { id: 'it', label: 'Italian' }, { id: 'ja', label: 'Japanese' },
	{ id: 'ko', label: 'Korean' }, { id: 'pl', label: 'Polish' }, { id: 'pt-BR', label: 'Portuguese (Brazil)' }, { id: 'pt-PT', label: 'Portuguese (Portugal)' },
	{ id: 'ru', label: 'Russian' }, { id: 'es-MX', label: 'Spanish (Mexico)' }, { id: 'es-ES', label: 'Spanish (Spain)' }, { id: 'sv', label: 'Swedish' },
	{ id: 'th', label: 'Thai' }, { id: 'tr', label: 'Turkish' }, { id: 'vi', label: 'Vietnamese' },
];

/** `m:ss`, minutes unbounded. */
export function callClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** What a call's card says: Connecting, Ongoing · m:ss or Ended · m:ss. */
export function callStatusLabel(call: Pick<IVoiceCallRecord, 'status' | 'connectedAt' | 'endedAt' | 'lastHeardAt'>, live: boolean, now = Date.now()): string {
	if (live) {
		return call.connectedAt ? `Ongoing · ${callClock(now - call.connectedAt)}` : 'Connecting';
	}
	const end = call.endedAt ?? call.lastHeardAt;
	return call.connectedAt && end ? `Ended · ${callClock(end - call.connectedAt)}` : 'Ended';
}
