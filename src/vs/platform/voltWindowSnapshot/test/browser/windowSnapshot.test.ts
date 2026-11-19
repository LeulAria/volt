/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { captureWindowSnapshot, collectRuntimeCss, selectorApplies } from '../../browser/windowSnapshotCapture.js';
import { isWindowSnapshotShown, paintWindowSnapshot, readSnapshotInput, removeWindowSnapshot } from '../../browser/windowSnapshotPaint.js';
import { canPaintVoltWindowSnapshot, IVoltWindowSnapshot, VOLT_WINDOW_SNAPSHOT_ID, VOLT_WINDOW_SNAPSHOT_INPUT_ID, VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS, voltWindowSnapshotKey } from '../../common/windowSnapshot.js';

suite('Volt window snapshot', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const doc = mainWindow.document;
	let root: HTMLElement;

	setup(() => {
		root = doc.createElement('div');
		root.className = 'snapshot-test-root';
		root.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;overflow:hidden';
		doc.body.appendChild(root);
	});

	teardown(() => {
		root.remove();
		removeWindowSnapshot(doc);
	});

	function snapshotOf(composer?: Parameters<typeof captureWindowSnapshot>[2]['composer']): IVoltWindowSnapshot {
		return captureWindowSnapshot(mainWindow, root, { key: 'k', baseTheme: 'vs-dark', sessionId: 's', composer });
	}

	test('keys: scope, then workspace, then the empty window\'s backup folder', () => {
		assert.strictEqual(voltWindowSnapshotKey({ voltWindowScope: 'a', workspace: { id: 'w' } }), 'scope:a');
		assert.strictEqual(voltWindowSnapshotKey({ workspace: { id: 'w' }, backupPath: '/b/123' }), 'workspace:w');
		assert.strictEqual(voltWindowSnapshotKey({ backupPath: '/u/Backups/1700000000' }), 'empty:1700000000');
		assert.strictEqual(voltWindowSnapshotKey({}), 'empty');
	});

	test('painted only for the same window, size, scale and theme', () => {
		const snapshot = snapshotOf();
		const win = { innerWidth: snapshot.width, innerHeight: snapshot.height, devicePixelRatio: snapshot.devicePixelRatio };
		assert.ok(canPaintVoltWindowSnapshot(snapshot, 'k', win, 'vs-dark'));
		assert.ok(!canPaintVoltWindowSnapshot(snapshot, 'other', win, 'vs-dark'));
		assert.ok(!canPaintVoltWindowSnapshot(snapshot, 'k', { ...win, innerWidth: win.innerWidth + 40 }, 'vs-dark'));
		assert.ok(!canPaintVoltWindowSnapshot(snapshot, 'k', { ...win, devicePixelRatio: win.devicePixelRatio + 1 }, 'vs-dark'));
		assert.ok(!canPaintVoltWindowSnapshot(snapshot, 'k', win, 'vs'));
		assert.ok(!canPaintVoltWindowSnapshot(undefined, 'k', win, 'vs-dark'));
	});

	test('keeps elements, classes, styles and text; drops handlers, ids, scripts; boxes frames', () => {
		root.innerHTML = '';
		const row = doc.createElement('div');
		row.className = 'row';
		row.id = 'row-1';
		row.setAttribute('onclick', 'alert(1)');
		row.setAttribute('style', 'color: red');
		row.textContent = 'Hello';
		root.appendChild(row);
		root.appendChild(doc.createElement('script'));
		const frame = doc.createElement('iframe');
		frame.style.cssText = 'width:120px;height:40px;border:0;display:block';
		root.appendChild(frame);
		const hidden = doc.createElement('div');
		hidden.style.display = 'none';
		hidden.textContent = 'not drawn';
		root.appendChild(hidden);

		const tree = snapshotOf().root;
		assert.ok(typeof tree !== 'string');
		const kids = tree.c ?? [];
		assert.strictEqual(kids.length, 2, 'the script and the hidden element are gone');
		const first = kids[0];
		assert.ok(typeof first !== 'string');
		assert.deepStrictEqual(first.a, { class: 'row', style: 'color: red' });
		assert.deepStrictEqual(first.c, ['Hello']);
		const box = kids[1];
		assert.ok(typeof box !== 'string');
		assert.strictEqual(box.t, 'div');
		assert.ok(box.a?.style.includes('width:120px') && box.a.style.includes('height:40px'));
		assert.strictEqual(box.c, undefined);
	});

	test('an element below the window keeps its box but not its content', () => {
		root.style.height = '5000px';
		root.style.overflow = 'visible';
		const far = doc.createElement('div');
		far.style.cssText = `margin-top:${mainWindow.innerHeight + 500}px;height:30px`;
		far.textContent = 'far away';
		root.appendChild(far);
		const tree = snapshotOf().root;
		assert.ok(typeof tree !== 'string');
		const kept = tree.c?.[0];
		assert.ok(kept && typeof kept !== 'string');
		assert.strictEqual(kept.c, undefined);
		assert.ok(kept.a?.style.includes('height:30px'));
	});

	test('rows above the window become one spacer of their height', () => {
		root.style.height = 'auto';
		root.style.overflow = 'visible';
		root.style.top = `${-3000}px`;
		for (let i = 0; i < 3; i++) {
			const row = doc.createElement('div');
			row.style.cssText = 'height:500px;margin:0';
			row.textContent = `old ${i}`;
			root.appendChild(row);
			root.appendChild(doc.createTextNode('\n'));
		}
		const onScreen = doc.createElement('div');
		onScreen.style.cssText = `margin-top:1500px;height:40px`;
		onScreen.textContent = 'latest';
		root.appendChild(onScreen);
		const tree = snapshotOf().root;
		assert.ok(typeof tree !== 'string');
		assert.strictEqual(tree.c?.length, 2, 'one spacer, then the row on screen');
		const spacer = tree.c[0];
		assert.ok(typeof spacer !== 'string');
		assert.ok(spacer.a?.style.includes('height:1500px'), spacer.a?.style);
		assert.strictEqual(spacer.c, undefined);
		const latest = tree.c[1];
		assert.ok(typeof latest !== 'string');
		assert.deepStrictEqual(latest.c, ['latest']);
	});

	test('paints a snapshot, keeps typed keys and Enter for the composer, and takes it away', () => {
		const lines = doc.createElement('div');
		lines.style.cssText = 'position:absolute;left:10px;top:200px;width:300px;height:20px';
		const editor = doc.createElement('div');
		editor.style.cssText = 'position:absolute;left:10px;top:200px;width:300px;height:20px';
		root.appendChild(editor);
		editor.appendChild(lines);
		const label = doc.createElement('span');
		label.className = 'title';
		label.textContent = 'Chat title';
		root.appendChild(label);
		const snapshot = snapshotOf({ editor, linesElement: lines, text: 'draft', placeholder: 'Ask' });

		assert.ok(paintWindowSnapshot(doc, snapshot));
		assert.ok(isWindowSnapshotShown(doc));
		assert.ok(doc.body.classList.contains(VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS));
		const host = doc.getElementById(VOLT_WINDOW_SNAPSHOT_ID)!;
		assert.ok(host.textContent?.includes('Chat title'));
		const input = doc.getElementById(VOLT_WINDOW_SNAPSHOT_INPUT_ID) as HTMLTextAreaElement;
		assert.strictEqual(input.value, 'draft');
		assert.strictEqual(input.placeholder, 'Ask');

		assert.deepStrictEqual(readSnapshotInput(doc), { text: 'draft', selectionStart: 5, selectionEnd: 5, changed: false, send: false, focused: doc.activeElement === input });
		input.value = 'draft and more';
		input.setSelectionRange(2, 4);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
		const typed = readSnapshotInput(doc)!;
		assert.strictEqual(typed.text, 'draft and more');
		assert.strictEqual(typed.changed, true);
		assert.strictEqual(typed.send, true);
		assert.deepStrictEqual([typed.selectionStart, typed.selectionEnd], [2, 4]);

		assert.ok(removeWindowSnapshot(doc));
		assert.ok(!isWindowSnapshotShown(doc));
		assert.ok(!doc.body.classList.contains(VOLT_WINDOW_SNAPSHOT_SHOWN_CLASS));
		assert.strictEqual(doc.head.querySelectorAll('style.volt-window-snapshot-style, style[data-volt-snapshot]').length, 0);
		assert.strictEqual(readSnapshotInput(doc), undefined);
	});

	test('LAUNCH-KEYS-1: keys typed before the snapshot was painted go after the draft, as typed text', () => {
		const lines = doc.createElement('div');
		lines.style.cssText = 'position:absolute;left:10px;top:200px;width:300px;height:20px';
		const editor = doc.createElement('div');
		editor.style.cssText = 'position:absolute;left:10px;top:200px;width:300px;height:20px';
		root.appendChild(editor);
		editor.appendChild(lines);

		let asked = 0;
		assert.ok(paintWindowSnapshot(doc, snapshotOf({ editor, linesElement: lines, text: 'draft ', placeholder: 'Ask' }), () => { asked++; return 'ade'; }));
		const input = doc.getElementById(VOLT_WINDOW_SNAPSHOT_INPUT_ID) as HTMLTextAreaElement;
		assert.strictEqual(asked, 1);
		assert.strictEqual(input.value, 'draft ade');
		// The caret after them; the text differs from the draft, so the composer that takes over takes it.
		assert.deepStrictEqual(readSnapshotInput(doc), { text: 'draft ade', selectionStart: 9, selectionEnd: 9, changed: true, send: false, focused: doc.activeElement === input });
		assert.ok(removeWindowSnapshot(doc));

		// Nothing typed: the draft alone, unchanged. A source that fails loses those keys only.
		assert.ok(paintWindowSnapshot(doc, snapshotOf({ editor, linesElement: lines, text: 'draft ', placeholder: 'Ask' }), () => ''));
		assert.strictEqual(readSnapshotInput(doc)?.changed, false);
		assert.ok(removeWindowSnapshot(doc));
		assert.ok(paintWindowSnapshot(doc, snapshotOf({ editor, linesElement: lines, text: 'draft ', placeholder: 'Ask' }), () => { throw new Error('gone'); }));
		assert.strictEqual(readSnapshotInput(doc)?.text, 'draft ');
		assert.ok(removeWindowSnapshot(doc));

		// A snapshot with no composer has no text area: the keys are not asked for (they stay with whoever keeps them).
		asked = 0;
		assert.ok(paintWindowSnapshot(doc, snapshotOf(), () => { asked++; return 'x'; }));
		assert.strictEqual(asked, 0);
		assert.strictEqual(readSnapshotInput(doc), undefined);
		assert.ok(removeWindowSnapshot(doc));
	});

	test('a stored snapshot is data: scripts, handlers and frames in it are never built', () => {
		const snapshot: IVoltWindowSnapshot = {
			version: 1, key: 'k', width: 1, height: 1, devicePixelRatio: 1, baseTheme: 'vs-dark', css: '', htmlClass: '', bodyClass: '', savedAt: 0,
			root: {
				t: 'div', a: { class: 'ok', onclick: 'alert(1)', id: 'x' }, c: [
					{ t: 'script', c: ['alert(1)'] },
					{ t: 'iframe', a: { src: 'https://example.com' } },
					{ t: 'img', a: { src: 'x', onerror: 'alert(1)' } },
					{ t: 'div', a: { style: 'background:url(javascript:alert(1))' } },
					{ t: 'svg', svg: 1, a: { viewBox: '0 0 10 10', onload: 'alert(1)' }, c: [{ t: 'path', a: { d: 'M0 0L10 10', fill: 'red' } }] },
					'text',
				],
			},
		};
		assert.ok(paintWindowSnapshot(doc, snapshot));
		const host = doc.getElementById(VOLT_WINDOW_SNAPSHOT_ID)!;
		assert.strictEqual(host.querySelectorAll('script, iframe, img').length, 0);
		assert.strictEqual(host.querySelector('[onclick], [onload], [onerror], #x'), null);
		const built = host.querySelector('.ok')!;
		assert.strictEqual((built.children[0] as HTMLElement).getAttribute('style'), null);
		const svg = built.querySelector('svg')!;
		assert.strictEqual(svg.namespaceURI, 'http://www.w3.org/2000/svg');
		assert.strictEqual(svg.getAttribute('viewBox'), '0 0 10 10');
		assert.strictEqual(svg.querySelector('path')?.getAttribute('d'), 'M0 0L10 10');
		assert.ok(built.textContent?.endsWith('text'));
	});

	test('runtime rules are kept only when the snapshot uses every class they name', () => {
		const used = new Set(['monaco-workbench', 'codicon', 'codicon-folder']);
		assert.ok(selectorApplies('.codicon-folder::before', used));
		assert.ok(selectorApplies('.monaco-workbench', used));
		assert.ok(selectorApplies(':root', used));
		assert.ok(selectorApplies('.nope, .monaco-workbench .codicon', used));
		assert.ok(!selectorApplies('.codicon-file::before', used));
		assert.ok(!selectorApplies('#id .codicon', used));
	});

	test('keeps the icon variables of icons the snapshot shows or a stylesheet names, drops the rest', () => {
		const style = mainWindow.document.createElement('style');
		style.textContent = `:root { --vscode-icon-vsnap-add-content: '+'; --vscode-icon-vsnap-add-font-family: 'codicon'; --vscode-icon-vsnap-close-content: 'x'; --vscode-icon-vsnap-close-font-family: 'codicon'; --vscode-icon-vsnap-chevron-content: 'v'; --vsnap-color: red; }
			.vsnap-twistie::before { content: var(--vscode-icon-vsnap-chevron-content); }
			:root { --vsnap-only-plain: 1px; }`;
		mainWindow.document.head.appendChild(style);
		try {
			const css = collectRuntimeCss(mainWindow.document, new Set(['codicon', 'codicon-vsnap-add', 'vsnap-twistie']));
			assert.ok(css.includes('--vscode-icon-vsnap-add-content'));
			assert.ok(css.includes('--vscode-icon-vsnap-add-font-family'));
			assert.ok(css.includes('--vscode-icon-vsnap-chevron-content'), 'named by a rule through var()');
			assert.ok(css.includes('--vsnap-color: red'));
			assert.ok(css.includes('--vsnap-only-plain'));
			assert.ok(!css.includes('--vscode-icon-vsnap-close-content'));
			assert.ok(!css.includes('--vscode-icon-vsnap-close-font-family'));
		} finally {
			style.remove();
		}
	});
});
