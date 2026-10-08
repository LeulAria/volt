/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	cleanupPlan, describeMoveResult, moveRollback, parseStatusZ, parseWorkspaceMoveSpec, planCarry, presentAfterMove, shouldRemoveOldWorktree, validateBranchName, workspaceMoveNote,
} from '../../../common/git/workspaceMove.js';

/** `git status --porcelain=v1 -z --untracked-files=all` of a checkout with every kind of change. */
const STATUS = [
	'MM a.txt',
	' D b.txt',
	' M bin.dat',
	'R  ren2.txt', 'ren.txt',
	'A  sn.txt',
	'?? d/n2.txt',
	'?? new.txt',
	' M user-notes.md',
	'?? scratch.log',
].join('\0') + '\0';

suite('Volt workspace move: plan', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('porcelain -z: renames carry their source, untracked and staged entries keep their columns', () => {
		const entries = parseStatusZ(STATUS);
		assert.strictEqual(entries.length, 9);
		assert.deepStrictEqual(entries[3], { path: 'ren2.txt', origPath: 'ren.txt', x: 'R', y: ' ' });
		assert.deepStrictEqual(entries[0], { path: 'a.txt', x: 'M', y: 'M' });
		assert.deepStrictEqual(entries[5], { path: 'd/n2.txt', x: '?', y: '?' });
		assert.deepStrictEqual(parseStatusZ(''), []);
	});

	test('the thread\'s files move; the user\'s own dirty files and untracked junk stay', () => {
		const plan = planCarry({
			status: parseStatusZ(STATUS),
			threadPaths: ['a.txt', 'b.txt', 'bin.dat', 'ren.txt', 'ren2.txt', 'sn.txt', 'd', 'new.txt'],
			carry: 'thread',
		});
		assert.deepStrictEqual(plan.blockers, []);
		assert.deepStrictEqual([...plan.tracked].sort(), ['a.txt', 'b.txt', 'bin.dat', 'ren.txt', 'ren2.txt', 'sn.txt']);
		assert.deepStrictEqual([...plan.untracked].sort(), ['d/n2.txt', 'new.txt'], 'an untracked file in a folder the agent made goes too');
		assert.deepStrictEqual(plan.left.map(entry => entry.path), ['user-notes.md', 'scratch.log']);
		assert.match(plan.notes.join(' '), /2 other uncommitted files stay/);
	});

	test('carry all takes every uncommitted change; none takes nothing; unknown thread files take nothing and say so', () => {
		const all = planCarry({ status: parseStatusZ(STATUS), threadPaths: [], carry: 'all' });
		assert.strictEqual(all.moved.length, 9);
		assert.deepStrictEqual(all.left, []);
		const none = planCarry({ status: parseStatusZ(STATUS), threadPaths: ['a.txt'], carry: 'none' });
		assert.strictEqual(none.moved.length, 0);
		const unknown = planCarry({ status: parseStatusZ(STATUS), threadPaths: undefined, carry: 'thread' });
		assert.strictEqual(unknown.moved.length, 0);
		assert.match(unknown.notes.join(' '), /does not know which files/);
	});

	test('merge conflicts and an operation in progress block the move before anything changes', () => {
		const plan = planCarry({ status: parseStatusZ('UU a.txt\0 M b.txt\0'), threadPaths: ['a.txt', 'b.txt'], carry: 'thread', inProgress: 'merge' });
		assert.strictEqual(plan.blockers.length, 2);
		assert.match(plan.blockers[0], /merge is in progress/);
		assert.match(plan.blockers[1], /a\.txt has unresolved merge conflicts/);
	});

	test('a target checkout that changed the same files is a conflict; other dirty files there are fine', () => {
		const plan = planCarry({
			status: parseStatusZ(' M a.txt\0?? new.txt\0'),
			threadPaths: ['a.txt', 'new.txt'],
			carry: 'thread',
			targetStatus: parseStatusZ(' M a.txt\0 M unrelated.ts\0?? new.txt\0'),
		});
		assert.deepStrictEqual(plan.conflicts, ['a.txt', 'new.txt']);
	});

	test('cleanup restores what HEAD knows and deletes what it does not', () => {
		const plan = planCarry({ status: parseStatusZ(STATUS), threadPaths: [], carry: 'all' });
		const cleanup = cleanupPlan(plan.moved);
		assert.deepStrictEqual([...cleanup.restore].sort(), ['a.txt', 'b.txt', 'bin.dat', 'ren.txt', 'user-notes.md']);
		assert.deepStrictEqual([...cleanup.unstage].sort(), ['ren2.txt', 'sn.txt']);
		assert.deepStrictEqual([...cleanup.remove].sort(), ['d/n2.txt', 'new.txt', 'ren2.txt', 'scratch.log', 'sn.txt']);
		assert.deepStrictEqual(presentAfterMove(plan.moved).sort(), ['a.txt', 'bin.dat', 'd/n2.txt', 'new.txt', 'ren2.txt', 'scratch.log', 'sn.txt', 'user-notes.md']);
	});
});

