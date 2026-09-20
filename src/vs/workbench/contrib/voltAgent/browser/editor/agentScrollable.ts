/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollableElementCreationOptions } from '../../../../../base/browser/ui/scrollbar/scrollableElementOptions.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';

export function createAgentScrollable(content: HTMLElement, options?: ScrollableElementCreationOptions): DomScrollableElement {
	content.classList.add('volt-agent-scrollable-content');
	const scroll = new DomScrollableElement(content, {
		className: 'volt-agent-scrollable',
		vertical: ScrollbarVisibility.Auto,
		horizontal: ScrollbarVisibility.Hidden,
		verticalScrollbarSize: 10,
		horizontalScrollbarSize: 10,
		useShadows: false,
		handleMouseWheel: true,
		alwaysConsumeMouseWheel: false,
		...options,
	});
	const node = scroll.getDomNode();
	node.style.width = '100%';
	node.style.maxWidth = '100%';
	return scroll;
}

export function appendAgentScrollableList(parent: HTMLElement, extraClass?: string): { list: HTMLElement; scroll: DomScrollableElement } {
	const list = extraClass ? $(`.volt-agent-dropdown-list.${extraClass}`) : $('.volt-agent-dropdown-list');
	const scroll = createAgentScrollable(list);
	parent.appendChild(scroll.getDomNode());
	return { list, scroll };
}
