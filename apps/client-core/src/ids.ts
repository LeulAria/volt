/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

function randomBytes(n: number): Uint8Array {
	const bytes = new Uint8Array(n);
	const crypto = (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
	if (crypto?.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < n; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return bytes;
}

/** RFC 4122 v4. */
export function uuid(): string {
	const b = randomBytes(16);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A new chat's id, in the agent window's form (`agent-<uuid>`). */
export function newChatId(): string {
	return `agent-${uuid()}`;
}
