/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltGitStatusFile } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { commitPlanOutcomeText, isPlaceholderBranch, normalizeBranchName, normalizePlanPath, parseCommitPlan, splitCommitMessage } from '../../common/agentCommitPlan.js';

const ROOT = '/repo';

function file(path: string, extra: Partial<IVoltGitStatusFile> = {}): IVoltGitStatusFile {
	return { path, status: 'modified', additions: 1, deletions: 0, ...extra };
}

suite('Agent commit plan', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const files = [file('src/a.ts'), file('src/b.ts'), file('docs/readme.md'), file('src/new.ts', { status: 'renamed', previousPath: 'src/old.ts' })];

	test('splits the changes into the commits given, in order, and reports the files no commit took', () => {
		const plan = parseCommitPlan({
			commits: [
				{ message: 'feat: a and b', files: ['./src/a.ts', '/repo/src/b.ts'] },
				{ message: 'refactor: move old', files: ['src/old.ts'] },
			],
		}, ROOT, files);
		assert.deepStrictEqual(plan, {
			commits: [
				{ message: 'feat: a and b', paths: ['src/a.ts', 'src/b.ts'] },
				// A rename named by the path it left is the renamed file.
				{ message: 'refactor: move old', paths: ['src/new.ts'] },
			],
			leftover: ['docs/readme.md'],
		});
	});

	test('says what to fix: unknown files, a file in two commits, missing message or files', () => {
		const unknown = parseCommitPlan({ commits: [{ message: 'x', files: ['src/zzz.ts'] }] }, ROOT, files);
		assert.ok('error' in unknown && unknown.error.includes('src/zzz.ts') && unknown.error.includes('src/a.ts'), 'names the bad file and lists the changed ones');
		const twice = parseCommitPlan({ commits: [{ message: 'x', files: ['src/a.ts'] }, { message: 'y', files: ['src/a.ts'] }] }, ROOT, files);
		assert.ok('error' in twice && twice.error.includes('commit 1 and commit 2'));
		const noMessage = parseCommitPlan({ commits: [{ message: ' ', files: ['src/a.ts'] }] }, ROOT, files);
		assert.ok('error' in noMessage && noMessage.error.includes('no `message`'));
		const noFiles = parseCommitPlan({ commits: [{ message: 'x', files: [] }] }, ROOT, files);
		assert.ok('error' in noFiles && noFiles.error.includes('no `files`'));
		const clean = parseCommitPlan({ commits: [{ message: 'x', files: ['a'] }] }, ROOT, []);
		assert.ok('error' in clean && clean.error.includes('nothing to commit'));
	});

	test('reads paths, messages and branch names the way people write them', () => {
		assert.strictEqual(normalizePlanPath('.\\src\\a.ts', ROOT), 'src/a.ts');
		assert.strictEqual(normalizePlanPath('/repo/src/', ROOT), 'src');
		assert.deepStrictEqual(splitCommitMessage('feat: x\n\nWhy it matters.\nMore.'), { subject: 'feat: x', body: 'Why it matters.\nMore.' });
		assert.deepStrictEqual(splitCommitMessage('fix: y'), { subject: 'fix: y', body: '' });
		assert.strictEqual(normalizeBranchName(' refs/heads/feat/commit review '), 'feat/commit-review');
	});

	test('knows a worktree placeholder branch and reminds the agent to name it after committing', () => {
		assert.ok(isPlaceholderBranch('volt/f7175242'));
		assert.ok(!isPlaceholderBranch('volt/commit-review'));
		assert.ok(!isPlaceholderBranch('main'));
		const text = commitPlanOutcomeText({ committed: [{ sha: 'abcdef1234', subject: 'feat: x', files: 2 }], uncommitted: ['docs/readme.md'], branch: 'volt/f7175242' });
		assert.ok(text.includes('abcdef1 feat: x (2 files)'));
		assert.ok(text.includes('Left uncommitted'));
		assert.ok(text.includes('rename_branch'), 'tells the agent to ask for a name before pushing');
		const named = commitPlanOutcomeText({ committed: [{ sha: 'abcdef1234', subject: 'feat: x', files: 1 }], uncommitted: [], branch: 'feat/x' });
		assert.ok(!named.includes('rename_branch'));
		assert.ok(commitPlanOutcomeText({ committed: [], uncommitted: ['a'], dismissed: true }).includes('without committing'));
	});
});
