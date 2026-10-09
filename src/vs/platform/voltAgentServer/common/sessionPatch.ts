/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A chat transcript travels as patches: the server folds run events into messages (as the agent
 * window always has) and sends only the messages whose JSON changed. A client holding revision
 * `rev - 1` applies the patch; anything else means it missed one and must reopen the session.
 */
export interface ISessionPatch {
	readonly id: string;
	/** Increments by one per patch of this session. */
	readonly rev: number;
	/** The transcript's length after the patch (shorter = truncated). */
	readonly len: number;
	readonly set: readonly { readonly i: number; readonly message: unknown }[];
	readonly contextUsed?: number;
	readonly contextWindow?: number;
}

export type SessionChangeKind = 'render' | 'usage' | 'runEnd' | 'turnStart';

/** A session lifecycle change, mirrored from the server's session controller. */
export interface ISessionChangeEvent {
	readonly id: string;
	readonly change: {
		readonly kind: SessionChangeKind;
		readonly turnId?: string;
		readonly aborted?: boolean;
		readonly failed?: boolean;
	};
}

export type SessionTopicData =
	| ({ readonly type: 'patch' } & ISessionPatch)
	| ({ readonly type: 'change' } & ISessionChangeEvent)
	| { readonly type: 'idle'; readonly id: string };

/** What `session.open` returns: the full transcript at a revision. */
export interface ISessionState {
	readonly id: string;
	readonly rev: number;
	readonly messages: readonly unknown[];
	readonly contextUsed?: number;
	readonly contextWindow?: number;
	/** A run is folding into this transcript right now. */
	readonly running: boolean;
}

/**
 * Server side: remembers the JSON of each message last sent and computes the next patch.
 */
export class SessionPatcher {

	private sent: string[] = [];
	private usage: { contextUsed?: number; contextWindow?: number } = {};
	private _rev = 0;

	constructor(readonly id: string) { }

	get rev(): number {
		return this._rev;
	}

	/** Starts over from a full transcript (what `session.open` returns). */
	reset(messages: readonly unknown[]): void {
		this.sent = messages.map(message => JSON.stringify(message));
	}

	/** The patch from what was last sent to `messages`, or undefined when nothing changed. */
	diff(messages: readonly unknown[], usage?: { contextUsed?: number; contextWindow?: number }): ISessionPatch | undefined {
		const set: { i: number; message: unknown }[] = [];
		const next: string[] = new Array(messages.length);
		for (let i = 0; i < messages.length; i++) {
			const json = JSON.stringify(messages[i]);
			next[i] = json;
			if (this.sent[i] !== json) {
				set.push({ i, message: JSON.parse(json) });
			}
		}
		const truncated = messages.length < this.sent.length;
		const usageChanged = !!usage && (usage.contextUsed !== this.usage.contextUsed || usage.contextWindow !== this.usage.contextWindow);
		if (!set.length && !truncated && !usageChanged) {
			return undefined;
		}
		this.sent = next;
		if (usage) {
			this.usage = { contextUsed: usage.contextUsed, contextWindow: usage.contextWindow };
		}
		return {
			id: this.id,
			rev: ++this._rev,
			len: messages.length,
			set,
			...(this.usage.contextUsed !== undefined ? { contextUsed: this.usage.contextUsed } : {}),
			...(this.usage.contextWindow !== undefined ? { contextWindow: this.usage.contextWindow } : {}),
		};
	}
}

/**
 * Client side: applies a patch in place. Returns false when the patch doesn't follow the held
 * revision (the caller reopens the session).
 */
export function applySessionPatch(messages: unknown[], heldRev: number, patch: ISessionPatch): boolean {
	if (patch.rev !== heldRev + 1) {
		return false;
	}
	messages.length = Math.min(messages.length, patch.len);
	for (const { i, message } of patch.set) {
		if (i > messages.length) {
			return false;
		}
		messages[i] = i < messages.length ? reconcile(messages[i], message) : message;
	}
	return messages.length === patch.len;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Makes `target` equal to `source` while keeping every object and array that survives as the same
 * instance, the way the in-process controller mutates a streaming reply. Views that key caches on
 * message, segment or block identity keep working. Returns what should take `target`'s place.
 */
export function reconcile(target: unknown, source: unknown): unknown {
	if (Array.isArray(target) && Array.isArray(source)) {
		target.length = Math.min(target.length, source.length);
		for (let i = 0; i < source.length; i++) {
			target[i] = i < target.length ? reconcile(target[i], source[i]) : source[i];
		}
		return target;
	}
	if (isPlainObject(target) && isPlainObject(source)) {
		for (const key of Object.keys(target)) {
			if (!(key in source)) {
				delete target[key];
			}
		}
		for (const [key, value] of Object.entries(source)) {
			target[key] = key in target ? reconcile(target[key], value) : value;
		}
		return target;
	}
	return source;
}
