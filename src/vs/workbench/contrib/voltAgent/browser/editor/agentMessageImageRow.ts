/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentMessageImages.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentImageStrip, closeMediaDialog, formatImageSize, IAgentImageStripItem, trackMediaDialog } from '../composer/agentImageAttachments.js';
import { formatDuration } from '../composer/agentVideoAttachments.js';

/**
 * Keeps an image strip (a sent prompt's, or the composer's) to one row: as many tiles as the width
 * holds, and when some do not fit, the last one shows "+N" (N hidden) over its dimmed image. "+N"
 * opens every image in a grid, and a pick there opens it the way a tile does. Counted again on every
 * resize and whenever the strip's images change.
 */
export function fitImageStripToOneRow(strip: AgentImageStrip, onOpen: (index: number) => void): IDisposable {
	const store = new DisposableStore();
	const element = strip.element;
	const win = getWindow(element);
	element.classList.add('one-row');
	let moreTile: HTMLElement | undefined;
	let moreBadge: HTMLElement | undefined;

	const restore = () => {
		if (moreTile) {
			moreTile.classList.remove('more');
			moreBadge?.remove();
			const index = tilesOf(element).indexOf(moreTile);
			const item = strip.items[index];
			if (item) {
				moreTile.setAttribute('aria-label', localize('voltAgent.openImage', "Open {0}", item.name));
				setAgentTooltip(moreTile, item.name, tileDetail(item));
			}
		}
		moreTile = undefined;
		moreBadge = undefined;
	};

	const layout = () => {
		const tiles = tilesOf(element);
		const style = win.getComputedStyle(element);
		const available = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
		const tileWidth = tiles[0]?.offsetWidth ?? 0;
		if (available <= 0 || tileWidth <= 0) {
			// Not laid out (a stashed thread): keep what is there until it is.
			return;
		}
		const gap = parseFloat(style.columnGap) || 0;
		const fit = Math.max(1, Math.floor((available + gap) / (tileWidth + gap)));
		const overflowing = tiles.length > fit;
		tiles.forEach((tile, index) => tile.classList.toggle('overflow', overflowing && index >= fit));
		const last = overflowing ? tiles[fit - 1] : undefined;
		if (last !== moreTile) {
			restore();
		}
		if (!last) {
			return;
		}
		// The last tile stands for itself and every hidden one.
		const hidden = tiles.length - fit + 1;
		moreTile = last;
		last.classList.add('more');
		moreBadge ??= append(last, $('span.volt-agent-image-tile-more'));
		moreBadge.textContent = `+${hidden}`;
		const label = localize('voltAgent.showAllImages', "Show all {0} attachments", tiles.length);
		last.setAttribute('aria-label', label);
		setAgentTooltip(last, label);
	};

	// Before the tile's own click (which opens that one image): "+N" opens the grid instead.
	store.add(addDisposableListener(element, EventType.CLICK, e => {
		if (moreTile && moreTile.contains(e.target as Node)) {
			e.preventDefault();
			e.stopPropagation();
			showAgentMessageImageGallery(element, strip.items, onOpen);
		}
	}, true));

	// The tiles were rebuilt: the old "+N" tile is gone with them.
	store.add(strip.onDidUpdate(() => {
		moreTile = undefined;
		moreBadge = undefined;
		layout();
	}));
	const observer = new win.ResizeObserver(() => layout());
	observer.observe(element);
	store.add(toDisposable(() => observer.disconnect()));
	layout();
	return store;
}

function tilesOf(element: HTMLElement): HTMLElement[] {
	return Array.from(element.children).filter((child): child is HTMLElement => child.classList.contains('volt-agent-image-tile'));
}

/** The tooltip's second line, as the strip writes it. */
function tileDetail(item: IAgentImageStripItem): string {
	const duration = item.video?.duration;
	return [duration ? formatDuration(duration) : undefined, formatImageSize(item.size)].filter(Boolean).join(' · ');
}

