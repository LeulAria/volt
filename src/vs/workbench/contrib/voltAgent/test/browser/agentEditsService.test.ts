/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDocumentDiff, IDocumentDiffProviderOptions } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { linesDiffComputers } from '../../../../../editor/common/diff/linesDiffComputers.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { TestEditorWorkerService } from '../../../../../editor/test/common/services/testEditorWorkerService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltGitService, VoltGitRestoreOutcome } from '../../../../../platform/voltGit/common/voltGit.js';
import { IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { AgentEditsService, IAgentEditsService, mergeText3, sessionFromBaseline } from '../../browser/review/agentEditsService.js';
import { IAgentCheckpointService, refSegment } from '../../browser/review/agentCheckpointService.js';
import { IAgentSessionFileChange, mergeSnapshotChanges } from '../../browser/review/agentSessionChanges.js';
import { AgentSessionChangesService } from '../../browser/review/agentSessionChangesService.js';
import { createFileChangeBlock, FileChangeVerb } from '../../browser/blocks/agentBlocks.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';

suite('mergeText3', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('applies the other side when one side is untouched', () => {
		assert.strictEqual(mergeText3('a\n', 'a\n', 'b\n'), 'b\n');
		assert.strictEqual(mergeText3('a\n', 'b\n', 'a\n'), 'b\n');
		assert.strictEqual(mergeText3('a\n', 'b\n', 'b\n'), 'b\n');
	});

	test('merges edits in separate regions and keeps both', () => {
		const base = 'one\ntwo\nthree\nfour\nfive\nsix\n';
		const ours = 'one\ntwo\nthree\nfour\nfive\nsix (user)\n';
		const theirs = 'ONE\ntwo\nthree\nfour\nfive\nsix\n';
		assert.strictEqual(mergeText3(base, ours, theirs), 'ONE\ntwo\nthree\nfour\nfive\nsix (user)\n');
		assert.strictEqual(mergeText3('a\nb\n', 'a\nb\nc\n', 'x\na\nb\n'), 'x\na\nb\nc\n', 'insertions at both ends');
	});

	test('refuses overlapping or adjacent edits, like git merge-file', () => {
		assert.strictEqual(mergeText3('a\nb\nc\n', 'a\nB1\nc\n', 'a\nB2\nc\n'), undefined);
		assert.strictEqual(mergeText3('a\nb\n', 'A\nb\n', 'a\nB\n'), undefined);
		assert.strictEqual(mergeText3('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n'), 'a\nX\nc\n', 'the same edit on both sides is fine');
	});

	test('handles files without a final newline and empty files', () => {
		assert.strictEqual(mergeText3('', 'new\n', ''), 'new\n');
		assert.strictEqual(mergeText3('x\nm\ny', 'x\nm\ny\nz', 'X\nm\ny'), 'X\nm\ny\nz');
	});
});

