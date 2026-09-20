/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatRunPlanSection } from '../../common/harness/contextPack.js';
import { detectRunPlanFromFiles } from '../../common/runPlan.js';

suite('Volt run plan', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('static html uses python http.server', () => {
		const plan = detectRunPlanFromFiles({ indexHtml: true });
		assert.strictEqual(plan.kind, 'static');
		assert.ok(plan.start?.includes('http.server'));
		assert.ok(plan.previewUrl?.includes('8080'));
	});

	test('vite script wins over static html', () => {
		const plan = detectRunPlanFromFiles({
			indexHtml: true,
			vite: true,
			packageJson: { scripts: { dev: 'vite' } },
			lock: 'pnpm',
		});
		assert.strictEqual(plan.kind, 'vite');
		assert.strictEqual(plan.start, 'pnpm run dev');
		assert.strictEqual(plan.previewUrl, 'http://localhost:5173/');
	});

	test('preview section stays compact and bans system open', () => {
		const hint = formatRunPlanSection({ kind: 'static', start: 'python3 -m http.server 8080 --bind 127.0.0.1', previewUrl: 'http://127.0.0.1:8080/' });
		assert.ok(hint.includes('in-app browser'));
		assert.ok(/never call open, xdg-open, or start/.test(hint));
		assert.ok(hint.includes('python3 -m http.server'));
		assert.ok(hint.length < 400);
	});
});
