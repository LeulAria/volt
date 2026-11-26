/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	applyThreadGroupAction, assignServers, attachedChatBlock, changedPath, chatDigest, chatFiles, chatRecord, describeRelations, describeServer, fileAnswers, findOverlaps, findPorts, findTerms, findThreadGroup, formatFleet,
	groupsOf, IFleetProjectRef, IFoundChat, IRecordTurn, IThreadGroup, IThreadGroupChange, looksLikeDevServer, rankFound, shownPath, turnWork, workSearchText, matchProject, misroutedProjects, parseThreadGroups, parseThreadOrigins, projectsLine, relatedChatsNote, relationsOf, routeNote, shortCommand, withThreadOrigin,
} from '../../../common/orchestration/agentFleet.js';

const VOLT: IFleetProjectRef = { id: 'p-volt', name: 'volt', root: '/Users/me/code/volt' };
const SERVER: IFleetProjectRef = { id: 'p-server', name: 'volt-server', root: '/Users/me/code/volt-server' };
const SHOP: IFleetProjectRef = { id: 'p-shop', name: 'Shopfront', root: '/Users/me/code/shopfront' };
const API: IFleetProjectRef = { id: 'p-api', name: 'api', root: '/Users/me/work/api' };
const PAY: IFleetProjectRef = { id: 'p-pay', name: 'payments-gateway', root: '/Users/me/work/payments-gateway' };
const ALL = [VOLT, SERVER, SHOP, API, PAY];

