#!/usr/bin/env node
// A TCP proxy that behaves like a slow mobile link, for everything the page sends (HTTP and
// WebSockets alike, which DevTools throttling does not cover): each direction gets `--delay` ms
// one way and `--kbps` of bandwidth (bytes leave in order, paced). `--down` makes it refuse and
// cut every connection until `--up` (a control port toggles it: GET /down, /up, /stats; /fast and
// /slow switch the pacing off and on).
//
//   node slowlink.mjs --listen 9959 --target 127.0.0.1:9958 [--delay 200] [--kbps 400] [--control 9960] [--rewrite]
//
// Defaults are Chrome DevTools' "Slow 3G" preset as ADEMark and T3 use it: 400 ms round trip,
// 400 kbit/s each way.
import net from 'node:net';
import http from 'node:http';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const listen = Number(opt('listen', '9959'));
const [host, port] = opt('target', '127.0.0.1:9958').split(':');
const delay = Number(opt('delay', '200'));
const bytesPerMs = Number(opt('kbps', '400')) * 1000 / 8 / 1000;
const control = Number(opt('control', '9960'));
// `--rewrite`: swap "127.0.0.1:<listen>" and "127.0.0.1:<target port>" in the bytes each way (same
// length), so a server that checks Host and Origin sees its own address (a phone reaching it
// through a tunnel looks the same to it), and absolute URLs it sends point back at the link.
const rewrite = args.includes('--rewrite') && String(listen).length === port.length;
const swap = { up: [Buffer.from(`127.0.0.1:${listen}`), Buffer.from(`127.0.0.1:${port}`)], down: [Buffer.from(`127.0.0.1:${port}`), Buffer.from(`127.0.0.1:${listen}`)] };
function rewritten(chunk, counter) {
	const [from, to] = swap[counter];
	for (let i = chunk.indexOf(from); i !== -1; i = chunk.indexOf(from, i + from.length)) {
		to.copy(chunk, i);
	}
	return chunk;
}

let down = false;
/** `/fast`: pass bytes straight through (pairing and warm-up), `/slow` paces them again. */
let fast = false;
const sockets = new Set();
const stats = { connections: 0, up: 0, down: 0 };

/** When each direction of the link is next free: one link, shared by every connection over it. */
const linkFree = { up: 0, down: 0 };

/** Paces chunks from `from` into `to`: each leaves `delay` ms after it arrived, and no faster than the link. */
function pipe(from, to, counter) {
	let free = 0;
	from.on('data', chunk => {
		if (rewrite) {
			chunk = rewritten(chunk, counter);
		}
		const now = Date.now();
		stats[counter] += chunk.length;
		if (fast) {
			free = Math.max(free, now);
			to.write(chunk);
			return;
		}
		const start = Math.max(now + delay, linkFree[counter]);
		free = linkFree[counter] = start + chunk.length / bytesPerMs;
		setTimeout(() => { if (!to.destroyed) { to.write(chunk); } }, free - now);
	});
	from.on('end', () => setTimeout(() => to.end(), Math.max(0, free - Date.now()) + (fast ? 0 : delay)));
	from.on('error', () => to.destroy());
}

net.createServer(client => {
	if (down) {
		client.destroy();
		return;
	}
	stats.connections++;
	const server = net.connect(Number(port), host);
	sockets.add(client);
	sockets.add(server);
	const close = () => { sockets.delete(client); sockets.delete(server); client.destroy(); server.destroy(); };
	client.on('close', close);
	// The server closes its side as soon as it has handed over the last byte (or after its keep-alive
	// timeout), long before the paced bytes reach the client: the client side ends once they have
	// ('end' in pipe), so a large response is never cut off.
	server.on('close', () => sockets.delete(server));
	server.on('error', close);
	pipe(client, server, 'up');
	pipe(server, client, 'down');
}).listen(listen, '127.0.0.1', () => console.log(`slow link 127.0.0.1:${listen} -> ${host}:${port}, ${delay * 2} ms RTT, ${bytesPerMs * 8} kbit/s`));

http.createServer((req, res) => {
	if (req.url === '/down') {
		down = true;
		for (const s of sockets) {
			s.destroy();
		}
		sockets.clear();
	} else if (req.url === '/up') {
		down = false;
	} else if (req.url === '/fast' || req.url === '/slow') {
		fast = req.url === '/fast';
	} else if (req.url === '/reset') {
		stats.connections = stats.up = stats.down = 0;
	}
	res.end(JSON.stringify({ down, fast, ...stats }));
}).listen(control, '127.0.0.1');
