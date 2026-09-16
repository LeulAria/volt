/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { extractLocalPreviewUrl } from './localPreview.js';
import { isSnapshotActivity } from './browserSnapshot.js';
import { AgentSegment, IAgentActivityItem, IFileChangeBlock, ITerminalBlock, isExploreTool } from './blocks/agentBlocks.js';
import { computeFileChangePreview, formatChangeStats } from './fileChangePreviewModel.js';

export type ThreadPart =
	| { kind: 'group'; id: string; title: string; items: IAgentActivityItem[]; thinking?: string }
	| { kind: 'snapshot'; id: string; item: IAgentActivityItem }
	| { kind: 'markdown'; id: string; content: string }
	| { kind: 'changes'; id: string; files: IFileChangeBlock[]; commands: ITerminalBlock[]; additions: number; deletions: number }
	| { kind: 'block'; block: import('./blocks/agentBlocks.js').AgentBlock };

const PROCESS_RE = /\[volt\]|skip repo-wide|xdg-open|browser mcp|in-app browser cannot|list mcp|webfetch|simplebrowser|evaluation task|these instructions|cannot be used to open|i will list|i'll list|preparing to run|checking the workspace|checking terminals|i cannot use|no browser mcp|no in-app browser/i;

export function isProcessNarration(text: string): boolean {
	const t = text.trim();
	if (!t) {
		return false;
	}
	if (PROCESS_RE.test(t)) {
		return true;
	}
	if (t.length > 240 && /^(checking|preparing|starting|i will|i'll|this appears)/i.test(t)) {
		return true;
	}
	return false;
}

export function partitionAssistantText(text: string): Array<{ kind: 'thought' | 'reply'; text: string }> {
	const parts: Array<{ kind: 'thought' | 'reply'; text: string }> = [];
	for (const raw of text.split(/\n{2,}/)) {
		const para = raw.trim();
		if (!para) {
			continue;
		}
		const kind = classifyAssistantParagraph(para);
		const last = parts.at(-1);
		if (last && last.kind === kind) {
			last.text += `\n\n${para}`;
		} else {
			parts.push({ kind, text: para });
		}
	}
	return parts;
}

function classifyAssistantParagraph(para: string): 'thought' | 'reply' {
	if (extractLocalPreviewUrl(para)) {
		return 'reply';
	}
	if (isProcessNarration(para) || para.length > 280) {
		return 'thought';
	}
	return 'reply';
}

export function buildThreadParts(segments: AgentSegment[] | undefined, fallbackText?: string, streaming = false): ThreadPart[] {
	const source = segments?.length
		? segments
		: (fallbackText ? [{ kind: 'text' as const, text: fallbackText }] : []);
	const parts: ThreadPart[] = [];
	let items: IAgentActivityItem[] = [];
	let thinking = '';
	let work: Array<IFileChangeBlock | ITerminalBlock> = [];
	let groupIndex = 0;
	let textIndex = 0;

	const flushGroup = () => {
		if (!items.length && !thinking.trim()) {
			return;
		}
		parts.push({
			kind: 'group',
			id: `activity-${groupIndex++}`,
			title: activityGroupTitle(items, thinking, false),
			items,
			thinking: thinking.trim() || undefined,
		});
		items = [];
		thinking = '';
	};

	const flushWork = () => {
		if (!work.length) {
			return;
		}
		const files = work.filter((block): block is IFileChangeBlock => block.type === 'file');
		const commands = work.filter((block): block is ITerminalBlock => block.type === 'terminal');
		if (files.length && (files.length > 1 || commands.length > 0)) {
			let additions = 0;
			let deletions = 0;
			for (const file of files) {
				const preview = computeFileChangePreview(fileChangeSource(file));
				additions += preview.additions;
				deletions += preview.deletions;
			}
			parts.push({
				kind: 'changes',
				id: `changes-${groupIndex++}`,
				files,
				commands,
				additions,
				deletions,
			});
		} else {
			for (const block of work) {
				parts.push({ kind: 'block', block });
			}
		}
		work = [];
	};

	for (const segment of source) {
		if (segment.kind === 'thought') {
			thinking = joinText(thinking, segment.text);
			continue;
		}
		if (segment.kind === 'activity') {
			if (isSnapshotActivity(segment.item)) {
				flushWork();
				flushGroup();
				parts.push({ kind: 'snapshot', id: `snapshot-${groupIndex++}`, item: segment.item });
				continue;
			}
			items.push(segment.item);
			continue;
		}
		if (segment.kind === 'text') {
			for (const chunk of partitionAssistantText(segment.text)) {
				if (chunk.kind === 'thought') {
					thinking = joinText(thinking, chunk.text);
				} else {
					flushWork();
					flushGroup();
					parts.push({ kind: 'markdown', id: `md-${textIndex++}`, content: chunk.text });
				}
			}
			continue;
		}
		if (segment.block.type === 'tool' && isExploreTool(segment.block.name, segment.block.title)) {
			continue;
		}
		if (segment.block.type === 'file' || segment.block.type === 'terminal') {
			flushGroup();
			work.push(segment.block);
			continue;
		}
		flushWork();
		flushGroup();
		parts.push({ kind: 'block', block: segment.block });
	}
	flushWork();
	flushGroup();
	if (streaming) {
		const last = parts.at(-1);
		if (last?.kind === 'group') {
			last.title = activityGroupTitle(last.items, last.thinking ?? '', true);
		} else if (last?.kind !== 'snapshot') {
			parts.push({
				kind: 'group',
				id: `activity-${groupIndex}`,
				title: localize('voltAgent.thinking', "Thinking"),
				items: [],
			});
		}
	}
	return parts;
}

export function activityGroupTitle(items: readonly IAgentActivityItem[], thinking?: string, streaming = false): string {
	const reads = items.filter(item => item.kind === 'read');
	const files = reads.length;
	const searches = items.filter(item => item.kind === 'search').length;
	const browsers = items.filter(item => item.kind === 'browser').length;
	const waits = items.filter(item => item.kind === 'wait');
	const explore = formatExploreTitle(files, searches, browsers, streaming, reads[0]?.detail);
	if (explore) {
		return explore;
	}
	if (waits.length && waits.length === items.length) {
		return waits[0]?.label || localize('voltAgent.waited', "Waited");
	}
	return streaming
		? localize('voltAgent.thinking', "Thinking")
		: localize('voltAgent.thoughtBriefly', "Thought briefly");
}

function formatExploreTitle(files: number, searches: number, browsers: number, streaming: boolean, fileName?: string): string | undefined {
	if (!files && !searches && !browsers) {
		return undefined;
	}
	const parts: string[] = [];
	if (files) {
		parts.push(files === 1
			? (fileName || localize('voltAgent.oneFile', "1 file"))
			: localize('voltAgent.manyFiles', "{0} files", files));
	}
	if (searches) {
		parts.push(searches === 1
			? localize('voltAgent.oneSearch', "1 search")
			: localize('voltAgent.manySearches', "{0} searches", searches));
	}
	if (browsers) {
		parts.push(browsers === 1
			? localize('voltAgent.oneBrowser', "1 browser action")
			: localize('voltAgent.manyBrowsers', "{0} browser actions", browsers));
	}
	const joined = parts.join(', ');
	return streaming
		? localize('voltAgent.exploring', "Exploring {0}", joined)
		: localize('voltAgent.explored', "Explored {0}", joined);
}

export function fileChangeGroupTitle(files: number, commands: number, additions: number, deletions: number): string {
	const parts: string[] = [];
	if (files) {
		parts.push(files === 1
			? localize('voltAgent.editingOneFile', "Editing 1 file")
			: localize('voltAgent.editingManyFiles', "Editing {0} files", files));
	}
	if (commands) {
		parts.push(commands === 1
			? localize('voltAgent.ranOneCommand', "ran 1 command")
			: localize('voltAgent.ranManyCommands', "ran {0} commands", commands));
	}
	const stats = formatChangeStats(additions, deletions);
	const counts = [stats.added, stats.removed].filter(Boolean).join(' ');
	const joined = parts.join(', ');
	return counts ? `${joined} ${counts}` : joined;
}

export function fileChangeSource(block: IFileChangeBlock) {
	return {
		path: block.path,
		verb: block.verb,
		original: block.original,
		modified: block.modified,
		unifiedDiff: block.unifiedDiff,
		additions: block.additions,
		deletions: block.deletions,
	};
}

function joinText(left: string, right: string): string {
	if (!left) {
		return right;
	}
	if (!right) {
		return left;
	}
	return `${left}${left.endsWith('\n') || right.startsWith('\n') ? '' : '\n'}${right}`;
}