suite('Snapshot change helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds only what the transcript missed, and splits renames', () => {
		const transcript: IAgentSessionFileChange[] = [{ path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 0 }];
		const base = { repoRoot: '/r', binary: false, additions: 2, deletions: 1, turnId: 't1' };
		const merged = mergeSnapshotChanges(transcript, [
			{ ...base, path: 'src/a.ts', absolutePath: '/r/src/a.ts', kind: 'modified', oldBlob: 'o', newBlob: 'n' },
			{ ...base, path: 'sed.txt', absolutePath: '/r/sed.txt', kind: 'modified', oldBlob: 'o2', newBlob: 'n2' },
			{ ...base, path: 'new/name.ts', oldPath: 'old/name.ts', absolutePath: '/r/new/name.ts', oldAbsolutePath: '/r/old/name.ts', kind: 'renamed', oldBlob: 'o3', newBlob: 'n3' },
			{ ...base, path: 'logo.png', absolutePath: '/r/logo.png', kind: 'added', binary: true, newBlob: 'n4' },
		]);
		assert.deepStrictEqual(merged.map(file => [file.path, file.kind, !!file.snapshot]), [
			['src/a.ts', 'modified', false],
			['sed.txt', 'modified', true],
			['old/name.ts', 'deleted', true],
			['new/name.ts', 'added', true],
			['logo.png', 'added', true],
		]);
		assert.strictEqual(merged.find(file => file.path === 'logo.png')?.snapshot?.binary, true);
	});

	test('transcript paths written as absolute paths still match', () => {
		const merged = mergeSnapshotChanges([{ path: 'r/src/a.ts', kind: 'modified', additions: 1, deletions: 0 }], [
			{ path: 'src/a.ts', absolutePath: '/r/src/a.ts', kind: 'modified', binary: false, additions: 1, deletions: 0, repoRoot: '/r' },
		]);
		assert.strictEqual(merged.length, 1);
	});

	test('ref segments are always valid', () => {
		assert.strictEqual(refSegment('3f2a-uuid_1.x'), '3f2a-uuid_1.x');
		assert.strictEqual(refSegment('a b/c:d..e'), 'a_b_c_d_e');
		assert.strictEqual(refSegment('.hidden.lock'), '_hidden_');
		assert.strictEqual(refSegment(''), '_');
	});
});

/** Computes real line diffs from the models, like the editor worker. */
class DiffingWorkerService extends TestEditorWorkerService {
	constructor(private readonly models: () => IModelService) {
		super();
	}
	override async computeDiff(original: URI, modified: URI, options: IDocumentDiffProviderOptions): Promise<IDocumentDiff | null> {
		const a = this.models().getModel(original);
		const b = this.models().getModel(modified);
		if (!a || !b) {
			return null;
		}
		const result = linesDiffComputers.getDefault().computeDiff(a.getLinesContent(), b.getLinesContent(), { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false });
		return { identical: !result.changes.length, quitEarly: result.hitTimeout, changes: result.changes, moves: result.moves };
	}
}

