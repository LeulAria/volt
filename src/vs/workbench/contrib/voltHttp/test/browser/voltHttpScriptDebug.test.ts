/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { HttpBreaksPanel, HttpScriptBreakpoints, HttpTestDetail } from '../../browser/voltHttpScriptDebug.js';
import { IHttpExchangeTest } from '../../browser/voltHttpService.js';
import { httpScriptRuntime, IHttpScriptBreak } from '../../common/httpScriptRuntime.js';

suite('HTTP client script debugging UI', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let copied: string[];
	let host: HTMLElement;

	setup(() => {
		instantiationService = workbenchInstantiationService(undefined, disposables);
		copied = [];
		instantiationService.stub(IClipboardService, { writeText: async (text: string) => { copied.push(text); } });
		host = mainWindow.document.createElement('div');
		host.style.width = '700px';
		host.style.height = '400px';
		mainWindow.document.body.appendChild(host);
	});

	teardown(() => host.remove());

	const texts = (root: HTMLElement, selector: string): string[] => [...root.querySelectorAll(selector)].map(element => element.textContent ?? '');

	test('a failed test shows its message, Expected and Actual with the changed lines, its assertions and console lines', () => {
		const failed: IHttpExchangeTest = {
			name: 'body matches', passed: false, durationMs: 3.4, errorLine: 7,
			error: 'expected {"a":1} to deeply equal {"a":2}',
			expected: '{\n  "a": 2\n}', actual: '{\n  "a": 1\n}',
			assertions: [{ passed: true, message: 'expected 200 to equal 200', operator: 'equal' }, { passed: false, message: 'expected {"a":1} to deeply equal {"a":2}', operator: 'deep equal' }],
		};
		const revealed: number[] = [];
		let closed = 0;
		const detail = disposables.add(instantiationService.createInstance(HttpTestDetail, host, failed, {
			line: 4,
			logs: [{ level: 'log', text: 'mine', test: 'body matches' }, { level: 'log', text: 'not mine' }, { level: 'warn', text: 'other', test: 'other' }],
			onReveal: line => revealed.push(line),
			onClose: () => closed++,
		}));
		const root = detail.element;
		assert.deepStrictEqual(texts(root, '.volt-http-test-badge'), ['FAIL']);
		assert.deepStrictEqual(texts(root, '.volt-http-debug-detail-name'), ['body matches']);
		assert.deepStrictEqual(texts(root, '.volt-http-debug-message-text'), [failed.error]);
		assert.deepStrictEqual(texts(root, '.volt-http-debug-side-label'), ['Expected', 'Actual']);
		assert.deepStrictEqual(texts(root, '.volt-http-debug-side.expected .removed'), ['  "a": 2']);
		assert.deepStrictEqual(texts(root, '.volt-http-debug-side.actual .added'), ['  "a": 1']);
		assert.deepStrictEqual(texts(root, '.volt-http-debug-row-text'), ['expected 200 to equal 200', failed.error, 'mine']);

		(root.querySelector('.volt-http-debug-line-link') as HTMLButtonElement).click();
		(root.querySelector('[aria-label="Go to Test"]') as HTMLButtonElement).click();
		assert.deepStrictEqual(revealed, [7, 4]);
		(root.querySelector('[aria-label="Copy as Text"]') as HTMLButtonElement).click();
		assert.ok(copied[0].startsWith('FAIL body matches'), copied[0]);
		assert.ok(copied[0].includes('Expected:\n{\n  "a": 2\n}') && copied[0].includes('[fail] expected {"a":1}') && copied[0].includes('[log] mine'), copied[0]);
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(closed, 1);
		assert.strictEqual(root.querySelector('[aria-label="Run Test"]'), null, 'no Run Test without onRun');
	});

	test('a test with nothing beyond its name says so', () => {
		const detail = disposables.add(instantiationService.createInstance(HttpTestDetail, host, { name: 'empty', passed: true }, { onClose: () => { } }));
		assert.deepStrictEqual(texts(detail.element, '.volt-http-debug-empty'), ['This test made no assertions.']);
		assert.deepStrictEqual(texts(detail.element, '.volt-http-test-badge'), ['PASS']);
		detail.dispose();
		assert.strictEqual(host.childElementCount, 0, 'disposing removes the panel');
	});

	const recorded = (): IHttpScriptBreak[] => httpScriptRuntime({
		script: `let n = 0;\nfor (let i = 0; i < 3; i++) {\n	n += i;\n}\nconst done = { n };`,
		phase: 'preRequest',
		request: { name: 'r', method: 'GET', url: 'https://x.test', headers: [] },
		variables: { environment: {}, collection: {}, globals: {}, local: {} },
		breakpoints: [3, 5],
	}).breaks!;

	test('the stops panel steps through the recorded stops and shows each one\'s variables', () => {
		const stops = recorded();
		assert.deepStrictEqual(stops.map(stop => stop.line), [3, 3, 3, 5]);
		const chosen: number[] = [];
		const panel = disposables.add(instantiationService.createInstance(HttpBreaksPanel, host, stops, { selected: 1, onSelect: (_stop, index) => chosen.push(index), onClose: () => { } }));
		panel.layout(700, 400);
		const root = panel.element;
		assert.ok(root.classList.contains('wide'));
		assert.deepStrictEqual(texts(root, '.volt-http-debug-breaks-title'), ['Stop 2 of 4']);
		assert.deepStrictEqual(chosen, [1]);
		assert.ok(texts(root, '.volt-http-debug-var-name').includes('Local'));
		assert.ok(texts(root, '.volt-http-debug-var-name').includes('i'), 'Local is open');

		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true }));
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true }));
		assert.deepStrictEqual(texts(root, '.volt-http-debug-breaks-title'), ['Stop 4 of 4']);
		assert.strictEqual((root.querySelector('[aria-label="Next Stop (F10)"]') as HTMLButtonElement).disabled, true);
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		(root.querySelector('[aria-label="First Stop"]') as HTMLButtonElement).click();
		assert.deepStrictEqual(chosen, [1, 2, 3, 2, 0]);

		panel.layout(400, 400);
		assert.ok(!root.classList.contains('wide'), 'stacked when narrow');
	});

	test('the stops panel says when no breakpoint was reached', () => {
		const panel = disposables.add(instantiationService.createInstance(HttpBreaksPanel, host, [], { onSelect: () => { }, onClose: () => { } }));
		panel.layout(400, 200);
		assert.deepStrictEqual(texts(panel.element, '.volt-http-debug-breaks-title'), ['No stops']);
		assert.strictEqual(panel.element.querySelectorAll('.volt-http-debug-empty').length, 1);
		assert.ok((panel.element.querySelector('.volt-http-debug-note')?.textContent ?? '').includes('does not pause'));
	});

	test('breakpoints in the editor stay with their text and report when they move', () => {
		const store = new DisposableStore();
		const model = store.add(createTextModel('const a = 1;\n\nconst b = a;\nconsole.log(b);'));
		const editor = store.add(createTestCodeEditor(model));
		const reports: number[][] = [];
		const breakpoints = store.add(new HttpScriptBreakpoints(editor, [3, 4, 99], lines => reports.push(lines)));
		assert.deepStrictEqual(breakpoints.lines, [3, 4], 'a line past the end is dropped');
		assert.strictEqual(editor.getOption(EditorOption.glyphMargin), true, 'the gutter shows breakpoints');

		model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '// new\n' }]);
		assert.deepStrictEqual(breakpoints.lines, [4, 5]);
		assert.deepStrictEqual(reports, [[4, 5]]);

		breakpoints.setLines([1]);
		assert.deepStrictEqual(breakpoints.lines, [1]);
		assert.deepStrictEqual(reports.length, 1, 'setLines does not report');

		breakpoints.showStop(4);
		assert.strictEqual(model.getAllDecorations().filter(decoration => decoration.options.className === 'volt-http-debug-stop-line' && decoration.range.startLineNumber === 4).length, 1);
		breakpoints.showStop(undefined);
		assert.strictEqual(model.getAllDecorations().filter(decoration => decoration.options.className === 'volt-http-debug-stop-line').length, 0);
		store.dispose();
	});
});
