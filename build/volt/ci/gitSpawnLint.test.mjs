/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findGitSpawns, lint } from './gitSpawnLint.mjs';

const ids = text => findGitSpawns(text).map(finding => finding.id);

test('every way Volt has started git is caught', () => {
	assert.deepEqual(ids(`const child = spawn('git', ['status'], { cwd });`), ['child-process']);
	assert.deepEqual(ids(`execFile("git", [...args], options, callback);`), ['child-process']);
	assert.deepEqual(ids('execSync(`git status`)'), ['child-process']);
	assert.deepEqual(ids(`const top = await this.run('git', ['rev-parse'], { cwd });`), ['runner']);
	assert.deepEqual(ids(`const result = await this.execFile(ctx, 'git', args, folder, timeoutMs);`), ['runner']);
	assert.deepEqual(ids(`command: ['git', '--no-pager', ...args].map(quote).join(' '),`), ['argv']);
	assert.deepEqual(ids(`const argv = ['git', ...args];`), ['argv']);
	assert.deepEqual(ids(`this.stdio.exec({ id, command: 'git status --porcelain', cwd })`), ['stdio-request']);
	assert.deepEqual(ids(`await stdio.execFile({ file: 'git', args, timeoutMs })`), ['stdio-request']);
});

test('comments, names and unrelated lists are not spawns', () => {
	assert.deepEqual(ids(`// spawn('git', ['status'])\n/* execFile('git') */\n * run('git', x)`), []);
	assert.deepEqual(ids(`registerMethods('git', { status })`), []);
	assert.deepEqual(ids(`const groups = ['git', 'slack', 'teams'];`), []);
	assert.deepEqual(ids(`permissions: ['git', 'network'],`), []);
	assert.deepEqual(ids(`slot('git', label, description);`), []);
});

test('the tree is clean: every git spawn in src/ goes through HostGit or is allow-listed with a reason', () => {
	const { problems, stale } = lint();
	assert.deepEqual(problems, []);
	assert.deepEqual(stale, []);
});
