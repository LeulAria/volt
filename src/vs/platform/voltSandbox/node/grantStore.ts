/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from '../../../base/common/path.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { canonicalJson, emptyGrantStore, grantExpiry, GrantStoreStatus, IGrant, IGrantStoreData, IGrantStoreLoadOptions, IRefusal, loadGrantStore, serializeGrantStore } from '../common/grants.js';
import { SubjectKey } from '../common/principals.js';

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
 * - A store from a newer Volt is read-only, its third-party grants absent.
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

	/** Re-reads the store (another process may have committed). */
	reload(): Promise<void> {
		return this.serial(() => this.read(false));
	}

	/**
	 * Compare-and-swap: applies `change` only if the store is still at `expectedEpoch` (re-read from
	 * disk under the lock). The new epoch is one above the old; a change that changes nothing
	 * commits without a new epoch.
	 */
	commit(expectedEpoch: number, change: IGrantStoreChange): Promise<GrantCommitResult> {
		return this.serial(() => this.locked(async () => {
			await this.read(false);
			if (this._readOnly) {
				throw new Error('the grant store was written by a newer Volt and is read-only');
			}
			if (this._data.epoch !== expectedEpoch) {
				return { committed: false, epoch: this._data.epoch };
			}
			return this.apply(change);
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
		let grants: IGrant[] = [];
		for (const grant of current.grants) {
			if (revoke.has(grant.id)) {
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
		let refusals = [...current.refusals];
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
		this._data = next;
		this._status = 'ok';
		this._onDidChange.fire({ epoch, subjects: [...subjects], narrowed });
		return { committed: true, epoch, changed: true };
	}

	private async read(initial: boolean): Promise<void> {
		const text = await readText(this.path);
		const floor = await this.readEpochFloor();
		const loaded = loadGrantStore(text, this.options);
		let data = loaded.data;
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
		if (!initial && before.epoch !== data.epoch) {
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

	/** Holds `<store>.lock` (O_EXCL) while `task` runs, so another Volt process can't commit in between. */
	private async locked<T>(task: () => Promise<T>): Promise<T> {
		const lock = `${this.path}.lock`;
		const deadline = Date.now() + (this.options.lockWaitMs ?? LOCK_WAIT_MS);
		for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
			try {
				const handle = await fs.open(lock, 'wx', 0o600);
				await handle.writeFile(String(process.pid));
				await handle.close();
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw err;
				}
				const stat = await fs.stat(lock).catch(() => undefined);
				if (stat && Date.now() - stat.mtimeMs > (this.options.staleLockMs ?? LOCK_STALE_MS)) {
					await fs.unlink(lock).catch(() => undefined);
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
			await fs.unlink(lock).catch(() => undefined);
		}
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
