/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * The integrity lock of third-party extensions (spec H.10, P4; GlassWorm's sleeper extensions):
 * at install or update Volt records what it unpacked, file by file, in a store of its own
 * (`~/.volt/trust/extensions.lock.json`, denied to every sandbox by the credential floor), and
 * checks the installed files against it before the extension runs. Files changed on disk after
 * install (by another program, another extension, or the extension itself downloading code into
 * its folder) keep it from starting until the user reinstalls it or trusts the files as they are.
 *
 * An update is held for the user (the install sheet, with the reason) when the publisher's identity
 * changed, its signature got worse, or the new version gains Volt capabilities or `high` code-scan
 * findings: auto-update never applies such a version on its own.
 *
 * Pure: the lock's shape, the comparisons and the hold's reasons. Hashing and the store are in
 * `node/voltExtensionIntegrity.ts`.
 */

export const VOLT_EXTENSION_LOCK_FILE = 'extensions.lock.json';

/** Where the lock came from: what Volt unpacked, or the files as the user trusted them. */
export type VoltLockSource =
	/** An install or update from the gallery Volt is set up with (Open VSX). */
	| 'gallery'
	/** A `.vsix` the user installed. */
	| 'vsix'
	/** Installed before Volt kept a lock: the files as Volt first saw them (trust on first use). */
	| 'baseline'
	/** The user chose "Trust Current Files" after a mismatch. */
	| 'trusted';

export interface IVoltLockedFile {
	/** Hex SHA-256 (of `package.json` without the `__metadata` VS Code writes into it). */
	readonly sha256: string;
	readonly size: number;
	/**
	 * What the file looked like when it was last hashed: a file whose size, modification time and
	 * change time are unchanged is not read again. The change time can't be set back by a program
	 * (unlike the modification time), so a rewritten file is always hashed.
	 */
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

/** Who published it, as the gallery said at install. */
export interface IVoltPublisherFacts {
	/** The namespace in the id (`publisher` in `publisher.name`). */
	readonly publisher: string;
	/** The gallery's publisher id, where it has one. */
	readonly publisherId?: string;
	readonly publisherDisplayName?: string;
	/** The gallery says the publisher (Open VSX namespace) is verified. */
	readonly verified?: boolean;
	/** The signature check's result (`ExtensionSignatureVerificationCode`), when one ran. */
	readonly signature?: string;
}

export interface IVoltExtensionLockEntry extends IVoltPublisherFacts {
	/** `publisher.name`, lower case. */
	readonly id: string;
	readonly version: string;
	readonly source: VoltLockSource;
	/** Hex SHA-256 over every file's path and hash ({@link voltLockRootDigest}'s input). */
	readonly root: string;
	/** Posix paths relative to the extension's folder. */
	readonly files: { readonly [path: string]: IVoltLockedFile };
	readonly recordedAt: number;
	/** What the install-time code scan found `high` (rule and evidence), to compare an update against. */
	readonly highFindings?: readonly string[];
}

export interface IVoltExtensionLock {
	readonly version: 1;
	/** By the extension folder's real path. */
	readonly extensions: { readonly [location: string]: IVoltExtensionLockEntry };
}

/** Files Volt does not lock: what the OS or a language runtime writes beside an extension's files. */
export function isUnlockedPath(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name === '.DS_Store' || name === 'Thumbs.db' || /(?:^|\/)__pycache__\/[^/]+\.pyc$/.test(path);
}

/**
 * `package.json` as it was unpacked: VS Code writes install metadata into it (`__metadata`), which
 * is not the extension's own. Undefined when it is not JSON (it is hashed as it is then).
 */
export function canonicalManifest(text: string): string | undefined {
	try {
		const manifest = JSON.parse(text);
		if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
			delete manifest.__metadata;
		}
		return JSON.stringify(manifest);
	} catch {
		return undefined;
	}
}

/** The text {@link IVoltExtensionLockEntry.root} is the SHA-256 of: sorted `path NUL hash` lines. */
export function voltLockRootDigestInput(files: { readonly [path: string]: Pick<IVoltLockedFile, 'sha256'> }): string {
	return Object.keys(files).sort().map(path => `${path}\0${files[path].sha256}\n`).join('');
}

/** A file on disk as the check sees it (before hashing). */
export interface IVoltDiskFile {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

export interface IVoltLockComparison {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	/** Same path, but its size or times differ from the lock: hash it to know. */
	readonly toHash: readonly string[];
}

/** What changed between the lock and the files on disk, from the file list and stats alone. */
export function compareWithLock(entry: Pick<IVoltExtensionLockEntry, 'files'>, disk: ReadonlyMap<string, IVoltDiskFile>): IVoltLockComparison {
	const added: string[] = [];
	const toHash: string[] = [];
	for (const [path, stat] of disk) {
		const locked = Object.prototype.hasOwnProperty.call(entry.files, path) ? entry.files[path] : undefined;
		if (!locked) {
			added.push(path);
		} else if (locked.size !== stat.size || locked.mtimeMs !== stat.mtimeMs || locked.ctimeMs !== stat.ctimeMs) {
			toHash.push(path);
		}
	}
	const removed = Object.keys(entry.files).filter(path => !disk.has(path));
	return { added: added.sort(), removed: removed.sort(), toHash: toHash.sort() };
}

/** Why an installed extension failed the check, in Volt's words (`out/extension.js was modified`). */
export function describeMismatch(mismatch: { readonly added: readonly string[]; readonly removed: readonly string[]; readonly modified: readonly string[] }): string | undefined {
	const parts: string[] = [];
	const name = (paths: readonly string[], verb: string) => paths.length === 1 ? `${paths[0]} was ${verb}` : `${paths[0]} and ${paths.length - 1} more were ${verb}`;
	if (mismatch.modified.length) {
		parts.push(name(mismatch.modified, 'modified'));
	}
	if (mismatch.added.length) {
		parts.push(name(mismatch.added, 'added'));
	}
	if (mismatch.removed.length) {
		parts.push(name(mismatch.removed, 'removed'));
	}
	return parts.length ? parts.join('; ') : undefined;
}

// --- updates ----------------------------------------------------------------------------------------

/** Why an update waits for the user. */
export type VoltUpdateConcern =
	/** A different gallery publisher id behind the same namespace: an account or namespace changed hands. */
	| { readonly kind: 'publisher-changed'; readonly from: string; readonly to: string }
	/** The namespace was verified when installed and is not now. */
	| { readonly kind: 'publisher-unverified'; readonly publisher: string }
	/** The installed version was signed (verified) and this one is not. */
	| { readonly kind: 'signature-worse'; readonly from: string; readonly to: string }
	/** It declares Volt capabilities the installed version didn't. */
	| { readonly kind: 'capabilities'; readonly added: readonly string[] }
	/** Its code has `high` code-scan findings the installed version's didn't. */
	| { readonly kind: 'code'; readonly added: readonly string[] };

/** A signature check's result, best first: a verified signature, none (or not checked), anything that failed. */
function signatureRank(code: string | undefined): number {
	return code === 'Success' ? 2 : code === undefined || code === 'NotSigned' ? 1 : 0;
}

/**
 * The publisher and signature concerns of an update from `installed` to `next` (H.10, P4). Facts
 * the gallery doesn't give (no publisher id, no verified flag, no signature check) are no concern.
 */
export function voltPublisherConcerns(installed: IVoltPublisherFacts, next: IVoltPublisherFacts): VoltUpdateConcern[] {
	const concerns: VoltUpdateConcern[] = [];
	if (installed.publisher.toLowerCase() !== next.publisher.toLowerCase()) {
		concerns.push({ kind: 'publisher-changed', from: installed.publisher, to: next.publisher });
	} else if (installed.publisherId && next.publisherId && installed.publisherId !== next.publisherId) {
		concerns.push({ kind: 'publisher-changed', from: installed.publisherDisplayName ?? installed.publisherId, to: next.publisherDisplayName ?? next.publisherId });
	}
	if (installed.verified === true && next.verified === false) {
		concerns.push({ kind: 'publisher-unverified', publisher: next.publisher });
	}
	if (installed.signature !== undefined && next.signature !== undefined && signatureRank(next.signature) < signatureRank(installed.signature)) {
		concerns.push({ kind: 'signature-worse', from: installed.signature, to: next.signature });
	}
	return concerns;
}

/** Every Volt capability id a manifest declares (`contributes.voltCapabilities`, required and optional), with its targets. */
export function declaredVoltCapabilities(manifest: { readonly contributes?: unknown }): string[] {
	const declared = (manifest.contributes as { voltCapabilities?: { required?: unknown; optional?: unknown } } | undefined)?.voltCapabilities;
	const entries = [declared?.required, declared?.optional].flatMap(list => Array.isArray(list) ? list : []) as { id?: unknown; targets?: unknown }[];
	return [...new Set(entries.flatMap(entry => {
		if (typeof entry?.id !== 'string') {
			return [];
		}
		const id = entry.id.replace(/@\d+$/, '');
		const targets = Array.isArray(entry.targets) ? entry.targets.filter((target): target is string => typeof target === 'string') : [];
		return targets.length ? targets.map(target => `${id} ${target}`) : [id];
	}))].sort();
}

/** What `next` has that `installed` hasn't (capabilities, findings), sorted. */
export function gained(installed: readonly string[], next: readonly string[]): string[] {
	const before = new Set(installed);
	return [...new Set(next.filter(item => !before.has(item)))].sort();
}

/** An update Volt holds for the user, as the node side reports it to the window. */
export interface IVoltHeldUpdate {
	readonly id: string;
	readonly version: string;
	readonly installedVersion: string;
	readonly publisher: string;
	readonly displayName?: string;
	readonly concerns: readonly VoltUpdateConcern[];
	/** The new version's `high` findings (`ICodeScanFinding`s), for the sheet. */
	readonly findings?: readonly unknown[];
	/** The new version's manifest `contributes`, for the sheet's capability rows. */
	readonly contributes?: unknown;
}

/** The text a held update's error carries across processes: `volt-update-held:<json>`. */
export const VOLT_UPDATE_HELD_PREFIX = 'volt-update-held:';

/** Install option context key: the user approved this held update (`publisher.name@version`). */
export const VOLT_UPDATE_APPROVED_CONTEXT = 'volt.updateApproved';

export function heldUpdateMessage(held: IVoltHeldUpdate): string {
	return `${VOLT_UPDATE_HELD_PREFIX}${JSON.stringify(held)}`;
}

/** The held update in an install error's message, if it is one. */
export function parseHeldUpdate(error: unknown): IVoltHeldUpdate | undefined {
	const text = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
	const at = text?.indexOf(VOLT_UPDATE_HELD_PREFIX) ?? -1;
	if (!text || at < 0) {
		return undefined;
	}
	try {
		const held = JSON.parse(text.slice(at + VOLT_UPDATE_HELD_PREFIX.length));
		return held && typeof held.id === 'string' && typeof held.version === 'string' && Array.isArray(held.concerns) ? held : undefined;
	} catch {
		return undefined;
	}
}

export function approvedUpdateKey(id: string, version: string): string {
	return `${id.toLowerCase()}@${version}`;
}

// --- the service the window asks --------------------------------------------------------------------

/** An installed extension whose files don't match the lock. */
export interface IVoltIntegrityFailure {
	/** The extension folder's path (`fsPath`). */
	readonly location: string;
	readonly id: string;
	readonly version: string;
	/** `out/extension.js was modified`. */
	readonly why: string;
	/** Where its files came from, so the window knows whether it can be reinstalled from the gallery. */
	readonly source: VoltLockSource;
}

export const VOLT_EXTENSION_INTEGRITY_CHANNEL = 'voltExtensionIntegrity';

export const IVoltExtensionIntegrityService = createDecorator<IVoltExtensionIntegrityService>('voltExtensionIntegrityService');

export interface IVoltExtensionIntegrityService {
	readonly _serviceBrand: undefined;
	/** Checks installed third-party extension folders (`fsPath`s) against the lock; an extension with no entry gets one (its first look). */
	verify(locations: readonly string[]): Promise<IVoltIntegrityFailure[]>;
	/** "Trust Current Files": the folder's files as they are now become its lock. */
	trust(location: string): Promise<void>;
}
