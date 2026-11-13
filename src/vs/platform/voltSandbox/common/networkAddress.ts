/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IP addresses for the network broker (spec I.4 "Special ranges", INV-19). Pure: the Policy
 * Authority's floor and the broker read the same table, so a decision about an address is the same
 * at every layer.
 *
 * Only canonical text forms parse: a dotted quad of four decimal octets without leading zeros, and
 * RFC 4291 IPv6 text (with an optional dotted tail, no zone id). Anything a resolver might read as
 * a number in another base (`0x7f.1`, `017700000001`, `2130706433`, `127.1`) is not an address
 * here, and {@link isAmbiguousNumericHost} makes the broker refuse it rather than treat it as a name.
 */

/**
 * - `public`: globally routable unicast.
 * - `loopback`: `127/8`, `::1`; reachable only by `net.loopback.connect:<port>`.
 * - `local`: the LAN ranges marked `*` in I.4 (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`);
 *   reachable only by `net.local.connect` to that exact address or CIDR and port.
 * - `metadata`: cloud instance metadata; never reachable, whatever is granted.
 * - `special`: every other reserved range; never reachable.
 */
export type AddressClass = 'public' | 'loopback' | 'local' | 'metadata' | 'special';

export interface ISpecialRange {
	readonly cidr: string;
	readonly class: Exclude<AddressClass, 'public'>;
	readonly note: string;
}

/** Cloud metadata endpoints: AWS/GCP/Azure/OpenStack, AWS's IPv6 one, Alibaba's. */
export const METADATA_ADDRESSES: readonly string[] = ['169.254.169.254', 'fd00:ec2::254', '100.100.100.200'];

/** I.4's table. IPv4 inside IPv6 (mapped, compatible, NAT64, 6to4) is not here: it is judged as the IPv4 address. */
export const SPECIAL_RANGES: readonly ISpecialRange[] = [
	{ cidr: '0.0.0.0/8', class: 'special', note: 'this network' },
	{ cidr: '10.0.0.0/8', class: 'local', note: 'RFC 1918' },
	{ cidr: '100.64.0.0/10', class: 'special', note: 'CGNAT' },
	{ cidr: '127.0.0.0/8', class: 'loopback', note: 'loopback' },
	{ cidr: '169.254.0.0/16', class: 'special', note: 'link-local' },
	{ cidr: '172.16.0.0/12', class: 'local', note: 'RFC 1918' },
	{ cidr: '192.0.0.0/24', class: 'special', note: 'IETF protocol assignments' },
	{ cidr: '192.0.2.0/24', class: 'special', note: 'TEST-NET-1' },
	{ cidr: '192.88.99.0/24', class: 'special', note: '6to4 relay anycast' },
	{ cidr: '192.168.0.0/16', class: 'local', note: 'RFC 1918' },
	{ cidr: '198.18.0.0/15', class: 'special', note: 'benchmarking' },
	{ cidr: '198.51.100.0/24', class: 'special', note: 'TEST-NET-2' },
	{ cidr: '203.0.113.0/24', class: 'special', note: 'TEST-NET-3' },
	{ cidr: '224.0.0.0/4', class: 'special', note: 'multicast' },
	{ cidr: '240.0.0.0/4', class: 'special', note: 'reserved' },
	{ cidr: '255.255.255.255/32', class: 'special', note: 'broadcast' },
	{ cidr: '::/128', class: 'special', note: 'unspecified' },
	{ cidr: '::1/128', class: 'loopback', note: 'loopback' },
	{ cidr: '100::/64', class: 'special', note: 'discard' },
	// Teredo carries an obfuscated IPv4 address the broker can't judge: refused (stricter than I.4).
	{ cidr: '2001::/32', class: 'special', note: 'Teredo' },
	{ cidr: '2001:db8::/32', class: 'special', note: 'documentation' },
	{ cidr: 'fc00::/7', class: 'local', note: 'unique local' },
	{ cidr: 'fe80::/10', class: 'special', note: 'link-local' },
	{ cidr: 'fec0::/10', class: 'special', note: 'site-local' },
	{ cidr: 'ff00::/8', class: 'special', note: 'multicast' },
];

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

/** The 4 bytes of a canonical dotted quad; undefined for any other text. */
export function parseIPv4(text: string): Uint8Array | undefined {
	if (!IPV4.test(text)) {
		return undefined;
	}
	return Uint8Array.from(text.split('.').map(Number));
}

