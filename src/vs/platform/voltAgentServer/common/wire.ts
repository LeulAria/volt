/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { MarshalledId } from '../../../base/common/marshallingIds.js';
import { URI } from '../../../base/common/uri.js';

/**
 * Values crossing the socket are JSON. Two kinds of objects in Volt's state don't survive plain
 * JSON: byte arrays (pasted images, video stills) and URIs. `toWire` turns bytes into
 * `{ $u8: base64 }` (URIs already serialize with `$mid`); `fromWire` brings both back.
 */
export function toWire(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return { $u8: encodeBase64(VSBuffer.wrap(value)) };
	}
	if (Array.isArray(value)) {
		let copy: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const next = toWire(value[i]);
			if (next !== value[i]) {
				copy ??= value.slice();
				copy[i] = next;
			}
		}
		return copy ?? value;
	}
	if (value && typeof value === 'object') {
		if (URI.isUri(value)) {
			return value.toJSON();
		}
		let copy: Record<string, unknown> | undefined;
		for (const [key, entry] of Object.entries(value)) {
			const next = toWire(entry);
			if (next !== entry) {
				copy ??= { ...value as Record<string, unknown> };
				copy[key] = next;
			}
		}
		return copy ?? value;
	}
	return value;
}

/** Revives what {@link toWire} encoded, in place where it can. */
export function fromWire<T = unknown>(value: unknown): T {
	return revive(value) as T;
}

function revive(value: unknown): unknown {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			value[i] = revive(value[i]);
		}
		return value;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.$u8 === 'string' && Object.keys(record).length === 1) {
			return decodeBase64(record.$u8).buffer;
		}
		if (record.$mid === MarshalledId.Uri) {
			return URI.revive(record as unknown as URI);
		}
		for (const key of Object.keys(record)) {
			record[key] = revive(record[key]);
		}
		return record;
	}
	return value;
}
