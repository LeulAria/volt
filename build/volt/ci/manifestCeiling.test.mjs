/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkBuiltins, loadCeilings, readBuiltins } from './manifestCeiling.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const ceilings = await loadCeilings(root);

/** @param {string} name @param {object} contributes */
function builtin(name, contributes) {
	return { folder: `volt-${name}`, manifest: { publisher: 'volt', name, contributes } };
}

/** The real built-ins with one manifest replaced. */
function withReplaced(replacement) {
	return readBuiltins(root).map(entry => entry.folder === replacement.folder ? replacement : entry);
}

test('M5-CI-1: every extensions/volt-* manifest is within its first-party ceiling, and every ceiling has its built-in', () => {
	const builtins = readBuiltins(root);
	assert.ok(builtins.length >= 30, `found ${builtins.length} built-ins`);
	const { problems, warnings } = checkBuiltins(builtins, ceilings);
	assert.deepEqual(problems, []);
	assert.deepEqual(warnings, [], 'every ceiling is exactly as narrow as its manifest');
});

test('M5-CI-2: an over-wide manifest fails', () => {
	// A capability the ceiling doesn't hold.
	const memory = builtin('memory', { voltCapabilities: { required: [{ id: 'tools.register' }, { id: 'agents.context' }, { id: 'agents.send' }] } });
	assert.deepEqual(checkBuiltins(withReplaced(memory), ceilings).problems, ['volt.memory declares agents.send beyond its first-party ceiling']);
	// A family where the ceiling holds one member.
	const claude = builtin('provider-claude', { voltCapabilities: { required: [{ id: 'secrets.use:*' }] } });
	assert.deepEqual(checkBuiltins(withReplaced(claude), ceilings).problems, ['volt.provider-claude declares secrets.use:* beyond its first-party ceiling']);
	// Dropping the targets asks for every target; an optional entry counts as much as a required one.
	const customize = builtin('customize', { voltCapabilities: { optional: [{ id: 'files.write' }] } });
	assert.deepEqual(checkBuiltins(withReplaced(customize), ceilings).problems, ['volt.customize declares files.write beyond its first-party ceiling']);
	const openrouter = builtin('provider-openrouter', { voltCapabilities: { required: [{ id: 'net.connect', targets: ['openrouter.ai', 'evil.example'] }, { id: 'secrets.use:openrouter' }] } });
	assert.deepEqual(checkBuiltins(withReplaced(openrouter), ceilings).problems, ['volt.provider-openrouter declares net.connect on openrouter.ai, evil.example beyond its first-party ceiling']);
});

test('M5-CI-3: a built-in without a ceiling, a renamed manifest and a stale ceiling fail', () => {
	const unknown = builtin('notreal', { voltCapabilities: { required: [{ id: 'usage.report' }] } });
	assert.deepEqual(checkBuiltins([...readBuiltins(root), unknown], ceilings).problems, ['volt.notreal has no first-party ceiling']);
	const agents = builtin('notreal', { voltAgents: [{ id: 'x' }] });
	assert.deepEqual(checkBuiltins([...readBuiltins(root), agents], ceilings).problems, ['volt.notreal contributes voltAgents but has no first-party ceiling']);
	const renamed = { folder: 'volt-scratch-board', manifest: { publisher: 'someone', name: 'scratch-board', contributes: {} } };
	assert.deepEqual(checkBuiltins(withReplaced(renamed), ceilings).problems, [
		'extensions/volt-scratch-board: the manifest is someone.scratch-board, expected volt.scratch-board (a built-in\'s ceiling is found by its id)',
		'volt.scratch-board has a first-party ceiling but no extensions/volt-scratch-board built-in (remove the stale ceiling)',
	]);
	// A narrower manifest passes and only warns.
	const narrower = builtin('memory', { voltCapabilities: { required: [{ id: 'tools.register' }] } });
	const { problems, warnings } = checkBuiltins(withReplaced(narrower), ceilings);
	assert.deepEqual(problems, []);
	assert.deepEqual(warnings, ['volt.memory: the ceiling holds agents.context, which the manifest doesn\'t declare (narrow the ceiling)']);
});
