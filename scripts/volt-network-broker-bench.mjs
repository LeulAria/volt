/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The network broker's performance budget (sandbox spec M.3 C3): throughput through a CONNECT
// tunnel >= 80% of a direct connection, and connect overhead <= 2 ms. Everything stays on this
// machine: a local sink stands in for the internet, and the broker's resolver answers with a
// public-looking address its connector sends to the sink (name resolution is the same for a direct
// client, so it is left out of both sides).
//
// Usage: npm run -s transpile-client-oxc && node scripts/volt-network-broker-bench.mjs [--json]
//   VOLT_BENCH_CONNECTS (default 400), VOLT_BENCH_MB (default 512)

import * as net from 'node:net';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { NetworkBroker } = await import(pathToFileURL(path.join(ROOT, 'out/vs/platform/voltSandbox/node/networkBroker.js')).href);

const CONNECTS = Number(process.env.VOLT_BENCH_CONNECTS) || 400;
const MEGABYTES = Number(process.env.VOLT_BENCH_MB) || 512;
const CHUNK = Buffer.alloc(64 * 1024, 7);

/** The link speed the paced runs model (a fast real link); loopback runs are unpaced. */
const LINK_MBPS = Number(process.env.VOLT_BENCH_LINK_MBPS) || 125;

/**
 * A sink: `D<bytes>\n` downloads that many bytes as fast as loopback goes, `P<bytes>\n` paced at
 * {@link LINK_MBPS}; anything else is held open until the client ends.
 */
const sink = net.createServer(socket => {
	socket.on('error', () => undefined);
	socket.once('data', data => {
		const match = /^([DP])(\d+)\n/.exec(data.toString('latin1'));
		if (!match) {
			return;
		}
		let left = Number(match[2]);
		const paced = match[1] === 'P';
		const started = performance.now();
		let sent = 0;
		const pump = () => {
			while (left > 0) {
				if (paced && sent > (performance.now() - started) / 1000 * LINK_MBPS * 1024 * 1024) {
					setTimeout(pump, 1);
					return;
				}
				const piece = left >= CHUNK.length ? CHUNK : CHUNK.subarray(0, left);
				left -= piece.length;
				sent += piece.length;
				if (!socket.write(piece)) {
					socket.once('drain', pump);
					return;
				}
			}
			socket.end();
		};
		pump();
	});
});
await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
const sinkPort = sink.address().port;

/** The floor for any user-space proxy: a bare relay that pipes both ways and decides nothing. */
const relay = net.createServer(client => {
	const upstream = net.connect({ host: '127.0.0.1', port: sinkPort });
	client.on('error', () => undefined);
	upstream.on('error', () => undefined);
	client.pipe(upstream);
	upstream.pipe(client);
});
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
const relayPort = relay.address().port;

const broker = new NetworkBroker({
	lookup: async () => [{ address: '93.184.216.34', family: 4 }],
	connect: () => net.connect({ host: '127.0.0.1', port: sinkPort }),
});
const route = await broker.openRoute({
	principal: { id: 'bench', subject: 'chat:bench', kind: 'agent', executionHost: 'local', launchPolicyHash: '', createdAt: 0 },
	allow: ['bench.example.com'],
});
const auth = `Basic ${Buffer.from(`volt:${route.token}`).toString('base64')}`;

/** A connected socket to the sink: directly, through the bare relay, or through a CONNECT tunnel (resolves once `200` arrived). */
function open(path) {
	const viaBroker = path === 'broker';
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: '127.0.0.1', port: viaBroker ? route.port : path === 'relay' ? relayPort : sinkPort });
		socket.setNoDelay(true);
		socket.once('error', reject);
		if (!viaBroker) {
			socket.once('connect', () => resolve(socket));
			return;
		}
		socket.once('connect', () => socket.write(`CONNECT bench.example.com:443 HTTP/1.1\r\nHost: bench.example.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`));
		let head = '';
		const onData = data => {
			head += data.toString('latin1');
			const end = head.indexOf('\r\n\r\n');
			if (end >= 0) {
				socket.off('data', onData);
				if (!head.startsWith('HTTP/1.1 200')) {
					reject(new Error(head.split('\r\n')[0]));
					return;
				}
				resolve(socket);
			}
		};
		socket.on('data', onData);
	});
}

