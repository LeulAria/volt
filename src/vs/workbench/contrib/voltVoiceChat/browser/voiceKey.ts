/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IVoltVoiceChatService, VOLT_VOICE_PROVIDER_INFO, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';

/** Asks for the provider (unless given) and its API key, and saves it on this computer. */
export async function setVoiceKey(quickInput: IQuickInputService, voiceService: IVoltVoiceChatService, notifications: INotificationService, given?: VoltVoiceProvider): Promise<boolean> {
	let provider = given;
	if (!provider) {
		const pick = await quickInput.pick([
			{ id: 'xai', label: VOLT_VOICE_PROVIDER_INFO.xai.label, description: 'console.x.ai' },
			{ id: 'openai', label: VOLT_VOICE_PROVIDER_INFO.openai.label, description: 'platform.openai.com' },
		], { placeHolder: localize('voiceChat.pickProvider', "Which voice provider is the key for?") });
		provider = pick?.id as VoltVoiceProvider | undefined;
	}
	if (!provider) {
		return false;
	}
	const key = await quickInput.input({
		password: true,
		placeHolder: provider === 'xai' ? 'xai-…' : 'sk-…',
		prompt: localize('voiceChat.keyPrompt', "{0} API key. It stays on this computer; each call gets a short-lived secret from it.", VOLT_VOICE_PROVIDER_INFO[provider].label),
		validateInput: async value => value.trim() && /\s/.test(value.trim()) ? localize('voiceChat.keyInvalid', "An API key has no spaces.") : undefined,
	});
	if (key === undefined) {
		return false;
	}
	try {
		await voiceService.setKey(provider, key.trim() || undefined);
		return true;
	} catch (err) {
		notifications.error(err instanceof Error ? err.message : String(err));
		return false;
	}
}
