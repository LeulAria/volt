/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import http from 'node:http';
import { Relay, WEBHOOK_BODY_LIMIT } from './relay.mjs';
import { clampInt, HttpError, publicBase, readBody, readJson, sendJson } from './util.mjs';

/**
 * The relay's HTTP surface. Everything Volt and runners do is a plain HTTPS request they make
 * outward (so both work behind NAT); live updates come as Server-Sent Events, with a long-poll
 * twin for proxies that buffer streams. See PROTOCOL.md.
 */
export async function startRelayServer(options) {
	const relay = new Relay(options);
	await relay.init();
	const streams = new Set();

	const server = http.createServer((req, res) => {
		handle(req, res).catch(err => {
			const status = err instanceof HttpError ? err.status : 500;
			if (status === 500) {
				console.error('[relay]', req.method, req.url, err);
			}
			if (!res.headersSent) {
				sendJson(res, status, { error: err.message || 'Internal error' }, err.extra);
			} else {
				res.destroy();
			}
		});
	});

	async function handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://relay');
		const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
		const query = Object.fromEntries(url.searchParams);
		const base = publicBase(req, options.publicUrl);
		const method = req.method ?? 'GET';

		// Public routes.
		if (method === 'GET' && parts.length === 0) {
			return statusPage(res, relay, base);
		}
		if (method === 'GET' && parts[0] === 'healthz') {
			return sendJson(res, 200, { ok: true, ...relay.info(base) });
		}
		if (parts[0] === 'h' && parts.length === 2) {
			if (!['POST', 'PUT', 'PATCH'].includes(method)) {
				throw new HttpError(405, 'Webhooks are POST (or PUT/PATCH).');
			}
			const body = await readBody(req, WEBHOOK_BODY_LIMIT);
			const result = await relay.receiveWebhook(parts[1], { method, headers: req.headers, query, body });
			if (typeof result.text === 'string') {
				res.writeHead(result.status, { 'content-type': 'text/plain; charset=utf-8' });
				return res.end(result.text);
			}
			return sendJson(res, result.status, result.body);
		}
		if (method === 'POST' && parts[0] === 'api' && parts[1] === 'pair' && parts.length === 2) {
			const result = await relay.pair(await readJson(req));
			return sendJson(res, 200, { ...result, relay: relay.info(base) });
		}

		if (parts[0] !== 'api') {
			throw new HttpError(404, 'Not found.');
		}
		const device = relay.authenticate(req.headers.authorization);
		const route = `${method} /${parts.slice(1).map(part => /^(dlv|task|blob|run|cli)_/.test(part) ? ':id' : part).join('/')}`;
		const id = parts.find(part => /^(dlv|task|blob|run|cli)_/.test(part));
		const runnerOnly = () => {
			if (device.kind !== 'runner') {
				throw new HttpError(403, 'Runners only.');
			}
		};
		const adminOnly = () => {
			if (!device.admin) {
				throw new HttpError(403, 'Admin token only.');
			}
		};

		if (parts[1] === 'hooks' && parts.length === 3) {
			if (method === 'PUT') {
				return sendJson(res, 200, await relay.upsertHook(device, parts[2], await readJson(req), base));
			}
			if (method === 'DELETE') {
				await relay.deleteHook(device, parts[2]);
				return sendJson(res, 200, { ok: true });
			}
		}

		switch (route) {
			case 'GET /me':
				return sendJson(res, 200, { device: { id: device.id, kind: device.kind, name: device.name }, relay: relay.info(base) });
			case 'POST /pairings': {
				adminOnly();
				const body = await readJson(req);
				const pairing = await relay.createPairing(body.kind, body.name);
				return sendJson(res, 200, { ...pairing, link: `${base}/#pair=${pairing.code}` });
			}
			case 'GET /devices':
				adminOnly();
				return sendJson(res, 200, { devices: relay.state.devices.map(({ tokenHash: _hash, ...rest }) => rest) });
			case 'DELETE /devices/:id':
				adminOnly();
				await relay.revokeDevice(id);
				return sendJson(res, 200, { ok: true });
			case 'GET /events':
				return openStream(req, res, Number(query.after ?? req.headers['last-event-id'] ?? 0));
			case 'GET /events/poll':
				return poll(res, Number(query.after ?? 0), clampInt(query.timeout, 0, 55, 25) * 1000);
			case 'POST /heartbeat':
				return sendJson(res, 200, await relay.heartbeat(device, await readJson(req)));
			case 'GET /machines':
				return sendJson(res, 200, { machines: relay.listMachines(), now: Date.now() });
			case 'GET /hooks':
				return sendJson(res, 200, { hooks: relay.listHooks(device) });
			case 'GET /deliveries':
				return sendJson(res, 200, { deliveries: relay.listDeliveries(device, query) });
			case 'GET /deliveries/:id':
				return sendJson(res, 200, await relay.getDelivery(device, id, true));
			case 'POST /deliveries/:id/claim':
				return sendJson(res, 200, await relay.claimDelivery(device, id));
			case 'POST /deliveries/:id/ack':
				return sendJson(res, 200, await relay.ackDelivery(device, id, await readJson(req)));
			case 'POST /deliveries/:id/redeliver':
				return sendJson(res, 200, await relay.redeliver(device, id));
			case 'PUT /blobs':
				return sendJson(res, 200, await relay.putBlob(device, req, query));
			case 'GET /blobs/:id': {
				const { blob, path } = relay.getBlob(id);
				res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': blob.size, 'x-sha256': blob.sha256 });
				fs.createReadStream(path).pipe(res);
				return;
			}
			case 'POST /tasks':
				return sendJson(res, 200, await relay.createTask(device, await readJson(req)));
			case 'GET /tasks':
				return sendJson(res, 200, { tasks: relay.listTasks(query) });
			case 'GET /tasks/:id':
				return sendJson(res, 200, relay.getTask(id));
			case 'DELETE /tasks/:id':
				await relay.archiveTask(id);
				return sendJson(res, 200, { ok: true });
			case 'POST /tasks/:id/cancel':
				return sendJson(res, 200, await relay.cancelTask(id));
			case 'GET /tasks/:id/log':
				return sendJson(res, 200, { lines: await relay.readLog(id, Number(query.after ?? 0)) });
			case 'POST /runner/claim': {
				runnerOnly();
				const body = await readJson(req);
				const wait = clampInt(query.wait, 0, 55, 25) * 1000;
				const task = await relay.claimTask(device, body, wait);
				return task ? sendJson(res, 200, { task }) : sendJson(res, 200, { task: null });
			}
			case 'POST /runner/tasks/:id/events':
				runnerOnly();
				return sendJson(res, 200, await relay.taskEvents(device, id, (await readJson(req, 8 * 1024 * 1024)).events));
			case 'POST /runner/tasks/:id/complete':
				runnerOnly();
				return sendJson(res, 200, await relay.completeTask(device, id, await readJson(req)));
		}
		throw new HttpError(404, `No route ${method} ${url.pathname}.`);
	}

	function openStream(req, res, after) {
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			'x-accel-buffering': 'no',
			connection: 'keep-alive',
		});
		res.write(`retry: 3000\n: volt relay ${relay.state.relayId}\n\n`);
		const send = event => res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		const backlog = relay.store.eventsAfter(after);
		if (backlog === undefined) {
			res.write(`id: ${relay.state.seq}\nevent: resync\ndata: ${JSON.stringify({ type: 'resync', seq: relay.state.seq })}\n\n`);
		} else {
			backlog.forEach(send);
		}
		const unsubscribe = relay.store.subscribe(send);
		// A comment every 15s keeps NATs and proxies from closing an idle stream.
		const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
		const stream = { res, close: () => res.end() };
		streams.add(stream);
		req.on('close', () => {
			clearInterval(ping);
			unsubscribe();
			streams.delete(stream);
		});
	}

	function poll(res, after, timeout) {
		const backlog = relay.store.eventsAfter(after);
		if (backlog === undefined) {
			return sendJson(res, 200, { events: [{ type: 'resync', seq: relay.state.seq }], seq: relay.state.seq });
		}
		if (backlog.length || timeout === 0) {
			return sendJson(res, 200, { events: backlog, seq: relay.state.seq });
		}
		let done = false;
		const finish = () => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				unsubscribe();
				sendJson(res, 200, { events: relay.store.eventsAfter(after) ?? [], seq: relay.state.seq });
			}
		};
		// Collect a burst (a status change plus its log lines) into one response.
		const unsubscribe = relay.store.subscribe(() => setTimeout(finish, 50));
		const timer = setTimeout(finish, timeout);
		res.on('close', () => {
			done = true;
			clearTimeout(timer);
			unsubscribe();
		});
	}

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', resolve);
	});
	const address = server.address();
	return {
		relay,
		server,
		port: typeof address === 'object' && address ? address.port : options.port,
		async close() {
			relay.close();
			for (const stream of streams) {
				stream.close();
			}
			await new Promise(resolve => server.close(resolve));
			server.closeAllConnections?.();
			await relay.store.saving;
		},
	};
}

function statusPage(res, relay, base) {
	const machines = relay.listMachines();
	const escape = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
	const rows = machines.map(machine => `<li>${escape(machine.name)} <small>(${machine.kind}, ${machine.online ? 'online' : 'offline'})</small></li>`).join('') || '<li>No machines yet.</li>';
	const html = `<!doctype html><meta charset="utf-8"><title>Volt Relay</title>
<style>body{font:14px system-ui;margin:40px;max-width:640px;color:#222}code{background:#f3f3f3;padding:2px 5px;border-radius:4px}small{color:#777}</style>
<h1>Volt Relay</h1>
<p>Relay <code>${escape(relay.state.relayId)}</code> at <code>${escape(base)}</code>.</p>
<p>To connect Volt, run <code>volt-relay pair</code> on this host (or <code>docker exec &lt;container&gt; volt-relay pair</code>) and paste the link it prints into Volt: <b>Connect to Relay…</b>.</p>
<h2>Machines</h2><ul>${rows}</ul>`;
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
	res.end(html);
}
