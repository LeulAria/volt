/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IHttpFlow, parseHttpFlow } from '../../common/httpAutomation.js';
import { emptyHttpCollection, emptyHttpFolder, emptyHttpRequest, IHttpCollection, IHttpRequest } from '../../common/httpCollection.js';
import { executeHttpFlow, HttpFlowRun, httpFlowRefFor, IHttpFlowExecution, resolveHttpFlowRef } from '../../browser/voltHttpAutomations.js';
import { IHttpCollectionEntry, IHttpSendContext } from '../../browser/voltHttpCollections.js';
import { IHttpExchange } from '../../browser/voltHttpService.js';

const ROOT = URI.file('/repo');
const COLLECTION = URI.file('/repo/http/Shop.postman_collection.json');
const FLOW_FILE = URI.file('/repo/http/automations/checkout.volt-flow.json');

interface IAnswer {
	readonly status?: number;
	readonly body?: unknown;
	readonly headers?: Record<string, string>;
	/** No response: the send failed with this. */
	readonly error?: string;
}

interface ISent {
	readonly name: string;
	readonly url: string;
	readonly variables: Readonly<Record<string, string>>;
	readonly collection?: string;
}

/**
 * A collections service that answers sends from a function of the request's name and how many
 * times it was sent, and keeps a log of what was sent with which variables.
 */
function fixture(answer: (name: string, count: number, sent: ISent) => IAnswer = () => ({ status: 200, body: {} }), collection?: IHttpCollection) {
	const sent: ISent[] = [];
	const counts = new Map<string, number>();
	const entry: IHttpCollectionEntry | undefined = collection ? { uri: COLLECTION, collection, indent: '\t' } : undefined;
	const sleeps: number[] = [];
	const collections: IHttpFlowExecution['collections'] = {
		load: async (uri: URI) => entry && uri.toString() === COLLECTION.toString() ? entry : undefined,
		collections: async () => entry ? [entry] : [],
		send: async (request: IHttpRequest, context: IHttpSendContext): Promise<IHttpExchange> => {
			const count = (counts.get(request.name) ?? 0) + 1;
			counts.set(request.name, count);
			const record: ISent = { name: request.name, url: request.url, variables: { ...context.variables }, ...(context.collection ? { collection: context.collection.toString() } : {}) };
			sent.push(record);
			const reply = answer(request.name, count, record);
			const base = { id: `${request.name}-${count}`, at: Date.now(), method: request.method, url: request.url, headers: [] };
			if (reply.error) {
				return { ...base, error: reply.error };
			}
			const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
			return { ...base, response: { status: reply.status ?? 200, statusText: 'OK', headers: { 'content-type': 'application/json', ...reply.headers }, body, durationMs: 5, size: body.length } } as IHttpExchange;
		},
	};
	const run = (flow: IHttpFlow, extra: Partial<IHttpFlowExecution> = {}): Promise<HttpFlowRun> => executeHttpFlow({
		flow,
		flowUri: FLOW_FILE,
		root: ROOT,
		collections,
		sleep: async ms => { sleeps.push(ms); },
		...extra,
	});
	return { sent, sleeps, run };
}

function flow(json: Record<string, unknown>): IHttpFlow {
	const parsed = parseHttpFlow({ volt: 'flow', name: 'Test', ...json });
	assert.ok(parsed.flow, parsed.error);
	return parsed.flow;
}

function inline(name: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { kind: 'request', name, inline: { method: 'GET', url }, ...extra };
}

/** The status of each step that does something, by name, in the order they ran. */
function statuses(run: HttpFlowRun): string[] {
	return run.steps.filter(step => step.kind !== 'group' && step.kind !== 'condition' && step.kind !== 'repeat').map(step => `${step.name}:${step.status}`);
}

