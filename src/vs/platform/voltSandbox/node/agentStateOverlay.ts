/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { basename, dirname, join } from '../../../base/common/path.js';
import { fetchOauthAccount } from '../../voltAccounts/node/claudeLogin.js';
import { credentialFreshness, IAgentStateCredential, IAgentStatePlan, IAgentStateSeed, mergeAgentState, sameCredentialIdentity } from '../common/agentState.js';

/**
 * Creates and merges the per-chat config overlay of a sandboxed agent CLI (see agentState.ts).
 * Runs in Volt's process, outside the sandbox. Everything the sandbox wrote is untrusted input:
 * files are read as JSON and only listed keys or a verified login are written back.
 */

export interface IAgentStateSync {
	readonly applied: readonly string[];
	readonly dropped: readonly string[];
}

export interface IAgentStateOverlayOptions {
	/** The account a Claude Code access token belongs to (`accountUuid`); the real check asks Anthropic. */
	readonly claudeAccount?: (accessToken: string) => Promise<string | undefined>;
	readonly warn?: (message: string) => void;
}

const MAX_STATE_FILE = 8 * 1024 * 1024;
/** Overlays of chats not run for this long are removed (their sessions are recapped on the next turn). */
const OVERLAY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

async function readJson(path: string): Promise<unknown> {
	try {
		const handle = await fs.open(path, 'r');
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_STATE_FILE) {
				return undefined;
			}
			return JSON.parse(await handle.readFile('utf8'));
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	return fs.lstat(path).then(() => true, () => false);
}

/** Temp file and rename beside the target, keeping the target's mode (0600 for a new file). */
async function writeAtomic(path: string, text: string): Promise<void> {
	let mode = 0o600;
	try {
		mode = (await fs.stat(path)).mode & 0o777;
	} catch {
		// New file.
	}
	const temp = join(dirname(path), `.${basename(path)}.volt-${process.pid}-${Date.now().toString(36)}`);
	await fs.writeFile(temp, text, { mode });
	await fs.rename(temp, path);
}

/** This process's holders of each lock, in order: Volt's own merges queue here instead of polling the lock folder. */
const lockQueues = new Map<string, Promise<unknown>>();

/**
 * A `proper-lockfile` compatible lock (the CLI's own writers take `<file>.lock` the same way).
 * Within this process callers take turns; against other processes the lock folder is polled from
 * 2 ms, doubling to 100 ms (a merge holds it for a few milliseconds).
 */
function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
	const lock = `${path}.lock`;
	const previous = lockQueues.get(lock) ?? Promise.resolve();
	const turn = previous.catch(() => undefined).then(() => withLockFolder(path, lock, run));
	const settled = turn.catch(() => undefined);
	lockQueues.set(lock, settled);
	void settled.then(() => {
		if (lockQueues.get(lock) === settled) {
			lockQueues.delete(lock);
		}
	});
	return turn;
}

async function withLockFolder<T>(path: string, lock: string, run: () => Promise<T>): Promise<T> {
	const started = Date.now();
	for (let wait = 2; ; wait = Math.min(wait * 2, 100)) {
		try {
			await fs.mkdir(lock);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw err;
			}
		}
		const stat = await fs.stat(lock).catch(() => undefined);
		if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
			await fs.rmdir(lock).catch(() => undefined);
			continue;
		}
		if (Date.now() - started > LOCK_TIMEOUT_MS) {
			throw new Error(`${path} is locked`);
		}
		await new Promise(resolve => setTimeout(resolve, wait));
	}
	try {
		return await run();
	} finally {
		await fs.rmdir(lock).catch(() => undefined);
	}
}

export class AgentStateOverlay {

	private constructor(
		readonly plan: IAgentStatePlan,
		private readonly options: IAgentStateOverlayOptions,
	) { }

	/**
	 * Makes the overlay ready for a launch: what a previous run left is merged first (a crash may
	 * have skipped it), then the links are set again, the seeds copied in fresh and the logins
	 * brought up to date.
	 */
	static async prepare(plan: IAgentStatePlan, options: IAgentStateOverlayOptions = {}): Promise<AgentStateOverlay> {
		const overlay = new AgentStateOverlay(plan, options);
		for (const dir of [plan.dir, plan.configDir, plan.seedDir, ...(plan.secureDir ? [plan.secureDir] : [])]) {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			await fs.chmod(dir, 0o700).catch(() => undefined);
		}
		await overlay.sync().catch(err => options.warn?.(`[volt-sandbox] agent state merge before launch failed: ${err}`));
		await overlay.syncCredentials().catch(err => options.warn?.(`[volt-sandbox] agent login merge before launch failed: ${err}`));
		await overlay.link();
		for (const seed of plan.seeds) {
			await overlay.seed(seed);
		}
		for (const credential of plan.credentials) {
			await overlay.seedCredential(credential);
		}
		return overlay;
	}

	/** Removes overlays of chats that have not run for a month. */
	static async prune(root: string, now = Date.now()): Promise<void> {
		for (const name of await fs.readdir(root).catch(() => [] as string[])) {
			const path = join(root, name);
			const stat = await fs.lstat(path).catch(() => undefined);
			if (stat?.isDirectory() && now - stat.mtimeMs > OVERLAY_MAX_AGE_MS) {
				await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
			}
		}
	}

