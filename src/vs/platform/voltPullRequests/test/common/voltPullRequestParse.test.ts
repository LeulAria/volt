/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	classifyGhError,
	ghErrorText,
	latestChecks,
	parseCheckRun,
	parsePullRequest,
	parsePullRequestDetail,
	parsePullRequestUrl,
	parseRemoteUrl,
	prKey,
	summarizeChecks,
} from '../../common/voltPullRequestParse.js';
import { IVoltPrCheck, VoltPrError, voltPrErrorCode, voltPrErrorMessage } from '../../common/voltPullRequests.js';

const REPO = { host: 'github.com', owner: 'LeulAria', name: 'Agent-Git-Test' };

/** A pull request node as GitHub's GraphQL returns it for the summary fragment. */
export function rawPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'PR_kw1',
		number: 7,
		title: 'Add search',
		url: 'https://github.com/LeulAria/Agent-Git-Test/pull/7',
		state: 'OPEN',
		isDraft: false,
		createdAt: '2026-10-01T10:00:00Z',
		updatedAt: '2026-10-02T10:00:00Z',
		mergedAt: null,
		closedAt: null,
		author: { login: 'LeulAria', avatarUrl: 'https://a/1', __typename: 'User' },
		headRefName: 'feature/search',
		headRefOid: 'abc1234def',
		baseRefName: 'main',
		isCrossRepository: false,
		headRepositoryOwner: { login: 'LeulAria' },
		additions: 10,
		deletions: 2,
		changedFiles: 3,
		mergeable: 'MERGEABLE',
		mergeStateStatus: 'CLEAN',
		reviewDecision: 'REVIEW_REQUIRED',
		autoMergeRequest: null,
		labels: { nodes: [{ name: 'feature', color: '00ff00' }] },
		assignees: { nodes: [{ login: 'octocat' }] },
		reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'reviewer' } }, { requestedReviewer: { __typename: 'Team', combinedSlug: 'org/core' } }, { requestedReviewer: null }] },
		latestReviews: { nodes: [{ author: { login: 'reviewer' }, state: 'COMMENTED', submittedAt: '2026-10-02T09:00:00Z' }] },
		comments: { totalCount: 2 },
		reviewThreads: { nodes: [{ isResolved: false, comments: { totalCount: 3 } }, { isResolved: true, comments: { totalCount: 1 } }] },
		commits: {
			nodes: [{
				commit: {
					oid: 'abc1234def', statusCheckRollup: {
						state: 'FAILURE', contexts: {
							nodes: [
								{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/1', startedAt: '2026-10-02T08:00:00Z', completedAt: '2026-10-02T08:05:00Z', title: 'Tests failed', checkSuite: { workflowRun: { workflow: { name: 'CI' } } } },
								{ __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: null, checkSuite: { workflowRun: { workflow: { name: 'CI' } } } },
								{ __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS', targetUrl: 'https://vercel/1', description: 'Deployed', createdAt: '2026-10-02T08:00:00Z' },
								{ __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
							],
						},
					},
				},
			}],
		},
		...overrides,
	};
}

suite('Volt pull requests: parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('remote URLs from every common form', () => {
		assert.deepStrictEqual(parseRemoteUrl('git@github.com:LeulAria/Agent-Git-Test.git'), { host: 'github.com', owner: 'LeulAria', name: 'Agent-Git-Test', provider: 'github' });
		assert.deepStrictEqual(parseRemoteUrl('https://github.com/LeulAria/Agent-Git-Test'), { host: 'github.com', owner: 'LeulAria', name: 'Agent-Git-Test', provider: 'github' });
		assert.deepStrictEqual(parseRemoteUrl('https://token@github.com/LeulAria/Agent-Git-Test.git/'), { host: 'github.com', owner: 'LeulAria', name: 'Agent-Git-Test', provider: 'github' });
		assert.deepStrictEqual(parseRemoteUrl('ssh://git@ssh.github.com:443/o/n.git'), { host: 'ssh.github.com', owner: 'o', name: 'n', provider: 'github' });
		assert.strictEqual(parseRemoteUrl('git@ghe.corp.io:team/app.git', new Set(['ghe.corp.io']))?.provider, 'github', 'a host the CLI is signed in to is GitHub');
		assert.strictEqual(parseRemoteUrl('git@ghe.corp.io:team/app.git')?.provider, 'unknown');
		assert.deepStrictEqual(parseRemoteUrl('https://gitlab.com/group/sub/proj.git'), { host: 'gitlab.com', owner: 'group/sub', name: 'proj', provider: 'gitlab' });
		assert.strictEqual(parseRemoteUrl('git@bitbucket.org:team/repo.git')?.provider, 'bitbucket');
		assert.strictEqual(parseRemoteUrl('https://codeberg.org/a/b')?.provider, 'gitea');
		assert.deepStrictEqual(parseRemoteUrl('https://org@dev.azure.com/org/Project/_git/repo'), { host: 'dev.azure.com', owner: 'org/Project', name: 'repo', provider: 'azure' });
		assert.deepStrictEqual(parseRemoteUrl('git@ssh.dev.azure.com:v3/org/Project/repo'), { host: 'dev.azure.com', owner: 'org/Project', name: 'repo', provider: 'azure' });
		assert.strictEqual(parseRemoteUrl(''), undefined);
		assert.strictEqual(parseRemoteUrl('/local/path/repo'), undefined);
		assert.strictEqual(parseRemoteUrl('file:///tmp/repo.git'), undefined);
		assert.strictEqual(parseRemoteUrl('https://github.com/only-owner'), undefined);
	});

	test('pull request URLs and keys', () => {
		assert.deepStrictEqual(parsePullRequestUrl('https://github.com/LeulAria/Agent-Git-Test/pull/12'), { repo: { host: 'github.com', owner: 'LeulAria', name: 'Agent-Git-Test' }, number: 12 });
		assert.deepStrictEqual(parsePullRequestUrl('https://GHE.corp.io/a/b/pull/3/files#diff'), { repo: { host: 'ghe.corp.io', owner: 'a', name: 'b' }, number: 3 });
		assert.strictEqual(parsePullRequestUrl('https://github.com/a/b/issues/3'), undefined);
		assert.strictEqual(parsePullRequestUrl('https://github.com/a/b/pull/0'), undefined);
		assert.strictEqual(parsePullRequestUrl('not a url'), undefined);
		assert.strictEqual(prKey(REPO, 7), 'github.com/leularia/agent-git-test#7', 'keys ignore case so links never double up');
	});

	test('checks: every state maps, re-runs keep the newest, the rollup counts', () => {
		assert.strictEqual(parseCheckRun({ __typename: 'CheckRun', name: 'a', status: 'QUEUED' })?.state, 'pending');
		for (const [conclusion, state] of [['SUCCESS', 'success'], ['FAILURE', 'failure'], ['TIMED_OUT', 'failure'], ['STARTUP_FAILURE', 'failure'], ['ACTION_REQUIRED', 'failure'], ['CANCELLED', 'cancelled'], ['SKIPPED', 'skipped'], ['NEUTRAL', 'neutral'], ['STALE', 'neutral']]) {
			assert.strictEqual(parseCheckRun({ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion })?.state, state, conclusion);
		}
		for (const [raw, state] of [['SUCCESS', 'success'], ['FAILURE', 'failure'], ['ERROR', 'failure'], ['PENDING', 'pending'], ['EXPECTED', 'pending']]) {
			assert.strictEqual(parseCheckRun({ __typename: 'StatusContext', context: 'ci', state: raw })?.state, state, raw);
		}
		assert.strictEqual(parseCheckRun({ __typename: 'Unknown' }), undefined);
		assert.strictEqual(parseCheckRun(null), undefined);

		const runs: IVoltPrCheck[] = [
			{ name: 'test', workflow: 'CI', state: 'failure', startedAt: 1 },
			{ name: 'test', workflow: 'CI', state: 'success', startedAt: 2 },
			{ name: 'test', workflow: 'Nightly', state: 'failure', startedAt: 1 },
		];
		assert.deepStrictEqual(latestChecks(runs).map(check => `${check.workflow}:${check.state}`).sort(), ['CI:success', 'Nightly:failure']);

		assert.deepStrictEqual(summarizeChecks([]), { state: 'none', total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, failing: [] });
		assert.strictEqual(summarizeChecks([{ name: 'a', state: 'skipped' }]).state, 'success', 'only skipped checks do not block');
		assert.strictEqual(summarizeChecks([{ name: 'a', state: 'success' }, { name: 'b', state: 'pending' }]).state, 'pending');
		const failing = summarizeChecks([{ name: 'a', state: 'failure' }, { name: 'b', state: 'pending' }, { name: 'c', state: 'success' }]);
		assert.deepStrictEqual([failing.state, failing.failed, failing.pending, failing.passed, failing.failing], ['failure', 1, 1, 1, ['a']]);
	});

	test('a pull request summary reads every field, and missing ones fall back', () => {
		const pr = parsePullRequest(rawPullRequest(), REPO, 'LeulAria');
		assert.strictEqual(pr.key, 'github.com/leularia/agent-git-test#7');
		assert.strictEqual(pr.state, 'open');
		assert.strictEqual(pr.mergeable, 'mergeable');
		assert.strictEqual(pr.mergeState, 'clean');
		assert.strictEqual(pr.reviewDecision, 'reviewRequired');
		assert.deepStrictEqual(pr.reviewRequests, ['reviewer', 'org/core']);
		assert.deepStrictEqual(pr.assignees, ['octocat']);
		assert.deepStrictEqual(pr.labels, [{ name: 'feature', color: '00ff00' }]);
		assert.strictEqual(pr.unresolvedThreads, 1);
		assert.strictEqual(pr.comments, 6, 'conversation comments plus review comments');
		assert.deepStrictEqual([pr.checks.state, pr.checks.total, pr.checks.failed, pr.checks.pending, pr.checks.passed, pr.checks.skipped], ['failure', 4, 1, 1, 1, 1]);
		assert.strictEqual(pr.createdAt, Date.parse('2026-10-01T10:00:00Z'));
		assert.strictEqual(pr.mergedAt, undefined);
		assert.strictEqual(pr.viewer, 'LeulAria');

		assert.strictEqual(parsePullRequest(rawPullRequest({ isDraft: true }), REPO, 'x').state, 'draft');
		assert.strictEqual(parsePullRequest(rawPullRequest({ state: 'MERGED', mergedAt: '2026-10-03T00:00:00Z' }), REPO, 'x').state, 'merged');
		assert.strictEqual(parsePullRequest(rawPullRequest({ state: 'CLOSED', isDraft: true }), REPO, 'x').state, 'closed');

		const sparse = parsePullRequest({ number: 3 }, REPO, 'x');
		assert.strictEqual(sparse.author.login, 'ghost', 'a deleted author reads as ghost');
		assert.strictEqual(sparse.checks.state, 'none');
		assert.strictEqual(sparse.mergeable, 'unknown');
		assert.deepStrictEqual(sparse.labels, []);
		assert.strictEqual(sparse.state, 'open');
		assert.strictEqual(parsePullRequest(rawPullRequest({ author: { login: 'dependabot[bot]' } }), REPO, 'x').author.bot, true);
	});

	test('a detail read keeps threads, reviews, files and merge options, and hides others\' pending reviews', () => {
		const raw = rawPullRequest({
			body: 'Body',
			baseRefOid: 'base0',
			viewerCanUpdate: true,
			reviewThreadsFull: { nodes: [{ id: 'T1', path: 'a.ts', line: null, originalLine: 4, startLine: 2, diffSide: 'LEFT', isResolved: false, isOutdated: true, viewerCanResolve: true, comments: { nodes: [{ id: 'C1', author: { login: 'r' }, body: 'nit', createdAt: '2026-10-02T00:00:00Z', url: 'u', diffHunk: '@@' }] } }] },
			reviewList: { nodes: [{ id: 'R1', author: { login: 'r' }, state: 'APPROVED', body: '', submittedAt: '2026-10-02T00:00:00Z', url: 'u' }, { id: 'R2', author: { login: 'other' }, state: 'PENDING', body: 'draft', url: 'u' }, { id: 'R3', author: { login: 'me' }, state: 'PENDING', body: 'mine', url: 'u' }] },
			conversation: { nodes: [{ id: 'I1', author: null, body: 'hi', createdAt: '2026-10-02T00:00:00Z', url: 'u' }] },
			commitList: { nodes: [{ commit: { oid: 'c1', messageHeadline: 'one', committedDate: '2026-10-01T00:00:00Z', author: { name: 'N', user: { login: 'n' } }, statusCheckRollup: { state: 'SUCCESS' } } }] },
		});
		const detail = parsePullRequestDetail(raw, { viewerPermission: 'WRITE', mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, deleteBranchOnMerge: true, autoMergeAllowed: true, labels: { nodes: [{ name: 'bug', color: 'ff0000' }] } }, REPO, 'me', {
			files: [{ path: 'a.ts', change: 'modified', additions: 1, deletions: 0, viewed: 'viewed' }],
			checks: [{ name: 'test', state: 'success', required: true }],
		});
		assert.deepStrictEqual(detail.threads[0], {
			id: 'T1', path: 'a.ts', line: 4, startLine: 2, side: 'LEFT', resolved: false, outdated: true, canResolve: true,
			comments: [{ id: 'C1', author: { login: 'r' }, body: 'nit', createdAt: Date.parse('2026-10-02T00:00:00Z'), url: 'u', diffHunk: '@@' }],
		});
		assert.deepStrictEqual(detail.reviewList.map(review => review.id), ['R1', 'R3']);
		assert.strictEqual(detail.conversation[0].author.login, 'ghost');
		assert.deepStrictEqual(detail.commits[0], { oid: 'c1', headline: 'one', author: 'n', at: Date.parse('2026-10-01T00:00:00Z'), checks: 'success' });
		assert.deepStrictEqual(detail.mergeOptions, { merge: false, squash: true, rebase: true, deleteBranchOnMerge: true, autoMergeAllowed: true });
		assert.strictEqual(detail.viewerCanMerge, true);
		assert.strictEqual(detail.checks.state, 'success', 'the detail\'s own checks replace the summary rollup');
		assert.deepStrictEqual(detail.repoLabels, [{ name: 'bug', color: 'ff0000' }]);
		assert.strictEqual(parsePullRequestDetail(raw, { viewerPermission: 'READ' }, REPO, 'me', { files: [] }).viewerCanMerge, false);
	});

	test('gh failures sort into codes, and the code survives IPC in the message', () => {
		assert.strictEqual(classifyGhError('', null, 'spawn gh ENOENT'), 'noCli');
		assert.strictEqual(classifyGhError('To get started with GitHub CLI, please run:  gh auth login', 4), 'noAuth');
		assert.strictEqual(classifyGhError('HTTP 401: Bad credentials (https://api.github.com/graphql)', 1), 'noAuth');
		assert.strictEqual(classifyGhError('API rate limit exceeded for user', 1), 'rateLimited');
		assert.strictEqual(classifyGhError('Head branch was modified. Review and try the merge again.', 1), 'stale');
		assert.strictEqual(classifyGhError('Pull Request is not mergeable', 1), 'conflict');
		assert.strictEqual(classifyGhError('GraphQL: Could not resolve to a Repository with the name \'a/b\'.', 1), 'notFound');
		assert.strictEqual(classifyGhError('dial tcp: lookup api.github.com: no such host', 1), 'network');
		assert.strictEqual(classifyGhError('something odd', 1), 'failed');
		assert.strictEqual(ghErrorText('gh: Not Found (HTTP 404)\nUsage: gh api <endpoint>\n'), 'Not Found (HTTP 404)');
		assert.strictEqual(ghErrorText(''), 'The GitHub CLI failed.');

		const err = new VoltPrError('stale', 'Someone pushed since you looked.');
		const overIpc = Object.assign(new Error(err.message), { name: err.name });
		assert.strictEqual(voltPrErrorCode(overIpc), 'stale');
		assert.strictEqual(voltPrErrorMessage(overIpc), 'Someone pushed since you looked.');
		assert.strictEqual(voltPrErrorCode(new Error('[stale] plain')), undefined, 'only Volt pull request errors carry a code');
	});
});
