/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
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
import { VoltWindowScopeService } from '../../../voltWindowScope/common/voltWindowScopeService.js';
import { TestWindowScopesHost } from '../../../voltWindowScope/test/common/testWindowScopesHost.js';

/** The history writes its index atomically, which the plain in-memory provider refuses. */
class AtomicInMemoryFileSystemProvider extends InMemoryFileSystemProvider {
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite;
	}
}

suite('Agent history across windows', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const home = URI.file('/user');

	function setup() {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new AtomicInMemoryFileSystemProvider())));
		const host = disposables.add(new TestWindowScopesHost());
		const openWindow = async (scope?: string) => {
			if (scope) {
				host.open(scope);
			}
			const windowScope = disposables.add(new VoltWindowScopeService(scope, host.scopes, host));
			const history = disposables.add(new AgentHistoryService(
				fileService,
				{ userRoamingDataHome: home } as never,
				{ getWorkspace: () => ({ id: 'w', folders: [] }), onDidChangeWorkspaceFolders: Event.None } as never,
				{ onWillShutdown: Event.None } as never,
				new NullLogService(),
				{} as never,
				windowScope,
			));
			await history.whenReady;
			return history;
		};
		const readIndex = async () => JSON.parse((await fileService.readFile(joinPath(home, 'agentSessions', 'index.json'))).value.toString()).sessions.map((meta: { id: string }) => meta.id).sort();
		return { host, openWindow, readIndex };
	}

	async function startChat(history: AgentHistoryService, id: string): Promise<void> {
		const handle = history.open(id);
		await handle.load();
		handle.appendUser('t1', `hello from ${id}`, { kind: 'user', text: 'hello' });
		await handle.close();
		await history.flushAll();
	}

	test('two windows keep each other\'s chats in the index', async () => {
		const { openWindow, readIndex } = setup();
		const first = await openWindow();
		const second = await openWindow();
		await startChat(first, 'chat-a');
		await startChat(second, 'chat-b');
		await startChat(first, 'chat-c');
		assert.deepStrictEqual(await readIndex(), ['chat-a', 'chat-b', 'chat-c']);
	});

	test('a chat deleted in one window is not written back by another', async () => {
		const { openWindow, readIndex } = setup();
		const setupWindow = await openWindow();
		await startChat(setupWindow, 'chat-a');
		const first = await openWindow();
		const second = await openWindow();
		assert.ok(second.get('chat-a'));
		await first.delete('chat-a');
		await first.flushAll();
		await startChat(second, 'chat-b');
		assert.deepStrictEqual(await readIndex(), ['chat-b']);
	});

	test('a New Window\'s chats show only there, then in the main window once it closes', async () => {
		const { host, openWindow } = setup();
		const main = await openWindow();
		await startChat(main, 'main-chat');
		const scoped = await openWindow('new-window');

		assert.deepStrictEqual(scoped.list({ inWindow: true }).map(meta => meta.id), [], 'a New Window starts empty');
		await startChat(scoped, 'scoped-chat');
		assert.deepStrictEqual(scoped.list({ inWindow: true }).map(meta => meta.id), ['scoped-chat']);
		assert.ok(scoped.list().some(meta => meta.id === 'main-chat'), 'unscoped lists still see every chat');
		assert.deepStrictEqual(main.list({ inWindow: true }).map(meta => meta.id), ['main-chat']);

		const changed = Event.toPromise(Event.filter(main.onDidChange, () => !!main.get('scoped-chat')));
		host.close('new-window');
		await changed;
		assert.deepStrictEqual(main.list({ inWindow: true }).map(meta => meta.id).sort(), ['main-chat', 'scoped-chat']);
	});
});
