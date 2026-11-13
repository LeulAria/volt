/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { constants as fsConstants, promises as fs, realpath as realpathCallback } from 'fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from '../../../base/common/path.js';
import { verifyHelperBinary } from '../../voltHelpers/node/helperIntegrity.js';

/**
 * Race-free file opens for files Volt reads and writes on behalf of a sandboxed principal (B-17,
 * I.2, INV-12). Volt's own process is outside the sandbox, so a check of the path followed by an
 * open of the path lets the workload swap a folder for a symlink in between and redirect the write
 * (`ws/dir` -> `$HOME`, `dir/.zshrc` becomes `~/.zshrc`). Here the open itself refuses symlinks:
 *
 * - macOS: `open(realpath, O_NOFOLLOW_ANY)`: no component of the path may be a symlink (macOS 11+).
 *   The path is the real path of the target, checked before the open, so the file opened is the
 *   file checked. Folders a write needs are created first; a swap there can leave an empty folder
 *   outside, never a byte.
 * - Linux, writes: the `volt-fsd` helper, `openat2(root, rel, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS
 *   | RESOLVE_NO_MAGICLINKS)` (missing folders made with mkdirat on such descriptors), and the I/O on
 *   that descriptor: Node can neither call openat2 nor receive a descriptor over SCM_RIGHTS without
 *   a native addon. Verified before every launch. Reads need no helper: the descriptor's path, read
 *   back from `/proc/self/fd`, must be the path asked for (see {@link safeOpenRead}). A build without
 *   the helper writes only files that already exist, the same way; creating one is refused.
 * - Windows: every component from the root down is refused when it is a reparse point (symlinks
 *   and junctions), then the file is opened and its real path checked again. Not race-free: the
 *   check and the open are separate calls. Compile-checked only.
 *
 * Every open checks `floor` on the final path of the opened file, and refuses a file with more than
 * one link when `refuseHardLinks` is set (a hard link made inside a writable folder to a file
 * outside it).
 */

/** `O_NOFOLLOW_ANY` from `<sys/fcntl.h>` (macOS 11+): fail with ELOOP if any component is a symlink. */
export const O_NOFOLLOW_ANY = 0x20000000;

export type SafeOpenRefusal = 'symlink' | 'outside' | 'hardlink' | 'not-file' | 'floor' | 'missing' | 'unsupported' | 'helper' | 'io' | 'changed';

export class SafeOpenError extends Error {
	constructor(readonly refusal: SafeOpenRefusal, message: string) {
		super(message);
		this.name = 'SafeOpenError';
	}
}

export interface ISafeOpenRequest {
	/** The folder the file must stay inside: an existing real path (no symlinks in it). */
	readonly root: string;
	/** The file, absolute: the real path of what will be opened (its folders resolved), inside `root`. */
	readonly path: string;
	/** Why the final path of the opened file may not be used (credential folders, deny patterns, execution-bearing files), or undefined. */
	readonly floor?: (finalPath: string) => string | undefined;
	/** Refuse a file with more than one link (sandboxed principals). */
	readonly refuseHardLinks?: boolean;
	/**
	 * Writes: why the file's content now (undefined when the write would create it) may not be
	 * replaced, checked on the opened file before a byte is written (an edit made against text that
	 * has changed since), or undefined.
	 */
	readonly precondition?: (before: Buffer | undefined) => string | undefined;
}

export interface ISafeOpenOptions {
	readonly platform?: NodeJS.Platform;
	/** Linux: the `volt-fsd` binary. */
	readonly fsdPath?: string;
}

export interface ISafeReadResult {
	readonly content: Buffer;
	readonly finalPath: string;
}

export interface ISafeWriteResult {
	/** What the file held before; undefined when the write created it. */
	readonly before: Buffer | undefined;
	readonly finalPath: string;
}

