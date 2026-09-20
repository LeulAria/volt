/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildAcpLead, buildSystemPrompt } from '../../../common/harness/contextPack.js';
import { classifyIntent } from '../../../common/harness/intent.js';

suite('Volt context pack', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a price question never injects a start-server hint', () => {
		const intent = classifyIntent('how much does this cost right now', 'agent');
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			runPlan: { kind: 'static', start: 'python3 -m http.server 8080 --bind 127.0.0.1', previewUrl: 'http://127.0.0.1:8080/' },
		});
		assert.ok(!/http\.server/.test(prompt));
		assert.ok(!/Start servers/.test(prompt));
		assert.ok(/web_search|Look up current facts/.test(prompt));
		assert.ok(/Do not modify the workspace/.test(prompt));
		assert.ok(!/one or two lines/.test(prompt));
		const lead = buildAcpLead({ mode: 'agent', intent, runPlan: { kind: 'static', start: 'python3 -m http.server 8080' } });
		assert.ok(lead);
		assert.ok(!/http\.server/.test(lead));
		assert.ok(/question/i.test(lead));
	});

	test('an enumerated table asks for research, not a one-liner', () => {
		const intent = classifyIntent('tell me each model and their price give me in a table', 'ask');
		const prompt = buildSystemPrompt({
			mode: 'ask',
			intent,
			shape: { form: 'table', enumerate: true, lookup: true, cite: false, depth: 'full' },
		});
		assert.ok(/research question|web_search/.test(prompt));
		assert.ok(/full table or list|Fetch the pages/.test(prompt));
		assert.ok(!/one or two lines|sentence or a small table/.test(prompt));
	});

	test('run the app injects the detected start command', () => {
		const intent = classifyIntent('run the app', 'agent');
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			runPlan: { kind: 'static', start: 'python3 -m http.server 8080 --bind 127.0.0.1', previewUrl: 'http://127.0.0.1:8080/' },
		});
		assert.ok(/http\.server/.test(prompt));
		assert.ok(/in-app browser/.test(prompt));
		const lead = buildAcpLead({
			mode: 'agent',
			intent,
			runPlan: { kind: 'static', start: 'python3 -m http.server 8080 --bind 127.0.0.1' },
		});
		assert.ok(lead?.includes('http.server'));
	});

	test('a coding lookup keeps write permission and still asks for sources', () => {
		const intent = classifyIntent('implement login using the official docs', 'agent', { hasWorkspace: true });
		const prompt = buildSystemPrompt({ mode: 'agent', intent });
		assert.ok(/You may edit files/.test(prompt));
		assert.ok(/official|look (them )?up|Search more than once/i.test(prompt));
		assert.ok(!/Do not modify the workspace/.test(prompt));
		const lead = buildAcpLead({ mode: 'agent', intent });
		assert.ok(lead);
		assert.ok(!/Do not modify the workspace/.test(lead));
	});

	test('ordinary coding requests send no ACP lead and no preview hint', () => {
		const intent = classifyIntent('add pagination to the users table and make sure the tests pass', 'agent');
		assert.strictEqual(buildAcpLead({ mode: 'agent', intent, runPlan: { kind: 'static', start: 'python3 -m http.server 8080' } }), undefined);
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			runPlan: { kind: 'static', start: 'python3 -m http.server 8080' },
		});
		assert.ok(!/http\.server/.test(prompt));
	});

	test('plan mode is read-only even in the agent lane', () => {
		const intent = classifyIntent('add pagination to the users table', 'plan');
		const prompt = buildSystemPrompt({ mode: 'plan', intent });
		assert.ok(/Read-only/.test(prompt));
		assert.ok(/Do not run commands/.test(prompt));
		const lead = buildAcpLead({ mode: 'plan', intent });
		assert.ok(lead?.includes('[Volt mode: plan]'));
	});

	test('task brief, memory, and evidence land in the prompt', () => {
		const intent = classifyIntent('add a logout button to the header', 'agent');
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			taskBrief: 'Constraints the user set:\n- do not add dependencies',
			memory: 'Remembered:\n- (project) package manager: pnpm',
			evidence: 'Changed: src/Header.tsx',
			workerFraming: 'Make the change this step names.',
		});
		assert.ok(/do not add dependencies/.test(prompt));
		assert.ok(/package manager: pnpm/.test(prompt));
		assert.ok(/Changed: src\/Header\.tsx/.test(prompt));
		assert.ok(/Make the change this step names/.test(prompt));
	});

	test('project instructions land in a tagged section', () => {
		const intent = classifyIntent('fix the typo in README.md', 'agent');
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			projectInstructions: 'Always use pnpm.',
			toolSnippets: ['read_file - read a file with offset/limit'],
		});
		assert.ok(/<project_instructions>/.test(prompt));
		assert.ok(/Always use pnpm/.test(prompt));
		assert.ok(/read_file/.test(prompt));
		assert.ok(/small, well-scoped/.test(prompt));
	});

	test('a check-in gets a one-line prompt and no tools', () => {
		const intent = classifyIntent('testing', 'agent', { hasWorkspace: true });
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			projectInstructions: 'Always use pnpm.',
			toolSnippets: ['read_file - read a file'],
		});
		assert.ok(/check-in|Reply immediately/.test(prompt));
		assert.ok(!/read_file/.test(prompt));
		assert.ok(!/Always use pnpm/.test(prompt));
		const lead = buildAcpLead({ mode: 'agent', intent });
		assert.ok(lead && /Reply immediately/.test(lead));
	});

	test('remaining budget is a volatile section', () => {
		const intent = classifyIntent('add a logout button to the header', 'agent');
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			remaining: { steps: 12, tools: 40, timeMs: 120_000 },
		});
		assert.ok(/Remaining budget: 12 model steps, 40 tool calls, 120s/.test(prompt));
	});
});
