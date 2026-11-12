/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkFindings, findDecisions, scan } from './authorityGate.mjs';

test('AUTH-GATE-1: finds decision primitives called outside the Authority', () => {
	const text = [
		'if (ceilingCovers(id, capability, target)) {',
		'const ok = grants.some(grant => grantCovers(grant, capability, target) && grantValid(grant, ctx));',
		'return legacyHostToolRefusal(use, id, sandbox, covers);',
	].join('\n');
	assert.deepEqual(findDecisions('src/vs/workbench/x.ts', text).map(f => `${f.line}:${f.kind}`), ['1:ceilingCovers', '2:grantCovers', '3:legacyHostToolRefusal']);
});

test('AUTH-GATE-2: the Authority\'s own modules, imports, definitions, methods and comments are not findings', () => {
	assert.equal(findDecisions('src/vs/platform/voltSandbox/common/authority.ts', 'return chatCovers(a, b);').length, 0);
	assert.equal(findDecisions('src/vs/workbench/x.ts', 'import { ceilingCovers } from \'./firstPartyCeilings.js\';\nexport { chatCovers } from \'./authority.js\';').length, 0);
	assert.equal(findDecisions('src/vs/workbench/x.ts', 'export function legacySandboxCovers(target, caller) {').length, 0);
	assert.equal(findDecisions('src/vs/workbench/x.ts', 'return this.authority.chatCovers(a, b);\n// ceilingCovers(x) is not used\n * grantValid(g) in a doc').length, 0);
});

test('AUTH-GATE-3: allowlist entries cover their exact line; unused entries are stale', () => {
	const findings = findDecisions('a.ts', 'ceilingCovers(a);\nhasRefusal(b);');
	const { unallowed, stale } = checkFindings(findings, [
		{ file: 'a.ts', text: 'ceilingCovers(a);', reason: 'reviewed' },
		{ file: 'a.ts', text: 'gone(c);', reason: 'reviewed' },
	]);
	assert.deepEqual(unallowed.map(f => f.kind), ['hasRefusal']);
	assert.deepEqual(stale.map(e => e.text), ['gone(c);']);
});

test('AUTH-GATE-4: the repository passes the gate with every site reviewed and no stale entry', () => {
	const root = path.resolve(import.meta.dirname, '../../..');
	const allowlist = JSON.parse(fs.readFileSync(path.join(root, 'build/volt/ci/authority-allowlist.json'), 'utf8')).sites;
	const { unallowed, stale } = checkFindings(scan(root), allowlist);
	assert.deepEqual(unallowed.map(f => `${f.file}:${f.line}: ${f.text}`), []);
	assert.deepEqual(stale.map(e => `${e.file}: ${e.text}`), []);
	assert.ok(allowlist.every(entry => typeof entry.reason === 'string' && entry.reason.length >= 10));
});
