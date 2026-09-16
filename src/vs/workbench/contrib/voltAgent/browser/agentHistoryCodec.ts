/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { basename } from '../../../../base/common/path.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/agentHistory.js';
import { ATTACHMENT_REF_PREFIX } from '../../../services/voltRuntime/common/agentHistoryLog.js';
import type { IAgentAssistantMessage, IAgentUserMessage } from './agentEditor.js';
import type { IAgentDisplayMention, IAgentImagePayload } from './agentMentions.js';
import { AgentSegment, IAgentActivityItem } from './blocks/agentBlocks.js';

/**
 * Translates the editor's in-memory message model to and from the JSON that
 * lives in the history log. Two things are not JSON-safe or too large to
 * inline: image bytes on mentions and data-URL snapshots on activity items.
 * Both become content-addressed attachment references; URIs become
 * {@link UriComponents}.
 */
export class AgentHistoryCodec {

	private readonly imageRefs = new WeakMap<Uint8Array, Promise<string>>();
	private readonly dataUrlRefs = new Map<string, Promise<string>>();

	constructor(private readonly history: IAgentHistoryService) { }

	//#region Freeze

	async freezeMentions(mentions: readonly IAgentDisplayMention[] | undefined): Promise<unknown[] | undefined> {
		if (!mentions?.length) {
			return undefined;
		}
		return Promise.all(mentions.map(async mention => ({
			...mention,
			resource: mention.resource ? mention.resource.toJSON() : undefined,
			image: mention.image ? await this.freezeImage(mention.image) : undefined,
		})));
	}

	async freezeUser(message: IAgentUserMessage): Promise<unknown> {
		return {
			...message,
			mentions: await this.freezeMentions(message.mentions),
		};
	}

	async freezeAssistant(message: IAgentAssistantMessage): Promise<unknown> {
		const items = message.activity?.items ?? [];
		const frozenItems = await Promise.all(items.map(item => this.freezeActivityItem(item)));
		const segments = await Promise.all(message.segments.map(async segment => segment.kind === 'activity'
			? { kind: 'activity', item: await this.freezeActivityItem(segment.item) }
			: segment));
		return {
			...message,
			segments,
			activity: message.activity ? { ...message.activity, items: frozenItems } : undefined,
		};
	}

	private async freezeActivityItem(item: IAgentActivityItem): Promise<IAgentActivityItem> {
		if (!item.image || item.image.startsWith(ATTACHMENT_REF_PREFIX)) {
			return item;
		}
		return { ...item, image: await this.freezeDataUrl(item.image) };
	}

	private freezeImage(image: IAgentImagePayload): Promise<{ id: string; mime: string; ref: string }> {
		let ref = this.imageRefs.get(image.bytes);
		if (!ref) {
			ref = this.history.putAttachment(image.bytes, image.mime);
			this.imageRefs.set(image.bytes, ref);
		}
		return ref.then(value => ({ id: image.id, mime: image.mime, ref: value }));
	}

	private freezeDataUrl(dataUrl: string): Promise<string> {
		let ref = this.dataUrlRefs.get(dataUrl);
		if (!ref) {
			const parsed = parseDataUrl(dataUrl);
			ref = parsed ? this.history.putAttachment(parsed.bytes, parsed.mime) : Promise.resolve(dataUrl);
			this.dataUrlRefs.set(dataUrl, ref);
		}
		return ref;
	}

	//#endregion

	//#region Thaw

	async thawMentions(stored: unknown): Promise<IAgentDisplayMention[] | undefined> {
		if (!Array.isArray(stored) || !stored.length) {
			return undefined;
		}
		const mentions: IAgentDisplayMention[] = [];
		for (const raw of stored) {
			if (!raw || typeof raw !== 'object' || typeof (raw as { label?: unknown }).label !== 'string') {
				continue;
			}
			const item = raw as IAgentDisplayMention & { resource?: UriComponents; image?: { id: string; mime: string; ref?: string } };
			mentions.push({
				...item,
				resource: item.resource ? URI.revive(item.resource) : undefined,
				image: item.image ? await this.thawImage(item.image) : undefined,
			});
		}
		return mentions;
	}

	async thawUser(stored: unknown): Promise<IAgentUserMessage | undefined> {
		if (!stored || typeof stored !== 'object' || (stored as { kind?: unknown }).kind !== 'user') {
			return undefined;
		}
		const raw = stored as IAgentUserMessage;
		return {
			...raw,
			text: typeof raw.text === 'string' ? raw.text : '',
			mentions: await this.thawMentions(raw.mentions),
		};
	}

