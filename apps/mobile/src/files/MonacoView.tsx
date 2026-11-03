/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MONACO_THEMES } from '@volt/client-core';
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { monacoLanguage, monacoPage, monacoPayload } from './monacoPage';

export type MonacoEvent =
	| { readonly type: 'ready' }
	| { readonly type: 'error'; readonly message: string }
	| { readonly type: 'dirty'; readonly dirty: boolean }
	| { readonly type: 'text'; readonly text: string; readonly version: number };

export interface IMonacoView {
	setReadOnly(readOnly: boolean): void;
	setWrap(wrap: boolean): void;
	/** Asks for the text; it arrives as a `text` event with the version to pass to markSaved. */
	requestText(): void;
	markSaved(version: number): void;
}

/**
 * VS Code's editor for a file (or a diff, with `original`), in a WebView: the desktop's Volt
 * Dark/Light themes, its language's colours, Geist Mono, sticky scroll, and editing once
 * `setReadOnly(false)`. It starts read-only so a tap scrolls instead of raising the keyboard.
 * Monaco ships inside the app (monacoBundle.ts); an `error` event means it failed to start and
 * the caller shows its own viewer.
 */
export const MonacoView = forwardRef<IMonacoView, {
	readonly text: string;
	/** The left side: set, it shows a diff of `original` → `text` instead of the file. */
	readonly original?: string;
	readonly language: string;
	readonly dark: boolean;
	readonly background: string;
	readonly lineColor: string;
	readonly wrap: boolean;
	readonly line?: number;
	readonly onEvent: (event: MonacoEvent) => void;
}>(function MonacoView({ text, original, language, dark, background, lineColor, wrap, line, onEvent }, ref) {
	const web = useRef<WebView>(null);
	// The page is built once per file: later changes (wrap, editing) go through the handle, not a reload.
	const html = useMemo(() => monacoPage({ text, original, language: monacoLanguage(language), line, wrap, lineColor, theme: dark ? 'volt-dark' : 'volt-light', themes: MONACO_THEMES }, background),
		[text, original, language, dark]);
	const run = (js: string) => web.current?.injectJavaScript(`window.volt && ${js}; true;`);
	useImperativeHandle(ref, () => ({
		setReadOnly: readOnly => run(`window.volt.readOnly(${readOnly})`),
		setWrap: on => run(`window.volt.wrap(${on})`),
		requestText: () => run('window.volt.text()'),
		markSaved: version => run(`window.volt.saved(${Number(version)})`),
	}), []);
	const onMessage = (e: WebViewMessageEvent) => {
		try {
			onEvent(JSON.parse(e.nativeEvent.data) as MonacoEvent);
		} catch {
			// Not ours.
		}
	};
	return (
		<WebView
			ref={web}
			originWhitelist={['*']}
			source={{ html, baseUrl: 'https://volt.local/' }}
			onMessage={onMessage}
			onLoadEnd={() => web.current?.injectJavaScript(monacoPayload())}
			onShouldStartLoadWithRequest={request => request.url.startsWith('https://volt.local') || request.url === 'about:blank'}
			javaScriptEnabled
			bounces={false}
			overScrollMode="never"
			scrollEnabled={false}
			hideKeyboardAccessoryView
			keyboardDisplayRequiresUserAction={false}
			setSupportMultipleWindows={false}
			style={{ flex: 1, backgroundColor: background }}
			containerStyle={{ flex: 1, backgroundColor: background }}
		/>
	);
});