/** Opens the grid of a prompt's attachments; one image or video dialog at a time. */
export function showAgentMessageImageGallery(anchor: HTMLElement, items: readonly IAgentImageStripItem[], onOpen: (index: number) => void): IDisposable {
	closeMediaDialog();
	const gallery = new AgentMessageImageGallery(anchor, items, onOpen);
	trackMediaDialog(gallery);
	return gallery;
}

/** Every attachment of a sent prompt as a grid in a dialog. A pick closes it and opens that one. */
class AgentMessageImageGallery extends Disposable {

	private readonly overlay: HTMLElement;
	private closed = false;
	private readonly closeListeners: (() => void)[] = [];

	constructor(anchor: HTMLElement, items: readonly IAgentImageStripItem[], onOpen: (index: number) => void) {
		super();
		const win = getWindow(anchor);
		const title = localize('voltAgent.imageGalleryTitle', "{0} attachments", items.length);
		this.overlay = append(win.document.body, $('.volt-agent-image-viewer-overlay'));
		this.overlay.tabIndex = -1;
		this.overlay.setAttribute('role', 'dialog');
		this.overlay.setAttribute('aria-modal', 'true');
		this.overlay.setAttribute('aria-label', title);
		const dialog = append(this.overlay, $('.volt-agent-image-viewer.volt-agent-image-gallery'));
		const head = append(dialog, $('.volt-agent-image-viewer-head'));
		const titleRow = append(head, $('.volt-agent-image-viewer-title-row'));
		append(titleRow, $('span.volt-agent-image-viewer-title')).textContent = title;
		const actions = append(head, $('.volt-agent-image-viewer-actions'));
		const close = append(actions, $('button.volt-agent-image-viewer-btn')) as HTMLButtonElement;
		close.type = 'button';
		const closeLabel = localize('voltAgent.imageClose', "Close");
		close.setAttribute('aria-label', closeLabel);
		close.appendChild(renderIcon(Codicon.close));
		setAgentTooltip(close, closeLabel, 'Esc');
		this._register(addDisposableListener(close, EventType.CLICK, () => this.dispose()));

		const grid = append(dialog, $('.volt-agent-image-gallery-grid'));
		items.forEach((item, index) => {
			const tile = append(grid, $('button.volt-agent-image-gallery-tile')) as HTMLButtonElement;
			tile.type = 'button';
			tile.classList.toggle('video', !!item.video);
			tile.setAttribute('aria-label', localize('voltAgent.openImage', "Open {0}", item.name));
			setAgentTooltip(tile, item.name, tileDetail(item));
			const img = append(tile, $('img')) as HTMLImageElement;
			img.alt = item.name;
			img.draggable = false;
			if (item.bytes) {
				// The image itself, not the strip's small thumbnail: these tiles are larger.
				const url = URL.createObjectURL(new Blob([item.bytes as Uint8Array<ArrayBuffer>], { type: item.video ? 'image/jpeg' : item.mime }));
				img.src = url;
				this._register(toDisposable(() => URL.revokeObjectURL(url)));
			}
			if (item.video) {
				const badge = append(tile, $('span.volt-agent-image-tile-badge'));
				badge.appendChild(renderIcon(Codicon.play));
				if (item.video.duration) {
					append(badge, $('span')).textContent = formatDuration(item.video.duration);
				}
			}
			this._register(addDisposableListener(tile, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				this.dispose();
				onOpen(index);
			}));
		});

		this._register(addDisposableListener(this.overlay, EventType.MOUSE_DOWN, e => {
			if (e.target === this.overlay) {
				e.preventDefault();
				this.dispose();
			}
		}));
		this._register(addDisposableListener(this.overlay, EventType.KEY_DOWN, e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.dispose();
			}
		}));
		this.overlay.focus();
	}

	onClose(listener: () => void): void {
		this.closeListeners.push(listener);
	}

	override dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.overlay.remove();
		super.dispose();
		for (const listener of this.closeListeners) {
			listener();
		}
	}
}
