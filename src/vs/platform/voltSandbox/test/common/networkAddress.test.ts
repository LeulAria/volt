/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The network broker's pure parts (spec I.4, C3): the special-range table, host normalisation, the
 * host rules and the exfil list, and the Policy Authority's address floor. The range table has a
 * property test: every encoding of a special address is refused or judged non-public (NET-PROP-1).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { evaluate, IAccessRequest, PolicySnapshot } from '../../common/authority.js';
import { IGrant } from '../../common/grants.js';
import { canonicalAddress, classifyAddress, cidrContains, METADATA_ADDRESSES, parseCidr, SPECIAL_RANGES } from '../../common/networkAddress.js';
import { EXFIL_HOSTS, INormalizedHost, isExfilHost, isPublicSuffix, networkRulesCover, normalizeNetworkHost, parseNetworkRule } from '../../common/networkRules.js';
import { IPrincipal, SubjectKey } from '../../common/principals.js';
import { forAll, Gen } from './seededGen.js';

const host = (raw: string): INormalizedHost => {
	const normalized = normalizeNetworkHost(raw);
	assert.ok(typeof normalized === 'object', `${raw} normalises: ${normalized}`);
	return normalized;
};

const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);

/** Every spelling Volt knows of an IPv4 address as an IPv6 one, and the forms a resolver might read as it. */
function ipv4Encodings(b: readonly number[], gen: Gen): { readonly address: string[]; readonly numeric: string[] } {
	const [a, b2, c, d] = b;
	const dotted = `${a}.${b2}.${c}.${d}`;
	const h1 = hex(a, b2), h2 = hex(c, d);
	const upper = (text: string) => gen.bool() ? text.toUpperCase() : text;
	// RFC 6052 positions inside 64:ff9b:1::/48 (byte 8 always zero).
	const local64 = [[6, 7, 9, 10], [7, 9, 10, 11], [9, 10, 11, 12], [12, 13, 14, 15]].map(at => {
		const bytes = new Array<number>(16).fill(0);
		bytes.splice(0, 6, 0x00, 0x64, 0xff, 0x9b, 0x00, 0x01);
		at.forEach((i, k) => bytes[i] = b[k]);
		return Array.from({ length: 8 }, (_, i) => hex(bytes[i * 2], bytes[i * 2 + 1])).join(':');
	});
	const address = [
		dotted, `${dotted}.`,
		upper(`::ffff:${dotted}`), upper(`::ffff:${h1}:${h2}`), `0:0:0:0:0:ffff:${dotted}`, `[::ffff:${dotted}]`,
		upper(`64:ff9b::${dotted}`), upper(`64:ff9b::${h1}:${h2}`), `0064:ff9b:0000:0000:0000:0000:${h1}:${h2}`,
		...local64,
		upper(`2002:${h1}:${h2}::`), `2002:${h1}:${h2}:${gen.int(0xffff).toString(16)}::${gen.int(0xffff).toString(16)}`,
	];
	// `::a.b.c.d` (compatible) stands for the IPv4 address except for `::` and `::1`, which are special anyway.
	address.push(`::${dotted}`);
	const value = ((a << 24) >>> 0) + (b2 << 16) + (c << 8) + d;
	const numeric = [
		String(value), `0x${value.toString(16)}`, `0${value.toString(8)}`,
		`0${a.toString(8)}.${b2}.${c}.${d}`, `0x${a.toString(16)}.${b2}.${c}.${d}`, `${a}.${(b2 << 16) + (c << 8) + d}`,
		`${a}.${b2}.${c}.0${d}`, `${a}.${b2}.${c}.${d}.0`,
	];
	return { address, numeric };
}

function randomIn(cidr: string, gen: Gen): number[] {
	const range = parseCidr(cidr)!;
	return Array.from(range.bytes, (byte, i) => {
		const bits = Math.max(0, Math.min(8, range.prefix - i * 8));
		const mask = bits === 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
		return (byte & mask) | (gen.int(256) & ~mask & 0xff);
	});
}

