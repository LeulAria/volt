/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IAgentDisplayMention } from '../composer/agentMentions.js';
import type { VoltCommentStatus } from '../chrome/voltCommentsPane.js';

export interface IBrowserCommentBounds {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** One element or region a comment points at: its chip label, the block the agent reads, where it is. */
export interface IBrowserCommentRef {
	readonly label: string;
	readonly payload: string;
	readonly bounds: IBrowserCommentBounds;
	/** Its key in the page's tracked elements: marks and pins follow the element, not `bounds`, while the page is open. */
	readonly track?: string;
	/** The element's text, shortened: the message quotes it after the chip. */
	readonly snippet?: string;
	/** What it looked like when picked (its outline included), sent with the message. Filled in once captured. */
	image?: { readonly bytes: Uint8Array; readonly mime: string };
}

/**
 * A comment left on a page in a browser tab. It stays on the page (a numbered pin) after it is sent,
 * until the user resolves it; resolved ones can be archived for good.
 */
export interface IBrowserComment {
	readonly id: string;
	/** The browser tab it was made in. */
	readonly viewId: string;
	/** The chat whose tools hold that tab, when one does: its composer offers the comment too. */
	readonly sessionId: string | undefined;
	readonly url: string;
	/** 1, 2, ... in its tab. */
	readonly number: number;
	readonly refs: readonly IBrowserCommentRef[];
	/** The user's words, without the chips. */
	readonly text: string;
	/** What the agent reads: the chips' blocks and the words, as the composer serialized them. */
	readonly prompt: string;
	/** What the sent message shows: the words with the chips. */
	readonly displayText: string;
	readonly mentions: readonly IAgentDisplayMention[];
	readonly status: VoltCommentStatus;
	/** Goes with the next message (open comments only); the comments list ticks it. */
	readonly picked: boolean;
	readonly archived?: boolean;
	readonly at: number;
}

export type IBrowserCommentScope = { readonly viewId: string } | { readonly sessionId: string };

export type IBrowserCommentInit = Pick<IBrowserComment, 'viewId' | 'sessionId' | 'url' | 'refs' | 'text' | 'prompt' | 'displayText' | 'mentions'>;
export type IBrowserCommentPatch = Partial<Pick<IBrowserComment, 'sessionId' | 'refs' | 'text' | 'prompt' | 'displayText' | 'mentions' | 'status' | 'picked'>>;

/** The comments ready to go, as one message: what the agent reads and what the bubble shows. */
export interface IBrowserCommentMessage {
	readonly agentText: string;
	readonly displayText: string;
	readonly mentions: IAgentDisplayMention[];
	readonly ids: readonly string[];
}

export const IVoltBrowserComments = createDecorator<IVoltBrowserComments>('voltBrowserComments');

export interface IVoltBrowserComments {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Someone (a chip, the dock) asked the tab to show its comments list. */
	readonly onDidRequestShow: Event<IBrowserCommentScope>;
	/** The comments not archived, oldest first. */
	list(scope: IBrowserCommentScope): readonly IBrowserComment[];
	/** Open comments ticked to go with the next message. */
	pending(scope: IBrowserCommentScope): readonly IBrowserComment[];
	get(id: string): IBrowserComment | undefined;
	add(init: IBrowserCommentInit): IBrowserComment;
	update(id: string, patch: IBrowserCommentPatch): void;
	remove(id: string): void;
	archiveResolved(scope: IBrowserCommentScope): void;
	/** The tab now belongs to chat `sessionId` (or none): its comments follow. */
	setSession(viewId: string, sessionId: string | undefined): void;
	/** `ids` (or every pending comment) as one message; they leave the batch (and the page). Undefined when none are open. */
	take(scope: IBrowserCommentScope, ids?: readonly string[]): IBrowserCommentMessage | undefined;
	show(scope: IBrowserCommentScope): void;
}

function inScope(comment: IBrowserComment, scope: IBrowserCommentScope): boolean {
	return 'viewId' in scope ? comment.viewId === scope.viewId : comment.sessionId === scope.sessionId;
}

/**
 * The comments as the message the agent gets: each numbered with its page, its element blocks and the
 * words. The bubble shows "Comment 1: <chips and words>" lines.
 */
export function formatBrowserComments(comments: readonly IBrowserComment[]): IBrowserCommentMessage {
	const pages = new Set(comments.map(comment => comment.url));
	const lines = [pages.size === 1
		? `The user left ${comments.length === 1 ? 'a comment' : `${comments.length} comments`} on ${[...pages][0] || 'the page'} in the browser. Address each one:`
		: `The user left ${comments.length} comments on pages in the browser. Address each one:`];
	const display: string[] = [];
	const mentions: IAgentDisplayMention[] = [];
	comments.forEach((comment, index) => {
		lines.push('', `Comment ${comment.number}${pages.size > 1 ? ` (${comment.url})` : ''}:`, comment.prompt);
		// One annotation reads as itself; a batch is a numbered list.
		display.push(comments.length === 1 ? comment.displayText.trim() : `${index + 1}. ${comment.displayText.trim()}`);
		mentions.push(...comment.mentions);
	});
	return { agentText: lines.join('\n'), displayText: display.join('\n'), mentions, ids: comments.map(comment => comment.id) };
}

export class VoltBrowserComments extends Disposable implements IVoltBrowserComments {
	declare readonly _serviceBrand: undefined;

