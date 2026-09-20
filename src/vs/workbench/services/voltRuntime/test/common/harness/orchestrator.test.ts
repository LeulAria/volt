/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { orchestrate, workerFraming } from '../../../common/harness/orchestrator.js';
import { buildPlan } from '../../../common/harness/plan.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';

suite('Volt orchestrator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('chat and fast stay on a single worker', () => {
		const chat = prepare('what does this function do', 'chat');
		assert.strictEqual(orchestrate(chat.intel, 'chat', undefined).mode, 'single');

		const fast = prepare('fix the typo in README.md', 'fast');
		assert.strictEqual(orchestrate(fast.intel, 'fast', fast.plan).mode, 'single');
	});

	test('a large multi-deliverable mission uses specialists', () => {
		const text = 'add login and add signup and add billing and make sure the tests pass';
		const { intel, plan } = prepare(text, 'mission');
		const orch = orchestrate(intel, 'mission', plan);
		assert.ok(orch.mode === 'subagents' || orch.mode === 'swarm', orch.reason);
		assert.ok(orch.workers.length >= 2);
		assert.ok(orch.concurrency >= 1);
	});

	test('a coding lookup still uses one worker that can edit', () => {
		const { intel, plan } = prepare('implement login using the official docs', 'agent');
		const orch = orchestrate(intel, 'agent', plan);
		assert.strictEqual(orch.mode, 'single');
		assert.strictEqual(orch.workers[0]?.role, 'general');
	});

	test('specialists get a tighter framing than the general agent', () => {
		assert.ok(/Do not edit/.test(workerFraming('explore')));
		assert.ok(/Touch only/.test(workerFraming('implement')));
		assert.ok(/Do not "fix"/.test(workerFraming('verify')));
	});
});

function prepare(text: string, lane: 'chat' | 'fast' | 'agent' | 'mission') {
	const mode = lane === 'mission' ? 'multitask' : lane === 'chat' ? 'ask' : 'agent';
	const intent = classifyIntent(text, mode, { hasWorkspace: true });
	const intel = analyzeTask(text, intent);
	return { intel, plan: buildPlan(intel, lane) };
}
