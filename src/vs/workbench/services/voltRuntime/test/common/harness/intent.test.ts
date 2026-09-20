/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent, mergeGrantedGroups } from '../../../common/harness/intent.js';

suite('Volt intent router', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a price question is chat: no preview, no edit, no shell, wants web', () => {
		const intent = classifyIntent('how much is nissan kiks in UAE', 'agent');
		assert.strictEqual(intent.lane, 'chat');
		assert.strictEqual(intent.wantsPreview, false);
		assert.strictEqual(intent.wantsWeb, true);
		assert.ok(!intent.groups.includes('shell'));
		assert.ok(!intent.groups.includes('edit'));
		assert.ok(intent.groups.includes('web'));
	});

	test('an enumerated table in ask mode stays chat and still gets web tools', () => {
		const intent = classifyIntent('tell me each model and their price give me in a table', 'ask');
		assert.strictEqual(intent.lane, 'chat');
		assert.strictEqual(intent.wantsWeb, true);
		assert.ok(intent.signals.includes('table'));
		assert.ok(intent.signals.includes('enumerate'));
		assert.ok(intent.groups.includes('web'));
		assert.ok(!intent.groups.includes('edit'));
	});

	test('plain statements without coding signals are chat', () => {
		assert.strictEqual(classifyIntent('thanks!', 'agent').lane, 'chat');
		assert.strictEqual(classifyIntent('nissan kicks 2026 price dubai', 'agent').lane, 'chat');
		assert.strictEqual(classifyIntent('what is 2+2', 'agent').lane, 'chat');
	});

	test('questions about the workspace stay chat but may read', () => {
		const intent = classifyIntent('explain how auth works in this repo', 'agent');
		assert.strictEqual(intent.lane, 'chat');
		assert.strictEqual(intent.referencesWorkspace, true);
		assert.ok(intent.groups.includes('read'));
		assert.ok(intent.groups.includes('search'));
		assert.ok(!intent.groups.includes('edit'));
	});

	test('how-to questions are chat even with a coding verb', () => {
		assert.strictEqual(classifyIntent('how do I add a route in this app', 'agent').lane, 'chat');
	});

	test('run the app wants a preview and is agent', () => {
		const intent = classifyIntent('run the app', 'agent');
		assert.strictEqual(intent.lane, 'agent');
		assert.strictEqual(intent.wantsPreview, true);
		assert.ok(intent.groups.includes('shell'));
	});

	test('show me in the browser wants a preview', () => {
		assert.strictEqual(classifyIntent('build the landing page and show me in the browser', 'agent').wantsPreview, true);
	});

	test('small named edits are fast', () => {
		assert.strictEqual(classifyIntent('rename getCwd to getCurrentWorkingDirectory in src/utils/path.ts', 'agent').lane, 'fast');
		assert.strictEqual(classifyIntent('fix the typo in README.md', 'agent').lane, 'fast');
		assert.strictEqual(classifyIntent('bump the version in package.json', 'agent').lane, 'fast');
	});

	test('fast lane has edit but no shell', () => {
		const intent = classifyIntent('fix the typo in README.md', 'agent');
		assert.ok(intent.groups.includes('edit'));
		assert.ok(!intent.groups.includes('shell'));
	});

	test('implementing from official docs stays in a coding lane and still gets web', () => {
		const intent = classifyIntent('implement login using the official docs', 'agent', { hasWorkspace: true });
		assert.strictEqual(intent.lane, 'agent');
		assert.strictEqual(intent.shape.lookup, true);
		assert.strictEqual(intent.shape.cite, true);
		assert.strictEqual(intent.wantsWeb, true);
		assert.ok(intent.groups.includes('web'));
		assert.ok(intent.groups.includes('edit'));
		assert.ok(intent.budget.maxToolCalls >= 24);
	});

	test('a fast edit that depends on current facts still gets web', () => {
		const intent = classifyIntent('fix the typo in README.md using the official docs', 'agent', { hasWorkspace: true });
		assert.strictEqual(intent.lane, 'fast');
		assert.strictEqual(intent.shape.lookup, true);
		assert.ok(intent.groups.includes('web'));
		assert.ok(intent.groups.includes('edit'));
	});

	test('ordinary coding requests are agent', () => {
		assert.strictEqual(classifyIntent('add pagination to the users table and make sure the tests pass', 'agent').lane, 'agent');
		assert.strictEqual(classifyIntent('why does the build fail?', 'agent').lane, 'agent');
	});

	test('multi-deliverable specs are mission', () => {
		const text = 'Build the entire payment reconciliation system, integrate Stripe, write tests, migrate the database and make sure production deployment works.';
		const intent = classifyIntent(text, 'agent');
		assert.strictEqual(intent.lane, 'mission');
		assert.ok(intent.groups.includes('agents'));
	});

	test('bulleted specs are mission', () => {
		const text = [
			'Implement the dashboard:',
			'- add the API routes for metrics',
			'- create the chart components',
			'- wire the websocket updates',
			'- write integration tests for all of it',
		].join('\n');
		assert.strictEqual(classifyIntent(text, 'agent').lane, 'mission');
	});

	test('slash commands override', () => {
		assert.strictEqual(classifyIntent('/mission ship the thing', 'agent').lane, 'mission');
		assert.strictEqual(classifyIntent('/fast add a comment here', 'agent').lane, 'fast');
		assert.strictEqual(classifyIntent('/ask what does this do', 'agent').lane, 'chat');
	});

	test('modes constrain lanes and groups', () => {
		assert.strictEqual(classifyIntent('add pagination to the users table', 'ask').lane, 'chat');
		assert.strictEqual(classifyIntent('do it all', 'multitask').lane, 'mission');
		const plan = classifyIntent('add pagination to the users table', 'plan');
		assert.strictEqual(plan.lane, 'agent');
		assert.ok(!plan.groups.includes('edit'));
		assert.ok(!plan.groups.includes('shell'));
	});

	test('without a workspace everything is chat', () => {
		assert.strictEqual(classifyIntent('add pagination to the users table', 'agent', { hasWorkspace: false }).lane, 'chat');
	});

	test('follow-up questions in a coding conversation stick to the coding lane', () => {
		assert.strictEqual(classifyIntent('does it compile in this project?', 'agent', { priorLane: 'agent' }).lane, 'agent');
		assert.strictEqual(classifyIntent('how much is nissan kiks in UAE', 'agent', { priorLane: 'agent' }).lane, 'chat');
	});

	test('signals are recorded', () => {
		const intent = classifyIntent('how much is nissan kiks in UAE', 'agent');
		assert.ok(intent.signals.includes('question'));
		assert.ok(intent.signals.includes('web'));
		assert.ok(intent.signals.includes('plain-question'));
	});

	test('request_capabilities cannot grant writes in ask mode', () => {
		assert.deepStrictEqual(
			mergeGrantedGroups(['read', 'search', 'web', 'meta'], ['edit', 'shell'], 'ask'),
			['read', 'search', 'web', 'meta'],
		);
	});
});
