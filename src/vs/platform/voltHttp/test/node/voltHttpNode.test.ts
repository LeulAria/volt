/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
// A real HTTP/2 server to send to.
// eslint-disable-next-line local/code-import-patterns
import * as http2 from 'http2';
import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import type * as tls from 'tls';
import { gzipSync } from 'zlib';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltHttpNodeOptions, VOLT_HTTP_VERSION_HEADER } from '../../common/voltHttpTransport.js';
import { voltHttpNodeRequest, voltHttpTlsOptions } from '../../node/voltHttpNode.js';

/** A self-signed certificate for localhost, made with the system's openssl; undefined when there is none. */
async function selfSigned(): Promise<{ key: string; cert: string } | undefined> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'volt-http-tls-'));
	try {
		await new Promise<void>((resolve, reject) => execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], error => error ? reject(error) : resolve()));
		return { key: await fs.readFile(join(dir, 'key.pem'), 'utf8'), cert: await fs.readFile(join(dir, 'cert.pem'), 'utf8') };
	} catch {
		return undefined;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

suite('Volt HTTP client: requests sent through Node (TLS and protocol settings)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const closers: (() => Promise<void>)[] = [];
	teardown(async () => {
		await Promise.all(closers.splice(0).map(close => close()));
	});

	async function listen(server: net.Server): Promise<number> {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		closers.push(() => new Promise<void>(resolve => {
			(server as http.Server).closeAllConnections?.();
			server.close(() => resolve());
		}));
		return (server.address() as AddressInfo).port;
	}

	async function send(url: string, node: IVoltHttpNodeOptions, extra: { method?: string; data?: string; timeout?: number } = {}) {
		const context = await voltHttpNodeRequest({ type: extra.method ?? 'GET', url, headers: { 'x-test': '1' }, ...(extra.data !== undefined ? { data: extra.data } : {}), ...(extra.timeout ? { timeout: extra.timeout } : {}), node }, CancellationToken.None);
		return { status: context.res.statusCode, headers: context.res.headers, body: (await streamToBuffer(context.stream)).toString() };
	}

	test('TLS options: disabled versions narrow the range, ciphers and their order', () => {
		assert.deepStrictEqual(voltHttpTlsOptions({}), { rejectUnauthorized: true });
		const no13 = voltHttpTlsOptions({ rejectUnauthorized: false, disabledProtocols: ['TLSv1_3'], ciphers: ['ECDHE-RSA-AES128-GCM-SHA256', ' AES128-SHA '], honorCipherOrder: true });
		assert.deepStrictEqual([no13.rejectUnauthorized, no13.minVersion, no13.maxVersion, no13.ciphers, no13.honorCipherOrder], [false, 'TLSv1.2', 'TLSv1.2', 'ECDHE-RSA-AES128-GCM-SHA256:AES128-SHA', true]);
		const legacy = voltHttpTlsOptions({ disabledProtocols: ['TLSv1_2', 'TLSv1_3'] });
		assert.deepStrictEqual([legacy.minVersion, legacy.maxVersion], ['TLSv1', 'TLSv1.1']);
		assert.throws(() => voltHttpTlsOptions({ disabledProtocols: ['TLSv1', 'TLSv1_1', 'TLSv1_2', 'TLSv1_3'] }), /Every TLS version is disabled/);
	});

	test('a self-signed server: refused while certificates are verified, answered when not; HTTP/2 by ALPN, HTTP/1.1 when pinned; TLS versions disabled', async function () {
		const credentials = await selfSigned();
		if (!credentials) {
			this.skip();
		}
		const protocols: string[] = [];
		const server = http2.createSecureServer({ ...credentials, allowHTTP1: true }, (req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ version: req.httpVersion, method: req.method, header: req.headers['x-test'] }));
		});
		server.on('secureConnection', (socket: tls.TLSSocket) => protocols.push(socket.getProtocol() ?? ''));
		const port = await listen(server);
		const url = `https://localhost:${port}/path?q=1`;

		await assert.rejects(send(url, {}), /self[- ]signed/i);

		const auto = await send(url, { rejectUnauthorized: false });
		assert.strictEqual(auto.status, 200);
		assert.deepStrictEqual(JSON.parse(auto.body), { version: '2.0', method: 'GET', header: '1' });
		assert.strictEqual(auto.headers[VOLT_HTTP_VERSION_HEADER], '2');

		const one = await send(url, { rejectUnauthorized: false, httpVersion: 'http1' }, { method: 'POST', data: 'x' });
		assert.deepStrictEqual(JSON.parse(one.body), { version: '1.1', method: 'POST', header: '1' });
		assert.strictEqual(one.headers[VOLT_HTTP_VERSION_HEADER], '1.1');

		const two = await send(url, { rejectUnauthorized: false, httpVersion: 'http2' }, { method: 'POST', data: 'y' });
		assert.strictEqual(JSON.parse(two.body).version, '2.0');

		protocols.length = 0;
		await send(url, { rejectUnauthorized: false, disabledProtocols: ['TLSv1_3'] });
		assert.deepStrictEqual(protocols, ['TLSv1.2']);
	});

	test('HTTP/2 asked of a server that offers only HTTP/1.1 is an error', async function () {
		const credentials = await selfSigned();
		if (!credentials) {
			this.skip();
		}
		const https = await import('https');
		const port = await listen(https.createServer(credentials!, (_req, res) => res.end('one')));
		await assert.rejects(send(`https://127.0.0.1:${port}/`, { rejectUnauthorized: false, httpVersion: 'http2' }), /does not offer HTTP\/2/);
		assert.strictEqual((await send(`https://127.0.0.1:${port}/`, { rejectUnauthorized: false })).body, 'one', 'auto falls back to HTTP/1.1');
	});

	test('the lenient parser takes a header the strict one refuses; bodies are decoded; the timeout holds', async () => {
		const port = await listen(net.createServer(socket => {
			socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nX-Bad: a\x01b\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
		}));
		const lenient = await send(`http://127.0.0.1:${port}/`, { insecureHTTPParser: true });
		assert.strictEqual(lenient.body, 'ok');
		await assert.rejects(send(`http://127.0.0.1:${port}/`, {}));

		const gzipPort = await listen(http.createServer((_req, res) => {
			res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
			res.end(gzipSync('unzipped'));
		}));
		const zipped = await send(`http://127.0.0.1:${gzipPort}/`, {});
		assert.strictEqual(zipped.body, 'unzipped');
		assert.strictEqual(zipped.headers['content-encoding'], undefined);
		assert.strictEqual(zipped.headers[VOLT_HTTP_VERSION_HEADER], '1.1');

		const silentPort = await listen(http.createServer(() => { /* never answers */ }));
		await assert.rejects(send(`http://127.0.0.1:${silentPort}/`, {}, { timeout: 50 }), /Request timeout after 50ms/);
	});
});
