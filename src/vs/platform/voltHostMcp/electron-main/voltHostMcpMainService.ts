/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The host MCP server is plain Node; the main process serves it to windows, the agent server runs it itself.
export { checkHostMcpRequest, VoltHostMcpService as VoltHostMcpMainService } from '../node/voltHostMcpService.js';
