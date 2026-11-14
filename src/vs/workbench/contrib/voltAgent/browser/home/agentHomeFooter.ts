/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';

/**
 * The agent lists' footers (Settings, Usage, ...), so what lives in a footer (the update button) finds the one that
 * appeared or learns its own went away, rather than searching the window for it every couple of seconds.
 */
const footers = new Set<HTMLElement>();
const onDidChange = new Emitter<void>();

/** A footer was added or removed. */
export const onDidChangeAgentHomeFooters: Event<void> = onDidChange.event;

export function registerAgentHomeFooter(footer: HTMLElement): IDisposable {
	footers.add(footer);
	onDidChange.fire();
	return toDisposable(() => {
		if (footers.delete(footer)) {
			onDidChange.fire();
		}
	});
}

/** The first footer in `container`, in document order. */
export function agentHomeFooterIn(container: HTMLElement): HTMLElement | undefined {
	let first: HTMLElement | undefined;
	for (const footer of footers) {
		if (container.contains(footer) && (!first || first.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_PRECEDING)) {
			first = footer;
		}
	}
	return first;
}
