/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { XAI_VOICES } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import {
	VOICE_CHAT_CUSTOM_URL_SETTING, VOICE_CHAT_ENABLED_SETTING, VOICE_CHAT_LANGUAGE_SETTING, VOICE_CHAT_PROVIDER_SETTING, VOICE_CHAT_SPEED_SETTING, VOICE_CHAT_SPEEDS, VOICE_CHAT_VOICE_SETTING,
} from './voltVoiceChat.js';

/** Voice chat's settings: core registers them so they exist (and show in Settings) before the module loads. */
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'voltVoiceChat',
	title: localize('voiceChat.settingsTitle', "Voice Chat"),
	type: 'object',
	properties: {
		[VOICE_CHAT_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voiceChat.enabled', "Show Start voice chat (the waveform button) in an empty composer."),
		},
		[VOICE_CHAT_PROVIDER_SETTING]: {
			type: 'string',
			enum: ['auto', 'xai', 'openai', 'custom', 'local'],
			enumDescriptions: [
				localize('voiceChat.provider.auto', "xAI when it has a key, then OpenAI, otherwise this computer."),
				localize('voiceChat.provider.xai', "xAI's Grok Voice Agent API (grok-voice-latest)."),
				localize('voiceChat.provider.openai', "OpenAI's Realtime API (gpt-realtime)."),
				localize('voiceChat.provider.custom', "A server at the URL below that speaks the same realtime protocol."),
				localize('voiceChat.provider.local', "This computer: dictation hears you, the chat's agent answers, and the Read Aloud voice speaks. Free and needs no key; you take turns."),
			],
			default: 'auto',
			description: localize('voiceChat.provider', "Who hears and speaks in voice chats. The API key stays on this computer; each call gets a short-lived secret."),
		},
		[VOICE_CHAT_VOICE_SETTING]: {
			type: 'string',
			default: 'ara',
			enum: [...XAI_VOICES, 'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'],
			description: localize('voiceChat.voice', "Default voice for voice chats."),
		},
		[VOICE_CHAT_SPEED_SETTING]: {
			type: 'number',
			enum: [...VOICE_CHAT_SPEEDS],
			default: 1,
			description: localize('voiceChat.speed', "How quickly the voice speaks in voice chats."),
		},
		[VOICE_CHAT_LANGUAGE_SETTING]: {
			type: 'string',
			default: 'auto',
			description: localize('voiceChat.language', "Language used in voice chats: auto, or a code such as en, de or pt-BR."),
		},
		[VOICE_CHAT_CUSTOM_URL_SETTING]: {
			type: 'string',
			default: '',
			description: localize('voiceChat.customUrl', "The ws:// or wss:// URL of a custom realtime voice server (provider: custom)."),
		},
	},
});
