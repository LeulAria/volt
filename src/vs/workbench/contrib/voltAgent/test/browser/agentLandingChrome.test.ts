/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildLandingProjectList, landingWorkspaceName } from '../../browser/home/agentLandingModel.js';

suite('Agent landing chrome', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers the folder name for a single-folder workspace', () => {
		assert.strictEqual(landingWorkspaceName({ folderName: 'volt', workspaceLabel: 'volt (Workspace)' }), 'volt');
		assert.strictEqual(landingWorkspaceName({ workspaceLabel: 'volt' }), 'volt');
		assert.strictEqual(landingWorkspaceName({}), '');
	});

	test('prefers the workspace label for multi-root workspaces', () => {
		assert.strictEqual(landingWorkspaceName({
			folderName: 'apps',
			workspaceLabel: 'volt',
			multiRoot: true,
		}), 'volt');
		assert.strictEqual(landingWorkspaceName({
			folderName: 'apps',
			multiRoot: true,
		}), 'apps');
	});

	test('puts the current project first and drops duplicate recents', () => {
		const current = { uri: URI.file('/tmp/volt'), name: 'volt', current: true, workspace: false };
		const other = { uri: URI.file('/tmp/app'), name: 'app', current: false, workspace: false };
		const dup = { uri: URI.file('/tmp/volt'), name: 'volt-dup', current: false, workspace: false };
		assert.deepStrictEqual(
			buildLandingProjectList(current, [dup, other]).map(project => project.name),
			['volt', 'app'],
		);
		assert.deepStrictEqual(
			buildLandingProjectList(undefined, [other]).map(project => project.name),
			['app'],
		);
	});
});
