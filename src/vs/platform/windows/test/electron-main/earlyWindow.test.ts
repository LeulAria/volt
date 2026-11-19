/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as electron from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { EARLY_WINDOW_KEY } from '../../common/earlyWindow.js';
import { adoptEarlyWindow, isEarlyWindowProcess } from '../../electron-main/earlyWindow.js';

suite('earlyWindow (electron-main)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const globals = globalThis as Record<string, unknown>;

	function page(processId: number, destroyed = false) {
		return { isDestroyed: () => destroyed, close: () => { }, getZoomFactor: () => 1, setZoomFactor: () => { }, mainFrame: { processId } };
	}

	function publish(view: { webContents: ReturnType<typeof page> } | undefined) {
		const state = {
			win: { isDestroyed: () => false, contentView: { removeChildView: () => { } } },
			view,
			channel: 'c',
			url: 'vscode-file://vscode-app/workbench.html',
			options: {},
			webPreferences: {},
			failed: false,
			taken: false,
			releaseProtocols: () => ({ resources: [], files: [] }),
			detach: () => { },
			dispose: () => { },
		};
		globals[EARLY_WINDOW_KEY] = state;
		return state;
	}

	teardown(() => {
		delete globals[EARLY_WINDOW_KEY];
	});

	test('trusts only the launch page renderer while the application starts', () => {
		assert.strictEqual(isEarlyWindowProcess(7), false, 'no launch window');

		publish({ webContents: page(7) });
		assert.strictEqual(isEarlyWindowProcess(7), true);
		assert.strictEqual(isEarlyWindowProcess(8), false);

		publish({ webContents: page(7, true) });
		assert.strictEqual(isEarlyWindowProcess(7), false, 'destroyed page');
	});

	test('keeps trusting the page after a code window adopted it', () => {
		publish({ webContents: page(9) });
		const adopted = adoptEarlyWindow({} as electron.BrowserWindowConstructorOptions, 'vscode-file://vscode-app/workbench.html', () => { });
		assert.ok(adopted?.view, 'page adopted');
		assert.strictEqual(isEarlyWindowProcess(9), true);
		assert.strictEqual(isEarlyWindowProcess(10), false);
	});
});