/** `path` relative to `root`, as components; throws when it is not strictly inside. */
export function componentsBelow(root: string, path: string): string[] {
	if (!isAbsolute(root) || !isAbsolute(path)) {
		throw new SafeOpenError('outside', `${path} is not an absolute path inside ${root}`);
	}
	const rel = relative(normalize(root), normalize(path));
	if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
		throw new SafeOpenError('outside', `${path} is not inside ${root}`);
	}
	const parts = rel.split(sep);
	if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
		throw new SafeOpenError('outside', `${path} is not a plain path inside ${root}`);
	}
	return parts;
}

/** The real path of `path`, or of its nearest existing folder plus the rest (a file about to be created). */
export async function realPathOfNearest(path: string): Promise<string> {
	const rest: string[] = [];
	let current = normalize(path);
	for (let i = 0; i < 256; i++) {
		try {
			const real = await fs.realpath(current);
			return rest.length ? join(real, ...rest) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				break;
			}
			rest.unshift(basename(current));
			current = parent;
		}
	}
	return normalize(path);
}

function checkFloor(request: ISafeOpenRequest, finalPath: string): void {
	const why = request.floor?.(finalPath);
	if (why) {
		throw new SafeOpenError('floor', why);
	}
}

function checkPrecondition(request: ISafeOpenRequest, before: Buffer | undefined): void {
	const why = request.precondition?.(before);
	if (why) {
		throw new SafeOpenError('changed', why);
	}
}

/**
 * Opens the file for reading without following a symlink anywhere in its path, checks the floor on
 * the opened file's own path, and returns the open handle (the caller closes it).
 *
 * A read has no side effect, so on Linux the open needs no helper: the file is opened (the last
 * component with O_NOFOLLOW) and the descriptor's path, read back from `/proc/self/fd`, must be
 * the path asked for. A folder swapped for a link sends the open elsewhere, and the path says so.
 */
