/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { firstScreenOf, readFirstScreen, saveFirstScreen } from '../../browser/editor/agentFirstScreen.js';

suite('agentFirstScreen', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const user = (text: string) => ({ kind: 'user', text });
	const agent = (text: string) => ({ kind: 'agent', text });
	const chat = (exchanges: number) => Array.from({ length: exchanges }, (_, i) => [user(`q${i}`), agent(`a${i}`)]).flat();

	test('the last whole exchanges that fit, starting at a prompt', () => {
		const parse = (raw: string | undefined) => raw ? (JSON.parse(raw) as { text: string }[]).map(m => m.text) : undefined;
		assert.deepStrictEqual(parse(firstScreenOf(chat(5), { messages: 6, chars: 1e6 })), ['q2', 'a2', 'q3', 'a3', 'q4', 'a4']);
		assert.deepStrictEqual(parse(firstScreenOf(chat(5), { messages: 5, chars: 1e6 })), ['q3', 'a3', 'q4', 'a4'], 'a reply without its prompt is left out');
		const one = JSON.stringify(user('q4')).length + JSON.stringify(agent('a4')).length + 4;
		assert.deepStrictEqual(parse(firstScreenOf(chat(5), { messages: 6, chars: one })), ['q4', 'a4'], 'the size cap counts whole messages');
		assert.strictEqual(firstScreenOf(chat(5), { messages: 6, chars: one - 1 }), undefined, 'not even the last exchange fits');
		assert.strictEqual(firstScreenOf([agent('only a reply')]), undefined);
		assert.strictEqual(firstScreenOf([]), undefined);
	});

	test('kept per chat for the next window, the most recent few chats', () => {
		const storage = store.add(new InMemoryStorageService());
		saveFirstScreen(storage, 'a', chat(2));
		assert.deepStrictEqual(readFirstScreen(storage, 'a'), chat(2));
		assert.strictEqual(readFirstScreen(storage, 'b'), undefined);
		saveFirstScreen(storage, 'a', []);
		assert.strictEqual(readFirstScreen(storage, 'a'), undefined, 'a chat with nothing to show forgets its old screen');
		for (let i = 0; i < 10; i++) {
			saveFirstScreen(storage, `c${i}`, chat(1));
		}
		assert.strictEqual(readFirstScreen(storage, 'c0'), undefined, 'the oldest go past eight chats');
		assert.strictEqual(readFirstScreen(storage, 'c1'), undefined);
		assert.deepStrictEqual(readFirstScreen(storage, 'c2'), chat(1));
		assert.deepStrictEqual(readFirstScreen(storage, 'c9'), chat(1));
	});

	test('a screen kept before the chat last changed is out of date', () => {
		const storage = store.add(new InMemoryStorageService());
		saveFirstScreen(storage, 'a', chat(1), 1000);
		assert.deepStrictEqual(readFirstScreen(storage, 'a', 1000), chat(1));
		assert.deepStrictEqual(readFirstScreen(storage, 'a', undefined), chat(1), 'when the chat is not known yet');
		assert.strictEqual(readFirstScreen(storage, 'a', 1001), undefined, 'the chat ran on after the window kept it');
	});
});
