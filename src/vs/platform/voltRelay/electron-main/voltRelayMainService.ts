/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as http from 'http';
import { arch, cpus, freemem, hostname, loadavg, platform, tmpdir, totalmem } from 'os';
import { Readable } from 'stream';
import { powerMonitor } from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { parseRelayLink } from '../common/relayLink.js';
import {
	IVoltAppliedCloudResult, IVoltCloudSourceSummary, IVoltCloudTaskInput, IVoltDeliveryOutcome, IVoltHeldDelivery, IVoltLocalHook, IVoltRelayEvent, IVoltRelayService,
	IVoltRelayState, VOLT_LOCAL_WEBHOOK_PORT,
} from '../common/voltRelay.js';
import { verifyWebhookSignature } from '../node/relaySignature.js';
import { fetchResultBundle, prepareCloudSource } from '../node/relaySource.js';

interface IRelayConfig {
	readonly url: string;
	readonly token: string;
	readonly relayId?: string;
	readonly relayName?: string;
	readonly deviceId?: string;
	readonly deviceName?: string;
}

interface IConfigFile {
	readonly relay?: IRelayConfig;
	/** Stable across re-pairing, so the relay keeps this Mac's identity. */
	readonly machineId?: string;
}

type QueueItem = { readonly id: string; readonly source: 'relay'; readonly seq: number } | { readonly id: string; readonly source: 'local'; readonly delivery: IVoltHeldDelivery };

const HEARTBEAT_MS = 10_000;
/** Held deliveries are looked for this often even without an event (missed events, expired leases). */
const HELD_POLL_MS = 60_000;
/** A claimed delivery nobody answered is offered again after this (the relay lease is 2 minutes). */
const INFLIGHT_MS = 150_000;
/** The stream sends a comment every 15 s; silence this long means a dead connection. */
const STREAM_IDLE_MS = 45_000;
const LOCAL_BODY_LIMIT = 1024 * 1024;

class RelayError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** See {@link IVoltRelayService}. Every connection to the relay is outbound (works behind NAT). */
export class VoltRelayMainService extends Disposable implements IVoltRelayService {

	declare readonly _serviceBrand: undefined;

	private readonly file: string;
	private configFile: IConfigFile = {};
	private state: IVoltRelayState = { status: 'off' };
	/** Bumped on connect/disconnect; loops of an older generation stop. */
	private generation = 0;
	private streamAbort: AbortController | undefined;
	private lastSeq = 0;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private heldTimer: ReturnType<typeof setInterval> | undefined;
	private batteryTimer: ReturnType<typeof setInterval> | undefined;
	private battery: { percent?: number; charging?: boolean } | undefined;
	private cpuPrevious: { busy: number; total: number } | undefined;

	private readonly queue: QueueItem[] = [];
	private readonly inflight = new Map<string, number>();
	private readonly waiters = new Set<() => void>();
	private refreshing: Promise<void> | undefined;

	private readonly localHooks = new Map<string, IVoltLocalHook>();
	private readonly localSeen = new Map<string, string>();
	private localServer: http.Server | undefined;
	private localBase: string | undefined;
	private readonly ready: Promise<void>;