	/**
	 * @param settled when true the run is known to be over (loaded from disk),
	 * so anything still marked streaming is closed as interrupted.
	 */
	async thawAssistant(stored: unknown, settled: boolean, at?: number): Promise<IAgentAssistantMessage | undefined> {
		if (!stored || typeof stored !== 'object' || (stored as { kind?: unknown }).kind !== 'agent') {
			return undefined;
		}
		const raw = stored as IAgentAssistantMessage;
		const segments: AgentSegment[] = Array.isArray(raw.segments) ? raw.segments : [];
		const thawedSegments = await Promise.all(segments.map(async segment => segment.kind === 'activity'
			? { kind: 'activity' as const, item: await this.thawActivityItem(segment.item) }
			: segment));
		const items = Array.isArray(raw.activity?.items) ? await Promise.all(raw.activity!.items.map(item => this.thawActivityItem(item))) : [];
		const message: IAgentAssistantMessage = {
			...raw,
			title: typeof raw.title === 'string' ? raw.title : '',
			steps: Array.isArray(raw.steps) ? raw.steps : [],
			segments: thawedSegments,
			blockState: raw.blockState && typeof raw.blockState === 'object' ? raw.blockState : {},
			activity: raw.activity ? { ...raw.activity, items } : undefined,
		};
		if (settled) {
			settleAssistant(message, at);
		}
		return message;
	}

	private async thawActivityItem(item: IAgentActivityItem): Promise<IAgentActivityItem> {
		if (!item.image || !item.image.startsWith(ATTACHMENT_REF_PREFIX)) {
			return item;
		}
		const attachment = await this.history.getAttachment(item.image);
		return { ...item, image: attachment ? toDataUrl(attachment.bytes, attachment.mime) : undefined };
	}

	private async thawImage(image: { id: string; mime: string; ref?: string; bytes?: unknown }): Promise<IAgentImagePayload | undefined> {
		if (image.ref) {
			const attachment = await this.history.getAttachment(image.ref);
			return attachment ? { id: image.id, mime: image.mime, bytes: attachment.bytes } : undefined;
		}
		return undefined;
	}

	//#endregion
}

/** Close out a reply that was still streaming when it was persisted. */
export function settleAssistant(message: IAgentAssistantMessage, at?: number): void {
	const activity = message.activity;
	if (activity?.streaming) {
		activity.streaming = false;
		activity.expanded = false;
		activity.status = localize('voltAgent.interrupted', "Interrupted");
		message.cancelled = true;
	}
	if (message.endedAt === undefined && message.startedAt !== undefined) {
		message.endedAt = at ?? message.startedAt;
		message.durationMs = Math.max(0, message.endedAt - message.startedAt);
	}
	for (const segment of message.segments) {
		if (segment.kind === 'block' && segment.block.status === 'streaming') {
			segment.block.status = segment.block.type === 'approval' ? 'error' : 'complete';
		}
	}
}

/** Plain text of a user prompt as the model received it. */
export function userMessageText(message: IAgentUserMessage): string {
	return (message.agentText ?? message.text ?? '').trim();
}

/**
 * Short activity summary for history lists: files edited beat files read,
 * which beat the live status, which beats the first line of the reply.
 */
export function assistantSummary(message: IAgentAssistantMessage, plainText: string): string | undefined {
	const items = collectActivityItems(message);
	const edited = uniqueFiles(items.filter(item => /^(edited|created|deleted|wrote)$/i.test(item.label)));
	if (edited.length) {
		return `${localize('voltAgent.history.edited', "Edited")} ${joinFiles(edited)}`;
	}
	const read = uniqueFiles(items.filter(item => item.kind === 'read' && item.path));
	if (read.length) {
		return `${localize('voltAgent.history.read', "Read")} ${joinFiles(read)}`;
	}
	if (message.activity?.streaming && message.activity.status) {
		return message.activity.status;
	}
	const firstLine = plainText.split('\n').map(line => line.trim()).find(Boolean);
	return firstLine ? firstLine.replace(/[#*_`>]+/g, '').trim() : undefined;
}

function collectActivityItems(message: IAgentAssistantMessage): IAgentActivityItem[] {
	const seen = new Set<IAgentActivityItem>();
	const items: IAgentActivityItem[] = [];
	for (const item of message.activity?.items ?? []) {
		if (!seen.has(item)) {
			seen.add(item);
			items.push(item);
		}
	}
	for (const segment of message.segments) {
		if (segment.kind === 'activity' && !seen.has(segment.item)) {
			seen.add(segment.item);
			items.push(segment.item);
		}
	}
	return items;
}

function uniqueFiles(items: readonly IAgentActivityItem[]): string[] {
	const names: string[] = [];
	for (const item of items) {
		const name = item.path ? basename(item.path) : item.detail;
		if (name && !names.includes(name)) {
			names.push(name);
		}
	}
	return names;
}

function joinFiles(names: readonly string[]): string {
	return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | undefined {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
	if (!match) {
		return undefined;
	}
	const mime = match[1] || 'application/octet-stream';
	try {
		if (match[2]) {
			return { bytes: decodeBase64(match[3]).buffer, mime };
		}
		return { bytes: VSBuffer.fromString(decodeURIComponent(match[3])).buffer, mime };
	} catch {
		return undefined;
	}
}

function toDataUrl(bytes: Uint8Array, mime: string): string {
	return `data:${mime};base64,${encodeBase64(VSBuffer.wrap(bytes))}`;
}
