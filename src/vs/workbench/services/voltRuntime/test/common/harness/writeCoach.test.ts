/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { noteWriteFail, noteWriteOk, resetWriteCoach, writeFailCoaching, writeFailCount } from '../../../common/harness/writeCoach.js';

suite('Volt write coach', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => resetWriteCoach());

	test('escalates coaching across consecutive empty writes', () => {
		assert.ok(/required/.test(writeFailCoaching('a.ts', noteWriteFail('a.ts'))));
		assert.ok(/skeleton/.test(writeFailCoaching('a.ts', noteWriteFail('a.ts'))));
		assert.ok(/Do not call write_file/.test(writeFailCoaching('a.ts', noteWriteFail('a.ts'))));
		assert.strictEqual(writeFailCount('a.ts'), 3);
		noteWriteOk('a.ts');
		assert.strictEqual(writeFailCount('a.ts'), 0);
	});
});
