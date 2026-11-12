/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { userInfo } from 'os';
import { IAdminPolicy, parseAdminPolicy } from '../common/authority.js';

/**
 * The admin layer's source (spec G.1): managed policy in OS-protected locations, which only an
 * administrator (or MDM) can write.
 *
 * - macOS: managed preferences for `com.volt.policy` (`/Library/Managed Preferences/com.volt.policy.plist`,
 *   or the per-user one MDM writes), XML or binary plist.
 * - Linux: `/etc/volt/policy.json`, owned by root and writable by nobody else.
 * - Windows: `HKLM\Software\Policies\Volt`, value `Policy` (a JSON string).
 *
 * The policy's keys are the `IAdminPolicy` fields (`denyCapabilities`, `denyHosts`,
 * `maxThirdPartyClass`), or one `Policy` key holding them as JSON. A policy that exists but can't be
 * read or trusted (wrong owner, malformed) is `unreadable`: third parties then get nothing above
 * class `none`. The reader is injectable so tests never touch the real locations.
 */

export interface IAdminPolicySource {
	/** Undefined: no managed policy. `unreadable`: one is there but can't be read or trusted. */
	read(): Promise<{ readonly source: string; readonly value: unknown } | { readonly source: string; readonly unreadable: string } | undefined>;
}

export const LINUX_ADMIN_POLICY_PATH = '/etc/volt/policy.json';
export const MAC_MANAGED_PREFS_DIR = '/Library/Managed Preferences';
export const MAC_POLICY_DOMAIN = 'com.volt.policy';
export const WINDOWS_POLICY_KEY = 'SOFTWARE\\Policies\\Volt';

/** Reads the admin policy through `source`. Never throws; a broken source is `unreadable`. */
export async function readAdminPolicy(source: IAdminPolicySource): Promise<IAdminPolicy & { readonly source?: string; readonly problem?: string }> {
	let found: Awaited<ReturnType<IAdminPolicySource['read']>>;
	try {
		found = await source.read();
	} catch (err) {
		return { unreadable: true, problem: err instanceof Error ? err.message : String(err) };
	}
	if (!found) {
		return {};
	}
	if ('unreadable' in found) {
		return { unreadable: true, source: found.source, problem: found.unreadable };
	}
	let value = found.value;
	if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).Policy === 'string') {
		try {
			value = JSON.parse((value as Record<string, string>).Policy);
		} catch {
			return { unreadable: true, source: found.source, problem: 'Policy is not JSON' };
		}
	}
	const policy = parseAdminPolicy(value);
	return { ...policy, source: found.source, ...(policy.unreadable ? { problem: 'the policy does not match the schema' } : {}) };
}

/** The managed locations of `platform`. */
export function systemAdminPolicySource(platform: NodeJS.Platform = process.platform): IAdminPolicySource {
	switch (platform) {
		case 'linux':
			return { read: () => readRootOwnedJson(LINUX_ADMIN_POLICY_PATH) };
		case 'darwin':
			return { read: () => readManagedPreferences() };
		case 'win32':
			return { read: () => readWindowsPolicy() };
		default:
			return { read: async () => undefined };
	}
}

async function readRootOwnedJson(path: string): Promise<Awaited<ReturnType<IAdminPolicySource['read']>>> {
	const stat = await fs.stat(path).catch(() => undefined);
	if (!stat) {
		return undefined;
	}
	if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
		return { source: path, unreadable: 'not owned by root, or writable by others' };
	}
	try {
		return { source: path, value: JSON.parse(await fs.readFile(path, 'utf8')) };
	} catch (err) {
		return { source: path, unreadable: err instanceof Error ? err.message : String(err) };
	}
}

async function readManagedPreferences(): Promise<Awaited<ReturnType<IAdminPolicySource['read']>>> {
	let user: string | undefined;
	try {
		user = userInfo().username;
	} catch {
		user = undefined;
	}
	// The per-user file MDM writes wins over the machine one, as cfprefsd resolves managed prefs.
	const candidates = [...(user ? [`${MAC_MANAGED_PREFS_DIR}/${user}/${MAC_POLICY_DOMAIN}.plist`] : []), `${MAC_MANAGED_PREFS_DIR}/${MAC_POLICY_DOMAIN}.plist`];
	for (const path of candidates) {
		const stat = await fs.stat(path).catch(() => undefined);
		if (!stat) {
			continue;
		}
		if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
			return { source: path, unreadable: 'not owned by root, or writable by others' };
		}
		try {
			return { source: path, value: parsePlist(await fs.readFile(path)) };
		} catch (err) {
			return { source: path, unreadable: err instanceof Error ? err.message : String(err) };
		}
	}
	return undefined;
}

async function readWindowsPolicy(): Promise<Awaited<ReturnType<IAdminPolicySource['read']>>> {
	const source = `HKLM\\${WINDOWS_POLICY_KEY}`;
	let text: string | undefined;
	try {
		const registry = await import('@vscode/windows-registry');
		text = registry.GetStringRegKey('HKEY_LOCAL_MACHINE', WINDOWS_POLICY_KEY, 'Policy');
	} catch (err) {
		return { source, unreadable: err instanceof Error ? err.message : String(err) };
	}
	if (text === undefined || text === '') {
		return undefined;
	}
	try {
		return { source, value: JSON.parse(text) };
	} catch {
		return { source, unreadable: 'Policy is not JSON' };
	}
}

