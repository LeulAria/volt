/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { FSWatcher, promises as fs, watch as fsWatch } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from '../../../base/common/path.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { canonicalJson, emptyGrantStore, grantExpiry, GrantStoreStatus, IGrant, IGrantStoreData, IGrantStoreLoadOptions, IRefusal, loadGrantStore, serializeGrantStore } from '../common/grants.js';
import { SubjectKey } from '../common/principals.js';
import { bareCapability } from '../../voltPlugins/common/capabilityCatalog.js';

/**
 * The grant store (spec F.9, F.11, G.4, G.9): `~/.volt/trust/grants.json`, denied to every sandbox
 * by the credential floor (`.volt/trust`).
 *
 * - Writes are atomic: a temp file (0600) written and fsynced, then renamed over the store.
 * - The epoch only grows. It is also kept in `grants.epoch`, written first, so a store that is lost
 *   or torn still restarts above every epoch it ever had.
 * - Commits are compare-and-swap on the epoch, under a lock file shared with other Volt processes:
 *   two approvals for different hosts both land, in order; approving the same thing twice is
 *   idempotent.
 * - A torn or unparsable store loads empty (third party: no grants; first party: its compiled
 *   ceiling), is kept aside for inspection, and reports `torn` so the Security page can say
 *   "Permissions were reset". Never "allow all".
 * - A store from a newer Volt is read-only, its third-party grants absent. Narrowing still works
 *   there: a revoke (or a subject dropped) is appended to `grants.revoked`, a log every version
 *   reads and applies over the store (one JSON object a line: `{"id"}`, or `{"subject","epoch"}`
 *   for every grant of that subject up to that epoch), so the newer Volt honours it too. Widening
 *   (a grant, a refusal forgotten) stays refused. A log that can't be read revokes everything.
 */

export const DEFAULT_GRANT_STORE_PATH = join(homedir(), '.volt', 'trust', 'grants.json');

/** A grant to add: its epoch is the commit's. */
export type IGrantDraft = Omit<IGrant, 'epoch'>;

export interface IGrantStoreChange {
	readonly add?: readonly IGrantDraft[];
	/** Grant ids to revoke (removed from the store). */
	readonly revoke?: readonly string[];
	/** Grants used: their `lastUsedAt` moves to `at` (G.4's unused expiry counts from it). */
	readonly touch?: readonly { readonly id: string; readonly at: number }[];
	readonly refuse?: readonly IRefusal[];
	/** Refusals to forget (the user allowed it after all, on the Access page). */
	readonly unrefuse?: readonly { readonly subject: SubjectKey; readonly capability: string }[];
	/** Every grant and refusal of these subjects goes (a signer change, G.9; an uninstall). */
	readonly dropSubjects?: readonly SubjectKey[];
	/** Drop every grant that has expired at this time. */
	readonly expireAt?: number;
}

export type GrantCommitResult =
	| { readonly committed: true; readonly epoch: number; readonly changed: boolean }
	| { readonly committed: false; readonly epoch: number };

export interface IGrantStoreChangeEvent {
	readonly epoch: number;
	readonly subjects: readonly SubjectKey[];
	/** Something was revoked or expired: brokers re-evaluate in-flight work (G.5). */
	readonly narrowed: boolean;
}

export interface IGrantStoreOptions extends IGrantStoreLoadOptions {
	/** How long a lock file may stand before it counts as left behind by a crashed process. */
	readonly staleLockMs?: number;
	readonly lockWaitMs?: number;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

export class GrantStore extends Disposable {

