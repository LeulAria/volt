/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IVoltResourceAttachment } from '../../../../services/voltRuntime/common/fileAttachments.js';
import { isSendableImageMime } from './agentFileAttachments.js';
import type { IAgentDisplayMention } from './agentMentions.js';
import { formatDuration } from './agentVideoAttachments.js';

// A prompt's attachments as the runtime sends them. Kept free of DOM imports: the Volt agent server
// builds turns from the same mentions.

/** An image the model receives with the prompt: the runtime's `IVoltImageAttachment` shape. */
export interface IAgentImageAttachment {
	readonly mediaType: string;
	/** Base64 without a `data:` prefix. */
	readonly data: string;
	/** The name the prompt text refers to ("Image1" for `@Image1`, the file name for a dropped file). */
	readonly name?: string;
}

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
		if (!isSendableImageMime(mediaType)) {
			continue;
		}
		seen.add(image.bytes);
		attachments.push({ mediaType, data: encodeBase64(VSBuffer.wrap(image.bytes)), name: mention.label });
	}
	return attachments;
}

/**
 * The prompt's attached files as ACP resources (saved copies only). A folded paste is marked
 * `pasted`: the turn host reads its text so agents that take embedded context get it inline.
 */
export function resourceAttachmentsFromMentions(mentions: readonly IAgentDisplayMention[] | undefined): (IVoltResourceAttachment & { readonly pasted?: boolean })[] {
	const resources: (IVoltResourceAttachment & { readonly pasted?: boolean })[] = [];
	for (const mention of mentions ?? []) {
		const file = mention.file;
		if (!file?.path) {
			continue;
		}
		const mime = file.mime.toLowerCase();
		const mimeType = file.pasted && !(mime.startsWith('text/') || mime === 'application/json') ? 'text/plain' : file.mime;
		resources.push({ uri: URI.file(file.path).toString(), name: mention.label, mimeType, size: file.size, ...(file.pasted ? { pasted: true } : {}) });
	}
	return resources;
}

/** `screen.mov @ 0:03.5`: the name a video still is sent under. */
export function videoFrameName(label: string, time: number): string {
	return `${label} @ ${formatDuration(time, true)}`;
}
