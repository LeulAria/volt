/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { orbitStopVisibility } from '../../browser/chat/agentChatOrbit.js';

suite('agentChatOrbit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const pickers = { left: 320, top: 239, right: 750, bottom: 261 };

	test('a stop name over a control is hidden', () => {
		assert.strictEqual(orbitStopVisibility({ left: 400, top: 245, right: 460, bottom: 258 }, [pickers], 14), 0);
	});

	test('a stop name touching a control is hidden', () => {
		assert.strictEqual(orbitStopVisibility({ left: 750, top: 245, right: 800, bottom: 258 }, [pickers], 14), 0);
	});

	test('a stop name fades in as it moves away', () => {
		assert.strictEqual(orbitStopVisibility({ left: 757, top: 245, right: 800, bottom: 258 }, [pickers], 14), 0.5);
		assert.strictEqual(orbitStopVisibility({ left: 400, top: 200, right: 460, bottom: 232 }, [pickers], 14), 0.5);
	});

	test('a stop name far from every control is fully shown', () => {
		assert.strictEqual(orbitStopVisibility({ left: 900, top: 100, right: 960, bottom: 113 }, [pickers], 14), 1);
		assert.strictEqual(orbitStopVisibility({ left: 900, top: 100, right: 960, bottom: 113 }, [], 14), 1);
	});

	test('the nearest control decides', () => {
		const composer = { left: 320, top: 271, right: 880, bottom: 381 };
		assert.strictEqual(orbitStopVisibility({ left: 890, top: 300, right: 950, bottom: 313 }, [pickers, composer], 14), 10 / 14);
	});
});
