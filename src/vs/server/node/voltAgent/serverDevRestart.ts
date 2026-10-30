/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FSWatcher, watch } from 'fs';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';

/** Compiles come in bursts; wait for this much quiet before counting the code as changed. */
const SETTLE_MS = 3_000;
const CHECK_MS = 2_000;

/** Compiled code the server never loads: window and main-process code, tests. */
const NOT_LOADED = /[\\/](electron-browser|electron-main|test)[\\/]|\.(css|map)$/;

/**
 * Out of sources (`VSCODE_DEV`), the server keeps running the code it started with while the
 * watcher recompiles `out/`. Once the code changed and no agent is running, it stops; the next
 * window connection starts it again from the new code. A running agent is never cut off for this.
 */
export function restartWhenStale(outDir: string, idle: () => boolean, restart: () => void, logService: ILogService): IDisposable {
	let changedAt: number | undefined;
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(outDir, { recursive: true }, (_event, file) => {
			const name = file ? String(file) : '';
			if (name.endsWith('.js') && !NOT_LOADED.test(name)) {
				if (changedAt === undefined) {
					logService.info(`[volt agent server] its code was recompiled (${name}); restarting once no agent is running`);
				}
				changedAt = Date.now();
			}
		});
		watcher.on('error', () => watcher?.close());
	} catch (err) {
		logService.warn('[volt agent server] cannot watch the compiled code; restart it after changing it', err);
	}
	let restarting = false;
	const timer = setInterval(() => {
		if (!restarting && changedAt !== undefined && Date.now() - changedAt >= SETTLE_MS && idle()) {
			restarting = true;
			logService.info('[volt agent server] restarting to load the recompiled code');
			restart();
		}
	}, CHECK_MS);
	return toDisposable(() => {
		clearInterval(timer);
		watcher?.close();
	});
}
