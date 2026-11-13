/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { encodeMessage, RpcMessage, VoltPluginError } from '../../../common/pluginProtocol.js';
import { runPluginHost } from '../../../node/pluginHostRuntime.js';

/**
 * A T2 host with a deliberate SES escape (test only): the real host runtime, plus an endowment
 * `leak` that hands the Compartment what an escape would reach: Node's `fs`, `net`,
 * `child_process`, the process's environment and its own channel (requests past the SDK, raw
 * frames). The plugin in `pluginHost.test.ts` uses it, and
 * every use must hit the OS sandbox's denial (spec P1 gate: "a simulated SES escape hits OS
 * denials"). The supervisor starts it exactly like `pluginHostMain.js`, under the same policy.
 */

function attempt(fn: () => unknown): string {
	try {
		const value = fn();
		return `ok:${typeof value === 'string' ? value.slice(0, 80) : JSON.stringify(value)?.slice(0, 80)}`;
	} catch (err) {
		return `err:${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
	}
}

const fd = Number(process.env.VOLT_HOST_CHANNEL_FD);
delete process.env.VOLT_HOST_CHANNEL_FD;
void runPluginHost({
	fd,
	testEndowments: channel => ({
		leak: {
			// The channel itself, past the SDK (identity forging, IPC-1/3/5): requests with any params, and raw frames.
			rpc: (method: string, params: unknown) => channel.request(method, params).then(
				value => `ok:${JSON.stringify(value)?.slice(0, 200)}`,
				err => `err:${err instanceof VoltPluginError ? err.type : (err as Error).message}`,
			),
			frame: (message: unknown) => {
				for (const bytes of encodeMessage(message as RpcMessage, () => 1)) {
					channel.write(bytes);
				}
			},
			read: (path: string) => attempt(() => fs.readFileSync(path, 'utf8')),
			write: (path: string, text: string) => attempt(() => fs.writeFileSync(path, text)),
			list: (path: string) => attempt(() => fs.readdirSync(path).length),
			spawn: (command: string) => attempt(() => {
				const result = spawnSync(command, [], { encoding: 'utf8', timeout: 5000 });
				if (result.error) {
					throw result.error;
				}
				return `status ${result.status} ${result.stdout}`;
			}),
			connect: (host: string, port: number) => new Promise<string>(resolve => {
				const socket = net.connect({ host, port });
				const done = (value: string) => { socket.destroy(); resolve(value); };
				socket.once('connect', () => done('ok:connected'));
				socket.once('error', (err: NodeJS.ErrnoException) => done(`err:${err.code ?? err.message}`));
				setTimeout(() => done('err:timeout'), 5000);
			}),
			env: () => Object.keys(process.env).sort().join(','),
		},
	}),
}).catch(err => {
	process.stderr.write(`escape host: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
