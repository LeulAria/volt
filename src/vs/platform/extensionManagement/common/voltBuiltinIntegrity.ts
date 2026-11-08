/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeHex, VSBuffer } from '../../../base/common/buffer.js';
import { getErrorMessage } from '../../../base/common/errors.js';
import { basename, joinPath, relativePath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';

/**
 * H.10 #6: built-ins ship with the app and are checked at load against `builtin-manifest.json`, which
 * build/volt/release/builtinManifest.mjs writes next to product.json at build time (file hashes of every
 * `extensions/volt-*` folder, plus helper binaries). product.json carries the manifest's own hash
 * (`voltBuiltinManifestSha256`), so deleting or rewriting the manifest is caught too.
 *
 * Dev builds (running from sources) skip the check and log it. A build without a manifest and without the
 * product.json hash (made before the manifest existed) also skips it, with a warning.
 */

export const VOLT_BUILTIN_MANIFEST_FILE = 'builtin-manifest.json';

/** Built-in extension folders the manifest covers. */
export function isVoltBuiltinExtensionFolder(name: string): boolean {
	return name.startsWith('volt-');
}

export interface IVoltBuiltinManifest {
	readonly version: 1;
	readonly algorithm: 'sha256';
	/** Folder name (`volt-browser`) to file path inside it (posix, `package.json`) to hex SHA-256. */
	readonly extensions: { readonly [folder: string]: { readonly [file: string]: string } };
	/** Helper binaries: path relative to the app root to hex SHA-256 (see checkHelper). */
	readonly helpers?: { readonly [file: string]: string };
}

export interface IVoltBuiltinIntegrityOptions {
	/** The app root (`resources/app`): the manifest lives here, built-in extensions in `extensions/`. */
	readonly appRoot: URI;
	readonly isBuilt: boolean;
	/** product.json `voltBuiltinManifestSha256`. */
	readonly manifestSha256: string | undefined;
}

type ManifestState =
	| { readonly kind: 'skip'; readonly why: string }
	| { readonly kind: 'broken'; readonly why: string }
	| { readonly kind: 'ok'; readonly manifest: IVoltBuiltinManifest };

export async function sha256Hex(bytes: VSBuffer): Promise<string> {
	return encodeHex(VSBuffer.wrap(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as Uint8Array<ArrayBuffer>))));
}

export class VoltBuiltinIntegrity {

	private manifest: Promise<ManifestState> | undefined;
	private loggedSkip = false;

	constructor(
		private readonly options: IVoltBuiltinIntegrityOptions,
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) { }

	private load(): Promise<ManifestState> {
		if (!this.manifest) {
			this.manifest = this.doLoad();
		}
		return this.manifest;
	}

	private async doLoad(): Promise<ManifestState> {
		if (!this.options.isBuilt) {
			return { kind: 'skip', why: 'running from sources' };
		}
		const location = joinPath(this.options.appRoot, VOLT_BUILTIN_MANIFEST_FILE);
		let content: VSBuffer;
		try {
			content = (await this.fileService.readFile(location)).value;
		} catch (error) {
			return this.options.manifestSha256
				? { kind: 'broken', why: `${VOLT_BUILTIN_MANIFEST_FILE} is missing (${getErrorMessage(error)})` }
				: { kind: 'skip', why: `this build has no ${VOLT_BUILTIN_MANIFEST_FILE}` };
		}
		if (this.options.manifestSha256 && await sha256Hex(content) !== this.options.manifestSha256.toLowerCase()) {
			return { kind: 'broken', why: `${VOLT_BUILTIN_MANIFEST_FILE} does not match the hash in product.json` };
		}
		try {
			const manifest: IVoltBuiltinManifest = JSON.parse(content.toString());
			if (manifest?.version !== 1 || manifest.algorithm !== 'sha256' || !manifest.extensions || typeof manifest.extensions !== 'object') {
				return { kind: 'broken', why: `${VOLT_BUILTIN_MANIFEST_FILE} has an unknown format` };
			}
			return { kind: 'ok', manifest };
		} catch (error) {
			return { kind: 'broken', why: `${VOLT_BUILTIN_MANIFEST_FILE} is not valid JSON` };
		}
	}