	/** The user's config read-only through links; anything the sandbox put under a protected name is removed. */
	private async link(): Promise<void> {
		const links = new Map(this.plan.links.map(link => [link.path, link.target]));
		const reset = async (path: string) => {
			const target = links.get(path);
			const current = await fs.readlink(path).catch(() => undefined);
			if (target && current === target && await exists(target)) {
				return;
			}
			await fs.rm(path, { recursive: true, force: true });
			if (target && await exists(target)) {
				await fs.symlink(target, path);
			}
		};
		const paths = [...new Set(this.plan.protect)];
		// Names are the config folder's own children, set together; one below another is set in order.
		if (paths.some(path => paths.some(other => path.startsWith(`${other}/`)))) {
			for (const path of paths) {
				await reset(path);
			}
		} else {
			await Promise.all(paths.map(reset));
		}
	}

	private async seed(seed: IAgentStateSeed): Promise<void> {
		const real = await readJson(seed.from);
		await fs.rm(seed.path, { recursive: true, force: true });
		if (real === undefined) {
			// No config of the user's yet: the CLI starts one in the overlay.
			await writeAtomic(seed.snapshot, '{}');
			return;
		}
		const text = JSON.stringify(real, undefined, 2);
		await fs.writeFile(seed.path, text, { mode: 0o600 });
		await writeAtomic(seed.snapshot, text);
	}

	/** The newer login wins: the user's, unless this chat refreshed it since. */
	private async seedCredential(credential: IAgentStateCredential): Promise<void> {
		const real = await readJson(credential.real);
		if (real === undefined) {
			return;
		}
		const mine = await readJson(credential.path);
		const realFresh = credentialFreshness(real, credential.freshness) ?? 0;
		const mineFresh = mine === undefined ? -1 : credentialFreshness(mine, credential.freshness) ?? -1;
		if (realFresh >= mineFresh) {
			await fs.rm(credential.path, { recursive: true, force: true });
			await fs.writeFile(credential.path, JSON.stringify(real), { mode: 0o600 });
		}
	}

	/**
	 * Copies the allowed keys each seeded file gained back to the user's file, under its lock, and
	 * returns them with everything else the sandbox changed. The snapshot moves on, so each change
	 * is reported once.
	 */
	async sync(): Promise<IAgentStateSync> {
		const applied: string[] = [];
		const dropped: string[] = [];
		for (const seed of this.plan.seeds) {
			const snapshot = await readJson(seed.snapshot);
			if (snapshot === undefined) {
				continue;
			}
			const after = await readJson(seed.path);
			if (after === undefined && !(await exists(seed.path))) {
				continue;
			}
			// What the sandbox changed and which of it is allowed back depend only on the snapshot and
			// the overlay's file; the user's file is read (under its lock) only when something goes back.
			const changes = mergeAgentState(snapshot, after, {}, seed.mergeBack);
			if (!(await exists(seed.from))) {
				// Never create the user's config from the sandbox: only report.
				dropped.push(...mergeAgentState(snapshot, after, {}, []).dropped);
			} else if (!changes.merged) {
				dropped.push(...changes.dropped);
			} else {
				const result = await withLock(seed.from, async () => {
					const merge = mergeAgentState(snapshot, after, await readJson(seed.from), seed.mergeBack);
					if (merge.merged) {
						await writeAtomic(seed.from, JSON.stringify(merge.merged, undefined, 2));
					}
					return merge;
				});
				applied.push(...result.applied);
				dropped.push(...result.dropped);
			}
			if (after !== undefined && (changes.applied.length || changes.dropped.length)) {
				await writeAtomic(seed.snapshot, JSON.stringify(after));
			}
		}
		return { applied, dropped };
	}

	/**
	 * A login the CLI refreshed in the overlay goes back to the user's file when it is newer and
	 * provably the same account, so the user's own CLI does not hold a refresh token the provider
	 * has already rotated. Anything else (another account, a planted API key) stays in the chat.
	 */
	async syncCredentials(): Promise<readonly string[]> {
		const written: string[] = [];
		for (const credential of this.plan.credentials) {
			const mine = await readJson(credential.path);
			const real = await readJson(credential.real);
			if (mine === undefined || real === undefined || !mine || typeof mine !== 'object' || Array.isArray(mine)) {
				continue;
			}
			const mineFresh = credentialFreshness(mine, credential.freshness);
			const realFresh = credentialFreshness(real, credential.freshness) ?? 0;
			if (mineFresh === undefined || mineFresh <= realFresh) {
				continue;
			}
			if (!await this.sameAccount(credential, mine, real)) {
				this.options.warn?.(`[volt-sandbox] a sandboxed agent's login in ${credential.path} is not the user's account; it was not copied back`);
				continue;
			}
			await writeAtomic(credential.real, JSON.stringify(mine));
			written.push(credential.real);
		}
		return written;
	}

	private async sameAccount(credential: IAgentStateCredential, mine: unknown, real: unknown): Promise<boolean> {
		if (credential.identity !== 'claude') {
			return sameCredentialIdentity(mine, real, credential.identity);
		}
		const token = (mine as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth?.accessToken;
		const config = credential.account ? await readJson(credential.account) : undefined;
		const expected = (config as { oauthAccount?: { accountUuid?: unknown } } | undefined)?.oauthAccount?.accountUuid;
		if (typeof token !== 'string' || typeof expected !== 'string') {
			return false;
		}
		const lookup = this.options.claudeAccount ?? (async (accessToken: string) => {
			const account = await fetchOauthAccount(accessToken);
			return typeof account?.accountUuid === 'string' ? account.accountUuid : undefined;
		});
		return await lookup(token).catch(() => undefined) === expected;
	}
}
