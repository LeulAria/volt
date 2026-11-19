/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

/**
 * Voice chat's contract with core (the `volt.voice-chat` built-in extension's module): ids core
 * may name before the module is loaded.
 */

export const VOICE_CHAT_FEATURE_ID = 'voiceChat';

/** Starts a voice call from a chat's composer. Args: `{ sessionId?: string }` (none: a new chat's composer). */
export const START_VOICE_CHAT_COMMAND_ID = 'volt.voiceChat.start';
export const END_VOICE_CHAT_COMMAND_ID = 'volt.voiceChat.end';
export const TOGGLE_VOICE_CHAT_MUTE_COMMAND_ID = 'volt.voiceChat.toggleMute';
/** Opens a call's transcript in the right panel. Args: `{ callId: string, sessionId?: string }`. */
export const OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID = 'volt.voiceChat.openTranscript';
export const SET_VOICE_CHAT_KEY_COMMAND_ID = 'volt.voiceChat.setKey';

export const VOICE_CALL_TRANSCRIPT_INPUT_ID = 'workbench.input.voltVoiceCallTranscript';
export const VOICE_CALL_TRANSCRIPT_EDITOR_ID = 'workbench.editor.voltVoiceCallTranscript';

/** A voice call is running in this window. */
export const VoiceChatActiveContext = new RawContextKey<boolean>('voltVoiceChatActive', false);

export const VOICE_CHAT_PROVIDER_SETTING = 'volt.voiceChat.provider';
export const VOICE_CHAT_VOICE_SETTING = 'volt.voiceChat.voice';
export const VOICE_CHAT_SPEED_SETTING = 'volt.voiceChat.speed';
export const VOICE_CHAT_LANGUAGE_SETTING = 'volt.voiceChat.language';
export const VOICE_CHAT_CUSTOM_URL_SETTING = 'volt.voiceChat.customUrl';
export const VOICE_CHAT_ENABLED_SETTING = 'volt.voiceChat.enabled';

/** Speeds the call offers. */
export const VOICE_CHAT_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 2];
