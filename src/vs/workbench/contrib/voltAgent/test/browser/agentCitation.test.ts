/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { footnoteTarget } from '../../browser/blocks/agentMarkdown.js';
import { citationLabel, IAgentCitation, locateQuote, reviveCitation, serializeChatSelection, withCitationComment } from '../../browser/composer/agentCitation.js';
import { captureCitationSource, findCitation } from '../../browser/editor/agentCitationSource.js';

/** Two exchanges: a user prompt and an assistant reply each, the reply text split over nodes. */
function transcript(): HTMLElement {
	const doc = mainWindow.document;
	const thread = doc.createElement('div');
	thread.innerHTML = [
		'<div class="volt-agent-turn user" data-message-id="t1"><p>Explain the cache</p></div>',
		'<div class="volt-agent-turn agent" data-message-id="t1"><div class="volt-agent-thread-body"><p>The server <b>uses a cache</b> for reads.</p><p>It also uses a cache for writes.</p></div><div class="footer">Worked 3s</div></div>',
		'<div class="volt-agent-turn agent" data-message-id="t2"><div class="volt-agent-thread-body"><p>Second reply.</p></div></div>',
	].join('');
	doc.body.appendChild(thread);
	return thread;
}

function rangeOver(node: Node, start: number, end: number, endNode: Node = node): Range {
	const range = mainWindow.document.createRange();
	range.setStart(node, start);
	range.setEnd(endNode, end);
	return range;
}

