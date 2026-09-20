/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentActivityItem } from '../blocks/agentBlocks.js';

const SNAPSHOT_RE = /\b(snapshot|screenshot|capture.?page|browser.?screenshot)\b/i;
const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

export function isSnapshotTool(name?: string, title?: string): boolean {
	return SNAPSHOT_RE.test(`${name ?? ''} ${title ?? ''}`.replace(/[_-]+/g, ' '));
}

export function isSnapshotActivity(item: IAgentActivityItem): boolean {
	return !!item.image || SNAPSHOT_RE.test(`${item.label} ${item.detail ?? ''}`);
}

/** Pull a displayable image out of an ACP / tool-call result. */
export function extractToolImage(result: unknown): string | undefined {
	if (!result) {
		return undefined;
	}
	if (typeof result === 'string') {
		return asImageDataUrl(result);
	}
	if (Array.isArray(result)) {
		for (const part of result) {
			const image = extractToolImage(part);
			if (image) {
				return image;
			}
		}
		return undefined;
	}
	if (typeof result !== 'object') {
		return undefined;
	}
	const o = result as Record<string, unknown>;
	const mime = pickMime(o);
	for (const key of ['data', 'image', 'base64', 'bytes']) {
		const value = o[key];
		if (typeof value === 'string') {
			const image = asImageDataUrl(value, mime);
			if (image) {
				return image;
			}
		}
	}
	if (typeof o.url === 'string') {
		const image = asImageDataUrl(o.url, mime);
		if (image) {
			return image;
		}
	}
	if (o.source && typeof o.source === 'object') {
		const image = extractToolImage(o.source);
		if (image) {
			return image;
		}
	}
	if (o.content !== undefined) {
		const image = extractToolImage(o.content);
		if (image) {
			return image;
		}
	}
	return undefined;
}

export function asImageDataUrl(value: string, mime = 'image/png'): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	if (DATA_URL_RE.test(trimmed)) {
		return trimmed;
	}
	if (/^https?:\/\//i.test(trimmed) && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(trimmed)) {
		return trimmed;
	}
	if (isBase64Image(trimmed)) {
		return `data:${mime || 'image/png'};base64,${trimmed.replace(/\s+/g, '')}`;
	}
	return undefined;
}

function pickMime(o: Record<string, unknown>): string {
	for (const key of ['mimeType', 'mime_type', 'mediaType', 'media_type']) {
		const value = o[key];
		if (typeof value === 'string' && /^image\//i.test(value)) {
			return value;
		}
	}
	return 'image/png';
}

function isBase64Image(value: string): boolean {
	const compact = value.replace(/\s+/g, '');
	if (compact.length < 80 || compact.length % 4 !== 0) {
		return false;
	}
	return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}