suite('AgentEditsService', () => {

	let store: DisposableStore;
	// Registered before the leak check so in-flight model loads finish and are disposed first.
	teardown(async () => {
		await settle();
		service?.dispose();
		for (const model of instantiation.get(ITextFileService).files.models) {
			model.dispose();
		}
		store.dispose();
	});
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiation: TestInstantiationService;
	let fileService: IFileService;
	let events: Emitter<IVoltEventEnvelope>;
	let dialogs: TestDialogService;
	let service: AgentEditsService;
	const file = URI.file('/project/app.ts');

	setup(() => {
		store = disposables.add(new DisposableStore());
		instantiation = workbenchInstantiationService({
			fileService: () => {
				const files = store.add(new FileService(new NullLogService()));
				store.add(files.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
				return files;
			},
		}, store);
		fileService = instantiation.get(IFileService);
		events = store.add(new Emitter<IVoltEventEnvelope>());
		instantiation.stub(IAgentRuntimeService, { onDidEmit: events.event } as Partial<IAgentRuntimeService>);
		instantiation.stub(IVoltGitService, { readBlob: async () => VSBuffer.fromString('') } as Partial<IVoltGitService>);
		instantiation.stub(IEditorWorkerService, new DiffingWorkerService(() => instantiation.get(IModelService)));
		dialogs = new TestDialogService();
		instantiation.stub(IDialogService, dialogs);
	});

	async function create(): Promise<AgentEditsService> {
		service = store.add(instantiation.createInstance(AgentEditsService));
		return service;
	}

	async function write(text: string): Promise<void> {
		await fileService.writeFile(file, VSBuffer.fromString(text));
	}

	async function read(): Promise<string> {
		return (await fileService.readFile(file)).value.toString();
	}

	async function settle(): Promise<void> {
		for (let i = 0; i < 4; i++) {
			await new Promise(resolve => setTimeout(resolve, 80));
			await service.whenSettled();
		}
	}

	function emitRunEnd(sessionId: string): void {
		events.fire({ seq: 1, runId: 'r', sessionId, timestamp: Date.now(), event: { type: 'run.end', runId: 'r', reason: 'done' } });
	}

	test('two chats editing one file: each is credited and undoes only its own change', async () => {
		await create();
		await write('a\nb\nc\nd\ne\nf\n');
		await write('A\nb\nc\nd\ne\nf\n');
		service.recordBaseline('A', file, 'a\nb\nc\nd\ne\nf\n');
		await settle();
		await write('A\nb\nc\nd\ne\nF\n');
		service.recordBaseline('B', file, 'A\nb\nc\nd\ne\nf\n');
		await settle();

		const a = service.getPendingFile(file, 'A')!;
		const b = service.getPendingFile(file, 'B')!;
		assert.deepStrictEqual([a.additions, a.deletions, b.additions, b.deletions], [1, 1, 1, 1], 'no cross-credit');
		assert.ok(a.modifiedUri, 'the older chat diffs against a frozen copy');
		assert.strictEqual(sessionFromBaseline(a.modifiedUri), 'A');
		assert.notStrictEqual(a.baselineUri.toString(), b.baselineUri.toString());
		assert.strictEqual(service.getPendingFile(file)?.sessionId, 'B', 'the newest entry follows the live file');

		// Undo the older chat: its line goes, the newer chat's stays, and B's diff stays B's.
		assert.strictEqual(await service.undoFile(file, 'A'), true);
		assert.strictEqual(await read(), 'a\nb\nc\nd\ne\nF\n');
		await settle();
		const after = service.getPendingFile(file, 'B')!;
		assert.deepStrictEqual([after.additions, after.deletions], [1, 1]);
		assert.strictEqual(service.getPendingFile(file, 'A'), undefined);
		assert.strictEqual(service.getPendingFiles('B').length, 1);
	});

	test('undoing the newer chat hands the file back to the older one', async () => {
		await create();
		await write('x\n');
		await write('x\na\n');
		service.recordBaseline('A', file, 'x\n');
		await settle();
		await write('x\na\nb\n');
		service.recordBaseline('B', file, 'x\na\n');
		await settle();
		assert.strictEqual(await service.undoFile(file, 'B'), true);
		assert.strictEqual(await read(), 'x\na\n');
		await settle();
		const a = service.getPendingFile(file);
		assert.strictEqual(a?.sessionId, 'A');
		assert.strictEqual(a.modifiedUri, undefined, 'live again');
		assert.strictEqual(await service.undoFile(file), true);
		assert.strictEqual(await read(), 'x\n');
	});

	test('undo keeps edits made after the agent when they merge, and asks when they overlap', async () => {
		await create();
		await write('one\ntwo\nthree\nfour\nfive\nsix\n');
		await write('ONE\ntwo\nthree\nfour\nfive\nsix\n');
		service.recordBaseline('A', file, 'one\ntwo\nthree\nfour\nfive\nsix\n');
		await settle();
		emitRunEnd('A');
		await settle();
		// The user edits far away from the agent's change.
		await write('ONE\ntwo\nthree\nfour\nfive\nsix (mine)\n');
		await settle();
		assert.strictEqual(await service.undoFile(file, 'A'), true);
		assert.strictEqual(await read(), 'one\ntwo\nthree\nfour\nfive\nsix (mine)\n');

		// Overlapping edit: the user cancels, nothing changes and the entry stays.
		await write('one\n');
		await write('agent\n');
		service.recordBaseline('A', file, 'one\n');
		await settle();
		emitRunEnd('A');
		await settle();
		await write('agent and me\n');
		await settle();
		dialogs.setConfirmResult({ confirmed: false });
		assert.strictEqual(await service.undoFile(file, 'A'), false);
		assert.strictEqual(await read(), 'agent and me\n');
		assert.ok(service.getPendingFile(file, 'A'), 'still pending');
		dialogs.setConfirmResult({ confirmed: true });
		assert.strictEqual(await service.undoFile(file, 'A'), true);
		assert.strictEqual(await read(), 'one\n');
	});

	test('a failed undo keeps the entry and its baseline', async () => {
		await create();
		await write('before\n');
		await write('after\n');
		service.recordBaseline('A', file, 'before\n');
		await settle();
		const textFiles = instantiation.get(ITextFileService);
		const save = textFiles.save;
		textFiles.save = async () => { throw new Error('disk full'); };
		try {
			assert.strictEqual(await service.undoFile(file, 'A'), false);
		} finally {
			textFiles.save = save;
		}
		await settle();
		const pending = service.getPendingFile(file, 'A');
		assert.ok(pending, 'not dropped');
		assert.strictEqual(service.getBaselineModel(pending.baselineUri)?.getValue(), 'before\n');
		assert.strictEqual(await read(), 'after\n');
		assert.strictEqual(await service.undoFile(file, 'A'), true);
		assert.strictEqual(await read(), 'before\n');
	});

	test('created files are deleted on undo; binary entries restore from the snapshot', async () => {
		instantiation.stub(IVoltGitService, { readBlob: async () => VSBuffer.wrap(new Uint8Array([1, 0, 2])) } as Partial<IVoltGitService>);
		await create();
		await write('new\n');
		service.recordBaseline('A', file, undefined);
		await settle();
		assert.strictEqual(service.getPendingFile(file)?.kind, 'added');
		assert.strictEqual(await service.undoFile(file), true);
		assert.strictEqual(await fileService.exists(file), false);

		const image = URI.file('/project/logo.png');
		await fileService.writeFile(image, VSBuffer.wrap(new Uint8Array([9, 9])));
		service.recordBinaryBaseline('A', image, { repoRoot: '/project', blob: 'b'.repeat(40), path: 'logo.png' });
		await settle();
		assert.deepStrictEqual([service.getPendingFile(image)?.binary, service.getPendingFile(image)?.kind], [true, 'modified']);
		assert.strictEqual(await service.undoFile(image), true);
		assert.deepStrictEqual([...(await fileService.readFile(image)).value.buffer], [1, 0, 2]);
		assert.strictEqual(service.getPendingFile(image), undefined);
	});

	test('pending entries survive a reload, per chat and frozen state included', async () => {
		await create();
		await write('x\n');
		await write('x\na\n');
		service.recordBaseline('A', file, 'x\n');
		await settle();
		await write('x\na\nb\n');
		service.recordBaseline('B', file, 'x\na\n');
		await settle();
		await new Promise(resolve => setTimeout(resolve, 600));
		service.dispose();
		store.delete(service);

		const reloaded = store.add(instantiation.createInstance(AgentEditsService));
		service = reloaded;
		await settle();
		assert.deepStrictEqual(reloaded.getPendingFiles().map(f => [f.sessionId, f.additions, !!f.modifiedUri]), [['A', 1, true], ['B', 1, false]]);
	});

});

suite('Discard changes', () => {

	let store: DisposableStore;
	teardown(() => store.dispose());
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiation: TestInstantiationService;
	let fileService: IFileService;
	let dialogs: TestDialogService;
	let restoreCalls: { uri: URI; overwrite?: boolean }[];
	let restoreOutcomes: (VoltGitRestoreOutcome | 'unavailable')[];
	let undoCalls: { uri: URI; sessionId?: string }[];
	let pending: URI | undefined;
	const file = URI.file('/project/app.ts');
	const fullText = 'line 1\nline 2\nold_string\nline 4\n';

	setup(async () => {
		store = disposables.add(new DisposableStore());
		instantiation = workbenchInstantiationService({
			fileService: () => {
				const files = store.add(new FileService(new NullLogService()));
				store.add(files.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
				return files;
			},
		}, store);
		fileService = instantiation.get(IFileService);
		await fileService.writeFile(file, VSBuffer.fromString(fullText.replace('old_string', 'new_string')));
		dialogs = new TestDialogService({ confirmed: true });
		instantiation.stub(IDialogService, dialogs);
		instantiation.stub(ISCMService, { repositories: [], onDidAddRepository: Event.None, onDidRemoveRepository: Event.None } as Partial<ISCMService>);
		instantiation.stub(IVoltSessionContextService, { rootFor: () => URI.file('/project') } as Partial<IVoltSessionContextService>);
		restoreCalls = [];
		restoreOutcomes = [];
		undoCalls = [];
		pending = undefined;
		instantiation.stub(IAgentCheckpointService, {
			onDidChange: Event.None,
			getChanges: async () => [],
			restoreFile: async (_sessionId: string, uri: URI, options?: { overwrite?: boolean }) => {
				restoreCalls.push({ uri, overwrite: options?.overwrite });
				return restoreOutcomes.shift() ?? 'unavailable';
			},
		} as Partial<IAgentCheckpointService>);
		instantiation.stub(IAgentEditsService, {
			onDidChange: Event.None,
			getPendingFiles: () => [],
			getPendingFile: (uri: URI) => pending && uri.toString() === pending.toString() ? { uri } as ReturnType<IAgentEditsService['getPendingFile']> : undefined,
			undoFile: async (uri: URI, sessionId?: string) => {
				undoCalls.push({ uri, sessionId });
				return true;
			},
		} as Partial<IAgentEditsService>);
	});

	function create(verb: FileChangeVerb, original: string | undefined): AgentSessionChangesService {
		const service = store.add(instantiation.createInstance(AgentSessionChangesService));
		service.setSessionTranscript('S', [{
			kind: 'agent',
			id: 't1',
			segments: [{ kind: 'block', block: createFileChangeBlock({ id: 'f', path: '/project/app.ts', verb, original, modified: 'new_string', additions: 1, deletions: 1 }) }],
		}]);
		return service;
	}

	async function read(): Promise<string | undefined> {
		return fileService.exists(file).then(found => found ? fileService.readFile(file).then(content => content.value.toString()) : undefined);
	}

	test('never writes the edit\'s snippet over the file when there is no real baseline', async () => {
		const service = create('Edited', 'old_string');
		assert.strictEqual(await service.discardFile('S', file), false);
		assert.strictEqual(await read(), 'line 1\nline 2\nnew_string\nline 4\n', 'untouched');
		assert.strictEqual(restoreCalls.length, 1);
		assert.strictEqual(service.getFiles('S', 'uncommitted').length, 1, 'still listed');
	});

	test('never deletes an overwritten file just because the tool reported no old text', async () => {
		const service = create('Created', undefined);
		assert.strictEqual(await service.discardFile('S', file), false);
		assert.ok(await read(), 'still there');
	});

	test('uses this chat\'s pending baseline first', async () => {
		pending = file;
		const service = create('Edited', 'old_string');
		assert.strictEqual(await service.discardFile('S', file), true);
		assert.deepStrictEqual(undoCalls.map(call => [call.uri.toString(), call.sessionId]), [[file.toString(), 'S']]);
		assert.strictEqual(restoreCalls.length, 0);
		assert.strictEqual(service.getFiles('S', 'uncommitted').length, 0);
	});

	test('falls back to the snapshots, asking before overwriting later edits', async () => {
		const service = create('Edited', 'old_string');
		restoreOutcomes = ['conflict', 'restored'];
		assert.strictEqual(await service.discardFile('S', file), true);
		assert.deepStrictEqual(restoreCalls.map(call => call.overwrite), [undefined, true]);
		assert.strictEqual(service.getFiles('S', 'uncommitted').length, 0);
	});
});
