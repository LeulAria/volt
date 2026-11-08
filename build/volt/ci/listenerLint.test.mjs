/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkFindings, findListeners, scan } from './listenerLint.mjs';

test('finds http, net and tls servers, WebSocketServer and server.listen', () => {
	const text = [
		'import * as http from \'http\';',
		'const a = http.createServer((req, res) => res.end());',
		'const b = net.createServer();',
		'const c = https.createServer({ key, cert });',
		'const wss = new WebSocketServer({ port: 8080 });',
		'a.listen(0);',
		'server.listen(port, host);',
		'this._server.listen(0, \'127.0.0.1\');',
		'proxy.listen(0);',
	].join('\n');
	const kinds = findListeners('src/vs/platform/x/node/x.ts', text).map(finding => `${finding.line}:${finding.kind}`);
	assert.deepEqual(kinds, ['2:createServer', '3:createServer', '4:createServer', '5:WebSocketServer', '7:listen', '8:listen', '9:listen']);
});

test('a bare createServer counts only when imported from http, net, https, tls or http2', () => {
	assert.equal(findListeners('a.ts', 'import { createServer } from \'net\';\nconst s = createServer();').length, 1);
	assert.equal(findListeners('a.ts', 'const { createServer } = await import(\'http\');\nconst s = createServer(handler);').length, 1);
	assert.equal(findListeners('a.ts', 'import { createServer } from \'./remoteServer.js\';\nconst s = createServer(null, args);').length, 0);
	assert.equal(findListeners('a.ts', 'import { createServer } from \'http\';\nexport function createServer(x) {}').length, 0);
});

test('IPC and event listen calls, comments and the library itself are not listeners', () => {
	assert.equal(findListeners('a.ts', 'channel.listen(\'onDidChange\');\nreturn this.channel.listen(event, arg);').length, 0);
	assert.equal(findListeners('a.ts', '// http.createServer is not used here\n * server.listen(0) in a doc comment').length, 0);
	assert.equal(findListeners('src/vs/platform/voltListeners/node/listenerAuth.ts', 'http.createServer(handler);\nserver.listen(0);').length, 0);
});

test('an allowlist entry covers its file and line text only; unused entries are stale', () => {
	const findings = [
		{ file: 'a.ts', line: 3, kind: 'createServer', text: 'const s = http.createServer(h);' },
		{ file: 'b.ts', line: 9, kind: 'createServer', text: 'const s = http.createServer(h);' },
	];
	const allowlist = [
		{ file: 'a.ts', text: 'const s = http.createServer(h);', reason: 'reviewed: a port probe' },
		{ file: 'c.ts', text: 'gone();', reason: 'reviewed: removed since' },
	];
	const { unallowed, stale } = checkFindings(findings, allowlist);
	assert.deepEqual(unallowed.map(finding => finding.file), ['b.ts']);
	assert.deepEqual(stale.map(entry => entry.file), ['c.ts']);
});

test('the repository has no listener outside the library beyond its reviewed allowlist', () => {
	const root = path.resolve(import.meta.dirname, '..', '..', '..');
	const allowlist = JSON.parse(fs.readFileSync(path.join(root, 'build/volt/ci/listener-allowlist.json'), 'utf8')).sites;
	for (const entry of allowlist) {
		assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 10, `${entry.file} needs a reason`);
	}
	const { unallowed } = checkFindings(scan(root), allowlist);
	assert.deepEqual(unallowed, []);
});
