/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltCodeIndexOptions } from '../../common/voltCodeIndex.js';
import { CodeIndexEngine } from '../../node/codeIndexEngine.js';

/**
 * GATE-SYM-1 at the index (B-15, INV-12): a workspace symlink to a credential folder. The shared
 * index follows it, and its search returns the files' lines, not only their paths (the spec's
 * assumption, confirmed here). A sandboxed chat's confined index never sees through it.
 */
suite('Volt code index: a sandboxed chat\'s confined index (GATE-SYM-1)', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let base: string;
	let ws: string;
	let engine: CodeIndexEngine;
	const CONFINED: IVoltCodeIndexOptions = { confined: true };

	suiteSetup(async () => {
		base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), `volt-index-confined-${generateUuid().slice(0, 8)}-`)));
		ws = join(base, 'ws');
		const ssh = join(base, 'home', '.ssh');
		await fs.mkdir(join(ws, 'src'), { recursive: true });
		await fs.mkdir(ssh, { recursive: true });
		await fs.writeFile(join(ws, 'src', 'app.ts'), 'export function startServer() { return "hello"; }\n');
		await fs.writeFile(join(ssh, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-c4n4ry-KEY\n-----END OPENSSH PRIVATE KEY-----\n');
		await fs.writeFile(join(ssh, 'agent.ts'), 'export function canaryExport() { return "CANARY-c4n4ry-KEY"; }\n');
		// What the agent can do inside its sandbox: make a link (reading through it is what the OS denies).
		await fs.symlink(ssh, join(ws, 'k'));
		engine = new CodeIndexEngine(join(base, 'data'), () => { });
	});

	suiteTeardown(async () => {
		await engine?.dispose();
		await fs.rm(base, { recursive: true, force: true });
	});

	const grep = (options: IVoltCodeIndexOptions) => engine.search({ root: ws, pattern: 'CANARY', isRegExp: false, caseSensitive: true, multiline: false, maxMatches: 50, options, waitMs: 30_000 });

	test('the shared index follows the link and returns the secret\'s lines (why B-15 matters)', async () => {
		const result = await grep({});
		assert.strictEqual(result.kind, 'results', JSON.stringify(result));
		const lines = result.kind === 'results' ? result.files.flatMap(file => file.lines.map(line => `${file.path}: ${line.text}`)) : [];
		assert.ok(lines.some(line => line.startsWith('k/id_ed25519: ') && line.includes('CANARY-c4n4ry-KEY')), `content lines come back, not only paths: ${JSON.stringify(lines)}`);
	});

	test('GATE-SYM-1: a confined search for the canary returns nothing, and no listing shows the link\'s files', async () => {
		const result = await grep(CONFINED);
		assert.strictEqual(result.kind, 'results', JSON.stringify(result));
		assert.deepStrictEqual(result.kind === 'results' ? result.files : undefined, []);
		const files = await engine.files({ root: ws, pattern: '**/*', limit: 100, options: CONFINED, waitMs: 30_000 });
		assert.deepStrictEqual(files.kind === 'results' ? [...files.paths].sort() : files, ['src/app.ts']);
		const found = await engine.findFiles({ root: ws, query: 'id_ed25519', limit: 10, options: CONFINED, fff: 'auto', waitMs: 30_000 });
		assert.deepStrictEqual(found.kind === 'results' ? found.paths : found, []);
		const symbols = await engine.symbols({ root: ws, query: 'canaryExport', limit: 10, options: CONFINED, waitMs: 30_000 });
		assert.deepStrictEqual(symbols.kind === 'results' ? symbols.symbols : symbols, []);
		// The project's own files are still found.
		const own = await engine.symbols({ root: ws, query: 'startServer', limit: 10, options: CONFINED, waitMs: 30_000 });
		assert.deepStrictEqual(own.kind === 'results' ? own.symbols.map(symbol => symbol.path) : own, ['src/app.ts']);
	});

	test('the confined index lives beside the shared one: the settings page lists the folder once', async () => {
		const status = await engine.status();
		assert.deepStrictEqual(status.filter(entry => entry.root === ws).length, 1);
	});
});
