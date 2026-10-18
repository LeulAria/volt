/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One shared app state per project, after pi-durable's App State: a JSON document every agent of
 * the project (chats, subagents, delegated tasks, automation runs) reads and changes through
 * `state_read` / `state_update`. Each update is a list of path operations applied together, so
 * two agents changing different fields never overwrite each other, and a writer that read an
 * older revision can ask for its update to be refused. It lives on disk next to the chats, so it
 * survives crashes, restarts, compaction and new chats: the place to keep what the work is, how
 * far it got, and the facts agents hand each other.
 */

export const STATE_READ_TOOL_NAME = 'state_read';
export const STATE_UPDATE_TOOL_NAME = 'state_update';

/** The document's largest serialized size. */
export const MAX_STATE_CHARS = 256 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface IAppStateFile {
	readonly version: 1;
	readonly revision: number;
	readonly updatedAt: number;
	readonly doc: { [key: string]: JsonValue };
}

export type AppStateOp =
	| { readonly op: 'set'; readonly path: string; readonly value: JsonValue }
	| { readonly op: 'delete'; readonly path: string }
	| { readonly op: 'increment'; readonly path: string; readonly by?: number }
	| { readonly op: 'append'; readonly path: string; readonly value: JsonValue };

export function emptyAppState(): IAppStateFile {
	return { version: 1, revision: 0, updatedAt: 0, doc: {} };
}

/** `tasks.migration.done` or `items.2.name`; an empty path is the whole document. */
export function statePath(path: string): string[] {
	return path.split('.').map(part => part.trim()).filter(Boolean);
}

/** The value at `path`, or `undefined` when nothing is there. */
export function readStateValue(doc: JsonValue, path: string): JsonValue | undefined {
	let value: JsonValue | undefined = doc;
	for (const key of statePath(path)) {
		if (Array.isArray(value)) {
			value = /^\d+$/.test(key) ? value[Number(key)] : undefined;
		} else if (value && typeof value === 'object') {
			value = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
		} else {
			return undefined;
		}
	}
	return value;
}

/** The ops a tool call asked for, or why they are not valid. */
export function parseStateOps(raw: unknown): { readonly ops: AppStateOp[] } | { readonly error: string } {
	const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
	if (!list.length) {
		return { error: 'state_update needs `ops`: a list of { op: "set" | "delete" | "increment" | "append", path, value? }.' };
	}
	const ops: AppStateOp[] = [];
	for (const item of list) {
		const entry = item as Record<string, unknown>;
		const path = typeof entry.path === 'string' ? entry.path : '';
		if (!statePath(path).length) {
			return { error: 'Every op needs a non-empty `path` such as "migration.done".' };
		}
		if (statePath(path).some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
			return { error: `Path "${path}" is not allowed.` };
		}
		switch (entry.op) {
			case 'set':
			case 'append':
				if (!('value' in entry)) {
					return { error: `${entry.op} at "${path}" needs a \`value\`.` };
				}
				ops.push({ op: entry.op, path, value: entry.value as JsonValue });
				break;
			case 'delete':
				ops.push({ op: 'delete', path });
				break;
			case 'increment':
				ops.push({ op: 'increment', path, ...(typeof entry.by === 'number' ? { by: entry.by } : {}) });
				break;
			default:
				return { error: `Unknown op "${String(entry.op)}"; use set, delete, increment or append.` };
		}
	}
	return { ops };
}

/** The document after `ops`, all or nothing. */
export function applyStateOps(doc: { [key: string]: JsonValue }, ops: readonly AppStateOp[]): { readonly doc: { [key: string]: JsonValue } } | { readonly error: string } {
	const next = structuredClone(doc);
	for (const op of ops) {
		const keys = statePath(op.path);
		const last = keys[keys.length - 1];
		let parent: JsonValue = next;
		for (const key of keys.slice(0, -1)) {
			const container: JsonValue = parent;
			if (Array.isArray(container)) {
				if (!/^\d+$/.test(key) || Number(key) >= container.length) {
					return { error: `"${op.path}": no item ${key} in that list.` };
				}
				parent = container[Number(key)];
			} else if (container && typeof container === 'object') {
				const child: JsonValue | undefined = container[key];
				if (child === undefined || child === null || typeof child !== 'object') {
					if (op.op === 'delete') {
						parent = null;
						break;
					}
					container[key] = {};
				}
				parent = container[key];
			} else {
				return { error: `"${op.path}": ${key} is inside a ${typeof container}, not an object.` };
			}
		}
		if (parent === null || typeof parent !== 'object') {
			if (op.op === 'delete') {
				continue;
			}
			return { error: `"${op.path}" does not lead to an object or a list.` };
		}
		const target: JsonValue[] | { [key: string]: JsonValue } = parent;
		const index = Array.isArray(target) && /^\d+$/.test(last) ? Number(last) : undefined;
		if (Array.isArray(target) && index === undefined) {
			return { error: `"${op.path}": ${last} is not a list position.` };
		}
		const current = Array.isArray(target) ? target[index!] : target[last];
		switch (op.op) {
			case 'set':
				if (Array.isArray(target)) {
					target[index!] = op.value;
				} else {
					target[last] = op.value;
				}
				break;
			case 'delete':
				if (Array.isArray(target)) {
					if (index! < target.length) {
						target.splice(index!, 1);
					}
				} else {
					delete target[last];
				}
				break;
			case 'increment': {
				if (current !== undefined && typeof current !== 'number') {
					return { error: `"${op.path}" holds a ${Array.isArray(current) ? 'list' : typeof current}, not a number.` };
				}
				const value = (current ?? 0) + (op.by ?? 1);
				if (Array.isArray(target)) {
					target[index!] = value;
				} else {
					target[last] = value;
				}
				break;
			}
			case 'append': {
				if (current !== undefined && !Array.isArray(current)) {
					return { error: `"${op.path}" holds a ${typeof current}, not a list.` };
				}
				const list = current ?? [];
				list.push(op.value);
				if (Array.isArray(target)) {
					target[index!] = list;
				} else {
					target[last] = list;
				}
				break;
			}
		}
	}
	if (JSON.stringify(next).length > MAX_STATE_CHARS) {
		return { error: `The state would pass ${MAX_STATE_CHARS / 1024} KB. Keep progress and facts in it, not file contents or logs.` };
	}
	return { doc: next };
}

/** A read for the model: the value, its revision, and what is there when nothing is. */
export function renderStateRead(file: IAppStateFile, path: string): string {
	const value = readStateValue(file.doc, path);
	const where = path.trim() ? `"${path.trim()}"` : 'the project state';
	if (value === undefined) {
		return `Nothing at ${where} (revision ${file.revision}). Top-level keys: ${Object.keys(file.doc).join(', ') || '(none yet)'}.`;
	}
	const text = JSON.stringify(value, undefined, 1);
	return `${where} at revision ${file.revision}:\n${text.length > 30_000 ? `${text.slice(0, 30_000)}\n[... cut; read a narrower path]` : text}`;
}
