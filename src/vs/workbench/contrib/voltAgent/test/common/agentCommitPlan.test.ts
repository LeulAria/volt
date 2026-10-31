/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltGitStatusFile } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { commitPlanOutcomeText, IPlanHunk, isPlaceholderBranch, normalizeBranchName, normalizePlanPath, parseCommitPlan, parseHunks, spliceHunks, splitCommitMessage } from '../../common/agentCommitPlan.js';

const ROOT = '/repo';

function file(path: string, extra: Partial<IVoltGitStatusFile> = {}): IVoltGitStatusFile {
	return { path, status: 'modified', additions: 1, deletions: 0, ...extra };
}

const PATCH = [
	'diff --git a/src/a.ts b/src/a.ts',
	'index 1111111..2222222 100644',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -2,1 +2,1 @@',
	'-b',
	'+B',
	'@@ -8,0 +9,1 @@',
	'+new line',
	'',
].join('\n');

const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj';

suite('Agent commit plan', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const files = [file('src/a.ts'), file('src/b.ts'), file('docs/readme.md'), file('src/new.ts', { status: 'renamed', previousPath: 'src/old.ts' })];
	const noHunks = new Map<string, IPlanHunk[]>();
	const aHunks = parseHunks(PATCH);

	test('splits the changes into the commits given, in order, and reports the files no commit took', () => {
		const plan = parseCommitPlan({
			commits: [
				{ message: 'feat: a and b', files: ['./src/a.ts', '/repo/src/b.ts'] },
				{ message: 'refactor: move old', files: ['src/old.ts'] },
			],
		}, ROOT, files, noHunks);
		assert.deepStrictEqual(plan, {
			commits: [
				{ message: 'feat: a and b', paths: ['src/a.ts', 'src/b.ts'], parts: {} },
				// A rename named by the path it left is the renamed file.
				{ message: 'refactor: move old', paths: ['src/new.ts'], parts: {} },
			],
			leftover: ['docs/readme.md'],
		});
	});

	test('says what to fix: unknown files, a file in two commits, missing message or files', () => {
		const unknown = parseCommitPlan({ commits: [{ message: 'x', files: ['src/zzz.ts'] }] }, ROOT, files, noHunks);
		assert.ok('error' in unknown && unknown.error.includes('src/zzz.ts') && unknown.error.includes('src/a.ts'), 'names the bad file and lists the changed ones');
		const twice = parseCommitPlan({ commits: [{ message: 'x', files: ['src/a.ts'] }, { message: 'y', files: ['src/a.ts'] }] }, ROOT, files, noHunks);
		assert.ok('error' in twice && twice.error.includes('commit 1 and commit 2'));
		const noMessage = parseCommitPlan({ commits: [{ message: ' ', files: ['src/a.ts'] }] }, ROOT, files, noHunks);
		assert.ok('error' in noMessage && noMessage.error.includes('no `message`'));
		const noFiles = parseCommitPlan({ commits: [{ message: 'x', files: [] }] }, ROOT, files, noHunks);
		assert.ok('error' in noFiles && noFiles.error.includes('no `files`'));
		const clean = parseCommitPlan({ commits: [{ message: 'x', files: ['a'] }] }, ROOT, [], noHunks);
		assert.ok('error' in clean && clean.error.includes('nothing to commit'));
	});

	test('parses hunk headers into hunks named by their new-side start', () => {
		assert.deepStrictEqual(aHunks.get('src/a.ts'), [
			{ start: 2, oldStart: 2, oldCount: 1, newLines: ['B'] },
			{ start: 9, oldStart: 8, oldCount: 0, newLines: ['new line'] },
		]);
	});

	test('splices chosen hunks into the base text', () => {
		const hunks = aHunks.get('src/a.ts')!;
		assert.strictEqual(spliceHunks(BASE, [hunks[0]]), 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj');
		assert.strictEqual(spliceHunks(BASE, [hunks[1]]), 'a\nb\nc\nd\ne\nf\ng\nh\nnew line\ni\nj');
		assert.strictEqual(spliceHunks(BASE, hunks), 'a\nB\nc\nd\ne\nf\ng\nh\nnew line\ni\nj');
		assert.strictEqual(spliceHunks(BASE, []), BASE);
	});

	test('splits one file across commits by hunk, and leaves hunks nobody took as leftovers', () => {
		const args = {
			commits: [
				{ message: 'feat: first hunk', hunks: [{ file: 'src/a.ts', lines: [2] }] },
				{ message: 'fix: rest', files: ['src/b.ts'], hunks: [{ file: 'src/a.ts', lines: [9] }] },
			],
		};
		assert.deepStrictEqual(parseCommitPlan(args, ROOT, files, aHunks), {
			commits: [
				{ message: 'feat: first hunk', paths: ['src/a.ts'], parts: { 'src/a.ts': [2] } },
				{ message: 'fix: rest', paths: ['src/b.ts', 'src/a.ts'], parts: { 'src/a.ts': [9] } },
			],
			leftover: ['docs/readme.md', 'src/new.ts'],
		});
		const partial = parseCommitPlan({ commits: [{ message: 'feat: first hunk', hunks: [{ file: 'src/a.ts', lines: [2] }] }] }, ROOT, files, aHunks);
		assert.ok('commits' in partial && partial.leftover.includes('src/a.ts'), 'the hunk not taken stays uncommitted');
	});

	test('rejects hunks that do not fit: unknown numbers, a hunk in two commits, a file both whole and split', () => {
		const badNumber = parseCommitPlan({ commits: [{ message: 'x', hunks: [{ file: 'src/a.ts', lines: [5] }] }] }, ROOT, files, aHunks);
		assert.ok('error' in badNumber && badNumber.error.includes('no hunk starting at line 5'));
		const twice = parseCommitPlan({ commits: [{ message: 'x', hunks: [{ file: 'src/a.ts', lines: [2] }] }, { message: 'y', hunks: [{ file: 'src/a.ts', lines: [2] }] }] }, ROOT, files, aHunks);
		assert.ok('error' in twice && twice.error.includes('a hunk can be in one commit only'));
		const whole = parseCommitPlan({ commits: [{ message: 'x', files: ['src/a.ts'] }, { message: 'y', hunks: [{ file: 'src/a.ts', lines: [9] }] }] }, ROOT, files, aHunks);
		assert.ok('error' in whole && whole.error.includes('as a whole file'));
		const renamed = parseCommitPlan({ commits: [{ message: 'x', hunks: [{ file: 'src/new.ts', lines: [2] }] }] }, ROOT, files, aHunks);
		assert.ok('error' in renamed && renamed.error.includes('is a rename'));
	});

	test('a file whose hunks are all taken is not a leftover', () => {
		const parsed = parseCommitPlan({ commits: [{ message: 'x', hunks: [{ file: 'src/a.ts', lines: [2, 9] }] }] }, ROOT, files, aHunks);
		assert.ok('commits' in parsed);
		assert.ok(!parsed.leftover.includes('src/a.ts'));
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
