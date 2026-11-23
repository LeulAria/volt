/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { agentToolsPartId, hasSavedAgentTools } from '../../browser/workspace/agentToolsEditorPart.js';

suite('Agent tools tabs', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const grid = { serializedGrid: { root: { type: 'leaf', data: {}, size: 1 }, orientation: 0, width: 1, height: 1 }, activeGroup: 0, mostRecentActiveGroups: [] };

	test('a chat\'s tabs saved by any window are found, after a restart in another window too', () => {
		const storage = store.add(new InMemoryStorageService());
		assert.strictEqual(hasSavedAgentTools(storage, 'agent-1'), false);
		storage.store('volt.agent.toolsTabs/agent-1', JSON.stringify(grid), StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(hasSavedAgentTools(storage, 'agent-1'), true);
		assert.strictEqual(hasSavedAgentTools(storage, 'agent-2'), false);
	});

	test('the window\'s own copy still counts, and a broken entry does not', () => {
		const storage = store.add(new InMemoryStorageService());
		storage.store(`memento/${agentToolsPartId('agent-3')}`, JSON.stringify({ 'editorpart.state': grid }), StorageScope.WORKSPACE, StorageTarget.USER);
		assert.strictEqual(hasSavedAgentTools(storage, 'agent-3'), true);
		storage.store('volt.agent.toolsTabs/agent-4', '{not json', StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(hasSavedAgentTools(storage, 'agent-4'), false);
	});
});
