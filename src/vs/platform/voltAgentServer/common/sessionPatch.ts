/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A chat transcript travels as patches: the server folds run events into messages (as the agent
 * window always has) and sends only the messages whose JSON changed. A client holding revision
 * `rev - 1` applies the patch; anything else means it missed one and must reopen the session.
 *
 * Patches come in two forms. The full form (`session` topic) carries every changed message whole.
 * The compact form (`sessionEdits` topic) carries a changed message as {@link SessionEdit}s: a
 * streaming reply grows by the text it streamed, not by the whole reply with every tool output in
 * it, which with a hundred chats at work is the difference between kilobytes and megabytes a second.
 */
export interface ISessionPatch {
	readonly id: string;
	/** Increments by one per patch of this session. */
	readonly rev: number;
	/** The transcript's length after the patch (shorter = truncated). */
	readonly len: number;
	/** Messages that are new or replaced whole. */
	readonly set: readonly { readonly i: number; readonly message: unknown }[];
	/** Compact form only: messages the client has, changed by edits. */
	readonly edit?: readonly { readonly i: number; readonly edits: readonly SessionEdit[] }[];
	readonly contextUsed?: number;
	readonly contextWindow?: number;
}

/** Keys and indexes from a message down to the value an edit changes. */
export type SessionEditPath = readonly (string | number)[];

/** One change inside a message. */
export type SessionEdit =
	/** Sets the value at the path (added or replaced). */
	| { readonly p: SessionEditPath; readonly v: unknown }
	/** Appends `s` to the string at the path, which must be `at` characters long. */
	| { readonly p: SessionEditPath; readonly s: string; readonly at: number }
	/** Cuts the array at the path to `n` entries. */
	| { readonly p: SessionEditPath; readonly n: number }
	/** Deletes the key at the path. */
	| { readonly p: SessionEditPath; readonly x: 1 };

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

/** One revision of a session in both forms (see {@link ISessionPatch}). */
export interface ISessionPatches {
	readonly full: ISessionPatch;
	readonly compact: ISessionPatch;
}

/**
 * Server side: remembers the JSON of each message last sent and computes the next patch.
 */
export class SessionPatcher {

	private sent: string[] = [];
	private usage: { contextUsed?: number; contextWindow?: number } = {};
	private _rev = 0;

	/** `encode` turns a message into what goes on the wire (JSON-safe). */
	constructor(readonly id: string, private readonly encode: (message: unknown) => unknown = message => message) { }

	get rev(): number {
		return this._rev;
	}

	/** Starts over from a full transcript (what `session.open` returns). */
	reset(messages: readonly unknown[]): void {
		this.sent = messages.map(message => JSON.stringify(this.encode(message)));
	}

	/** The full-form patch from what was last sent to `messages`, or undefined when nothing changed. */
	diff(messages: readonly unknown[], usage?: { contextUsed?: number; contextWindow?: number }): ISessionPatch | undefined {
		return this.diffPatches(messages, usage)?.full;
	}

	/**
	 * Both forms of the patch from what was last sent to `messages`, or undefined when nothing
	 * changed. Messages before `from` are taken as unchanged and not even read, so a streaming
	 * reply costs what the current turn holds, not the whole transcript.
	 */
	diffPatches(messages: readonly unknown[], usage?: { contextUsed?: number; contextWindow?: number }, from = 0): ISessionPatches | undefined {
		const start = Math.max(0, Math.min(from, messages.length, this.sent.length));
		const full: { i: number; message: unknown }[] = [];
		const set: { i: number; message: unknown }[] = [];
		const edit: { i: number; edits: SessionEdit[] }[] = [];
		const next = this.sent.slice(0, messages.length);
		for (let i = start; i < messages.length; i++) {
			const json = JSON.stringify(this.encode(messages[i]));
			const before = this.sent[i];
			if (before === json) {
				continue;
			}
			next[i] = json;
			const message = JSON.parse(json);
			full.push({ i, message });
			const edits = before === undefined ? undefined : sessionEdits(JSON.parse(before), message);
			if (edits && JSON.stringify(edits).length < json.length) {
				edit.push({ i, edits });
			} else {
				set.push({ i, message });
			}
		}
		const truncated = messages.length < this.sent.length;
		const usageChanged = !!usage && (usage.contextUsed !== this.usage.contextUsed || usage.contextWindow !== this.usage.contextWindow);
		if (!full.length && !truncated && !usageChanged) {
			return undefined;
		}
		this.sent = next;
		if (usage) {
			this.usage = { contextUsed: usage.contextUsed, contextWindow: usage.contextWindow };
		}
		const common = {
			id: this.id,
			rev: ++this._rev,
			len: messages.length,
			...(this.usage.contextUsed !== undefined ? { contextUsed: this.usage.contextUsed } : {}),
			...(this.usage.contextWindow !== undefined ? { contextWindow: this.usage.contextWindow } : {}),
		};
		return {
			full: { ...common, set: full },
			compact: { ...common, set, ...(edit.length ? { edit } : {}) },
		};
	}
}

