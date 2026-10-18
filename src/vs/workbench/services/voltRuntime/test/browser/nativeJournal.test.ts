/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INativeJournalEntry, NativeJournal } from '../../browser/history/nativeJournal.js';
import { searchArchivedHistory } from '../../common/harness/historySearch.js';
import { applyCompaction } from '../../common/harness/nativeCompaction.js';
import { INativeLoopMessage } from '../../common/harness/nativeLoop.js';

class AtomicMemoryProvider extends InMemoryFileSystemProvider {
	override get capabilities(): FileSystemProviderCapabilities {
		return super.capabilities | FileSystemProviderCapabilities.FileAtomicWrite;
	}
}

const ROOT = URI.file('/voltNative');

function entry(messages: INativeLoopMessage[], running?: string[]): INativeJournalEntry {
	return { version: 1, messages, synced: 1, savedAt: Date.now(), ...(running ? { running } : {}) };
}

/** Lets the fire-and-forget live-log writes land. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await timeout(1);
	}
}

suite('NativeJournal live log', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let store: DisposableStore;
	let fileService: FileService;

	setup(() => {
		store = disposables.add(new DisposableStore());
		fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('file', store.add(new AtomicMemoryProvider())));
	});

	test('a crash after the snapshot keeps every later step and names the calls that were running', async () => {
		const journal = store.add(new NativeJournal(ROOT, fileService, new NullLogService()));
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'port the app', turn: true }];
		const snapshot = () => entry(messages);
		await journal.schedule('chat', snapshot, true);

		messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', args: { path: 'x' } }, { id: 'b', name: 'shell', args: { command: 'npm test' } }] });
		const done: INativeLoopMessage = { role: 'tool', content: 'file x', callId: 'a', name: 'read_file' };
		journal.log('chat', snapshot, () => entry([...messages, done], ['b']));
		await settle();

		// A new window reads it back (the old one died without its full save).
		const reopened = store.add(new NativeJournal(ROOT, fileService, new NullLogService()));
		const loaded = await reopened.load('chat');
		assert.deepStrictEqual(loaded?.messages.map(message => message.role), ['user', 'assistant', 'tool']);
		assert.deepStrictEqual(loaded?.running, ['b']);
	});

	test('a subagent transcript kept only in the live log comes back, and a delete outlasts a write in flight', async () => {
		const journal = store.add(new NativeJournal(ROOT, fileService, new NullLogService()));
		const id = 'chat.sub-1';
		assert.strictEqual(await journal.load(id), undefined);
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'find the parser' }, { role: 'assistant', content: '', toolCalls: [{ id: 'g', name: 'grep', args: { pattern: 'parse' } }] }];
		journal.log(id, () => entry(messages), () => entry(messages, ['g']));
		await settle();
		const reopened = store.add(new NativeJournal(ROOT, fileService, new NullLogService()));
		const loaded = await reopened.load(id);
		assert.deepStrictEqual(loaded?.messages.map(message => message.role), ['user', 'assistant']);
		assert.deepStrictEqual(loaded?.running, ['g']);

		// The report reached the parent: the copy goes, even with a write still on its way.
		messages.push({ role: 'tool', content: 'src/parser.ts', callId: 'g', name: 'grep' });
		journal.log(id, () => entry(messages), () => entry(messages));
		await journal.delete(id);
		await settle();
		assert.strictEqual(await store.add(new NativeJournal(ROOT, fileService, new NullLogService())).load(id), undefined);
	});

	test('compacted messages stay in the archive, and search_history finds the exact error in them', async () => {
		const journal = store.add(new NativeJournal(ROOT, fileService, new NullLogService()));
		assert.deepStrictEqual(await journal.readArchive('chat'), []);
		await journal.archive('chat', [
			{ role: 'assistant', content: '', toolCalls: [{ id: 's1', name: 'shell', args: { command: 'npm run build' } }] },
			{ role: 'tool', content: 'src/a.ts(4,1): error TS2304: Cannot find name \'Widget\'.', callId: 's1', name: 'shell', isError: true },
		]);
		await journal.archive('chat', [{ role: 'assistant', content: 'Renamed Widget to Gadget in src/b.ts.' }]);
		const archive = await store.add(new NativeJournal(ROOT, fileService, new NullLogService())).readArchive('chat');
		assert.deepStrictEqual(archive.map(entry => entry.message.role), ['assistant', 'tool', 'assistant']);
		const found = searchArchivedHistory(archive, 'TS2304 Widget');
		assert.ok(found.startsWith('[#1 tool result (shell), error'), found);
		assert.ok(found.includes('Cannot find name'));
		assert.ok(searchArchivedHistory(archive, 'npm run build').includes('shell'));
		assert.ok(searchArchivedHistory(archive, 'kubernetes').startsWith('No earlier message matches'));
	});

	test('a live log an older snapshot left is ignored', async () => {
		const journal = store.add(new NativeJournal(ROOT, fileService, new NullLogService()));
		const messages: INativeLoopMessage[] = [{ role: 'user', content: 'hi', turn: true }];
		const snapshot = () => entry(messages);
		await journal.schedule('chat', snapshot, true);
		journal.log('chat', snapshot, () => entry([...messages, { role: 'assistant', content: 'working' }], ['c']));
		await settle();

		// The run ended: the full save has everything, and nothing is running any more.
		messages.push({ role: 'assistant', content: 'done' });
		await timeout(2);
		await journal.schedule('chat', snapshot, true);

		const loaded = await store.add(new NativeJournal(ROOT, fileService, new NullLogService())).load('chat');
		assert.deepStrictEqual(loaded?.messages.map(message => message.content), ['hi', 'done']);
		assert.strictEqual(loaded?.running, undefined);
	});

	test('compaction keeps the request the user typed, not the continuation Volt sent', () => {
		const messages: INativeLoopMessage[] = [
			{ role: 'user', content: 'Port the billing service to Go.', turn: true },
			{ role: 'assistant', content: 'step 1' },
			{ role: 'user', content: '[Volt] Your previous run reached its step limit for one run.', turn: true },
			{ role: 'assistant', content: 'step 2' },
			{ role: 'assistant', content: 'step 3' },
		];
		const compacted = applyCompaction(messages, 3, 'Did steps 1 and 2.');
		assert.ok(compacted[0].content.includes('Port the billing service to Go.'));

		// A second compaction finds it in the first one's note.
		const again = applyCompaction([...compacted, { role: 'user', content: '[Volt] Continue.', turn: true }, { role: 'assistant', content: 'step 4' }], compacted.length + 1, 'Did steps 1 to 3.');
		assert.ok(again[0].content.includes('Port the billing service to Go.'));
	});
});
