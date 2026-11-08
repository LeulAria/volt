/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isAbsolute, normalize, sep } from '../../../base/common/path.js';
import { BrokerError, brokerEvaluate, ByteBudget, contextChain, IBroker, IBrokerAudit, IBrokerAuthority, IBrokerCallers } from '../../voltSandbox/common/broker.js';
import { buildEntryGuard } from '../../voltGit/node/buildEntryGuard.js';
import { ICallContext, IPrincipal, isFirstPartySubject } from '../../voltSandbox/common/principals.js';
import { FILES_BROKER_LIMITS, FilesAccess, FilesBrokerPathError, filesPlan, IFilesScope, validateBrokerPath } from '../common/filesBroker.js';
import { ISafeOpenOptions, ISafeOpenRequest, realPathOfNearest, SafeOpenError, safeOpenRead, safeWriteFile } from './safeOpen.js';

/**
 * The files broker (spec I.2, INV-12): handle-based, mediated file I/O for a principal.
 *
 * `open` takes a path and a mode and returns an opaque handle (128 random bits) bound to the
 * caller's principal, the resolved real path and the mode. Every later call names the handle,
 * never a path: the broker re-checks that the handle is the caller's and of the call's mode, asks
 * the Authority again (so a revoked grant stops the next operation, F.9), re-checks the floor and
 * the scope, and does the I/O race-free through `safeOpen.ts` (no symlink anywhere in the path,
 * the floor checked again on the opened file's own path, hard links refused for writes).
 *
 * Reads keep the descriptor the open checked; writes reopen race-free each time, so a folder
 * swapped for a symlink after `open` makes the write fail, never land elsewhere. No descriptor
 * ever leaves the broker (revocable grants are mediated I/O; F.9).
 *
 * Methods: `open {path, mode}` -> `{handle, size?}`; `read {handle, offset?, length?}` -> `{data,
 * eof}`; `write {handle, data}` (the file's whole content); `stat {handle}`; `close {handle}`.
 */

interface IOpenHandle {
	readonly id: string;
	readonly principal: IPrincipal;
	readonly mode: FilesAccess;
	/** The path the caller named (validated). */
	readonly given: string;
	/** Its real path when opened. */
	readonly path: string;
	readonly root: string;
	/** Reads: the descriptor the open checked. */
	file?: fs.FileHandle;
}

export interface IFilesBrokerOptions {
	readonly authority: IBrokerAuthority;
	readonly callers: IBrokerCallers;
	readonly audit: IBrokerAudit;
	/** Core's record of where a principal may reach (never the caller's say); undefined: nowhere. */
	readonly scope: (principal: IPrincipal) => IFilesScope | undefined;
	readonly safeOpen?: ISafeOpenOptions;
	readonly now?: () => number;
	/** Default: {@link FILES_BROKER_LIMITS}. */
	readonly limits?: Partial<typeof FILES_BROKER_LIMITS>;
	/**
	 * The build-entry guard (I.6). A principal that is not first party is a sandboxed writer: before
	 * its first write the execution-bearing files of the folder are recorded, so a build file it
	 * changes (`package.json`, a Makefile) is shown before Volt runs it. Default: the shared guard.
	 */
	readonly guard?: { snapshot(root: string): Promise<void> };
}

const MODES: readonly FilesAccess[] = ['read', 'write'];

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new BrokerError('invalid', 'the arguments must be an object');
	}
	return value as Record<string, unknown>;
}

function handleId(args: Record<string, unknown>): string {
	const id = args.handle;
	if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) {
		throw new BrokerError('handle', 'not a file handle');
	}
	return id;
}

function count(value: unknown, name: string, max: number, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
		throw new BrokerError('invalid', `${name} must be a whole number from 0 to ${max}`);
	}
	return value;
}

function bytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (typeof value === 'string') {
		return Buffer.from(value, 'utf8');
	}
	if (value && typeof value === 'object' && (value as { buffer?: unknown }).buffer instanceof Uint8Array) {
		return (value as { buffer: Uint8Array }).buffer; // VSBuffer over IPC
	}
	throw new BrokerError('invalid', 'data must be bytes or text');
}

