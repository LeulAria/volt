/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { handoffPath, handoffToolCall, IHandoffActivity, IHandoffFile, IHandoffToolCall } from '../../../../services/voltRuntime/common/contextHandoff.js';
import { AgentSegment, classifyToolActivity } from './agentBlocks.js';

/**
 * What a saved reply did besides talking, read back from its transcript rows: commands, reads,
 * searches and other tools by what they touched, files by path. A chat restored from history
 * hands this to the next model the same way a live run does.
 */
export function handoffActivityOf(segments: readonly AgentSegment[] | undefined, cwd?: string): IHandoffActivity | undefined {
	const tools: IHandoffToolCall[] = [];
	const files: IHandoffFile[] = [];
	for (const segment of segments ?? []) {
		if (segment.kind === 'activity') {
			const item = segment.item;
			if (item.hidden || (item.kind !== 'read' && item.kind !== 'search' && item.kind !== 'browser')) {
				continue;
			}
			const label = item.kind === 'read' && item.path ? handoffPath(item.path, cwd) : item.detail || item.label;
			tools.push({ kind: item.kind, label, ...(item.error ? { failed: true } : {}) });
			continue;
		}
		if (segment.kind !== 'block') {
			continue;
		}
		const block = segment.block;
		switch (block.type) {
			case 'terminal':
				tools.push({ kind: 'execute', label: block.command || block.title || 'command', ...(block.status === 'error' || (block.exitCode !== undefined && block.exitCode !== 0) ? { failed: true } : {}) });
				break;
			case 'file': {
				const path = handoffPath(block.path, cwd);
				tools.push({ kind: 'edit', label: path, ...(block.status === 'error' ? { failed: true } : {}) });
				if (block.status !== 'error') {
					files.push({ path, kind: block.verb === 'Created' ? 'create' : block.verb === 'Deleted' ? 'delete' : 'edit' });
				}
				break;
			}
			case 'tool': {
				const kind = classifyToolActivity(block.name, block.title);
				tools.push(handoffToolCall({
					kind: kind === 'read' || kind === 'search' || kind === 'browser' ? kind : undefined,
					name: block.name,
					title: block.title,
					input: block.input,
					failed: block.status === 'error',
				}, cwd));
				break;
			}
		}
	}
	return tools.length || files.length ? { tools, files } : undefined;
}
