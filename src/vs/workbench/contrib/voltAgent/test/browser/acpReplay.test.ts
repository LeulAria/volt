/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AcpAgentProvider } from '../../../../services/voltRuntime/browser/agents/acpProvider.js';
import { IVoltEvent, IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import type { AgentSegment } from '../../browser/blocks/agentBlocks.js';
import type { IAgentAssistantMessage, IAgentMessage } from '../../browser/editor/agentEditor.js';
import { AgentSessionController, IAgentSessionHost } from '../../browser/editor/agentSessionController.js';
import { IAgentWorkspaceService } from '../../browser/workspace/agentWorkspace.js';
import { CLAUDE_EDIT_TURN, CURSOR_EDIT_TURN } from './acpReplayFixtures.js';
import { buildThreadParts, visibleReplyParts } from '../../browser/chrome/agentTimeline.js';

class ReplayRuntime {
	private readonly listeners = new Set<(e: IVoltEventEnvelope) => void>();
	private seq = 0;

	onEvent(_sessionId: string, listener: (e: IVoltEventEnvelope) => void) {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	getOrCreateSession() {
		return { activeRun: { status: 'running' } };
	}

	emit(event: IVoltEvent): void {
		const envelope: IVoltEventEnvelope = { seq: ++this.seq, runId: 'run-1', sessionId: 's1', timestamp: Date.now(), event };
		for (const listener of [...this.listeners]) {
			listener(envelope);
		}
	}
}

/** What the mapper turns one recorded `session/update` into. */
function mapUpdate(provider: AcpAgentProvider, update: Record<string, unknown>): IVoltEvent[] {
	return (provider as unknown as { mapUpdate(params: unknown): IVoltEvent[] }).mapUpdate({ sessionId: 'acp', update });
}

/** A compact, readable line per segment, so a failing test shows the whole transcript. */
export function describeSegments(segments: readonly AgentSegment[]): string[] {
	return segments.map(segment => {
		if (segment.kind === 'text') {
			return `text: ${segment.text.slice(0, 60)}`;
		}
		if (segment.kind === 'thought') {
			return `thought: ${segment.text.slice(0, 60)}`;
		}
		if (segment.kind === 'activity') {
			return `activity: ${segment.item.label} ${segment.item.detail ?? ''}`.trim();
		}
		if (segment.kind === 'notice') {
			return `notice: ${segment.title}`;
		}
		const block = segment.block;
		switch (block.type) {
			case 'file':
				return `file: ${block.verb} ${block.path} +${block.additions ?? '?'} -${block.deletions ?? '?'}`;
			case 'terminal':
				return `terminal: [${block.title ?? ''}] $ ${block.command} => ${JSON.stringify((block.output ?? '').slice(0, 40))}`;
			default:
				return `${block.type}`;
		}
	});
}

suite('ACP replay', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function replay(updates: readonly Record<string, unknown>[]) {
		const runtime = new ReplayRuntime();
		const host: IAgentSessionHost = {
			sessionId: 's1',
			messages: [{ kind: 'user', id: 'turn-1', text: 'hi' }, {
				kind: 'agent', id: 'turn-1', title: '', steps: [], segments: [], blockState: {},
				activity: { status: 'Thinking', expanded: false, streaming: true, items: [] },
			}] as IAgentMessage[],
			recordAssistant: () => { },
		};
		store.add(new AgentSessionController(
			host,
			runtime as unknown as IAgentRuntimeService,
			{ rootFor: () => undefined } as unknown as IVoltSessionContextService,
			{ getWorkspace: () => ({ folders: [] }) } as unknown as IWorkspaceContextService,
			{ openSurface: () => undefined } as unknown as IAgentWorkspaceService,
			{ get: () => undefined, setAttention: async () => { } } as unknown as IAgentHistoryService,
		));
		const provider = new AcpAgentProvider('claude-code', 'Claude', 'claude', [], undefined as unknown as IVoltStdioService,
			undefined as unknown as IWorkspaceContextService, undefined as unknown as IFileService, undefined as unknown as ILogService);
		runtime.emit({ type: 'run.start', runId: 'run-1', mode: 'agent' });
		for (const update of updates) {
			for (const event of mapUpdate(provider, update)) {
				runtime.emit(event);
			}
		}
		runtime.emit({ type: 'run.end', runId: 'run-1', reason: 'done' });
		return host.messages.at(-1) as IAgentAssistantMessage;
	}

	test('a Claude edit turn reads like the work it did', () => {
		const reply = replay(CLAUDE_EDIT_TURN);
		const lines = describeSegments(reply.segments);
		const transcript = lines.join('\n');
		const files = lines.filter(line => line.startsWith('file:'));
		assert.deepStrictEqual(files, ['file: Edited /work/Agent-Test/harness-server.mjs +5 -0'], transcript);
		const terminals = lines.filter(line => line.startsWith('terminal:'));
		assert.strictEqual(terminals.length, 3, transcript);
		for (const line of terminals) {
			assert.ok(!line.includes('$ {}'), `command keeps the empty input snapshot: ${line}`);
			assert.ok(!line.includes('```'), `output keeps the console fence: ${line}`);
		}
		assert.ok(lines.some(line => line.startsWith('activity:') && line.includes('harness-server.mjs')), transcript);
	});

	test('a Cursor edit turn reads like the work it did', () => {
		const reply = replay(CURSOR_EDIT_TURN);
		const lines = describeSegments(reply.segments);
		const transcript = lines.join('\n');
		assert.deepStrictEqual(lines.filter(line => line.startsWith('file:')), ['file: Edited /work/Agent-Test/harness-server.mjs +5 -0'], transcript);
		assert.ok(lines.some(line => line.startsWith('activity:') && line.includes('harness-server.mjs')), transcript);
		assert.ok(!lines.some(line => line.includes('`/work')), `a title keeps its markdown path: ${transcript}`);
	});

	test('the reply shows the change and the final answer', () => {
		for (const turn of [CLAUDE_EDIT_TURN, CURSOR_EDIT_TURN]) {
			const reply = replay(turn);
			const parts = visibleReplyParts(buildThreadParts(reply.segments, reply.text, false));
			const kinds = parts.map(part => part.kind === 'block' ? `block:${part.block.type}` : part.kind);
			assert.ok(kinds.some(kind => kind === 'block:file' || kind === 'changes'), kinds.join(', '));
			assert.strictEqual(kinds.at(-1), 'markdown', kinds.join(', '));
		}
	});
});

