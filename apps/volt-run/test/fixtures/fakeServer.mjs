/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stands in for out/volt-agent-server-main.js in tests: the same files (token, runtime.json), the
// same routes volt-run uses, and a clean stop on SIGTERM. FAKE_SERVER_OLD=1 acts like Volt 0.0.5
// (no sign-in page, no pairing codes); FAKE_SERVER_CRASH=1 exits while starting. SIGUSR2 stops it
// the way a checkout's server stops to load its recompiled code.

import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const value = name => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const userDataDir = value('--user-data-dir');
const host = value('--host') ?? '127.0.0.1';
const old = process.env.FAKE_SERVER_OLD === '1';
if (process.env.FAKE_SERVER_CRASH === '1') {
	console.error('fake server: crashing on purpose');
	process.exit(3);
}
const dir = path.join(userDataDir, 'agentServer');
fs.mkdirSync(dir, { recursive: true });
const tokenFile = path.join(dir, 'token');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : randomBytes(32).toString('hex');
fs.writeFileSync(tokenFile, token);
const preferred = 47_100 + (createHash('sha256').update(userDataDir).digest().readUInt16BE(0) % 800);
const appRoot = path.resolve(import.meta.dirname, '..');

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	if (url.pathname === '/health') {
		const ok = req.headers.authorization === `Bearer ${token}`;
		res.writeHead(ok ? 200 : 401).end(JSON.stringify({ ok }));
	} else if (url.pathname === '/.well-known/volt/environment') {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ environmentId: 'env-test', label: 'Test', capabilities: { pairing: true, workbench: true }, network: host !== '127.0.0.1' }));
	} else if (url.pathname === '/' && !old) {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><script>const BOOT = {"session":"/api/workbench/session"}</script>');
	} else if (url.pathname === '/api/auth/code' && !old && req.method === 'POST' && req.headers.authorization === `Bearer ${token}`) {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'ABCDEFGH', expiresAt: Date.now() + 600_000, network: host !== '127.0.0.1', urls: [...(host !== '127.0.0.1' ? [{ kind: 'lan', url: `http://192.168.1.2:${server.address().port}/pair#code=ABCDEFGH` }] : []), { kind: 'loopback', url: `http://127.0.0.1:${server.address().port}/pair#code=ABCDEFGH` }] }));
	} else {
		res.writeHead(404).end('Not found');
	}
});

const listen = port => server.listen(port, host, () => {
	const info = { version: 1, pid: process.pid, host, port: server.address().port, epoch: 'test', serverVersion: '1', startedAt: Date.now(), appRoot, env: { compileCache: process.env.NODE_COMPILE_CACHE ?? null, idleExit: process.env.VOLT_AGENT_SERVER_IDLE_EXIT ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null } };
	fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(info));
});
server.once('error', err => err.code === 'EADDRINUSE' && !value('--port') ? listen(0) : process.exit(4));
listen(value('--port') ? Number(value('--port')) : preferred);

const stop = (code = 0) => {
	fs.rmSync(path.join(dir, 'runtime.json'), { force: true });
	fs.writeFileSync(path.join(dir, 'stopped'), String(process.pid));
	process.exit(code);
};
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('SIGUSR2', () => stop(75));
