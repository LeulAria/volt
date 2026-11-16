/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltVoiceChatService = createDecorator<IVoltVoiceChatService>('voltVoiceChatService');
export const VOLT_VOICE_CHAT_CHANNEL_NAME = 'voltVoiceChat';

/**
 * Who hears and speaks in a voice chat. `xai` and `openai` are speech-to-speech realtime models
 * (one WebSocket, the model calls Volt's tools itself); `custom` is any server that speaks the same
 * realtime protocol (a local proxy, a test server).
 */
export type VoltVoiceProvider = 'xai' | 'openai' | 'custom';

export const VOLT_VOICE_PROVIDERS: readonly VoltVoiceProvider[] = ['xai', 'openai', 'custom'];

export interface IVoltVoiceProviderInfo {
	readonly id: VoltVoiceProvider;
	readonly label: string;
	/** The realtime WebSocket, model query included. */
	readonly url: string;
	readonly model: string;
	/** Where the user gets a key. */
	readonly keyUrl?: string;
	/** Environment variables a key may come from on the computer. */
	readonly envKeys: readonly string[];
	readonly defaultVoice: string;
	readonly voices: readonly string[];
}

/** xAI's built-in voices (GET /v1/tts/voices), the ones Cursor's voice chat offers too. */
export const XAI_VOICES: readonly string[] = [
	'altair', 'ara', 'atlas', 'aurora', 'carina', 'castor', 'celeste', 'cosmo', 'eve', 'helios', 'helix', 'iris', 'kepler', 'leo', 'liora', 'lumen', 'luna',
	'lux', 'naksh', 'orion', 'perseus', 'rex', 'rigel', 'sal', 'sirius', 'ursa', 'zagan', 'zenith',
];

export const OPENAI_VOICES: readonly string[] = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'];

export const VOLT_VOICE_PROVIDER_INFO: Readonly<Record<VoltVoiceProvider, IVoltVoiceProviderInfo>> = {
	xai: {
		id: 'xai', label: 'xAI Grok Voice', url: 'wss://api.x.ai/v1/realtime?model=grok-voice-latest', model: 'grok-voice-latest',
		keyUrl: 'https://console.x.ai', envKeys: ['XAI_API_KEY', 'GROK_API_KEY'], defaultVoice: 'ara', voices: XAI_VOICES,
	},
	openai: {
		id: 'openai', label: 'OpenAI Realtime', url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime', model: 'gpt-realtime',
		keyUrl: 'https://platform.openai.com/api-keys', envKeys: ['OPENAI_API_KEY'], defaultVoice: 'marin', voices: OPENAI_VOICES,
	},
	custom: {
		id: 'custom', label: 'Custom realtime server', url: '', model: '', envKeys: [], defaultVoice: 'ara', voices: XAI_VOICES,
	},
};

/** Speeds the settings menu offers, as Cursor's does. xAI takes 0.7-1.5, so 2x is clamped there. */
export const VOLT_VOICE_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 2];

/** A short-lived secret the client opens the realtime socket with; the API key never leaves the computer's service. */
export interface IVoltVoiceSession {
	readonly provider: VoltVoiceProvider;
	readonly url: string;
	/** WebSocket subprotocols that carry the secret (browsers can't set headers). */
	readonly protocols: readonly string[];
	/** Unix ms; the client starts a new socket before this when a call runs that long. */
	readonly expiresAt: number;
	readonly model: string;
}

export interface IVoltVoiceMintRequest {
	readonly provider: VoltVoiceProvider;
	/** For `custom`: the server's ws(s) URL. */
	readonly url?: string;
}

export interface IVoltVoiceKeyStatus {
	readonly provider: VoltVoiceProvider;
	/** `saved`: set in Volt; `env`: from an environment variable on the computer. */
	readonly source: 'saved' | 'env' | undefined;
	/** `XAI_API_KEY` etc. when `source` is `env`. */
	readonly envKey?: string;
}

/** One line of a call's transcript. */
export interface IVoltVoiceTurn {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'note';
	readonly text: string;
	readonly at: number;
	/** The chat a note is about (an agent the voice agent started or messaged). */
	readonly chatId?: string;
}

export type VoltVoiceCallStatus = 'ongoing' | 'ended' | 'failed';

/** A voice call as saved on the computer: shown as a card in the chats it touched and as a transcript tab. */
export interface IVoltVoiceCall {
	readonly id: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly status: VoltVoiceCallStatus;
	readonly provider: VoltVoiceProvider;
	readonly voice: string;
	/** The chat the call was started from (undefined: a new chat's composer). */
	readonly originChatId?: string;
	/** Every chat the call started or talked to, in order; each shows the call's card. */
	readonly chatIds: readonly string[];
	/** Where each chat's card goes: after the reply of this turn (the last one when the call reached the chat); none: the end. */
	readonly anchors?: Readonly<Record<string, { readonly turnId: string }>>;
	/** When the call last heard from the line; an ongoing call not heard for a while is shown as ended. */
	readonly lastHeardAt?: number;
	readonly connectedAt?: number;
	readonly turns: readonly IVoltVoiceTurn[];
	readonly error?: string;
}

export interface IVoltVoiceChatService {
	readonly _serviceBrand: undefined;
	keyStatus(): Promise<readonly IVoltVoiceKeyStatus[]>;
	/** Saves (or with undefined, removes) Volt's own key for `provider`. */
	setKey(provider: VoltVoiceProvider, key: string | undefined): Promise<void>;
	/** A short-lived secret for the realtime socket. Rejects with a readable message when no key is set. */
	mint(request: IVoltVoiceMintRequest): Promise<IVoltVoiceSession>;
	/** A short sample of `voice` ("This is a voice preview."), as base64 audio. */
	previewVoice(provider: VoltVoiceProvider, voice: string, speed: number): Promise<{ readonly mime: string; readonly base64: string }>;
	saveCall(call: IVoltVoiceCall): Promise<void>;
	getCall(id: string): Promise<IVoltVoiceCall | undefined>;
	/** Calls that touched `chatId`, oldest first, or every call (newest 200) without it. */
	listCalls(chatId?: string): Promise<readonly IVoltVoiceCall[]>;
}

/** Clamps a menu speed to what the provider accepts. */
export function providerSpeed(provider: VoltVoiceProvider, speed: number): number {
	const [min, max] = provider === 'openai' ? [0.25, 1.5] : [0.7, 1.5];
	return Math.min(max, Math.max(min, speed));
}

export function isVoiceProvider(value: unknown): value is VoltVoiceProvider {
	return typeof value === 'string' && (VOLT_VOICE_PROVIDERS as readonly string[]).includes(value);
}

/** A call id: letters and digits only, so it is safe as a file name. */
export function isVoiceCallId(id: unknown): id is string {
	return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}
