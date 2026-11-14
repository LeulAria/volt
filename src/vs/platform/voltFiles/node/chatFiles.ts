/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, normalize, sep } from '../../../base/common/path.js';
import { chatSubject } from '../../voltSandbox/common/principals.js';
import type { IVoltChatFileRequest, IVoltChatFileResult } from '../../voltStdio/common/voltStdio.js';
import { FilesAccess, filesPlan, IFilesScope } from '../common/filesBroker.js';
import { ISafeOpenOptions, ISafeOpenRequest, realPathOfNearest, SafeOpenError, safeOpenRead, safeWriteFile } from './safeOpen.js';

/**
 * Files Volt reads, writes and deletes for a sandboxed chat's own tools (a native model's file
 * tools, browser_run's edits), after the host-tool gate allowed them (SEC3-3, limitation 13).
 * The gate checks a path and Volt opens it later, so a workload that swaps a folder for a symlink in
 * between would redirect the open. Here the chat's path rule (the files broker's `filesPlan` for the
 * chat, which the gate applies too) is judged again on the given and the real path, and the open
 * itself refuses a symlink anywhere in the path (`safeOpen.ts`); the final path of the opened file
 * is judged once more. Writes refuse files with more than one link.
 */

export interface IChatFileOptions extends ISafeOpenOptions {
	readonly home?: string;
	readonly tmpdir?: string;
}

function fold(platform: string): (s: string) => string {
	return platform === 'darwin' || platform === 'win32' ? s => s.toLowerCase() : s => s;
}

function strictlyInside(path: string, root: string, platform: string): boolean {
	const f = fold(platform);
	const p = f(normalize(path));
	const r = f(normalize(root));
	return p !== r && p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** Runs one operation; a refusal or failure is `ok: false` with the reason, never a throw. */
export async function chatFileOp(request: IVoltChatFileRequest, options: IChatFileOptions = {}): Promise<IVoltChatFileResult> {
	try {
		return await run(request, options);
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err), ...(err instanceof SafeOpenError ? { refusal: err.refusal } : {}) };
	}
}

async function run(request: IVoltChatFileRequest, options: IChatFileOptions): Promise<IVoltChatFileResult> {
	const platform = options.platform ?? process.platform;
	if (typeof request.path !== 'string' || !isAbsolute(request.path) || request.path.includes('\0')) {
		throw new SafeOpenError('outside', `${String(request.path)} is not an absolute path`);
	}
	if (!request.sandbox || request.sandbox.level === 'off' || typeof request.chatId !== 'string' || !request.chatId) {
		// Only a sandboxed chat's files come here; anything else is a caller error, refused.
		throw new SafeOpenError('floor', 'Volt does not know which sandboxed chat this file is for');
	}
	const access: FilesAccess = request.op === 'read' ? 'read' : 'write';
	const given = normalize(request.path);
	const real = await realPathOfNearest(given);
	const named = (request.roots ?? []).filter(root => typeof root === 'string' && isAbsolute(root));
	const realRoots = await Promise.all(named.map(root => fs.realpath(root).catch(() => undefined)));
	const home = options.home ?? homedir();
	const temp = options.tmpdir ?? process.env['TMPDIR'] ?? tmpdir();
	const scope: IFilesScope = {
		roots: [...new Set([...named, ...realRoots.filter((root): root is string => !!root)])],
		home,
		tmpdir: temp,
		platform,
		chat: request.sandbox,
	};
	const subject = chatSubject(request.chatId);
	const verb = access === 'read' ? 'read' : 'written';
	const rule = (path: string) => filesPlan(subject, path, access, scope).refusal;
	// Both spellings must pass: the gate judged the real path, and the agent named the given one.
	const refusal = rule(given) ?? (real !== given ? rule(real) : undefined);
	if (refusal) {
		throw new SafeOpenError('floor', `${given} is not ${verb} for this sandboxed chat: ${refusal}`);
	}
	// The open's root: the deepest folder the rule allows that holds the file, as a real path (no symlink in it).
	const candidates = [...scope.roots, ...(request.sandbox.extraWritableRoots ?? []), '/tmp', '/var/tmp', temp];
	const roots = await Promise.all(candidates.map(root => isAbsolute(root) ? fs.realpath(root).catch(() => undefined) : Promise.resolve(undefined)));
	const root = roots.filter((candidate): candidate is string => !!candidate && strictlyInside(real, candidate, platform)).sort((a, b) => b.length - a.length)[0];
	if (!root) {
		throw new SafeOpenError('outside', `${given} is outside this chat's folders`);
	}
	const open: ISafeOpenRequest = { root, path: real, floor: final => rule(final), refuseHardLinks: access === 'write' };
	switch (request.op) {
		case 'read':
			return read(open, given, request, options);
		case 'write':
			return write(open, given, request, options);
		case 'delete':
			return remove(given, real);
		default:
			throw new SafeOpenError('io', `unknown file operation ${String(request.op)}`);
	}
}

async function read(open: ISafeOpenRequest, given: string, request: IVoltChatFileRequest, options: ISafeOpenOptions): Promise<IVoltChatFileResult> {
	const { handle, finalPath } = await safeOpenRead(open, options);
	try {
		const size = (await handle.stat()).size;
		if (request.maxBytes !== undefined && size > request.maxBytes) {
			throw new SafeOpenError('io', `${given} is ${size} bytes, more than the ${request.maxBytes} this tool reads`);
		}
		const content = await handle.readFile();
		return { ok: true, path: finalPath, content: content.toString(request.encoding === 'base64' ? 'base64' : 'utf8') };
	} finally {
		await handle.close();
	}
}

async function write(open: ISafeOpenRequest, given: string, request: IVoltChatFileRequest, options: ISafeOpenOptions): Promise<IVoltChatFileResult> {
	const expected = request.expected;
	const precondition = expected === undefined ? undefined : (before: Buffer | undefined) => before !== undefined && before.toString('utf8') === expected ? undefined : `${given} changed since it was read; nothing was written`;
	const written = await safeWriteFile({ ...open, ...(precondition ? { precondition } : {}) }, Buffer.from(request.content ?? '', 'utf8'), options);
	return { ok: true, path: written.finalPath, existed: written.before !== undefined };
}

/**
 * One file, by its real path (the path the rule judged), never a symlink itself: its folder must
 * still be its own real path just before the unlink. Node has no `unlinkat`, so that last check and
 * the unlink are two calls (see 05-limitations.md item 13).
 */
async function remove(given: string, real: string): Promise<IVoltChatFileResult> {
	const named = await fs.lstat(given).catch(() => undefined);
	if (!named) {
		return { ok: true, path: given, existed: false };
	}
	if (named.isSymbolicLink()) {
		throw new SafeOpenError('symlink', `${given} is a symbolic link, which a sandboxed chat's tools do not delete through`);
	}
	const stat = await fs.lstat(real).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new SafeOpenError('not-file', `${given} is not a file`);
	}
	if (stat.nlink > 1) {
		throw new SafeOpenError('hardlink', `${given} has ${stat.nlink} links; a sandboxed chat does not delete a file linked from elsewhere`);
	}
	const parent = dirname(real);
	if (await fs.realpath(parent).catch(() => undefined) !== parent) {
		throw new SafeOpenError('symlink', `${given} changed while it was deleted`);
	}
	await fs.unlink(real);
	return { ok: true, path: real, existed: true };
}
