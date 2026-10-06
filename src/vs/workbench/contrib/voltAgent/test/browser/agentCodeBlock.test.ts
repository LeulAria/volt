/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { renderCodeCard, runnableShellCommand } from '../../browser/blocks/agentCodeBlock.js';

suite('Agent code cards: Run in terminal', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('only finished shell blocks a terminal would read as shown are runnable', () => {
		assert.strictEqual(runnableShellCommand('bash', 'npm test\n'), 'npm test');
		assert.strictEqual(runnableShellCommand('sh', '$ git status\n$ git log -1\n'), 'git status\ngit log -1', 'a prompt prefix is not part of the command');
		assert.strictEqual(runnableShellCommand('ts', 'npm test'), undefined, 'not a shell block');
		assert.strictEqual(runnableShellCommand('bash', '   \n'), undefined);
		assert.strictEqual(runnableShellCommand('bash', 'docker run \\'), undefined, 'a line continuation waits for more');
		assert.strictEqual(runnableShellCommand('bash', 'echo safe‮rm -rf ~'), undefined, 'a bidi override could hide what runs');
	});

	test('the card offers Run only when the chat can run it', () => {
		const disposables = store.add(new DisposableStore());
		const ran: string[] = [];
		const withRun = renderCodeCard(mainWindow.document.createElement('div'), 'bash', 'npm test\n', { store: disposables, onRunInTerminal: command => ran.push(command) });
		const button = withRun.querySelector<HTMLButtonElement>('button[aria-label="Run in terminal"]');
		assert.ok(button);
		button.click();
		assert.deepStrictEqual(ran, ['npm test']);
		const without = renderCodeCard(mainWindow.document.createElement('div'), 'bash', 'npm test\n', { store: disposables });
		assert.strictEqual(without.querySelector('button[aria-label="Run in terminal"]'), null);
	});
});
