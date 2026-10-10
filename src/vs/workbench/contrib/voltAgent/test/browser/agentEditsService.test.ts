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
import { Range } from '../../../../../editor/common/core/range.js';
import { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
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
import { agentTurnScope, IAgentSessionFileChange, mergeSnapshotChanges } from '../../browser/review/agentSessionChanges.js';
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
	/** Report hunks without character-level detail, as a diff that timed out does. */
	dropInnerChanges = false;

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
		const changes = this.dropInnerChanges ? result.changes.map(change => new DetailedLineRangeMapping(change.original, change.modified, undefined)) : result.changes;
		return { identical: !changes.length, quitEarly: result.hitTimeout, changes, moves: result.moves };
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
		worker = new DiffingWorkerService(() => instantiation.get(IModelService));
		instantiation.stub(IEditorWorkerService, worker);
		dialogs = new TestDialogService();
		instantiation.stub(IDialogService, dialogs);
	});

	let worker: DiffingWorkerService;

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

	/** Shared text, or one hunk as `[before, after]`. Hunks are kept apart by unchanged lines. */
	type HunkPart = string | readonly [before: string, after: string];

	const singleHunkCases: { readonly name: string; readonly parts: readonly HunkPart[] }[] = [
		{ name: 'insert at start', parts: [['', 'X\n'], 'a\nb\nc\n'] },
		{ name: 'insert in the middle', parts: ['a\n', ['', 'X\nY\n'], 'b\nc\n'] },
		{ name: 'insert at end', parts: ['a\nb\n', ['', 'X\n']] },
		{ name: 'delete at start', parts: [['a\n', ''], 'b\nc\n'] },
		{ name: 'delete in the middle', parts: ['a\n', ['b\nc\n', ''], 'd\n'] },
		{ name: 'delete at end', parts: ['a\nb\n', ['c\n', '']] },
		{ name: 'modify at start', parts: [['a\n', 'A\n'], 'b\nc\n'] },
		{ name: 'modify in the middle', parts: ['a\n', ['b\n', 'B1\nB2\n'], 'c\n'] },
		{ name: 'modify at end', parts: ['a\nb\n', ['c\n', 'C\n']] },
		{ name: 'no final newline: append a line', parts: ['a\nb', ['', '\nc']] },
		{ name: 'no final newline: delete the last line', parts: ['a\nb', ['\nc', '']] },
		{ name: 'no final newline: modify the last line', parts: ['a\nb\n', ['c', 'C']] },
		{ name: 'final newline added', parts: ['a\nb', ['', '\n']] },
		{ name: 'final newline removed', parts: ['a\nb', ['\n', '']] },
		{ name: 'empty file filled', parts: [['', 'a\nb\n']] },
		{ name: 'file emptied', parts: [['a\nb\n', '']] },
		{ name: 'CRLF insert', parts: ['a\r\n', ['', 'X\r\n'], 'b\r\n'] },
		{ name: 'CRLF delete at end', parts: ['a\r\nb\r\n', ['c\r\n', '']] },
		{ name: 'CRLF modify', parts: ['a\r\n', ['b\r\n', 'B\r\n'], 'c\r\n'] },
	];

	const multiHunkCases: { readonly name: string; readonly parts: readonly HunkPart[] }[] = [
		{ name: 'three hunks', parts: [['a\n', 'A\n'], 'b\nc\nd\n', ['', 'X\nY\n'], 'e\nf\ng\n', ['h\n', '']] },
		{ name: 'three hunks, CRLF, no final newline', parts: ['a\r\n', ['b\r\n', ''], 'c\r\nd\r\ne\r\n', ['f\r\n', 'F\r\nG\r\n'], 'h\r\ni\r\nj', ['', '\r\nk']] },
	];

	function compose(parts: readonly HunkPart[], side: (hunk: number) => 0 | 1): string {
		let hunk = 0;
		return parts.map(part => typeof part === 'string' ? part : part[side(hunk++)]).join('');
	}

	async function waitFor(condition: () => boolean, what: string): Promise<void> {
		for (let i = 0; i < 200 && !condition(); i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
			await service.whenSettled();
		}
		assert.ok(condition(), `timed out waiting for ${what}`);
	}

	let hunkFile = 0;

	/**
	 * Keeps or undoes each hunk of `parts` in file order, checking the file on disk and the
	 * baseline after every step. Returns the failure instead of throwing, so one run reports
	 * every broken case.
	 */
	async function reviewHunks(name: string, parts: readonly HunkPart[], choices: readonly ('keep' | 'undo')[]): Promise<string | undefined> {
		const uri = URI.file(`/project/hunks-${hunkFile++}.txt`);
		const label = `${name} [${choices.join(', ')}]${worker.dropInnerChanges ? ' without inner changes' : ''}`;
		try {
			await fileService.writeFile(uri, VSBuffer.fromString(compose(parts, () => 1)));
			service.recordBaseline('A', uri, compose(parts, () => 0));
			await waitFor(() => service.getPendingFile(uri, 'A')?.changes.length === choices.length, `${choices.length} hunks`);
			for (let step = 0; step < choices.length; step++) {
				const pending = service.getPendingFile(uri, 'A')!;
				const change = pending.changes[0];
				const done = choices[step] === 'keep' ? await service.keepHunk(uri, change, 'A') : await service.undoHunk(uri, change, 'A');
				assert.strictEqual(done, true, `step ${step} applied`);
				if (step === choices.length - 1) {
					await waitFor(() => !service.getPendingFile(uri, 'A'), 'the entry to resolve');
				} else {
					await waitFor(() => service.getPendingFile(uri, 'A')?.changes.length === choices.length - step - 1, `hunks left after step ${step}`);
					const baseline = compose(parts, hunk => hunk <= step && choices[hunk] === 'keep' ? 1 : 0);
					assert.strictEqual(JSON.stringify(service.getBaselineModel(pending.baselineUri)?.getValue()), JSON.stringify(baseline), `baseline after step ${step}`);
				}
				const expected = compose(parts, hunk => hunk <= step && choices[hunk] === 'undo' ? 0 : 1);
				assert.strictEqual(JSON.stringify((await fileService.readFile(uri)).value.toString()), JSON.stringify(expected), `file after step ${step}`);
			}
			return undefined;
		} catch (err) {
			return `${label}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	test('keep or undo a single hunk anywhere in the file', async function () {
		this.timeout(120_000);
		await create();
		const failures: string[] = [];
		for (const dropInner of [false, true]) {
			worker.dropInnerChanges = dropInner;
			for (const { name, parts } of singleHunkCases) {
				for (const choice of ['keep', 'undo'] as const) {
					const failure = await reviewHunks(name, parts, [choice]);
					if (failure) {
						failures.push(failure);
					}
				}
			}
		}
		assert.deepStrictEqual(failures, []);
	});

	test('keep some hunks and undo others, in every combination', async function () {
		this.timeout(120_000);
		await create();
		const failures: string[] = [];
		for (const dropInner of [false, true]) {
			worker.dropInnerChanges = dropInner;
			for (const { name, parts } of multiHunkCases) {
				const count = parts.filter(part => typeof part !== 'string').length;
				for (let mask = 0; mask < 1 << count; mask++) {
					const failure = await reviewHunks(name, parts, Array.from({ length: count }, (_, i) => mask & (1 << i) ? 'undo' : 'keep'));
					if (failure) {
						failures.push(failure);
					}
				}
			}
		}
		assert.deepStrictEqual(failures, []);
	});

	test('undoing a hunk keeps what the user typed elsewhere in the file', async () => {
		await create();
		await write('a\nb\nc\nd\ne\n');
		await write('a\nB\nc\nd\ne\n');
		service.recordBaseline('A', file, 'a\nb\nc\nd\ne\n');
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 1, 'the agent hunk');
		const model = instantiation.get(IModelService).getModel(file)!;
		model.pushEditOperations(null, [{ range: new Range(5, 1, 5, 2), text: 'E (mine)' }], () => null);
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 2, 'the typed line to show');
		const agentHunk = service.getPendingFile(file, 'A')!.changes.find(change => change.modified.startLineNumber === 2)!;
		assert.strictEqual(await service.undoHunk(file, agentHunk, 'A'), true);
		assert.strictEqual(model.getValue(), 'a\nb\nc\nd\nE (mine)\n');
		assert.strictEqual(await read(), 'a\nb\nc\nd\nE (mine)\n');
	});

	test('undoing the only hunk of a file the agent created deletes the file', async () => {
		await create();
		await write('created\nby agent\n');
		service.recordBaseline('A', file, undefined);
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 1, 'the created file');
		const resolved: string[] = [];
		store.add(service.onDidResolve(e => resolved.push(`${e.sessionId}:${e.outcome}`)));
		assert.strictEqual(await service.undoHunk(file, service.getPendingFile(file, 'A')!.changes[0], 'A'), true);
		await waitFor(() => !service.getPendingFile(file, 'A'), 'the entry to resolve');
		assert.strictEqual(await fileService.exists(file), false);
		assert.deepStrictEqual(resolved, ['A:undone']);
	});

	test('settling the last hunk resolves the file like Keep File / Undo File', async () => {
		await create();
		const resolved: string[] = [];
		store.add(service.onDidResolve(e => resolved.push(`${e.outcome}`)));
		await write('x\ny\nz\n');
		await write('X\ny\nz\n');
		service.recordBaseline('A', file, 'x\ny\nz\n');
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 1, 'one hunk');
		await service.keepHunk(file, service.getPendingFile(file, 'A')!.changes[0], 'A');
		await waitFor(() => !service.getPendingFile(file, 'A'), 'kept');
		await write('X\ny\nZ\n');
		service.recordBaseline('A', file, 'X\ny\nz\n');
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 1, 'one hunk');
		await service.undoHunk(file, service.getPendingFile(file, 'A')!.changes[0], 'A');
		await waitFor(() => !service.getPendingFile(file, 'A'), 'undone');
		assert.deepStrictEqual(resolved, ['kept', 'undone']);
	});

	test('Undo File after keeping one hunk keeps that hunk, also after a reload', async () => {
		await create();
		await write('a\nb\nc\nd\ne\n');
		await write('A\nb\nc\nd\nE\n');
		service.recordBaseline('A', file, 'a\nb\nc\nd\ne\n');
		emitRunEnd('A');
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 2, 'two hunks');
		await service.keepHunk(file, service.getPendingFile(file, 'A')!.changes[0], 'A');
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 1, 'one hunk left');
		await new Promise(resolve => setTimeout(resolve, 600));
		service.dispose();
		store.delete(service);
		service = store.add(instantiation.createInstance(AgentEditsService));
		await waitFor(() => service.getPendingFile(file, 'A')?.changes.length === 1, 'the kept hunk is still kept after a reload');
		assert.strictEqual(await service.undoFile(file, 'A'), true);
		assert.strictEqual(await read(), 'A\nb\nc\nd\ne\n');
	});

	async function setUpThreeFiles(): Promise<{ modified: URI; created: URI; deleted: URI }> {
		const modified = URI.file('/project/m.ts');
		const created = URI.file('/project/n.ts');
		const deleted = URI.file('/project/d.ts');
		await fileService.writeFile(modified, VSBuffer.fromString('m2\n'));
		await fileService.writeFile(created, VSBuffer.fromString('new\n'));
		service.recordBaseline('A', modified, 'm1\n');
		service.recordBaseline('A', created, undefined);
		service.recordBaseline('A', deleted, 'gone\n');
		service.recordBaseline('B', file, 'other chat\n');
		await fileService.writeFile(file, VSBuffer.fromString('other chat, edited\n'));
		await waitFor(() => service.getPendingFiles('A').length === 3 && service.getPendingFile(deleted, 'A')?.kind === 'deleted', 'three pending files');
		return { modified, created, deleted };
	}

	test('Undo All puts back every file of the chat, and only that chat', async () => {
		await create();
		const { modified, created, deleted } = await setUpThreeFiles();
		const resolved: string[] = [];
		store.add(service.onDidResolve(e => resolved.push(`${e.sessionId}:${e.outcome}`)));
		await service.undoAll('A');
		await waitFor(() => service.getPendingFiles('A').length === 0, 'no pending files');
		assert.strictEqual((await fileService.readFile(modified)).value.toString(), 'm1\n');
		assert.strictEqual(await fileService.exists(created), false);
		assert.strictEqual((await fileService.readFile(deleted)).value.toString(), 'gone\n');
		assert.deepStrictEqual(resolved, ['A:undone', 'A:undone', 'A:undone']);
		assert.strictEqual(service.getPendingFiles('B').length, 1, 'the other chat is untouched');
		assert.strictEqual(await read(), 'other chat, edited\n');
	});

	test('Keep All leaves every file as the agent left it', async () => {
		await create();
		const { modified, created, deleted } = await setUpThreeFiles();
		await service.keepAll('A');
		await waitFor(() => service.getPendingFiles('A').length === 0, 'no pending files');
		assert.strictEqual((await fileService.readFile(modified)).value.toString(), 'm2\n');
		assert.strictEqual((await fileService.readFile(created)).value.toString(), 'new\n');
		assert.strictEqual(await fileService.exists(deleted), false);
		assert.strictEqual(service.getPendingFiles('B').length, 1);
	});

	test('Undo All keeps the round in the chat\'s history', async () => {
		await create();
		instantiation.stub(IAgentEditsService, service);
		instantiation.stub(ISCMService, { repositories: [], onDidAddRepository: Event.None, onDidRemoveRepository: Event.None } as Partial<ISCMService>);
		instantiation.stub(IVoltSessionContextService, { rootFor: () => URI.file('/project') } as Partial<IVoltSessionContextService>);
		const turnChange = { uri: file, path: 'app.ts', kind: 'modified' as const, binary: false, additions: 1, deletions: 1, repoRoot: '/project', oldBlob: 'o', newBlob: 'n', turnId: 't1' };
		instantiation.stub(IAgentCheckpointService, {
			onDidChange: Event.None,
			getChanges: async (_sessionId: string, scope: unknown) => typeof scope === 'object' ? [turnChange] : [],
		} as Partial<IAgentCheckpointService>);
		const changes = store.add(instantiation.createInstance(AgentSessionChangesService));
		await write('before\n');
		await write('after\n');
		service.recordBaseline('S', file, 'before\n');
		changes.setSessionTranscript('S', [
			{ kind: 'user', id: 't1', text: 'change it' },
			{ kind: 'agent', id: 'a1', segments: [{ kind: 'block', block: createFileChangeBlock({ id: 'f', path: '/project/app.ts', verb: 'Edited', original: 'before', modified: 'after', additions: 1, deletions: 1 }) }] },
		]);
		await waitFor(() => changes.getStats('S', 'pending').files === 1, 'pending');
		changes.getStats('S', agentTurnScope('t1'));
		await changes.loadTurn('S', 't1');

		await service.undoAll('S');
		await waitFor(() => changes.getStats('S', 'pending').files === 0, 'undone');
		assert.strictEqual(await read(), 'before\n');
		assert.deepStrictEqual(changes.getFiles('S', 'lastTurn').map(f => f.path), ['project/app.ts'], 'the round still lists the file');
		assert.deepStrictEqual(changes.getFiles('S', 'uncommitted').map(f => f.path), ['project/app.ts']);
		assert.deepStrictEqual(changes.getStats('S', agentTurnScope('t1')), { files: 1, additions: 1, deletions: 1 }, 'the turn keeps its diff');
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