export async function safeOpenRead(request: ISafeOpenRequest, options: ISafeOpenOptions = {}): Promise<{ readonly handle: fs.FileHandle; readonly finalPath: string }> {
	const parts = componentsBelow(request.root, request.path);
	checkFloor(request, request.path);
	let handle: fs.FileHandle;
	let finalPath = request.path;
	switch (options.platform ?? process.platform) {
		case 'darwin':
			// O_NOFOLLOW_ANY: the descriptor's path is the one opened.
			handle = await openNoFollowAny(request.path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
			break;
		case 'linux':
			handle = await fs.open(request.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY).catch(err => { throw asRefusal(err, request.path); });
			try {
				finalPath = await fs.readlink(`/proc/self/fd/${handle.fd}`);
			} catch (err) {
				await handle.close();
				throw new SafeOpenError('unsupported', `cannot read the opened file's path from /proc: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (normalize(finalPath) !== normalize(request.path)) {
				await handle.close();
				throw new SafeOpenError('symlink', `${request.path} opened as ${finalPath}`);
			}
			break;
		case 'win32':
			await refuseReparsePoints(request.root, parts, false);
			handle = await fs.open(request.path, 'r').catch(err => { throw asRefusal(err, request.path); });
			try {
				finalPath = await windowsRecheck(request);
			} catch (err) {
				await handle.close();
				throw err;
			}
			break;
		default:
			throw new SafeOpenError('unsupported', `no race-free open on ${options.platform ?? process.platform}`);
	}
	try {
		if (!(await handle.stat()).isFile()) {
			throw new SafeOpenError('not-file', `${request.path} is not a regular file`);
		}
		checkFloor(request, finalPath);
	} catch (err) {
		await handle.close();
		throw err;
	}
	return { handle, finalPath };
}

/** Reads the file without following a symlink anywhere in its path. */
export async function safeReadFile(request: ISafeOpenRequest, options: ISafeOpenOptions = {}): Promise<ISafeReadResult> {
	const { handle, finalPath } = await safeOpenRead(request, options);
	try {
		return { content: await handle.readFile(), finalPath };
	} finally {
		await handle.close();
	}
}

/** Writes the file (creating it and its missing folders) without following a symlink anywhere in its path. */
export async function safeWriteFile(request: ISafeOpenRequest, content: Uint8Array, options: ISafeOpenOptions = {}): Promise<ISafeWriteResult> {
	const parts = componentsBelow(request.root, request.path);
	checkFloor(request, request.path);
	switch (options.platform ?? process.platform) {
		case 'darwin':
			return macWrite(request, parts, content);
		case 'linux': {
			if (!options.fsdPath) {
				return linuxWriteExisting(request, content);
			}
			const result = await runFsd(request, parts, content, options);
			return { before: result.created ? undefined : result.current, finalPath: result.finalPath };
		}
		case 'win32':
			return windowsWrite(request, parts, content);
		default:
			throw new SafeOpenError('unsupported', `no race-free open on ${options.platform ?? process.platform}`);
	}
}

//#region macOS

async function openNoFollowAny(path: string, flags: number, mode?: number): Promise<fs.FileHandle> {
	try {
		return await fs.open(path, flags | O_NOFOLLOW_ANY, mode);
	} catch (err) {
		throw asRefusal(err, path);
	}
}

function asRefusal(err: unknown, path: string): Error {
	if (err instanceof SafeOpenError) {
		return err;
	}
	const code = (err as NodeJS.ErrnoException | undefined)?.code;
	switch (code) {
		case 'ELOOP':
		case 'ENOTDIR':
			return new SafeOpenError('symlink', `${path} goes through a symbolic link`);
		case 'ENOENT':
			return new SafeOpenError('missing', `${path} does not exist`);
		case 'EISDIR':
			return new SafeOpenError('not-file', `${path} is a folder`);
		default:
			return new SafeOpenError('io', `${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function macWrite(request: ISafeOpenRequest, parts: readonly string[], content: Uint8Array): Promise<ISafeWriteResult> {
	// Missing folders, one at a time, each checked to be a real folder.
	let folder = request.root;
	for (const part of parts.slice(0, -1)) {
		folder = join(folder, part);
		const stat = await fs.lstat(folder).catch(() => undefined);
		if (!stat) {
			await fs.mkdir(folder).catch(err => {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw asRefusal(err, folder);
				}
			});
		} else if (!stat.isDirectory()) {
			throw new SafeOpenError(stat.isSymbolicLink() ? 'symlink' : 'not-file', `${folder} is not a folder`);
		}
	}
	let handle: fs.FileHandle;
	let created = false;
	try {
		handle = await openNoFollowAny(request.path, fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
	} catch (err) {
		if (!(err instanceof SafeOpenError) || err.refusal !== 'missing') {
			throw err;
		}
		handle = await openNoFollowAny(request.path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOCTTY, 0o666);
		created = true;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new SafeOpenError('not-file', `${request.path} is not a regular file`);
		}
		if (request.refuseHardLinks && stat.nlink > 1) {
			throw new SafeOpenError('hardlink', `${request.path} has ${stat.nlink} links; a sandboxed chat does not write a file linked from elsewhere`);
		}
		checkFloor(request, request.path);
		const before = created ? undefined : await handle.readFile();
		checkPrecondition(request, before);
		await handle.truncate(0);
		await writeAllAt(handle, content);
		return { before, finalPath: request.path };
	} finally {
		await handle.close();
	}
}

async function writeAllAt(handle: fs.FileHandle, content: Uint8Array): Promise<void> {
	let done = 0;
	while (done < content.byteLength) {
		const { bytesWritten } = await handle.write(content, done, content.byteLength - done, done);
		done += bytesWritten;
	}
}

//#endregion

//#region Linux

/**
 * Without `volt-fsd` (a build that lacks it), Node alone: only a file that already exists. Opening
 * it (no O_CREAT, no O_TRUNC) changes nothing, so the descriptor's path, read back from
 * `/proc/self/fd`, is checked before a byte is written through it: a folder swapped for a link
 * sends the open elsewhere, and the write is refused. Creating a file has an effect at open time
 * (an empty file through the link), so that needs the helper and is refused here.
 */
async function linuxWriteExisting(request: ISafeOpenRequest, content: Uint8Array): Promise<ISafeWriteResult> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(request.path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
	} catch (err) {
		const refusal = asRefusal(err, request.path);
		if (refusal instanceof SafeOpenError && refusal.refusal === 'missing') {
			throw new SafeOpenError('helper', `${request.path} does not exist, and creating a file safely on Linux needs volt-fsd, which is not part of this build`);
		}
		throw refusal;
	}
	try {
		let finalPath: string;
		try {
			finalPath = await fs.readlink(`/proc/self/fd/${handle.fd}`);
		} catch (err) {
			throw new SafeOpenError('unsupported', `cannot read the opened file's path from /proc: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (normalize(finalPath) !== normalize(request.path)) {
			throw new SafeOpenError('symlink', `${request.path} opened as ${finalPath}`);
		}
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new SafeOpenError('not-file', `${request.path} is not a regular file`);
		}
		if (request.refuseHardLinks && stat.nlink > 1) {
			throw new SafeOpenError('hardlink', `${request.path} has ${stat.nlink} links; a sandboxed chat does not write a file linked from elsewhere`);
		}
		checkFloor(request, finalPath);
		const before = await handle.readFile();
		checkPrecondition(request, before);
		await handle.truncate(0);
		await writeAllAt(handle, content);
		return { before, finalPath };
	} finally {
		await handle.close();
	}
}

//#endregion

//#region Linux (volt-fsd)

interface IFsdHeader {
	readonly ok: boolean;
	readonly path?: string;
	readonly nlink?: number;
	readonly size?: number;
	readonly created?: number;
	readonly error?: SafeOpenRefusal | 'usage';
	readonly message?: string;
}

/** A write through `volt-fsd write` (see build/volt/volt-fsd.c for the protocol). */
async function runFsd(request: ISafeOpenRequest, parts: readonly string[], content: Uint8Array, options: ISafeOpenOptions): Promise<{ current: Buffer; finalPath: string; created: boolean }> {
	const helper = options.fsdPath;
	if (!helper) {
		throw new SafeOpenError('helper', 'volt-fsd, which Volt needs to open files safely on Linux, is not part of this build');
	}
	// Checked immediately before every launch (INV-27).
	const verified = await verifyHelperBinary('volt-fsd', helper);
	if (!verified.ok) {
		throw new SafeOpenError('helper', `volt-fsd was not run: ${verified.reason ?? 'it failed verification'}`);
	}
	// No environment: the helper needs none, and nothing of Volt's may reach it (INV-24).
	const child = spawn(helper, ['write', request.root, parts.join('/')], { stdio: ['pipe', 'pipe', 'ignore'], env: {}, windowsHide: true });
	const chunks: Buffer[] = [];
	let header: IFsdHeader | undefined;
	let headerBytes = 0;
	let closed = false;
	let wake = () => { };
	// The header line, then (when it says ok) the `size` bytes the file holds now.
	const complete = () => {
		if (!header) {
			const all = Buffer.concat(chunks);
			const newline = all.indexOf(0x0a);
			if (newline >= 0) {
				try {
					header = JSON.parse(all.subarray(0, newline).toString('utf8')) as IFsdHeader;
				} catch {
					header = { ok: false, error: 'io', message: 'volt-fsd answered something that is not JSON' };
				}
				headerBytes = newline + 1;
			}
		}
		return closed || (!!header && (!header.ok || Buffer.concat(chunks).length >= headerBytes + (header.size ?? 0)));
	};
	child.stdout.on('data', (chunk: Buffer) => {
		chunks.push(chunk);
		wake();
	});
	child.stdin.on('error', () => { /* the helper exited first; its answer says why */ });
	const exited = new Promise<number | null>(resolve => {
		child.on('close', code => {
			closed = true;
			wake();
			resolve(code);
		});
		child.on('error', () => {
			closed = true;
			wake();
			resolve(null);
		});
	});
	await new Promise<void>(resolve => {
		wake = () => complete() && resolve();
		wake();
	});
	const fail = async (error: SafeOpenError): Promise<never> => {
		child.stdin.end('x');
		await exited;
		throw error;
	};
	if (!header) {
		await exited;
		throw new SafeOpenError('helper', 'volt-fsd ended without an answer');
	}
	if (!header.ok) {
		await exited;
		throw new SafeOpenError(header.error === 'usage' || !header.error ? 'io' : header.error, header.message ?? 'volt-fsd refused the open');
	}
	const all = Buffer.concat(chunks);
	const size = header.size ?? 0;
	const tailStart = headerBytes + size;
	if (all.length < tailStart || typeof header.path !== 'string') {
		return fail(new SafeOpenError('io', 'volt-fsd ended early'));
	}
	const current = all.subarray(headerBytes, headerBytes + size);
	// The descriptor's own path (/proc/self/fd): RESOLVE_NO_SYMLINKS makes it the path asked for.
	const finalPath = header.path;
	if (normalize(finalPath) !== normalize(request.path)) {
		return fail(new SafeOpenError('symlink', `${request.path} opened as ${finalPath}`));
	}
	try {
		checkFloor(request, finalPath);
	} catch (err) {
		return fail(err as SafeOpenError);
	}
	if (request.refuseHardLinks && (header.nlink ?? 1) > 1) {
		return fail(new SafeOpenError('hardlink', `${request.path} has ${header.nlink} links; a sandboxed chat does not write a file linked from elsewhere`));
	}
	try {
		checkPrecondition(request, header.created === 1 ? undefined : current);
	} catch (err) {
		return fail(err as SafeOpenError);
	}
	child.stdin.end(Buffer.concat([Buffer.from('w'), Buffer.from(content)]));
	const code = await exited;
	const tail = Buffer.concat(chunks).subarray(tailStart).toString('utf8').trim();
	let done: IFsdHeader | undefined;
	try {
		done = JSON.parse(tail.split('\n').pop() ?? '') as IFsdHeader;
	} catch {
		done = undefined;
	}
	if (code !== 0 || !done?.ok) {
		throw new SafeOpenError('io', done?.message ?? `volt-fsd exited with ${code}`);
	}
	return { current, finalPath, created: header.created === 1 };
}

//#endregion

//#region Windows

/** Every existing component from the root down, refused when it is a reparse point (symlink or junction). */
async function refuseReparsePoints(root: string, parts: readonly string[], createFolders: boolean): Promise<void> {
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = join(current, parts[i]);
		const stat = await fs.lstat(current).catch(() => undefined);
		if (!stat) {
			if (createFolders && i < parts.length - 1) {
				await fs.mkdir(current);
				continue;
			}
			return;
		}
		// Node reports junctions and symlinks alike as symbolic links.
		if (stat.isSymbolicLink()) {
			throw new SafeOpenError('symlink', `${current} is a reparse point`);
		}
	}
}

async function windowsRecheck(request: ISafeOpenRequest): Promise<string> {
	// GetFinalPathNameByHandle on a fresh open of the path (Node cannot ask it of our handle).
	const real = await new Promise<string>(resolve => realpathCallback.native(request.path, (err, resolved) => resolve(err ? request.path : resolved)));
	if (normalize(real).toLowerCase() !== normalize(request.path).toLowerCase()) {
		throw new SafeOpenError('symlink', `${request.path} opened as ${real}`);
	}
	checkFloor(request, real);
	return real;
}

async function windowsWrite(request: ISafeOpenRequest, parts: readonly string[], content: Uint8Array): Promise<ISafeWriteResult> {
	await refuseReparsePoints(request.root, parts, true);
	let created = false;
	let handle = await fs.open(request.path, 'r+').catch(() => undefined);
	if (!handle) {
		handle = await fs.open(request.path, 'wx').catch(err => { throw asRefusal(err, request.path); });
		created = true;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new SafeOpenError('not-file', `${request.path} is not a regular file`);
		}
		if (request.refuseHardLinks && stat.nlink > 1) {
			throw new SafeOpenError('hardlink', `${request.path} has ${stat.nlink} links; a sandboxed chat does not write a file linked from elsewhere`);
		}
		const finalPath = await windowsRecheck(request);
		const before = created ? undefined : await handle.readFile();
		checkPrecondition(request, before);
		await handle.truncate(0);
		await writeAllAt(handle, content);
		return { before, finalPath };
	} finally {
		await handle.close();
	}
}

//#endregion
