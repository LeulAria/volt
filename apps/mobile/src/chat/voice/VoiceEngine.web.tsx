/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { VOICE_ENGINE_HTML } from './engineHtml';
import type { IVoiceEngineHandle, IVoiceEngineProps, VoiceEngineCommand, VoiceEngineMessage } from './VoiceEngine';

export type { IVoiceEngineHandle, IVoiceEngineProps, VoiceEngineCommand, VoiceEngineMessage } from './VoiceEngine';

export async function ensureMicPermission(): Promise<boolean> {
	return true;
}

/** The browser build of {@link VoiceEngine}: the same page in a hidden iframe allowed the microphone. */
export const VoiceEngine = forwardRef<IVoiceEngineHandle, IVoiceEngineProps>(function VoiceEngine({ onMessage }, ref) {
	const frame = useRef<HTMLIFrameElement | null>(null);
	const loaded = useRef(false);
	const queue = useRef<VoiceEngineCommand[]>([]);
	const latest = useRef(onMessage);
	latest.current = onMessage;
	const deliver = (command: VoiceEngineCommand) => frame.current?.contentWindow?.postMessage({ voltVoiceCmd: command }, '*');
	useImperativeHandle(ref, () => ({
		send: command => {
			if (loaded.current) {
				deliver(command);
			} else {
				queue.current.push(command);
			}
		},
	}));
	useEffect(() => {
		const listener = (event: MessageEvent) => {
			const text = (event.data as { voltVoice?: unknown } | undefined)?.voltVoice;
			if (!frame.current || event.source !== frame.current.contentWindow || typeof text !== 'string') {
				return;
			}
			let message: VoiceEngineMessage;
			try {
				message = JSON.parse(text) as VoiceEngineMessage;
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
			latest.current(message);
		};
		window.addEventListener('message', listener);
		return () => window.removeEventListener('message', listener);
	}, []);
	return createElement('iframe', {
		ref: frame,
		srcDoc: VOICE_ENGINE_HTML,
		allow: 'microphone; autoplay',
		title: 'Voice chat audio',
		style: { position: 'absolute', width: 1, height: 1, opacity: 0, border: 0, pointerEvents: 'none' },
	});
});
