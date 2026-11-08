/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, X509Certificate, type KeyObject } from 'crypto';
import { promises as fs } from 'fs';
import * as http from 'http';
import { isIP } from 'net';
import * as tls from 'tls';
import { join } from '../../../base/common/path.js';

/**
 * A listener's own TLS identity for the local network: a P-256 key and a self-signed certificate
 * made once per server and kept beside it (key 0600). No certificate authority vouches for it;
 * clients pin the certificate's SHA-256, which reaches them through the pairing QR or link
 * (`#...&fp=<base64url>`), never over the connection it protects.
 */
export interface IListenerIdentity {
	readonly key: string;
	readonly cert: string;
	/** SHA-256 of the certificate's DER, base64url (43 characters): what pairing links carry. */
	readonly fingerprint: string;
	/** The same as `AB:CD:...`, what a browser's certificate viewer shows. */
	readonly fingerprintHex: string;
}

const KEY_FILE = 'tls-key.pem';
const CERT_FILE = 'tls-cert.pem';
const VALID_DAYS = 5 * 365;
/** A certificate this close to expiry is replaced (devices re-pair to learn the new pin). */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/** The identity kept in `dir`, made on first use or when the kept one is unusable or expiring. */
export async function loadOrCreateListenerIdentity(dir: string, commonName = 'Volt'): Promise<IListenerIdentity> {
	const keyFile = join(dir, KEY_FILE);
	const certFile = join(dir, CERT_FILE);
	try {
		const [key, cert] = await Promise.all([fs.readFile(keyFile, 'utf8'), fs.readFile(certFile, 'utf8')]);
		const x509 = new X509Certificate(cert);
		if (x509.checkPrivateKey(createPrivateKey(key)) && Date.parse(x509.validTo) - Date.now() > RENEW_BEFORE_MS) {
			if (process.platform !== 'win32') {
				await fs.chmod(keyFile, 0o600);
			}
			return identityOf(key, cert);
		}
	} catch {
		// none yet, or unreadable: make a new one
	}
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const cert = createSelfSignedCertificate(commonName, privateKey, publicKey);
	const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await writeAtomic(keyFile, key, 0o600);
	await writeAtomic(certFile, cert, 0o644);
	return identityOf(key, cert);
}

function identityOf(key: string, cert: string): IListenerIdentity {
	const der = new X509Certificate(cert).raw;
	return { key, cert, fingerprint: certificateFingerprint(der), fingerprintHex: fingerprintHex(der) };
}

async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	await fs.writeFile(tmp, data, { mode });
	await fs.rename(tmp, file);
}

/** SHA-256 of a certificate's DER, base64url. */
export function certificateFingerprint(der: Uint8Array): string {
	return createHash('sha256').update(der).digest('base64url');
}

function fingerprintHex(der: Uint8Array): string {
	return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
}

/** Whether `der` hashes to the pinned fingerprint (constant time). */
export function fingerprintMatches(der: Uint8Array | undefined, pinned: string): boolean {
	if (!der || !/^[A-Za-z0-9_-]{43}$/.test(pinned)) {
		return false;
	}
	const actual = createHash('sha256').update(der).digest();
	const expected = Buffer.from(pinned, 'base64url');
	return expected.length === actual.length && timingSafeEqual(actual, expected);
}

//#region A minimal X.509 writer (DER)

function derLength(length: number): Buffer {
	if (length < 0x80) {
		return Buffer.from([length]);
	}
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest >>= 8) {
		bytes.unshift(rest & 0xff);
	}
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
	return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));

