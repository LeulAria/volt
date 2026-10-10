/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/** Arrow Up in the agent composer brings back earlier prompts, newest first; Arrow Down walks back. */
export const AGENT_PROMPT_HISTORY_SETTING = 'volt.agent.composer.promptHistory';

/** New Agent reopens the project's chat that only holds unsent text, instead of starting another empty one. */
export const AGENT_NEW_CHAT_DRAFT_SETTING = 'volt.agent.composer.restoreUnsentDraft';

/** The model a new chat starts on (a catalog ref). Empty: the model picked last. A project's own default wins. */
export const AGENT_DEFAULT_MODEL_SETTING = 'volt.agent.defaultModel';

/** Pastes this large (KiB) become a `Pasted text` attachment instead of composer text. 0 keeps them inline. */
export const AGENT_LARGE_PASTE_SETTING = 'volt.agent.composer.largePasteKB';

/** Dictation falls back to this OpenAI-compatible base URL (`/audio/transcriptions`) when on-device speech is not installed. */
export const AGENT_VOICE_ENDPOINT_SETTING = 'volt.agent.composer.voice.transcriptionEndpoint';

export const AGENT_VOICE_MODEL_SETTING = 'volt.agent.composer.voice.transcriptionModel';

/** Where dictation goes: `auto`, `openai` (realtime), `system` (the Mac's recognizer) or `endpoint`. */
export const AGENT_VOICE_ENGINE_SETTING = 'volt.agent.composer.voice.engine';

/** The OpenAI realtime transcription model dictation uses. */
export const AGENT_VOICE_REALTIME_MODEL_SETTING = 'volt.agent.composer.voice.realtimeModel';

export type AgentVoiceEngine = 'auto' | 'openai' | 'system' | 'endpoint';

/** OpenAI's realtime transcription models, fastest first. */
export const AGENT_VOICE_REALTIME_MODELS: readonly string[] = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];

export const AGENT_VOICE_DEFAULT_REALTIME_MODEL = 'gpt-4o-transcribe';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.agent.composer',
	title: localize('voltAgent.composerConfigTitle', "Agent Composer"),
	type: 'object',
	properties: {
		[AGENT_PROMPT_HISTORY_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.promptHistory', "Press Arrow Up in an empty agent composer to load your previous prompts. Arrow Down goes back to newer ones and then to the text you were typing."),
		},
		[AGENT_NEW_CHAT_DRAFT_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltAgent.restoreUnsentDraft', "When a new chat was left with text that was never sent, New Agent opens that chat again with the text still in the composer."),
		},
		[AGENT_LARGE_PASTE_SETTING]: {
			type: 'number',
			default: 32,
			minimum: 0,
			description: localize('voltAgent.largePaste', "Text pasted into the agent composer that is at least this many KB becomes a \"Pasted text\" attachment (click it to preview or turn it back into text). 0 keeps pastes inline. Cmd+Shift+V always pastes as text."),
		},
		[AGENT_VOICE_ENDPOINT_SETTING]: {
			type: 'string',
			default: '',
			description: localize('voltAgent.voiceEndpoint', "Base URL of an OpenAI-compatible speech-to-text server, such as http://localhost:8000/v1. Dictation uses it when the on-device speech model is not installed. Left empty, macOS sends dictation to Apple's speech service in that case."),
		},
		[AGENT_VOICE_MODEL_SETTING]: {
			type: 'string',
			default: 'whisper-1',
			description: localize('voltAgent.voiceModel', "The transcription model sent to the speech-to-text endpoint."),
		},
		[AGENT_VOICE_ENGINE_SETTING]: {
			type: 'string',
			enum: ['auto', 'openai', 'system', 'endpoint'],
			enumDescriptions: [
				localize('voltAgent.voiceEngine.auto', "OpenAI realtime transcription when an OpenAI key is set, otherwise the Mac's speech recognizer, otherwise the transcription endpoint."),
				localize('voltAgent.voiceEngine.openai', "OpenAI realtime transcription, with the model below."),
				localize('voltAgent.voiceEngine.system', "The Mac's speech recognizer: on device when its model is installed, otherwise Apple's service."),
				localize('voltAgent.voiceEngine.endpoint', "The OpenAI-compatible transcription endpoint above, such as a local Whisper server."),
			],
			default: 'auto',
			description: localize('voltAgent.voiceEngine', "Where dictation in the agent composer is transcribed."),
		},
		[AGENT_VOICE_REALTIME_MODEL_SETTING]: {
			type: 'string',
			default: AGENT_VOICE_DEFAULT_REALTIME_MODEL,
			description: localize('voltAgent.voiceRealtimeModel', "The OpenAI realtime transcription model dictation uses, such as gpt-4o-transcribe or gpt-4o-mini-transcribe."),
		},
		[AGENT_DEFAULT_MODEL_SETTING]: {
			type: 'string',
			default: '',
			description: localize('voltAgent.defaultModel', "The model new chats start on. Empty uses the model you picked last. A project's own default model wins over this."),
		},
	},
});
