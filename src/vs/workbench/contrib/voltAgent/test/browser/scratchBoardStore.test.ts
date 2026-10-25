/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ScratchBoardModel } from '../../browser/scratchBoard/scratchBoardService.js';
import { emptyBoardDocument, parseBoardDocument, serializeBoardDocument } from '../../common/scratchBoard/scratchDocument.js';
import { createShape } from '../../common/scratchBoard/scratchFactory.js';
import { ScratchElement } from '../../common/scratchBoard/scratchTypes.js';

type BoardStore = ConstructorParameters<typeof ScratchBoardModel>[1];

const ROOT = URI.file('/scratch');
const BOARD = 'board1';

function shape(id: string, x = 0): ScratchElement {
	return createShape({ id, x, y: 0, width: 100, height: 60, shape: 'rectangle' });
}

/** The parts of a model a test drives that the class keeps private. */
function internals(model: ScratchBoardModel): { reload(): Promise<void> } {
	return model as unknown as { reload(): Promise<void> };
}

suite('Scratch board store', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		const file = joinPath(ROOT, 'boards', `${BOARD}.json`);
		await fileService.writeFile(file, VSBuffer.fromString(serializeBoardDocument(emptyBoardDocument(BOARD, 1), 1)));
		const backups: string[] = [];
		const makeStore = (files: IFileService = fileService): BoardStore => ({
			fileService: files,
			logService: new NullLogService(),
			root: ROOT,
			boardFile: id => joinPath(ROOT, 'boards', `${id}.json`),
			writeAtomic: async (target, content) => { await files.writeFile(target, VSBuffer.fromString(content)); },
			backupBroken: async (_target, content, reason) => { backups.push(reason); return joinPath(ROOT, 'broken', `${backups.length}.json`); },
			noteEdited: () => { },
			notifyUnreadable: () => { },
		});
		const open = async (files?: IFileService) => {
			const model = disposables.add(new ScratchBoardModel(BOARD, makeStore(files)));
			await model.whenLoaded;
			return model;
		};
		const onDisk = async () => parseBoardDocument(JSON.parse((await fileService.readFile(file)).value.toString()), BOARD).document;
		return { fileService, file, open, onDisk, backups };
	}

	const ids = (elements: readonly ScratchElement[]) => elements.map(e => e.id).sort();

	test('two windows editing at once both keep their elements', async () => {
		const { open, onDisk } = await setup();
		const a = await open();
		const b = await open();
		a.scene.transact('add', tx => tx.add(shape('a1')));
		assert.strictEqual(await a.flush(), true);
		// B has not seen A's save yet: its save merges the disk copy first.
		b.scene.transact('add', tx => tx.add(shape('b1')));
		assert.strictEqual(await b.flush(), true);
		assert.deepStrictEqual(ids((await onDisk()).elements), ['a1', 'b1']);
		assert.deepStrictEqual(ids(b.scene.getElements()), ['a1', 'b1']);
		await internals(a).reload();
		assert.deepStrictEqual(ids(a.scene.getElements()), ['a1', 'b1']);
	});

	test('a copy on disk that lost our element is written again', async () => {
		const { open, onDisk, fileService, file } = await setup();
		const a = await open();
		a.scene.transact('add', tx => tx.add(shape('a1')));
		await a.flush();
		// Another window raced and wrote a copy without a1 (it never saw it).
		const other = { ...emptyBoardDocument(BOARD, 2), elements: [shape('b1')], revision: 9, updated: Date.now() + 1000 };
		await fileService.writeFile(file, VSBuffer.fromString(serializeBoardDocument(other, Date.now())));
		await internals(a).reload();
		assert.deepStrictEqual(ids(a.scene.getElements()), ['a1', 'b1']);
		assert.strictEqual(a.hasUnsavedEdits, true, 'the union has to be written back');
		await a.flush();
		assert.deepStrictEqual(ids((await onDisk()).elements), ['a1', 'b1']);
	});

	test('another window\'s save during a drag is taken in after it, and the drag never reaches the disk', async () => {
		const { open, onDisk } = await setup();
		const a = await open();
		const b = await open();
		a.scene.transact('add', tx => tx.add(shape('a1', 0)));
		await a.flush();
		await internals(b).reload();
		// A starts dragging a1.
		const drag = a.scene.begin('move', true);
		drag.update('a1', { x: 500 });
		b.scene.transact('add', tx => tx.add(shape('b1')));
		await b.flush();
		await internals(a).reload();
		assert.deepStrictEqual(ids(a.scene.getElements()), ['a1'], 'not merged into a scene mid-drag');
		// A save while the drag is open writes what was committed.
		await a.flush();
		const mid = await onDisk();
		assert.deepStrictEqual(ids(mid.elements), ['a1', 'b1']);
		assert.strictEqual(mid.elements.find(e => e.id === 'a1')!.x, 0, 'the drag in progress is not saved');
		drag.commit();
		await internals(a).reload();
		assert.deepStrictEqual(ids(a.scene.getElements()), ['a1', 'b1']);
		await a.flush();
		const after = await onDisk();
		assert.strictEqual(after.elements.find(e => e.id === 'a1')!.x, 500);
		assert.deepStrictEqual(ids(after.elements), ['a1', 'b1']);
	});

	test('an Escape-cancelled drag leaves the disk as it was', async () => {
		const { open, onDisk } = await setup();
		const a = await open();
		a.scene.transact('add', tx => tx.add(shape('a1', 0)));
		const drag = a.scene.begin('move', true);
		drag.update('a1', { x: 900 });
		drag.add(shape('ghost'));
		await a.flush();
		drag.cancel();
		const doc = await onDisk();
		assert.deepStrictEqual(ids(doc.elements), ['a1']);
		assert.strictEqual(doc.elements[0].x, 0);
	});

	test('a disk that cannot be read is never written over', async () => {
		const { open, onDisk, fileService } = await setup();
		let failReads = false;
		const flaky = new Proxy(fileService, {
			get(target, key, receiver) {
				if (key === 'readFile' && failReads) {
					return async () => { throw new FileOperationError('busy', FileOperationResult.FILE_PERMISSION_DENIED); };
				}
				const value = Reflect.get(target, key, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as IFileService;
		const a = await open(flaky);
		a.scene.transact('add', tx => tx.add(shape('a1')));
		await a.flush();
		failReads = true;
		a.scene.transact('add', tx => tx.add(shape('a2')));
		assert.strictEqual(await a.flush(), false, 'the save reports that it did not land');
		assert.deepStrictEqual(ids((await onDisk()).elements), ['a1']);
		failReads = false;
		assert.strictEqual(await a.flush(), true);
		assert.deepStrictEqual(ids((await onDisk()).elements), ['a1', 'a2']);
	});

	test('a deletion keeps the time it happened in the other window', async () => {
		const { open } = await setup();
		const a = await open();
		a.scene.transact('add', tx => tx.add(shape('a1')));
		const at = a.scene.get('a1')!.updated + 5;
		a.scene.applyRemote([], { a1: at }, undefined, undefined);
		assert.strictEqual(a.scene.get('a1'), undefined);
		assert.strictEqual(a.scene.deleted.get('a1'), at);
	});
});
