/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_CHAT_BACKGROUND_DIM_SETTING, AGENT_CHAT_BACKGROUND_IN_CHATS_SETTING, AGENT_CHAT_BACKGROUND_PIXELS_SETTING, AGENT_CHAT_BACKGROUND_SETTING, agentChatBackgroundDim, agentChatDrawing, resolveAgentChatBackground } from '../../common/agentChatBackground.js';

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

	test('Orbit, Volt and Halftone are drawn live; pictures and files are not', () => {
		assert.strictEqual(agentChatDrawing(resolveAgentChatBackground('orbit')), 'orbit');
		assert.strictEqual(agentChatDrawing(resolveAgentChatBackground('Volt')), 'volt');
		assert.strictEqual(agentChatDrawing(resolveAgentChatBackground('halftone')), 'halftone');
		assert.strictEqual(agentChatDrawing(resolveAgentChatBackground('axum')), undefined);
		assert.strictEqual(agentChatDrawing(resolveAgentChatBackground('/tmp/orbit.png')), undefined);
		assert.strictEqual(agentChatDrawing(resolveAgentChatBackground('none')), undefined);
	});

	test('anything else is an image file', () => {
		assert.deepStrictEqual(resolveAgentChatBackground('/Users/me/Pictures/sky.jpg'), { kind: 'file', location: '/Users/me/Pictures/sky.jpg' });
		assert.deepStrictEqual(resolveAgentChatBackground('~/sky.png'), { kind: 'file', location: '~/sky.png' });
		assert.deepStrictEqual(resolveAgentChatBackground('https://example.com/sky.webp'), { kind: 'file', location: 'https://example.com/sky.webp' });
	});

	test('dim is a fraction, clamped, with a bright picture shaded further and a drawn one taking less', () => {
		const axum = resolveAgentChatBackground('axum');
		assert.strictEqual(agentChatBackgroundDim(undefined, axum), 0.55);
		assert.strictEqual(agentChatBackgroundDim(0, axum), 0);
		assert.strictEqual(agentChatBackgroundDim(250, axum), 0.9);
		assert.strictEqual(agentChatBackgroundDim(-5, axum), 0);
		assert.strictEqual(agentChatBackgroundDim(40, resolveAgentChatBackground('harar')), 0.598);
		assert.strictEqual(agentChatBackgroundDim(40, resolveAgentChatBackground('/tmp/a.png')), 0.4);
		// Orbit, Volt and Halftone keep the 40% they were drawn for at the default.
		assert.strictEqual(agentChatBackgroundDim(undefined, resolveAgentChatBackground('orbit')), 0.4);
		assert.strictEqual(agentChatBackgroundDim(250, resolveAgentChatBackground('halftone')), 0.655);
	});
});
