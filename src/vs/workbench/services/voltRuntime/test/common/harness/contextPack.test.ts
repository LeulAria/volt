/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildAcpLead, buildSystemPrompt, CALLER_VISIBLE_CHANGES, DESIGN_LOOP, TEST_INTEGRITY, VISUAL_REPLIES, WORKSPACE_SCOPE } from '../../../common/harness/contextPack.js';
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

	test('multitask names the models a subagent can run on, across harnesses', () => {
		const intent = classifyIntent('create src/array.js on Grok and src/date.js on GPT-6-Astra in parallel', 'multitask');
		const lead = buildAcpLead({ mode: 'multitask', intent, taskModels: ['Haiku 4.5', 'Grok 4.7 High Fast', 'GPT-6-Astra'] });
		assert.ok(lead?.includes('Haiku 4.5, Grok 4.7 High Fast, GPT-6-Astra'));
		assert.ok(/never a shell command/.test(lead!));
		assert.ok(!buildAcpLead({ mode: 'agent', intent, taskModels: ['Haiku 4.5'] })?.includes('Haiku 4.5'), 'only multitask lists them');
	});

	test('ordinary coding requests send only the workspace scope line, no preview hint', () => {
		const intent = classifyIntent('add pagination to the users table and make sure the tests pass', 'agent');
		assert.strictEqual(buildAcpLead({ mode: 'agent', intent, runPlan: { kind: 'static', start: 'python3 -m http.server 8080' } }), `[Volt] ${TEST_INTEGRITY}\n[Volt] ${WORKSPACE_SCOPE}`);
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			runPlan: { kind: 'static', start: 'python3 -m http.server 8080' },
		});
		assert.ok(!/http\.server/.test(prompt));
	});

	test('building from a design image adds the render-and-compare loop, except in read-only modes', () => {
		const prompt = 'Build design/pricing.png as a static page: index.html with plain HTML and CSS. It should match the image closely.';
		assert.strictEqual(buildAcpLead({ mode: 'agent', intent: classifyIntent(prompt, 'agent') }), `[Volt] ${DESIGN_LOOP}\n[Volt] ${WORKSPACE_SCOPE}`);
		assert.ok(!buildAcpLead({ mode: 'plan', intent: classifyIntent(prompt, 'plan') })?.includes(DESIGN_LOOP));
	});

	test('an open-ended change asks for caller-visible changes to be named; a specific one does not', () => {
		assert.ok(buildAcpLead({ mode: 'agent', intent: classifyIntent('Make the todos API production ready.', 'agent') })?.includes(CALLER_VISIBLE_CHANGES));
		assert.ok(!buildAcpLead({ mode: 'agent', intent: classifyIntent('add a GET /health route to src/server.js', 'agent') })?.includes(CALLER_VISIBLE_CHANGES));
		assert.ok(!buildAcpLead({ mode: 'plan', intent: classifyIntent('Make the todos API production ready.', 'plan') })?.includes(CALLER_VISIBLE_CHANGES));
	});

	test('agents that can reach the volt MCP server are told when to chart, except for small edits', () => {
		const question = classifyIntent('how has my token usage changed by model over the last 30 days?', 'ask');
		assert.ok(buildAcpLead({ mode: 'ask', intent: question, visuals: true })?.includes(`[Volt] ${VISUAL_REPLIES}`));
		assert.ok(buildAcpLead({ mode: 'agent', intent: classifyIntent('analyse the commit history of this repo by author', 'agent'), visuals: true })?.includes(VISUAL_REPLIES));
		assert.ok(!buildAcpLead({ mode: 'ask', intent: question })?.includes(VISUAL_REPLIES), 'not without the visual tools');
		assert.ok(!buildAcpLead({ mode: 'agent', intent: classifyIntent('fix the typo in README.md', 'agent'), visuals: true })?.includes(VISUAL_REPLIES), 'not in the fast lane');
		assert.ok(buildSystemPrompt({ mode: 'ask', intent: question, visuals: true }).includes(VISUAL_REPLIES), 'native prompts receive the same guidance');
		assert.ok(!buildSystemPrompt({ mode: 'ask', intent: question }).includes(VISUAL_REPLIES));
		assert.ok(!buildSystemPrompt({ mode: 'agent', intent: classifyIntent('fix the typo in README.md', 'agent'), visuals: true }).includes(VISUAL_REPLIES));
	});

	test('test-related work forbids gaming the suite; other work and read-only modes do not carry the line', () => {
		assert.ok(buildAcpLead({ mode: 'agent', intent: classifyIntent("npm test is failing. Make every test pass. Don't edit anything under test/.", 'agent') })?.includes(TEST_INTEGRITY));
		assert.ok(!buildAcpLead({ mode: 'agent', intent: classifyIntent('rename foo to bar in src/utils.ts', 'agent') })?.includes(TEST_INTEGRITY));
		assert.ok(!buildAcpLead({ mode: 'ask', intent: classifyIntent('why are the tests failing?', 'ask') })?.includes(TEST_INTEGRITY));
	});

	test('plan mode is read-only even in the agent lane', () => {
		const intent = classifyIntent('add pagination to the users table', 'plan');
		const prompt = buildSystemPrompt({ mode: 'plan', intent });
		assert.ok(/Read-only/.test(prompt));
		assert.ok(/Do not run commands/.test(prompt));
		const lead = buildAcpLead({ mode: 'plan', intent });
		assert.ok(lead?.includes('[Volt mode: plan]'));
		assert.ok(lead?.includes('Do not change files'));
	});

	test('each non-agent mode tells an ACP agent what it is for', () => {
		const lead = (mode: 'ask' | 'debug' | 'agent') => buildAcpLead({ mode, intent: classifyIntent('why does the server crash on start', mode) }) ?? '';
		assert.ok(/Answer only/.test(lead('ask')));
		assert.ok(/reproduce the problem first/.test(lead('debug')));
		assert.ok(!lead('agent').includes('[Volt mode'));
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

	test('a short message still gets the normal prompt', () => {
		const intent = classifyIntent('testing', 'agent', { hasWorkspace: true });
		const prompt = buildSystemPrompt({
			mode: 'agent',
			intent,
			projectInstructions: 'Always use pnpm.',
			toolSnippets: ['read_file - read a file'],
		});
		assert.ok(!/check-in|Reply immediately/.test(prompt));
		assert.ok(/read_file/.test(prompt));
		assert.ok(/Always use pnpm/.test(prompt));
		const lead = buildAcpLead({ mode: 'agent', intent });
		assert.ok(!lead || !/Reply immediately/.test(lead));
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