async function connectTimes(path) {
	const times = [];
	for (let i = 0; i < CONNECTS; i++) {
		const started = performance.now();
		const socket = await open(path);
		times.push(performance.now() - started);
		socket.destroy();
	}
	times.sort((a, b) => a - b);
	return { median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)] };
}

async function throughput(path, mode, megabytes) {
	const bytes = megabytes * 1024 * 1024;
	const socket = await open(path);
	const started = performance.now();
	let received = 0;
	await new Promise((resolve, reject) => {
		socket.on('data', data => { received += data.length; });
		socket.once('end', resolve);
		socket.once('error', reject);
		socket.write(`${mode}${bytes}\n`);
	});
	const seconds = (performance.now() - started) / 1000;
	if (received !== bytes) {
		throw new Error(`received ${received} of ${bytes} bytes`);
	}
	return bytes / 1024 / 1024 / seconds;
}

/** Best of three per path, the paths interleaved so drift hits all alike. */
async function rates(paths, mode, megabytes) {
	const runs = Object.fromEntries(paths.map(path => [path, []]));
	for (let i = 0; i < 3; i++) {
		for (const path of paths) {
			runs[path].push(await throughput(path, mode, megabytes));
		}
	}
	return Object.fromEntries(paths.map(path => [path, Math.max(...runs[path])]));
}

await connectTimes('direct');
await connectTimes('broker');
const direct = await connectTimes('direct');
const brokered = await connectTimes('broker');
const loopback = await rates(['direct', 'relay', 'broker'], 'D', MEGABYTES);
// About 4 s of transfer per run at the modelled link speed.
const link = await rates(['direct', 'broker'], 'P', Math.max(64, Math.round(LINK_MBPS * 4)));
const result = {
	connect: { directMedianMs: direct.median, brokerMedianMs: brokered.median, overheadMedianMs: brokered.median - direct.median, directP95Ms: direct.p95, brokerP95Ms: brokered.p95, overheadP95Ms: brokered.p95 - direct.p95 },
	throughputLink: { linkMBps: LINK_MBPS, directMBps: link.direct, brokerMBps: link.broker, ratio: link.broker / link.direct },
	throughputLoopback: { directMBps: loopback.direct, bareRelayMBps: loopback.relay, brokerMBps: loopback.broker, ratio: loopback.broker / loopback.direct, ratioToBareRelay: loopback.broker / loopback.relay },
	budget: { overheadMs: 2, ratio: 0.8 },
};
result.pass = result.connect.overheadMedianMs <= 2 && result.throughputLink.ratio >= 0.8;

route.dispose();
broker.dispose();
relay.close();
sink.close();

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(result, null, '\t'));
} else {
	const ms = value => `${value.toFixed(3)} ms`;
	const mbps = value => `${value.toFixed(0)} MB/s`;
	const pct = value => `${(value * 100).toFixed(1)}%`;
	console.log(`connect            direct ${ms(direct.median)} (p95 ${ms(direct.p95)})  broker ${ms(brokered.median)} (p95 ${ms(brokered.p95)})  overhead ${ms(result.connect.overheadMedianMs)} (budget 2 ms)`);
	console.log(`throughput, link   ${LINK_MBPS} MB/s link: direct ${mbps(link.direct)}  broker ${mbps(link.broker)}  ratio ${pct(result.throughputLink.ratio)} (budget 80%)`);
	console.log(`throughput, loopback (no link): direct ${mbps(loopback.direct)}  bare relay ${mbps(loopback.relay)}  broker ${mbps(loopback.broker)}  ratio ${pct(result.throughputLoopback.ratio)}, ${pct(result.throughputLoopback.ratioToBareRelay)} of a bare relay`);
	console.log(result.pass ? 'PASS' : 'FAIL');
}
process.exitCode = result.pass ? 0 : 1;
