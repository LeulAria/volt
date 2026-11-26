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
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentHistoryService } from '../../browser/history/agentHistoryService.js';
import { AGENT_HISTORY_FORMAT_VERSION } from '../../common/history/agentHistory.js';
import { IVoltProjectRecord } from '../../common/sessionContext.js';
import { VoltWindowScopeService } from '../../../voltWindowScope/common/voltWindowScopeService.js';

/** The history rewrites logs atomically, which the plain in-memory provider refuses. */
class AtomicInMemoryFileSystemProvider extends InMemoryFileSystemProvider {
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite;
	}
}

suite('Agent history: a chat\'s project', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const home = URI.file('/user');
	const sessions = joinPath(home, 'agentSessions', 'sessions');
	const hotel: IVoltProjectRecord = { id: 'project-hotel', root: URI.file('/projects/hotel'), displayName: 'hotel', authority: 'file' } as IVoltProjectRecord;
	/** What the agent server's own workspace looks like: no folder, so it is "Untitled". */
	const serverWorkspace = { id: 'volt-agent-server', label: 'Untitled', folders: [] };
	const line = (record: object) => `${JSON.stringify(record)}\n`;

	function setup(bound: readonly string[]) {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new AtomicInMemoryFileSystemProvider())));
		const sessionContext = {
			bindingFor: (sessionId: string) => bound.includes(sessionId) ? { sessionId, projectId: hotel.id, root: hotel.root, authority: 'file' } : undefined,
			getProject: (id: string) => id === hotel.id ? hotel : undefined,
		};
		const start = async () => {
			const history = disposables.add(new AgentHistoryService(
				fileService,
				{ userRoamingDataHome: home } as never,
				{ getWorkspace: () => ({ id: 'volt-agent-server', folders: [] }), onDidChangeWorkspaceFolders: Event.None } as never,
				{ onWillShutdown: Event.None } as never,
				new NullLogService(),
				{} as never,
				disposables.add(new VoltWindowScopeService(undefined, undefined, undefined)),
				sessionContext as never,
			));
			await history.whenReady;
			return history;
		};
		const readHeader = async (id: string) => JSON.parse((await fileService.readFile(joinPath(sessions, `${id}.jsonl`))).value.toString().split('\n')[0]);
		return { fileService, start, readHeader };
	}

	test('a chat the agent server saved as Untitled is listed under the project it is bound to, and its log is fixed', async () => {
		const { fileService, start, readHeader } = setup(['lost-pin']);
		const header = { type: 'header', version: AGENT_HISTORY_FORMAT_VERSION, id: 'lost-pin', createdAt: 1, workspace: serverWorkspace };
		await fileService.writeFile(joinPath(sessions, 'lost-pin.jsonl'), VSBuffer.fromString(
			line(header)
			+ line({ type: 'user', turn: 't1', at: 2, text: 'go', message: { kind: 'user', text: 'go' } })
			+ line({ type: 'agent', turn: 't1', at: 3, final: true, status: 'done', text: 'ok', message: { kind: 'agent' } })));
		await fileService.writeFile(joinPath(sessions, 'no-binding.jsonl'), VSBuffer.fromString(
			line({ ...header, id: 'no-binding' })
			+ line({ type: 'user', turn: 't1', at: 2, text: 'go', message: { kind: 'user', text: 'go' } })));
		const meta = (id: string) => ({ id, title: id, createdAt: 1, updatedAt: 3, workspaceId: 'volt-agent-server', workspaceLabel: 'Untitled', turnCount: 1, preview: 'go', status: 'done' });
		await fileService.writeFile(joinPath(home, 'agentSessions', 'index.json'), VSBuffer.fromString(JSON.stringify({ version: AGENT_HISTORY_FORMAT_VERSION, sessions: [meta('lost-pin'), meta('no-binding')] })));

		const history = await start();
		assert.strictEqual(history.get('lost-pin')?.workspaceLabel, 'hotel', 'listed under its project at once');
		assert.strictEqual(history.get('lost-pin')?.workspaceFolder, hotel.root.fsPath);
		assert.strictEqual(history.get('no-binding')?.workspaceLabel, 'Untitled', 'a chat bound to nothing is left alone');

		const handle = history.open('lost-pin');
		await handle.load();
		handle.appendUser('t2', 'more', { kind: 'user', text: 'more' });
		await handle.close();
		assert.deepStrictEqual((await readHeader('lost-pin')).workspace, { id: hotel.id, label: 'hotel', folders: [hotel.root.fsPath] }, 'the log says hotel too, so a later write keeps it');
		assert.strictEqual(history.get('lost-pin')?.workspaceLabel, 'hotel');
		assert.strictEqual(history.get('lost-pin')?.turnCount, 2);
	});

	test('a new chat whose pin never arrived is saved in the project it is bound to', async () => {
		const { start, readHeader } = setup(['new-chat']);
		const history = await start();
		const handle = history.open('new-chat');
		await handle.load();
		handle.appendUser('t1', 'hello', { kind: 'user', text: 'hello' });
		await handle.close();
		assert.strictEqual(history.get('new-chat')?.workspaceLabel, 'hotel');
		assert.strictEqual((await readHeader('new-chat')).workspace.label, 'hotel');
	});

	test('a pin that arrives after the chat was saved without a project still names it', async () => {
		const { start, readHeader } = setup([]);
		const history = await start();
		const handle = history.open('late-pin');
		await handle.load();
		handle.appendUser('t1', 'hello', { kind: 'user', text: 'hello' });
		await handle.flush();
		assert.strictEqual(history.get('late-pin')?.workspaceLabel, 'Untitled');
		history.pinSessionWorkspace('late-pin', { id: hotel.id, label: 'hotel', folders: [hotel.root.fsPath] });
		await handle.close();
		assert.strictEqual(history.get('late-pin')?.workspaceLabel, 'hotel');
		assert.strictEqual((await readHeader('late-pin')).workspace.label, 'hotel');
	});
});
