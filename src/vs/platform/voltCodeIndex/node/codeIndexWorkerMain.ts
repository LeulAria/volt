/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server } from '../../../base/parts/ipc/node/ipc.cp.js';
import { CodeIndexEngine } from './codeIndexEngine.js';

// The code index process: forked on first use by VoltCodeIndexService, exits when idle.
const dataDir = process.env['VOLT_CODE_INDEX_DIR'];
if (!dataDir) {
	throw new Error('VOLT_CODE_INDEX_DIR is not set');
}

const server = new Server('voltCodeIndex');
const engine = new CodeIndexEngine(dataDir, message => console.log(message));
server.registerChannel('codeIndex', ProxyChannel.fromService(engine, new DisposableStore()));

process.once('disconnect', () => {
	void engine.dispose().finally(() => process.exit(0));
});
