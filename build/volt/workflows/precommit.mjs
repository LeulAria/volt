/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Pre-commit step (package.json "precommit", after hygiene): when the staged files touch the
// workflow templates repository or the code that reads it, run the templates validator. It is
// quick (no build) and checks the working tree. Without Bun it skips with a note instead of
// blocking the commit; the Workflow Templates GitHub Action runs the same check.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const WATCHED = [
	/^workflow-templates\//,
	/^build\/volt\/workflows\//,
	/^src\/vs\/workbench\/services\/voltRuntime\/common\/workflows\//,
	/^src\/vs\/workbench\/services\/voltRuntime\/common\/automations\/automation(Cron|Triggers|Webhooks)\.ts$/,
];

const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
if (staged.status !== 0) {
	console.log('Skipping the workflow templates check: could not list the staged files.');
	process.exit(0);
}
const touched = staged.stdout.split(/\r?\n/).filter(file => WATCHED.some(pattern => pattern.test(file)));
if (!touched.length) {
	process.exit(0);
}

const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (bun.error || bun.status !== 0) {
	console.log('Workflow templates changed, but Bun is not installed, so they were not validated (CI will). Install Bun (https://bun.sh) to check them before you commit.');
	process.exit(0);
}

console.log(`Validating workflow templates (${touched.length} staged file${touched.length === 1 ? ' touches' : 's touch'} them)...`);
const result = spawnSync('bun', [path.join('build', 'volt', 'workflows', 'validateTemplates.ts')], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
