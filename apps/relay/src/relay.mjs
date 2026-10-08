/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { verifySignature } from './signature.mjs';
import { Store } from './store.mjs';
import { ineligibleReason, loadScore, pickMachine } from './placement.mjs';
import { HttpError, newId, normalizePairingCode, pairingCode, randomToken, redactHeaders, safeEqual, sha256 } from './util.mjs';

export const PROTOCOL_VERSION = 1;

/** A machine whose last heartbeat is older than this is offline. */
export const MACHINE_STALE_MS = 30_000;
/** A claimed delivery that is not acked in this long goes back to `held` (at-least-once). */
export const DELIVERY_LEASE_MS = 2 * 60_000;
/** Deliveries kept per hook once handled (held ones are never pruned). */
export const DELIVERIES_KEPT_PER_HOOK = 100;
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
export const WEBHOOK_RATE_PER_MINUTE = 60;
/** A queued task aimed at one runner may go to any capable runner after this long. */
export const DEFAULT_FALLBACK_SEC = 90;
/** A runner silent this long while working on a task fails it. */
const RUNNER_LOST_MS = 90_000;
const PAIRING_TTL_MS = 15 * 60_000;
const LOG_LIMIT_BYTES = 8 * 1024 * 1024;

const TASK_ACTIVE = new Set(['queued', 'claimed', 'preparing', 'running', 'finishing']);
/** The agents a cloud task can run, each with its own placement. */
const PLACEMENT_AGENTS = ['claude', 'codex'];
const TASK_DONE = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Domain logic of the relay: devices and pairing, hooks and held deliveries, machines and their
 * load, cloud tasks and their logs. HTTP lives in server.mjs; everything here works on the store.
 */
export class Relay {

	constructor(options) {
		this.options = {
			holdDays: 7,
			enrollKey: undefined,
			maxBlobBytes: 512 * 1024 * 1024,
			...options,
		};
		this.store = new Store(options.dataDir);
		this.state = this.store.load();
		if (!this.state.relayId) {
			this.state.relayId = newId('relay');
		}
		this.rates = new Map();
		this.claimWaiters = new Set();
		this.adminToken = this.loadAdminToken();
	}

	async init() {
		this.sweep();
		await this.store.save();
		this.timer = setInterval(() => this.sweep(), 5_000);
		this.timer.unref?.();
	}

	close() {
		clearInterval(this.timer);
		for (const waiter of this.claimWaiters) {
			waiter.resolve(undefined);
		}
	}

	loadAdminToken() {
		const file = this.store.path('admin-token');
		if (process.env.VOLT_RELAY_ADMIN_TOKEN) {
			return process.env.VOLT_RELAY_ADMIN_TOKEN;
		}
		try {
			return fs.readFileSync(file, 'utf8').trim();
		} catch {
			const token = `vra_${randomToken(24)}`;
			fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
			return token;
		}
	}

	info(base) {
		return { relayId: this.state.relayId, name: this.options.name ?? 'Volt Relay', protocol: PROTOCOL_VERSION, publicUrl: base };
	}

	//#region Auth and pairing

