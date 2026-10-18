/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserCommentInit, VoltBrowserComments } from '../../browser/preview/browserCommentStore.js';
import { archiveResolvedCanvasComments, ICanvasDoc } from '../../browser/visuals/canvas/canvasModel.js';

function init(text: string, viewId = 'tab-1'): IBrowserCommentInit {
	return {
		viewId,
		sessionId: 'chat-1',
		url: 'http://localhost:3000/rooms',
		refs: [{ label: 'button', payload: '```browser_element\ntag: button\n```', bounds: { x: 10, y: 20, w: 80, h: 30 } }],
		text,
		prompt: `\`\`\`browser_element\ntag: button\n\`\`\` ${text}`,
		displayText: `button ${text}`,
		mentions: [{ kind: 'browser', label: 'button' }],
	};
}

suite('Browser comment store', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('numbers comments per tab and queues new ones for the next message', () => {
		const comments = store.add(new VoltBrowserComments());
		const first = comments.add(init('tighter padding'));
		const second = comments.add(init('bigger title'));
		const other = comments.add(init('elsewhere', 'tab-2'));
		assert.deepStrictEqual([first.number, second.number, other.number], [1, 2, 1]);
		assert.deepStrictEqual(comments.pending({ viewId: 'tab-1' }).map(comment => comment.id), [first.id, second.id]);
		assert.strictEqual(comments.pending({ sessionId: 'chat-1' }).length, 3);
	});

	test('takes only the ticked comments, as one message, and drops them from the batch', () => {
		const comments = store.add(new VoltBrowserComments());
		const first = comments.add(init('tighter padding'));
		const second = comments.add(init('bigger title'));
		comments.update(second.id, { picked: false });
		const message = comments.take({ viewId: 'tab-1' });
		assert.ok(message);
		assert.deepStrictEqual(message.ids, [first.id]);
		assert.ok(message.agentText.includes('Comment 1:'));
		assert.ok(message.agentText.includes('tighter padding'));
		assert.ok(!message.agentText.includes('bigger title'));
		// One annotation reads as itself.
		assert.strictEqual(message.displayText, 'button tighter padding');
		assert.strictEqual(comments.get(first.id), undefined);
		assert.deepStrictEqual(comments.list({ viewId: 'tab-1' }).map(comment => comment.id), [second.id]);
	});

	test('a batch reads as a numbered list, and numbering starts over once it is sent', () => {
		const comments = store.add(new VoltBrowserComments());
		comments.add(init('tighter padding'));
		comments.add(init('bigger title'));
		const message = comments.take({ viewId: 'tab-1' });
		assert.strictEqual(message?.displayText, '1. button tighter padding\n2. button bigger title');
		assert.strictEqual(message?.mentions.length, 2);
		assert.deepStrictEqual(comments.list({ viewId: 'tab-1' }), []);
		assert.strictEqual(comments.add(init('third')).number, 1);
	});

	test('canvas: archiving marks resolved comments and leaves the rest', () => {
		const doc = {
			id: 'c', title: 'T', version: 1, frames: [], links: [], createdAt: 1, updatedAt: 1,
			comments: [
				{ id: 'c1', anchor: { frame: 'f', x: 0, y: 0 }, text: 'a', status: 'resolved', author: 'user', at: 1 },
				{ id: 'c2', anchor: { frame: 'f', x: 0, y: 0 }, text: 'b', status: 'open', author: 'user', at: 1 },
			],
		} as unknown as ICanvasDoc;
		const next = archiveResolvedCanvasComments(doc, 5);
		assert.deepStrictEqual(next.comments.map(comment => [comment.id, !!comment.archived]), [['c1', true], ['c2', false]]);
		assert.strictEqual(archiveResolvedCanvasComments(next, 6), next);
	});
});