function inside(path: string, root: string, fold: boolean): boolean {
	const p = fold ? normalize(path).toLowerCase() : normalize(path);
	const r = fold ? normalize(root).toLowerCase() : normalize(root);
	return r === sep || p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

export class FilesBroker extends Disposable implements IBroker {

	readonly id = 'files';
	private readonly handles = new Map<string, IOpenHandle>();
	private readonly writes: ByteBudget;
	private readonly now: () => number;
	private readonly limits: typeof FILES_BROKER_LIMITS;

	constructor(private readonly options: IFilesBrokerOptions) {
		super();
		this.now = options.now ?? Date.now;
		this.limits = { ...FILES_BROKER_LIMITS, ...options.limits };
		this.writes = new ByteBudget(this.limits.writeBytesPerMinute, 60_000, this.now);
		if (options.callers.onDidRevoke) {
			this._register(options.callers.onDidRevoke(principal => this.revokePrincipal(principal.id)));
		}
		this._register(toDisposable(() => {
			for (const handle of this.handles.values()) {
				void handle.file?.close().catch(() => undefined);
			}
			this.handles.clear();
		}));
	}

	/** Handles `principalId` holds now. */
	openHandles(principalId: string): number {
		let n = 0;
		for (const handle of this.handles.values()) {
			if (handle.principal.id === principalId) {
				n++;
			}
		}
		return n;
	}

	async handle(context: ICallContext, method: string, args: unknown): Promise<unknown> {
		switch (method) {
			case 'open': return this.open(context, args);
			case 'read': return this.read(context, args);
			case 'write': return this.write(context, args);
			case 'stat': return this.stat(context, args);
			case 'close': return this.close(context, args);
		}
		throw new BrokerError('invalid', `the files broker has no method ${String(method)}`);
	}

	async open(context: ICallContext, args: unknown): Promise<{ readonly handle: string; readonly size?: number }> {
		return this.audited(context, 'open', args, async () => {
			this.authenticate(context);
			const input = record(args);
			const mode = input.mode === undefined ? 'read' : input.mode;
			if (!MODES.includes(mode as FilesAccess)) {
				throw new BrokerError('invalid', 'mode must be read or write');
			}
			const scope = this.scopeOf(context.principal);
			let given: string;
			try {
				given = validateBrokerPath(input.path, scope.platform);
			} catch (err) {
				throw new BrokerError('invalid', err instanceof FilesBrokerPathError ? err.message : String(err));
			}
			if (this.openHandles(context.principal.id) >= this.limits.handles) {
				throw new BrokerError('limit', `${this.limits.handles} files are open already: close one first`);
			}
			const path = await realPathOfNearest(given);
			const root = await this.authorize(context, scope, given, path, mode as FilesAccess);
			if (mode === 'write') {
				await this.recordBuildEntries(context, scope, path);
			}
			const id = randomBytes(16).toString('base64url');
			const handle: IOpenHandle = { id, principal: context.principal, mode: mode as FilesAccess, given, path, root };
			let size: number | undefined;
			if (handle.mode === 'read') {
				const opened = await this.safely(() => safeOpenRead(this.request(context, scope, handle), this.options.safeOpen));
				handle.file = opened.handle;
				size = (await opened.handle.stat()).size;
			}
			this.handles.set(id, handle);
			return { handle: id, ...(size !== undefined ? { size } : {}) };
		});
	}

	async read(context: ICallContext, args: unknown): Promise<{ readonly data: Uint8Array; readonly eof: boolean }> {
		return this.withHandle(context, 'read', args, 'read', async (handle, input) => {
			const offset = count(input.offset, 'offset', Number.MAX_SAFE_INTEGER, 0);
			const length = count(input.length, 'length', this.limits.readChunk, this.limits.readChunk);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.file!.read(buffer, 0, length, offset);
			const size = (await handle.file!.stat()).size;
			return { data: buffer.subarray(0, bytesRead), eof: offset + bytesRead >= size };
		});
	}

	async write(context: ICallContext, args: unknown): Promise<{ readonly bytes: number; readonly created: boolean }> {
		return this.withHandle(context, 'write', args, 'write', async (handle, input, scope) => {
			const data = bytes(input.data);
			if (data.byteLength > this.limits.writeChunk) {
				throw new BrokerError('limit', `one write takes at most ${this.limits.writeChunk} bytes`);
			}
			if (!this.writes.take(handle.principal.id, data.byteLength)) {
				throw new BrokerError('limit', `more than ${this.limits.writeBytesPerMinute} bytes were written in the last minute`);
			}
			const result = await this.safely(() => safeWriteFile(this.request(context, scope, handle), data, this.options.safeOpen));
			return { bytes: data.byteLength, created: result.before === undefined };
		});
	}

	async stat(context: ICallContext, args: unknown): Promise<{ readonly size: number; readonly mtime: number }> {
		return this.withHandle(context, 'stat', args, undefined, async handle => {
			if (handle.file) {
				const stat = await handle.file.stat();
				return { size: stat.size, mtime: stat.mtimeMs };
			}
			const stat = await fs.lstat(handle.path).catch(() => undefined);
			if (!stat?.isFile()) {
				throw new BrokerError('io', `${handle.given} is not a file (yet)`);
			}
			return { size: stat.size, mtime: stat.mtimeMs };
		});
	}

	async close(context: ICallContext, args: unknown): Promise<void> {
		return this.audited(context, 'close', args, async () => {
			this.authenticate(context);
			const handle = this.owned(context, handleId(record(args)));
			this.handles.delete(handle.id);
			await handle.file?.close().catch(() => undefined);
		});
	}

	/** Every handle of `principalId` stops working now (its principal was revoked or its grant narrowed to nothing). */
	revokePrincipal(principalId: string): void {
		for (const handle of [...this.handles.values()]) {
			if (handle.principal.id === principalId) {
				this.handles.delete(handle.id);
				void handle.file?.close().catch(() => undefined);
			}
		}
		this.writes.forget(principalId);
	}

	// --- the contract ---------------------------------------------------------------------------

	private authenticate(context: ICallContext): void {
		if (!this.options.callers.verify(context)) {
			throw new BrokerError('unauthenticated', 'the call does not come from a principal this host knows');
		}
	}

	private scopeOf(principal: IPrincipal): IFilesScope {
		const scope = this.options.scope(principal);
		if (!scope) {
			throw new BrokerError('denied', 'this principal has no folders it may reach through the files broker');
		}
		return scope;
	}

	/** The floor and scope on both spellings, then the Authority on the capability (with the chain). Returns the open's root. */
	private async authorize(context: ICallContext, scope: IFilesScope, given: string, path: string, mode: FilesAccess): Promise<string> {
		let capability: string | undefined;
		let target: string | undefined;
		for (const candidate of new Set([given, path])) {
			const plan = filesPlan(context.principal.subject, candidate, mode, scope);
			if (plan.refusal) {
				throw new BrokerError('denied', plan.refusal);
			}
			capability ??= plan.capability;
			target ??= plan.target;
			// The more privileged of the two spellings decides.
			if (plan.capability === 'files.read:home') {
				capability = plan.capability;
				target = plan.target;
			}
		}
		// Callers in the chain are held to their own scope too (a plugin acting for a chat reaches only what the chat may).
		for (const caller of context.onBehalfOf) {
			const theirs = this.options.scope(caller);
			const plan = theirs ? filesPlan(caller.subject, path, mode, theirs) : { refusal: `${caller.subject} has no folders it may reach` };
			if (plan.refusal) {
				throw new BrokerError('denied', `on behalf of ${caller.subject}: ${plan.refusal}`);
			}
		}
		brokerEvaluate(this.options.authority, { capability: capability!, target: target! }, context);
		const fold = scope.platform === 'darwin' || scope.platform === 'win32';
		const roots = [...scope.roots, ...scope.declaredRoots ?? [], ...scope.chat?.extraWritableRoots ?? [], ...(scope.tmpdir ? [scope.tmpdir] : []), '/tmp', '/var/tmp'];
		const real = await Promise.all(roots.filter(root => isAbsolute(root)).map(root => fs.realpath(root).catch(() => undefined)));
		const root = real.filter((candidate): candidate is string => !!candidate && candidate !== path && inside(path, candidate, fold)).sort((a, b) => b.length - a.length)[0];
		if (!root) {
			throw new BrokerError('denied', `${given} is not inside a folder this principal may reach`);
		}
		return root;
	}

	/** Before a writer that is not first party (nor the user) changes a folder: the guard's baseline of it (I.6). */
	private async recordBuildEntries(context: ICallContext, scope: IFilesScope, path: string): Promise<void> {
		const subject = context.principal.subject;
		if (subject === 'user' || isFirstPartySubject(subject)) {
			return;
		}
		const fold = scope.platform === 'darwin' || scope.platform === 'win32';
		const roots = await Promise.all([...scope.roots, ...scope.declaredRoots ?? []].filter(root => isAbsolute(root)).map(root => fs.realpath(root).catch(() => undefined)));
		const guard = this.options.guard ?? buildEntryGuard();
		for (const root of new Set(roots)) {
			if (root && inside(path, root, fold)) {
				try {
					await guard.snapshot(root);
				} catch (err) {
					// Without a baseline its changes could not be shown before they run: the write is refused.
					throw new BrokerError('io', `Volt could not record ${root} before this write: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}

	private request(context: ICallContext, scope: IFilesScope, handle: IOpenHandle): ISafeOpenRequest {
		const subject = context.principal.subject;
		return {
			root: handle.root,
			path: handle.path,
			refuseHardLinks: handle.mode === 'write' && subject !== 'user',
			// The floor once more, on the opened file's own path.
			floor: final => filesPlan(subject, final, handle.mode, scope).refusal,
		};
	}

	private owned(context: ICallContext, id: string): IOpenHandle {
		const handle = this.handles.get(id);
		// Another principal's handle is refused exactly like an unknown one: it says nothing about it.
		if (!handle || handle.principal.id !== context.principal.id) {
			throw new BrokerError('handle', 'not an open file handle of this caller');
		}
		return handle;
	}

	private async withHandle<T>(context: ICallContext, method: string, args: unknown, mode: FilesAccess | undefined, run: (handle: IOpenHandle, input: Record<string, unknown>, scope: IFilesScope) => Promise<T>): Promise<T> {
		return this.audited(context, method, args, async () => {
			this.authenticate(context);
			const input = record(args);
			const handle = this.owned(context, handleId(input));
			if (mode && handle.mode !== mode) {
				throw new BrokerError('handle', `the handle was opened for ${handle.mode}, not ${mode}`);
			}
			// Every operation is decided again (F.9: a revoked or narrowed grant stops the next one).
			const scope = this.scopeOf(context.principal);
			await this.authorize(context, scope, handle.given, handle.path, handle.mode);
			return run(handle, input, scope);
		});
	}

	private async safely<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof SafeOpenError) {
				throw new BrokerError(err.refusal === 'io' || err.refusal === 'missing' || err.refusal === 'not-file' ? 'io' : 'denied', err.message);
			}
			throw err;
		}
	}

	/** Runs one operation and records it, allowed or refused (I.1 #6); anything that is not a broker error is an `io` failure. */
	private async audited<T>(context: ICallContext, method: string, args: unknown, run: () => Promise<T>): Promise<T> {
		const target = this.auditTarget(args);
		const base = { ts: this.now(), broker: this.id, method, principal: context.principal.id, subject: context.principal.subject, chain: contextChain(context), epoch: this.options.authority.epoch, ...(target ? { target } : {}) };
		try {
			const result = await run();
			this.options.audit.record({ ...base, decision: 'allow' });
			return result;
		} catch (err) {
			const error = err instanceof BrokerError ? err : new BrokerError('io', err instanceof Error ? err.message : String(err));
			this.options.audit.record({ ...base, decision: 'deny', code: error.code, ...(error.decision?.deniedBy ? { deniedBy: error.decision.deniedBy } : {}) });
			throw error;
		}
	}

	private auditTarget(args: unknown): string | undefined {
		if (!args || typeof args !== 'object') {
			return undefined;
		}
		const input = args as Record<string, unknown>;
		if (typeof input.path === 'string') {
			return input.path;
		}
		const handle = typeof input.handle === 'string' ? this.handles.get(input.handle) : undefined;
		return handle?.path;
	}
}
