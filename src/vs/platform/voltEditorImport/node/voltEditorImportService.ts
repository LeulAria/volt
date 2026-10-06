/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Database } from '@vscode/sqlite3';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, join } from '../../../base/common/path.js';
import { isLinux, isMacintosh, isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import { dedupeFolders, editorProfileDirs, folderUriToPath, IEditorProfileDir, parseLegacyStorage, parseRecentlyOpened, RECENTS_STORAGE_KEY } from '../common/editorRecents.js';
import { IVoltEditorImportService, IVoltImportedEditor, IVoltImportedFolder } from '../common/voltEditorImport.js';

const READ_TIMEOUT_MS = 4000;

function platformId(): 'darwin' | 'win32' | 'linux' {
	return isWindows ? 'win32' : isMacintosh ? 'darwin' : 'linux';
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(fallback), ms);
		promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
	});
}

export class VoltEditorImportService implements IVoltEditorImportService {

	declare readonly _serviceBrand: undefined;

	constructor(@ILogService private readonly logService: ILogService) { }

	/** The editors' data folders; tests point this at fixtures. */
	protected profileDirs(): readonly IEditorProfileDir[] {
		return editorProfileDirs(platformId(), homedir(), { APPDATA: process.env['APPDATA'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] });
	}

	async recentFolders(): Promise<readonly IVoltImportedEditor[]> {
		const editors = await Promise.all(this.profileDirs().map(async (profile): Promise<IVoltImportedEditor | undefined> => {
			if (!await exists(profile.dir)) {
				return undefined;
			}
			const uris = await withTimeout(this.readRecents(profile), READ_TIMEOUT_MS, []);
			const platform = platformId();
			const paths = dedupeFolders(uris.map(uri => folderUriToPath(uri, platform)).filter((path): path is string => !!path), !isLinux);
			const folders = await Promise.all(paths.map(async (path): Promise<IVoltImportedFolder> => {
				const [present, git] = await Promise.all([exists(path), exists(join(path, '.git'))]);
				return { path, name: basename(path) || path, exists: present, gitRepo: git };
			}));
			return folders.length ? { id: profile.id, label: profile.label, folders } : undefined;
		}));
		return editors.filter((editor): editor is IVoltImportedEditor => !!editor);
	}

	private async readRecents(profile: IEditorProfileDir): Promise<string[]> {
		const globalStorage = join(profile.dir, 'User', 'globalStorage');
		const fromDb = parseRecentlyOpened(await this.readStateKey(join(globalStorage, 'state.vscdb'), RECENTS_STORAGE_KEY));
		const legacy = parseLegacyStorage(await fs.readFile(join(globalStorage, 'storage.json'), 'utf8').catch(() => undefined));
		return [...fromDb, ...legacy];
	}

	/** One key from an editor's global state database, opened read-only (the editor may be running). */
	private async readStateKey(dbPath: string, key: string): Promise<string | undefined> {
		if (!await exists(dbPath)) {
			return undefined;
		}
		const sqlite3 = (await import('@vscode/sqlite3')).default;
		return new Promise<string | undefined>(resolve => {
			let db: Database | undefined;
			const finish = (value: string | undefined) => {
				if (db) {
					db.close(() => resolve(value));
				} else {
					resolve(value);
				}
			};
			db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => {
				if (err) {
					this.logService.trace(`[volt-import] cannot open ${dbPath}: ${err.message}`);
					db = undefined;
					resolve(undefined);
					return;
				}
				db!.get('SELECT value FROM ItemTable WHERE key = ?', [key], (queryErr: Error | null, row: { value?: unknown } | undefined) => {
					if (queryErr || !row) {
						finish(undefined);
						return;
					}
					const value = row.value;
					finish(typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : undefined);
				});
			});
		});
	}
}
