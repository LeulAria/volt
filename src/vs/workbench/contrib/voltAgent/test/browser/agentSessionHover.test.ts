/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createSessionHoverFolderIcon } from '../../browser/home/agentHomeIcons.js';
import { agentSessionHoverRows, agentSessionStatusNote } from '../../browser/home/agentSessionHover.js';

suite('Agent session hover card', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('last-run status row uses the clock icon for failed and interrupted', () => {
		assert.strictEqual(agentSessionStatusNote({ status: 'interrupted' }), 'The last run was interrupted');
		assert.strictEqual(agentSessionStatusNote({ status: 'error' }), 'The last run failed');
		assert.strictEqual(agentSessionStatusNote({ status: 'done' }), undefined);
		assert.strictEqual(agentSessionStatusNote({ status: 'cancelled' }), 'The last run was stopped');
		assert.strictEqual(agentSessionStatusNote({ status: 'error', summary: 'You\'ve hit your monthly spend limit' }), 'The last run stopped at a usage limit');

		const interrupted = agentSessionHoverRows('Testing', agentSessionStatusNote({ status: 'interrupted' }), [
			{ pathLabel: '~/Desktop/Agent-Test' },
		]);
		assert.deepStrictEqual(interrupted, [
			{ label: 'Testing' },
			{ label: 'The last run was interrupted', icon: Codicon.clock },
			{ label: '~/Desktop/Agent-Test', icon: createSessionHoverFolderIcon, muted: true },
		]);

		const failed = agentSessionHoverRows('Testing', agentSessionStatusNote({ status: 'error' }), [
			{ pathLabel: '~/Desktop/Agent-Test' },
		]);
		assert.strictEqual(failed[1]?.icon, Codicon.clock);
		assert.notStrictEqual(failed[1]?.icon, Codicon.bell);
	});

	test('includes the git branch when the session folder has one, and omits it when missing', () => {
		const withBranch = agentSessionHoverRows('Testing', undefined, [{
			pathLabel: '~/Desktop/Agent-Test',
			repo: { name: 'Agent-Test', owner: 'leularia', branch: 'main' },
		}]);
		assert.deepStrictEqual(withBranch, [
			{ label: 'Testing' },
			{ label: 'leularia/Agent-Test', detail: 'main', icon: Codicon.gitBranch },
			{ label: '~/Desktop/Agent-Test', icon: createSessionHoverFolderIcon, muted: true },
		]);

		const withoutBranch = agentSessionHoverRows('Testing', undefined, [{
			pathLabel: '~/Desktop/Agent-Test',
			repo: { name: 'Agent-Test', owner: 'leularia' },
		}]);
		assert.deepStrictEqual(withoutBranch, [
			{ label: 'Testing' },
			{ label: '~/Desktop/Agent-Test', icon: createSessionHoverFolderIcon, muted: true },
		]);

		const blankBranch = agentSessionHoverRows('Testing', undefined, [{
			pathLabel: '~/Desktop/Agent-Test',
			repo: { name: 'Agent-Test', branch: '   ' },
		}]);
		assert.deepStrictEqual(blankBranch, [
			{ label: 'Testing' },
			{ label: '~/Desktop/Agent-Test', icon: createSessionHoverFolderIcon, muted: true },
		]);
	});
});
