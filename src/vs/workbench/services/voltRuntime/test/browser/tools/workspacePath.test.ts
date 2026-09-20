/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { displayPath, resolveWorkspaceUri } from '../../../browser/tools/workspacePath.js';

suite('Volt workspace path', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = URI.file('/Users/dev/app');

	test('resolves relative paths inside the workspace', () => {
		const uri = resolveWorkspaceUri(root, 'src/a.ts');
		assert.ok(uri);
		assert.strictEqual(displayPath(root, uri!), 'src/a.ts');
	});

	test('rejects paths that escape the workspace', () => {
		assert.strictEqual(resolveWorkspaceUri(root, '../secret'), undefined);
		assert.strictEqual(resolveWorkspaceUri(root, '/etc/passwd'), undefined);
	});
});