/** The 16 bytes of IPv6 text (`::` once, optional dotted tail); undefined for anything else, zone ids included. */
export function parseIPv6(text: string): Uint8Array | undefined {
	const value = text.toLowerCase();
	if (!value.includes(':') || !/^[0-9a-f:.]+$/.test(value) || value.split('::').length > 2) {
		return undefined;
	}
	let tail: number[] = [];
	let body = value;
	const lastColon = value.lastIndexOf(':');
	if (value.slice(lastColon + 1).includes('.')) {
		const v4 = parseIPv4(value.slice(lastColon + 1));
		if (!v4) {
			return undefined;
		}
		tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
		body = value.slice(0, lastColon + 1);
		if (body.endsWith(':') && !body.endsWith('::')) {
			body = body.slice(0, -1);
		}
	}
	const groups = (part: string): number[] | undefined => {
		if (!part) {
			return [];
		}
		const out: number[] = [];
		for (const group of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(group)) {
				return undefined;
			}
			out.push(parseInt(group, 16));
		}
		return out;
	};
	let words: number[];
	if (body.includes('::')) {
		const [head, rest] = body.split('::');
		const left = groups(head);
		const right = groups(rest);
		if (!left || !right) {
			return undefined;
		}
		const fill = 8 - left.length - right.length - tail.length;
		if (fill < 1) {
			return undefined;
		}
		words = [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
	} else {
		const all = groups(body);
		if (!all) {
			return undefined;
		}
		words = [...all, ...tail];
	}
	if (words.length !== 8) {
		return undefined;
	}
	const bytes = new Uint8Array(16);
	words.forEach((word, i) => {
		bytes[i * 2] = word >> 8;
		bytes[i * 2 + 1] = word & 0xff;
	});
	return bytes;
}

/** 4 or 6 for a canonical address, else 0. */
export function ipFamily(text: string): 0 | 4 | 6 {
	return parseIPv4(text) ? 4 : parseIPv6(text) ? 6 : 0;
}

function bytesToIPv4(bytes: ArrayLike<number>, at = 0): string {
	return `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;
}

/** Canonical text of an IPv6 address (lower case, longest zero run as `::`). */
function formatIPv6(bytes: Uint8Array): string {
	const words = Array.from({ length: 8 }, (_, i) => (bytes[i * 2] << 8) | bytes[i * 2 + 1]);
	let best = -1, bestLength = 0;
	for (let i = 0; i < 8;) {
		if (words[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < 8 && words[j] === 0) {
			j++;
		}
		if (j - i > bestLength && j - i > 1) {
			best = i;
			bestLength = j - i;
		}
		i = j;
	}
	const hex = words.map(word => word.toString(16));
	if (best < 0) {
		return hex.join(':');
	}
	return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLength).join(':')}`;
}

/** The address in one canonical spelling (`::FFFF:7F00:1` and `::ffff:127.0.0.1` alike); undefined if not an address. */
export function canonicalAddress(text: string): string | undefined {
	const v4 = parseIPv4(text);
	if (v4) {
		return text;
	}
	const v6 = parseIPv6(text);
	return v6 ? formatIPv6(v6) : undefined;
}

interface ICidr {
	readonly bytes: Uint8Array;
	readonly prefix: number;
}

/** `a.b.c.d/n` or `v6/n` (a bare address is its /32 or /128); undefined when malformed. */
export function parseCidr(text: string): ICidr | undefined {
	const slash = text.indexOf('/');
	const address = slash < 0 ? text : text.slice(0, slash);
	const bytes = parseIPv4(address) ?? parseIPv6(address);
	if (!bytes) {
		return undefined;
	}
	const max = bytes.length * 8;
	const prefix = slash < 0 ? max : /^\d{1,3}$/.test(text.slice(slash + 1)) ? Number(text.slice(slash + 1)) : NaN;
	return Number.isInteger(prefix) && prefix >= 0 && prefix <= max ? { bytes, prefix } : undefined;
}

function inCidr(bytes: Uint8Array, cidr: ICidr): boolean {
	if (bytes.length !== cidr.bytes.length) {
		return false;
	}
	let bits = cidr.prefix;
	for (let i = 0; bits > 0; i++, bits -= 8) {
		const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
		if ((bytes[i] & mask) !== (cidr.bytes[i] & mask)) {
			return false;
		}
	}
	return true;
}

/** Whether `address` (canonical text) is inside `cidr` (or is that address). IPv4 inside IPv6 is compared as IPv4. */
export function cidrContains(cidr: string, address: string): boolean {
	const range = parseCidr(cidr);
	if (!range) {
		return false;
	}
	const judged = judgedAs(address);
	return judged.some(bytes => inCidr(bytes, range));
}

const PARSED_RANGES = SPECIAL_RANGES.map(range => ({ ...range, parsed: parseCidr(range.cidr)! }));
const PARSED_METADATA = METADATA_ADDRESSES.map(address => (parseIPv4(address) ?? parseIPv6(address))!);

/**
 * The IPv4 address(es) an IPv6 address stands for, if it embeds one: `::ffff:0:0/96` (mapped),
 * `::ffff:0:0:0/96` (SIIT, RFC 2765), `::/96` (compatible, deprecated), `64:ff9b::/96` (NAT64), `2002::/16` (6to4) and `64:ff9b:1::/48`
 * (RFC 8215 local-use NAT64), where a network may put the IPv4 address at any RFC 6052 position, so
 * every reading counts.
 */
