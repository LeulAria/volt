/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentTooltip } from '../../browser/chrome/agentTooltip.js';
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
});