suite('Agent citations', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const citation: IAgentCitation = { agentId: 'chat-1', messageId: 't1', quote: 'uses a cache', prefix: 'The server ', suffix: ' for reads.', start: 11 };

	test('the agent gets the old block plus the reply id and the comment', () => {
		assert.strictEqual(serializeChatSelection({ agentId: 'chat-1', quote: ' hello ' }), '\n```chat_selection\nagent_id: chat-1\nselected_text:\nhello\n```\n');
		const text = serializeChatSelection({ ...citation, comment: 'Which\ncache?' });
		const lines = text.split('\n');
		assert.strictEqual(lines[1], '```chat_selection');
		assert.ok(lines.includes('message_id: t1'));
		assert.ok(lines.includes('user_comment: Which cache?'));
		assert.ok(lines.some(line => line.startsWith('note: ') && line.includes('selected_text') && line.includes('user_comment')));
		// `selected_text:` still runs to the end of the block, as older readers expect.
		assert.deepStrictEqual(lines.slice(lines.indexOf('selected_text:')), ['selected_text:', 'uses a cache', '```', '']);
	});

	test('the chip shows the comment, else a short quote', () => {
		assert.strictEqual(citationLabel(citation), '"uses a cache"');
		assert.strictEqual(citationLabel({ quote: 'x', comment: '  why  this? ' }), 'why this?');
		assert.strictEqual(citationLabel({ quote: 'a'.repeat(60) }), `"${'a'.repeat(37)}..."`);
		assert.strictEqual(withCitationComment({ ...citation, comment: 'old' }, '').comment, undefined);
		assert.strictEqual(withCitationComment(citation, ' new ').comment, 'new');
	});

	test('stored citations are checked when read back', () => {
		assert.deepStrictEqual(reviveCitation(JSON.parse(JSON.stringify({ ...citation, comment: 'c' }))), { ...citation, comment: 'c' });
		assert.deepStrictEqual(reviveCitation({ agentId: 'a', quote: 'q', start: 'x', messageId: 3 }), { agentId: 'a', quote: 'q' });
		assert.strictEqual(reviveCitation({ quote: 'q' }), undefined);
		assert.strictEqual(reviveCitation(undefined), undefined);
	});

	test('a quote is found at its offset, by its context when the reply moved, or not at all', () => {
		const text = 'The server uses a cache for reads. It also uses a cache for writes.';
		assert.deepStrictEqual(locateQuote(text, citation), { start: 11, end: 23 });
		// Text was added in front: the offset is stale, the prefix and suffix pick the first occurrence.
		const moved = `Intro. ${text}`;
		assert.deepStrictEqual(locateQuote(moved, citation), { start: 18, end: 30 });
		// The second occurrence, by its own context.
		const second = { ...citation, prefix: 'It also ', suffix: ' for writes.', start: 0 };
		assert.deepStrictEqual(locateQuote(moved, second), { start: moved.indexOf('uses a cache for writes'), end: moved.indexOf('uses a cache for writes') + 12 });
		// Reflowed whitespace still matches.
		assert.deepStrictEqual(locateQuote('The server uses a\n  cache for reads.', citation), { start: 11, end: 25 });
		assert.strictEqual(locateQuote('Nothing here.', citation), undefined);
	});

	test('a selection inside one reply records its source; across messages it does not', () => {
		const thread = transcript();
		try {
			const bold = thread.querySelector('b')!.firstChild!;
			const source = captureCitationSource(rangeOver(bold, 0, bold.textContent!.length), thread);
			assert.deepStrictEqual(source, { messageId: 't1', quote: 'uses a cache', start: 11, prefix: 'The server ', suffix: ' for reads.It also uses a cache ' });

			const user = thread.querySelector('.volt-agent-turn.user p')!.firstChild!;
			assert.strictEqual(captureCitationSource(rangeOver(user, 0, 7, bold), thread), undefined);
			assert.strictEqual(captureCitationSource(rangeOver(user, 0, 7), thread), undefined);
			const second = thread.querySelectorAll('.volt-agent-thread-body p')[2].firstChild!;
			assert.strictEqual(captureCitationSource(rangeOver(bold, 0, 4, second), thread), undefined);
		} finally {
			thread.remove();
		}
	});

	test('a cited quote is found again in its reply, even after the reply changed', () => {
		const thread = transcript();
		try {
			const bold = thread.querySelector('b')!.firstChild!;
			const source = captureCitationSource(rangeOver(bold, 0, bold.textContent!.length), thread)!;
			assert.strictEqual(findCitation(thread, source)?.toString(), 'uses a cache');
			thread.querySelector('.volt-agent-turn.agent .volt-agent-thread-body')!.prepend(mainWindow.document.createTextNode('Update: '));
			const again = findCitation(thread, source);
			assert.strictEqual(again?.toString(), 'uses a cache');
			assert.strictEqual(again?.startContainer, bold);
			assert.strictEqual(findCitation(thread, { ...source, messageId: 'gone' }), undefined);
			assert.strictEqual(findCitation(thread, { ...source, quote: 'not in the reply' }), undefined);
		} finally {
			thread.remove();
		}
	});

	test('footnote refs point at their note and notes back at their first ref', () => {
		const body = mainWindow.document.createElement('div');
		body.className = 'volt-agent-thread-body';
		body.innerHTML = [
			'<div class="volt-agent-markdown"><p>Claim<sup class="volt-md-footnote-ref">1</sup> and<sup class="volt-md-footnote-ref">2</sup></p></div>',
			'<div class="volt-agent-markdown"><ol class="volt-md-footnotes" start="1"><li>One <span class="volt-md-footnote-back">↩</span></li></ol><ol class="volt-md-footnotes" start="2"><li>Two <span class="volt-md-footnote-back">↩</span></li></ol></div>',
		].join('');
		const [one, two] = Array.from(body.querySelectorAll<HTMLElement>('sup'));
		const backs = Array.from(body.querySelectorAll<HTMLElement>('.volt-md-footnote-back'));
		assert.strictEqual(footnoteTarget(one)?.textContent?.startsWith('One'), true);
		assert.strictEqual(footnoteTarget(two)?.textContent?.startsWith('Two'), true);
		assert.strictEqual(footnoteTarget(backs[1]), two);
		assert.strictEqual(footnoteTarget(backs[0]), one);
	});
});
