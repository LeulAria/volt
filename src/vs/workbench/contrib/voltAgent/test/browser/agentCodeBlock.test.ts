/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { compactTokens, renderCodeCard, runnableShellCommand } from '../../browser/blocks/agentCodeBlock.js';

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

suite('Agent code cards: cost', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function span(className: string, text: string): HTMLElement {
		const el = mainWindow.document.createElement('span');
		el.className = className;
		el.textContent = text;
		return el;
	}

	test('highlighted tokens fold whitespace and same-class neighbours into fewer spans', () => {
		const out = compactTokens([span('mtk4', 'export'), span('mtk1', ' '), span('mtk4', 'function'), span('mtk1', ' '), span('mtk9', 'f'), span('mtk1', '('), span('mtk1', ')')]);
		assert.deepStrictEqual(out.map(node => [(node as HTMLElement).className, node.textContent]), [['mtk4', 'export function '], ['mtk9', 'f'], ['mtk1', '()']]);
		const underlined = compactTokens([span('mtk3 mtku', 'link'), span('mtk1', ' '), span('mtk3', 'x')]);
		assert.strictEqual(underlined.length, 3, 'whitespace does not join an underlined token');
	});

	test('a card renders highlighted lines and creates no editor before it is on screen', () => {
		const disposables = store.add(new DisposableStore());
		let editors = 0;
		const instantiationService = { invokeFunction: () => { editors++; }, createInstance: () => { editors++; } } as unknown as IInstantiationService;
		const card = renderCodeCard(mainWindow.document.createElement('div'), 'ts', 'const a = 1;\nconst b = 2;\n', { store: disposables, instantiationService });
		assert.strictEqual(editors, 0);
		assert.ok(!card.classList.contains('has-editor'));
		assert.strictEqual(card.querySelectorAll('.volt-md-code-line').length, 2);
	});
});
