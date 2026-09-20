/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccessResource, PermissionAction } from '../access/accessTypes.js';
import { CapabilityGroup } from './lanes.js';
import { pickString } from '../tools/args.js';
import { IVoltTool } from '../tools/tool.js';

export function actionForGroup(group: CapabilityGroup): PermissionAction {
	switch (group) {
		case 'read': return 'read';
		case 'search': return 'search';
		case 'edit': return 'edit';
		case 'shell': return 'shell';
		case 'web': return 'web';
		case 'browser': return 'browser';
		case 'mcp': return 'mcp';
		case 'agents': return 'subagent';
		case 'git': return 'git';
		default: return 'question';
	}
}

export function resourceForCall(tool: IVoltTool, args: unknown): IAccessResource {
	if (tool.group === 'shell') {
		return { type: 'command', value: pickString(args, 'command', 'cmd') ?? tool.name };
	}
	if (tool.group === 'web') {
		return { type: 'url', value: pickString(args, 'url', 'query', 'q') ?? tool.name };
	}
	if (tool.group === 'browser' || tool.group === 'mcp' || tool.group === 'agents' || tool.group === 'meta') {
		return { type: 'tool', value: tool.name };
	}
	return { type: 'file', value: pickString(args, 'path', 'file', 'file_path', 'directory') ?? '*' };
}
