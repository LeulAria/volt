/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHostToolDetail.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IAgentActivityItem } from '../blocks/agentBlocks.js';
import { type IBlockRenderContext, renderMarkdownInto } from '../blocks/agentBlockRenderers.js';

let open: DisposableStore | undefined;

/** Height the body keeps until "Show more", as in Cursor's action dialog. */
const COLLAPSED_BODY_PX = 300;

/**
 * The dialog behind a browser-action row ("Clicked · Top-left cell"): what the agent did and the
 * page it saw afterwards (URL, title, accessibility snapshot), or the screenshot it took.
 */
export function showHostToolDetail(anchor: HTMLElement, item: IAgentActivityItem, ctx: IBlockRenderContext, onOpenUrl: (url: string) => void): void {
	open?.dispose();
	const store = new DisposableStore();
	open = store;
	const doc = getWindow(anchor).document;
	const overlay = append(doc.body, $('.volt-tool-detail-overlay'));
	overlay.tabIndex = -1;
	store.add({ dispose: () => overlay.remove() });

	const dialog = append(overlay, $('.volt-tool-detail'));
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	const head = append(dialog, $('.volt-tool-detail-head'));
	const titles = append(head, $('.volt-tool-detail-titles'));
	append(titles, $('.volt-tool-detail-title')).textContent = item.label;
	if (item.detail) {
		append(titles, $('.volt-tool-detail-subtitle')).textContent = item.detail;
	}
	dialog.setAttribute('aria-label', [item.label, item.detail].filter(Boolean).join(' '));
	const close = append(head, $('button.volt-tool-detail-close')) as HTMLButtonElement;
	close.type = 'button';
	close.setAttribute('aria-label', localize('voltAgent.toolDetail.close', "Close"));
	close.appendChild(renderIcon(Codicon.close));

	const body = append(dialog, $('.volt-tool-detail-body'));
	const content = append(body, $('.volt-tool-detail-content'));
	if (item.error) {
		append(content, $('.volt-tool-detail-error')).textContent = item.error;
	}
	if (item.image) {
		const img = append(content, $('img.volt-tool-detail-image')) as HTMLImageElement;
		img.src = item.image;
		img.alt = item.label;
	}
	const markdown = item.result?.trim();
	if (markdown) {
		renderMarkdownInto(content, markdown, {
			...ctx, store, onOpenUrl: url => {
				dismiss();
				onOpenUrl(url);
			}
		}, 'volt-tool-detail-markdown');
	}

	const more = append(dialog, $('button.volt-tool-detail-more.hidden')) as HTMLButtonElement;
	more.type = 'button';
	more.textContent = localize('voltAgent.toolDetail.showMore', "Show more");
	const syncMore = () => {
		const tall = content.scrollHeight > COLLAPSED_BODY_PX + 24;
		if (!tall) {
			body.classList.add('expanded');
		}
		more.classList.toggle('hidden', !tall || body.classList.contains('expanded'));
		body.classList.toggle('clipped', tall && !body.classList.contains('expanded'));
	};
	store.add(addDisposableListener(more, 'click', e => {
		e.preventDefault();
		body.classList.add('expanded');
		syncMore();
	}));
	getWindow(anchor).requestAnimationFrame(syncMore);
	if (item.image) {
		const img = content.querySelector('img');
		if (img) {
			store.add(addDisposableListener(img, 'load', syncMore));
		}
	}

	const dismiss = () => {
		if (open === store) {
			open = undefined;
		}
		store.dispose();
		anchor.focus?.();
	};
	store.add(addDisposableListener(close, 'click', e => {
		e.preventDefault();
		dismiss();
	}));
	store.add(addDisposableListener(overlay, 'mousedown', e => {
		if (e.target === overlay) {
			dismiss();
		}
	}));
	store.add(addDisposableListener(overlay, 'keydown', e => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			dismiss();
		}
	}));
	overlay.focus();
}
