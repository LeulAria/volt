/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Tests for the command visibility lint (commandVisibility.mjs). It needs `typescript` from the
// root node_modules, so it is a .spec.mjs that the Typecheck job runs, not one of the dependency-free
// *.test.mjs files the Workflows job runs.
// Run: node --test build/volt/ci/commandVisibility.spec.mjs

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { isVoltCommandId, isVoltFile, SourceIndex, voltRegistrations } from './commandVisibility.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

function lint(files, entry) {
	const sources = new Map(Object.entries(files).map(([file, text]) => [path.join(root, file), text]));
	const index = new SourceIndex(file => sources.get(file));
	return voltRegistrations(index, path.join(root, entry)).map(({ id, visibility, problem, line }) => ({ id, visibility, problem, line }));
}

test('Volt ids and Volt files', () => {
	for (const id of ['volt.browser.automate', 'voltAgent.checkpoint.restore', '_volt.agentTools.editUntilClosed', '_voltScratch.x']) {
		assert.ok(isVoltCommandId(id), id);
	}
	for (const id of ['workbench.action.files.save', 'vscode.open', 'git.commit', 'voltage', 'revolt.x']) {
		assert.ok(!isVoltCommandId(id), id);
	}
	assert.ok(isVoltFile('src/vs/workbench/contrib/voltAgent/browser/x.ts'));
	assert.ok(isVoltFile('src/vs/platform/voltHostMcp/common/voltHostMcpAuth.ts'));
	assert.ok(!isVoltFile('src/vs/workbench/api/browser/mainThreadCommands.ts'));
});

test('flags Volt registrations without a visibility, through constants and imports', () => {
	const files = {
		'src/vs/workbench/contrib/voltFixture/common/ids.ts': `
			export const AUTOMATE = 'volt.browser.automate';
			export const PREFIX = 'volt.fixture';
			export class Ids { static readonly Open = \`\${PREFIX}.open\`; }
			export const enum E { Run = 'voltAgent.run' }
		`,
		'src/vs/workbench/contrib/voltFixture/browser/fixture.ts': `
			import { AUTOMATE, Ids, E, PREFIX } from '../common/ids.js';
			registerAction2(class extends Action2 { constructor() { super({ id: Ids.Open, title: 'Open' }); } run() { } });
			registerAction2(class extends Action2 { constructor() { super({ id: E.Run, visibility: 'internal', title: 'Run' }); } run() { } });
			CommandsRegistry.registerCommand(AUTOMATE, () => { });
			CommandsRegistry.registerCommand(AUTOMATE, () => { }, 'internal');
			CommandsRegistry.registerCommand({ id: PREFIX + '.x', handler: () => { }, visibility: 'exported:git.read' });
			KeybindingsRegistry.registerCommandAndKeybindingRule({ id: 'workbench.action.voltFixture.go', weight: 0, handler: () => { } });
			CommandsRegistry.registerCommand('volt.fixture.bad', () => { }, 'privileged');
			class Base extends Action2 { constructor() { super({ id: 'volt.fixture.base', visibility: 'public', title: 'B' }); } }
			registerAction2(class extends Base { });
			const dynamic = (id: string) => registerAction2(class extends Action2 { constructor() { super({ id, title: id }); } run() { } });
			CommandsRegistry.registerCommandAlias('volt.fixture.alias', 'volt.fixture.open');
		`,
	};
	const found = lint(files, 'src/vs/workbench/contrib/voltFixture/browser/fixture.ts');
	assert.deepEqual(found.map(({ id, visibility, problem }) => [id, visibility, problem]), [
		['volt.fixture.open', undefined, 'has no visibility'],
		['voltAgent.run', 'internal', undefined],
		['volt.browser.automate', undefined, 'has no visibility'],
		['volt.browser.automate', 'internal', undefined],
		['volt.fixture.x', 'exported:git.read', undefined],
		// In a Volt file every registration says, whatever its id.
		['workbench.action.voltFixture.go', undefined, 'has no visibility'],
		['volt.fixture.bad', 'privileged', 'has a visibility that is not internal, public or exported:<capability> (\'privileged\')'],
		['volt.fixture.base', 'public', undefined],
		[undefined, undefined, 'has no visibility'],
	]);
});

test('outside Volt files only Volt ids need a visibility', () => {
	const found = lint({
		'src/vs/workbench/contrib/files/browser/fileActions.ts': `
			CommandsRegistry.registerCommand('workbench.action.files.save', () => { });
			registerAction2(class extends Action2 { constructor() { super({ id: 'workbench.action.other', title: 'x' }); } run() { } });
			CommandsRegistry.registerCommand('volt.sneaky', () => { });
		`,
	}, 'src/vs/workbench/contrib/files/browser/fileActions.ts');
	assert.deepEqual(found.map(({ id, problem }) => [id, problem]), [['volt.sneaky', 'has no visibility']]);
});

test('XPL-CMD: the real registrations of volt.browser.automate, volt.agentServer.allowNetwork and the checkpoint commands are internal', () => {
	const index = new SourceIndex();
	const visibilityOf = new Map();
	for (const file of [
		'src/vs/workbench/contrib/voltAgent/browser/preview/browserAutomation.ts',
		'src/vs/workbench/contrib/voltAgent/electron-browser/agentServerClient.contribution.ts',
		'src/vs/workbench/contrib/voltAgent/browser/review/agentChangesActions.ts',
		'src/vs/workbench/contrib/voltGitGraph/browser/voltGitGraph.module.ts',
		'src/vs/workbench/contrib/voltAgent/browser/workspace/agentSurfaceHost.ts',
	]) {
		assert.ok(fs.existsSync(path.join(root, file)), file);
		for (const entry of voltRegistrations(index, path.join(root, file))) {
			visibilityOf.set(entry.id, entry.visibility);
		}
	}
	for (const id of ['volt.browser.automate', 'volt.browser.pageUrl', 'volt.browser.preflight', 'volt.agentServer.allowNetwork', 'volt.agentServer.stopNetwork', 'voltAgent.checkpoint.restore', 'voltAgent.checkpoint.redo', 'voltAgent.checkpoint.beginTurn']) {
		assert.equal(visibilityOf.get(id), 'internal', id);
	}
	// What the git extension calls (extensions/git: blame hover links, GIT_EDITOR) stays reachable.
	assert.equal(visibilityOf.get('volt.gitGraph.open'), 'exported:git.read');
	assert.equal(visibilityOf.get('volt.gitGraph.askAgent'), 'exported:agents.send');
	assert.equal(visibilityOf.get('_volt.agentTools.editUntilClosed'), 'exported:ui.contribute');
});
