/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs Volt's pure-logic (`test/common`) unit tests with `bun test`, straight from src/*.ts: no
// watcher, no out/, so a stale or crashed `gulp watch-client` cannot make tests pass against old code.
// Usage: bun build/volt/bun/test.mjs [file-or-folder ...]   (default: every Volt test/common suite)
//        npm run test-volt-bun -- src/vs/workbench/services/voltRuntime/test/common
// The canonical suites stay on mocha (`npm run test-node`, `scripts/test.sh`); VS Code's own
// base suites rely on Node timer semantics that Bun does not match.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const isCommonTest = file => file.endsWith('.test.ts') && file.split(path.sep).includes('common') && file.split(path.sep).includes('test');

function collect(target, into) {
	const stat = fs.statSync(target);
	if (stat.isDirectory()) {
		for (const entry of fs.readdirSync(target)) {
			collect(path.join(target, entry), into);
		}
	} else if (isCommonTest(target)) {
		into.push(target);
	}
}

const args = process.argv.slice(2);
const files = [];
if (args.length) {
	for (const arg of args) {
		collect(path.resolve(arg), files);
	}
} else {
	collect(path.join(root, 'src'), files);
	files.splice(0, files.length, ...files.filter(file => /volt/i.test(path.relative(root, file))));
}
if (!files.length) {
	console.error('No test/common suites found.');
	process.exit(1);
}
files.sort();

const bun = process.versions.bun ? process.execPath : 'bun';
const result = spawnSync(bun, ['test', '--timeout', '20000', '--preload', path.join(import.meta.dirname, 'testPreload.mjs'), ...files.map(file => path.relative(root, file))], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
