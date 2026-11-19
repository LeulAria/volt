/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isLocalGoodbye, localToolWords } from '../../common/localVoiceLine.js';
import { landedWords, replyProse } from '../../common/voiceCallBrain.js';

suite('Volt voice chat on this computer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only a goodbye on its own ends the call', () => {
		for (const text of ['Bye.', 'goodbye', 'Okay, bye!', 'Thanks, goodbye.', 'hang up', 'End the call', 'end call now', 'See you']) {
			assert.strictEqual(isLocalGoodbye(text), true, text);
		}
		for (const text of ['Say bye to the user in the footer', 'Add a hang up button', 'bye the way, fix the tests', 'Why does the call end early?']) {
			assert.strictEqual(isLocalGoodbye(text), false, text);
		}
	});

	test('a sent task is acknowledged by its receipt', () => {
		assert.strictEqual(localToolWords('send_task', { receipt: 'under way' }), 'On it.');
		assert.strictEqual(localToolWords('send_task', { receipt: 'under way', steered: true }), 'Got it. I passed that to the agent.');
		assert.strictEqual(localToolWords('send_task', { receipt: 'queued behind the current work', behind: 'x' }), 'Queued. It starts after the current work.');
		assert.strictEqual(localToolWords('send_task', { receipt: 'already under way' }), 'That is already under way.');
		assert.strictEqual(localToolWords('send_task', { relay: 'unreachable', spoken: '…' }), 'There is no chat open to send it to. Open a chat and try again.');
		assert.strictEqual(localToolWords('send_task', { relay: 'refused', spoken: '…' }), 'The agent needs you in the chat first.');
		assert.strictEqual(localToolWords('send_task', { error: 'The chat refused the message.' }), 'That did not go through. The chat refused the message.');
		assert.strictEqual(localToolWords('end_the_call', {}), 'Bye.');
		assert.strictEqual(localToolWords('stay_silent', {}), undefined);
	});

	test('landed work is read as the reply, or the outcome in a sentence', () => {
		assert.strictEqual(landedWords('done', 'tail', 'The whole reply.'), 'The whole reply.');
		assert.strictEqual(landedWords('done', 'tail', undefined), 'tail');
		assert.strictEqual(landedWords('done', undefined, '  '), 'The agent finished without a written reply.');
		assert.strictEqual(landedWords('needs-user', undefined, undefined), 'The agent needs you in the chat.');
		assert.strictEqual(landedWords('failed', 'boom', undefined), 'The work failed.');
		assert.strictEqual(landedWords('stopped', undefined, undefined), 'The work was stopped.');
	});

	test('a reply is read from its text segments, not its tool output and notices', () => {
		const message = {
			segments: [
				{ kind: 'notice' },
				{ kind: 'block', block: { type: 'terminal', output: 'README.md\n.git' } },
				{ kind: 'text', text: 'The project has one file, `README.md`.' },
				{ kind: 'text', text: '  ' },
				{ kind: 'text', text: 'Want me to add more?' },
			],
		};
		assert.strictEqual(replyProse(message), 'The project has one file, `README.md`.\n\nWant me to add more?');
		assert.strictEqual(replyProse({ segments: [{ kind: 'notice' }] }), undefined);
		assert.strictEqual(replyProse('plain'), undefined);
		assert.strictEqual(replyProse(undefined), undefined);
	});
});
