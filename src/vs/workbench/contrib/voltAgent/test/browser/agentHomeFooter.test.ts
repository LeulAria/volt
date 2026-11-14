/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentHomeFooterIn, onDidChangeAgentHomeFooters, registerAgentHomeFooter } from '../../browser/home/agentHomeFooter.js';

suite('agentHomeFooter', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the first footer in the container, in page order; a footer going away is announced', () => {
		const doc = mainWindow.document;
		const container = doc.createElement('div');
		const elsewhere = doc.createElement('div');
		const first = container.appendChild(doc.createElement('div'));
		const second = container.appendChild(doc.createElement('div'));
		const outside = elsewhere.appendChild(doc.createElement('div'));
		let changes = 0;
		store.add(onDidChangeAgentHomeFooters(() => changes++));
		assert.strictEqual(agentHomeFooterIn(container), undefined);
		const b = registerAgentHomeFooter(second);
		store.add(registerAgentHomeFooter(outside));
		const a = registerAgentHomeFooter(first);
		assert.strictEqual(changes, 3);
		assert.strictEqual(agentHomeFooterIn(container), first, 'page order, not the order they were announced in');
		a.dispose();
		assert.strictEqual(changes, 4);
		assert.strictEqual(agentHomeFooterIn(container), second);
		b.dispose();
		b.dispose();
		assert.strictEqual(changes, 5, 'once per footer');
		assert.strictEqual(agentHomeFooterIn(container), undefined);
	});
});
