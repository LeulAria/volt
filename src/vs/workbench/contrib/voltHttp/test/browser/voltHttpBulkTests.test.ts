/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { emptyHttpCollection, emptyHttpFolder, emptyHttpRequest, findHttpItem, IHttpItem, IHttpRequest } from '../../common/httpCollection.js';
import { appendHttpTestScript, httpScriptHasTests } from '../../browser/voltHttpAiTests.js';
import { generateHttpTestsFor, httpTestTargetsOf, IHttpBulkResult } from '../../browser/voltHttpBulkTests.js';
import { httpDraftKey, IHttpCollectionEntry, IHttpSendContext, IVoltHttpCollections, mergeHttpTests } from '../../browser/voltHttpCollections.js';
import { IHttpExchange } from '../../browser/voltHttpService.js';

const FILE = URI.file('/repo/http/Shop.postman_collection.json');

function request(name: string, url: string, mutate?: (request: IHttpRequest) => void): IHttpRequest {
	const made = emptyHttpRequest(name, 'none');
	made.url = url;
	mutate?.(made);
	return made;
}

/** A collection service that keeps one collection in memory and answers sends from a table. */
function fixture(items: IHttpItem[], answers: Record<string, { status: number; body: string } | string> = {}) {
	const collection = emptyHttpCollection('Shop', 'postman');
	collection.items.push(...items);
	const entry: IHttpCollectionEntry = { uri: FILE, collection, indent: '\t' };
	const drafts = new Map<string, IHttpRequest>();
	const log: string[] = [];
	const service = {
		load: async () => entry,
		get: () => entry,
		draftOf: (key: string) => drafts.get(key),
		setDraft: (key: string, value: IHttpRequest | undefined) => {
			log.push(`draft ${value?.name}`);
			if (value) {
				drafts.set(key, value);
			} else {
				drafts.delete(key);
			}
		},
		updateItem: async (_uri: URI, id: string, mutate: (item: IHttpItem) => void) => {
			const item = findHttpItem(collection, id)!.item;
			mutate(item);
			log.push(`save ${item.name}`);
		},
		send: async (sent: IHttpRequest, context: IHttpSendContext): Promise<IHttpExchange> => {
			log.push(`send ${sent.name}`);
			assert.strictEqual(context.collection?.toString(), FILE.toString());
			const answer = answers[sent.name] ?? { status: 200, body: `{"name":"${sent.name}"}` };
			const base = { id: sent.name, at: 1, method: sent.method, url: sent.url, headers: [] };
			return typeof answer === 'string' ? { ...base, error: answer } : { ...base, response: { status: answer.status, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: answer.body, durationMs: 5, size: answer.body.length } } as IHttpExchange;
		},
		retest: async (tested: IHttpRequest, _context: IHttpSendContext, exchange: IHttpExchange): Promise<IHttpExchange> => {
			log.push(`retest ${tested.name}`);
			// One result per pm.test in the script as it now stands; a test named "bad" fails.
			const names = [...tested.scripts.test.matchAll(/pm\.test\('([^']+)'/g)].map(match => match[1]);
			return { ...exchange, tests: names.map(name => name === 'bad' ? { name, passed: false, error: 'expected 1 to equal 2' } : { name, passed: true }) };
		},
	};
	return { collections: service as unknown as IVoltHttpCollections, collection, entry, drafts, log };
}

suite('Volt Client: tests for many requests', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('each request is sent, gets the script the model wrote, is saved and its tests run, in the order given', async () => {
		const login = request('Log in', 'http://api.test/login');
		const user = request('Get user', 'http://api.test/users/7', made => made.scripts.test = `pm.test('old', () => {});`);
		const { collections, log } = fixture([login, user]);
		const prompts: string[] = [];
		const stages: string[] = [];
		const seen: IHttpBulkResult[] = [];
		const results = await generateHttpTestsFor(collections, [{ collection: FILE, id: login.id }, { collection: FILE, id: user.id }], {
			wish: 'check the name',
			token: CancellationToken.None,
			write: async prompt => {
				prompts.push(prompt);
				return { script: prompts.length === 1 ? `pm.test('status', () => {});\npm.test('shape', () => {});` : `pm.test('bad', () => {});` };
			},
			onStage: (target, stage) => stages.push(`${target.id === login.id ? 'login' : 'user'}:${stage}`),
			onResult: (result, done, total) => { seen.push(result); assert.strictEqual(total, 2); assert.strictEqual(done, seen.length); },
		});
		assert.deepStrictEqual(log, ['send Log in', 'save Log in', 'retest Log in', 'send Get user', 'save Get user', 'retest Get user']);
		assert.deepStrictEqual(stages, ['login:sending', 'login:writing', 'login:running', 'user:sending', 'user:writing', 'user:running']);
		assert.deepStrictEqual(results.map(({ target, ...rest }) => rest), [
			{ name: 'Log in', status: 'added', passed: 2, total: 2 },
			{ name: 'Get user', status: 'added', passed: 1, total: 2, detail: 'bad: expected 1 to equal 2' },
		]);
		assert.deepStrictEqual(seen, results);
		assert.strictEqual(login.scripts.test, `pm.test('status', () => {});\npm.test('shape', () => {});\n`);
		assert.strictEqual(user.scripts.test, `pm.test('old', () => {});\n\npm.test('bad', () => {});\n`, 'added under the tests it had');
		assert.ok(prompts[0].includes('POST http://api.test/login') || prompts[0].includes('GET http://api.test/login'));
		assert.ok(prompts[0].includes('check the name') && prompts[0].includes('"name":"Log in"'));
		assert.ok(prompts[1].includes('Existing tests:') && prompts[1].includes(`pm.test('old'`), 'the model is told what is there already');
	});

	test('requests with tests are left alone when asked; connections and requests without a URL never get any', async () => {
		const tested = request('Tested', 'http://api.test/a', made => made.scripts.test = `pm.test('old', () => {});`);
		const socket = request('Events', 'ws://api.test/events', made => made.protocol = 'ws');
		const blank = request('Blank', '');
		const plain = request('Plain', 'http://api.test/b');
		const { collections, log } = fixture([tested, socket, blank, plain]);
		const results = await generateHttpTestsFor(collections, [tested, socket, blank, plain].map(item => ({ collection: FILE, id: item.id })), {
			skipExisting: true,
			token: CancellationToken.None,
			write: async () => ({ script: `pm.test('new', () => {});` }),
		});
		assert.deepStrictEqual(results.map(result => `${result.name}:${result.status}`), ['Tested:skipped', 'Events:skipped', 'Blank:skipped', 'Plain:added']);
		assert.strictEqual(results[0].detail, 'Already has tests.');
		assert.deepStrictEqual(log, ['send Plain', 'save Plain', 'retest Plain']);
		assert.strictEqual(tested.scripts.test, `pm.test('old', () => {});`);
	});

	test('a request that got no response, or no usable script, fails on its own and the rest go on; nothing is written for it', async () => {
		const down = request('Down', 'http://api.test/down');
		const mute = request('Mute', 'http://api.test/mute');
		const gone = { collection: FILE, id: 'not-there' };
		const fine = request('Fine', 'http://api.test/fine');
		const { collections, log } = fixture([down, mute, fine], { Down: 'connect ECONNREFUSED' });
		let writes = 0;
		const results = await generateHttpTestsFor(collections, [{ collection: FILE, id: down.id }, { collection: FILE, id: mute.id }, gone, { collection: FILE, id: fine.id }], {
			token: CancellationToken.None,
			write: async () => ++writes === 1 ? { script: 'Sure! Here are some ideas.', failure: 'The model did not answer with tests. Try another model.' } : { script: `pm.test('ok', () => {});` },
		});
		assert.deepStrictEqual(results.map(result => `${result.name}:${result.status}:${result.detail ?? ''}`), [
			'Down:failed:connect ECONNREFUSED',
			'Mute:failed:The model did not answer with tests. Try another model.',
			'not-there:failed:The request is no longer in its collection.',
			'Fine:added:',
		]);
		assert.deepStrictEqual(log, ['send Down', 'send Mute', 'send Fine', 'save Fine', 'retest Fine']);
		assert.strictEqual(down.scripts.test + mute.scripts.test, '');
	});

	test('a request open with unsaved edits is sent as edited and gets the tests in those edits, not in the file', async () => {
		const saved = request('Get user', 'http://api.test/users/7');
		const { collections, drafts, log } = fixture([saved]);
		const key = httpDraftKey(FILE, saved.id);
		drafts.set(key, { ...saved, url: 'http://api.test/users/8', scripts: { ...saved.scripts, test: `pm.test('mine', () => {});` } });
		const prompts: string[] = [];
		const results = await generateHttpTestsFor(collections, [{ collection: FILE, id: saved.id }], {
			token: CancellationToken.None,
			write: async prompt => {
				prompts.push(prompt);
				// The user types on while the model writes.
				drafts.set(key, { ...drafts.get(key)!, name: 'Get user (renamed)' });
				return { script: `pm.test('new', () => {});` };
			},
		});
		assert.ok(prompts[0].includes('http://api.test/users/8'));
		assert.deepStrictEqual(log, ['send Get user', 'draft Get user (renamed)', 'retest Get user (renamed)']);
		assert.deepStrictEqual(results.map(({ target, ...rest }) => rest), [{ name: 'Get user', status: 'added', passed: 2, total: 2, unsaved: true }]);
		assert.strictEqual(saved.scripts.test, '', 'the file keeps what it had until the user saves');
		assert.strictEqual(drafts.get(key)!.scripts.test, `pm.test('mine', () => {});\n\npm.test('new', () => {});\n`);
		assert.strictEqual(drafts.get(key)!.name, 'Get user (renamed)', 'what was typed meanwhile is kept');
	});

	test('stopping ends the run after the request in hand: nothing more is sent or written', async () => {
		const first = request('First', 'http://api.test/1');
		const second = request('Second', 'http://api.test/2');
		const { collections, log } = fixture([first, second]);
		const cancel = new CancellationTokenSource();
		const results = await generateHttpTestsFor(collections, [first, second].map(item => ({ collection: FILE, id: item.id })), {
			token: cancel.token,
			write: async () => {
				cancel.cancel();
				return { script: `pm.test('half', () => {});` };
			},
		});
		cancel.dispose();
		assert.deepStrictEqual(results, []);
		assert.deepStrictEqual(log, ['send First']);
		assert.strictEqual(first.scripts.test, '');
	});

	test('what a sidebar row stands for: a collection\'s requests, a folder\'s, or the one request', () => {
		const top = request('Top', 'http://api.test/top');
		const inner = request('Inner', 'http://api.test/inner');
		const deep = request('Deep', 'http://api.test/deep');
		const folder = emptyHttpFolder('Auth');
		const nested = emptyHttpFolder('Admin');
		nested.items.push(deep);
		folder.items.push(inner, nested);
		const { entry } = fixture([top, folder]);
		const ids = (itemId?: string) => httpTestTargetsOf(entry, itemId).map(target => target.id);
		assert.deepStrictEqual(ids(), [top.id, inner.id, deep.id]);
		assert.deepStrictEqual(ids(folder.id), [inner.id, deep.id]);
		assert.deepStrictEqual(ids(deep.id), [deep.id]);
		assert.deepStrictEqual(ids('nope'), []);
		assert.deepStrictEqual(httpTestTargetsOf({ ...entry, error: 'not JSON' }), []);
	});

	test('one test run again takes the place of its earlier result; the others stay where they were', () => {
		const current = [{ name: 'a', passed: true }, { name: 'b', passed: false, error: 'was 1' }, { name: 'a', passed: false, error: 'second a' }, { name: 'c', passed: true }];
		assert.deepStrictEqual(mergeHttpTests(current, [{ name: 'b', passed: true }]), [current[0], { name: 'b', passed: true }, current[2], current[3]]);
		// Two of one name: the first run replaces the first, the second the second.
		assert.deepStrictEqual(mergeHttpTests(current, [{ name: 'a', passed: false, error: 'x' }, { name: 'a', passed: true }]).map(test => `${test.name}:${test.passed}`), ['a:false', 'b:false', 'a:true', 'c:true']);
		assert.deepStrictEqual(mergeHttpTests(current, [{ name: 'new', passed: true }]).map(test => test.name), ['a', 'b', 'a', 'c', 'new']);
		assert.deepStrictEqual(mergeHttpTests(current, []), current);
	});

	test('a script counts as tests only when it holds one; added scripts go under what is there', () => {
		assert.ok(httpScriptHasTests(`pm.test('a', () => {});`) && httpScriptHasTests(`client.test("a", function () {});`) && httpScriptHasTests(`tests['a'] = true;`));
		assert.ok(!httpScriptHasTests('I cannot do that.') && !httpScriptHasTests(''));
		assert.strictEqual(appendHttpTestScript('', 'x();'), 'x();\n');
		assert.strictEqual(appendHttpTestScript('a();\n\n\n', 'x();'), 'a();\n\nx();\n');
	});
});
