/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { Linking, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

export interface IRichFrameProps {
	/** A complete document from the server (render.visual / render.mermaid / render.math). */
	readonly html: string;
	/** Where relative URLs in the page resolve (the server's origin). */
	readonly baseUrl?: string;
	/** Height before the page reports its own. */
	readonly initialHeight: number;
	readonly maxHeight?: number;
	/** Full screen: the page scrolls inside the frame instead of growing it. */
	readonly fill?: boolean;
	readonly style?: StyleProp<ViewStyle>;
	readonly onHeight?: (height: number) => void;
	/** The page asked to fill in the composer (`volt.prompt`) or send (`volt.send`). */
	readonly onPrompt?: (text: string, send: boolean) => void;
}

interface IFrameMessage {
	readonly type?: string;
	readonly height?: number;
	readonly href?: string;
	readonly text?: string;
}

/**
 * A server-drawn page in a WebView, sized to its content: the page posts its height (see
 * serverRender.ts `bridgeScript`), links open in the browser, and nothing navigates the frame away.
 */
export function RichFrame({ html, baseUrl, initialHeight, maxHeight = 2000, fill, style, onHeight, onPrompt }: IRichFrameProps) {
	const [height, setHeight] = useState(initialHeight);
	const onMessage = (event: WebViewMessageEvent) => {
		let message: IFrameMessage;
		try {
			message = JSON.parse(event.nativeEvent.data) as IFrameMessage;
		} catch {
			return;
		}
		if (message.type === 'volt-frame-height' && typeof message.height === 'number') {
			const next = Math.min(maxHeight, Math.max(24, Math.ceil(message.height)));
			setHeight(next);
			onHeight?.(next);
		} else if (message.type === 'volt-open' && message.href && /^(https?:|mailto:)/i.test(message.href)) {
			void Linking.openURL(message.href).catch(() => undefined);
		} else if ((message.type === 'volt-prompt' || message.type === 'volt-send') && typeof message.text === 'string') {
			onPrompt?.(message.text, message.type === 'volt-send');
		}
	};
	return (
		<WebView
			originWhitelist={['*']}
			source={{ html, ...(baseUrl ? { baseUrl } : {}) }}
			onMessage={onMessage}
			onShouldStartLoadWithRequest={request => {
				// The page itself (about:blank / the base URL) loads; any other navigation opens outside.
				if (request.url === 'about:blank' || request.url.startsWith('data:') || (baseUrl && request.url.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''))) {
					return true;
				}
				if (/^(https?:|mailto:)/i.test(request.url)) {
					void Linking.openURL(request.url).catch(() => undefined);
				}
				return false;
			}}
			scrollEnabled={!!fill}
			nestedScrollEnabled={!!fill}
			showsVerticalScrollIndicator={!!fill}
			showsHorizontalScrollIndicator={false}
			bounces={false}
			overScrollMode="never"
			javaScriptEnabled
			domStorageEnabled={false}
			allowsInlineMediaPlayback
			setSupportMultipleWindows={false}
			style={[{ backgroundColor: 'transparent' }, fill ? { flex: 1 } : { height }, style]}
			containerStyle={fill ? { flex: 1 } : { height }}
		/>
	);
}
