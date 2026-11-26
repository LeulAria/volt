/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { readableModelLabel } from '../../common/models/modelMeta.js';

suite('readableModelLabel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names a harness model id the way people read it', () => {
		assert.strictEqual(readableModelLabel('claude-opus-5-5[1m]'), 'Opus 5.5 · 1M');
		assert.strictEqual(readableModelLabel('claude-opus-5-5'), 'Opus 5.5');
		assert.strictEqual(readableModelLabel('claude-sonnet-5-5-20261001'), 'Sonnet 5.5');
		assert.strictEqual(readableModelLabel('claude-haiku-5'), 'Haiku 5');
		assert.strictEqual(readableModelLabel('gpt-5.6-sol'), 'GPT 5.6 Sol');
	});

	test('keeps a label that already reads as a name', () => {
		assert.strictEqual(readableModelLabel('Opus 5.5'), 'Opus 5.5');
		assert.strictEqual(readableModelLabel('Opus 5.5 High'), 'Opus 5.5 High');
		assert.strictEqual(readableModelLabel('default'), 'default');
		assert.strictEqual(readableModelLabel(''), undefined);
		assert.strictEqual(readableModelLabel(undefined), undefined);
	});
});