/**
 * The edits that turn JSON value `before` into `after` (both as `JSON.parse` returns them), or
 * undefined when `after` must replace `before` whole. Values encoded for the wire (`$mid`, `$u8`)
 * change whole: the client revives them into objects of their own.
 */
export function sessionEdits(before: unknown, after: unknown): SessionEdit[] | undefined {
	const edits: SessionEdit[] = [];
	collectEdits(before, after, [], edits);
	return edits.some(edit => !edit.p.length) ? undefined : edits;
}

function collectEdits(before: unknown, after: unknown, path: (string | number)[], edits: SessionEdit[]): void {
	if (before === after) {
		return;
	}
	if (typeof before === 'string' && typeof after === 'string') {
		if (before.length && after.length > before.length && after.startsWith(before)) {
			edits.push({ p: path, s: after.slice(before.length), at: before.length });
		} else {
			edits.push({ p: path, v: after });
		}
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		if (after.length < before.length) {
			edits.push({ p: path, n: after.length });
		}
		for (let i = 0; i < after.length; i++) {
			if (i < before.length) {
				collectEdits(before[i], after[i], [...path, i], edits);
			} else {
				edits.push({ p: [...path, i], v: after[i] });
			}
		}
		return;
	}
	if (isEditableObject(before) && isEditableObject(after)) {
		for (const key of Object.keys(before)) {
			if (!Object.hasOwn(after, key)) {
				edits.push({ p: [...path, key], x: 1 });
			}
		}
		for (const [key, value] of Object.entries(after)) {
			if (Object.hasOwn(before, key)) {
				collectEdits(before[key], value, [...path, key], edits);
			} else {
				edits.push({ p: [...path, key], v: value });
			}
		}
		return;
	}
	edits.push({ p: path, v: after });
}

function isEditableObject(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value) && !Object.hasOwn(value, '$mid') && !Object.hasOwn(value, '$u8');
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Client side: applies `edits` to `target` in place (objects that survive stay the same
 * instances). `revive` turns a set value from the wire into the client's form. Returns false when
 * an edit does not fit what the client holds (it then reopens the session).
 */
export function applySessionEdits(target: unknown, edits: readonly SessionEdit[], revive: (value: unknown) => unknown = value => value): boolean {
	for (const edit of edits) {
		if (!edit.p.length || edit.p.some(key => typeof key === 'string' && UNSAFE_KEYS.has(key))) {
			return false;
		}
		let parent = target;
		for (let k = 0; k < edit.p.length - 1; k++) {
			parent = parent && typeof parent === 'object' ? (parent as Record<string | number, unknown>)[edit.p[k]] : undefined;
		}
		if (!parent || typeof parent !== 'object') {
			return false;
		}
		const holder = parent as Record<string | number, unknown>;
		const key = edit.p[edit.p.length - 1];
		if (Array.isArray(holder) !== (typeof key === 'number')) {
			return false;
		}
		if ('s' in edit) {
			const current = holder[key];
			if (typeof current !== 'string' || current.length !== edit.at) {
				return false;
			}
			holder[key] = current + edit.s;
		} else if ('n' in edit) {
			const current = holder[key];
			if (!Array.isArray(current)) {
				return false;
			}
			current.length = Math.min(current.length, edit.n);
		} else if ('x' in edit) {
			if (Array.isArray(holder)) {
				return false;
			}
			delete holder[key];
		} else {
			if (Array.isArray(holder) && (key as number) > holder.length) {
				return false;
			}
			holder[key] = revive(edit.v);
		}
	}
	return true;
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
	for (const { i, edits } of patch.edit ?? []) {
		if (i >= messages.length || !applySessionEdits(messages[i], edits)) {
			return false;
		}
	}
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