suite('Volt network broker: addresses, hosts and rules (I.4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the special-range table is I.4\'s, with local-use NAT64 and both metadata families', () => {
		const table = new Set(SPECIAL_RANGES.map(range => range.cidr));
		for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32', '::/128', '::1/128', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8']) {
			assert.ok(table.has(cidr), `${cidr} is in the table`);
		}
		assert.deepStrictEqual([...METADATA_ADDRESSES].sort(), ['100.100.100.200', '169.254.169.254', 'fd00:ec2::254']);
		for (const [address, cls] of [['10.1.2.3', 'local'], ['172.31.255.255', 'local'], ['192.168.0.1', 'local'], ['fd12::1', 'local'], ['127.0.0.1', 'loopback'], ['::1', 'loopback'], ['93.184.216.34', 'public'], ['2606:4700::1111', 'public'], ['169.254.169.254', 'metadata'], ['fd00:ec2::254', 'metadata'], ['100.100.100.200', 'metadata'], ['100.64.0.1', 'special'], ['fe80::1', 'special']] as const) {
			assert.strictEqual(classifyAddress(address)?.class, cls, address);
		}
	});

	test('NET-PROP-1: every encoding of a special address is refused or judged non-public', () => {
		const v4 = SPECIAL_RANGES.filter(range => !range.cidr.includes(':'));
		const v6 = SPECIAL_RANGES.filter(range => range.cidr.includes(':'));
		forAll('NET-PROP-1', gen => {
			const range = gen.pick(gen.bool(0.7) ? v4 : v6);
			const bytes = randomIn(range.cidr, gen);
			if (range.cidr.includes(':')) {
				const words = Array.from({ length: 8 }, (_, i) => hex(bytes[i * 2], bytes[i * 2 + 1]));
				for (const text of [words.join(':'), words.map(word => word.padStart(4, '0')).join(':').toUpperCase(), canonicalAddress(words.join(':'))!, `[${words.join(':')}]`]) {
					const normalized = normalizeNetworkHost(text);
					assert.ok(typeof normalized === 'string' || classifyAddress(normalized.host)?.class !== 'public', `${text} (${range.cidr}) must not be public`);
				}
				return;
			}
			const { address, numeric } = ipv4Encodings(bytes, gen);
			for (const text of address) {
				const normalized = normalizeNetworkHost(text);
				assert.ok(typeof normalized === 'string' || (!!normalized.ip && classifyAddress(normalized.host)?.class !== 'public'), `${text} (${range.cidr}) must not be public`);
				if (typeof normalized === 'object') {
					assert.ok(!networkRulesCover(['*', '*.com'], normalized, 443), `${text}: no name rule covers an address`);
				}
			}
			for (const text of numeric) {
				assert.strictEqual(typeof normalizeNetworkHost(text), 'string', `${text} (a number a resolver reads as ${bytes.join('.')}) is refused, never resolved`);
			}
		});
	});

	test('NET-PROP-2: every encoding of a metadata address is metadata', () => {
		forAll('NET-PROP-2', gen => {
			const { address } = ipv4Encodings(gen.pick([[169, 254, 169, 254], [100, 100, 100, 200]]), gen);
			for (const text of address) {
				const normalized = host(text);
				const cls = classifyAddress(normalized.host)?.class;
				// The local-use NAT64 prefix has four readings; a non-public one there is refused as special or metadata.
				assert.ok(cls === 'metadata' || (text.startsWith('64:ff9b:1:') && cls === 'special'), `${text}: ${cls}`);
			}
		}, 200);
		for (const text of ['fd00:ec2::254', 'FD00:EC2:0:0:0:0:0:254', '[fd00:ec2::254]']) {
			assert.strictEqual(classifyAddress(host(text).host)?.class, 'metadata', text);
		}
	});

	test('public addresses stay public in every encoding', () => {
		forAll('public', gen => {
			const bytes = [gen.pick([8, 23, 93, 104, 140, 151, 185]), gen.int(256), gen.int(256), 1 + gen.int(254)];
			const { address } = ipv4Encodings(bytes, gen);
			// Not the local-use NAT64 forms: their other readings of the same bytes may be reserved, which refuses them (stricter).
			for (const text of address.filter(text => !text.startsWith('64:ff9b:1:') && (!text.startsWith('::') || text.startsWith('::ffff')))) {
				const normalized = host(text);
				assert.strictEqual(classifyAddress(normalized.host)?.class, 'public', text);
			}
		}, 200);
	});

	test('hosts: IDNA to lower-case ASCII, one trailing dot, controls and empty labels refused', () => {
		assert.deepStrictEqual(normalizeNetworkHost('API.Example.COM.'), { host: 'api.example.com' });
		// allow-any-unicode-next-line
		assert.deepStrictEqual(normalizeNetworkHost('ＡＰＰＬＥ.com'), { host: 'apple.com' }, 'full-width is the same name');
		// allow-any-unicode-next-line
		assert.deepStrictEqual(normalizeNetworkHost('аpple.com'), { host: 'xn--pple-43d.com' }, 'a Cyrillic first letter is another name');
		for (const bad of ['', '.', 'a..b', 'a.b..', 'evil.com\u0000.good.com', 'a b.com', 'a%2e.com', 'a/b', 'user@host', 'host#frag', '[::1', 'a'.repeat(64) + '.com']) {
			assert.strictEqual(typeof normalizeNetworkHost(bad), 'string', JSON.stringify(bad));
		}
	});

	test('rules: descendants only, no public suffix, ports explicit, * on the web ports only (B-32)', () => {
		const cover = (entries: string[], raw: string, port: number) => networkRulesCover(entries, host(raw), port);
		assert.ok(cover(['*.example.com'], 'a.example.com', 443));
		assert.ok(!cover(['*.example.com'], 'example.com', 443), 'descendants only');
		assert.ok(!cover(['*.example.com'], 'a.example.com', 80), 'no port is 443');
		assert.ok(cover(['http://example.com'], 'example.com', 80));
		assert.ok(cover(['example.com:8443'], 'example.com', 8443));
		assert.ok(!cover(['example.com:8443'], 'example.com', 443));
		for (const suffix of ['*.com', '*.co.uk', '*.github.io', '*.vercel.app']) {
			assert.ok(!cover([suffix], 'victim.' + suffix.slice(2), 443), `${suffix} matches nothing`);
		}
		assert.ok(isPublicSuffix('com') && isPublicSuffix('co.uk') && !isPublicSuffix('example.com'));
		assert.ok(cover(['*'], 'example.com', 443) && cover(['*'], 'example.com', 80));
		assert.ok(!cover(['*'], 'example.com', 6379), '* never widens a port');
		assert.ok(!cover(['*'], '93.184.216.34', 443), '* never covers an address');
		assert.ok(cover(['93.184.216.0/24'], '93.184.216.34', 443) && cover(['[2606:4700::/32]:8443'], '2606:4700::1111', 8443));
		assert.ok(!cover(['93.184.216.0/24'], 'example.com', 443), 'an address rule never covers a name');
		assert.strictEqual(parseNetworkRule('*.*.com'), undefined);
		assert.strictEqual(parseNetworkRule('example.com:99999'), undefined);
		assert.ok(cidrContains('10.0.0.0/8', '::ffff:10.1.2.3'), 'mapped forms are compared as IPv4');
	});

	test('exfil hosts: only a rule naming the host exactly opens one', () => {
		for (const name of ['pastebin.com', 'webhook.site', 'x.ngrok.io', 'abc.trycloudflare.com', 'bucket.s3.amazonaws.com', 'bucket.s3.us-east-1.amazonaws.com', 'gist.github.com', 'api.github.com', 'upload.pypi.org', 'transfer.sh']) {
			assert.ok(isExfilHost(name), name);
			assert.ok(!networkRulesCover(['*', `*.${name.split('.').slice(1).join('.')}`], host(name), 443), `${name}: no wildcard opens it`);
			assert.ok(networkRulesCover([name], host(name), 443), `${name}: its exact name does`);
		}
		assert.ok(!isExfilHost('github.com') && !isExfilHost('registry.npmjs.org') && !isExfilHost('api.anthropic.com'));
		assert.ok(EXFIL_HOSTS.length > 60);
	});
});

