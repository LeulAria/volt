/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { runPluginHost } from './pluginHostRuntime.js';

/**
 * The T2 plugin host's entry (spec H.1): `out/vs/platform/voltPlugins/node/pluginHostMain.js`,
 * started only by the supervisor (`node/pluginHost.ts`), as Node (`ELECTRON_RUN_AS_NODE=1`, never
 * `utilityProcess`, which has no sandbox and ignores `--disable-sigusr1`), inside the OS sandbox.
 * Its one channel is the socketpair on `VOLT_HOST_CHANNEL_FD`; without it, it exits at once.
 */

const fd = Number(process.env.VOLT_HOST_CHANNEL_FD);
delete process.env.VOLT_HOST_CHANNEL_FD;
process.on('uncaughtException', err => {
	process.stderr.write(`plugin host: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
process.on('unhandledRejection', err => {
	process.stderr.write(`plugin host: unhandled rejection: ${err instanceof Error ? err.message : String(err)}\n`);
});
if (!Number.isInteger(fd) || fd < 3) {
	process.stderr.write('plugin host: no channel\n');
	process.exit(2);
}
runPluginHost({ fd }).catch(err => {
	process.stderr.write(`plugin host: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exit(1);
});
