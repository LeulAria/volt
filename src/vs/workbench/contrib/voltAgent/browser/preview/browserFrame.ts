/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The preview's page in a browser tab, where Electron's `<webview>` does not exist: an iframe that
 * answers the same calls and events the preview uses to show a page (load, back and forward,
 * reload, title, loading state). Scripting the page, input automation, screenshots and devtools
 * stay with the desktop app (the preview checks for those before it calls them).
 *
 * A page on the server's own machine (`localhost:5173`) is asked for at the address this page came
 * from when the browser is elsewhere (a phone on the Wi-Fi), so a dev server listening on the
 * network shows up there too.
 */
export function createBrowserFrame(doc: Document): HTMLElement {
	const frame = doc.createElement('iframe');
	frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
	frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen; camera; microphone; geolocation');
	frame.setAttribute('referrerpolicy', 'no-referrer');
	frame.style.border = '0';

	const history: string[] = [];
	let index = -1;
	let current = 'about:blank';
	let loading = false;

	const emit = (type: string, detail: Record<string, unknown> = {}) => {
		frame.dispatchEvent(Object.assign(new Event(type), detail));
	};
	const show = (url: string) => {
		current = url;
		loading = true;
		emit('did-start-loading');
		frame.src = reachable(url, doc);
	};
	const title = () => {
		try {
			return frame.contentDocument?.title ?? '';
		} catch {
			return ''; // another origin
		}
	};

	frame.addEventListener('load', () => {
		loading = false;
		// Same-origin pages can tell where a link took them.
		try {
			const href = frame.contentWindow?.location.href;
			if (href && href !== 'about:blank' && href !== frame.src) {
				current = href;
				if (history[index] !== href) {
					history.splice(index + 1, history.length, href);
					index = history.length - 1;
				}
			}
		} catch {
			// another origin
		}
		emit('dom-ready');
		if (current !== 'about:blank') {
			emit('did-navigate', { url: current });
			const text = title();
			if (text) {
				emit('page-title-updated', { title: text });
			}
		}
		emit('did-finish-load');
		emit('did-stop-loading');
	});

	Object.assign(frame, {
		loadURL(url: string): Promise<void> {
			history.splice(index + 1, history.length, url);
			index = history.length - 1;
			show(url);
			return Promise.resolve();
		},
		getURL: () => current,
		getTitle: title,
		canGoBack: () => index > 0,
		canGoForward: () => index < history.length - 1,
		goBack(): void {
			if (index > 0) {
				show(history[--index]);
			}
		},
		goForward(): void {
			if (index < history.length - 1) {
				show(history[++index]);
			}
		},
		reload: () => show(current),
		reloadIgnoringCache: () => show(current),
		isLoading: () => loading,
		stop(): void {
			try {
				frame.contentWindow?.stop();
			} catch {
				// another origin
			}
			loading = false;
			emit('did-stop-loading');
		},
		setZoomFactor(factor: number): void {
			frame.style.zoom = String(factor);
		},
	});
	return frame;
}

/** `localhost` is the server's; a browser on another device reaches it at the page's own host. */
function reachable(url: string, doc: Document): string {
	try {
		const target = new URL(url);
		const page = doc.defaultView?.location;
		if (!page || !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(target.hostname) || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(page.hostname)) {
			return url;
		}
		target.hostname = page.hostname;
		return target.toString();
	} catch {
		return url;
	}
}
