/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildAcpLead, buildSystemPrompt, CALLER_VISIBLE_CHANGES, CODE_QUESTIONS, IDE_TOOLS_GUIDE, IDE_TOOLS_GUIDE_SANDBOXED, IDE_WORK_HINTS, LOAD_DEFERRED, DESIGN_LOOP, DEVICE_REPLIES, MOCKUP_REPLIES, SCRATCH_REPLIES, SCREENS_REPLIES, STANDING_NOTES, SURFACES, TEST_INTEGRITY, VISUAL_REPLIES, WORKSPACE_SCOPE } from '../../../common/harness/contextPack.js';
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
		// A question in Agent mode stays an Agent turn: only Ask and Plan forbid edits.
		assert.ok(!/Do not modify the workspace/.test(prompt));
		assert.ok(/Do not modify the workspace|Read-only/.test(buildSystemPrompt({ mode: 'ask', intent: classifyIntent('how much does this cost right now', 'ask') })));
		assert.ok(!/one or two lines/.test(prompt));
		const lead = buildAcpLead({ mode: 'agent', intent, runPlan: { kind: 'static', start: 'python3 -m http.server 8080' } });
		assert.ok(lead);
		assert.ok(!/http\.server/.test(lead));
		assert.ok(/look them up/i.test(lead));
		assert.ok(!/Do not modify the workspace/.test(lead));
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

	test('small talk gets no lead: nothing to frame, chart or keep in the workspace; the mode contract stays', () => {
		for (const text of ['hi', 'thanks!', 'ok']) {
			const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
			assert.strictEqual(intent.smallTalk, true, text);
			assert.strictEqual(buildAcpLead({ mode: 'agent', intent, visuals: true }), undefined, text);
		}
		const plan = buildAcpLead({ mode: 'plan', intent: classifyIntent('ok', 'plan', { hasWorkspace: true }), visuals: true });
		assert.ok(plan?.startsWith('[Volt mode: plan]'), plan);
		for (const text of ['what is 2+2', 'nissan kicks 2026 price dubai', 'explain the auth flow']) {
			const intent = classifyIntent(text, 'agent', { hasWorkspace: true });
			assert.ok(!intent.smallTalk, text);
			const lead = buildAcpLead({ mode: 'agent', intent, visuals: true });
			assert.ok(lead?.includes(WORKSPACE_SCOPE) && lead.includes(VISUAL_REPLIES), text);
		}
		assert.ok(!classifyIntent('thanks', 'agent', { hasWorkspace: true, priorLane: 'agent' }).smallTalk, 'a follow-up in coding work keeps its lane and lead');
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

	test('the galleries are named only when the request asks for them and the agent has the volt server', () => {
		const mockups = classifyIntent('give me 5 sidebar alternatives for our website', 'agent');
		assert.ok(buildAcpLead({ mode: 'agent', intent: mockups, visuals: true })?.includes(MOCKUP_REPLIES));
		assert.ok(!buildAcpLead({ mode: 'agent', intent: mockups })?.includes(MOCKUP_REPLIES), 'not without the volt MCP server');
		assert.ok(!buildAcpLead({ mode: 'agent', intent: classifyIntent('add pagination to the users table', 'agent'), visuals: true })?.includes(MOCKUP_REPLIES));
		const screens = classifyIntent('show all the screens of the app in light and dark', 'agent');
		assert.ok(buildSystemPrompt({ mode: 'agent', intent: screens, visuals: true }).includes(SCREENS_REPLIES));
		assert.ok(!buildSystemPrompt({ mode: 'agent', intent: screens, visuals: true }).includes(MOCKUP_REPLIES));
	});

	test('surface requests name the right surface, and the surfaces line comes with them', () => {
		const scratch = buildAcpLead({ mode: 'agent', intent: classifyIntent('sketch out the auth architecture', 'agent'), visuals: true });
		assert.ok(scratch?.includes(`[Volt] ${SURFACES}`));
		assert.ok(scratch?.includes(`[Volt] ${SCRATCH_REPLIES}`));
		assert.ok(!scratch?.includes(DEVICE_REPLIES));
		const device = buildAcpLead({ mode: 'agent', intent: classifyIntent('run the ios app on the simulator', 'agent'), visuals: true });
		assert.ok(device?.includes(DEVICE_REPLIES));
		assert.ok(device?.includes(SURFACES));
		assert.ok(!device?.includes(SCRATCH_REPLIES));
		assert.ok(buildAcpLead({ mode: 'agent', intent: classifyIntent('design the onboarding flow for the mobile app', 'agent'), visuals: true })?.includes(SURFACES));
		assert.ok(buildAcpLead({ mode: 'agent', intent: classifyIntent('run the app', 'agent'), visuals: true })?.includes(SURFACES), 'a preview is the browser surface');
		assert.ok(buildSystemPrompt({ mode: 'agent', intent: classifyIntent('[/scratch skill] the release plan', 'agent'), visuals: true }).includes(SCRATCH_REPLIES), 'native prompts receive the same guidance');
		assert.ok(!buildAcpLead({ mode: 'agent', intent: classifyIntent('sketch out the auth architecture', 'agent') })?.includes(SURFACES), 'not without the volt MCP server');
		assert.ok(!buildAcpLead({ mode: 'agent', intent: classifyIntent('add pagination to the users table', 'agent'), visuals: true })?.includes(SURFACES));
	});
	test('a question about the code gets the code-intelligence hint, a plain question does not', () => {
		const code = classifyIntent('Which classes inject FolioService through their constructor?', 'agent');
		assert.strictEqual(code.lane, 'chat');
		const lead = buildAcpLead({ mode: 'agent', intent: code, codeIndexed: true, ideTools: true }) ?? '';
		assert.ok(lead.includes(CODE_QUESTIONS));
		assert.ok(lead.includes(LOAD_DEFERRED), 'the volt tools are deferred: the hint says how to load them');
		assert.ok(!buildAcpLead({ mode: 'agent', intent: code })?.includes(CODE_QUESTIONS));
		const plain = classifyIntent('how much is nissan kicks in UAE', 'agent');
		const plainLead = buildAcpLead({ mode: 'agent', intent: plain, codeIndexed: true, ideTools: true }) ?? '';
		assert.ok(!plainLead.includes(CODE_QUESTIONS) && !plainLead.includes(LOAD_DEFERRED));
	});
	test('an agent session hears each standing note once; request-specific notes go with every request that calls for them', () => {
		const heard = new Set<string>();
		const code = classifyIntent('Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug you find with the line number.', 'agent');
		const first = buildAcpLead({ mode: 'agent', intent: code, visuals: true, ideTools: true }, heard) ?? '';
		assert.ok(first.includes(VISUAL_REPLIES) && first.includes(IDE_TOOLS_GUIDE) && first.includes(WORKSPACE_SCOPE), first);
		assert.deepStrictEqual([...heard].sort(), ['ide', 'scope', 'visuals']);
		assert.ok([...heard].every(id => STANDING_NOTES.includes(id)));
		// The next turn of the same agent session: none of them again.
		const second = buildAcpLead({ mode: 'agent', intent: code, visuals: true, ideTools: true }, heard) ?? '';
		assert.ok(!second.includes(VISUAL_REPLIES) && !second.includes(IDE_TOOLS_GUIDE) && !second.includes(WORKSPACE_SCOPE), second);
		// Switching to a sandboxed chat is news; a test request still gets its own note every time.
		const tests = classifyIntent("npm test is failing. Make every test pass. Don't edit anything under test/.", 'agent');
		const third = buildAcpLead({ mode: 'agent', intent: tests, visuals: true, ideTools: true, sandboxed: true }, heard) ?? '';
		assert.ok(third.includes(IDE_TOOLS_GUIDE_SANDBOXED) && third.includes(TEST_INTEGRITY), third);
		assert.ok((buildAcpLead({ mode: 'agent', intent: tests, ideTools: true, sandboxed: true }, heard) ?? '').includes(TEST_INTEGRITY));
		// "hi" first marks nothing heard, so the first real request still carries them.
		const fresh = new Set<string>();
		assert.strictEqual(buildAcpLead({ mode: 'agent', intent: classifyIntent('hi', 'agent'), visuals: true, ideTools: true }, fresh), undefined);
		assert.strictEqual(fresh.size, 0);
		// Without a set (other callers) every note goes out each time, as before.
		assert.strictEqual(buildAcpLead({ mode: 'agent', intent: code, visuals: true, ideTools: true }), first);
	});
	test('a sandboxed chat is told what of the IDE runs inside its sandbox and what asks first', () => {
		const intent = classifyIntent('add a retry to the payment webhook handler and run its tests', 'agent');
		const open = buildAcpLead({ mode: 'agent', intent, ideTools: true }) ?? '';
		const sandboxed = buildAcpLead({ mode: 'agent', intent, ideTools: true, sandboxed: true }) ?? '';
		assert.ok(open.includes(IDE_TOOLS_GUIDE) && !open.includes(IDE_TOOLS_GUIDE_SANDBOXED));
		assert.ok(sandboxed.includes(IDE_TOOLS_GUIDE_SANDBOXED));
		assert.ok(IDE_TOOLS_GUIDE_SANDBOXED.includes('asks the user') && IDE_TOOLS_GUIDE_SANDBOXED.includes('Full access'));
	});
	test('a request an IDE tool answers gets one line naming it, in any lane', () => {
		const hints = (text: string, mode: 'agent' | 'ask' = 'agent') => {
			const lead = buildAcpLead({ mode, intent: classifyIntent(text, mode), ideTools: true }) ?? '';
			return (Object.keys(IDE_WORK_HINTS) as (keyof typeof IDE_WORK_HINTS)[]).filter(kind => lead.includes(IDE_WORK_HINTS[kind]));
		};
		assert.deepStrictEqual(hints('The flaky container from docker-compose.yml keeps restarting. Why?'), ['docker'], 'a chat-lane question');
		assert.deepStrictEqual(hints('scripts/slow.mjs is slow. Find which function takes the time.'), ['profile']);
		assert.deepStrictEqual(hints('The cart tests are failing. Find out which one and why.'), ['tests']);
		assert.deepStrictEqual(hints('Log in to the local API with the requests in requests.http and show me the profile.'), ['http']);
		assert.deepStrictEqual(hints('Which sku has the highest revenue in shop.db?'), ['db']);
		assert.deepStrictEqual(hints('Rename applyDiscount to applyCoupon everywhere'), ['rename']);
		assert.deepStrictEqual(hints('If the bookings column special_request_tags were renamed in the schema, which files change?'), [], 'a question renames nothing');
		assert.deepStrictEqual(hints('Which oRPC procedures reach resolveBookingStayRent?'), []);
		assert.deepStrictEqual(hints('why does the container keep restarting?', 'ask'), [], 'Ask mode runs nothing');
		assert.ok(!(buildAcpLead({ mode: 'agent', intent: classifyIntent('scripts/slow.mjs is slow', 'agent') }) ?? '').includes(IDE_WORK_HINTS.profile), 'not without the volt MCP server');
		// How to load a deferred volt tool: once, from the IDE guide in the code lanes, or from its own line.
		const chatLead = buildAcpLead({ mode: 'agent', intent: classifyIntent('The flaky container from docker-compose.yml keeps restarting. Why?', 'agent'), ideTools: true }) ?? '';
		assert.ok(chatLead.includes(LOAD_DEFERRED) && !chatLead.includes(IDE_TOOLS_GUIDE));
		const codeLead = buildAcpLead({ mode: 'agent', intent: classifyIntent('add a retry to the payment webhook handler and run its tests', 'agent'), ideTools: true }) ?? '';
		assert.ok(codeLead.includes(IDE_WORK_HINTS.tests) && codeLead.includes(IDE_TOOLS_GUIDE) && IDE_TOOLS_GUIDE.includes('ToolSearch'), codeLead);
		assert.ok(!codeLead.includes(LOAD_DEFERRED), 'said once');
	});
});