	private readonly _onDidChangeState = this._register(new Emitter<IVoltRelayState>());
	readonly onDidChangeState: Event<IVoltRelayState> = this._onDidChangeState.event;
	private readonly _onDidEvent = this._register(new Emitter<IVoltRelayEvent>());
	readonly onDidEvent: Event<IVoltRelayEvent> = this._onDidEvent.event;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.file = join(environmentMainService.userDataPath, 'voltRelay.json');
		this._register(toDisposable(() => {
			this.stop();
			this.localServer?.close();
		}));
		this.ready = this.init();
	}

	private async init(): Promise<void> {
		try {
			this.configFile = JSON.parse(await fs.readFile(this.file, 'utf8'));
		} catch {
			this.configFile = {};
		}
		await this.startLocalServer().catch(err => this.logService.warn('[volt relay] local webhook server did not start', err));
		if (this.configFile.relay) {
			this.start(this.configFile.relay);
		}
	}

	private async saveConfig(next: IConfigFile): Promise<void> {
		this.configFile = next;
		await fs.writeFile(this.file, JSON.stringify(next, null, '\t'), { mode: 0o600 });
	}

	private setState(patch: Partial<IVoltRelayState>, replace = false): void {
		const next: IVoltRelayState = { status: 'off', ...(replace ? {} : this.state), ...patch, ...(this.localBase ? { localWebhookBase: this.localBase } : {}) };
		if (JSON.stringify(next) !== JSON.stringify(this.state)) {
			this.state = next;
			this._onDidChangeState.fire(next);
		}
	}

	async getState(): Promise<IVoltRelayState> {
		await this.ready;
		return this.state;
	}

	//#region Pairing

	async connect(link: string, deviceName?: string): Promise<IVoltRelayState> {
		await this.ready;
		const parsed = parseRelayLink(link);
		if (!parsed) {
			throw new Error('That is not a relay link. Paste what `volt-relay pair` printed, e.g. https://relay.example.com/#pair=ABCD-EFGH.');
		}
		const machineId = this.configFile.machineId ?? `volt-${randomBytes(8).toString('hex')}`;
		const name = (deviceName || defaultDeviceName()).slice(0, 80);
		let token = parsed.token;
		let relayInfo: { relayId?: string; name?: string; publicUrl?: string } | undefined;
		let device: { id?: string; name?: string } | undefined;
		if (!token) {
			if (!parsed.code) {
				throw new Error('The link has no pairing code. On the relay host run `volt-relay pair` and paste the whole link.');
			}
			const response = await fetchJson(`${parsed.url}/api/pair`, { method: 'POST', body: { code: parsed.code, kind: 'client', name, machineId } });
			token = String(response.token);
			relayInfo = response.relay as typeof relayInfo;
			device = response.device as typeof device;
		} else {
			const me = await fetchJson(`${parsed.url}/api/me`, { token });
			relayInfo = me.relay as typeof relayInfo;
			device = me.device as typeof device;
		}
		const relay: IRelayConfig = {
			url: parsed.url,
			token,
			...(relayInfo?.relayId ? { relayId: relayInfo.relayId } : {}),
			...(relayInfo?.name ? { relayName: relayInfo.name } : {}),
			...(device?.id ? { deviceId: device.id } : {}),
			deviceName: device?.name ?? name,
		};
		await this.saveConfig({ ...this.configFile, machineId, relay });
		this.start(relay);
		return this.state;
	}

	async disconnect(): Promise<void> {
		await this.ready;
		this.stop();
		const { relay: _relay, ...rest } = this.configFile;
		await this.saveConfig(rest);
		this.setState({ status: 'off' }, true);
	}

	//#endregion

	//#region Connection

	private start(relay: IRelayConfig): void {
		this.stop();
		const generation = ++this.generation;
		this.lastSeq = 0;
		this.setState({
			status: 'connecting',
			url: relay.url,
			relayId: relay.relayId,
			relayName: relay.relayName,
			deviceId: relay.deviceId,
			deviceName: relay.deviceName,
		}, true);
		void this.streamLoop(relay, generation);
		this.heartbeatTimer = setInterval(() => void this.heartbeat(relay).catch(() => undefined), HEARTBEAT_MS);
		this.heldTimer = setInterval(() => void this.refreshHeld(), HELD_POLL_MS);
		if (platform() === 'darwin') {
			void this.readBattery();
			this.batteryTimer = setInterval(() => void this.readBattery(), 60_000);
		}
	}

	private stop(): void {
		this.generation++;
		this.streamAbort?.abort();
		this.streamAbort = undefined;
		clearInterval(this.heartbeatTimer);
		clearInterval(this.heldTimer);
		clearInterval(this.batteryTimer);
		this.queue.splice(0, this.queue.length, ...this.queue.filter(item => item.source === 'local'));
	}

	private relay(): IRelayConfig {
		const relay = this.configFile.relay;
		if (!relay) {
			throw new Error('Volt is not connected to a relay. Run "Connect to Volt Relay…" first.');
		}
		return relay;
	}

	/** One event stream at a time, resumed from the last event seen; reconnects with backoff. */
	private async streamLoop(relay: IRelayConfig, generation: number): Promise<void> {
		let backoff = 1000;
		while (generation === this.generation) {
			const abort = new AbortController();
			this.streamAbort = abort;
			let idle: ReturnType<typeof setTimeout> | undefined;
			const touch = () => {
				clearTimeout(idle);
				idle = setTimeout(() => abort.abort(), STREAM_IDLE_MS);
			};
			try {
				if (!this.lastSeq) {
					// Start from now: lists are read fresh on every connect (the resync below).
					const poll = await fetchJson(`${relay.url}/api/events/poll?after=${Number.MAX_SAFE_INTEGER}&timeout=0`, { token: relay.token, signal: abort.signal });
					this.lastSeq = Number(poll.seq) || 0;
				}
				touch();
				const response = await fetch(`${relay.url}/api/events?after=${this.lastSeq}`, {
					headers: { authorization: `Bearer ${relay.token}`, accept: 'text/event-stream' },
					signal: abort.signal,
				});
				if (!response.ok || !response.body) {
					const text = await response.text().catch(() => '');
					throw new RelayError(errorText(text, response.status), response.status);
				}
				if (generation !== this.generation) {
					return;
				}
				this.setState({ status: 'online', error: undefined, connectedAt: Date.now() });
				this.logService.info('[volt relay] connected to', relay.url);
				backoff = 1000;
				this._onDidEvent.fire({ seq: this.lastSeq, at: Date.now(), type: 'resync' });
				void this.heartbeat(relay).catch(() => undefined);
				void this.refreshHeld();
				const decoder = new TextDecoder();
				let buffer = '';
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					touch();
					buffer += decoder.decode(chunk, { stream: true });
					let end: number;
					while ((end = buffer.indexOf('\n\n')) >= 0) {
						const block = buffer.slice(0, end);
						buffer = buffer.slice(end + 2);
						this.onStreamBlock(block);
					}
				}
				throw new Error('The relay closed the event stream.');
			} catch (err) {
				if (generation !== this.generation) {
					return;
				}
				const message = err instanceof RelayError && err.status === 401
					? 'The relay no longer accepts this Volt (token revoked). Connect again with a new pairing link.'
					: abort.signal.aborted ? 'The relay stopped answering.' : describeNetworkError(err);
				this.setState({ status: 'offline', error: message });
				this.logService.info('[volt relay] offline:', message);
				if (err instanceof RelayError && err.status === 401) {
					backoff = 60_000;
				}
			} finally {
				clearTimeout(idle);
			}
			await new Promise(resolve => setTimeout(resolve, backoff));
			backoff = Math.min(30_000, backoff * 2);
		}
	}

	private onStreamBlock(block: string): void {
		let data = '';
		for (const line of block.split('\n')) {
			if (line.startsWith('data:')) {
				data += line.slice(5).trimStart();
			}
		}
		if (!data) {
			return;
		}
		let event: IVoltRelayEvent;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof event.seq === 'number') {
			this.lastSeq = Math.max(this.lastSeq, event.seq);
		}
		if (event.type === 'resync') {
			this.lastSeq = event.seq;
			void this.refreshHeld();
		}
		if (event.type === 'delivery' && (event.data as { status?: string } | undefined)?.status === 'held') {
			void this.refreshHeld();
		}
		this._onDidEvent.fire(event);
	}

	private async heartbeat(relay: IRelayConfig): Promise<void> {
		if (this.state.status !== 'online') {
			return;
		}
		await fetchJson(`${relay.url}/api/heartbeat`, {
			method: 'POST',
			token: relay.token,
			body: {
				name: relay.deviceName ?? defaultDeviceName(),
				version: 'volt',
				load: this.sampleLoad(),
				caps: { agents: {}, os: platform(), arch: arch(), labels: ['volt'] },
				running: [],
			},
		});
	}

	/** This machine's load, like a runner reports it, so the picker can show it beside them. */
	private sampleLoad(): Record<string, unknown> {
		let busy = 0;
		let total = 0;
		for (const cpu of cpus()) {
			const { user, nice, sys, idle, irq } = cpu.times;
			busy += user + nice + sys + irq;
			total += user + nice + sys + idle + irq;
		}
		const previous = this.cpuPrevious;
		this.cpuPrevious = { busy, total };
		const cpu = previous && total > previous.total ? (busy - previous.busy) / (total - previous.total) : undefined;
		const [load1, load5] = loadavg();
		let thermal: string | undefined;
		try {
			thermal = powerMonitor.getCurrentThermalState?.();
		} catch {
			thermal = undefined;
		}
		const onBattery = (() => {
			try {
				return powerMonitor.isOnBatteryPower();
			} catch {
				return false;
			}
		})();
		return {
			cpus: cpus().length,
			load1: Math.round(load1 * 100) / 100,
			load5: Math.round(load5 * 100) / 100,
			...(cpu !== undefined ? { cpu: Math.round(Math.max(0, Math.min(1, cpu)) * 1000) / 1000 } : {}),
			memFree: freemem(),
			memTotal: totalmem(),
			running: 0,
			...(this.battery ? { battery: { ...this.battery, charging: this.battery.charging ?? !onBattery } } : onBattery ? { battery: { charging: false } } : {}),
			...(thermal && thermal !== 'unknown' ? { thermal } : {}),
		};
	}

	private readBattery(): Promise<void> {
		return new Promise(resolve => {
			execFile('pmset', ['-g', 'batt'], { timeout: 5000 }, (err, stdout) => {
				const match = !err && /(\d+)%;\s*([\w ]+);/.exec(String(stdout));
				this.battery = match ? { percent: Number(match[1]), charging: !/discharging/i.test(match[2]) } : undefined;
				resolve();
			});
		});
	}

	async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		await this.ready;
		const relay = this.relay();
		return fetchJson(`${relay.url}/api${path.startsWith('/') ? path : `/${path}`}`, { method, token: relay.token, body }) as Promise<T>;
	}

	//#endregion

	//#region Held deliveries

	private isInflight(id: string): boolean {
		const at = this.inflight.get(id);
		return at !== undefined && Date.now() - at < INFLIGHT_MS;
	}

	private wake(): void {
		for (const waiter of [...this.waiters]) {
			waiter();
		}
	}

	/** Reads the relay's held deliveries (oldest first) into the queue. */
	private refreshHeld(): Promise<void> {
		if (this.refreshing || this.state.status !== 'online') {
			return this.refreshing ?? Promise.resolve();
		}
		this.refreshing = (async () => {
			try {
				const { deliveries } = await this.request<{ deliveries: { id: string; seq: number }[] }>('GET', '/deliveries?status=held&limit=500');
				const queued = new Set(this.queue.map(item => item.id));
				for (const delivery of deliveries) {
					if (!queued.has(delivery.id) && !this.isInflight(delivery.id)) {
						this.queue.push({ id: delivery.id, source: 'relay', seq: delivery.seq });
					}
				}
				// Relay deliveries in the order the relay received them; local ones keep their place.
				this.queue.sort((a, b) => a.source === 'relay' && b.source === 'relay' ? a.seq - b.seq : 0);
				if (this.queue.length) {
					this.wake();
				}
			} catch (err) {
				this.logService.info('[volt relay] could not list held deliveries', err instanceof Error ? err.message : err);
			} finally {
				this.refreshing = undefined;
			}
		})();
		return this.refreshing;
	}

	async nextDelivery(waitMs: number): Promise<IVoltHeldDelivery | undefined> {
		await this.ready;
		const deadline = Date.now() + Math.max(0, Math.min(waitMs, 60_000));
		while (true) {
			const item = this.queue.shift();
			if (item) {
				if (this.isInflight(item.id)) {
					continue;
				}
				this.inflight.set(item.id, Date.now());
				if (item.source === 'local') {
					return item.delivery;
				}
				try {
					const claimed = await this.request<Record<string, unknown>>('POST', `/deliveries/${encodeURIComponent(item.id)}/claim`);
					if (claimed.alreadyHandled) {
						this.inflight.delete(item.id);
						continue;
					}
					return heldFromRelay(claimed);
				} catch (err) {
					this.inflight.delete(item.id);
					this.logService.info('[volt relay] could not claim', item.id, err instanceof Error ? err.message : err);
					continue;
				}
			}
			const left = deadline - Date.now();
			if (left <= 0) {
				return undefined;
			}
			await new Promise<void>(resolve => {
				const done = () => {
					clearTimeout(timer);
					this.waiters.delete(done);
					resolve();
				};
				const timer = setTimeout(done, left);
				this.waiters.add(done);
			});
		}
	}

	async ackDelivery(id: string, source: 'relay' | 'local', outcome: IVoltDeliveryOutcome): Promise<void> {
		try {
			if (source === 'relay') {
				await this.request('POST', `/deliveries/${encodeURIComponent(id)}/ack`, outcome);
			}
		} finally {
			this.inflight.delete(id);
		}
	}

	//#endregion

	//#region Direct local webhooks

	async setLocalHooks(hooks: readonly IVoltLocalHook[]): Promise<void> {
		await this.ready;
		this.localHooks.clear();
		for (const hook of hooks) {
			if (hook.token) {
				this.localHooks.set(hook.token, hook);
			}
		}
	}

	private startLocalServer(): Promise<void> {
		const server = http.createServer((req, res) => void this.handleLocal(req, res).catch(err => {
			this.logService.warn('[volt relay] local webhook failed', err);
			if (!res.headersSent) {
				sendJson(res, 500, { error: 'Internal error' });
			}
		}));
		const listen = (port: number) => new Promise<number>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				server.removeListener('error', reject);
				const address = server.address();
				resolve(address && typeof address === 'object' ? address.port : port);
			});
		});
		return listen(VOLT_LOCAL_WEBHOOK_PORT).catch(() => listen(0)).then(port => {
			this.localServer = server;
			this.localBase = `http://127.0.0.1:${port}`;
			this.setState({});
			this.logService.info('[volt relay] local webhooks on', this.localBase);
		});
	}

	private async handleLocal(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://local');
		const parts = url.pathname.split('/').filter(Boolean);
		if (req.method === 'GET' && parts.length === 0) {
			return sendJson(res, 200, { ok: true, service: 'volt-local-webhooks' });
		}
		if (parts[0] !== 'h' || parts.length !== 2) {
			return sendJson(res, 404, { error: 'Not found.' });
		}
		if (!['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) {
			return sendJson(res, 405, { error: 'Webhooks are POST (or PUT/PATCH).' });
		}
		const hook = this.localHooks.get(parts[1]);
		if (!hook) {
			return sendJson(res, 404, { error: 'Unknown hook (or Volt has not loaded its scheduled tasks yet).' });
		}
		const body = await readBody(req, LOCAL_BODY_LIMIT);
		if (!body) {
			return sendJson(res, 413, { error: `Body is larger than ${LOCAL_BODY_LIMIT} bytes.` });
		}
		const headers = req.headers as Record<string, string | string[] | undefined>;
		const first = (name: string) => {
			const value = headers[name];
			return (Array.isArray(value) ? value[0] : value) || undefined;
		};
		const receivedAt = Date.now();
		const check = verifyWebhookSignature(hook.signature, headers, body, receivedAt);
		const event = first('x-github-event') ?? first('x-gitlab-event') ?? first('x-event-type') ?? first('x-volt-event');
		if (!check.ok) {
			this._onDidEvent.fire({ seq: 0, at: receivedAt, type: 'local.rejected', id: hook.hookId, data: { hookId: hook.hookId, reason: check.reason, receivedAt, event } });
			return sendJson(res, 401, { error: check.reason });
		}
		const externalId = first('x-github-delivery') ?? first('x-gitlab-event-uuid') ?? first('idempotency-key') ?? first('x-delivery-id');
		const seenKey = externalId ? `${hook.hookId}:${externalId}` : undefined;
		if (seenKey && this.localSeen.has(seenKey)) {
			return sendJson(res, 200, { id: this.localSeen.get(seenKey), duplicate: true });
		}
		const id = `loc_${generateUuid().replace(/-/g, '').slice(0, 16)}`;
		if (seenKey) {
			this.localSeen.set(seenKey, id);
			if (this.localSeen.size > 500) {
				this.localSeen.delete(this.localSeen.keys().next().value!);
			}
		}
		const kept: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			if (value !== undefined && !/authorization|cookie|token|secret|signature|password|api[-_]?key/i.test(name) && name !== 'host' && name !== 'connection') {
				kept[name] = (Array.isArray(value) ? value.join(', ') : value).slice(0, 2000);
			}
		}
		this.queue.push({
			id,
			source: 'local',
			delivery: {
				id,
				source: 'local',
				hookId: hook.hookId,
				receivedAt,
				...(event ? { event: event.slice(0, 120) } : {}),
				...(externalId ? { externalId: externalId.slice(0, 200) } : {}),
				signature: check.verified ? 'verified' : 'none',
				body: body.toString('utf8'),
				headers: kept,
				query: Object.fromEntries(url.searchParams),
			},
		});
		this.wake();
		return sendJson(res, 202, { id, status: 'held' });
	}

	//#endregion

	//#region Cloud tasks

	async createCloudTask(input: IVoltCloudTaskInput): Promise<{ task: unknown; source: IVoltCloudSourceSummary }> {
		await this.ready;
		const relay = this.relay();
		const prepared = await prepareCloudSource(input.repoRoot, input.sourceMode ?? 'auto');
		try {
			const bundle = prepared.bundleFile ? await this.upload(relay, prepared.bundleFile, 'source-bundle') : undefined;
			const patch = prepared.patchFile ? await this.upload(relay, prepared.patchFile, 'source-patch') : undefined;
			const summary = prepared.summary;
			const task = await this.request('POST', '/tasks', {
				title: input.title,
				prompt: input.prompt,
				agent: input.agent,
				...(input.model ? { model: input.model } : {}),
				source: {
					...(summary.repoUrl ? { repoUrl: summary.repoUrl } : {}),
					baseCommit: summary.baseCommit,
					...(summary.baseBranch ? { baseBranch: summary.baseBranch } : {}),
					...(bundle ? { bundleBlob: bundle } : {}),
					...(patch ? { patchBlob: patch } : {}),
					projectName: input.repoRoot.split(/[\\/]/).filter(Boolean).pop(),
				},
				target: {
					...(input.machineId ? { machineId: input.machineId } : {}),
					...(input.fallbackAfterSec !== undefined ? { fallbackAfterSec: input.fallbackAfterSec } : {}),
					autoPicked: !!input.autoPicked,
				},
				push: !!input.push,
				origin: { repoRoot: input.repoRoot, ...(input.chatId ? { chatId: input.chatId } : {}) },
			});
			return { task, source: summary };
		} finally {
			await prepared.dispose();
		}
	}

	private async upload(relay: IRelayConfig, file: string, kind: string): Promise<string> {
		const { size } = await fs.stat(file);
		const init: RequestInit & { duplex: 'half' } = {
			method: 'PUT',
			headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/octet-stream', 'content-length': String(size) },
			body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit,
			duplex: 'half',
		};
		const response = await fetch(`${relay.url}/api/blobs?kind=${encodeURIComponent(kind)}`, init);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(errorText(text, response.status));
		}
		return String(JSON.parse(text).id);
	}

	async fetchCloudResult(taskId: string, repoRoot: string): Promise<IVoltAppliedCloudResult> {
		await this.ready;
		const relay = this.relay();
		const task = await this.request<{ status: string; result?: { bundleBlob?: string; branch?: string; noChanges?: boolean } }>('GET', `/tasks/${encodeURIComponent(taskId)}`);
		const result = task.result;
		if (!result?.bundleBlob || !result.branch) {
			throw new Error(result?.noChanges ? 'The task made no changes, so there is nothing to apply.' : 'The task has no result to apply yet.');
		}
		const file = join(tmpdir(), `volt-cloud-result-${generateUuid().slice(0, 8)}.bundle`);
		try {
			const response = await fetch(`${relay.url}/api/blobs/${encodeURIComponent(result.bundleBlob)}`, { headers: { authorization: `Bearer ${relay.token}` } });
			if (!response.ok) {
				throw new Error(errorText(await response.text(), response.status));
			}
			await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
			const fetched = await fetchResultBundle(repoRoot, file, result.branch, taskId);
			return { ...fetched, branch: result.branch };
		} finally {
			await fs.rm(file, { force: true });
		}
	}

	async readBlobText(blobId: string, maxBytes: number): Promise<string> {
		await this.ready;
		const relay = this.relay();
		const response = await fetch(`${relay.url}/api/blobs/${encodeURIComponent(blobId)}`, { headers: { authorization: `Bearer ${relay.token}` } });
		if (!response.ok) {
			throw new Error(errorText(await response.text(), response.status));
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		return bytes.subarray(0, Math.max(0, maxBytes)).toString('utf8');
	}

	//#endregion
}

