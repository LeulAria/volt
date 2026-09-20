/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProviderAccessBridge } from '../../../common/access/providerAccessBridge.js';
import { ClaudeAccessBridge } from './claudeBridge.js';
import { CodexAccessBridge } from './codexBridge.js';
import { CursorAccessBridge } from './cursorBridge.js';
import { DefaultAcpBridge } from './defaultAcpBridge.js';
import { OpenCodeAccessBridge } from './opencodeBridge.js';

const BRIDGES: IProviderAccessBridge[] = [
	new CodexAccessBridge(),
	new ClaudeAccessBridge(),
	new CursorAccessBridge('cursor-acp'),
	new CursorAccessBridge('grok'),
	new OpenCodeAccessBridge(),
	new DefaultAcpBridge('acp-generic'),
];

export function accessBridgeFor(providerId: string): IProviderAccessBridge {
	return BRIDGES.find(bridge => bridge.id === providerId) ?? new DefaultAcpBridge(providerId);
}