// --- plist (managed preferences): XML and binary, the value types a policy uses ----------------

/** Parses an XML or binary (`bplist00`) property list. Supports dict, array, string, integer, real, true/false. */
export function parsePlist(bytes: Uint8Array): unknown {
	const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
	return head === 'bplist00' ? parseBinaryPlist(Buffer.from(bytes)) : parseXmlPlist(Buffer.from(bytes).toString('utf8'));
}

function parseXmlPlist(text: string): unknown {
	const tokens = text.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/i, '').replace(/<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) ?? [];
	let index = 0;
	const next = (): string | undefined => {
		while (index < tokens.length && !tokens[index].trim()) {
			index++;
		}
		return tokens[index++];
	};
	const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
	const textUntil = (close: string): string => {
		let out = '';
		while (index < tokens.length && tokens[index] !== close) {
			out += tokens[index++];
		}
		if (tokens[index++] !== close) {
			throw new Error(`plist: missing ${close}`);
		}
		return unescape(out);
	};
	const value = (token: string | undefined, depth: number): unknown => {
		if (depth > 32 || token === undefined) {
			throw new Error('plist: too deep or truncated');
		}
		switch (token) {
			case '<dict>': {
				const out: Record<string, unknown> = {};
				for (let key = next(); key !== '</dict>'; key = next()) {
					if (key !== '<key>') {
						throw new Error('plist: expected a key');
					}
					const name = textUntil('</key>');
					const item = value(next(), depth + 1);
					if (name !== '__proto__') {
						out[name] = item;
					}
				}
				return out;
			}
			case '<dict/>': return {};
			case '<array>': {
				const out: unknown[] = [];
				for (let item = next(); item !== '</array>'; item = next()) {
					out.push(value(item, depth + 1));
				}
				return out;
			}
			case '<array/>': return [];
			case '<string>': return textUntil('</string>');
			case '<string/>': return '';
			case '<integer>': return Number(textUntil('</integer>').trim());
			case '<real>': return Number(textUntil('</real>').trim());
			case '<true/>': return true;
			case '<false/>': return false;
		}
		throw new Error(`plist: unsupported ${token.slice(0, 20)}`);
	};
	let token = next();
	if (token?.startsWith('<plist')) {
		token = next();
	}
	return value(token, 0);
}

function parseBinaryPlist(buffer: Buffer): unknown {
	if (buffer.length < 40) {
		throw new Error('bplist: truncated');
	}
	const trailer = buffer.subarray(buffer.length - 32);
	const offsetSize = trailer[6];
	const refSize = trailer[7];
	const count = Number(trailer.readBigUInt64BE(8));
	const top = Number(trailer.readBigUInt64BE(16));
	const tableOffset = Number(trailer.readBigUInt64BE(24));
	if (count > 100_000 || tableOffset + count * offsetSize > buffer.length - 32 || offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) {
		throw new Error('bplist: bad trailer');
	}
	const uint = (at: number, size: number): number => {
		let out = 0;
		for (let i = 0; i < size; i++) {
			out = out * 256 + buffer[at + i];
		}
		return out;
	};
	const offsets = Array.from({ length: count }, (_, i) => uint(tableOffset + i * offsetSize, offsetSize));
	const object = (ref: number, depth: number): unknown => {
		if (depth > 32 || ref >= count) {
			throw new Error('bplist: bad reference');
		}
		let at = offsets[ref];
		const marker = buffer[at];
		const kind = marker >> 4;
		let length = marker & 0x0f;
		const lengthAt = () => {
			if (length === 0x0f) {
				const size = 1 << (buffer[at + 1] & 0x0f);
				length = uint(at + 2, size);
				at += 1 + size;
			}
		};
		switch (kind) {
			case 0x0:
				return marker === 0x09 ? true : marker === 0x08 ? false : null;
			case 0x1: {
				const size = 1 << length;
				return size === 8 ? Number(buffer.readBigInt64BE(at + 1)) : uint(at + 1, size);
			}
			case 0x2:
				return length === 3 ? buffer.readDoubleBE(at + 1) : buffer.readFloatBE(at + 1);
			case 0x5:
				lengthAt();
				return buffer.subarray(at + 1, at + 1 + length).toString('latin1');
			case 0x6: {
				lengthAt();
				const chars: string[] = [];
				for (let i = 0; i < length; i++) {
					chars.push(String.fromCharCode(buffer.readUInt16BE(at + 1 + i * 2)));
				}
				return chars.join('');
			}
			case 0xA: {
				lengthAt();
				return Array.from({ length }, (_, i) => object(uint(at + 1 + i * refSize, refSize), depth + 1));
			}
			case 0xD: {
				lengthAt();
				const out: Record<string, unknown> = {};
				for (let i = 0; i < length; i++) {
					const key = String(object(uint(at + 1 + i * refSize, refSize), depth + 1));
					const item = object(uint(at + 1 + (length + i) * refSize, refSize), depth + 1);
					if (key !== '__proto__') {
						out[key] = item;
					}
				}
				return out;
			}
		}
		throw new Error(`bplist: unsupported object type ${kind}`);
	};
	return object(top, 0);
}
