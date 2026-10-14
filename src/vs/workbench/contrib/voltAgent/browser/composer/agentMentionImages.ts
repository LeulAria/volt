/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import type { IAgentDisplayMention } from './agentMentions.js';

// Prompt attachments as the runtime sends them. Kept free of DOM imports: the agent server builds
// turns from the same mentions.

/** An image the model receives with the prompt: the runtime's `IVoltImageAttachment` shape. */
export interface IAgentImageAttachment {
	readonly mediaType: string;
	/** Base64 without a `data:` prefix. */
	readonly data: string;
	/** The name the prompt text refers to ("Image1" for `@Image1`, the file name for a dropped file). */
	readonly name?: string;
}

/** Image types every vision provider takes; others (SVG) stay a text mention only. */
const SENDABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * The pasted and dropped images among a prompt's mentions, and the stills of its videos, ready for
 * `IVoltSendRequest.images`. The text mention stays in the prompt; the name ties the two together.
 */
export function imageAttachmentsFromMentions(mentions: readonly IAgentDisplayMention[] | undefined): IAgentImageAttachment[] {
	const attachments: IAgentImageAttachment[] = [];
	const seen = new Set<Uint8Array>();
	for (const mention of mentions ?? []) {
		if (mention.kind === 'video') {
			for (const frame of mention.video?.frames ?? []) {
				attachments.push({ mediaType: frame.mime, data: encodeBase64(VSBuffer.wrap(frame.bytes)), name: videoFrameName(mention.label, frame.time) });
			}
			continue;
		}
		const image = mention.image;
		if (mention.kind !== 'image' || !image?.bytes.byteLength || seen.has(image.bytes)) {
			continue;
		}
		const mediaType = image.mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : image.mime.toLowerCase();
		if (!SENDABLE_IMAGE_TYPES.has(mediaType)) {
			continue;
		}
		seen.add(image.bytes);
		attachments.push({ mediaType, data: encodeBase64(VSBuffer.wrap(image.bytes)), name: mention.label });
	}
	return attachments;
}

/** `screen.mov @ 0:03.5`: the name a video still is sent under. */
export function videoFrameName(label: string, time: number): string {
	return `${label} @ ${formatDuration(time, true)}`;
}

/** `0:09`, `1:02:03`; `precise` adds tenths (`0:09.4`). */
export function formatDuration(seconds: number, precise = false): string {
	const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	const tenths = Math.round(safe * 10);
	const whole = precise ? Math.floor(tenths / 10) : Math.round(safe);
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	const clock = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
	return precise ? `${clock}.${tenths % 10}` : clock;
}
