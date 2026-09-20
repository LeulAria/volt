/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { IVoltTool, toolSchemas, visibleTools } from '../../../common/tools/tool.js';

suite('Volt capability groups', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const tools: IVoltTool[] = [
		stub('read_file', 'read', 'read'),
		stub('edit_file', 'edit', 'edit'),
		stub('shell', 'shell', 'execute'),
		stub('web_search', 'web', 'fetch'),
		stub('finish', 'meta', 'think'),
	];

	test('chat lane never sees edit or shell', () => {
		const intent = classifyIntent('how much is nissan kiks in UAE', 'agent');
		const visible = visibleTools(tools, intent.groups).map(tool => tool.name);
		assert.deepStrictEqual(visible, ['read_file', 'web_search', 'finish']);
		assert.ok(!toolSchemas(visibleTools(tools, intent.groups)).some(schema => schema.name === 'shell'));
	});

	test('fast lane sees edit but not shell', () => {
		const intent = classifyIntent('fix the typo in README.md', 'agent');
		assert.deepStrictEqual(visibleTools(tools, intent.groups).map(tool => tool.name), ['read_file', 'edit_file', 'finish']);
	});

	test('ask mode strips writes even if the text looks like an edit', () => {
		const intent = classifyIntent('fix the typo in README.md', 'ask');
		assert.ok(!visibleTools(tools, intent.groups).some(tool => tool.group === 'edit' || tool.group === 'shell'));
	});
});

function stub(name: string, group: IVoltTool['group'], kind: IVoltTool['kind']): IVoltTool {
	return {
		name,
		group,
		kind,
		description: name,
		schema: { type: 'object', properties: {} },
		parallelSafe: group === 'read' || group === 'web',
		snippet: name,
		execute: async () => ({ callId: '', name, kind, text: '' }),
	};
}
