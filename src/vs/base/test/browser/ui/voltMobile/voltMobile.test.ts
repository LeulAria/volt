/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isIconButton } from '../../../../browser/ui/voltMobile/voltTouchFeedback.js';
import { dismissAllVoltSurfaces, openVoltSurface, openVoltSurfaceCount, resetVoltSurfacesForTesting } from '../../../../browser/ui/voltMobile/voltSurfaces.js';
import { getVoltLayoutInsets, getVoltViewport, isVoltCompact } from '../../../../browser/ui/voltMobile/voltViewport.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../common/utils.js';

suite('Volt mobile primitives', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('viewport', () => {
		test('is off until the browser workbench installs it', () => {
			assert.strictEqual(getVoltViewport(), undefined);
			assert.strictEqual(isVoltCompact(), false);
			assert.deepStrictEqual(getVoltLayoutInsets(), { top: 0, right: 0, bottom: 0, left: 0 });
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