	private _data: IGrantStoreData;
	private _status: GrantStoreStatus;
	private _readOnly: boolean;
	private _notes: readonly string[];
	private queue: Promise<unknown> = Promise.resolve();
	private readonly _onDidChange = this._register(new Emitter<IGrantStoreChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	static async open(path = DEFAULT_GRANT_STORE_PATH, options: IGrantStoreOptions = {}): Promise<GrantStore> {
		await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const store = new GrantStore(path, options);
		await store.read(true);
		return store;
	}

	private constructor(readonly path: string, private readonly options: IGrantStoreOptions) {
		super();
		this._data = emptyGrantStore();
		this._status = 'missing';
		this._readOnly = false;
		this._notes = [];
	}

	get data(): IGrantStoreData { return this._data; }
	get epoch(): number { return this._data.epoch; }
	/** How the store last loaded: `torn` means permissions were reset. */
	get status(): GrantStoreStatus { return this._status; }
	get readOnly(): boolean { return this._readOnly; }
	get notes(): readonly string[] { return this._notes; }

	private get epochPath(): string {
		return this.path.replace(/\.json$/, '') + '.epoch';
	}

	/** Revocations every version applies over the store (see the class comment). */
	private get revokedPath(): string {
		return this.path.replace(/\.json$/, '') + '.revoked';
	}

	/** Re-reads the store (another process may have committed). */
	reload(): Promise<void> {
		return this.serial(() => this.read(false));
	}

	/**
	 * Re-reads the store when another Volt process writes it (the main process and the agent server
	 * share it), so a revocation made in one reaches the other's brokers: `onDidChange` fires with
	 * `narrowed` and their routes re-judge open tunnels (G.5).
	 */
	watch(debounceMs = 50): IDisposable {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let watcher: FSWatcher | undefined;
		const names = new Set([basename(this.path), basename(this.revokedPath)]);
		try {
			watcher = fsWatch(dirname(this.path), (_event, file) => {
				if (file && !names.has(file)) {
					return;
				}
				if (timer) {
					clearTimeout(timer);
				}
				timer = setTimeout(() => {
					timer = undefined;
					void this.reload().catch(() => undefined);
				}, debounceMs);
			});
			watcher.on('error', () => undefined);
		} catch {
			// No watcher (a folder that can't be watched): the store is still re-read on every commit.
		}
		return toDisposable(() => {
			if (timer) {
				clearTimeout(timer);
			}
			watcher?.close();
		});
	}

	/**
	 * Compare-and-swap: applies `change` only if the store is still at `expectedEpoch` (re-read from
	 * disk under the lock). The new epoch is one above the old; a change that changes nothing
	 * commits without a new epoch.
	 */
	commit(expectedEpoch: number, change: IGrantStoreChange): Promise<GrantCommitResult> {
		return this.serial(() => this.locked(async () => {
			await this.read(false);
			if (this._readOnly && (change.add?.length || change.refuse?.length || change.unrefuse?.length)) {
				throw new Error('the grant store was written by a newer Volt and is read-only');
			}
			if (this._data.epoch !== expectedEpoch) {
				return { committed: false, epoch: this._data.epoch };
			}
			return this._readOnly ? this.applyNarrowing(change) : this.apply(change);
		}));
	}

	/** Applies `change` on whatever the latest epoch is (CAS, retried): approvals never lose each other. */
	async update(change: IGrantStoreChange): Promise<number> {
		for (let attempt = 0; attempt < 16; attempt++) {
			const result = await this.commit(this._data.epoch, change);
			if (result.committed) {
				return result.epoch;
			}
		}
		throw new Error('the grant store kept changing under this commit');
	}

	private async apply(change: IGrantStoreChange): Promise<GrantCommitResult> {
		const current = this._data;
		const epoch = current.epoch + 1;
		const subjects = new Set<SubjectKey>();
		let narrowed = false;
		const revoke = new Set(change.revoke ?? []);
		const dropped = new Set<SubjectKey>(change.dropSubjects ?? []);
		let grants: IGrant[] = [];
		for (const grant of current.grants) {
			if (revoke.has(grant.id) || dropped.has(grant.subject)) {
				subjects.add(grant.subject);
				narrowed = true;
				continue;
			}
			const expiry = change.expireAt !== undefined ? grantExpiry(grant) : undefined;
			if (expiry !== undefined && expiry <= change.expireAt!) {
				subjects.add(grant.subject);
				narrowed = true;
				continue;
			}
			const touched = change.touch?.find(entry => entry.id === grant.id);
			grants.push(touched && touched.at > grant.lastUsedAt ? { ...grant, lastUsedAt: touched.at } : grant);
		}
		const touchedOnly = !!change.touch?.length && grants.some((grant, i) => grant !== current.grants[i]);
		for (const draft of change.add ?? []) {
			// Approving the same thing twice is one grant.
			const same = grants.find(grant => sameGrant(grant, draft));
			if (same || grants.some(grant => grant.id === draft.id)) {
				continue;
			}
			grants.push({ ...draft, epoch });
			subjects.add(draft.subject);
		}
		let refusals = current.refusals.filter(refusal => {
			const forget = dropped.has(refusal.subject) || !!change.unrefuse?.some(entry => entry.subject === refusal.subject && bareCapability(entry.capability) === bareCapability(refusal.capability));
			if (forget) {
				subjects.add(refusal.subject);
			}
			return !forget;
		});
		for (const refusal of change.refuse ?? []) {
			if (!refusals.some(existing => existing.subject === refusal.subject && existing.capability === refusal.capability)) {
				refusals.push(refusal);
				subjects.add(refusal.subject);
			}
		}
		if (!subjects.size && !touchedOnly) {
			return { committed: true, epoch: current.epoch, changed: false };
		}
		grants = grants.sort((a, b) => a.epoch - b.epoch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		refusals = refusals.sort((a, b) => a.at - b.at);
		const next: IGrantStoreData = { schemaVersion: current.schemaVersion, epoch, grants, refusals };
		await this.write(next);
		// The store now holds no revoked grant: the log's lines are spent.
		await fs.unlink(this.revokedPath).catch(() => undefined);
		this._data = next;
		this._status = 'ok';
		this._onDidChange.fire({ epoch, subjects: [...subjects], narrowed });
		return { committed: true, epoch, changed: true };
	}

	/**
	 * A newer Volt's store (read-only): revokes and dropped subjects go to the revocation log instead
	 * of the store, so they hold here at once and in the newer Volt that reads the log; touches and
	 * expiry (applied when grants are judged) are left to the store's own Volt.
	 */
	private async applyNarrowing(change: IGrantStoreChange): Promise<GrantCommitResult> {
		const current = this._data;
		const revoke = new Set(change.revoke ?? []);
		const dropped = new Set<SubjectKey>(change.dropSubjects ?? []);
		const logged = await this.readRevoked();
		const epoch = current.epoch + 1;
		// Every id and subject, also those this build can't see (a newer store's third-party grants).
		const lines = [
			...[...revoke].filter(id => !logged.ids.has(id)).map(id => ({ id })),
			...[...dropped].map(subject => ({ subject, epoch })),
		];
		if (!lines.length) {
			return { committed: true, epoch: current.epoch, changed: false };
		}
		const gone = current.grants.filter(grant => revoke.has(grant.id) || dropped.has(grant.subject));
		await atomicWrite(this.epochPath, String(epoch));
		const handle = await fs.open(this.revokedPath, 'a', 0o600);
		try {
			// Starts on a new line: a line a crash cut short never swallows this one.
			await handle.writeFile(`\n${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		const grants = current.grants.filter(grant => !gone.includes(grant));
		this._data = { ...current, epoch, grants };
		this._onDidChange.fire({ epoch, subjects: [...new Set([...gone.map(grant => grant.subject), ...dropped])], narrowed: true });
		return { committed: true, epoch, changed: true };
	}

	/**
	 * The revocation log: grant ids, and subjects with the epoch they were dropped at. A torn line is
	 * skipped; a log that is there but can't be read revokes every grant (`all`), as a torn store.
	 */
	private async readRevoked(): Promise<{ readonly ids: ReadonlySet<string>; readonly subjects: ReadonlyMap<SubjectKey, number>; readonly all?: boolean }> {
		const ids = new Set<string>();
		const subjects = new Map<SubjectKey, number>();
		let text = '';
		try {
			text = await fs.readFile(this.revokedPath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				return { ids, subjects, all: true };
			}
		}
		for (const line of text.split('\n')) {
			try {
				const entry = line.trim() ? JSON.parse(line) : undefined;
				if (typeof entry?.id === 'string') {
					ids.add(entry.id);
				} else if (typeof entry?.subject === 'string' && typeof entry.epoch === 'number') {
					subjects.set(entry.subject, Math.max(entry.epoch, subjects.get(entry.subject) ?? 0));
				}
			} catch {
				// A line cut short by a crash: its revoke never returned.
			}
		}
		return { ids, subjects };
	}

	private async read(initial: boolean): Promise<void> {
		const text = await readText(this.path);
		const floor = await this.readEpochFloor();
		const loaded = loadGrantStore(text, this.options);
		let data = loaded.data;
		const revoked = await this.readRevoked();
		if (revoked.all) {
			// As a torn store: no grant (first party keeps its compiled ceiling, which is no grant).
			data = { ...data, grants: [] };
		} else if (revoked.ids.size || revoked.subjects.size) {
			data = { ...data, grants: data.grants.filter(grant => !revoked.ids.has(grant.id) && !(grant.epoch <= (revoked.subjects.get(grant.subject) ?? -Infinity))) };
		}
		if (loaded.status === 'torn' && text !== undefined) {
			// Kept for inspection; the next commit writes a fresh store.
			await fs.rename(this.path, `${this.path}.torn-${Date.now()}`).catch(() => undefined);
		}
		// The epoch never goes back: not after a torn file, not after a lost one, not below what this process saw.
		const reset = loaded.status === 'torn' || (loaded.status === 'missing' && floor > 0);
		const epoch = Math.max(data.epoch, floor + (reset ? 1 : 0), initial ? 0 : this._data.epoch);
		if (epoch !== data.epoch) {
			data = { ...data, epoch };
		}
		const before = this._data;
		this._data = data;
		this._status = loaded.status === 'missing' && floor > 0 ? 'torn' : loaded.status;
		this._readOnly = loaded.readOnly;
		this._notes = loaded.notes;
		// Another process's commit writes the epoch file before the store: a read in between sees the
		// new epoch with the old grants, so a change is also told by the grants themselves.
		const changed = before.epoch !== data.epoch || before.grants.length !== data.grants.length || before.refusals.length !== data.refusals.length
			|| before.grants.some((grant, i) => grant.id !== data.grants[i].id || grant.lastUsedAt !== data.grants[i].lastUsedAt);
		if (!initial && changed) {
			const subjects = new Set<SubjectKey>([...before.grants, ...data.grants].map(grant => grant.subject));
			this._onDidChange.fire({ epoch: data.epoch, subjects: [...subjects], narrowed: before.grants.some(grant => !data.grants.some(other => other.id === grant.id)) });
		}
	}

	private async readEpochFloor(): Promise<number> {
		const text = await readText(this.epochPath);
		const value = text === undefined ? 0 : Number(text.trim());
		return Number.isInteger(value) && value >= 0 ? value : 0;
	}

	private async write(data: IGrantStoreData): Promise<void> {
		// The epoch file first: it is never below the store's epoch.
		await atomicWrite(this.epochPath, String(data.epoch));
		await atomicWrite(this.path, serializeGrantStore(data));
	}

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * Holds `<store>.lock` (O_EXCL) while `task` runs, so another Volt process can't commit in between.
	 * The lock names its owner (`<pid> <token>`): it is stale only when it is old and that process is
	 * gone, so a slow commit keeps it; a stale lock is removed under `<store>.lock.takeover`, so two
	 * waiters can't both take it over; and the owner removes it only while it is still its own.
	 */
	private async locked<T>(task: () => Promise<T>): Promise<T> {
		const lock = `${this.path}.lock`;
		const mine = `${process.pid} ${randomBytes(12).toString('hex')}`;
		const deadline = Date.now() + (this.options.lockWaitMs ?? LOCK_WAIT_MS);
		for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
			try {
				const handle = await fs.open(lock, 'wx', 0o600);
				await handle.writeFile(mine);
				await handle.close();
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw err;
				}
				if (await this.takeOverStale(lock)) {
					continue;
				}
				if (Date.now() > deadline) {
					throw new Error('the grant store is locked by another Volt process');
				}
				await new Promise(resolve => setTimeout(resolve, wait));
			}
		}
		try {
			return await task();
		} finally {
			if ((await readText(lock)) === mine) {
				await fs.unlink(lock).catch(() => undefined);
			}
		}
	}

	/** Removes `lock` when it is stale, holding the takeover lock while it checks; true when it did. */
	private async takeOverStale(lock: string): Promise<boolean> {
		const staleMs = this.options.staleLockMs ?? LOCK_STALE_MS;
		const takeover = `${lock}.takeover`;
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(takeover, 'wx', 0o600);
		} catch {
			// Another waiter is checking; a takeover lock its crashed owner left is cleared after a while.
			const stat = await fs.stat(takeover).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > staleMs * 3) {
				await fs.unlink(takeover).catch(() => undefined);
			}
			return false;
		}
		try {
			await handle.close();
			// Under the takeover lock nobody else removes `lock`, and nobody can create one while it exists.
			const [stat, text] = await Promise.all([fs.stat(lock).catch(() => undefined), readText(lock)]);
			if (!stat || Date.now() - stat.mtimeMs <= staleMs) {
				return false;
			}
			const owner = Number((text ?? '').split(' ')[0]);
			if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && ownerAlive(owner)) {
				return false;
			}
			await fs.unlink(lock).catch(() => undefined);
			return true;
		} finally {
			await fs.unlink(takeover).catch(() => undefined);
		}
	}
}

/** Whether process `pid` exists (EPERM: it does, as another user's). */
function ownerAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Same subject, capability, scope, kind and binding: the second approval adds nothing. */
function sameGrant(a: IGrant, b: IGrantDraft): boolean {
	return a.subject === b.subject && a.capability === b.capability && a.kind === b.kind && a.workspace === b.workspace && a.sessionId === b.sessionId
		&& canonicalJson(a.scope) === canonicalJson(b.scope) && !a.revoked && a.kind !== 'once';
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		// Present but unreadable: torn, never "allow all".
		return '';
	}
}

/** Write a temp file (0600), fsync it, rename it over `path`, fsync the folder. */
export async function atomicWrite(path: string, text: string): Promise<void> {
	const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	const handle = await fs.open(temp, 'wx', 0o600);
	try {
		await handle.writeFile(text, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.rename(temp, path);
	} catch (err) {
		await fs.unlink(temp).catch(() => undefined);
		throw err;
	}
	if (process.platform !== 'win32') {
		const folder = await fs.open(dirname(path), 'r').catch(() => undefined);
		await folder?.sync().catch(() => undefined);
		await folder?.close();
	}
}