	private readonly comments: IBrowserComment[] = [];
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidRequestShow = this._register(new Emitter<IBrowserCommentScope>());
	readonly onDidRequestShow = this._onDidRequestShow.event;

	list(scope: IBrowserCommentScope): readonly IBrowserComment[] {
		return this.comments.filter(comment => !comment.archived && inScope(comment, scope));
	}

	pending(scope: IBrowserCommentScope): readonly IBrowserComment[] {
		return this.list(scope).filter(comment => comment.status === 'open' && comment.picked);
	}

	get(id: string): IBrowserComment | undefined {
		return this.comments.find(comment => comment.id === id);
	}

	add(init: IBrowserCommentInit): IBrowserComment {
		const number = this.comments.filter(comment => comment.viewId === init.viewId).reduce((max, comment) => Math.max(max, comment.number), 0) + 1;
		const comment: IBrowserComment = { ...init, id: generateUuid(), number, status: 'open', picked: true, at: Date.now() };
		this.comments.push(comment);
		this._onDidChange.fire();
		return comment;
	}

	update(id: string, patch: IBrowserCommentPatch): void {
		const index = this.comments.findIndex(comment => comment.id === id);
		if (index < 0) {
			return;
		}
		const previous = this.comments[index];
		// Reopening a comment ticks it again: it goes with the next message.
		const picked = patch.picked ?? (patch.status === 'open' && previous.status !== 'open' ? true : previous.picked);
		this.comments[index] = { ...previous, ...patch, picked };
		this._onDidChange.fire();
	}

	remove(id: string): void {
		const index = this.comments.findIndex(comment => comment.id === id);
		if (index >= 0) {
			this.comments.splice(index, 1);
			this._onDidChange.fire();
		}
	}

	archiveResolved(scope: IBrowserCommentScope): void {
		let changed = false;
		this.comments.forEach((comment, index) => {
			if (!comment.archived && comment.status === 'resolved' && inScope(comment, scope)) {
				this.comments[index] = { ...comment, archived: true };
				changed = true;
			}
		});
		if (changed) {
			this._onDidChange.fire();
		}
	}

	setSession(viewId: string, sessionId: string | undefined): void {
		let changed = false;
		this.comments.forEach((comment, index) => {
			if (comment.viewId === viewId && comment.sessionId !== sessionId) {
				this.comments[index] = { ...comment, sessionId };
				changed = true;
			}
		});
		if (changed) {
			this._onDidChange.fire();
		}
	}

	take(scope: IBrowserCommentScope, ids?: readonly string[]): IBrowserCommentMessage | undefined {
		const comments = ids
			? this.list(scope).filter(comment => ids.includes(comment.id) && comment.status !== 'resolved')
			: this.pending(scope);
		if (!comments.length) {
			return undefined;
		}
		const message = formatBrowserComments(comments);
		// Sent: the annotations leave the batch and their pins leave the page.
		for (const comment of comments) {
			this.comments.splice(this.comments.indexOf(comment), 1);
		}
		this._onDidChange.fire();
		return message;
	}

	show(scope: IBrowserCommentScope): void {
		this._onDidRequestShow.fire(scope);
	}
}

registerSingleton(IVoltBrowserComments, VoltBrowserComments, InstantiationType.Delayed);
