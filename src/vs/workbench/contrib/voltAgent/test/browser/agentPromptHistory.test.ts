/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { AgentPromptHistoryNavigator, IAgentPromptHistoryEntry, readStoredPrompts, rememberPrompt } from '../../browser/composer/agentPromptHistory.js';

suite('Agent prompt history', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function prompts(...texts: string[]): () => IAgentPromptHistoryEntry[] {
		return () => texts.map(text => ({ text }));
	}

	test('Up walks older prompts once each, Down walks back to the text that was typed', () => {
		const history = new AgentPromptHistoryNavigator();
		let loads = 0;
		const load = () => { loads++; return prompts('fix the test', 'add a button', 'fix the test', '  ')(); };

		assert.strictEqual(history.older({ text: '' }, load)?.text, 'fix the test');
		assert.strictEqual(history.older({ text: 'fix the test' }, load)?.text, 'add a button');
		assert.strictEqual(history.older({ text: 'add a button' }, load), undefined, 'stops at the oldest');
		assert.strictEqual(loads, 1, 'the list is read once per browse');

		assert.strictEqual(history.newer('add a button')?.text, 'fix the test');
		assert.strictEqual(history.newer('fix the test')?.text, '');
		assert.strictEqual(history.isBrowsing(''), false, 'back at the draft, browsing is over');
		assert.strictEqual(history.newer(''), undefined);
	});

	test('the text being typed comes back after the newest prompt', () => {
		const history = new AgentPromptHistoryNavigator();
		assert.strictEqual(history.older({ text: 'half a thought' }, prompts('half a thought', 'earlier'))?.text, 'earlier', 'the draft itself is not offered');
		assert.strictEqual(history.newer('earlier')?.text, 'half a thought');
	});

	test('editing a recalled prompt ends browsing', () => {
		const history = new AgentPromptHistoryNavigator();
		assert.strictEqual(history.older({ text: '' }, prompts('one', 'two'))?.text, 'one');
		assert.strictEqual(history.isBrowsing('one!'), false);
		assert.strictEqual(history.newer('one!'), undefined, 'Down moves the caret instead');
		assert.strictEqual(history.older({ text: 'one!' }, prompts('one', 'two'))?.text, 'one', 'Up starts over from the edit');
	});

	test('sent prompts are kept newest first, once each, without images', () => {
		const storage = store.add(new InMemoryStorageService());
		const file = URI.file('/repo/a.ts');
		rememberPrompt(storage, { text: 'first', mentions: [{ label: 'a.ts', kind: 'file', resource: file }] });
		rememberPrompt(storage, { text: 'second', mentions: [{ label: 'Image1', kind: 'image', image: { id: 'img', mime: 'image/png', bytes: new Uint8Array([1]) } }] });
		rememberPrompt(storage, { text: '   ' });
		rememberPrompt(storage, { text: 'first' });

		const stored = readStoredPrompts(storage);
		assert.deepStrictEqual(stored.map(entry => entry.text), ['first', 'second']);
		assert.strictEqual(stored[1].mentions, undefined, 'image mentions are not stored');

		rememberPrompt(storage, { text: 'third', mentions: [{ label: 'a.ts', kind: 'file', resource: file }] });
		const revived = readStoredPrompts(storage)[0].mentions?.[0].resource;
		assert.ok(URI.isUri(revived));
		assert.strictEqual(revived.toString(), file.toString());
	});
});
