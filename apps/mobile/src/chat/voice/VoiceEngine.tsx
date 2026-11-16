/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { PermissionsAndroid, Platform, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { VOICE_ENGINE_HTML } from './engineHtml';

/** What the app sends the engine page (see engineHtml.ts). */
export type VoiceEngineCommand = { readonly type: string } & Record<string, unknown>;

/** What the engine page reports. */
export type VoiceEngineMessage = { readonly type: string } & Record<string, unknown>;

export interface IVoiceEngineHandle {
	send(command: VoiceEngineCommand): void;
}

export interface IVoiceEngineProps {
	readonly onMessage: (message: VoiceEngineMessage) => void;
}

/** Asks for the microphone before the page does (Android needs RECORD_AUDIO granted to the app). */
export async function ensureMicPermission(): Promise<boolean> {
	if (Platform.OS !== 'android') {
		return true;
	}
	const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
	return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * The call's audio in a hidden WebView (engineHtml.ts): WKWebView and Android's WebView both do
 * getUserMedia and Web Audio on a secure origin, so the page is given https://localhost.
 * Commands sent before the page loaded wait for it.
 */
export const VoiceEngine = forwardRef<IVoiceEngineHandle, IVoiceEngineProps>(function VoiceEngine({ onMessage }, ref) {
	const view = useRef<WebView>(null);
	const loaded = useRef(false);
	const queue = useRef<VoiceEngineCommand[]>([]);
	const deliver = (command: VoiceEngineCommand) => view.current?.injectJavaScript(`window.__voice && window.__voice.cmd(${JSON.stringify(command)}); true;`);
	useImperativeHandle(ref, () => ({
		send: command => {
			if (loaded.current) {
				deliver(command);
			} else {
				queue.current.push(command);
			}
		},
	}));
	const onWebMessage = (event: WebViewMessageEvent) => {
		let message: VoiceEngineMessage;
		try {
			message = JSON.parse(event.nativeEvent.data) as VoiceEngineMessage;
		} catch {
			return;
		}
		if (message.type === 'loaded') {
			loaded.current = true;
			for (const command of queue.current.splice(0)) {
				deliver(command);
			}
			return;
		}
		onMessage(message);
	};
	return (
		<View pointerEvents="none" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}>
			<WebView
				ref={view}
				originWhitelist={['*']}
				source={{ html: VOICE_ENGINE_HTML, baseUrl: 'https://localhost' }}
				onMessage={onWebMessage}
				javaScriptEnabled
				mediaCapturePermissionGrantType="grant"
				allowsInlineMediaPlayback
				mediaPlaybackRequiresUserAction={false}
				style={{ width: 1, height: 1, backgroundColor: 'transparent' }}
			/>
		</View>
	);
});
