/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_CHAT_BACKGROUND_DIM_SETTING, AGENT_CHAT_BACKGROUND_IN_CHATS_SETTING, AGENT_CHAT_BACKGROUND_PIXELS_SETTING, AGENT_CHAT_BACKGROUND_SETTING, agentChatBackgroundDim, resolveAgentChatBackground } from '../../common/agentChatBackground.js';

suite('agentChatBackground', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('no setting key is a prefix of another', () => {
		const keys = [AGENT_CHAT_BACKGROUND_SETTING, AGENT_CHAT_BACKGROUND_DIM_SETTING, AGENT_CHAT_BACKGROUND_PIXELS_SETTING, AGENT_CHAT_BACKGROUND_IN_CHATS_SETTING];
		for (const key of keys) {
			assert.deepStrictEqual(keys.filter(other => other !== key && other.startsWith(key)), [], key);
		}
	});

	test('built-in pictures by id, any case', () => {
		const orbit = resolveAgentChatBackground('orbit');
		assert.strictEqual(orbit.kind === 'preset' && orbit.preset.id, 'orbit');
		const harar = resolveAgentChatBackground(' Harar ');
		assert.strictEqual(harar.kind === 'preset' && harar.preset.id, 'harar');
	});

	test('none, empty and unset', () => {
		assert.deepStrictEqual(resolveAgentChatBackground('none'), { kind: 'none' });
		assert.deepStrictEqual(resolveAgentChatBackground('NONE'), { kind: 'none' });
		assert.deepStrictEqual(resolveAgentChatBackground('  '), { kind: 'none' });
		// Not a string (a broken settings.json): the default picture.
		const fallback = resolveAgentChatBackground(42);
		assert.strictEqual(fallback.kind === 'preset' && fallback.preset.id, 'orbit');
	});

	test('anything else is an image file', () => {
		assert.deepStrictEqual(resolveAgentChatBackground('/Users/me/Pictures/sky.jpg'), { kind: 'file', location: '/Users/me/Pictures/sky.jpg' });
		assert.deepStrictEqual(resolveAgentChatBackground('~/sky.png'), { kind: 'file', location: '~/sky.png' });
		assert.deepStrictEqual(resolveAgentChatBackground('https://example.com/sky.webp'), { kind: 'file', location: 'https://example.com/sky.webp' });
	});

	test('dim is a fraction, clamped, with a bright picture shaded further', () => {
		const orbit = resolveAgentChatBackground('orbit');
		assert.strictEqual(agentChatBackgroundDim(undefined, orbit), 0.4);
		assert.strictEqual(agentChatBackgroundDim(0, orbit), 0);
		assert.strictEqual(agentChatBackgroundDim(250, orbit), 0.9);
		assert.strictEqual(agentChatBackgroundDim(-5, orbit), 0);
		assert.strictEqual(agentChatBackgroundDim(40, resolveAgentChatBackground('harar')), 0.598);
		assert.strictEqual(agentChatBackgroundDim(40, resolveAgentChatBackground('/tmp/a.png')), 0.4);
	});
});
