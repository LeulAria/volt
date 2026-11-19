/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { VOLT_VOICE_PROVIDER_INFO, VOLT_VOICE_SPEEDS, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { IVoltMenuHandle, IVoltMenuItem, showVoltMenu } from '../../voltAgent/browser/ui/menu/voltMenu.js';

/** The languages Cursor's voice chat offers (`auto` detects). */
export const VOICE_LANGUAGES: readonly { readonly id: string; readonly label: string }[] = [
	{ id: 'auto', label: 'Auto-detect' }, { id: 'en', label: 'English' }, { id: 'ar-EG', label: 'Arabic (Egypt)' }, { id: 'ar-SA', label: 'Arabic (Saudi Arabia)' },
	{ id: 'ar-AE', label: 'Arabic (United Arab Emirates)' }, { id: 'bn', label: 'Bengali' }, { id: 'ca', label: 'Catalan' }, { id: 'zh', label: 'Chinese (Simplified)' },
	{ id: 'da', label: 'Danish' }, { id: 'nl', label: 'Dutch' }, { id: 'fi', label: 'Finnish' }, { id: 'fr', label: 'French' }, { id: 'de', label: 'German' },
	{ id: 'hi', label: 'Hindi' }, { id: 'hu', label: 'Hungarian' }, { id: 'id', label: 'Indonesian' }, { id: 'it', label: 'Italian' }, { id: 'ja', label: 'Japanese' },
	{ id: 'ko', label: 'Korean' }, { id: 'pl', label: 'Polish' }, { id: 'pt-BR', label: 'Portuguese (Brazil)' }, { id: 'pt-PT', label: 'Portuguese (Portugal)' },
	{ id: 'ru', label: 'Russian' }, { id: 'es-MX', label: 'Spanish (Mexico)' }, { id: 'es-ES', label: 'Spanish (Spain)' }, { id: 'sv', label: 'Swedish' },
	{ id: 'th', label: 'Thai' }, { id: 'tr', label: 'Turkish' }, { id: 'vi', label: 'Vietnamese' },
];

export function voiceLanguageLabel(id: string): string {
	return VOICE_LANGUAGES.find(language => language.id === id)?.label ?? id;
}

/** "ara" → "Ara". */
export function voiceLabel(id: string): string {
	return id ? id[0].toUpperCase() + id.slice(1) : id;
}

export function speedLabel(speed: number): string {
	return `${speed}x`;
}

export interface IVoiceSettingsValue {
	readonly voice: string;
	readonly speed: number;
	readonly language: string;
}

type VoicePick =
	| { readonly kind: 'voice'; readonly id: string }
	| { readonly kind: 'preview'; readonly id: string }
	| { readonly kind: 'speed'; readonly value: number }
	| { readonly kind: 'language'; readonly id: string };

/**
 * The call's settings menu (Cursor's tray gear): Voice (searchable, a play button per voice),
 * Speed and Language flyouts, each with a check on the current value.
 */
export function showVoiceSettingsMenu(contextViewService: IContextViewService, options: {
	readonly anchor: HTMLElement;
	readonly provider: VoltVoiceProvider;
	readonly value: IVoiceSettingsValue;
	readonly playingPreview?: string;
	readonly onChange: (next: Partial<IVoiceSettingsValue>) => void;
	readonly onPreview: (voice: string) => void;
	readonly onHide?: () => void;
}): IVoltMenuHandle {
	const { value } = options;
	const voices = VOLT_VOICE_PROVIDER_INFO[options.provider].voices;
	const voiceItems = (): IVoltMenuItem<VoicePick>[] => voices.map(id => ({
		id: `voice-${id}`,
		label: voiceLabel(id),
		checked: id === value.voice,
		data: { kind: 'voice', id },
		action: {
			icon: options.playingPreview === id ? Codicon.debugPause : Codicon.play,
			tooltip: options.playingPreview === id
				? localize('voiceChat.stopPreview', "Stop the {0} preview", voiceLabel(id))
				: localize('voiceChat.playPreview', "Play the {0} preview", voiceLabel(id)),
			data: { kind: 'preview', id },
			keepOpen: true,
		},
	}));
	return showVoltMenu<VoicePick>(contextViewService, {
		anchor: options.anchor,
		position: 'above',
		align: 'right',
		gap: 6,
		width: 260,
		ariaLabel: localize('voiceChat.settingsMenu', "Voice chat settings"),
		className: 'volt-voice-settings-menu',
		sections: [{
			id: 'settings',
			items: [
				{
					id: 'voice', label: localize('voiceChat.voice', "Voice"), detail: voiceLabel(value.voice), data: { kind: 'voice', id: value.voice },
					submenu: {
						search: { placeholder: localize('voiceChat.searchVoice', "Search…"), ariaLabel: localize('voiceChat.searchVoiceAria', "Search Voice"), icon: true },
						emptyMessage: localize('voiceChat.noMatches', "No matches"),
						maxListHeight: 400,
						width: 220,
						sections: [{ id: 'voices', items: voiceItems() }],
					},
				},
				{
					id: 'speed', label: localize('voiceChat.speed', "Speed"), detail: speedLabel(value.speed), data: { kind: 'speed', value: value.speed },
					submenu: {
						width: 140,
						sections: [{ id: 'speeds', items: VOLT_VOICE_SPEEDS.map(speed => ({ id: `speed-${speed}`, label: speedLabel(speed), checked: speed === value.speed, data: { kind: 'speed' as const, value: speed } })) }],
					},
				},
				{
					id: 'language', label: localize('voiceChat.language', "Language"), detail: voiceLanguageLabel(value.language), data: { kind: 'language', id: value.language },
					submenu: {
						search: { placeholder: localize('voiceChat.searchLanguage', "Search…"), ariaLabel: localize('voiceChat.searchLanguageAria', "Search Language"), icon: true },
						emptyMessage: localize('voiceChat.noMatches', "No matches"),
						maxListHeight: 400,
						width: 240,
						sections: [{ id: 'languages', items: VOICE_LANGUAGES.map(language => ({ id: `lang-${language.id}`, label: language.label, checked: language.id === value.language, data: { kind: 'language' as const, id: language.id } })) }],
					},
				},
			],
		}],
		onPick: item => {
			const pick = item.data;
			switch (pick.kind) {
				case 'voice': options.onChange({ voice: pick.id }); break;
				case 'preview': options.onPreview(pick.id); break;
				case 'speed': options.onChange({ speed: pick.value }); break;
				case 'language': options.onChange({ language: pick.id }); break;
			}
		},
		onHide: options.onHide,
	});
}
