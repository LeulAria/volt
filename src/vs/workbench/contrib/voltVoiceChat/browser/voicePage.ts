/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IVoltVoiceChatService, IVoltVoiceKeyStatus, VOLT_VOICE_PROVIDER_INFO, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { IVoltSettingsPageKit } from '../../voltCustomize/browser/voltFeatureModules.js';
import {
	VOICE_CHAT_CUSTOM_URL_SETTING, VOICE_CHAT_ENABLED_SETTING, VOICE_CHAT_LANGUAGE_SETTING, VOICE_CHAT_PROVIDER_SETTING, VOICE_CHAT_SPEED_SETTING, VOICE_CHAT_SPEEDS, VOICE_CHAT_VOICE_SETTING,
} from '../common/voltVoiceChat.js';
import { speedLabel, VOICE_LANGUAGES, voiceLabel } from './voiceSettings.js';
import { setVoiceKey } from './voiceKey.js';
import { VoicePreviewPlayer } from './voicePreview.js';

let keyStatus: readonly IVoltVoiceKeyStatus[] | undefined;

/**
 * Settings > Voice (Cursor's Voice tab, plus the provider and its key, which Cursor's own
 * backend hides): who hears and speaks, its API key, the default voice with a sample, speed,
 * language, and the composer button.
 */