	/** The device a bearer token belongs to, or `{ admin: true }`. */
	authenticate(header) {
		const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? ''));
		if (!match) {
			throw new HttpError(401, 'Missing bearer token.');
		}
		const token = match[1];
		if (safeEqual(token, this.adminToken)) {
			return { admin: true, id: 'admin', kind: 'admin', name: 'Admin' };
		}
		const hash = sha256(token);
		const device = this.state.devices.find(candidate => candidate.tokenHash === hash && !candidate.revokedAt);
		if (!device) {
			throw new HttpError(401, 'Unknown or revoked token.');
		}
		device.lastSeenAt = Date.now();
		return device;
	}

	async createPairing(kind, name) {
		const code = pairingCode();
		const pairing = { codeHash: sha256(normalizePairingCode(code)), kind: kind === 'runner' ? 'runner' : 'client', name: name || undefined, expiresAt: Date.now() + PAIRING_TTL_MS };
		this.state.pairings = [...this.state.pairings.filter(candidate => candidate.expiresAt > Date.now()), pairing];
		await this.store.save();
		return { code, kind: pairing.kind, expiresAt: pairing.expiresAt };
	}

	/** Trades a one-time code (or the enrollment key, for runners) for a long-lived device token. */
	async pair(body) {
		const now = Date.now();
		let kind;
		if (body.enrollKey) {
			if (!this.options.enrollKey || !safeEqual(body.enrollKey, this.options.enrollKey)) {
				throw new HttpError(403, 'Wrong enrollment key.');
			}
			kind = body.kind === 'client' ? 'client' : 'runner';
		} else {
			const hash = sha256(normalizePairingCode(body.code));
			const pairing = this.state.pairings.find(candidate => candidate.codeHash === hash && candidate.expiresAt > now);
			if (!pairing) {
				throw new HttpError(403, 'That pairing code is wrong or expired. Make a new one with `volt-relay pair`.');
			}
			this.state.pairings = this.state.pairings.filter(candidate => candidate !== pairing);
			kind = pairing.kind;
		}
		const name = String(body.name || (kind === 'runner' ? 'Runner' : 'Volt')).slice(0, 80);
		// A runner that re-enrolls under the same machine id keeps its identity (and its tasks).
		const machineId = typeof body.machineId === 'string' && /^[\w.-]{4,80}$/.test(body.machineId) ? body.machineId : undefined;
		const token = `vr${kind === 'runner' ? 'r' : 'c'}_${randomToken(32)}`;
		let device = machineId ? this.state.devices.find(candidate => candidate.machineId === machineId && candidate.kind === kind) : undefined;
		if (device) {
			device.tokenHash = sha256(token);
			device.name = name;
			device.revokedAt = undefined;
		} else {
			device = { id: newId(kind === 'runner' ? 'run' : 'cli'), kind, name, machineId, tokenHash: sha256(token), createdAt: now, lastSeenAt: now };
			this.state.devices.push(device);
		}
		await this.store.save();
		this.store.emit('device', device.id, publicDevice(device));
		return { token, device: publicDevice(device) };
	}

	async revokeDevice(id) {
		const device = this.state.devices.find(candidate => candidate.id === id);
		if (!device) {
			throw new HttpError(404, 'No such device.');
		}
		device.revokedAt = Date.now();
		this.state.machines = this.state.machines.filter(machine => machine.id !== id);
		await this.store.save();
		this.store.emit('machine.removed', id, {});
	}

	//#endregion

	//#region Machines

	/** A heartbeat from a runner or a Volt client: its load and what it can run. */
	async heartbeat(device, body) {
		const now = Date.now();
		const previous = this.state.machines.find(machine => machine.id === device.id);
		const machine = {
			id: device.id,
			kind: device.kind,
			name: String(body.name || device.name).slice(0, 80),
			at: now,
			load: sanitizeLoad(body.load),
			caps: sanitizeCaps(body.caps),
			version: typeof body.version === 'string' ? body.version.slice(0, 40) : undefined,
			running: Array.isArray(body.running) ? body.running.filter(id => typeof id === 'string').slice(0, 64) : [],
		};
		this.state.machines = [...this.state.machines.filter(candidate => candidate.id !== device.id), machine];
		// Heartbeats are frequent; they are persisted lazily (machine state is soft).
		if (!previous || !previous.caps || JSON.stringify(previous.caps) !== JSON.stringify(machine.caps)) {
			void this.store.save();
		}
		this.store.emit('machine', machine.id, this.machineView(machine, now));
		const cancel = this.state.tasks.filter(task => task.assignedTo === device.id && task.cancelRequested && TASK_ACTIVE.has(task.status)).map(task => task.id);
		return { cancel, now };
	}

	machineView(machine, now = Date.now()) {
		const reserved = this.state.tasks.filter(task => TASK_ACTIVE.has(task.status) && (task.assignedTo === machine.id || (task.status === 'queued' && task.target?.machineId === machine.id))).length;
		return { ...machine, online: now - machine.at < MACHINE_STALE_MS, lastSeenAt: machine.at, reserved };
	}

	/**
	 * What the desktop shows for each machine, decided here and nowhere else: its load score, whether
	 * it can take each agent's task (and why not), and whether it is the Auto pick for each agent.
	 */
	listMachines() {
		const now = Date.now();
		const counted = this.placementMachines();
		const autoPick = Object.fromEntries(PLACEMENT_AGENTS.map(agent => [agent, pickMachine(counted, { agent }, { now }).machineId]));
		return counted.map(machine => ({
			...this.machineView(machine, now),
			score: loadScore(machine),
			placement: Object.fromEntries(PLACEMENT_AGENTS.map(agent => {
				const reason = ineligibleReason(machine, { agent }, now);
				return [agent, { eligible: !reason, reason: reason ?? null }];
			})),
			autoPick: Object.fromEntries(PLACEMENT_AGENTS.map(agent => [agent, autoPick[agent] === machine.id])),
		}));
	}

	/** The machines Auto placement chooses among; a task already assigned to one counts as running there. */
	placementMachines() {
		const active = this.state.tasks.filter(candidate => TASK_ACTIVE.has(candidate.status) && candidate.assignedTo);
		return this.state.machines
			.filter(machine => this.state.devices.some(device => device.id === machine.id && !device.revokedAt))
			.map(machine => ({
				...machine,
				running: [...new Set([...(machine.running ?? []), ...active.filter(candidate => candidate.assignedTo === machine.id).map(candidate => candidate.id)])],
			}));
	}

	//#endregion

	//#region Hooks and deliveries

	listHooks(device) {
		return this.state.hooks.filter(hook => device.admin || hook.ownerId === device.id).map(hook => this.hookView(hook));
	}

	hookView(hook) {
		const deliveries = this.state.deliveries.filter(delivery => delivery.hookId === hook.id);
		return {
			id: hook.id,
			name: hook.name,
			enabled: hook.enabled,
			signature: { kind: hook.signature?.kind ?? 'none', header: hook.signature?.header, prefix: hook.signature?.prefix, encoding: hook.signature?.encoding, timestampHeader: hook.signature?.timestampHeader, hasSecret: !!hook.signature?.secret },
			tokenHint: hook.tokenHint,
			createdAt: hook.createdAt,
			held: deliveries.filter(delivery => delivery.status === 'held' || delivery.status === 'delivered').length,
			lastDeliveryAt: deliveries.at(-1)?.receivedAt,
		};
	}

	/**
	 * Creates or updates a hook. Its URL token is made here and returned once (on create or
	 * `rotate`); the relay keeps only its hash, so a leaked state file does not leak hook URLs.
	 */
	async upsertHook(device, id, body, base) {
		if (!/^[\w.-]{3,80}$/.test(id)) {
			throw new HttpError(400, 'Hook ids are 3-80 characters of letters, digits, dot, dash or underscore.');
		}
		let hook = this.state.hooks.find(candidate => candidate.id === id);
		if (hook && hook.ownerId !== device.id && !device.admin) {
			throw new HttpError(409, 'That hook id belongs to another device.');
		}
		let token;
		if (!hook) {
			hook = { id, ownerId: device.id, createdAt: Date.now(), enabled: true };
			this.state.hooks.push(hook);
			token = randomToken(24);
		} else if (body.rotate) {
			token = randomToken(24);
		}
		if (token) {
			hook.tokenHash = sha256(token);
			hook.tokenHint = token.slice(-4);
		}
		if (typeof body.name === 'string') {
			hook.name = body.name.slice(0, 120);
		}
		if (typeof body.enabled === 'boolean') {
			hook.enabled = body.enabled;
		}
		if (body.signature && typeof body.signature === 'object') {
			const kind = ['none', 'github', 'generic'].includes(body.signature.kind) ? body.signature.kind : 'none';
			hook.signature = kind === 'none' ? { kind } : {
				kind,
				// An update without a secret keeps the stored one (the client may not hold it any more).
				secret: typeof body.signature.secret === 'string' && body.signature.secret ? body.signature.secret : hook.signature?.secret,
				header: typeof body.signature.header === 'string' && body.signature.header ? body.signature.header.toLowerCase().slice(0, 80) : undefined,
				prefix: typeof body.signature.prefix === 'string' ? body.signature.prefix.slice(0, 20) : undefined,
				encoding: body.signature.encoding === 'base64' ? 'base64' : undefined,
				timestampHeader: typeof body.signature.timestampHeader === 'string' && body.signature.timestampHeader ? body.signature.timestampHeader.toLowerCase().slice(0, 80) : undefined,
				toleranceSec: Number.isFinite(body.signature.toleranceSec) ? body.signature.toleranceSec : undefined,
			};
		}
		await this.store.save();
		this.store.emit('hook', hook.id, this.hookView(hook));
		return { ...this.hookView(hook), ...(token ? { url: `${base}/h/${token}` } : {}) };
	}

	async deleteHook(device, id) {
		const hook = this.ownHook(device, id);
		this.state.hooks = this.state.hooks.filter(candidate => candidate !== hook);
		const gone = this.state.deliveries.filter(delivery => delivery.hookId === id);
		this.state.deliveries = this.state.deliveries.filter(delivery => delivery.hookId !== id);
		await this.store.save();
		await Promise.all(gone.map(delivery => this.store.removeFile(`deliveries/${delivery.id}.json`)));
		this.store.emit('hook.removed', id, {});
	}

	ownHook(device, id) {
		const hook = this.state.hooks.find(candidate => candidate.id === id);
		if (!hook || (!device.admin && hook.ownerId !== device.id)) {
			throw new HttpError(404, 'No such hook.');
		}
		return hook;
	}

	/**
	 * A webhook arrives at `/h/<token>`. It is checked (rate, size, signature), de-duplicated by
	 * the sender's delivery id, written to disk, and then answered 202: it is held until the
	 * owning Volt claims and acks it.
	 */
	async receiveWebhook(token, request) {
		const hash = sha256(token);
		const hook = this.state.hooks.find(candidate => candidate.tokenHash === hash);
		if (!hook) {
			throw new HttpError(404, 'Unknown hook.');
		}
		if (!hook.enabled) {
			throw new HttpError(410, 'This hook is turned off.');
		}
		const now = Date.now();
		const window = (this.rates.get(hook.id) ?? []).filter(at => now - at < 60_000);
		if (window.length >= WEBHOOK_RATE_PER_MINUTE) {
			throw new HttpError(429, 'Too many deliveries for this hook; slow down.', { 'retry-after': '30' });
		}
		window.push(now);
		this.rates.set(hook.id, window);

		const headers = request.headers;
		const event = headerOf(headers, 'x-github-event') ?? headerOf(headers, 'x-gitlab-event') ?? headerOf(headers, 'x-event-type') ?? headerOf(headers, 'x-volt-event');
		const externalId = headerOf(headers, 'x-github-delivery') ?? headerOf(headers, 'x-gitlab-event-uuid') ?? headerOf(headers, 'idempotency-key') ?? headerOf(headers, 'x-delivery-id') ?? headerOf(headers, 'x-request-id');
		const check = verifySignature(hook.signature, headers, request.body, now);
		const base = {
			hookId: hook.id,
			ownerId: hook.ownerId,
			receivedAt: now,
			method: request.method,
			event: event?.slice(0, 120),
			externalId: externalId?.slice(0, 200),
			contentType: headerOf(headers, 'content-type')?.slice(0, 120),
			size: request.body.length,
			signature: check.ok ? (check.verified ? 'verified' : 'none') : 'failed',
			attempts: 0,
		};
		if (!check.ok) {
			// Kept (without the body) so the deliveries list shows why a sender's calls fail.
			const rejected = { id: newId('dlv'), seq: this.state.seq + 1, status: 'failed', result: { error: check.reason, rejected: true }, ...base };
			this.state.deliveries.push(rejected);
			this.prune(hook.id);
			await this.store.save();
			this.store.emit('delivery', rejected.id, rejected);
			throw new HttpError(401, check.reason);
		}
		if (externalId) {
			const duplicate = this.state.deliveries.find(delivery => delivery.hookId === hook.id && delivery.externalId === externalId && !delivery.redeliveryOf && delivery.status !== 'failed');
			if (duplicate) {
				return { status: 200, body: { id: duplicate.id, status: duplicate.status, duplicate: true } };
			}
		}
		const delivery = { id: newId('dlv'), status: 'held', ...base };
		await this.store.writeFile(`deliveries/${delivery.id}.json`, JSON.stringify({
			headers: redactHeaders(headers),
			query: request.query,
			body: request.body.toString('utf8'),
		}));
		delivery.seq = this.state.seq + 1;
		this.store.emit('delivery', delivery.id, delivery);
		this.state.deliveries.push(delivery);
		this.prune(hook.id);
		await this.store.save();
		return { status: 202, body: { id: delivery.id, status: 'held' } };
	}

	listDeliveries(device, query) {
		const hooks = new Set(this.state.hooks.filter(hook => device.admin || hook.ownerId === device.id).map(hook => hook.id));
		let list = this.state.deliveries.filter(delivery => hooks.has(delivery.hookId));
		if (query.hook) {
			list = list.filter(delivery => delivery.hookId === query.hook);
		}
		if (query.status) {
			const wanted = new Set(String(query.status).split(','));
			list = list.filter(delivery => wanted.has(delivery.status));
		}
		list = [...list].sort((a, b) => a.seq - b.seq);
		const limit = Math.min(500, Number(query.limit) || 100);
		return query.status === 'held' ? list.slice(0, limit) : list.slice(-limit);
	}

	async getDelivery(device, id, withBody) {
		const delivery = this.ownDelivery(device, id);
		if (!withBody) {
			return delivery;
		}
		let payload = {};
		try {
			payload = JSON.parse(await fs.promises.readFile(this.store.path(`deliveries/${delivery.id}.json`), 'utf8'));
		} catch {
			// Rejected deliveries keep no body.
		}
		return { ...delivery, ...payload };
	}

	ownDelivery(device, id) {
		const delivery = this.state.deliveries.find(candidate => candidate.id === id);
		if (!delivery || (!device.admin && delivery.ownerId !== device.id)) {
			throw new HttpError(404, 'No such delivery.');
		}
		return delivery;
	}

	/** Leases a held delivery to its owner: it returns to `held` if not acked in time. */
	async claimDelivery(device, id) {
		const delivery = this.ownDelivery(device, id);
		if (delivery.status !== 'held' && delivery.status !== 'delivered') {
			// Already handled: hand back the outcome so a retrying client just acks and moves on.
			return { ...(await this.getDelivery(device, id, false)), alreadyHandled: true };
		}
		delivery.status = 'delivered';
		delivery.attempts = (delivery.attempts ?? 0) + 1;
		delivery.deliveredAt = Date.now();
		delivery.leaseUntil = Date.now() + DELIVERY_LEASE_MS;
		await this.store.save();
		this.store.emit('delivery', delivery.id, delivery);
		return this.getDelivery(device, id, true);
	}

	async ackDelivery(device, id, body) {
		const delivery = this.ownDelivery(device, id);
		const status = ['ran', 'filtered', 'failed'].includes(body.status) ? body.status : 'ran';
		delivery.status = status;
		delivery.ackedAt = Date.now();
		delivery.leaseUntil = undefined;
		delivery.result = {
			...(typeof body.threadId === 'string' ? { threadId: body.threadId.slice(0, 120) } : {}),
			...(typeof body.error === 'string' ? { error: body.error.slice(0, 500) } : {}),
			...(typeof body.note === 'string' ? { note: body.note.slice(0, 500) } : {}),
		};
		await this.store.save();
		this.store.emit('delivery', delivery.id, delivery);
		return delivery;
	}

	/** Sends a delivery again: a new held copy (new id, so dedupe does not swallow it). */
	async redeliver(device, id) {
		const original = this.ownDelivery(device, id);
		let payload;
		try {
			payload = await fs.promises.readFile(this.store.path(`deliveries/${original.id}.json`), 'utf8');
		} catch {
			throw new HttpError(409, 'That delivery kept no body (it was rejected), so it cannot be sent again.');
		}
		const copy = {
			...original,
			id: newId('dlv'),
			status: 'held',
			receivedAt: Date.now(),
			attempts: 0,
			redeliveryOf: original.id,
			deliveredAt: undefined,
			ackedAt: undefined,
			leaseUntil: undefined,
			result: undefined,
		};
		await this.store.writeFile(`deliveries/${copy.id}.json`, payload);
		copy.seq = this.state.seq + 1;
		this.store.emit('delivery', copy.id, copy);
		this.state.deliveries.push(copy);
		this.prune(copy.hookId);
		await this.store.save();
		return copy;
	}

	/** Keeps the newest handled deliveries per hook; held ones always stay. */
	prune(hookId) {
		const handled = this.state.deliveries.filter(delivery => delivery.hookId === hookId && delivery.status !== 'held' && delivery.status !== 'delivered');
		const extra = handled.length - DELIVERIES_KEPT_PER_HOOK;
		if (extra > 0) {
			const drop = new Set(handled.slice(0, extra).map(delivery => delivery.id));
			this.state.deliveries = this.state.deliveries.filter(delivery => !drop.has(delivery.id));
			for (const id of drop) {
				void this.store.removeFile(`deliveries/${id}.json`);
			}
		}
	}

	//#endregion

	//#region Blobs

	async putBlob(device, req, query) {
		const id = newId('blob');
		const target = this.store.path(`blobs/${id}`);
		const hash = crypto.createHash('sha256');
		let size = 0;
		const limit = this.options.maxBlobBytes;
		req.on('data', chunk => {
			size += chunk.length;
			hash.update(chunk);
			if (size > limit) {
				req.destroy(new HttpError(413, `Blobs are limited to ${limit} bytes.`));
			}
		});
		await pipeline(req, fs.createWriteStream(target, { mode: 0o600 }));
		const blob = { id, size, sha256: hash.digest('hex'), kind: String(query.kind ?? 'file').slice(0, 40), taskId: query.task ? String(query.task).slice(0, 80) : undefined, ownerId: device.id, createdAt: Date.now() };
		this.state.blobs.push(blob);
		await this.store.save();
		return blob;
	}

	getBlob(id) {
		const blob = this.state.blobs.find(candidate => candidate.id === id);
		if (!blob) {
			throw new HttpError(404, 'No such blob.');
		}
		return { blob, path: this.store.path(`blobs/${blob.id}`) };
	}

	//#endregion

	//#region Tasks

	async createTask(device, body) {
		const prompt = String(body.prompt ?? '').trim();
		if (!prompt) {
			throw new HttpError(400, 'A task needs a prompt.');
		}
		const source = body.source ?? {};
		if (!source.bundleBlob && !source.repoUrl) {
			throw new HttpError(400, 'A task needs code: source.repoUrl or source.bundleBlob.');
		}
		for (const blobId of [source.bundleBlob, source.patchBlob].filter(Boolean)) {
			this.getBlob(blobId);
		}
		const now = Date.now();
		const task = {
			id: newId('task'),
			title: String(body.title || prompt.split('\n')[0]).slice(0, 120),
			prompt: prompt.slice(0, 100_000),
			agent: body.agent === 'codex' ? 'codex' : 'claude',
			model: typeof body.model === 'string' ? body.model.slice(0, 80) : undefined,
			source: {
				repoUrl: typeof source.repoUrl === 'string' ? source.repoUrl.slice(0, 500) : undefined,
				baseCommit: typeof source.baseCommit === 'string' ? source.baseCommit.slice(0, 64) : undefined,
				baseBranch: typeof source.baseBranch === 'string' ? source.baseBranch.slice(0, 200) : undefined,
				bundleBlob: source.bundleBlob,
				patchBlob: source.patchBlob,
				projectName: typeof source.projectName === 'string' ? source.projectName.slice(0, 120) : undefined,
			},
			target: {
				machineId: typeof body.target?.machineId === 'string' ? body.target.machineId : undefined,
				fallbackAfterSec: Number.isFinite(body.target?.fallbackAfterSec) ? body.target.fallbackAfterSec : DEFAULT_FALLBACK_SEC,
				autoPicked: body.target?.autoPicked === true,
			},
			push: body.push === true,
			origin: { deviceId: device.id, deviceName: device.name, ...(body.origin && typeof body.origin === 'object' ? { repoRoot: body.origin.repoRoot, chatId: body.origin.chatId } : {}) },
			status: 'queued',
			createdAt: now,
			updatedAt: now,
			logCount: 0,
			logBytes: 0,
		};
		this.state.tasks.push(task);
		for (const blobId of [source.bundleBlob, source.patchBlob].filter(Boolean)) {
			this.getBlob(blobId).blob.taskId = task.id;
		}
		await this.store.save();
		this.store.emit('task', task.id, task);
		this.wakeClaimers();
		return task;
	}

	listTasks(query = {}) {
		let list = this.state.tasks.filter(task => !task.archived);
		if (query.active) {
			list = list.filter(task => TASK_ACTIVE.has(task.status));
		}
		return [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.min(500, Number(query.limit) || 200));
	}

	getTask(id) {
		const task = this.state.tasks.find(candidate => candidate.id === id);
		if (!task) {
			throw new HttpError(404, 'No such task.');
		}
		return task;
	}

	async cancelTask(id) {
		const task = this.getTask(id);
		if (TASK_DONE.has(task.status)) {
			return task;
		}
		if (task.status === 'queued') {
			this.finishTask(task, 'cancelled', { error: 'Cancelled before a runner took it.' });
		} else {
			task.cancelRequested = true;
			task.updatedAt = Date.now();
		}
		await this.store.save();
		this.store.emit('task', task.id, task);
		return task;
	}

	async archiveTask(id) {
		const task = this.getTask(id);
		if (TASK_ACTIVE.has(task.status)) {
			throw new HttpError(409, 'Cancel the task before removing it.');
		}
		task.archived = true;
		await this.store.save();
		this.store.emit('task.removed', task.id, {});
	}

	async readLog(id, after = 0, limit = 2000) {
		this.getTask(id);
		let text = '';
		try {
			text = await fs.promises.readFile(this.store.path(`logs/${id}.jsonl`), 'utf8');
		} catch {
			return [];
		}
		const lines = [];
		for (const line of text.split('\n')) {
			if (!line) {
				continue;
			}
			try {
				const entry = JSON.parse(line);
				if (entry.i > after) {
					lines.push(entry);
				}
			} catch {
				// A torn last line after a crash.
			}
		}
		return lines.slice(0, limit);
	}

	/**
	 * Hands a runner the next task it may take: aimed at it, or at nobody, or aimed at a runner
	 * that has been offline (or slow) past the task's fallback time. Waits up to `waitMs`.
	 */
	async claimTask(device, body, waitMs) {
		const found = this.nextTaskFor(device, body);
		if (found || waitMs <= 0) {
			return found ? this.assign(found, device) : undefined;
		}
		return new Promise(resolve => {
			const waiter = {
				resolve: task => {
					clearTimeout(timer);
					this.claimWaiters.delete(waiter);
					resolve(task);
				},
				try: () => {
					const task = this.nextTaskFor(device, body);
					if (task) {
						waiter.resolve(this.assign(task, device));
					}
				},
			};
			const timer = setTimeout(() => waiter.resolve(undefined), waitMs);
			this.claimWaiters.add(waiter);
		});
	}

	wakeClaimers() {
		for (const waiter of [...this.claimWaiters]) {
			waiter.try();
		}
	}

	nextTaskFor(device, body) {
		const now = Date.now();
		const agents = body?.agents && typeof body.agents === 'object' ? body.agents : undefined;
		const machines = new Map(this.state.machines.map(machine => [machine.id, machine]));
		return this.state.tasks
			.filter(task => task.status === 'queued' && !task.archived)
			.sort((a, b) => a.createdAt - b.createdAt)
			.find(task => {
				if (agents && agents[task.agent] !== true) {
					return false;
				}
				const target = task.target?.machineId;
				const overdue = now - task.createdAt > (task.target?.fallbackAfterSec ?? DEFAULT_FALLBACK_SEC) * 1000;
				if (!target) {
					// Auto: the least loaded runner that can take it gets it; anyone once it has waited too long.
					if (!task.target?.autoPicked || overdue) {
						return true;
					}
					return this.autoMachineFor(task, now) === device.id;
				}
				if (target === device.id) {
					return true;
				}
				const aimed = machines.get(target);
				const aimedOffline = !aimed || now - aimed.at > MACHINE_STALE_MS;
				return aimedOffline || overdue;
			});
	}

	/**
	 * The runner an Auto task goes to (see placement.mjs), counting the tasks already assigned to
	 * each runner, since its heartbeat may not list them yet. The chat's last runner keeps it unless
	 * another is clearly less loaded.
	 */
	autoMachineFor(task, now) {
		const chatId = task.origin?.chatId;
		const last = chatId ? this.state.tasks.filter(candidate => candidate.id !== task.id && candidate.origin?.chatId === chatId && candidate.assignedTo).at(-1) : undefined;
		return pickMachine(this.placementMachines(), task, { now, previousId: last?.assignedTo }).machineId;
	}

	assign(task, device) {
		task.status = 'claimed';
		task.assignedTo = device.id;
		task.assignedName = device.name;
		task.claimedAt = Date.now();
		task.updatedAt = task.claimedAt;
		void this.store.save();
		this.store.emit('task', task.id, task);
		return task;
	}

	ownTask(device, id) {
		const task = this.getTask(id);
		if (task.assignedTo !== device.id) {
			throw new HttpError(409, 'This task is not assigned to you.');
		}
		return task;
	}

	/** Progress from the runner: status changes and log lines (agent messages, tools, output). */
	async taskEvents(device, id, events) {
		const task = this.ownTask(device, id);
		if (TASK_DONE.has(task.status)) {
			return { cancel: true };
		}
		const now = Date.now();
		const lines = [];
		for (const event of Array.isArray(events) ? events.slice(0, 500) : []) {
			if (!event || typeof event !== 'object') {
				continue;
			}
			if (event.t === 'status' && ['preparing', 'running', 'finishing'].includes(event.status)) {
				task.status = event.status;
				if (event.status === 'running' && !task.startedAt) {
					task.startedAt = now;
				}
			}
			if (typeof event.progress === 'string') {
				task.progress = event.progress.slice(0, 200);
			}
			if (event.t === 'message' && typeof event.text === 'string') {
				task.lastMessage = event.text.slice(0, 400);
			}
			if (event.t === 'usage') {
				task.usage = { ...task.usage, ...sanitizeUsage(event) };
			}
			if (task.logBytes > LOG_LIMIT_BYTES && event.t === 'log') {
				continue;
			}
			const entry = { i: ++task.logCount, at: event.at ?? now, ...pick(event, ['t', 'status', 'progress', 'text', 'stream', 'name', 'summary', 'role', 'ok']) };
			if (typeof entry.text === 'string') {
				entry.text = entry.text.slice(0, 20_000);
			}
			lines.push(entry);
		}
		if (lines.length) {
			const chunk = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
			task.logBytes += Buffer.byteLength(chunk);
			await fs.promises.appendFile(this.store.path(`logs/${task.id}.jsonl`), chunk);
		}
		task.updatedAt = now;
		await this.store.save();
		this.store.emit('task', task.id, task);
		if (lines.length) {
			this.store.emit('task.log', task.id, { lines });
		}
		return { cancel: !!task.cancelRequested };
	}

	async completeTask(device, id, body) {
		const task = this.ownTask(device, id);
		if (TASK_DONE.has(task.status)) {
			return task;
		}
		const status = ['succeeded', 'failed', 'cancelled'].includes(body.status) ? body.status : 'failed';
		const result = body.result && typeof body.result === 'object' ? {
			branch: str(body.result.branch, 200),
			baseCommit: str(body.result.baseCommit, 64),
			headCommit: str(body.result.headCommit, 64),
			bundleBlob: str(body.result.bundleBlob, 80),
			patchBlob: str(body.result.patchBlob, 80),
			pushed: body.result.pushed && typeof body.result.pushed === 'object' ? { remote: str(body.result.pushed.remote, 500), branch: str(body.result.pushed.branch, 200) } : undefined,
			summary: str(body.result.summary, 8000),
			files: Array.isArray(body.result.files) ? body.result.files.slice(0, 500).map(file => ({ path: str(file.path, 500), insertions: Number(file.insertions) || 0, deletions: Number(file.deletions) || 0 })) : undefined,
			stats: body.result.stats && typeof body.result.stats === 'object' ? { files: Number(body.result.stats.files) || 0, insertions: Number(body.result.stats.insertions) || 0, deletions: Number(body.result.stats.deletions) || 0 } : undefined,
			noChanges: body.result.noChanges === true,
		} : undefined;
		this.finishTask(task, status, { result, error: str(body.error, 2000) });
		await this.store.save();
		this.store.emit('task', task.id, task);
		return task;
	}

	finishTask(task, status, { result, error }) {
		task.status = status;
		task.finishedAt = Date.now();
		task.updatedAt = task.finishedAt;
		task.cancelRequested = undefined;
		if (result) {
			task.result = result;
		}
		if (error) {
			task.error = error;
		}
	}

	//#endregion

	/** Periodic upkeep: expired leases, lost runners, old held deliveries. */
	sweep() {
		const now = Date.now();
		let changed = false;
		for (const delivery of this.state.deliveries) {
			if (delivery.status === 'delivered' && (delivery.leaseUntil ?? 0) < now) {
				delivery.status = 'held';
				delivery.leaseUntil = undefined;
				this.store.emit('delivery', delivery.id, delivery);
				changed = true;
			} else if (delivery.status === 'held' && now - delivery.receivedAt > this.options.holdDays * 86_400_000) {
				delivery.status = 'expired';
				this.store.emit('delivery', delivery.id, delivery);
				changed = true;
			}
		}
		const machines = new Map(this.state.machines.map(machine => [machine.id, machine]));
		for (const task of this.state.tasks) {
			if (!TASK_ACTIVE.has(task.status) || task.status === 'queued') {
				continue;
			}
			const runner = machines.get(task.assignedTo);
			const lastSign = Math.max(runner?.at ?? 0, task.updatedAt ?? 0);
			if (now - lastSign > RUNNER_LOST_MS) {
				if (task.status === 'claimed') {
					// It never started: let another runner have it.
					task.status = 'queued';
					task.assignedTo = undefined;
					task.assignedName = undefined;
				} else {
					this.finishTask(task, 'failed', { error: `${task.assignedName ?? 'The runner'} stopped responding.` });
				}
				this.store.emit('task', task.id, task);
				changed = true;
			}
		}
		if (this.state.tasks.some(task => task.status === 'queued')) {
			this.wakeClaimers();
		}
		this.state.pairings = this.state.pairings.filter(pairing => pairing.expiresAt > now);
		if (changed) {
			void this.store.save();
		}
	}
}

