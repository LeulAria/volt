/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// SUP-8: the integrity lock of third-party extensions (H.10): what was unpacked is recorded in
// ~/.volt/trust and checked before the extension runs; files changed on disk after install keep it
// from starting until the user reinstalls or trusts them.

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { extensionLockPath, scanHighFindings, VoltExtensionIntegrity } from '../../node/voltExtensionIntegrity.js';

suite('Volt extension integrity lock (SUP-8)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let lockPath: string;

	setup(async () => {
		root = await fs.promises.mkdtemp(join(tmpdir(), 'volt-sup8-'));
		lockPath = extensionLockPath(join(root, 'home'));
	});

	teardown(async () => {
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	async function extension(name: string, files: Record<string, string>): Promise<string> {
		const folder = join(root, 'extensions', name);
		for (const [path, text] of Object.entries({ 'package.json': JSON.stringify({ publisher: 'pub', name, version: '1.0.0', main: './out/extension.js' }), ...files })) {
			await fs.promises.mkdir(join(folder, path, '..'), { recursive: true });
			await fs.promises.writeFile(join(folder, path), text);
		}
		return folder;
	}

	const facts = (id: string) => ({ id, version: '1.0.0', publisher: 'pub', source: 'gallery' as const, publisherId: 'uuid-1', verified: true, signature: 'Success' });

	test('SUP-8-1: unchanged files pass; a modified, added or removed file fails with what changed', async () => {
		const integrity = new VoltExtensionIntegrity(lockPath);
		const lint = await extension('lint', { 'out/extension.js': 'activate()', 'media/icon.svg': '<svg/>' });
		const entry = await integrity.record(lint, facts('pub.lint'));
		assert.deepStrictEqual(Object.keys(entry.files).sort(), ['media/icon.svg', 'out/extension.js', 'package.json']);
		assert.match(entry.root, /^[0-9a-f]{64}$/);
		assert.deepStrictEqual(await integrity.verify([lint]), []);

		await fs.promises.writeFile(join(lint, 'out/extension.js'), 'activate(); fetch(evil)');
		assert.deepStrictEqual((await integrity.verify([lint])).map(failure => [failure.id, failure.why, failure.source]), [['pub.lint', 'out/extension.js was modified', 'gallery']]);

		// Same size, different bytes (the size alone is not trusted).
		await fs.promises.writeFile(join(lint, 'out/extension.js'), 'activatE()');
		assert.deepStrictEqual((await integrity.verify([lint])).map(failure => failure.why), ['out/extension.js was modified']);

		await fs.promises.writeFile(join(lint, 'out/extension.js'), 'activate()');
		await fs.promises.writeFile(join(lint, 'out/payload.js'), 'steal()');
		await fs.promises.rm(join(lint, 'media/icon.svg'));
		assert.deepStrictEqual((await integrity.verify([lint])).map(failure => failure.why), ['out/payload.js was added; media/icon.svg was removed']);
	});

	test('SUP-8-2: a file touched but unchanged passes and is not hashed again; VS Code\'s __metadata in package.json is not the extension\'s', async () => {
		const integrity = new VoltExtensionIntegrity(lockPath);
		const lint = await extension('lint', { 'out/extension.js': 'activate()' });
		await integrity.record(lint, facts('pub.lint'));
		const later = new Date(Date.now() + 60_000);
		await fs.promises.utimes(join(lint, 'out/extension.js'), later, later);
		assert.deepStrictEqual(await integrity.verify([lint]), []);
		const refreshed = (await integrity.entry(lint))!.files['out/extension.js'];
		assert.strictEqual(refreshed.mtimeMs, (await fs.promises.lstat(join(lint, 'out/extension.js'))).mtimeMs, 'the new stats are saved: the next check reads nothing');

		const manifest = JSON.parse(await fs.promises.readFile(join(lint, 'package.json'), 'utf8'));
		await fs.promises.writeFile(join(lint, 'package.json'), JSON.stringify({ ...manifest, __metadata: { installedTimestamp: 1, pinned: true } }, null, '\t'));
		assert.deepStrictEqual(await integrity.verify([lint]), [], 'install metadata is ignored');
		await fs.promises.writeFile(join(lint, 'package.json'), JSON.stringify({ ...manifest, main: './out/payload.js' }));
		assert.deepStrictEqual((await integrity.verify([lint])).map(failure => failure.why), ['package.json was modified']);
	});

	test('SUP-8-3: installed before the lock: recorded on first look (baseline), checked from then on', async () => {
		const integrity = new VoltExtensionIntegrity(lockPath);
		const old = await extension('old', { 'out/extension.js': 'activate()' });
		assert.deepStrictEqual(await integrity.verify([old]), [], 'trust on first use');
		await integrity.whenBaselined();
		const entry = await integrity.entry(old);
		assert.strictEqual(entry?.source, 'baseline');
		assert.strictEqual(entry?.id, 'pub.old');
		await fs.promises.writeFile(join(old, 'out/extension.js'), 'steal()');
		assert.deepStrictEqual((await integrity.verify([old])).map(failure => failure.why), ['out/extension.js was modified']);
		// A missing folder fails too (it can't be checked).
		await fs.promises.rm(old, { recursive: true });
		assert.deepStrictEqual((await integrity.verify([old])).map(failure => failure.why), ['its folder is missing']);
	});

	test('SUP-8-4: Trust Current Files makes the files as they are the lock, keeping who published it', async () => {
		const integrity = new VoltExtensionIntegrity(lockPath);
		const lint = await extension('lint', { 'out/extension.js': 'activate()' });
		await integrity.record(lint, facts('pub.lint'));
		await fs.promises.writeFile(join(lint, 'out/extension.js'), 'activate(); patched()');
		assert.strictEqual((await integrity.verify([lint])).length, 1);
		await integrity.trust(lint);
		assert.deepStrictEqual(await integrity.verify([lint]), []);
		const entry = (await integrity.entry(lint))!;
		assert.deepStrictEqual([entry.source, entry.publisherId, entry.verified, entry.signature], ['trusted', 'uuid-1', true, 'Success']);
	});

	test('SUP-8-5: files the OS or Python write beside an extension are not locked; the store is merged, not overwritten, and 0600', async () => {
		const a = new VoltExtensionIntegrity(lockPath);
		const b = new VoltExtensionIntegrity(lockPath); // another process (the agent server)
		const py = await extension('py', { 'lib/tool.py': 'print(1)' });
		const lint = await extension('lint', { 'out/extension.js': 'activate()' });
		await Promise.all([a.record(py, facts('pub.py')), b.record(lint, facts('pub.lint'))]);
		await fs.promises.mkdir(join(py, 'lib/__pycache__'));
		await fs.promises.writeFile(join(py, 'lib/__pycache__/tool.cpython-312.pyc'), 'bytecode');
		await fs.promises.writeFile(join(py, '.DS_Store'), 'finder');
		assert.deepStrictEqual(await a.verify([py, lint]), []);
		assert.deepStrictEqual(Object.keys((await a.read()).extensions).sort(), [lint, py].sort(), 'both writers kept');
		if (process.platform !== 'win32') {
			assert.strictEqual((await fs.promises.stat(lockPath)).mode & 0o777, 0o600);
		}
		// A version VS Code deleted (after an update or uninstall) leaves the lock at the next check.
		await fs.promises.rm(py, { recursive: true });
		assert.deepStrictEqual(await a.verify([lint]), []);
		assert.deepStrictEqual(Object.keys((await a.read()).extensions), [lint]);
	});

	test('SUP-8-6: the update check sees the install-time scan\'s high findings', async () => {
		const clean = await extension('clean', { 'out/extension.js': 'activate()' });
		const sneaky = await extension('sneaky', { 'out/extension.js': `const c = ['child', 'process'].join('_'); require(c);` });
		assert.deepStrictEqual((await scanHighFindings(clean, {})).keys, []);
		assert.deepStrictEqual((await scanHighFindings(sneaky, {})).keys, ['hidden-name: child_process']);
	});

	test('SUP-8-PERF: 50 extensions of 60 files each: the check stats, it does not read', async function () {
		this.timeout(60_000);
		const integrity = new VoltExtensionIntegrity(lockPath);
		const folders: string[] = [];
		for (let i = 0; i < 50; i++) {
			const files: Record<string, string> = {};
			for (let j = 0; j < 60; j++) {
				files[`out/chunk${j % 10}/file${j}.js`] = `module.exports = ${i * 1000 + j};`.repeat(20);
			}
			const folder = await extension(`ext${i}`, files);
			await integrity.record(folder, facts(`pub.ext${i}`));
			folders.push(folder);
		}
		const started = Date.now();
		assert.deepStrictEqual(await integrity.verify(folders), []);
		const elapsed = Date.now() - started;
		// On real extensions (50 installed ones, 27,585 files, 1.85 GB) the check took 125 to 141 ms on an
		// M-series Mac; the bound only catches a check that reads every file.
		assert.ok(elapsed < 5_000, `the check took ${elapsed} ms`);
	});
});
