/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentHistoryService } from '../../browser/history/agentHistoryService.js';
import { AGENT_HISTORY_FORMAT_VERSION } from '../../common/history/agentHistory.js';

suite('Agent history after a restart', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a turn that finished just before the window closed is not shown as interrupted', async () => {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		const home = URI.file('/user');
		const sessions = joinPath(home, 'agentSessions', 'sessions');
		const workspace = { id: 'w', label: 'repo', folders: ['/repo'] };
		const header = { type: 'header', version: AGENT_HISTORY_FORMAT_VERSION, id: 'done-chat', createdAt: 1, workspace };
		const line = (record: object) => `${JSON.stringify(record)}\n`;
		// The log has the final reply (it is flushed at once); the index still says running (it is debounced).
		await fileService.writeFile(joinPath(sessions, 'done-chat.jsonl'), VSBuffer.fromString(
			line(header)
			+ line({ type: 'user', turn: 't1', at: 2, text: 'go', message: { kind: 'user', text: 'go' } })
			+ line({ type: 'agent', turn: 't1', at: 3, final: true, status: 'done', text: 'ok', message: { kind: 'agent' } })));
		await fileService.writeFile(joinPath(sessions, 'cut-chat.jsonl'), VSBuffer.fromString(
			line({ ...header, id: 'cut-chat' })
			+ line({ type: 'user', turn: 't1', at: 2, text: 'go', message: { kind: 'user', text: 'go' } })
			+ line({ type: 'agent', turn: 't1', at: 3, final: false, status: 'running', text: 'wor', message: { kind: 'agent' } })));
		const meta = (id: string) => ({ id, title: id, createdAt: 1, updatedAt: 3, workspaceId: 'w', workspaceLabel: 'repo', turnCount: 1, preview: 'go', status: 'running', pinned: true });
		await fileService.writeFile(joinPath(home, 'agentSessions', 'index.json'), VSBuffer.fromString(JSON.stringify({ version: AGENT_HISTORY_FORMAT_VERSION, sessions: [meta('done-chat'), meta('cut-chat')] })));

		const service = disposables.add(new AgentHistoryService(
			fileService,
			{ userRoamingDataHome: home } as never,
			{ getWorkspace: () => ({ id: 'w', folders: [] }), onDidChangeWorkspaceFolders: Event.None } as never,
			{ onWillShutdown: Event.None } as never,
			new NullLogService(),
			{} as never,
		));
		await service.whenReady;
		assert.strictEqual(service.get('done-chat')?.status, 'done', 'the log says it finished');
		assert.strictEqual(service.get('done-chat')?.pinned, true, 'what only the index knows is kept');
		assert.strictEqual(service.get('cut-chat')?.status, 'interrupted', 'a reply that was still streaming was cut off');
	});
});
