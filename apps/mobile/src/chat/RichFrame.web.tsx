/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createElement, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/theme';
import type { IRichFrameProps } from './RichFrame';

export type { IRichFrameProps } from './RichFrame';

/** The browser build of {@link RichFrame}: a sandboxed iframe with the page as its `srcdoc`. */
export function RichFrame({ html, initialHeight, maxHeight = 2000, fill, style, onHeight, onPrompt }: IRichFrameProps) {
	const { dark } = useTheme();
	const ref = useRef<HTMLIFrameElement | null>(null);
	const [height, setHeight] = useState(initialHeight);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!ref.current || event.source !== ref.current.contentWindow) {
				return;
			}
			const message = event.data as { type?: string; height?: number; href?: string; text?: string } | undefined;
			if (message?.type === 'volt-frame-height' && typeof message.height === 'number') {
				const next = Math.min(maxHeight, Math.max(24, Math.ceil(message.height)));
				setHeight(next);
				onHeight?.(next);
			} else if (message?.type === 'volt-open' && message.href && /^(https?:|mailto:)/i.test(message.href)) {
				window.open(message.href, '_blank', 'noopener');
			} else if ((message?.type === 'volt-prompt' || message?.type === 'volt-send') && typeof message.text === 'string') {
				onPrompt?.(message.text, message.type === 'volt-send');
			}
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [maxHeight, onHeight, onPrompt]);
	const frame = createElement('iframe', {
		ref,
		srcDoc: html,
		// Scripts run, but the page gets no access to the app's origin, storage or cookies.
		sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
		style: { border: 0, width: '100%', height: fill ? '100%' : height, display: 'block', background: 'transparent', colorScheme: dark ? 'dark' : 'light' },
		// Chrome paints a frame opaque when its color scheme differs from the page's inside it: they match, so it stays see-through.
		scrolling: fill ? 'auto' : 'no',
		title: 'Visual',
	});
	return <View style={[fill ? { flex: 1 } : { height }, styles.box, style]}>{frame}</View>;
}

const styles = StyleSheet.create({
	box: { width: '100%', overflow: 'hidden' },
});
