/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentTooltip, setAgentTooltip, setIconButtonTooltip } from '../../browser/chrome/agentTooltip.js';
import { subagentHoverRows } from '../../browser/chrome/agentSubagents.js';

suite('Agent tooltip card', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a muted row without an icon is a quiet note, not a second title', () => {
		const disposables = store.add(new DisposableStore());
		const tooltip = disposables.add(new AgentTooltip());
		const anchor = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => anchor.remove() });
		const rows = subagentHoverRows({ key: 't1', title: 'Count files', modelLabel: 'Haiku 5.5', state: 'completed', stateLabel: 'Done', detail: 'Done. The project root was listed.', openable: true, cancellable: false, readOnly: true, multitask: false, source: 'volt' }, Date.now());
		tooltip.show(anchor, rows, { variant: 'card' });
		const titles = [...tooltip.domNode.querySelectorAll('.volt-agent-tooltip-card-title')].map(el => el.textContent);
		const notes = [...tooltip.domNode.querySelectorAll('.volt-agent-tooltip-card-note')].map(el => el.textContent);
		assert.deepStrictEqual(titles, ['Count files']);
		assert.deepStrictEqual(notes, ['Click to watch its chat beside this one (read only)']);
	});

	test('icon rows keep their muted label', () => {
		const disposables = store.add(new DisposableStore());
		const tooltip = disposables.add(new AgentTooltip());
		const anchor = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => anchor.remove() });
		tooltip.show(anchor, [{ label: 'Chat' }, { label: '~/repo', icon: Codicon.folder, muted: true }], { variant: 'card' });
		assert.strictEqual(tooltip.domNode.querySelectorAll('.volt-agent-tooltip-card-note').length, 0);
		assert.strictEqual(tooltip.domNode.querySelector('.volt-agent-tooltip-card-row .volt-agent-tooltip-label.muted')?.textContent, '~/repo');
	});

	test('a button with its menu open shows no tooltip over the menu', () => {
		const doc = mainWindow.document;
		const button = doc.body.appendChild(doc.createElement('button'));
		const label = button.appendChild(doc.createElement('span'));
		try {
			setAgentTooltip(button, 'Ask before commands and file changes.');
			const shown = () => [...doc.querySelectorAll('.volt-agent-tooltip:not(.hidden)')].filter(el => el.textContent?.includes('Ask before commands'));
			label.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
			assert.strictEqual(shown().length, 1, 'closed: the tooltip shows');
			doc.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			button.setAttribute('aria-expanded', 'true');
			label.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
			assert.strictEqual(shown().length, 0, 'open: nothing over the menu');
		} finally {
			doc.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			button.remove();
		}
	});

	test('an icon-only button is named by its tooltip', () => {
		const button = mainWindow.document.createElement('button');
		setIconButtonTooltip(button, 'Send');
		assert.strictEqual(button.getAttribute('aria-label'), 'Send');
		setIconButtonTooltip(button, 'Voice');
		assert.strictEqual(button.getAttribute('aria-label'), 'Voice');
	});
});