function embeddedIPv4(bytes: Uint8Array): Uint8Array[] | undefined {
	const zero = (from: number, to: number) => bytes.slice(from, to).every(b => b === 0);
	if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return [bytes.slice(12, 16)];
	}
	if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12)) {
		return [bytes.slice(12, 16)];
	}
	if (zero(0, 12) && !(zero(12, 15) && bytes[15] <= 1)) {
		return [bytes.slice(12, 16)];
	}
	if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
		if (zero(4, 12)) {
			return [bytes.slice(12, 16)];
		}
		if (bytes[4] === 0x00 && bytes[5] === 0x01) {
			// RFC 6052 positions: /48 bytes 6,7,9,10; /56 7,9,10,11; /64 9..12; /96 12..15 (byte 8 is always zero).
			return [[6, 7, 9, 10], [7, 9, 10, 11], [9, 10, 11, 12], [12, 13, 14, 15]].map(at => Uint8Array.from(at.map(i => bytes[i])));
		}
	}
	if (bytes[0] === 0x20 && bytes[1] === 0x02) {
		return [bytes.slice(2, 6)];
	}
	return undefined;
}

/** The byte forms an address is judged as: itself, or the IPv4 address(es) it embeds. */
function judgedAs(address: string): Uint8Array[] {
	const v4 = parseIPv4(address);
	if (v4) {
		return [v4];
	}
	const v6 = parseIPv6(address);
	if (!v6) {
		return [];
	}
	return embeddedIPv4(v6) ?? [v6];
}

const RANK: Readonly<Record<AddressClass, number>> = { public: 0, local: 1, loopback: 2, special: 3, metadata: 4 };

function classifyBytes(bytes: Uint8Array): AddressClass {
	if (PARSED_METADATA.some(meta => meta.length === bytes.length && meta.every((b, i) => b === bytes[i]))) {
		return 'metadata';
	}
	let found: AddressClass = 'public';
	for (const range of PARSED_RANGES) {
		if (inCidr(bytes, range.parsed) && RANK[range.class] > RANK[found]) {
			found = range.class;
		}
	}
	return found;
}

export interface IAddressClassification {
	readonly class: AddressClass;
	/** The address the class is about: the IPv4 one for an embedding form, else the address itself (canonical). */
	readonly judged: string;
}

/**
 * The class of an address, or undefined when the text is not a canonical address. An embedding
 * form is judged as its IPv4 address (a LAN or loopback one making it `special`); with several
 * readings (`64:ff9b:1::/48`) the worst counts, and a non-public reading there is `special` (the
 * grant it would need can't be told apart).
 */
export function classifyAddress(text: string): IAddressClassification | undefined {
	const v4 = parseIPv4(text);
	const v6 = v4 ? undefined : parseIPv6(text);
	if (!v4 && !v6) {
		return undefined;
	}
	if (v4) {
		return { class: classifyBytes(v4), judged: text };
	}
	// The embedded address must not hide the IPv6 one's own class (fd00:ec2::254 is metadata, not 0.0.2.84).
	const own = classifyBytes(v6!);
	const readings = embeddedIPv4(v6!);
	if (!readings) {
		return { class: own, judged: formatIPv6(v6!) };
	}
	const classes = readings.map(classifyBytes);
	const worst = classes.reduce((a, b) => RANK[b] > RANK[a] ? b : a, 'public' as AddressClass);
	// A LAN or loopback address in an IPv6 disguise is refused outright (`special`): the grants that
	// open those name the address itself (`net.local.connect`, `net.loopback.connect:<port>`), and a
	// NAT64 or 6to4 form of `127.0.0.1` is someone else's machine, not this one.
	const judged = (cls: AddressClass): AddressClass => cls === 'local' || cls === 'loopback' ? 'special' : cls;
	if (readings.length > 1) {
		return { class: worst === 'public' ? 'public' : worst === 'metadata' ? 'metadata' : 'special', judged: bytesToIPv4(readings[readings.length - 1]) };
	}
	return { class: judged(RANK[own] > RANK[worst] ? own : worst), judged: bytesToIPv4(readings[0]) };
}

/** True only for a canonical, globally routable unicast address. */
export function isPublicAddress(text: string): boolean {
	return classifyAddress(text)?.class === 'public';
}

/**
 * A host a resolver could read as an IPv4 number in some base (WHATWG URL, `inet_aton`): its last
 * label is all digits or `0x` hex, but it is not a canonical dotted quad. `2130706433`,
 * `0x7f000001`, `0177.0.0.1`, `127.1`, `127.0.0.01`, `1.2.3.4.5`. Refused, never resolved.
 */
export function isAmbiguousNumericHost(host: string): boolean {
	const labels = host.replace(/\.$/, '').split('.');
	const last = labels[labels.length - 1];
	return /^(?:0x[0-9a-f]*|\d+)$/i.test(last) && !parseIPv4(host.replace(/\.$/, ''));
}
