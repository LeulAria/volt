/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BROWSER_SNAPSHOT_TOOL_NAME, isVoltHostTool, VOLT_HOST_TOOLS } from '../../common/hostTools.js';

suite('Volt host tools', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exposes browser snapshot as an optional tool', () => {
		const tool = VOLT_HOST_TOOLS.find(item => item.name === BROWSER_SNAPSHOT_TOOL_NAME);
		assert.ok(tool);
		assert.ok(tool.description.length > 0);
		assert.strictEqual(isVoltHostTool(BROWSER_SNAPSHOT_TOOL_NAME), true);
		assert.strictEqual(isVoltHostTool('Read'), false);
	});
});
