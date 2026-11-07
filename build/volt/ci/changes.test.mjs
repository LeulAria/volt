/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect, everything } from './changes.mjs';

/** @param {Record<string, boolean>} result */
const on = result => Object.keys(result).filter(area => result[area]).sort();

test('documentation alone runs nothing', () => {
	assert.deepEqual(on(detect(['README.md', 'docs/setup.md', '.github/ISSUE_TEMPLATE/bug_report.yml', 'CHANGELOG.md'])), []);
});

test('a source change runs the core checks only', () => {
	assert.deepEqual(on(detect(['src/vs/workbench/contrib/voltAgent/browser/agentEditor.ts'])), ['src']);
});

test('a markdown file inside src still counts as source', () => {
	assert.deepEqual(on(detect(['src/vs/workbench/contrib/voltAgent/README.md'])), ['src']);
});

test('build/ wakes both the core checks and the extensions compile', () => {
	assert.deepEqual(on(detect(['build/lib/compilation.ts'])), ['extensions', 'src']);
});

test('the lockfile wakes the core checks and the extensions compile', () => {
	assert.deepEqual(on(detect(['package-lock.json'])), ['extensions', 'src']);
});

test('apps run only their own jobs', () => {
	assert.deepEqual(on(detect(['apps/docs/src/routes/index.tsx'])), ['docs']);
	assert.deepEqual(on(detect(['apps/relay/src/relay.mjs'])), ['relay']);
	assert.deepEqual(on(detect(['apps/volt-govern/src/server/main.ts'])), ['govern']);
	assert.deepEqual(on(detect(['apps/mobile/app/index.tsx'])), ['mobile']);
});

test('client-core and the widgets are checked with the mobile app', () => {
	assert.deepEqual(on(detect(['apps/client-core/src/terminals.ts'])), ['mobile']);
	assert.deepEqual(on(detect(['apps/mobile-widgets/src/model.ts'])), ['mobile']);
});

test('release and CI scripts run the workflow checks, not the core checks', () => {
	assert.deepEqual(on(detect(['build/volt/release/prepare.mjs'])), ['workflows']);
	assert.deepEqual(on(detect(['build/volt/ci/review/diff.mjs'])), ['workflows']);
	assert.deepEqual(on(detect(['.github/workflows/volt-pr.yml'])), ['workflows']);
});

test('editing the CI itself runs every job', () => {
	assert.deepEqual(detect(['.github/workflows/volt-ci.yml']), everything());
	assert.deepEqual(detect(['.github/actions/setup-volt/action.yml']), everything());
	assert.deepEqual(detect(['build/volt/ci/changes.mjs']), everything());
});

test('an unknown top-level path falls back to the core checks', () => {
	assert.deepEqual(on(detect(['newtool/config.json'])), ['src']);
});

test('the Rust CLI runs only its own job', () => {
	assert.deepEqual(on(detect(['cli/src/main.rs', 'cli/Cargo.toml'])), ['cli']);
});
