/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { compactTokens, isLiveCodeFence, LiveCodeCard, renderCodeCard, resolveEditorLineHeight, runnableShellCommand } from '../../browser/blocks/agentCodeBlock.js';

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
		// Reading the editor font settings is fine; creating the editor widget is what costs.
		const accessor = { get: () => ({ getValue: () => undefined }) };
		const instantiationService = { invokeFunction: (fn: (a: typeof accessor) => unknown) => fn(accessor), createInstance: () => { editors++; } } as unknown as IInstantiationService;
		const card = renderCodeCard(mainWindow.document.createElement('div'), 'ts', 'const a = 1;\nconst b = 2;\n', { store: disposables, instantiationService });
		assert.strictEqual(editors, 0);
		assert.ok(!card.classList.contains('has-editor'));
		assert.strictEqual(card.querySelectorAll('.volt-md-code-line').length, 2);
	});
});

suite('Agent code cards: a streaming fence grows in place', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('only plain code and diff fences are live; file cards, cited snippets are drawn whole', () => {
		assert.strictEqual(isLiveCodeFence('ts', undefined), true);
		assert.strictEqual(isLiveCodeFence(undefined, undefined), true);
		assert.strictEqual(isLiveCodeFence('diff', undefined), true);
		assert.strictEqual(isLiveCodeFence('ts', 'src/a.ts'), false, 'a file card');
		assert.strictEqual(isLiveCodeFence('12:20:src/a.ts', undefined), false, 'a cited snippet');
	});

	test('a chunk redraws the changed tail only; the shell and the lines above it keep their elements', () => {
		const disposables = store.add(new DisposableStore());
		const card = disposables.add(new LiveCodeCard({ store: disposables, streaming: true }));
		card.update('ts', 'const a = 1;\nconst b = 2;\nconst c', { store: disposables, streaming: true });
		const shell = card.element.querySelector('.volt-md-code-block');
		const lines = () => Array.from(card.element.querySelectorAll<HTMLElement>('.volt-md-code-line'));
		assert.ok(shell);
		assert.deepStrictEqual(lines().map(line => line.textContent), ['const a = 1;', 'const b = 2;', 'const c']);
		const [first, second, third] = lines();
		card.update('ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d', { store: disposables, streaming: true });
		const after = lines();
		assert.strictEqual(card.element.querySelector('.volt-md-code-block'), shell, 'the shell stays');
		assert.strictEqual(after[0], first);
		assert.strictEqual(after[1], second);
		assert.notStrictEqual(after[2], third, 'the line that changed is drawn again');
		assert.deepStrictEqual(after.map(line => line.textContent), ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d']);
		// The same text again changes nothing.
		card.update('ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d', { store: disposables, streaming: true });
		assert.deepStrictEqual(lines(), after);
	});

	test('a diff fence keeps its +/- rows and classifies the new ones', () => {
		const disposables = store.add(new DisposableStore());
		const card = disposables.add(new LiveCodeCard({ store: disposables, streaming: true }));
		card.update('diff', '-  const a = 1;\n+  const a', { store: disposables, streaming: true });
		assert.ok(card.element.querySelector('.volt-md-code-block.diff'));
		const rows = () => Array.from(card.element.querySelectorAll<HTMLElement>('.volt-md-diff-line'));
		assert.deepStrictEqual(rows().map(row => [row.classList.contains('removed') ? '-' : row.classList.contains('added') ? '+' : ' ', row.textContent]), [['-', '  const a = 1;'], ['+', '  const a']]);
		const [removed] = rows();
		card.update('diff', '-  const a = 1;\n+  const a = 2;\n   done', { store: disposables, streaming: true });
		assert.strictEqual(rows()[0], removed, 'the settled row keeps its element');
		assert.deepStrictEqual(rows().map(row => row.textContent), ['  const a = 1;', '  const a = 2;', '  done']);
		assert.ok(rows()[2].classList.contains('context'));
	});
});

suite('Agent code cards: line height', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads editor.lineHeight as the editor does: pixels, a multiple of the font size, or the default', () => {
		assert.strictEqual(resolveEditorLineHeight(20, 12), 20, 'pixels');
		assert.strictEqual(resolveEditorLineHeight(1.55, 12), 19, 'the phone default is a multiple, not 1.55px');
		assert.strictEqual(resolveEditorLineHeight(0, 12), 18, '0 is 1.5 times the font size');
		assert.strictEqual(resolveEditorLineHeight(undefined, 14), 21);
		assert.strictEqual(resolveEditorLineHeight(0.2, 12), 8, 'never under the minimum');
	});
});
