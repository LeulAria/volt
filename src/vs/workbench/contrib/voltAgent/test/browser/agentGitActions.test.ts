/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltGitStatus } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import {
	actionIncludesCommit,
	buildMenuItems,
	defaultBranchPromptCopy,
	featureBranchName,
	requiresDefaultBranchConfirmation,
	resolveQuickAction,
	summarizeResult,
} from '../../common/agentGitActions.js';

function status(overrides: Partial<IVoltGitStatus> = {}): IVoltGitStatus {
	return {
		root: '/repo',
		branch: 'feature/x',
		remote: 'origin',
		remotes: ['origin'],
		upstream: 'feature/x',
		ahead: 0,
		behind: 0,
		defaultBranch: 'main',
		isDefaultBranch: false,
		aheadOfDefault: 0,
		files: [],
		insertions: 0,
		deletions: 0,
		...overrides,
	};
}

const changed = [{ path: 'a.ts', status: 'modified' as const, additions: 3, deletions: 1 }];

suite('agentGitActions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveQuickAction', () => {
		test('changes on a feature branch: commit, push and open a pull request', () => {
			const quick = resolveQuickAction({ status: status({ files: changed }), hasOpenPr: false, busy: false });
			assert.strictEqual(quick.action, 'commitPushPr');
			assert.strictEqual(quick.disabled, false);
		});

		test('changes with an open pull request or on the default branch: commit and push', () => {
			assert.strictEqual(resolveQuickAction({ status: status({ files: changed }), hasOpenPr: true, busy: false }).action, 'commitPush');
			assert.strictEqual(resolveQuickAction({ status: status({ files: changed, branch: 'main', isDefaultBranch: true }), hasOpenPr: false, busy: false }).action, 'commitPush');
		});

		test('changes without a remote: commit only', () => {
			const quick = resolveQuickAction({ status: status({ files: changed, remote: undefined, upstream: undefined }), hasOpenPr: false, busy: false });
			assert.strictEqual(quick.action, 'commit');
		});

		test('no upstream yet: push and create, or a hint when there is nothing to push', () => {
			assert.strictEqual(resolveQuickAction({ status: status({ upstream: undefined, aheadOfDefault: 2 }), hasOpenPr: false, busy: false }).action, 'createPr');
			const nothing = resolveQuickAction({ status: status({ upstream: undefined, aheadOfDefault: 0 }), hasOpenPr: false, busy: false });
			assert.strictEqual(nothing.kind, 'hint');
			assert.strictEqual(nothing.disabled, true);
			assert.strictEqual(resolveQuickAction({ status: status({ upstream: undefined, aheadOfDefault: 2 }), hasOpenPr: true, busy: false }).action, 'push');
		});

		test('behind pulls, diverged asks to sync, ahead pushes', () => {
			assert.strictEqual(resolveQuickAction({ status: status({ behind: 2 }), hasOpenPr: false, busy: false }).kind, 'pull');
			const diverged = resolveQuickAction({ status: status({ behind: 1, ahead: 1 }), hasOpenPr: false, busy: false });
			assert.strictEqual(diverged.disabled, true);
			assert.strictEqual(resolveQuickAction({ status: status({ ahead: 1, aheadOfDefault: 3 }), hasOpenPr: false, busy: false }).action, 'createPr');
			assert.strictEqual(resolveQuickAction({ status: status({ ahead: 1, aheadOfDefault: 3 }), hasOpenPr: true, busy: false }).action, 'push');
		});

		test('up to date: Create PR when the branch has work, else nothing to do', () => {
			assert.strictEqual(resolveQuickAction({ status: status({ aheadOfDefault: 2 }), hasOpenPr: false, busy: false }).action, 'createPr');
			assert.strictEqual(resolveQuickAction({ status: status({ aheadOfDefault: 2 }), hasOpenPr: true, busy: false }).disabled, true);
			assert.strictEqual(resolveQuickAction({ status: status({ aheadOfDefault: 0 }), hasOpenPr: false, busy: false }).disabled, true);
		});

		test('a branch whose pull request already merged at this commit offers nothing new', () => {
			const landed = { number: 7, state: 'merged' as const };
			const quick = resolveQuickAction({ status: status({ aheadOfDefault: 2 }), hasOpenPr: false, busy: false, landedPr: landed });
			assert.strictEqual(quick.disabled, true);
			assert.ok(quick.hint?.includes('#7'));
			// Deleted on GitHub after the merge: still nothing to push.
			assert.strictEqual(resolveQuickAction({ status: status({ upstream: undefined, aheadOfDefault: 2 }), hasOpenPr: false, busy: false, landedPr: landed }).disabled, true);
			// New changes are new work.
			assert.strictEqual(resolveQuickAction({ status: status({ files: changed, aheadOfDefault: 2 }), hasOpenPr: false, busy: false, landedPr: landed }).action, 'commitPushPr');
			assert.strictEqual(buildMenuItems({ status: status({ aheadOfDefault: 2 }), hasOpenPr: false, busy: false, landedPr: landed }).find(item => item.id === 'createPr')?.disabled, true);
		});

		test('conflicted files block committing until they are resolved', () => {
			const conflicted = status({ files: [{ path: 'a.ts', status: 'conflicted', additions: 0, deletions: 0 }] });
			const quick = resolveQuickAction({ status: conflicted, hasOpenPr: false, busy: false });
			assert.strictEqual(quick.disabled, true);
			assert.ok(quick.hint?.toLowerCase().includes('conflict'));
			assert.strictEqual(buildMenuItems({ status: conflicted, hasOpenPr: false, busy: false })[0].disabled, true);
		});

		test('nothing ahead without an upstream is nothing to push, on the default branch too', () => {
			assert.strictEqual(resolveQuickAction({ status: status({ branch: 'main', isDefaultBranch: true, upstream: undefined, aheadOfDefault: 0 }), hasOpenPr: false, busy: false }).disabled, true);
		});

		test('busy, no repository and a detached head do nothing', () => {
			assert.strictEqual(resolveQuickAction({ status: status({ files: changed }), hasOpenPr: false, busy: true }).disabled, true);
			assert.strictEqual(resolveQuickAction({ status: undefined, hasOpenPr: false, busy: false }).disabled, true);
			assert.strictEqual(resolveQuickAction({ status: status({ branch: undefined, files: changed }), hasOpenPr: false, busy: false }).disabled, true);
		});
	});

	suite('buildMenuItems', () => {
		test('a feature branch with changes: Commit on, Push and Create PR say why they wait', () => {
			const items = buildMenuItems({ status: status({ files: changed }), hasOpenPr: false, busy: false });
			assert.deepStrictEqual(items.map(item => [item.id, item.disabled]), [['commit', false], ['push', true], ['createPr', true]]);
			assert.ok(items[1].hint);
			assert.ok(items[2].hint);
		});

		test('an open pull request leaves Create PR out; no remote leaves only Commit', () => {
			assert.deepStrictEqual(buildMenuItems({ status: status({ ahead: 1 }), hasOpenPr: true, busy: false }).map(item => item.id), ['commit', 'push']);
			assert.deepStrictEqual(buildMenuItems({ status: status({ remote: undefined }), hasOpenPr: false, busy: false }).map(item => item.id), ['commit']);
		});

		test('a remote that is not origin: Commit and Push, never Create PR', () => {
			const fork = { remote: 'upstream', remotes: ['upstream'] };
			assert.deepStrictEqual(buildMenuItems({ status: status({ ...fork, ahead: 1, aheadOfDefault: 1 }), hasOpenPr: false, busy: false }).map(item => item.id), ['commit', 'push']);
			assert.strictEqual(resolveQuickAction({ status: status({ ...fork, files: changed }), hasOpenPr: false, busy: false }).action, 'commitPush');
			assert.strictEqual(resolveQuickAction({ status: status({ ...fork, ahead: 1, aheadOfDefault: 1 }), hasOpenPr: false, busy: false }).action, 'push');
			assert.strictEqual(resolveQuickAction({ status: status({ ...fork, upstream: undefined, aheadOfDefault: 2 }), hasOpenPr: false, busy: false }).action, 'push');
			assert.strictEqual(resolveQuickAction({ status: status({ ...fork, aheadOfDefault: 2 }), hasOpenPr: false, busy: false }).disabled, true);
		});

		test('clean, ahead of the default branch: Push and Create PR are offered', () => {
			const items = buildMenuItems({ status: status({ ahead: 1, aheadOfDefault: 1 }), hasOpenPr: false, busy: false });
			assert.deepStrictEqual(items.map(item => [item.id, item.disabled]), [['commit', true], ['push', false], ['createPr', false]]);
		});

		test('Create PR is not offered from the default branch', () => {
			const items = buildMenuItems({ status: status({ branch: 'main', upstream: 'main', isDefaultBranch: true, ahead: 1, aheadOfDefault: 1 }), hasOpenPr: false, busy: false });
			assert.strictEqual(items.find(item => item.id === 'createPr')?.disabled, true);
		});

		test('no status: no menu', () => {
			assert.deepStrictEqual(buildMenuItems({ status: undefined, hasOpenPr: false, busy: false }), []);
		});
	});

	test('default branch confirmation covers pushes and pull requests, not a plain commit', () => {
		const main = status({ branch: 'main', isDefaultBranch: true, files: changed });
		assert.strictEqual(requiresDefaultBranchConfirmation('commit', main), false);
		assert.strictEqual(requiresDefaultBranchConfirmation('commitPush', main), true);
		assert.strictEqual(requiresDefaultBranchConfirmation('push', main), true);
		assert.strictEqual(requiresDefaultBranchConfirmation('push', status()), false);
		const copy = defaultBranchPromptCopy('commitPush', 'main', actionIncludesCommit('commitPush', main));
		assert.ok(copy.message.includes('main'));
		assert.ok(copy.continueLabel.includes('main'));
	});

	test('feature branch names come from the subject and stay unique', () => {
		assert.strictEqual(featureBranchName('feat(api): Add word counts to notes!', []), 'volt/add-word-counts-to-notes');
		assert.strictEqual(featureBranchName('Add word counts', ['volt/add-word-counts']), 'volt/add-word-counts-2');
		assert.strictEqual(featureBranchName('Add word counts', ['volt/add-word-counts', 'VOLT/add-word-counts-2']), 'volt/add-word-counts-3');
		assert.strictEqual(featureBranchName('!!!', []), 'volt/changes');
		assert.strictEqual(featureBranchName(undefined, []), 'volt/changes');
	});

	test('the result toast names what happened and offers the next step', () => {
		assert.strictEqual(summarizeResult({ pr: { number: 7, url: 'u', existing: false } }).next, 'viewPr');
		assert.ok(summarizeResult({ pr: { number: 7, url: 'u', existing: true } }).title.includes('7'));
		const pushed = summarizeResult({ commit: { sha: 'abcdef1234', subject: 'Fix it' }, pushed: { branch: 'x', remote: 'origin' } });
		assert.ok(pushed.title.includes('abcdef1'));
		assert.strictEqual(pushed.next, 'createPr');
		assert.strictEqual(summarizeResult({ commit: { sha: 'abcdef1234', subject: 'Fix it' } }).next, 'push');
		assert.strictEqual(summarizeResult({}).next, undefined);
	});
});
