/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';

/**
 * A stand-in for `claude-agent-acp`'s `dist`: `serve.js`'s router opens one "agent" per connection that
 * answers one JSON line per request, doing in the host what the real adapter does there (reads its
 * environment, starts its CLI, reads files).
 */
const FAKE_SERVE = `
import { spawn, execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export function acpProtocolsFromEnv() { return 'auto'; }
export function acpProtocolRouter(logger, onAgent) {
	return {
		connect(stream) {
			let closed;
			const done = new Promise(resolve => closed = resolve);
			let child;
			onAgent({ dispose: async () => { child?.kill('SIGTERM'); } });
			const writer = stream.writable.getWriter();
			const reply = value => writer.write(new TextEncoder().encode(JSON.stringify(value) + '\\n'));
			const handle = async request => {
				if (request.do === 'cwd') { return { cwd: process.cwd() }; }
				if (request.do === 'throw') { setTimeout(() => { throw new Error('scripted'); }, 0); return { thrown: true }; }
				if (request.do === 'env') { return { value: process.env[request.name], keys: Object.keys({ ...process.env }).includes(request.name) }; }
				if (request.do === 'read') { return readFile(request.path, 'utf8').then(text => ({ text }), error => ({ error: error.code })); }
				if (request.do === 'readSync') { try { return { text: fs.readFileSync(request.path, 'utf8') }; } catch (error) { return { error: error.code }; } }
				if (request.do === 'write') { try { fs.writeFileSync(request.path, 'x'); return { ok: true }; } catch (error) { return { error: error.code }; } }
				if (request.do === 'spawnSync') { try { spawnSync('true'); return { ok: true }; } catch (error) { return { error: error.code }; } }
				if (request.do === 'execFile') { return execFileAsync(request.command, request.args, { env: { ...process.env, EXTRA: 'e' } }).then(out => ({ stdout: out.stdout }), error => ({ error: String(error.message) })); }
				if (request.do === 'start') {
					child = spawn(request.command, request.args, { env: { ...process.env, ADDED: 'by-adapter' }, stdio: ['pipe', 'pipe', 'pipe'] });
					// As the Agent SDK does: its first request is written before the process is up.
					if (request.first) { child.stdin.write(request.first); }
					child.stdout.setEncoding('utf8').on('data', data => reply({ event: 'out', data }));
					child.on('exit', (code, signal) => reply({ event: 'exit', code, signal }));
					child.on('error', error => reply({ event: 'error', message: error.message }));
					return { started: true };
				}
				if (request.do === 'say') { child.stdin.write(request.text); return { said: true }; }
				return { error: 'unknown' };
			};
			(async () => {
				let pending = '';
				const reader = stream.readable.getReader();
				for (;;) {
					const { value, done: end } = await reader.read();
					if (end) { break; }
					const lines = (pending + new TextDecoder().decode(value)).split('\\n');
					pending = lines.pop();
					for (const line of lines) {
						if (!line) { continue; }
						const request = JSON.parse(line);
						reply({ id: request.id, ...(await handle(request)) });
					}
				}
				closed();
			})();
			return { closed: done };
		},
	};
}
`;
const FAKE_UTILS = `
import { Readable, Writable } from 'node:stream';
export const nodeToWebWritable = stream => Writable.toWeb(stream);
export const nodeToWebReadable = stream => Readable.toWeb(stream);
`;
const FAKE_SDK = `export const ndJsonStream = (writable, readable) => ({ writable, readable });\n`;

/** Writes the stand-in adapter (and the ACP SDK entry it resolves) below `dir`; resolves with its entry file. */
export async function writeFakeAcpAdapter(dir: string): Promise<string> {
	const dist = join(dir, 'node_modules', 'adapter', 'dist');
	const sdk = join(dir, 'node_modules', '@agentclientprotocol', 'sdk');
	await fs.mkdir(dist, { recursive: true });
	await fs.mkdir(sdk, { recursive: true });
	await fs.writeFile(join(dir, 'node_modules', 'adapter', 'package.json'), '{"type":"module"}');
	await fs.writeFile(join(dist, 'serve.js'), FAKE_SERVE);
	await fs.writeFile(join(dist, 'utils.js'), FAKE_UTILS);
	await fs.writeFile(join(dist, 'index.js'), '');
	await fs.writeFile(join(sdk, 'package.json'), '{"name":"@agentclientprotocol/sdk","type":"module","exports":{"./experimental/v2":{"default":"./v2.js"}}}');
	await fs.writeFile(join(sdk, 'v2.js'), FAKE_SDK);
	return join(dist, 'index.js');
}