// --- the Authority's network decisions -------------------------------------------------------

const CHAT: SubjectKey = 'chat:net';
const principal: IPrincipal = { id: 'route-1', subject: CHAT, kind: 'agent', executionHost: 'local', launchPolicyHash: '', createdAt: 0 };

function snapshot(allowedDomains: string[], grants: IGrant[] = []): PolicySnapshot {
	return PolicySnapshot.build({ epoch: 3, asOf: 1000, grants, chats: [{ subject: CHAT, settings: { level: 'workspace-write', network: false, allowedDomains, listenPorts: [5173] } }] });
}

function grant(capability: string, targets: string[], extra: Partial<IGrant> = {}): IGrant {
	return { id: `g-${capability}-${targets.join(',')}`, subject: CHAT, capability, scope: { targets }, kind: 'session', sessionId: principal.id, source: 'user', grantedAt: 0, lastUsedAt: 0, epoch: 1, ...extra };
}

function decide(snap: PolicySnapshot, request: IAccessRequest) {
	const decision = evaluate(snap, request, { principal, onBehalfOf: [], requestId: 'r' });
	return decision.allow ? 'allow' : `${decision.deniedBy}/${decision.code}`;
}

suite('Volt network broker: the Authority\'s decisions (I.4, C2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('metadata and reserved addresses are floor denials that no grant opens', () => {
		const everything = snapshot(['*', '169.254.0.0/16', '0.0.0.0/0'], [grant('net.connect@1', ['*']), grant('net.local.connect@1', ['169.254.0.0/16:80', '0.0.0.0/0'])]);
		for (const [target, code] of [['169.254.169.254', 'metadata'], ['fd00:ec2::254', 'metadata'], ['100.100.100.200', 'metadata'], ['::ffff:169.254.169.254', 'metadata'], ['100.64.0.1', 'special-address'], ['224.0.0.1', 'special-address']] as const) {
			for (const capability of ['net.connect', 'net.local.connect', 'net.loopback.connect:80']) {
				assert.strictEqual(decide(everything, { capability, target, port: 80, surface: 'broker' }), `floor/${code}`, `${capability} ${target}`);
			}
		}
	});

	test('net.connect never reaches a local or loopback address; net.local.connect needs a grant naming it and its port', () => {
		const snap = snapshot(['*', '10.0.0.0/8'], [grant('net.local.connect@1', ['10.1.2.0/24:5432'])]);
		assert.strictEqual(decide(snap, { capability: 'net.connect', target: '10.1.2.3', port: 5432, surface: 'broker' }), 'floor/special-address');
		assert.strictEqual(decide(snap, { capability: 'net.connect', target: '127.0.0.1', port: 443, surface: 'broker' }), 'floor/special-address');
		assert.strictEqual(decide(snap, { capability: 'net.local.connect', target: '10.1.2.3', port: 5432, surface: 'broker' }), 'allow');
		assert.strictEqual(decide(snap, { capability: 'net.local.connect', target: '10.1.2.3', port: 6379, surface: 'broker' }), 'authority/chat-sandbox', 'another port');
		assert.strictEqual(decide(snap, { capability: 'net.local.connect', target: '10.9.9.9', port: 5432, surface: 'broker' }), 'authority/chat-sandbox', 'another address');
		assert.strictEqual(decide(snap, { capability: 'net.local.connect', target: '93.184.216.34', port: 5432, surface: 'broker' }), 'floor/special-address', 'not a LAN address');
	});

	test('broker requests: port-aware, exfil by exact name, live session grants of this principal only', () => {
		const snap = snapshot(['*.example.com', '*'], [grant('net.connect@1', ['pastebin.com']), grant('net.connect@1', ['other.test'], { sessionId: 'another-route' })]);
		assert.strictEqual(decide(snap, { capability: 'net.connect', target: 'a.example.com', port: 443, surface: 'broker' }), 'allow');
		assert.strictEqual(decide(snap, { capability: 'net.connect', target: 'a.example.com', port: 6379, surface: 'broker' }), 'authority/port');
		assert.strictEqual(decide(snap, { capability: 'net.connect', target: 'webhook.site', port: 443, surface: 'broker' }), 'authority/exfil');
		assert.strictEqual(decide(snap, { capability: 'net.connect', target: 'pastebin.com', port: 443, surface: 'broker' }), 'allow', 'granted by its exact name');
		assert.strictEqual(decide(snapshot([]), { capability: 'net.connect', target: 'other.test', port: 443, surface: 'broker' }), 'authority/chat-sandbox');
		assert.strictEqual(decide(snap, { capability: 'net.connect', target: 'other.test', port: 443, surface: 'broker' }), 'allow', '* covers it on 443 anyway');
		assert.strictEqual(decide(snapshot([], [grant('net.connect@1', ['other.test'], { sessionId: 'another-route' })]), { capability: 'net.connect', target: 'other.test', port: 443, surface: 'broker' }), 'authority/chat-sandbox', 'another route\'s session grant is not this one\'s');
	});
});
