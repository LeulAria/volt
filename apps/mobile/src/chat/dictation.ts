/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';

/**
 * Dictation into the composer, as the desktop's mic does: the system's speech recognizer
 * (expo-speech-recognition: Apple's on iOS, Google's on Android, the Web Speech API in a
 * browser) writes what it hears into the text box while you speak. Expo Go has no such native
 * module: the mic is hidden there.
 */

interface ISubscription { remove(): void }

interface ISpeechModule {
	start(options: Record<string, unknown>): void;
	stop(): void;
	abort(): void;
	requestPermissionsAsync(): Promise<{ granted: boolean; canAskAgain?: boolean }>;
	isRecognitionAvailable(): boolean;
	addListener(event: string, listener: (event: never) => void): ISubscription;
}

let cached: ISpeechModule | null | undefined;

function speechModule(): ISpeechModule | undefined {
	if (cached === undefined) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			cached = (require('expo-speech-recognition') as { ExpoSpeechRecognitionModule: ISpeechModule }).ExpoSpeechRecognitionModule ?? null;
			if (cached && !cached.isRecognitionAvailable()) {
				cached = null;
			}
		} catch {
			cached = null;
		}
	}
	return cached ?? undefined;
}

export function dictationAvailable(): boolean {
	return !!speechModule();
}

export interface IDictation {
	readonly available: boolean;
	readonly listening: boolean;
	/** Starts listening; `base` is the text already in the box, which the words are added to. */
	start(base: string): Promise<void>;
	stop(): void;
}

/** `onText` gets the whole box's text (what was there + what was heard so far) as it changes. */
export function useDictation(onText: (text: string) => void): IDictation {
	const [listening, setListening] = useState(false);
	const base = useRef('');
	const committed = useRef('');
	const textRef = useRef(onText);
	textRef.current = onText;
	const subs = useRef<ISubscription[]>([]);

	const detach = useCallback(() => {
		subs.current.forEach(sub => sub.remove());
		subs.current = [];
	}, []);

	useEffect(() => () => {
		detach();
		speechModule()?.abort();
	}, [detach]);

	const start = useCallback(async (current: string) => {
		const module = speechModule();
		if (!module) {
			return;
		}
		const permission = await module.requestPermissionsAsync().catch(() => ({ granted: false, canAskAgain: false }));
		if (!permission.granted) {
			Alert.alert('Microphone access is off', 'Allow Volt to use the microphone and speech recognition in Settings to dictate messages.', [
				{ text: 'Not now', style: 'cancel' },
				{ text: 'Open Settings', onPress: () => void Linking.openSettings() },
			]);
			return;
		}
		detach();
		base.current = current && !/\s$/.test(current) ? `${current} ` : current;
		committed.current = '';
		const join = (heard: string) => `${base.current}${committed.current}${heard}`;
		subs.current = [
			module.addListener('result', ((event: { isFinal?: boolean; results?: { transcript?: string }[] }) => {
				const heard = event.results?.[0]?.transcript ?? '';
				if (event.isFinal) {
					committed.current = `${committed.current}${heard}${heard && !/\s$/.test(heard) ? ' ' : ''}`;
					textRef.current(join(''));
				} else {
					textRef.current(join(heard));
				}
			}) as (event: never) => void),
			module.addListener('end', (() => {
				setListening(false);
				detach();
			}) as (event: never) => void),
			module.addListener('error', ((event: { error?: string; message?: string }) => {
				setListening(false);
				if (event.error && event.error !== 'aborted' && event.error !== 'no-speech') {
					Alert.alert('Dictation stopped', event.message || event.error);
				}
			}) as (event: never) => void),
		];
		try {
			module.start({ lang: 'en-US', interimResults: true, continuous: true, addsPunctuation: true, requiresOnDeviceRecognition: false });
			setListening(true);
		} catch (err) {
			detach();
			Alert.alert('Dictation is not available', err instanceof Error ? err.message : String(err));
		}
	}, [detach]);

	const stop = useCallback(() => {
		speechModule()?.stop();
		setListening(false);
	}, []);

	return { available: dictationAvailable(), listening, start, stop };
}
