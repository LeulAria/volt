/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkFile, importsOf, readFeatures, scan } from './featureImportLint.mjs';

const FEATURES = [
	{ feature: 'automations', entry: 'voltAutomations', folder: 'src/vs/workbench/contrib/voltAutomations/' },
	{ feature: 'skills', entry: 'voltSkills', folder: 'src/vs/workbench/contrib/voltSkills/' },
];

test('resolves static, side-effect, type, multi-line and dynamic imports', () => {
	const text = [
		'import \'../media/x.css\';',
		'import { a } from \'../../voltAgent/browser/a.js\';',
		'import type { B } from \'./b.js\';',
		'import {',
		'\tc,',
		'} from \'../common/c.js\';',
		'export * from \'./d.js\';',
		'const e = () => import(\'./e.js\');',
		'// import { f } from \'./f.js\';',
	].join('\n');
	const found = importsOf('src/vs/workbench/contrib/voltAutomations/browser/x.ts', text).map(entry => `${entry.line}:${entry.target}${entry.dynamic ? ':dynamic' : ''}`);
	assert.deepEqual(found, [
		'1:src/vs/workbench/contrib/voltAutomations/media/x.css',
		'2:src/vs/workbench/contrib/voltAgent/browser/a.ts',
		'3:src/vs/workbench/contrib/voltAutomations/browser/b.ts',
		'6:src/vs/workbench/contrib/voltAutomations/common/c.ts',
		'7:src/vs/workbench/contrib/voltAutomations/browser/d.ts',
		'8:src/vs/workbench/contrib/voltAutomations/browser/e.ts:dynamic',
	]);
});

test('LINT-FEATURE-IN: outside a feature, only its contract is importable', () => {
	const core = 'src/vs/workbench/contrib/voltAgent/browser/home/agentHomePane.ts';
	const contract = 'import { OPEN_AUTOMATIONS_COMMAND_ID } from \'../../../voltAutomations/common/voltAutomations.js\';';
	const internals = 'import { AutomationsEditor } from \'../../../voltAutomations/browser/automationsEditor.js\';';
	assert.equal(checkFile(core, contract, FEATURES, {}).length, 0);
	assert.deepEqual(checkFile(core, internals, FEATURES, {}).map(finding => `${finding.rule}:${finding.feature}`), ['in:automations']);
	// Features are outside each other.
	const skills = 'src/vs/workbench/contrib/voltSkills/browser/x.ts';
	assert.deepEqual(checkFile(skills, 'import { x } from \'../../voltAutomations/browser/automationUi.js\';', FEATURES, {}).map(finding => finding.rule), ['in']);
	assert.equal(checkFile(skills, 'import { x } from \'../../voltAutomations/common/voltAutomations.js\';', FEATURES, {}).length, 0);
});

test('LINT-FEATURE-TABLE: only the module table imports a module entry, and only dynamically', () => {
	const table = 'src/vs/workbench/contrib/voltCustomize/browser/voltFeatureModuleTable.ts';
	assert.equal(checkFile(table, 'const load = () => import(\'../../voltAutomations/browser/voltAutomations.module.js\');', FEATURES, {}).length, 0);
	assert.equal(checkFile(table, 'import { m } from \'../../voltAutomations/browser/voltAutomations.module.js\';', FEATURES, {}).length, 1, 'a static import loads it at startup');
	assert.equal(checkFile('src/vs/workbench/contrib/voltSettings/browser/x.ts', 'const load = () => import(\'../../voltAutomations/browser/voltAutomations.module.js\');', FEATURES, {}).length, 1);
});

test('LINT-FEATURE-OUT: a feature imports core beyond the always-allowed set only from its allowlist', () => {
	const file = 'src/vs/workbench/contrib/voltAutomations/browser/x.ts';
	const allowed = [
		'import { $ } from \'../../../../base/browser/dom.js\';',
		'import { localize } from \'../../../../nls.js\';',
		'import { IInstantiationService } from \'../../../../platform/instantiation/common/instantiation.js\';',
		'import { IVoltPluginContext } from \'../../../services/voltPlugins/common/voltApi.js\';',
		'import { createVoltButton } from \'../../voltAgent/browser/chrome/voltButton.js\';',
		'import { showVoltMenu } from \'../../voltAgent/browser/ui/menu/voltMenu.js\';',
		'import { own } from \'./own.js\';',
	].join('\n');
	assert.equal(checkFile(file, allowed, FEATURES, {}).length, 0);
	const deep = 'import { IAgentHistoryService } from \'../../../services/voltRuntime/common/history/agentHistory.js\';';
	assert.deepEqual(checkFile(file, deep, FEATURES, {}).map(finding => `${finding.rule}:${finding.target}`), ['out:src/vs/workbench/services/voltRuntime/common/history/agentHistory.ts']);
	assert.equal(checkFile(file, deep, FEATURES, { automations: ['src/vs/workbench/services/voltRuntime/common/history/agentHistory.ts'] }).length, 0);
	assert.equal(checkFile(file, deep, FEATURES, { skills: ['src/vs/workbench/services/voltRuntime/common/history/agentHistory.ts'] }).length, 1, 'another feature\'s entry does not count');
});

test('LINT-FEATURE-TEST: tests are not fenced (they import what they test)', () => {
	const internals = 'import { AutomationsEditor } from \'../../../voltAutomations/browser/automationsEditor.js\';';
	assert.equal(checkFile('src/vs/workbench/contrib/voltCustomize/test/browser/x.test.ts', internals, FEATURES, {}).length, 0);
	assert.equal(checkFile('src/vs/workbench/contrib/voltAutomations/test/browser/x.test.ts', 'import { x } from \'../../../voltAgent/browser/editor/agentEditor.js\';', FEATURES, {}).length, 0);
});

test('LINT-FEATURE-REPO: the repository passes, and its allowlist has no stale entry', () => {
	const root = path.resolve(import.meta.dirname, '../../..');
	const allowlist = JSON.parse(fs.readFileSync(path.join(root, 'build/volt/ci/feature-import-allowlist.json'), 'utf8')).features;
	const { features, findings, stale } = scan(root, allowlist);
	assert.deepEqual(findings.map(finding => `${finding.file}:${finding.line} ${finding.target}`), []);
	assert.deepEqual(stale, []);
	assert.deepEqual(Object.keys(allowlist).filter(feature => !features.some(entry => entry.feature === feature)), [], 'every allowlist key is a fenced feature');
	assert.ok(readFeatures(root).every(feature => fs.existsSync(path.join(root, feature.folder))), 'every voltModule.entry names a folder');
});