export function renderVoiceSettingsPage(accessor: ServicesAccessor, kit: IVoltSettingsPageKit, preview: VoicePreviewPlayer): void {
	const configuration = accessor.get(IConfigurationService);
	const contextView = accessor.get(IContextViewService);
	const voiceService = accessor.get(IVoltVoiceChatService);
	const quickInput = accessor.get(IQuickInputService);
	const notifications = accessor.get(INotificationService);
	const store = kit.store;
	const set = (key: string, value: unknown) => void configuration.updateValue(key, value).then(() => kit.rerender());

	kit.pageHead(localize('voiceChat.pageTitle', "Voice"), localize('voiceChat.pageLead', "Talk to your agents on a live call: Start voice chat (the waveform in an empty composer). The voice sends work to the chat, steers it while it runs, and tells you what came back."));

	if (!keyStatus) {
		void voiceService.keyStatus().then(status => {
			keyStatus = status;
			if (kit.isCurrent()) {
				kit.rerender();
			}
		}, () => undefined);
	}
	const configured = configuration.getValue<string>(VOICE_CHAT_PROVIDER_SETTING) || 'auto';
	const statusOf = (provider: VoltVoiceProvider) => keyStatus?.find(entry => entry.provider === provider);
	const effective: VoltVoiceProvider = configured === 'xai' || configured === 'openai' || configured === 'custom' ? configured : statusOf('openai')?.source && !statusOf('xai')?.source ? 'openai' : 'xai';

	kit.sectionLabel(localize('voiceChat.provider', "Provider"));
	const providerGroup = kit.settingsGroup();
	kit.settingRow(providerGroup, localize('voiceChat.providerTitle', "Voice Model"), localize('voiceChat.providerDesc', "The speech-to-speech model you talk to. Calls cost about $0.08 a minute on xAI."), host => {
		createVoltDropdown(host, contextView, {
			options: [
				{ id: 'auto', label: localize('voiceChat.auto', "Automatic"), description: localize('voiceChat.autoDesc', "xAI when it has a key, otherwise OpenAI") },
				{ id: 'xai', label: VOLT_VOICE_PROVIDER_INFO.xai.label, description: 'grok-voice-latest' },
				{ id: 'openai', label: VOLT_VOICE_PROVIDER_INFO.openai.label, description: 'gpt-realtime' },
				{ id: 'custom', label: VOLT_VOICE_PROVIDER_INFO.custom.label, description: localize('voiceChat.customDesc', "Any server that speaks the realtime protocol") },
			],
			value: configured,
			ariaLabel: localize('voiceChat.providerTitle', "Voice Model"),
			onChange: id => set(VOICE_CHAT_PROVIDER_SETTING, id),
		}, store);
	});
	for (const provider of ['xai', 'openai'] as const) {
		const status = statusOf(provider);
		const desc = !keyStatus ? localize('voiceChat.keyChecking', "Checking…")
			: status?.source === 'saved' ? localize('voiceChat.keySaved', "Saved on this computer.")
				: status?.source === 'env' ? localize('voiceChat.keyEnv', "From {0} in your shell.", status.envKey ?? '')
					: localize('voiceChat.keyMissing', "Not set. Get one at {0}.", VOLT_VOICE_PROVIDER_INFO[provider].keyUrl ?? '');
		kit.settingRow(providerGroup, localize('voiceChat.keyTitle', "{0} API Key", provider === 'xai' ? 'xAI' : 'OpenAI'), desc, host => {
			const add = createVoltButton(host, status?.source === 'saved' ? 'secondary' : 'primary');
			add.label = status?.source === 'saved' ? localize('voiceChat.replaceKey', "Replace Key") : localize('voiceChat.addKey', "Add Key");
			store.add(add);
			store.add(add.onDidClick(async () => {
				if (await setVoiceKey(quickInput, voiceService, notifications, provider)) {
					keyStatus = undefined;
					kit.rerender();
				}
			}));
			if (status?.source === 'saved') {
				const remove = createVoltButton(host, 'ghost');
				remove.label = localize('voiceChat.removeKey', "Remove");
				store.add(remove);
				store.add(remove.onDidClick(async () => {
					await voiceService.setKey(provider, undefined);
					keyStatus = undefined;
					kit.rerender();
				}));
			}
		});
	}
	if (configured === 'custom') {
		kit.settingRow(providerGroup, localize('voiceChat.customUrl', "Server URL"), localize('voiceChat.customUrlDesc', "The ws:// or wss:// address of the realtime server."), host => {
			const input = append(host, $('input.volt-voice-url')) as HTMLInputElement;
			input.type = 'text';
			input.spellcheck = false;
			input.placeholder = 'ws://127.0.0.1:8080/v1/realtime';
			input.value = configuration.getValue<string>(VOICE_CHAT_CUSTOM_URL_SETTING) ?? '';
			input.addEventListener('change', () => void configuration.updateValue(VOICE_CHAT_CUSTOM_URL_SETTING, input.value.trim()));
		});
	}

	kit.sectionLabel(localize('voiceChat.voiceSection', "Voice"));
	const group = kit.settingsGroup();
	const voices = VOLT_VOICE_PROVIDER_INFO[effective === 'custom' ? 'xai' : effective].voices;
	const currentVoice = configuration.getValue<string>(VOICE_CHAT_VOICE_SETTING) || VOLT_VOICE_PROVIDER_INFO[effective].defaultVoice;
	const speed = Number(configuration.getValue(VOICE_CHAT_SPEED_SETTING)) || 1;
	kit.settingRow(group, localize('voiceChat.agentVoice', "Agent Voice"), localize('voiceChat.agentVoiceDesc', "Default voice for voice chats. Changing the voice plays a short sample."), host => {
		createVoltDropdown(host, contextView, {
			options: voices.map(id => ({ id, label: voiceLabel(id) })),
			value: voices.includes(currentVoice) ? currentVoice : voices[0],
			ariaLabel: localize('voiceChat.agentVoice', "Agent Voice"),
			onChange: id => {
				set(VOICE_CHAT_VOICE_SETTING, id);
				if (effective !== 'custom') {
					void preview.toggle(effective, id, speed).catch(err => notifications.error(err instanceof Error ? err.message : String(err)));
				}
			},
		}, store);
		const play = createVoltButton(host, 'secondary', { supportIcons: true });
		const playLabel = () => preview.playing ? `$(debug-stop) ${localize('voiceChat.stopSampleShort', "Stop")}` : `$(play) ${localize('voiceChat.playSampleShort', "Play Sample")}`;
		play.label = playLabel();
		setAgentTooltip(play.element, localize('voiceChat.playSample', "Play voice sample"));
		store.add(play);
		store.add(play.onDidClick(() => {
			if (effective !== 'custom') {
				void preview.toggle(effective, currentVoice, speed).catch(err => notifications.error(err instanceof Error ? err.message : String(err)));
			}
		}));
		store.add(preview.onDidChange(() => play.label = playLabel()));
	});
	kit.settingRow(group, localize('voiceChat.speed', "Speed"), localize('voiceChat.speedDesc', "How quickly the voice speaks in voice chats."), host => {
		createVoltDropdown(host, contextView, {
			options: VOICE_CHAT_SPEEDS.map(value => ({ id: String(value), label: speedLabel(value) })),
			value: String([...VOICE_CHAT_SPEEDS].includes(speed) ? speed : 1),
			ariaLabel: localize('voiceChat.speed', "Speed"),
			onChange: id => set(VOICE_CHAT_SPEED_SETTING, Number(id)),
		}, store);
	});
	kit.settingRow(group, localize('voiceChat.language', "Language"), localize('voiceChat.languageDesc', "Language used in voice chats."), host => {
		createVoltDropdown(host, contextView, {
			options: VOICE_LANGUAGES.map(language => ({ id: language.id, label: language.label })),
			value: configuration.getValue<string>(VOICE_CHAT_LANGUAGE_SETTING) || 'auto',
			ariaLabel: localize('voiceChat.language', "Language"),
			onChange: id => set(VOICE_CHAT_LANGUAGE_SETTING, id),
		}, store);
	});
	const enabled = configuration.getValue<boolean>(VOICE_CHAT_ENABLED_SETTING) !== false;
	kit.settingRow(group, localize('voiceChat.button', "Start Voice Chat Button"), localize('voiceChat.buttonDesc', "Show the waveform button in an empty composer."), host => kit.toggle(host, enabled, localize('voiceChat.button', "Start Voice Chat Button"), () => set(VOICE_CHAT_ENABLED_SETTING, !enabled)));
}
