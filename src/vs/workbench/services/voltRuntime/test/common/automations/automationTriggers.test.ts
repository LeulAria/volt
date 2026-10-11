/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { eventLabel, matchAutomationEvent, providerSignature, summarizeAutomationEvent, triggerGroupOf } from '../../../common/automations/automationTriggers.js';
import { webhookContext } from '../../../common/automations/automationWebhooks.js';

function context(payload: unknown, headers: Record<string, string> = {}) {
	return webhookContext({ body: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...headers }, id: 'dlv', receivedAt: 0, source: 'local' });
}

suite('Volt automation triggers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('GitLab: merge requests through the Git matcher, pipelines by status', () => {
		const opened = context({ object_attributes: { action: 'open', iid: 4, title: 'Fix CI' } }, { 'X-Gitlab-Event': 'Merge Request Hook' });
		assert.ok(matchAutomationEvent('gitlab', 'pr.opened', undefined, opened).match);
		assert.ok(!matchAutomationEvent('gitlab', 'pr.merged', undefined, opened).match);
		const failed = context({ object_attributes: { status: 'failed', ref: 'main' } }, { 'X-Gitlab-Event': 'Pipeline Hook' });
		assert.ok(matchAutomationEvent('gitlab', 'pipeline.failed', undefined, failed).match);
		assert.ok(matchAutomationEvent('gitlab', 'pipeline.any', undefined, failed).match);
		assert.ok(!matchAutomationEvent('gitlab', 'pipeline.success', undefined, failed).match);
		assert.ok(!matchAutomationEvent('gitlab', 'pipeline.any', undefined, context({ object_attributes: { status: 'running' } }, { 'X-Gitlab-Event': 'Pipeline Hook' })).match);
		assert.ok(!matchAutomationEvent('gitlab', 'pr.opened', undefined, context({ action: 'opened', pull_request: {} }, { 'X-GitHub-Event': 'pull_request' })).match);
		assert.strictEqual(triggerGroupOf('gitlab'), 'git');
		assert.strictEqual(eventLabel('gitlab', 'pr.merged'), 'Merge request merged');
		assert.strictEqual(providerSignature('gitlab'), undefined);
	});

	test('Jira: issue events by webhookEvent and changelog, narrowed by project', () => {
		const moved = context({ webhookEvent: 'jira:issue_updated', issue: { key: 'ENG-7', fields: { summary: 'Login fails', project: { key: 'ENG' } } }, changelog: { items: [{ field: 'status' }] } });
		assert.strictEqual(moved.event, 'jira:issue_updated');
		assert.ok(matchAutomationEvent('jira', 'issue.status_changed', undefined, moved).match);
		assert.ok(matchAutomationEvent('jira', 'issue.updated', 'eng', moved).match);
		assert.ok(!matchAutomationEvent('jira', 'issue.updated', 'OPS', moved).match);
		assert.ok(!matchAutomationEvent('jira', 'issue.assigned', undefined, moved).match);
		assert.ok(matchAutomationEvent('jira', 'sprint.started', undefined, context({ webhookEvent: 'sprint_started', sprint: { name: 'S1' } })).match);
		assert.ok(summarizeAutomationEvent('jira', moved).includes('Issue: ENG-7 Login fails'));
		assert.deepStrictEqual(providerSignature('jira'), { kind: 'generic', header: 'x-hub-signature', prefix: 'sha256=', encoding: 'hex' });
	});

	test('Atlassian: Bitbucket by X-Event-Key, Confluence pages by space', () => {
		const push = context({ push: { changes: [{ new: { name: 'main' } }] } }, { 'X-Event-Key': 'repo:push' });
		assert.strictEqual(push.event, 'repo:push');
		assert.ok(matchAutomationEvent('atlassian', 'bitbucket.push', 'main', push).match);
		assert.ok(!matchAutomationEvent('atlassian', 'bitbucket.push', 'dev', push).match);
		assert.ok(matchAutomationEvent('atlassian', 'bitbucket.pr.merged', undefined, context({}, { 'X-Event-Key': 'pullrequest:fulfilled' })).match);
		const page = context({ webhookEvent: 'page_created', page: { title: 'Runbook', spaceKey: 'DOCS' } });
		assert.ok(matchAutomationEvent('atlassian', 'page.created', 'docs', page).match);
		assert.ok(!matchAutomationEvent('atlassian', 'page.updated', undefined, page).match);
		assert.ok(!matchAutomationEvent('atlassian', 'page.comment', undefined, context({ webhookEvent: 'comment_created', issue: { key: 'ENG-1' } })).match);
	});
});