suite('Volt workspace move: rollback and text', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('before the chat is re-bound a failure removes the copy; after it, nothing is undone', () => {
		assert.deepStrictEqual(moveRollback({ createdWorktree: { path: '/wt/x', branch: 'volt/x' } }), [{ kind: 'removeWorktree', path: '/wt/x', branch: 'volt/x' }]);
		assert.deepStrictEqual(moveRollback({ appliedTo: '/repo' }), [{ kind: 'restoreTarget', folder: '/repo' }]);
		assert.deepStrictEqual(moveRollback({ createdWorktree: { path: '/wt/x', branch: 'volt/x' }, rebound: true }), []);
		assert.deepStrictEqual(moveRollback({}), []);
	});

	test('the old worktree goes only when Volt made it and nothing in it would be lost', () => {
		assert.strictEqual(shouldRemoveOldWorktree({ managed: true, clean: true, unmergedCommits: 0, otherChats: 0 }), true);
		assert.strictEqual(shouldRemoveOldWorktree({ managed: false, clean: true, unmergedCommits: 0, otherChats: 0 }), false);
		assert.strictEqual(shouldRemoveOldWorktree({ managed: true, clean: false, unmergedCommits: 0, otherChats: 0 }), false);
		assert.strictEqual(shouldRemoveOldWorktree({ managed: true, clean: true, unmergedCommits: 2, otherChats: 0 }), false);
		assert.strictEqual(shouldRemoveOldWorktree({ managed: true, clean: true, unmergedCommits: 0, otherChats: 1 }), false);
	});

	test('specs, branch names, the model note and the divider text', () => {
		assert.deepStrictEqual(parseWorkspaceMoveSpec({ target: { kind: 'newWorktree', branch: ' feat/x ' }, carry: 'all' }), { target: { kind: 'newWorktree', branch: 'feat/x' }, carry: 'all' });
		assert.deepStrictEqual(parseWorkspaceMoveSpec({ target: { kind: 'local' } }), { target: { kind: 'local' }, carry: 'thread' });
		assert.strictEqual(parseWorkspaceMoveSpec({ target: { kind: 'worktree' } }), undefined);
		assert.strictEqual(validateBranchName('feat/move-it'), undefined);
		assert.ok(validateBranchName('bad name'));
		assert.ok(validateBranchName('a..b'));
		assert.ok(validateBranchName('x.lock'));
		const note = workspaceMoveNote({ fromPath: '/repo', toPath: '/wt/x', branch: 'volt/x', worktree: true, files: 2, left: 1 });
		assert.match(note, /moved from \/repo to the git worktree \/wt\/x \(branch volt\/x\)/);
		assert.match(note, /Work only in \/wt\/x/);
		assert.match(note, /\(2 files\) came along/);
		assert.match(note, /1 other uncommitted file stayed/);
		assert.strictEqual(describeMoveResult({ ok: true, worktree: true, branch: 'volt/x', files: 3 }), 'Moved to worktree volt/x · 3 files');
		assert.strictEqual(describeMoveResult({ ok: true, worktree: false, branch: 'main' }), 'Moved to local (main)');
	});
});