function integer(value: Buffer): Buffer {
	let bytes = value;
	while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) {
		bytes = bytes.subarray(1);
	}
	return tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
	const [first, second, ...rest] = dotted.split('.').map(Number);
	const bytes = [first * 40 + second];
	for (const arc of rest) {
		const chunk = [arc & 0x7f];
		for (let value = arc >> 7; value > 0; value >>= 7) {
			chunk.unshift(0x80 | (value & 0x7f));
		}
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
	const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
	// UTCTime through 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
	return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii')) : tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

function name(commonName: string): Buffer {
	return sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const SUBJECT_ALT_NAME = '2.5.29.17';
const BASIC_CONSTRAINTS = '2.5.29.19';

/** A v3 certificate for `commonName`, signed by its own key (ECDSA P-256 with SHA-256), as PEM. */
export function createSelfSignedCertificate(commonName: string, privateKey: KeyObject, publicKey: KeyObject, validDays = VALID_DAYS, now = new Date()): string {
	const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
	const notAfter = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);
	const algorithm = sequence(oid(ECDSA_WITH_SHA256));
	// Clients pin the certificate, so the names only keep strict parsers happy.
	const altNames = sequence(tlv(0x82, Buffer.from('localhost', 'ascii')), tlv(0x87, Buffer.from([127, 0, 0, 1])));
	const extensions = tlv(0xa3, sequence(
		sequence(oid(BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence())),
		sequence(oid(SUBJECT_ALT_NAME), tlv(0x04, altNames)),
	));
	const serial = randomBytes(16);
	serial[0] &= 0x7f;
	const tbs = sequence(
		tlv(0xa0, integer(Buffer.from([2]))),
		integer(serial),
		algorithm,
		name(commonName),
		sequence(time(notBefore), time(notAfter)),
		name(commonName),
		publicKey.export({ type: 'spki', format: 'der' }),
		extensions,
	);
	const signature = sign('sha256', tbs, privateKey);
	const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
	const base64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
	return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

//#endregion

//#region Pinned clients (Node)

export class PinMismatchError extends Error {
	readonly code = 'PinMismatch';
	constructor(host: string) {
		super(`The certificate of ${host} is not the one Volt paired with. Pair again from the computer's Devices page.`);
	}
}

/**
 * A TLS connection to `host:port` that is handed over only once the server's certificate hashes
 * to `fingerprint`; nothing is written to it before that.
 */
export function connectPinned(host: string, port: number, fingerprint: string, timeoutMs = 10_000): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({
			host,
			port,
			...(isIP(host) ? {} : { servername: host }),
			// The CA chain is not what is trusted here: the pin is, checked below before any byte is sent.
			rejectUnauthorized: false,
			ALPNProtocols: ['http/1.1'],
			minVersion: 'TLSv1.2',
		});
		const timer = setTimeout(() => socket.destroy(new Error(`No answer from ${host}:${port}.`)), timeoutMs);
		socket.once('secureConnect', () => {
			clearTimeout(timer);
			if (!fingerprintMatches(socket.getPeerX509Certificate()?.raw, fingerprint)) {
				const err = new PinMismatchError(`${host}:${port}`);
				socket.destroy(err);
				reject(err);
				return;
			}
			resolve(socket);
		});
		socket.once('error', err => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

export interface IPinnedResponse {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
}

/** One HTTPS request over a pinned connection ({@link connectPinned}). */
export async function pinnedRequest(url: string, fingerprint: string, init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string; readonly timeoutMs?: number } = {}): Promise<IPinnedResponse> {
	const target = new URL(url);
	if (target.protocol !== 'https:') {
		throw new Error(`A pinned request needs an https URL, not ${target.protocol}`);
	}
	const host = target.hostname.replace(/^\[|\]$/g, '');
	const port = Number(target.port || 443);
	const socket = await connectPinned(host, port, fingerprint, init.timeoutMs);
	return new Promise((resolve, reject) => {
		const req = http.request({
			createConnection: () => socket,
			// The Host header is the URL's own `host:port` (Node would add its default port 80 to it).
			setHost: false,
			path: `${target.pathname}${target.search}`,
			method: init.method ?? 'GET',
			headers: { Host: target.host, ...init.headers, ...(init.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}) },
			timeout: init.timeoutMs ?? 10_000,
		}, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', chunk => body += chunk);
			res.on('end', () => {
				socket.end();
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
			});
			res.on('error', reject);
		});
		req.on('timeout', () => req.destroy(new Error(`No answer from ${target.host}.`)));
		req.on('error', err => {
			socket.destroy();
			reject(err);
		});
		req.end(init.body);
	});
}

//#endregion
