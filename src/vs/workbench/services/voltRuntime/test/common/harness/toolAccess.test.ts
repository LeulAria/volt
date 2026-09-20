/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { mergeGrantedGroups } from '../../../common/harness/intent.js';
import { actionForGroup, resourceForCall } from '../../../common/harness/toolAccess.js';
import { IVoltTool } from '../../../common/tools/tool.js';

suite('Volt tool access mapping', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shell maps to a command resource', () => {
		assert.strictEqual(actionForGroup('shell'), 'shell');
		assert.deepStrictEqual(resourceForCall(fake('shell', 'shell'), { command: 'npm test', title: 'tests' }), {
			type: 'command',
			value: 'npm test',
		});
	});

	test('ask mode cannot be granted shell', () => {
		assert.deepStrictEqual(mergeGrantedGroups(['read', 'web', 'meta'], ['shell', 'edit'], 'ask'), ['read', 'web', 'meta']);
	});

	test('agent mode can add shell to a fast session', () => {
		const granted = mergeGrantedGroups(['read', 'search', 'edit', 'meta'], ['shell'], 'agent');
		assert.ok(granted.includes('shell'));
		assert.ok(granted.includes('edit'));
	});
});

function fake(name: string, group: IVoltTool['group']): IVoltTool {
	return {
		name,
		group,
		kind: 'other',
		description: name,
		schema: {},
		parallelSafe: true,
		snippet: name,
		execute: async () => ({ callId: '', name, kind: 'other', text: '' }),
	};
}
