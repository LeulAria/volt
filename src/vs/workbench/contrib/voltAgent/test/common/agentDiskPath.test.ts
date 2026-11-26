/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentComparableUri, agentDiskPath, agentDiskUri } from '../../common/agentDiskPath.js';

const REMOTE = URI.parse('vscode-remote://127.0.0.1:9931/tmp/vphone-proj');
const FILE = URI.file('/tmp/vphone-proj');

suite('agentDiskPath', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a file folder is on disk everywhere', () => {
		assert.strictEqual(agentDiskUri(FILE, false), FILE);
		assert.strictEqual(agentDiskUri(FILE, true), FILE);
		assert.strictEqual(agentDiskPath(FILE, false), FILE.fsPath);
	});

	test('a remote folder is on disk only where the remote is this computer (the browser workbench)', () => {
		assert.strictEqual(agentDiskUri(REMOTE, false), undefined);
		assert.strictEqual(agentDiskPath(REMOTE, false), undefined);
		assert.strictEqual(agentDiskUri(REMOTE, true)?.toString(), FILE.toString());
		assert.strictEqual(agentDiskPath(REMOTE, true), FILE.fsPath);
	});

	test('other schemes and no folder have no disk path', () => {
		assert.strictEqual(agentDiskUri(URI.parse('vscode-vfs://github/owner/repo'), true), undefined);
		assert.strictEqual(agentDiskPath(undefined, true), undefined);
	});

	test('folders compare as paths whatever the scheme', () => {
		assert.strictEqual(agentComparableUri(REMOTE).toString(), agentComparableUri(FILE).toString());
		const other = URI.parse('vscode-vfs://github/owner/repo');
		assert.strictEqual(agentComparableUri(other), other);
	});
});
