/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isDevReloadAsset, isDevReloadCss, isInitialCompileBurst, isDevReloadJs, requiresFullWindowReload, toOutRelativePath } from '../../common/devReload.js';

suite('Volt dev reload', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts js and css, ignores maps', () => {
		assert.strictEqual(isDevReloadAsset('vs/workbench/contrib/voltAgent/browser/editor/agentEditor.js'), true);
		assert.strictEqual(isDevReloadCss('vs/workbench/contrib/voltAgent/browser/media/agentEditor.css'), true);
		assert.strictEqual(isDevReloadJs('vs/workbench/contrib/voltAgent/browser/editor/agentEditor.js'), true);
		assert.strictEqual(isDevReloadAsset('vs/workbench/contrib/voltAgent/browser/editor/agentEditor.js.map'), false);
	});

	test('marks entrypoints and contributions as not live-applyable', () => {
		assert.strictEqual(requiresFullWindowReload('vs/workbench/contrib/voltAgent/electron-browser/voltDevReload.contribution.js'), true);
		assert.strictEqual(requiresFullWindowReload('vs/workbench/workbench.desktop.main.js'), true);
		assert.strictEqual(requiresFullWindowReload('vs/workbench/contrib/voltAgent/browser/editor/agentEditor.js'), false);
		assert.strictEqual(requiresFullWindowReload('vs/workbench/contrib/voltAgent/browser/media/agentEditor.css'), false);
	});

	test('treats a huge first write as compile burst', () => {
		assert.strictEqual(isInitialCompileBurst(3), false);
		assert.strictEqual(isInitialCompileBurst(20), true);
	});

	test('maps out paths to module-relative urls', () => {
		assert.strictEqual(
			toOutRelativePath('/repo/out', '/repo/out/vs/workbench/contrib/voltAgent/browser/editor/agentEditor.js'),
			'vs/workbench/contrib/voltAgent/browser/editor/agentEditor.js',
		);
	});
});