function defaultDeviceName(): string {
	return hostname().replace(/\.local$/i, '') || 'Volt';
}

async function fetchJson(url: string, options: { method?: string; token?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: options.method ?? 'GET',
			headers: {
				...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
				...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
			...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
			signal: options.signal ?? AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw new Error(describeNetworkError(err));
	}
	const text = await response.text();
	if (!response.ok) {
		throw new RelayError(errorText(text, response.status), response.status);
	}
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		throw new Error('The relay answered with something that is not JSON. Is that the relay\'s URL?');
	}
}

function errorText(text: string, status: number): string {
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed.error === 'string') {
			return parsed.error;
		}
	} catch {
		// Not JSON.
	}
	return `The relay answered ${status}.`;
}

function describeNetworkError(err: unknown): string {
	const cause = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
	switch (cause) {
		case 'ECONNREFUSED': return 'Connection refused: is the relay running?';
		case 'ENOTFOUND': return 'The relay\'s host name was not found.';
		case 'ETIMEDOUT':
		case 'UND_ERR_CONNECT_TIMEOUT': return 'The relay did not answer in time.';
	}
	return err instanceof Error ? err.message : String(err);
}

function heldFromRelay(raw: Record<string, unknown>): IVoltHeldDelivery {
	const str = (value: unknown) => typeof value === 'string' && value ? value : undefined;
	const record = (value: unknown) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)])) : {};
	return {
		id: String(raw.id),
		source: 'relay',
		hookId: String(raw.hookId),
		receivedAt: Number(raw.receivedAt) || Date.now(),
		...(str(raw.event) ? { event: str(raw.event) } : {}),
		...(str(raw.externalId) ? { externalId: str(raw.externalId) } : {}),
		...(str(raw.redeliveryOf) ? { redeliveryOf: str(raw.redeliveryOf) } : {}),
		...(raw.signature === 'verified' || raw.signature === 'none' ? { signature: raw.signature } : {}),
		attempts: Number(raw.attempts) || 0,
		body: typeof raw.body === 'string' ? raw.body : '',
		headers: record(raw.headers),
		query: record(raw.query),
	};
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
	res.end(body);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | undefined> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let over = false;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				over = true;
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(over ? undefined : Buffer.concat(chunks)));
		req.on('error', reject);
	});
}
