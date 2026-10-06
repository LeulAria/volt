/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { dedupeFolders, editorProfileDirs, folderUriToPath, IEditorProfileDir, parseLegacyStorage, parseRecentlyOpened, RECENTS_STORAGE_KEY } from '../../common/editorRecents.js';
import { VoltEditorImportService } from '../../node/voltEditorImportService.js';

suite('Volt editor import: recents parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('profile folders per platform', () => {
		const mac = editorProfileDirs('darwin', '/Users/me', {});
		assert.deepStrictEqual(mac.slice(0, 2).map(dir => dir.dir), ['/Users/me/Library/Application Support/Code', '/Users/me/Library/Application Support/Cursor']);
		assert.strictEqual(editorProfileDirs('win32', 'C:\\Users\\me', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })[1].dir, 'C:\\Users\\me\\AppData\\Roaming\\Cursor');
		assert.strictEqual(editorProfileDirs('linux', '/home/me', {})[0].dir, '/home/me/.config/Code');
		assert.strictEqual(editorProfileDirs('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg' })[0].dir, '/cfg/Code');
	});

	test('keeps local folders of the recently opened list, in order', () => {
		const raw = JSON.stringify({
			entries: [
				{ folderUri: 'file:///Users/me/a%20b' },
				{ workspace: { id: 'x', configPath: 'file:///w.code-workspace' } },
				{ fileUri: 'file:///Users/me/notes.md' },
				{ folderUri: 'vscode-remote://ssh-remote%2Bbox/home/x' },
				{ folderUri: 'file:///Users/me/c' },
			],
		});
		assert.deepStrictEqual(parseRecentlyOpened(raw), ['file:///Users/me/a%20b', 'file:///Users/me/c']);
		assert.deepStrictEqual(parseRecentlyOpened('garbage'), []);
		assert.deepStrictEqual(parseLegacyStorage(JSON.stringify({ openedPathsList: { workspaces3: ['file:///old'] }, windowsState: { lastActiveWindow: { folder: 'file:///last' }, openedWindows: [{ folder: 'file:///open' }] } })), ['file:///old', 'file:///last', 'file:///open']);
	});

	test('folder URIs to paths, deduped', () => {
		assert.strictEqual(folderUriToPath('file:///Users/me/My%20App/', 'darwin'), '/Users/me/My App');
		assert.strictEqual(folderUriToPath('file:///c%3A/src/app', 'win32'), 'c:\\src\\app');
		assert.strictEqual(folderUriToPath('file://server/share/x', 'win32'), '\\\\server\\share\\x');
		assert.strictEqual(folderUriToPath('untitled:x', 'linux'), undefined);
		assert.deepStrictEqual(dedupeFolders(['/a', '/A', '/b', '/a'], true), ['/a', '/b']);
		assert.deepStrictEqual(dedupeFolders(['/a', '/A'], false), ['/a', '/A']);
		assert.deepStrictEqual(dedupeFolders(['/a', '/b', '/c'], false, 2), ['/a', '/b']);
	});
});

suite('VoltEditorImportService on a real state.vscdb', function () {

	this.timeout(20_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(async () => {
		root = await mkdtemp(join(tmpdir(), 'volt-import-'));
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('reads recent folders read-only, marks missing ones and git repos', async () => {
		const profile = join(root, 'Code');
		const globalStorage = join(profile, 'User', 'globalStorage');
		await mkdir(globalStorage, { recursive: true });
		const repo = join(root, 'repo');
		await mkdir(join(repo, '.git'), { recursive: true });
		const plain = join(root, 'plain folder');
		await mkdir(plain);
		const value = JSON.stringify({ entries: [{ folderUri: `file://${encodeURI(repo)}` }, { folderUri: `file://${encodeURI(plain)}` }, { folderUri: `file://${join(root, 'gone')}` }] });
		const sqlite3 = (await import('@vscode/sqlite3')).default;
		await new Promise<void>((resolve, reject) => {
			const db = new sqlite3.Database(join(globalStorage, 'state.vscdb'), err => {
				if (err) {
					return reject(err);
				}
				db.serialize(() => {
					db.run('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
					db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [RECENTS_STORAGE_KEY, value]);
					db.close(closeErr => closeErr ? reject(closeErr) : resolve());
				});
			});
		});
		class FixtureImport extends VoltEditorImportService {
			protected override profileDirs(): readonly IEditorProfileDir[] {
				return [{ id: 'vscode', label: 'VS Code', dir: profile }, { id: 'cursor', label: 'Cursor', dir: join(root, 'Cursor') }];
			}
		}
		const editors = await new FixtureImport(new NullLogService()).recentFolders();
		assert.strictEqual(editors.length, 1);
		assert.strictEqual(editors[0].id, 'vscode');
		assert.deepStrictEqual(editors[0].folders.map(folder => [folder.name, folder.exists, folder.gitRepo]), [['repo', true, true], ['plain folder', true, false], ['gone', false, false]]);
	});
});
