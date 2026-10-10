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

	test('short messages including test and hello are real turns', () => {
		for (const text of ['testing', 'hello', 'thanks', 'ok', '23432+242']) {
			const intent = classifyIntent(text, 'agent', { hasWorkspace: true, priorLane: 'agent' });
			assert.ok(!intent.signals.includes('ping'), text);
			assert.ok(intent.budget.maxModelCalls > 0, text);
			assert.ok(intent.groups.includes('read') || intent.groups.includes('edit'), text);
		}
		assert.strictEqual(classifyIntent('testing', 'agent', { hasWorkspace: true }).lane, 'chat');
		assert.notStrictEqual(classifyIntent('test', 'agent', { hasWorkspace: true }).lane, 'chat');
	});

	test('smashed questions are not check-ins', () => {
		const intent = classifyIntent('whatistheproject', 'agent', { hasWorkspace: true });
		assert.strictEqual(intent.lane, 'chat');
		assert.ok(!intent.signals.includes('ping'));
		assert.strictEqual(intent.referencesWorkspace, true);
		assert.ok(intent.groups.includes('read'));
		assert.ok(intent.groups.includes('search'));
		assert.ok(!intent.groups.includes('edit'));
	});

	test('run the tests stays in a coding lane', () => {
		assert.notStrictEqual(classifyIntent('run the tests', 'agent', { hasWorkspace: true }).lane, 'chat');
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

	test('checking a result or running tests is not a preview', () => {
		assert.strictEqual(classifyIntent('Then check it with a Monte Carlo simulation you write and run in this repo as scripts/sim.js', 'agent').wantsPreview, false);
		assert.strictEqual(classifyIntent('run the tests in this repo and fix what fails', 'agent').wantsPreview, false);
		assert.strictEqual(classifyIntent('start the dev server and open it', 'agent').wantsPreview, true);
		assert.strictEqual(classifyIntent('Start the server and check the page in a browser before you finish.', 'agent').wantsPreview, true);
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

	test('a small edit with requested verification retains the tools to perform it', () => {
		for (const text of [
			'Fix the typo on the submit button and check it in the browser.',
			'Rename cnt in server/routes/stats.js and run the tests.',
			'Change the button label and test the page in the browser.',
		]) {
			const intent = classifyIntent(text, 'agent');
			assert.strictEqual(intent.lane, 'agent', text);
			assert.ok(intent.groups.includes('shell'), text);
			assert.ok(intent.groups.includes('browser'), text);
		}
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

	test('building from a design image is recognised; describing an image is not', () => {
		assert.strictEqual(classifyIntent('Build design/pricing.png as a static page: index.html with plain HTML and CSS.', 'agent').matchesDesign, true);
		assert.strictEqual(classifyIntent('implement this screen', 'agent', { attachments: ['Screenshot 2026-10-01.png'] }).matchesDesign, true);
		assert.strictEqual(classifyIntent('what is in logo.png?', 'agent').matchesDesign, undefined);
		assert.strictEqual(classifyIntent('compress the images in assets/ so hero.png is under 200 KB', 'agent').matchesDesign, undefined);
		assert.strictEqual(classifyIntent('Build design/pricing.png as a page', 'ask').matchesDesign, undefined);
	});

	test('design alternatives and the app\'s screens are recognised, and are work rather than a question', () => {
		const mockups = classifyIntent('give me 5 sidebar alternative for our website', 'agent');
		assert.strictEqual(mockups.wantsMockups, true);
		assert.strictEqual(mockups.lane, 'agent');
		assert.ok(mockups.signals.includes('gallery'));
		assert.strictEqual(classifyIntent('mock up three empty states for the inbox', 'agent').wantsMockups, true);
		assert.strictEqual(classifyIntent('show me 3 layout options for the pricing page', 'agent').wantsMockups, true);
		assert.strictEqual(classifyIntent('what is a good alternative to lodash?', 'agent').wantsMockups, undefined);
		assert.strictEqual(classifyIntent('options for caching the API', 'agent').wantsMockups, undefined);
		const screens = classifyIntent('inspect the current mobile screens, give me all in dark and light theme', 'agent');
		assert.strictEqual(screens.wantsScreens, true);
		assert.strictEqual(screens.lane, 'agent');
		assert.strictEqual(classifyIntent('screenshots of every page of the site', 'agent').wantsScreens, true);
		assert.strictEqual(classifyIntent('fix the login page in dark mode', 'agent').wantsScreens, undefined);
		// Ask mode answers; it does not start work.
		assert.strictEqual(classifyIntent('give me 5 sidebar alternatives', 'ask').lane, 'chat');
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
