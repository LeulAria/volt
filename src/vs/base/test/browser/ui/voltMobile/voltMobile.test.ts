/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../browser/window.js';
import { findHorizontalScroller } from '../../../../browser/ui/voltMobile/voltDragScroll.js';
import { isIconButton } from '../../../../browser/ui/voltMobile/voltTouchFeedback.js';
import { dismissAllVoltSurfaces, openVoltSurface, openVoltSurfaceCount, resetVoltSurfacesForTesting } from '../../../../browser/ui/voltMobile/voltSurfaces.js';
import { getVoltLayoutInsets, getVoltViewport, isVoltCompact, voltTouchRowHeight } from '../../../../browser/ui/voltMobile/voltViewport.js';
import { installVoltTapClick } from '../../../../browser/ui/voltMobile/voltTapClick.js';
import { EventType as TouchEventType, GestureEvent } from '../../../../browser/touch.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../common/utils.js';

suite('Volt mobile primitives', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('viewport', () => {
		test('is off until the browser workbench installs it', () => {
			assert.strictEqual(getVoltViewport(), undefined);
			assert.strictEqual(isVoltCompact(), false);
			assert.deepStrictEqual(getVoltLayoutInsets(), { top: 0, right: 0, bottom: 0, left: 0 });
			assert.strictEqual(voltTouchRowHeight(22), 22, 'tree rows keep their desktop height off a phone');
		});
	});

	suite('touch feedback', () => {
		const control = (classes: string[], text = '') => ({
			classList: { contains: (name: string) => classes.includes(name) },
			textContent: text,
		}) as unknown as HTMLElement;

		test('a small square control without text is an icon button', () => {
			assert.strictEqual(isIconButton(control([]), { width: 28, height: 28 }), true);
			assert.strictEqual(isIconButton(control([]), { width: 36, height: 28 }), true);
		});

		test('labels, wide controls and rows are not', () => {
			assert.strictEqual(isIconButton(control([], 'Send'), { width: 28, height: 28 }), false);
			assert.strictEqual(isIconButton(control([]), { width: 120, height: 28 }), false);
			assert.strictEqual(isIconButton(control([]), { width: 64, height: 64 }), false);
			assert.strictEqual(isIconButton(control(['monaco-list-row']), { width: 28, height: 28 }), false);
		});

		test('explicit classes decide', () => {
			assert.strictEqual(isIconButton(control(['volt-touch-icon'], 'x'), { width: 120, height: 44 }), true);
			assert.strictEqual(isIconButton(control(['volt-touch-card']), { width: 28, height: 28 }), false);
		});
	});

	suite('drag scroll', () => {
		let root: HTMLElement;
		setup(() => {
			root = mainWindow.document.createElement('div');
			mainWindow.document.body.appendChild(root);
		});
		teardown(() => root.remove());

		/** A row 100px wide holding 300px of chips, with `overflow` sideways. */
		const row = (overflow: string) => {
			const element = root.appendChild(document.createElement('div'));
			element.style.cssText = `width: 100px; overflow-x: ${overflow}; white-space: nowrap;`;
			const chip = element.appendChild(document.createElement('button'));
			chip.style.cssText = 'display: inline-block; width: 300px;';
			return { element, chip };
		};

		test('finds the row a chip scrolls in', () => {
			const { element, chip } = row('auto');
			assert.strictEqual(findHorizontalScroller(chip, root), element);
		});

		test('skips rows that clip or have nothing more to show', () => {
			assert.strictEqual(findHorizontalScroller(row('hidden').chip, root), undefined);
			const { element, chip } = row('auto');
			chip.style.width = '50px';
			assert.strictEqual(findHorizontalScroller(chip, root), undefined, `${element.scrollWidth}`);
		});

		test('leaves text fields alone', () => {
			const { element } = row('auto');
			const input = element.appendChild(document.createElement('input'));
			assert.strictEqual(findHorizontalScroller(input, root), undefined);
		});
	});

	suite('tap click', () => {
		const sleep = () => new Promise(resolve => setTimeout(resolve, 5));

		/** A Tap as Gesture sends it: one event, dispatched to each target that holds the finger. */
		const tap = (initialTarget: Element, ...targets: Element[]) => {
			const event = mainWindow.document.createEvent('CustomEvent') as unknown as GestureEvent;
			event.initEvent(TouchEventType.Tap, false, true);
			event.initialTarget = initialTarget;
			event.pageX = 10;
			event.pageY = 10;
			for (const target of targets) {
				target.dispatchEvent(event);
			}
			return event;
		};

		function fixture() {
			const root = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
			const view = root.appendChild(mainWindow.document.createElement('div'));
			const button = view.appendChild(mainWindow.document.createElement('button'));
			const label = button.appendChild(mainWindow.document.createElement('span'));
			let clicks = 0;
			button.addEventListener('click', () => clicks++);
			return { root, view, button, label, clicks: () => clicks };
		}

		test('a tap a view took sends its click to the plain button under the finger', async () => {
			const f = fixture();
			const bridge = installVoltTapClick(f.root, () => true);
			try {
				tap(f.label, f.view);
				await sleep();
				assert.strictEqual(f.clicks(), 1);
			} finally {
				bridge.dispose();
				f.root.remove();
			}
		});

		test('no click when the control answers taps itself, a handler took the tap, or it is off', async () => {
			const f = fixture();
			let enabled = true;
			const bridge = installVoltTapClick(f.root, () => enabled);
			try {
				tap(f.label, f.button, f.view);
				await sleep();
				assert.strictEqual(f.clicks(), 0, 'the button is a gesture target of its own');

				f.view.addEventListener(TouchEventType.Tap, e => e.preventDefault(), { once: true });
				tap(f.label, f.view);
				await sleep();
				assert.strictEqual(f.clicks(), 0, 'a handler prevented the tap');

				f.button.disabled = true;
				tap(f.label, f.view);
				await sleep();
				assert.strictEqual(f.clicks(), 0, 'disabled');
				f.button.disabled = false;

				enabled = false;
				tap(f.label, f.view);
				await sleep();
				assert.strictEqual(f.clicks(), 0, 'not a touch-first window');
			} finally {
				bridge.dispose();
				f.root.remove();
			}
		});
	});

	suite('surfaces', () => {
		teardown(() => resetVoltSurfacesForTesting());

		test('each surface stacks above the last; closing one hands the top back', () => {
			const first = openVoltSurface({ dismiss: () => { }, dismissible: true });
			const second = openVoltSurface({ dismiss: () => { }, dismissible: true });
			assert.ok(second.zIndex > first.zIndex);
			assert.strictEqual(second.isTop(), true);
			assert.strictEqual(first.isTop(), false);
			second.dispose();
			assert.strictEqual(first.isTop(), true);
			first.dispose();
			assert.strictEqual(openVoltSurfaceCount(), 0);
		});

		test('closing everything dismisses the newest first', () => {
			const order: string[] = [];
			const entries: { dispose(): void }[] = [];
			for (const name of ['sheet', 'page']) {
				const entry = openVoltSurface({ dismiss: () => { order.push(name); entry.dispose(); }, dismissible: true });
				entries.push(entry);
			}
			dismissAllVoltSurfaces();
			assert.deepStrictEqual(order, ['page', 'sheet']);
			assert.strictEqual(openVoltSurfaceCount(), 0);
		});

		test('disposing twice is harmless', () => {
			const entry = openVoltSurface({ dismiss: () => { }, dismissible: false });
			entry.dispose();
			entry.dispose();
			assert.strictEqual(openVoltSurfaceCount(), 0);
		});
	});
});