function publicDevice(device) {
	return { id: device.id, kind: device.kind, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, revokedAt: device.revokedAt };
}

function headerOf(headers, name) {
	const value = headers[name];
	return Array.isArray(value) ? value[0] : (typeof value === 'string' && value ? value : undefined);
}

function str(value, max) {
	return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function pick(source, keys) {
	const out = {};
	for (const key of keys) {
		if (source[key] !== undefined) {
			out[key] = source[key];
		}
	}
	return out;
}

function num(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeLoad(load) {
	const raw = load && typeof load === 'object' ? load : {};
	return {
		cpus: num(raw.cpus),
		load1: num(raw.load1),
		load5: num(raw.load5),
		cpu: num(raw.cpu),
		memFree: num(raw.memFree),
		memTotal: num(raw.memTotal),
		running: num(raw.running) ?? 0,
		slots: num(raw.slots),
		battery: raw.battery && typeof raw.battery === 'object' ? { percent: num(raw.battery.percent), charging: raw.battery.charging === true } : undefined,
		thermal: ['nominal', 'fair', 'serious', 'critical'].includes(raw.thermal) ? raw.thermal : undefined,
		container: raw.container === true,
	};
}

function sanitizeCaps(caps) {
	const raw = caps && typeof caps === 'object' ? caps : {};
	const agents = {};
	for (const name of ['claude', 'codex']) {
		const agent = raw.agents?.[name];
		if (agent && typeof agent === 'object') {
			agents[name] = { installed: agent.installed === true, credentials: agent.credentials === true, version: typeof agent.version === 'string' ? agent.version.slice(0, 60) : undefined };
		}
	}
	return {
		agents,
		maxParallel: num(raw.maxParallel),
		os: typeof raw.os === 'string' ? raw.os.slice(0, 40) : undefined,
		arch: typeof raw.arch === 'string' ? raw.arch.slice(0, 20) : undefined,
		gitPush: raw.gitPush === true,
		labels: Array.isArray(raw.labels) ? raw.labels.filter(label => typeof label === 'string').slice(0, 20).map(label => label.slice(0, 40)) : [],
	};
}

function sanitizeUsage(event) {
	return {
		...(num(event.inputTokens) !== undefined ? { inputTokens: event.inputTokens } : {}),
		...(num(event.outputTokens) !== undefined ? { outputTokens: event.outputTokens } : {}),
		...(num(event.costUsd) !== undefined ? { costUsd: event.costUsd } : {}),
		...(num(event.turns) !== undefined ? { turns: event.turns } : {}),
	};
}