suite('VoltHttp automations runner', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('runs steps in order and passes extracted values to the next send', async () => {
		const { sent, run } = fixture(name => name === 'Login' ? { status: 200, body: { token: 'tok-1', user: { id: 42 } }, headers: { 'X-Session': 'abc' } } : { status: 200, body: { ok: true } });
		const result = await run(flow({
			variables: [{ key: 'baseUrl', value: 'https://api.test', enabled: true }],
			steps: [
				inline('Login', '{{baseUrl}}/login', { extract: [{ name: 'token', from: 'json', path: '$.token' }, { name: 'userId', from: 'json', path: '$.user.id' }, { name: 'session', from: 'header', path: 'x-session' }], assert: [{ target: 'status', op: 'equals', value: 200 }] }),
				inline('Profile', '{{baseUrl}}/users/{{userId}}', { variables: [{ key: 'auth', value: 'Bearer {{token}}', enabled: true }] }),
			],
		}));
		assert.deepStrictEqual(sent.map(item => item.name), ['Login', 'Profile']);
		assert.strictEqual(sent[0].variables.baseUrl, 'https://api.test');
		assert.strictEqual(sent[1].variables.token, 'tok-1');
		assert.strictEqual(sent[1].variables.userId, '42');
		assert.strictEqual(sent[1].variables.session, 'abc');
		// A step's own overrides are filled in from the values before it.
		assert.strictEqual(sent[1].variables.auth, 'Bearer tok-1');
		assert.strictEqual(result.state, 'passed');
		assert.deepStrictEqual(statuses(result), ['Login:passed', 'Profile:passed']);
		assert.deepStrictEqual(result.steps[0].extracted.map(item => `${item.name}=${item.value}`), ['token=tok-1', 'userId=42', 'session=abc']);
		assert.strictEqual(result.variables.token, 'tok-1');
		assert.strictEqual(result.totals.requests, 2);
	});

	test('a failed assertion fails the step with a readable message', async () => {
		const { run } = fixture(() => ({ status: 200, body: { user: { id: 41 } } }));
		const result = await run(flow({ steps: [inline('Get', 'https://x/u', { assert: [{ target: 'json', path: '$.user.id', op: 'equals', value: 42 }] })] }));
		assert.strictEqual(result.state, 'failed');
		assert.strictEqual(result.steps[0].status, 'failed');
		assert.match(result.steps[0].asserts[0].message, /expected \$\.user\.id to equal 42, got 41/);
	});

	test('retry until polls the request until the condition holds', async () => {
		const { sent, sleeps, run } = fixture((_name, count) => ({ status: 200, body: { state: count < 3 ? 'pending' : 'done' } }));
		const result = await run(flow({
			steps: [inline('Job', 'https://x/job', {
				retry: { times: 5, delayMs: 100, backoff: 2, until: { target: 'json', path: '$.state', op: 'equals', value: 'done' } },
				assert: [{ target: 'status', op: 'equals', value: 200 }],
			})],
		}));
		assert.strictEqual(sent.length, 3);
		assert.strictEqual(result.steps[0].status, 'passed');
		assert.strictEqual(result.steps[0].attempts, 3);
		// The wait grows by the backoff factor.
		assert.deepStrictEqual(sleeps, [100, 200]);
	});

	test('retry until gives up after the last attempt', async () => {
		const { sent, run } = fixture(() => ({ status: 200, body: { state: 'pending' } }));
		const result = await run(flow({ steps: [inline('Job', 'https://x/job', { retry: { times: 2, delayMs: 0, backoff: 1, until: { target: 'json', path: '$.state', op: 'equals', value: 'done' } } })] }));
		assert.strictEqual(sent.length, 3);
		assert.strictEqual(result.steps[0].status, 'failed');
		assert.match(result.steps[0].error ?? '', /Gave up after 3 attempts/);
	});

	test('a retry without a condition sends a failing step again', async () => {
		const { sent, run } = fixture((_name, count) => ({ status: count === 1 ? 503 : 200 }));
		const result = await run(flow({ steps: [inline('Flaky', 'https://x/f', { retry: { times: 3, delayMs: 0, backoff: 1 }, assert: [{ target: 'status', op: 'equals', value: 200 }] })] }));
		assert.strictEqual(sent.length, 2);
		assert.strictEqual(result.steps[0].status, 'passed');
	});

	test('a condition runs its steps only when it holds', async () => {
		const { sent, run } = fixture();
		const result = await run(flow({
			steps: [
				{ kind: 'set', variables: [{ key: 'plan', value: 'pro', enabled: true }] },
				{ kind: 'condition', if: { target: 'variable', path: 'plan', op: 'equals', value: 'pro' }, steps: [inline('Pro', 'https://x/pro')] },
				{ kind: 'condition', if: { target: 'variable', path: 'plan', op: 'equals', value: 'free' }, steps: [inline('Free', 'https://x/free')] },
			],
		}));
		assert.deepStrictEqual(sent.map(item => item.name), ['Pro']);
		assert.ok(statuses(result).includes('Free:skipped'));
		assert.strictEqual(result.state, 'passed');
	});

	test('repeat goes through a JSON list, a count, and until a condition holds', async () => {
		const { sent, run } = fixture((name, count) => name === 'Poll' ? { body: { done: count >= 2 } } : { status: 200 });
		const result = await run(flow({
			steps: [
				{ kind: 'set', variables: [{ key: 'ids', value: '[7, 8, 9]', enabled: true }] },
				{ kind: 'repeat', forEach: 'ids', as: 'id', max: 100, steps: [inline('Item', 'https://x/items/{{id}}')] },
				{ kind: 'repeat', times: 2, max: 100, steps: [inline('Twice', 'https://x/t')] },
				{ kind: 'repeat', until: { target: 'json', path: '$.done', op: 'equals', value: true }, max: 5, steps: [inline('Poll', 'https://x/p')] },
			],
		}));
		const items = sent.filter(item => item.name === 'Item');
		assert.deepStrictEqual(items.map(item => item.variables.id), ['7', '8', '9']);
		assert.deepStrictEqual(items.map(item => item.variables.idIndex), ['0', '1', '2']);
		assert.strictEqual(sent.filter(item => item.name === 'Twice').length, 2);
		assert.strictEqual(sent.filter(item => item.name === 'Poll').length, 2);
		assert.strictEqual(result.state, 'passed');
	});

	test('a repeat over a variable that is not a list is an error', async () => {
		const { run } = fixture();
		const result = await run(flow({ steps: [{ kind: 'repeat', forEach: 'missing', max: 10, steps: [inline('Item', 'https://x/i')] }] }));
		assert.strictEqual(result.state, 'failed');
		assert.match(result.steps[0].error ?? '', /missing does not hold a JSON list/);
	});

	test('teardown runs after a failure while the other steps are skipped', async () => {
		const { sent, run } = fixture(name => name === 'Create' ? { status: 500 } : { status: 200 });
		const result = await run(flow({
			steps: [
				{ kind: 'group', role: 'setup', steps: [inline('Create', 'https://x/c', { assert: [{ target: 'status', op: 'equals', value: 201 }] })] },
				inline('Use', 'https://x/u'),
				{ kind: 'group', role: 'teardown', steps: [inline('Delete', 'https://x/d')] },
			],
		}));
		assert.deepStrictEqual(sent.map(item => item.name), ['Create', 'Delete']);
		assert.deepStrictEqual(statuses(result), ['Create:failed', 'Use:skipped', 'Delete:passed']);
		assert.strictEqual(result.state, 'failed');
	});

	test('stop on failure skips the rest; turned off, the run goes on', async () => {
		const answer = (name: string) => name === 'A' ? { status: 500 } : { status: 200 };
		const steps = [inline('A', 'https://x/a', { assert: [{ target: 'status', op: 'equals', value: 200 }] }), inline('B', 'https://x/b')];
		const stopping = fixture(answer);
		const stopped = await stopping.run(flow({ steps }));
		assert.deepStrictEqual(stopping.sent.map(item => item.name), ['A']);
		assert.deepStrictEqual(statuses(stopped), ['A:failed', 'B:skipped']);

		const going = fixture(answer);
		const went = await going.run(flow({ settings: { stopOnFailure: false }, steps }));
		assert.deepStrictEqual(going.sent.map(item => item.name), ['A', 'B']);
		assert.deepStrictEqual(statuses(went), ['A:failed', 'B:passed']);
		assert.strictEqual(went.state, 'failed');
	});

	test('continueOnFailure lets the run go on past one step', async () => {
		const { sent, run } = fixture(name => name === 'A' ? { status: 404 } : { status: 200 });
		await run(flow({ steps: [inline('A', 'https://x/a', { continueOnFailure: true, assert: [{ target: 'status', op: 'equals', value: 200 }] }), inline('B', 'https://x/b')] }));
		assert.deepStrictEqual(sent.map(item => item.name), ['A', 'B']);
	});

	test('one iteration per data row, its columns as variables', async () => {
		const { sent, run } = fixture();
		const result = await run(flow({ steps: [inline('Signup', 'https://x/signup')] }), { rows: [{ email: 'a@x.io' }, { email: 'b@x.io' }] });
		assert.deepStrictEqual(sent.map(item => item.variables.email), ['a@x.io', 'b@x.io']);
		assert.deepStrictEqual(sent.map(item => item.variables.iteration), ['1', '2']);
		assert.strictEqual(result.iterations, 2);
		assert.strictEqual(result.steps.length, 2);
		assert.deepStrictEqual(result.steps.map(step => step.iteration), [0, 1]);
	});

	test('iterations repeat the flow without data', async () => {
		const { sent, run } = fixture();
		await run(flow({ settings: { iterations: 3 }, steps: [inline('Ping', 'https://x/ping')] }));
		assert.strictEqual(sent.length, 3);
	});

	test('cancellation stops the run and skips what is left', async () => {
		const source = new CancellationTokenSource();
		const { sent, run } = fixture(name => {
			if (name === 'A') {
				source.cancel();
			}
			return { status: 200 };
		});
		const result = await run(flow({ steps: [inline('A', 'https://x/a'), inline('B', 'https://x/b'), { kind: 'delay', ms: 1000 }] }), { token: source.token });
		source.dispose();
		assert.deepStrictEqual(sent.map(item => item.name), ['A']);
		assert.strictEqual(result.state, 'stopped');
		assert.deepStrictEqual(statuses(result).slice(1), ['B:skipped', 'Wait 1000 ms:skipped']);
	});

	test('a send without a response is an error', async () => {
		const { run } = fixture(() => ({ error: 'connect ECONNREFUSED' }));
		const result = await run(flow({ steps: [inline('Down', 'https://x/down')] }));
		assert.strictEqual(result.steps[0].status, 'error');
		assert.match(result.steps[0].error ?? '', /ECONNREFUSED/);
		assert.strictEqual(result.state, 'failed');
	});

	test('progress is reported while the run goes', async () => {
		const { run } = fixture();
		const seen: string[] = [];
		await run(flow({ steps: [inline('A', 'https://x/a'), inline('B', 'https://x/b')] }), { onProgress: progress => seen.push(progress.steps.map(step => step.status).join(',')) });
		assert.ok(seen.includes('running'));
		assert.ok(seen.includes('passed,running'));
		assert.strictEqual(seen.at(-1), 'passed,passed');
	});

	test('a disabled step is skipped', async () => {
		const { sent, run } = fixture();
		const result = await run(flow({ steps: [inline('A', 'https://x/a', { disabled: true }), inline('B', 'https://x/b')] }));
		assert.deepStrictEqual(sent.map(item => item.name), ['B']);
		assert.deepStrictEqual(statuses(result), ['A:skipped', 'B:passed']);
	});

	test('run only this and run from here', async () => {
		const parsed = flow({ steps: [{ id: 'a', ...inline('A', 'https://x/a') }, { id: 'b', ...inline('B', 'https://x/b') }, { id: 'c', ...inline('C', 'https://x/c') }] });
		const only = fixture();
		await only.run(parsed, { onlyStepId: 'b', seed: { token: 'kept' } });
		assert.deepStrictEqual(only.sent.map(item => item.name), ['B']);
		assert.strictEqual(only.sent[0].variables.token, 'kept');
		const from = fixture();
		await from.run(parsed, { fromStepId: 'b' });
		assert.deepStrictEqual(from.sent.map(item => item.name), ['B', 'C']);
	});

	test('saved requests are sent from their collection', async () => {
		const collection = emptyHttpCollection('Shop', 'postman');
		const folder = emptyHttpFolder('Auth');
		const login = emptyHttpRequest('Login', 'none');
		login.method = 'POST';
		login.url = '{{baseUrl}}/login';
		folder.items.push(login);
		collection.items.push(folder);
		const { sent, run } = fixture(() => ({ status: 200 }), collection);
		const ref = httpFlowRefFor(FLOW_FILE, ROOT, COLLECTION, collection, login.id);
		assert.deepStrictEqual(ref, { collection: 'http/Shop.postman_collection.json', path: ['Auth', 'Login'] });
		const result = await run(flow({ steps: [{ kind: 'request', ref }, { kind: 'request', ref: { collection: 'Shop', path: ['Login'] } }, { kind: 'request', ref: { collection: 'Shop', path: ['Nope'] } }] }));
		assert.deepStrictEqual(sent.map(item => `${item.name} ${item.collection}`), [`Login ${COLLECTION.toString()}`, `Login ${COLLECTION.toString()}`]);
		assert.strictEqual(result.steps[0].requestId, login.id);
		assert.strictEqual(result.steps[2].status, 'error');
		assert.match(result.steps[2].error ?? '', /"Nope" is not in/);
	});

	test('a ref to a collection that is not there says so', async () => {
		const { collections } = { collections: { load: async () => undefined, collections: async () => [] } };
		const resolved = await resolveHttpFlowRef(collections, { collection: 'http/Gone.postman_collection.json', path: ['X'] }, FLOW_FILE, ROOT);
		assert.strictEqual(typeof resolved, 'string');
		assert.match(resolved as string, /was not found/);
	});
});