suite('Volt fleet: projects, servers, groups and routing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a project is found by its folder, its name, its folder name, then a part of its name', () => {
		assert.strictEqual(matchProject(ALL, '/Users/me/code/shopfront/').project, SHOP);
		assert.strictEqual(matchProject(ALL, 'shopfront').project, SHOP);
		assert.strictEqual(matchProject(ALL, 'volt').project, VOLT, 'the exact name wins over "volt-server"');
		assert.strictEqual(matchProject(ALL, 'payments').project, PAY);
		assert.deepStrictEqual(matchProject(ALL, 'vol').ambiguous, [VOLT, SERVER]);
		assert.deepStrictEqual(matchProject(ALL, 'nothing-like-it'), {});
		assert.deepStrictEqual(matchProject(ALL, '  '), {});
	});

	/**
	 * The routing set: a prompt typed into one project's chat, and the other projects it is meant
	 * for. Every case must hold; a new miss found in use is added here before the matcher changes.
	 */
	test('a prompt that names another project and not its own is flagged; everything else is left alone', () => {
		const cases: readonly { readonly own: IFleetProjectRef; readonly prompt: string; readonly expect: readonly IFleetProjectRef[] }[] = [
			// Meant for another project.
			{ own: VOLT, prompt: 'Fix the payment integration in Shopfront', expect: [SHOP] },
			{ own: VOLT, prompt: 'in shopfront the cart total is wrong, fix it', expect: [SHOP] },
			{ own: SHOP, prompt: 'update the retry logic in payments-gateway', expect: [PAY] },
			{ own: SHOP, prompt: 'Bump the node version in /Users/me/work/api/package.json', expect: [API] },
			{ own: VOLT, prompt: 'the api project needs a /health route', expect: [API] },
			{ own: VOLT, prompt: 'add rate limiting to project "api"', expect: [API] },
			{ own: SHOP, prompt: 'make Shopfront\'s checkout call payments-gateway', expect: [] },
			{ own: PAY, prompt: 'what is Shopfront doing and what port is it on?', expect: [SHOP] },
			// About this project: its own name, or no project at all.
			{ own: VOLT, prompt: 'fix the flaky test', expect: [] },
			{ own: VOLT, prompt: 'the volt sidebar flickers; shopfront does the same thing, compare', expect: [] },
			// A common word that happens to be a project's name.
			{ own: VOLT, prompt: 'add an api for listing chats', expect: [] },
			{ own: VOLT, prompt: 'call the API and show the result', expect: [] },
			// A name inside a path, an identifier, a package or a longer name.
			{ own: VOLT, prompt: 'open src/shopfront/index.ts', expect: [] },
			{ own: VOLT, prompt: 'rename shopfrontClient to storeClient', expect: [] },
			{ own: VOLT, prompt: 'install @acme/shopfront', expect: [] },
			{ own: VOLT, prompt: 'see shopfront.config.js', expect: [] },
			// One name contains the other: naming the longer says nothing about the shorter.
			{ own: VOLT, prompt: 'restart volt-server', expect: [] },
			{ own: SERVER, prompt: 'the volt window shows a stale chat', expect: [] },
		];
		const misses: string[] = [];
		for (const item of cases) {
			const got = misroutedProjects(item.prompt, item.own, ALL.filter(project => project !== item.own)).map(project => project.name);
			if (JSON.stringify(got) !== JSON.stringify(item.expect.map(project => project.name))) {
				misses.push(`[${item.own.name}] "${item.prompt}" -> ${JSON.stringify(got)}`);
			}
		}
		assert.deepStrictEqual(misses, [], `${cases.length - misses.length}/${cases.length} routed correctly`);
	});

	test('the routing note names the project and how to send the request there; no project, no note', () => {
		assert.strictEqual(routeNote(VOLT, []), undefined);
		const note = routeNote(VOLT, [SHOP])!;
		assert.ok(note.includes('"Shopfront" (/Users/me/code/shopfront)'));
		assert.ok(note.includes('"volt" (/Users/me/code/volt)'));
		assert.ok(note.includes('thread_send') && note.includes('thread_launch'));
		assert.strictEqual(projectsLine(VOLT, []), undefined);
		assert.ok(projectsLine(VOLT, [SHOP, API])!.includes('Shopfront (/Users/me/code/shopfront); api (/Users/me/work/api)'));
		assert.ok(projectsLine(VOLT, ALL, 2)!.includes('and 3 more'));
	});

	test('a server belongs to the deepest checkout holding its working directory', () => {
		const servers = [
			{ port: 5173, command: 'node vite', cwd: '/Users/me/code/shopfront/apps/web', pid: 1 },
			{ port: 3000, command: 'node server.js', cwd: '/private/tmp/wt/shop-a', pid: 2 },
			{ port: 9000, command: 'python -m http.server', cwd: '/Users/me/elsewhere', pid: 3 },
			{ port: 4000, command: 'node x', cwd: '/Users/me/code/shopfront-old', pid: 4 },
		];
		const assigned = assignServers(servers, [
			{ owner: 'project', path: '/Users/me/code/shopfront' },
			{ owner: 'chat-a', path: '/tmp/wt/shop-a/' },
		]);
		assert.deepStrictEqual(assigned.get('project')?.map(server => server.port), [5173]);
		assert.deepStrictEqual(assigned.get('chat-a')?.map(server => server.port), [3000], '/private/tmp is /tmp');
		assert.deepStrictEqual(assigned.get('')?.map(server => server.port), [4000, 9000], 'a folder whose name only starts the same is not inside');
	});

	test('desktop apps\' ports are not dev servers', () => {
		assert.strictEqual(looksLikeDevServer('/Applications/Docker.app/Contents/MacOS/com.docker.backend', '/'), false);
		assert.strictEqual(looksLikeDevServer('/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter', undefined), false);
		assert.strictEqual(looksLikeDevServer('node /Users/me/code/shopfront/node_modules/.bin/vite', '/Users/me/code/shopfront'), true);
		assert.strictEqual(looksLikeDevServer('./my-server', '/Users/me/code/thing'), true);
		assert.strictEqual(looksLikeDevServer('rapportd', '/'), false);
		const python = '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python -m http.server 9941';
		assert.strictEqual(looksLikeDevServer(python, '/private/tmp/vfleet/shopfront'), true, 'a runtime shipped as an app bundle, started in a project');
		assert.strictEqual(looksLikeDevServer('/Users/me/Applications/Thing.app/Contents/MacOS/Thing', '/'), false);
		// A Volt dev build run from its checkout listens on ports of its own (seen live: six of them under "outside every project").
		assert.strictEqual(looksLikeDevServer('/Users/me/code/volt/.build/electron/VOLT.app/Contents/MacOS/Electron . --user-data-dir /tmp/x', '/Users/me/code/volt'), false);
		assert.strictEqual(looksLikeDevServer('/Users/me/code/volt/.build/electron/VOLT.app/Contents/Frameworks/VOLT Helper (Renderer).app/Contents/MacOS/VOLT Helper (Renderer) --type=renderer', '/Users/me/code/volt'), false);
	});

	test('a server\'s command reads as typed, not as an install path', () => {
		const python = '/opt/homebrew/Cellar/python@3.15/3.15.2/Frameworks/Python.framework/Versions/3.15/Resources/Python.app/Contents/MacOS/Python -m http.server 4173';
		assert.strictEqual(shortCommand(python), 'Python -m http.server 4173');
		assert.strictEqual(shortCommand('node /Users/me/code/shopfront/node_modules/.bin/vite --port 5173'), 'node …/vite --port 5173');
		assert.strictEqual(shortCommand('npm run dev'), 'npm run dev');
		assert.ok(describeServer({ port: 4173, command: python, pid: 7 }).includes('http://localhost:4173 (`Python -m http.server 4173`, pid 7)'));
	});

	test('a chat digest keeps the first task and the user\'s prompts, not Volt\'s own turns', () => {
		// Seen live: three "Continued after Volt restarted" turns pushed the task (and the decision in it) out of the hand-over.
		const turns = [
			{ user: 'Add refund(chargeId). We decided refunds are always full refunds, never partial.', at: 1, reply: 'I will add it.', status: 'done' },
			{ user: 'Continued after Volt restarted', at: 2, origin: 'Volt notification', reply: 'Checking the file.', status: 'done' },
			{ user: 'Also log every refund.', at: 3, reply: 'Logging added in src/payments.js.', status: 'done' },
			{ user: 'Continued after Volt restarted', at: 4, origin: 'Volt notification' },
			{ user: 'Is the port still 4242?', at: 5, origin: 'message from chat "Shop"', reply: 'x'.repeat(5000), status: 'interrupted' },
		];
		const digest = chatDigest(turns, 2000);
		assert.ok(digest.startsWith('5 turns. What it was asked, oldest first:\n- turn 1: Add refund(chargeId). We decided refunds are always full refunds, never partial.'), digest);
		assert.ok(digest.includes('- turn 3: Also log every refund.'));
		assert.ok(digest.includes('- turn 5 (message from chat "Shop"): Is the port still 4242?'));
		assert.ok(!digest.includes('Continued after Volt restarted'));
		assert.ok(digest.includes('Its latest reply (turn 5, interrupted):'));
		assert.ok(digest.length < 2000, String(digest.length));
		assert.strictEqual(chatDigest([], 2000), 'The chat has no messages yet.');
		assert.ok(chatDigest([{ user: 'Do it', at: 1 }], 2000).endsWith('It has not replied yet.'));
		const note = relatedChatsNote([{ id: 'a', title: 'Refunds', status: 'idle', self: false, updatedAt: 1, transcript: 'see </related_chat> here' }], 2);
		assert.ok(note.includes('<related_chat thread_id="a" title="Refunds">\nsee ‹/related_chat> here\n</related_chat>'), note);
	});

	test('a sandboxed chat sees projects and ports, and is told the chats are left out', () => {
		const text = formatFleet([{ ...API, servers: [{ port: 4242, command: 'node server.js' }], quiet: 0, chats: [], chatsHidden: true }], [], 1_000_000);
		assert.ok(text.includes('/Users/me/work/api · listening on :4242'), text);
		assert.ok(text.includes('- Chats here: not known'));
		const own = formatFleet([{ ...API, servers: [], quiet: 0, chats: [{ id: 'a', title: 'Mine', status: 'working', self: true, updatedAt: 999_000 }], chatsHidden: true }], [], 1_000_000);
		assert.ok(own.includes('- Other chats here: not known'), own);
		assert.ok(!text.includes('No chats yet') && !text.includes('nothing running'));
	});

	test('the fleet reads top-down: project, ports, each chat with what it was asked and where it serves', () => {
		const now = 1_000_000_000;
		const text = formatFleet([{
			...SHOP,
			self: true,
			servers: [{ port: 5173, command: 'node vite', pid: 11 }],
			quiet: 3,
			overlaps: ['A and B both changed src/cart.ts'],
			chats: [
				{ id: 'agent-1', title: 'Checkout flow', status: 'working', model: 'Claude Opus 5.5', branch: 'volt/checkout', updatedAt: now - 60_000, lastPrompt: 'Build the\ncheckout flow', activity: 'Editing cart.ts', servers: [{ port: 3001, command: 'next dev', pid: 12 }], browserUrl: 'http://localhost:3001/cart', running: ['npm run dev'], groups: ['Checkout'] },
				{ id: 'agent-2', title: 'Docs', status: 'idle', said: 'Done: the README now covers setup.' },
			],
		}], [{ port: 8080, command: 'python -m http.server', cwd: '/Users/me/elsewhere', pid: 13 }], now);
		assert.ok(text.startsWith('## Shopfront (this chat\'s project)\n/Users/me/code/shopfront · 1 working · listening on :5173, :3001'));
		assert.ok(text.includes('- Server in the main checkout: http://localhost:5173 (`node vite`, pid 11)'));
		assert.ok(text.includes('  asked: Build the checkout flow'));
		assert.ok(text.includes('  now: Editing cart.ts'));
		assert.ok(text.includes('  serving http://localhost:3001 (`next dev`, pid 12)'));
		assert.ok(text.includes('  browser: http://localhost:3001/cart'));
		assert.ok(text.includes('  running: `npm run dev`'));
		assert.ok(text.includes('  group: Checkout'));
		assert.ok(text.includes('  last reply: Done: the README now covers setup.'));
		assert.ok(text.includes('- Overlap: A and B both changed src/cart.ts'));
		assert.ok(text.includes('- and 3 quiet chats'));
		assert.ok(text.includes('## Dev servers outside every project\n- http://localhost:8080'));
		assert.strictEqual(formatFleet([], [], now), 'No projects are open in Volt.');
		assert.ok(formatFleet([{ ...API, servers: [], quiet: 0, chats: [] }], [], now).includes('no dev server listening\n- No chats yet.'));
	});

	test('groups: create, add, remove, rename, delete; unknown chats and duplicate names are refused', () => {
		let next = 0;
		const context = { known: (id: string) => id.startsWith('agent-'), newId: () => `group-${++next}`, now: 5 };
		const ok = (groups: readonly IThreadGroup[], args: Record<string, unknown>): IThreadGroupChange => {
			const change = applyThreadGroupAction(groups, args, context);
			assert.ok(!('error' in change), 'error' in change ? change.error : '');
			return change as IThreadGroupChange;
		};
		const error = (groups: readonly IThreadGroup[], args: Record<string, unknown>): string => {
			const change = applyThreadGroupAction(groups, args, context);
			return 'error' in change ? change.error : '';
		};
		const made = ok([], { action: 'create', name: 'Checkout', thread_ids: ['agent-1', 'volt://session/agent-2', 'agent-1'], note: 'cart + payments', link: 'VOLT-123' });
		assert.deepStrictEqual(made.groups, [{ id: 'group-1', name: 'Checkout', threads: ['agent-1', 'agent-2'], note: 'cart + payments', link: 'VOLT-123', createdAt: 5 }]);
		assert.ok(error(made.groups, { action: 'create', name: 'checkout' }).includes('already exists'));
		assert.ok(error(made.groups, { action: 'add', group: 'Checkout', thread_ids: ['nope'] }).includes('No chat nope'));
		assert.ok(error(made.groups, { action: 'add', group: 'Other', thread_ids: ['agent-3'] }).includes('Groups: "Checkout"'));
		const added = ok(made.groups, { action: 'add', group: 'checkout', thread_ids: ['agent-3', 'agent-1'] });
		assert.deepStrictEqual(added.group?.threads, ['agent-1', 'agent-2', 'agent-3']);
		assert.strictEqual(ok(added.groups, { action: 'add', group: 'group-1', thread_ids: ['agent-1'] }).changed, false);
		const removed = ok(added.groups, { action: 'remove', group: 'Checkout', thread_ids: ['agent-2'] });
		assert.deepStrictEqual(removed.group?.threads, ['agent-1', 'agent-3']);
		const renamed = ok(removed.groups, { action: 'rename', group: 'Checkout', name: 'Cart', link: 'https://example.test/pr/4' });
		assert.strictEqual(renamed.group?.name, 'Cart');
		assert.strictEqual(renamed.group?.link, 'https://example.test/pr/4');
		assert.strictEqual(renamed.group?.note, 'cart + payments');
		assert.deepStrictEqual(groupsOf(renamed.groups, 'agent-3'), ['Cart']);
		assert.strictEqual(findThreadGroup(renamed.groups, 'CART')?.id, 'group-1');
		assert.deepStrictEqual(ok(renamed.groups, { action: 'delete', group: 'Cart' }).groups, []);
		assert.strictEqual(ok(renamed.groups, {}).changed, false, 'list is the default');
		// What is stored survives a round trip; anything malformed is dropped, not thrown on.
		assert.deepStrictEqual(parseThreadGroups(JSON.stringify(renamed.groups)), renamed.groups);
		assert.deepStrictEqual(parseThreadGroups('[{"id":1},null,{"id":"g","name":"n","threads":["a",2]}]'), [{ id: 'g', name: 'n', threads: ['a'], createdAt: 0 }]);
		assert.deepStrictEqual(parseThreadGroups('not json'), []);
	});

	test('where a chat came from: who started it, what it builds on, and what came out of it', () => {
		let origins = withThreadOrigin([], { id: 'agent-b', by: 'agent-a', context: ['agent-x'], at: 1 });
		origins = withThreadOrigin(origins, { id: 'agent-c', by: 'agent-a', at: 2 });
		assert.deepStrictEqual(parseThreadOrigins(JSON.stringify(origins)), origins);
		const forks = [{ id: 'agent-f', forkOf: 'agent-a' }];
		const link = (id: string) => `<${id}>`;
		assert.deepStrictEqual(describeRelations(relationsOf('agent-a', origins, forks), link), ['Forks of it: <agent-f>', 'Chats it started: <agent-b>, <agent-c>']);
		assert.deepStrictEqual(describeRelations(relationsOf('agent-b', origins, forks), link), ['Started by <agent-a>', 'Builds on <agent-x>']);
		assert.deepStrictEqual(describeRelations(relationsOf('agent-x', origins, forks), link), ['Chats that build on it: <agent-b>']);
		assert.deepStrictEqual(describeRelations(relationsOf('agent-f', origins, forks), link), ['Forked from <agent-a>']);
		assert.deepStrictEqual(describeRelations(relationsOf('agent-z', origins, forks), link), []);
	});

	test('two checkouts changing one file, and two chats working in one checkout, are both named', () => {
		assert.strictEqual(changedPath(' M src/a.ts'), 'src/a.ts');
		assert.strictEqual(changedPath('R  old/name.ts -> new/name.ts'), 'new/name.ts');
		assert.strictEqual(changedPath('?? "with space.ts"'), 'with space.ts');
		const lines = findOverlaps([
			{ path: '/repo', who: ['A', 'B'], files: ['src/cart.ts', 'README.md'], working: ['A', 'B'] },
			{ path: '/wt/c', who: ['C'], files: ['src/cart.ts', 'src/pay.ts'], working: ['C'] },
			{ path: '/wt/d', who: ['D'], files: ['docs/x.md'] },
		]);
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0].startsWith('A and B are working in the same checkout (/repo)'));
		assert.ok(lines[1].startsWith('A, B and C both changed src/cart.ts:'));
		assert.deepStrictEqual(findOverlaps([{ path: '/repo', who: ['A', 'B'], files: ['x'], working: ['A'] }]), [], 'one working chat and an idle one do not collide');
	});

	test('a tagged chat says who it is and how to read, inspect, ask and continue it', () => {
		const block = attachedChatBlock({ id: 'agent-9', title: 'Fix "login" <redirect>', status: 'idle', model: 'Claude Opus 5.5', project: 'Shopfront', checkout: '/wt/login', branch: 'volt/login', turns: 4, clipped: true }, 'User: hi\nAssistant: hello');
		assert.ok(block.startsWith('<attached_chat title="Fix login redirect" thread_id="agent-9" status="idle" model="Claude Opus 5.5" project="Shopfront" checkout="/wt/login" branch="volt/login" turns="4">\nUser: hi\nAssistant: hello\n\n'));
		assert.ok(block.includes('(the latest part; earlier turns were cut)'));
		for (const tool of ['thread_read', 'thread_inspect', 'thread_send', 'thread_fork']) {
			assert.ok(block.includes(tool), tool);
		}
		assert.ok(block.endsWith('</attached_chat>'));
		assert.ok(attachedChatBlock({ id: 'agent-1', title: 'New' }, undefined).includes('It has no messages yet.'));
	});

	const reply = (blocks: Record<string, unknown>[], steps: { label: string; state: string }[] = []) => ({ kind: 'agent', steps, segments: [{ kind: 'text', text: 'ok' }, ...blocks.map(block => ({ kind: 'block', block }))] });

	test('a reply\'s work is read from its stored blocks; anything malformed is ignored', () => {
		const work = turnWork(reply([
			{ type: 'file', path: '/repo/src/cart.ts', verb: 'Edited', additions: 4, deletions: 1 },
			{ type: 'terminal', command: ' npm test ', exitCode: 1, output: 'x' },
			{ type: 'file', path: 7 },
			{ type: 'terminal', command: '' },
			{ type: 'markdown', text: 'hi' },
		], [{ label: 'Write the test', state: 'done' }, { label: 'Fix rounding', state: 'current' }]));
		assert.deepStrictEqual(work, {
			files: [{ path: '/repo/src/cart.ts', verb: 'edited', additions: 4, deletions: 1 }],
			commands: [{ command: 'npm test', exitCode: 1 }],
			steps: [{ label: 'Write the test', done: true }, { label: 'Fix rounding', done: false }],
		});
		assert.strictEqual(turnWork(undefined), undefined);
		assert.strictEqual(turnWork('text'), undefined);
		assert.strictEqual(turnWork({ segments: 'no', steps: 3 }), undefined);
		assert.strictEqual(turnWork(reply([])), undefined, 'a reply that only talked did no work');
		assert.strictEqual(workSearchText(work), 'Changed files: /repo/src/cart.ts\nRan: npm test');
		assert.strictEqual(workSearchText(undefined), '');
	});

	const RECORD: IRecordTurn[] = [
		{ user: 'Add discounts to the cart', at: 1, reply: 'Started.', status: 'done', work: turnWork(reply([{ type: 'file', path: '/repo/src/cart.ts', verb: 'Created', additions: 30, deletions: 0 }, { type: 'terminal', command: 'npm test', exitCode: 1 }]))! },
		{ user: 'Use integer cents', at: 2, origin: 'message from chat "Payments API"', reply: 'Done.', status: 'done', work: turnWork(reply([{ type: 'file', path: '/repo/src/cart.ts', verb: 'Edited', additions: 5, deletions: 2 }, { type: 'file', path: '/repo/src/money.ts', verb: 'Created', additions: 9 }, { type: 'terminal', command: 'npm test', exitCode: 0 }, { type: 'terminal', command: 'npm run lint', exitCode: 2 }]))! },
		{ user: 'Now the coupon codes', at: 3, reply: 'Working on it', status: 'interrupted', work: turnWork(reply([], [{ label: 'Parse codes', state: 'done' }, { label: 'Apply at checkout', state: 'pending' }]))! },
	];

	test('a chat\'s record: files with their turns, commands still failing, open to-dos, who wrote to it, how it ended', () => {
		assert.deepStrictEqual(chatFiles(RECORD), [
			{ path: '/repo/src/money.ts', verb: 'created', turns: [2], additions: 9, deletions: 0 },
			{ path: '/repo/src/cart.ts', verb: 'created', turns: [1, 2], additions: 35, deletions: 2 },
		]);
		assert.deepStrictEqual(chatRecord(RECORD, { folder: '/repo' }), [
			'Files its agent changed (2, last changed first):',
			'- src/money.ts (created, turn 2, +9 -0)',
			'- src/cart.ts (created, turns 1, 2, +35 -2)',
			'Commands its agent ran: 3. Failing at their last run:',
			'- `npm run lint` exit 2 (turn 2)',
			'Its to-do list (turn 3): 1 of 2 done. Left open:',
			'- Apply at checkout',
			'Written to by other chats: "Payments API" (turn 2)',
			'Its last turn (3) did not finish: interrupted.',
		], 'npm test failed in turn 1 and passed in turn 2: not a failure');
		assert.deepStrictEqual(chatRecord([{ user: 'hi', at: 1, reply: 'hello', status: 'done' }]), [], 'a chat that only talked has no record');
		assert.strictEqual(shownPath('/private/tmp/repo/a.ts', '/tmp/repo'), 'a.ts');
		assert.strictEqual(shownPath('/elsewhere/a.ts', '/repo'), '/elsewhere/a.ts');
		assert.strictEqual(shownPath('src/a.ts', '/repo'), 'src/a.ts');
	});

	test('a digest handed to a chat that cannot read the original carries what was done, not only what was said', () => {
		const digest = chatDigest(RECORD, 4000, '/repo');
		assert.ok(digest.includes('What it did (Volt\'s record of its turns, not its own account):'));
		assert.ok(digest.includes('- src/cart.ts (created, turns 1, 2, +35 -2)'));
		assert.ok(digest.includes('- Apply at checkout'));
		assert.ok(digest.indexOf('What it did') < digest.indexOf('Its latest reply'));
	});

	test('a request\'s words, ports and files', () => {
		assert.deepStrictEqual(findTerms('What did we decide about the refund policy in payments-api?'), ['decide', 'refund', 'policy', 'payments-api']);
		assert.deepStrictEqual(findTerms('who is working on src/cart.ts'), ['src', 'cart.ts']);
		assert.deepStrictEqual(findTerms('the and for'), []);
		assert.deepStrictEqual(findTerms('who is on port 4173'), [], 'a port is answered from the listening processes, not from chats that said "port"');
		assert.deepStrictEqual(findPorts('who is on port 3000, and what about localhost:5173 or :8080?'), [3000, 5173, 8080]);
		assert.deepStrictEqual(findPorts('upgrade to v3.2.1 in 2026 across 12 files'), [2026], 'a version is not a port; a bare year cannot be told from one');
		assert.deepStrictEqual(findPorts('fix 7 bugs'), []);
		assert.ok(fileAnswers('/repo/src/cart.ts', [], 'cart.ts'));
		assert.ok(fileAnswers('/repo/src/cart.ts', [], 'src/cart.ts'));
		assert.ok(fileAnswers('src/cart.ts', [], './src/cart.ts'));
		assert.ok(!fileAnswers('/repo/src/cart.test.ts', [], 'cart.ts'));
		assert.ok(!fileAnswers('/repo/src/smartcart.ts', [], 'cart.ts'));
		assert.ok(fileAnswers('/repo/src/checkout/refunds.ts', ['refund'], undefined));
		assert.ok(fileAnswers('/repo/src/refund/index.ts', ['refund'], undefined), 'the folder names it');
		assert.ok(!fileAnswers('/repo/refund/src/deep/index.ts', ['refund'], undefined), 'a folder far above says little');
		assert.ok(!fileAnswers('/repo/api/users.ts', ['api'], undefined), 'short words match too much');
	});

	// The retrieval evaluation set: each case is a request with the chats Volt holds, and the chat
	// an agent should be pointed at first. A ranking change that loses one of these is a regression.
	const NOW = 100 * 86_400_000;
	const found = (id: string, part: Partial<IFoundChat>): IFoundChat => ({ id, content: 0, title: 0, files: 0, live: false, at: NOW - 86_400_000, sameProject: false, ...part });
	const RETRIEVAL: { readonly name: string; readonly chats: IFoundChat[]; readonly first: string; readonly absent?: string[] }[] = [
		{ name: 'the chat that changed the file beats one that only mentioned it', chats: [found('talked', { content: 1 }), found('changed', { files: 1, content: 0.2 })], first: 'changed' },
		{ name: 'changed and discussed beats changed alone', chats: [found('changed', { files: 1 }), found('both', { files: 1, content: 0.8 })], first: 'both' },
		{ name: 'a strong content match beats a title-only match', chats: [found('titled', { title: 1 }), found('said', { content: 1 })], first: 'said' },
		{ name: 'among equal matches the running chat comes first', chats: [found('idle', { content: 0.7 }), found('running', { content: 0.7, live: true })], first: 'running' },
		{ name: 'among equal matches the recent chat comes first', chats: [found('old', { content: 0.7, at: NOW - 40 * 86_400_000 }), found('new', { content: 0.7 })], first: 'new' },
		{ name: 'among equal matches this project\'s chat comes first', chats: [found('other', { content: 0.6 }), found('mine', { content: 0.6, sameProject: true })], first: 'mine' },
		{ name: 'recency does not beat evidence: an old chat that changed the file wins over a fresh mention', chats: [found('fresh', { content: 0.5, live: true, sameProject: true }), found('old', { files: 2, at: NOW - 60 * 86_400_000 })], first: 'old' },
		{ name: 'a chat that matches nothing is not listed, however busy', chats: [found('busy', { live: true, sameProject: true, at: NOW }), found('weak', { title: 0.25 })], first: 'weak', absent: ['busy'] },
		{ name: 'more matching files rank higher', chats: [found('one', { files: 1 }), found('three', { files: 3 })], first: 'three' },
		{ name: 'title and content together beat a better content match alone', chats: [found('said', { content: 1 }), found('both', { content: 0.6, title: 1 })], first: 'both' },
	];

	test(`retrieval evaluation: ${RETRIEVAL.length} of ${RETRIEVAL.length} requests point at the right chat first`, () => {
		const wrong = RETRIEVAL.filter(item => {
			const ranked = rankFound(item.chats, NOW).map(chat => chat.id);
			return ranked[0] !== item.first || (item.absent ?? []).some(id => ranked.includes(id));
		}).map(item => item.name);
		assert.deepStrictEqual(wrong, []);
		assert.deepStrictEqual(rankFound([found('a', {}), found('b', {})], NOW), []);
	});

	// The routing evaluation set: a prompt typed in one project's chat, and the projects it should
	// be flagged for. `[]` is as much an answer as a name: a false alarm interrupts the user.
	const ROUTING: { readonly prompt: string; readonly own: IFleetProjectRef; readonly to: string[] }[] = [
		{ prompt: 'Fix the payment integration in payments-gateway', own: SHOP, to: ['payments-gateway'] },
		{ prompt: 'update the readme of Shopfront', own: PAY, to: ['Shopfront'] },
		{ prompt: 'SHOPFRONT needs a dark mode', own: PAY, to: ['Shopfront'] },
		{ prompt: 'in the api project, add rate limiting', own: SHOP, to: ['api'] },
		{ prompt: 'the "api" repo is missing a license', own: SHOP, to: ['api'] },
		{ prompt: 'open /Users/me/work/payments-gateway/src/charge.ts and fix the rounding', own: SHOP, to: ['payments-gateway'] },
		{ prompt: 'bump volt-server to node 22', own: SHOP, to: ['volt-server'] },
		{ prompt: 'sync shopfront and payments-gateway versions', own: API, to: ['Shopfront', 'payments-gateway'] },
		{ prompt: 'add rate limiting to the api', own: SHOP, to: [] },
		{ prompt: 'call the api and render the result', own: SHOP, to: [] },
		{ prompt: 'make Shopfront call payments-gateway for refunds', own: SHOP, to: [] },
		{ prompt: 'copy the button style from shopfront into this project, payments-gateway', own: PAY, to: [] },
		{ prompt: 'fix the test in src/shopfront/cart.ts', own: PAY, to: [] },
		{ prompt: 'import { pay } from "payments-gateway/client"', own: SHOP, to: [] },
		{ prompt: 'install shopfront-ui and use its Button', own: PAY, to: [] },
		{ prompt: 'email me@shopfront', own: PAY, to: [] },
		{ prompt: 'rename the shopfront.config.js keys', own: PAY, to: [] },
		{ prompt: 'bump volt-server to node 22', own: VOLT, to: [] },
		{ prompt: 'fix the flaky login test', own: SHOP, to: [] },
		{ prompt: '', own: SHOP, to: [] },
	];

	test(`routing evaluation: ${ROUTING.length} of ${ROUTING.length} prompts are routed (or left alone) correctly`, () => {
		const wrong = ROUTING.flatMap(item => {
			const got = misroutedProjects(item.prompt, item.own, ALL.filter(project => project !== item.own)).map(project => project.name);
			return JSON.stringify(got) === JSON.stringify(item.to) ? [] : [`${JSON.stringify(item.prompt)} in ${item.own.name}: flagged [${got.join(', ')}], expected [${item.to.join(', ')}]`];
		});
		assert.deepStrictEqual(wrong, []);
	});
});
