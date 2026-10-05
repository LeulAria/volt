/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentImages.css';
import { $, addDisposableListener, append, clearNode } from '../../../../../base/browser/dom.js';
import { createCSSRule } from '../../../../../base/browser/domStylesheets.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { formatDuration } from './agentVideoAttachments.js';

/** Thumbnails are drawn at this size (CSS px × 2 for retina) and cropped to a square. */
const THUMB_PX = 128;

const thumbnails = new WeakMap<Uint8Array, Promise<string | undefined>>();
const thumbClasses = new WeakMap<Uint8Array, string>();

/** `19 KB`, `3.1 MB`. */
export function formatImageSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${Math.round(bytes / 1024)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `png` for `image/png`, `jpg` for `image/jpeg`. */
export function imageExtension(mime: string): string {
	const subtype = mime.toLowerCase().split('/')[1]?.split('+')[0] || 'png';
	return subtype === 'jpeg' ? 'jpg' : subtype;
}

export function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
	return createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
}

/** A small square data-URL preview of an image, cached per byte buffer. */
export function imageThumbnail(bytes: Uint8Array, mime: string): Promise<string | undefined> {
	let pending = thumbnails.get(bytes);
	if (!pending) {
		pending = (async () => {
			try {
				const bitmap = await decodeImage(bytes, mime);
				const side = Math.min(bitmap.width, bitmap.height);
				const canvas = document.createElement('canvas');
				canvas.width = THUMB_PX;
				canvas.height = THUMB_PX;
				const ctx = canvas.getContext('2d');
				if (!ctx || !side) {
					bitmap.close();
					return undefined;
				}
				ctx.imageSmoothingQuality = 'high';
				ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, THUMB_PX, THUMB_PX);
				bitmap.close();
				return canvas.toDataURL('image/png');
			} catch {
				return undefined;
			}
		})();
		thumbnails.set(bytes, pending);
	}
	return pending;
}

/**
 * A class that sets `--volt-image-thumb` to the image's thumbnail. Monaco decorations only take
 * class names, so the composer chip gets its preview through a stylesheet rule.
 */
export function imageThumbClass(bytes: Uint8Array, mime: string): string {
	let className = thumbClasses.get(bytes);
	if (!className) {
		className = `volt-image-thumb-${generateUuid().slice(0, 12)}`;
		thumbClasses.set(bytes, className);
		const selector = `.${className}`;
		void imageThumbnail(bytes, mime).then(url => {
			if (url) {
				createCSSRule(selector, `--volt-image-thumb: url("${url}");`);
			}
		});
	}
	return className;
}

export interface IAgentImageStripItem {
	readonly key: string;
	readonly name: string;
	/** What the preview is cut from: the image, or a video's poster (absent until the video is decoded). */
	readonly bytes: Uint8Array | undefined;
	readonly mime: string;
	/** Bytes of the attachment itself, for the tooltip. */
	readonly size: number;
	/** Present for a video: its length in seconds, once known. */
	readonly video?: { readonly duration?: number };
}

let activeDialog: IDisposable | undefined;

/** One image or video dialog at a time: close the open one before showing another. */
export function closeMediaDialog(): void {
	activeDialog?.dispose();
	activeDialog = undefined;
}

export function trackMediaDialog(dialog: IDisposable & { onClose(listener: () => void): void }): void {
	activeDialog = dialog;
	dialog.onClose(() => {
		if (activeDialog === dialog) {
			activeDialog = undefined;
		}
	});
}

export interface IAgentImageStripOptions {
	onOpen(index: number): void;
	/** Leave out for a read-only strip. */
	onRemove?(index: number): void;
}

/** Square previews of a prompt's images and videos, above the composer text or in a sent message. */
export class AgentImageStrip extends Disposable {

	readonly element: HTMLElement;
	private readonly itemStore = this._register(new DisposableStore());
	private keys = '';

	constructor(private readonly options: IAgentImageStripOptions, className = '') {
		super();
		this.element = $(`.volt-agent-image-strip${className ? `.${className}` : ''}`);
		this.element.classList.add('hidden');
	}

	get isEmpty(): boolean {
		return !this.keys;
	}

	update(items: readonly IAgentImageStripItem[]): void {
		const keys = items.map(item => item.key).join('|');
		if (keys === this.keys) {
			return;
		}
		this.keys = keys;
		this.itemStore.clear();
		clearNode(this.element);
		this.element.classList.toggle('hidden', !items.length);
		items.forEach((item, index) => {
			const tile = append(this.element, $('button.volt-agent-image-tile')) as HTMLButtonElement;
			tile.type = 'button';
			tile.classList.toggle('video', !!item.video);
			tile.setAttribute('aria-label', localize('voltAgent.openImage', "Open {0}", item.name));
			const duration = item.video?.duration;
			setAgentTooltip(tile, item.name, [duration ? formatDuration(duration) : undefined, formatImageSize(item.size)].filter(Boolean).join(' · '));
			const img = append(tile, $('img.volt-agent-image-tile-img')) as HTMLImageElement;
			img.alt = item.name;
			img.draggable = false;
			if (item.bytes) {
				void imageThumbnail(item.bytes, item.mime).then(url => {
					if (url) {
						img.src = url;
					}
				});
			}
			if (item.video) {
				const badge = append(tile, $('span.volt-agent-image-tile-badge'));
				badge.appendChild(renderIcon(Codicon.play));
				if (duration) {
					append(badge, $('span')).textContent = formatDuration(duration);
				}
			}
			this.itemStore.add(addDisposableListener(tile, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.options.onOpen(index);
			}));
			if (this.options.onRemove) {
				const remove = append(tile, $('span.volt-agent-image-tile-remove'));
				remove.setAttribute('role', 'button');
				remove.setAttribute('aria-label', localize('voltAgent.removeImage', "Remove image"));
				remove.appendChild(renderIcon(Codicon.close));
				this.itemStore.add(addDisposableListener(remove, 'mousedown', e => {
					// Keep focus in the composer.
					e.preventDefault();
				}));
				this.itemStore.add(addDisposableListener(remove, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					this.options.onRemove?.(index);
				}));
			}
		});
	}
}
