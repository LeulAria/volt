/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FffEngine, fffBaseFor, toRootPaths } from '../../node/fffEngine.js';

/**
 * A stand-in for `fff-mcp`: MCP over stdio, with queries that make it crash or hang.
 * Answers paths relative to the folder it was started in (the git root).
 */
const FAKE_FFF = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('fff-mcp 9.9.9 (test)'); process.exit(0); }
let buffer = '';
process.stdin.on('data', chunk => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf('\\n')) >= 0) {
		const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		if (msg.id === undefined) continue;
		if (msg.method === 'initialize') { reply(msg.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fff', version: '9.9.9' } }); continue; }
		const query = msg.params.arguments.query;
		if (query.includes('crash')) process.exit(3);
		if (query.includes('hang')) continue;
		if (query.includes('nothing')) { reply(msg.id, { content: [{ type: 'text', text: '0 results (3 indexed)' }] }); continue; }
		reply(msg.id, { content: [{ type: 'text', text: ['\\u2192 Read sub/a.ts (exact match!)', '3/7 matches', 'sub/a.ts - hot', 'other/b.ts git:modified', 'sub/My Dir/c.ts', 'cursor: 1'].join('\\n') }, { type: 'text', text: 'update available' }] });
	}
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
`;

(isWindows ? suite.skip : suite)('Volt code index: FFF engine', function () {

	this.timeout(20_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let base: string;
	let repo: string;
	let fake: string;
	let savedPath: string | undefined;

	suiteSetup(async () => {
		base = join(tmpdir(), `volt-fff-test-${generateUuid()}`);
		repo = join(base, 'repo');
		await fs.mkdir(join(repo, '.git'), { recursive: true });
		await fs.mkdir(join(repo, 'sub'), { recursive: true });
		fake = join(base, 'fake-fff-mcp');
		await fs.writeFile(fake, FAKE_FFF, { mode: 0o755 });
		savedPath = process.env['PATH'];
	});

	teardown(() => {
		process.env['PATH'] = savedPath;
	});

	suiteTeardown(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	const engine = () => new FffEngine(join(base, 'tools'), () => { }, { callMs: 1_000, firstCallMs: 2_000, retryAfterMs: 0 });

	test('the git root is FFF\'s base, and its paths map to the project\'s', async () => {
		assert.strictEqual(await fffBaseFor(join(repo, 'sub')), repo);
		assert.deepStrictEqual(toRootPaths(['sub/a.ts', 'other/b.ts', 'sub/My Dir/c.ts'], repo, join(repo, 'sub')), ['a.ts', 'My Dir/c.ts']);
		assert.deepStrictEqual(toRootPaths(['a.ts'], repo, repo), ['a.ts']);
	});

	test('not installed: skipped with the reason, never thrown', async () => {
		process.env['PATH'] = '';
		const fff = engine();
		try {
			assert.strictEqual((await fff.status()).state, 'missing');
			assert.deepStrictEqual(await fff.findFiles(repo, 'a', 5), { kind: 'skipped', reason: 'FFF not installed' });
		} finally {
			fff.dispose();
		}
	});

	test('a configured binary that does not run: an error status, and skipped', async () => {
		const fff = engine();
		try {
			const status = await fff.status(join(base, 'no-such-binary'));
			assert.strictEqual(status.state, 'error');
			const found = await fff.findFiles(repo, 'a', 5, join(base, 'no-such-binary'));
			assert.strictEqual(found.kind, 'skipped');
		} finally {
			fff.dispose();
		}
	});

	test('answers mapped to the project folder, notices ignored', async () => {
		const fff = engine();
		try {
			const status = await fff.status(fake);
			assert.deepStrictEqual({ state: status.state, version: status.version }, { state: 'ready', version: '9.9.9' });
			const atRoot = await fff.findFiles(repo, 'a', 5, fake);
			assert.deepStrictEqual(atRoot, { kind: 'results', paths: ['sub/a.ts', 'other/b.ts', 'sub/My Dir/c.ts'], total: 7 });
			const inSub = await fff.findFiles(join(repo, 'sub'), 'a', 5, fake);
			assert.deepStrictEqual(inSub, { kind: 'results', paths: ['a.ts', 'My Dir/c.ts'] });
			assert.deepStrictEqual(await fff.findFiles(repo, 'nothing', 5, fake), { kind: 'results', paths: [], total: 0 });
		} finally {
			fff.dispose();
		}
	});

	test('a hung call times out and a crashed process is reported, then restarted', async () => {
		const fff = engine();
		try {
			assert.strictEqual((await fff.findFiles(repo, 'a', 5, fake)).kind, 'results');
			const hung = await fff.findFiles(repo, 'hang', 5, fake);
			assert.strictEqual(hung.kind, 'skipped');
			assert.match(hung.kind === 'skipped' ? hung.reason : '', /did not answer/);
			const crashed = await fff.findFiles(repo, 'crash', 5, fake);
			assert.strictEqual(crashed.kind, 'skipped');
			assert.match(crashed.kind === 'skipped' ? crashed.reason : '', /exited/);
			// retryAfterMs is 0 here: the next call starts a fresh process.
			assert.strictEqual((await fff.findFiles(repo, 'a', 5, fake)).kind, 'results');
		} finally {
			fff.dispose();
		}
	});
});
