/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../../base/browser/dom.js';

/** Elements that host another page: focus there means the page has it. */
function isPageHost(element: Element | null): boolean {
	return !!element && (element.tagName === 'WEBVIEW' || element.tagName === 'IFRAME');
}

/**
 * Whether focus should go back to `before` after agent input moved it to `after`. Only when the
 * user was somewhere else (the composer, a terminal) and the agent's input pulled focus into the
 * page or dropped it on the body. If the user had the page focused, the page keeps it.
 */
export function shouldRestoreFocus(before: Element | null, after: Element | null, body: Element | null): boolean {
	if (!before || before === after || before === body || isPageHost(before) || !before.isConnected) {
		return false;
	}
	return !after || after === body || isPageHost(after);
}

/**
 * Runs agent input against the in-app browser without taking the user's focus. A trusted mouse
 * press on a `<webview>` makes Chromium focus the guest page and its `<webview>` element, which
 * would pull the caret out of the chat composer while the user is typing. Focus is put back as
 * soon as it moves, and once more when the input is done.
 */
export async function keepUserFocus<T>(doc: Document, work: () => Promise<T>): Promise<T> {
	const before = doc.activeElement;
	const restore = () => {
		if (shouldRestoreFocus(before, doc.activeElement, doc.body)) {
			(before as HTMLElement).focus({ preventScroll: true });
		}
	};
	const listener = addDisposableListener(doc, 'focusin', () => restore(), true);
	// A guest page taking focus shows up in the embedder as the <webview> becoming active, which
	// may not fire focusin on every Chromium path: also check after each event loop turn.
	const win = doc.defaultView;
	const interval = win?.setInterval(restore, 50);
	try {
		return await work();
	} finally {
		listener.dispose();
		if (interval !== undefined) {
			win?.clearInterval(interval);
		}
		restore();
	}
}