	private logSkip(why: string): void {
		if (!this.loggedSkip) {
			this.loggedSkip = true;
			const message = `Built-in integrity check skipped: ${why}`;
			if (this.options.isBuilt) {
				this.logService.warn(message);
			} else {
				this.logService.info(message);
			}
		}
	}

	/** Every file under `folder`, as posix paths relative to it. */
	private async listFiles(folder: URI): Promise<string[]> {
		const files: string[] = [];
		const walk = async (dir: URI) => {
			const stat = await this.fileService.resolve(dir);
			for (const child of stat.children ?? []) {
				if (child.isDirectory) {
					await walk(child.resource);
				} else {
					files.push(relativePath(folder, child.resource) ?? basename(child.resource));
				}
			}
		};
		await walk(folder);
		return files.sort();
	}

	private async checkFolder(folder: URI, expected: { readonly [file: string]: string }): Promise<string | undefined> {
		const actual = await this.listFiles(folder);
		const wanted = Object.keys(expected).sort();
		const added = actual.filter(file => !Object.prototype.hasOwnProperty.call(expected, file));
		if (added.length) {
			return `${added[0]} was added`;
		}
		const removed = wanted.filter(file => !actual.includes(file));
		if (removed.length) {
			return `${removed[0]} was removed`;
		}
		for (const file of actual) {
			const hash = await sha256Hex((await this.fileService.readFile(joinPath(folder, file))).value);
			if (hash !== expected[file]) {
				return `${file} was modified`;
			}
		}
		return undefined;
	}

	/**
	 * Checks built-in extension folders. Returns why each failing `volt-*` folder fails, keyed by its
	 * location; an empty map when all pass or the check is skipped.
	 */
	async checkExtensions(locations: readonly URI[]): Promise<Map<string, string>> {
		const failures = new Map<string, string>();
		const volt = locations.filter(location => isVoltBuiltinExtensionFolder(basename(location)));
		if (!volt.length) {
			return failures;
		}
		const state = await this.load();
		if (state.kind === 'skip') {
			this.logSkip(state.why);
			return failures;
		}
		await Promise.all(volt.map(async location => {
			const name = basename(location);
			let why: string | undefined;
			if (state.kind === 'broken') {
				why = state.why;
			} else if (!Object.prototype.hasOwnProperty.call(state.manifest.extensions, name)) {
				why = `${name} is not in ${VOLT_BUILTIN_MANIFEST_FILE}`;
			} else {
				try {
					why = await this.checkFolder(location, state.manifest.extensions[name]);
				} catch (error) {
					why = `could not be read (${getErrorMessage(error)})`;
				}
			}
			if (why) {
				failures.set(location.toString(), why);
				this.logService.error(`Built-in extension ${name} failed its integrity check and is not loaded: ${why}`);
			}
		}));
		return failures;
	}

	/**
	 * Hook for helper binaries (P0-4): checks a file the manifest lists under `helpers` by its path
	 * relative to the app root. Resolves undefined when it matches or the check is skipped, else why not.
	 */
	async checkHelper(relativeToAppRoot: string): Promise<string | undefined> {
		const state = await this.load();
		if (state.kind === 'skip') {
			this.logSkip(state.why);
			return undefined;
		}
		if (state.kind === 'broken') {
			return state.why;
		}
		const expected = state.manifest.helpers?.[relativeToAppRoot];
		if (!expected) {
			return `${relativeToAppRoot} is not in ${VOLT_BUILTIN_MANIFEST_FILE}`;
		}
		try {
			const hash = await sha256Hex((await this.fileService.readFile(joinPath(this.options.appRoot, relativeToAppRoot))).value);
			return hash === expected ? undefined : `${relativeToAppRoot} was modified`;
		} catch (error) {
			return `${relativeToAppRoot} could not be read (${getErrorMessage(error)})`;
		}
	}
}
