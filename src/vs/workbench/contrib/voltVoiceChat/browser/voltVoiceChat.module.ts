/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltVoiceChatService, VoltVoiceProvider } from '../../../../platform/voltVoiceChat/common/voltVoiceChat.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVoltAgentWindowService } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import {
	END_VOICE_CHAT_COMMAND_ID, OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID, SET_VOICE_CHAT_KEY_COMMAND_ID, START_VOICE_CHAT_COMMAND_ID, TOGGLE_VOICE_CHAT_MUTE_COMMAND_ID,
	VOICE_CALL_TRANSCRIPT_INPUT_ID, VOICE_CHAT_FEATURE_ID,
} from '../common/voltVoiceChat.js';
import { VoiceCallCards } from './voiceCallCard.js';
import { setActiveVoiceCallService, VoiceCallService } from './voiceCallService.js';
import { VoiceCallTranscriptEditor, VoiceCallTranscriptInput, VoiceCallTranscriptSerializer } from './voiceCallTranscript.js';
import { VoiceCallTray } from './voiceCallTray.js';
import { renderVoiceSettingsPage } from './voicePage.js';
import { setVoiceKey } from './voiceKey.js';
import { VoicePreviewPlayer } from './voicePreview.js';

function readArgs(value: unknown): { readonly sessionId?: string; readonly callId?: string } {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	return {
		...(typeof raw.sessionId === 'string' && raw.sessionId ? { sessionId: raw.sessionId } : {}),
		...(typeof raw.callId === 'string' && raw.callId ? { callId: raw.callId } : {}),
	};
}

/**
 * Voice chat, a module of the `volt.voice-chat` built-in extension: Start voice chat in the
 * composer (core draws the button and runs `volt.voiceChat.start`, which loads this), the call's
 * tray above the composer, its card in the chat, its transcript tab and Settings > Voice.
 * Disabling the extension hangs up and removes all of it.
 */
class VoiceChatModule implements IVoltFeatureModule {

	activate(host: IVoltFeatureModuleHost): void {
		const { subscriptions, instantiationService } = host;
		const service = subscriptions.add(instantiationService.createInstance(VoiceCallService));
		setActiveVoiceCallService(service);
		subscriptions.add({ dispose: () => setActiveVoiceCallService(undefined) });
		const preview = subscriptions.add(instantiationService.createInstance(VoicePreviewPlayer));

		instantiationService.invokeFunction(accessor => {
			const agentWindow = accessor.get(IVoltAgentWindowService);
			subscriptions.add(agentWindow.registerComposerTray(VOICE_CHAT_FEATURE_ID, trayHost => instantiationService.createInstance(VoiceCallTray, trayHost, service, preview)));
			subscriptions.add(agentWindow.registerThreadCards(subscriptions.add(instantiationService.createInstance(VoiceCallCards, service))));
		});

		subscriptions.add(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(VoiceCallTranscriptEditor, VoiceCallTranscriptEditor.ID, localize('voiceChat.transcriptEditor', "Voice call")),
			[new SyncDescriptor(VoiceCallTranscriptInput)],
		));
		host.registerEditorSerializer(VOICE_CALL_TRANSCRIPT_INPUT_ID, new VoiceCallTranscriptSerializer());

		subscriptions.add(CommandsRegistry.registerCommand(START_VOICE_CHAT_COMMAND_ID, (_accessor, args) => service.start(readArgs(args).sessionId), 'internal'));
		subscriptions.add(CommandsRegistry.registerCommand(END_VOICE_CHAT_COMMAND_ID, () => service.hangUp('hang_up'), 'internal'));
		subscriptions.add(CommandsRegistry.registerCommand(TOGGLE_VOICE_CHAT_MUTE_COMMAND_ID, () => service.setMuted(!service.state.muted), 'internal'));
		subscriptions.add(CommandsRegistry.registerCommand(OPEN_VOICE_CALL_TRANSCRIPT_COMMAND_ID, async (accessor, args) => {
			const { callId, sessionId } = readArgs(args);
			if (!callId) {
				return;
			}
			const editorService = accessor.get(IEditorService);
			const agentWindow = accessor.get(IVoltAgentWindowService);
			const existing = editorService.editors.find(editor => editor instanceof VoiceCallTranscriptInput && editor.callId === callId);
			if (existing && agentWindow.revealInTools(existing)) {
				return;
			}
			const input = new VoiceCallTranscriptInput(callId, sessionId);
			const opened = agentWindow.openInTools(input, sessionId, { pinned: true });
			if (opened) {
				await opened;
			} else {
				await editorService.openEditor(input, { pinned: true });
			}
		}, 'internal'));
		subscriptions.add(CommandsRegistry.registerCommand(SET_VOICE_CHAT_KEY_COMMAND_ID, async (accessor, args) => {
			await setVoiceKey(accessor.get(IQuickInputService), accessor.get(IVoltVoiceChatService), accessor.get(INotificationService), typeof args === 'string' ? args as VoltVoiceProvider : undefined);
		}, 'internal'));

		host.registerPart('settingsKitPage', 'voice', {
			render: (pageInstantiation, kit) => pageInstantiation.invokeFunction(accessor => renderVoiceSettingsPage(accessor, kit, preview)),
		});
	}
}

export const voiceChatModule = new VoiceChatModule();
