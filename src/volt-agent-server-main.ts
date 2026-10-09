/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Volt agent server: the agent runtime, orchestrator and chat history in one long-running
// process per profile, outliving the windows that connect to it. Started by Volt (launchd keeps it
// alive on macOS) as Electron in Node mode, so native modules match the app's build.

import './bootstrap-server.js'; // this MUST come before other imports as it changes global state
import { removeGlobalNodeJsModuleLookupPaths } from './bootstrap-node.js';
import { bootstrapESM } from './bootstrap-esm.js';
import { product } from './bootstrap-meta.js';
import { resolveNLSConfiguration } from './vs/base/node/nls.js';

const nlsConfiguration = await resolveNLSConfiguration({ userLocale: 'en', osLocale: 'en', commit: product.commit, userDataPath: '', nlsMetadataPath: import.meta.dirname });
process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfiguration);
process.env['VSCODE_HANDLES_SIGPIPE'] = 'true';
removeGlobalNodeJsModuleLookupPaths();
await bootstrapESM();

const { main } = await import('./vs/server/node/voltAgent/agentServerMain.js');
await main(process.argv.slice(2));
