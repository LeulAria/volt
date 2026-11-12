/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { audit, scan, sitesIn } from './spawnAudit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('spawn audit (K.4, SPAWN-AUDIT)', () => {
	test('finds child_process, utilityProcess, Worker, vm and node-pty sites, not look-alikes', () => {
		assert.deepEqual(sitesIn(`import { spawn, execFile as run } from 'child_process';\nconst a = spawn('x');\nrun('y', () => {});\n/^a/.exec('a'); // spawn('in a comment')\n`), { child_process: 2 });
		assert.deepEqual(sitesIn(`import * as cp from 'node:child_process';\ncp.fork('m');\ncp.spawnSync('x');\n`), { child_process: 2 });
		assert.deepEqual(sitesIn(`import { execFile } from 'child_process';\nconst execFileAsync = promisify(execFile);\nawait execFileAsync('a');\n`), { child_process: 1 });
		assert.deepEqual(sitesIn(`import type { ChildProcess } from 'child_process';\nconst x: ChildProcess = y;\n`), {});
		assert.deepEqual(sitesIn(`const { spawn } = require('child_process');\nspawn('a');\n`), { child_process: 1 });
		assert.deepEqual(sitesIn(`utilityProcess.fork(path);\nnew Worker(url);\nnew window.Worker(url);\n`), { 'utilityProcess.fork': 1, 'new Worker': 2 });
		assert.deepEqual(sitesIn(`import * as vm from 'vm';\nvm.runInNewContext(code);\n`), { vm: 1 });
		assert.deepEqual(sitesIn(`import { spawn } from 'node-pty';\nspawn(shell, []);\n`), { 'pty.spawn': 1 });
		assert.deepEqual(sitesIn(`const pty = await import('node-pty');\npty.spawn(shell, []);\n`), { 'pty.spawn': 1 });
	});

	test('a new site, a grown file, a gone site and a missing or TODO reason all fail', () => {
		const found = [{ file: 'src/a.ts', kind: 'child_process', count: 2 }, { file: 'src/new.ts', kind: 'new Worker', count: 1 }];
		const ok = { file: 'src/a.ts', kind: 'child_process', count: 2, owner: 'core', reason: 'supervisor', why: 'Fixed helper.' };
		assert.deepEqual(audit([found[0]], { sites: [ok] }), []);
		assert.match(audit(found, { sites: [ok] }).join('\n'), /src\/new\.ts: 1 new new Worker site/);
		assert.match(audit(found.slice(0, 1), { sites: [{ ...ok, count: 1 }] }).join('\n'), /1 more child_process site/);
		assert.match(audit(found.slice(0, 1), { sites: [{ ...ok, count: 3 }] }).join('\n'), /1 fewer/);
		assert.match(audit([], { sites: [ok] }).join('\n'), /no such site any more/);
		assert.match(audit(found.slice(0, 1), { sites: [{ ...ok, reason: 'whatever' }] }).join('\n'), /reason must be one of supervisor, user-action, build-only/);
		assert.match(audit(found.slice(0, 1), { sites: [{ ...ok, why: 'TODO classify' }] }).join('\n'), /needs a real why/);
		assert.match(audit(found.slice(0, 1), { sites: [{ ...ok, owner: '' }] }).join('\n'), /needs a real owner/);
	});

	test('the repository\'s allowlist lists every site in src/ and apps/, each with an owner and a reason', () => {
		const allowlist = JSON.parse(readFileSync(join(ROOT, 'build', 'volt', 'sandbox-spawn-allowlist.json'), 'utf8'));
		assert.deepEqual(audit(scan(ROOT), allowlist), []);
		assert.ok(allowlist.sites.some(site => site.file === 'src/vs/platform/voltStdio/node/voltStdioService.ts' && site.reason === 'supervisor'), 'the scan reached the stdio service');
	});
});
