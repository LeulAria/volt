/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	describeHttpFlow, duplicateHttpFlowStep, evaluateHttpFlowAssert, extractHttpFlowValue, fillHttpFlowVariables, findHttpFlowStep, httpFlowHtml, httpFlowInlineRequest, httpFlowJUnit, httpFlowMarkdown, httpFlowReportJson, httpFlowRunSummary, httpFlowRunText,
	httpFlowGenerationPrompt, httpFlowStepLabel, httpFlowStepsOf, httpFlowTotals, httpJsonPath, IHttpFlowAssert, IHttpFlowRequestStep, IHttpFlowResponse, IHttpFlowRun, IHttpFlowStepRun, inferHttpJsonSchema, listHttpJsonPaths, moveHttpFlowStep, parseHttpFlow, parseHttpFlowCsv,
	parseHttpFlowData, readHttpJsonPath, removeHttpFlowStep, serializeHttpFlow, validateHttpFlow, validateHttpJsonSchema,
} from '../../common/httpAutomation.js';

const BODY = {
	user: { id: 41, name: 'Ada', roles: ['admin', 'dev'], active: true, manager: null },
	items: [{ id: 1, price: 9.5, tags: ['a'] }, { id: 2, price: 20, tags: [] }],
	'odd key': 'x',
	token: 'abc.def',
};

function response(body: unknown = BODY, extra: Partial<IHttpFlowResponse> = {}): IHttpFlowResponse {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': 'r-7', 'set-cookie': 'sid=s1; Path=/; Expires=Wed, 01 Jan 2030 00:00:00 GMT, theme=dark; Path=/' }, body: text, durationMs: 120, size: text.length, ...extra };
}

function check(assertion: IHttpFlowAssert, variables: Record<string, string> = {}, from: IHttpFlowResponse | null = response()) {
	return evaluateHttpFlowAssert(assertion, { ...(from ? { response: from } : {}), variables });
}

const FLOW = {
	volt: 'flow',
	version: 1,
	name: 'Checkout',
	description: 'Buys one thing',
	environment: 'staging',
	variables: [{ key: 'email', value: 'qa@example.com', enabled: true }, { key: 'off', value: '1', enabled: false }],
	settings: { iterations: 2, delayMs: 50, stopOnFailure: false, timeoutMs: 8000, persistVariables: true },
	data: { rows: [{ sku: 'A1', qty: '2' }] },
	steps: [
		{
			id: 'setup', kind: 'group', name: 'Sign in', role: 'setup', steps: [
				{
					id: 'login', kind: 'request', name: 'Log in', ref: { collection: 'http/Shop.postman_collection.json', path: ['Auth', 'Log in'] },
					variables: [{ key: 'password', value: 'secret', enabled: true }],
					extract: [{ name: 'token', from: 'json', path: '$.token' }, { name: 'session', from: 'cookie', path: 'sid', default: 'none' }, { name: 'build', from: 'regex', pattern: 'build-(\\d+)' }],
					assert: [{ target: 'status', op: 'equals', value: 200 }, { target: 'json', path: '$.user.id', op: 'type', value: 'integer' }],
					retry: { times: 3, delayMs: 200, backoff: 2, until: { target: 'status', op: 'equals', value: 200 } },
					timeoutMs: 3000, continueOnFailure: true, runScripts: false,
				},
			],
		},
		{ id: 'wait', kind: 'delay', ms: 250 },
		{ id: 'vars', kind: 'set', variables: [{ key: 'orderUrl', value: '{{baseUrl}}/orders', enabled: true }] },
		{ id: 'order', kind: 'request', disabled: true, inline: { method: 'POST', url: '{{orderUrl}}', headers: [{ key: 'Accept', value: 'application/json', enabled: true }], bodyType: 'json', body: '{"sku":"{{sku}}"}' } },
		{ id: 'maybe', kind: 'condition', if: { target: 'variable', path: 'token', op: 'exists' }, steps: [{ id: 'inner', kind: 'delay', ms: 1 }] },
		{ id: 'loop', kind: 'repeat', forEach: 'ids', as: 'id', until: { target: 'status', op: 'equals', value: 204 }, max: 5, steps: [] },
		{ id: 'times', kind: 'repeat', times: 3, max: 100, steps: [] },
		{ id: 'bye', kind: 'group', role: 'teardown', steps: [] },
	],
};

suite('Volt Client: automation flows', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// --- The file ----------------------------------------------------------------------------------

	test('a flow written by this client reads back the same and is written the same again', () => {
		const text = `${JSON.stringify(FLOW, null, 2)}\n`;
		const parsed = parseHttpFlow(text);
		assert.deepStrictEqual(parsed.problems, []);
		assert.ok(parsed.flow);
		assert.strictEqual(serializeHttpFlow(parsed.flow), text);
		assert.strictEqual(serializeHttpFlow(parseHttpFlow(serializeHttpFlow(parsed.flow)).flow!), text);
		assert.deepStrictEqual(httpFlowStepsOf(parsed.flow.steps).map(step => step.id), ['setup', 'login', 'wait', 'vars', 'order', 'maybe', 'inner', 'loop', 'times', 'bye']);
		const login = findHttpFlowStep(parsed.flow, 'login')!.step as IHttpFlowRequestStep;
		assert.deepStrictEqual(login.extract[2], { name: 'build', from: 'regex', path: 'build-(\\d+)' });
		assert.deepStrictEqual(login.retry, { times: 3, delayMs: 200, backoff: 2, until: { target: 'status', op: 'equals', value: 200 } });
	});

	test('a flow written by hand is read tolerantly: no ids, shorthands, aliases, objects for rows and bodies', () => {
		const parsed = parseHttpFlow({
			name: 'By hand',
			variables: { baseUrl: 'http://api.test', retries: 3 },
			steps: [
				{ name: 'Create', request: { method: 'post', url: '{{baseUrl}}/users', headers: { Accept: 'application/json' }, query: { dry: 'true' }, body: { name: 'Ada' } }, assert: { target: 'statusCode', operator: 'eq', expected: 201 }, extract: [{ variable: 'userId', path: '$.id' }] },
				{ ref: { collection: 'Shop', path: 'Users / Get user' }, asserts: [{ path: '$.name', value: 'Ada' }, { target: 'body', op: 'includes', value: 'Ada' }, { path: '$.id' }, { target: 'time', op: '<', value: 500 }] },
				{ ms: 10 },
				{ kind: 'wait', ms: 20 },
				{ type: 'loop', times: 2, steps: [{ kind: 'set', variables: { n: '{{itemIndex}}' } }] },
				{ if: { target: 'var', path: 'userId', op: 'exists' }, then: [{ ms: 1 }] },
				{ id: 's1', ms: 5 },
				{ id: 's1', ms: 6 },
			],
		});
		assert.deepStrictEqual(parsed.problems, []);
		const flow = parsed.flow!;
		assert.deepStrictEqual(flow.settings, { iterations: 1, delayMs: 0, stopOnFailure: true, timeoutMs: 0, persistVariables: false });
		assert.deepStrictEqual(flow.variables, [{ key: 'baseUrl', value: 'http://api.test', enabled: true }, { key: 'retries', value: '3', enabled: true }]);
		const [create, get, , , loop, condition] = flow.steps;
		assert.strictEqual(create.kind, 'request');
		assert.deepStrictEqual((create as IHttpFlowRequestStep).inline, { method: 'POST', url: '{{baseUrl}}/users?dry=true', headers: [{ key: 'Accept', value: 'application/json', enabled: true }], body: '{\n  "name": "Ada"\n}', bodyType: 'json' });
		assert.deepStrictEqual((create as IHttpFlowRequestStep).assert, [{ target: 'status', op: 'equals', value: 201 }]);
		assert.deepStrictEqual((create as IHttpFlowRequestStep).extract, [{ name: 'userId', from: 'json', path: '$.id' }]);
		assert.deepStrictEqual((get as IHttpFlowRequestStep).ref, { collection: 'Shop', path: ['Users', 'Get user'] });
		assert.deepStrictEqual((get as IHttpFlowRequestStep).assert, [{ target: 'json', path: '$.name', op: 'equals', value: 'Ada' }, { target: 'text', op: 'contains', value: 'Ada' }, { target: 'json', path: '$.id', op: 'exists' }, { target: 'time', op: 'lt', value: 500 }]);
		assert.deepStrictEqual(flow.steps.map(step => step.kind), ['request', 'request', 'delay', 'delay', 'repeat', 'condition', 'delay', 'delay']);
		assert.strictEqual(loop.kind === 'repeat' && loop.steps[0].kind, 'set');
		assert.strictEqual(condition.kind === 'condition' && condition.if.target, 'variable');
		// Ids are given by place, never twice, and the same on a second read.
		const ids = httpFlowStepsOf(flow.steps).map(step => step.id);
		assert.strictEqual(new Set(ids).size, ids.length);
		assert.deepStrictEqual(httpFlowStepsOf(parseHttpFlow(JSON.parse(JSON.stringify({ name: 'By hand', steps: [{ ms: 1 }, { ms: 2 }] }))).flow!.steps).map(step => step.id), ['s1', 's2']);
		assert.ok(ids.includes('s1'));
	});

	test('what is not a flow says why; what a flow has wrong is listed with where it is', () => {
		assert.match(parseHttpFlow('').error!, /empty/);
		assert.match(parseHttpFlow('{ nope').error!, /Not valid JSON/);
		assert.match(parseHttpFlow('[1]').error!, /one JSON object/);
		assert.match(parseHttpFlow('{"volt":"perf","steps":[]}').error!, /"volt" is "perf"/);
		assert.match(parseHttpFlow('{"info":{}}').error!, /neither "volt": "flow" nor a "steps" list/);
		assert.strictEqual(parseHttpFlow('{"volt":"flow"}', 'From file').flow!.name, 'From file');

		const parsed = parseHttpFlow({ volt: 'flow', version: 9, steps: [{ kind: 'teleport' }, 7, { kind: 'request', inline: { url: 'http://x' }, assert: [{ target: 'mood', op: 'equals', value: 1 }, { target: 'status', op: 'resembles', value: 1 }], extract: [{ from: 'json' }, { name: 'a', from: 'dream' }] }] });
		assert.deepStrictEqual(parsed.problems.map(problem => `${problem.severity} ${problem.path}`), ['warning version', 'warning steps[0]', 'warning steps[1]', 'warning steps[2].extract[0]', 'warning steps[2].extract[1]', 'warning steps[2].assert[0]', 'warning steps[2].assert[1]']);
		assert.match(parsed.problems[1].message, /Unknown step kind "teleport"/);
		assert.match(parsed.problems[5].message, /Unknown assertion target "mood"/);
		assert.match(parsed.problems[6].message, /Unknown assertion operator "resembles"/);
		assert.strictEqual(parsed.flow!.steps.length, 1);

		const flow = parseHttpFlow({
			steps: [
				{ id: 'a', kind: 'request' },
				{ id: 'b', kind: 'request', inline: { url: '' } },
				{ id: 'c', kind: 'request', ref: { collection: 'x.http', path: ['Gone'] }, extract: [{ name: '', from: 'json', path: '$.a' }, { name: 'h', from: 'header' }, { name: 'r', from: 'regex', pattern: '(' }, { name: 'j', from: 'json', path: '$.a[' }], assert: [{ target: 'json', op: 'equals', value: 1 }, { target: 'status', op: 'equals' }, { target: 'text', op: 'matches', value: '(' }, { target: 'schema', op: 'schema', value: 'nope' }] },
				{ id: 'd', kind: 'repeat', steps: [] },
				{ id: 'e', kind: 'set', variables: [] },
			],
		}).flow!;
		const problems = validateHttpFlow(flow, () => false);
		assert.deepStrictEqual(problems.map(problem => `${problem.severity} ${problem.path} ${problem.stepId ?? ''}`.trim()), [
			'error steps[0] a', 'error steps[1].inline b', 'error steps[2].ref c',
			'error steps[2].extract[0] c', 'error steps[2].extract[1] c', 'error steps[2].extract[2] c', 'error steps[2].extract[3] c',
			'error steps[2].assert[0] c', 'error steps[2].assert[1] c', 'error steps[2].assert[2] c', 'error steps[2].assert[3] c',
			'error steps[3] d', 'warning steps[3].steps d', 'warning steps[4] e',
		]);
		assert.match(problems[2].message, /"Gone" was not found in x\.http/);
		assert.deepStrictEqual(validateHttpFlow(parseHttpFlow(FLOW).flow!, () => true).filter(problem => problem.severity === 'error'), []);
		assert.match(validateHttpFlow(parseHttpFlow({ steps: [] }).flow!)[0].message, /no request to send/);
	});

	test('steps move, are removed and are copied with new ids', () => {
		const flow = parseHttpFlow(FLOW).flow!;
		assert.strictEqual(moveHttpFlowStep(flow, 'wait', 'setup', 0), true);
		assert.deepStrictEqual(httpFlowStepsOf(flow.steps).slice(0, 3).map(step => step.id), ['setup', 'wait', 'login']);
		assert.strictEqual(moveHttpFlowStep(flow, 'wait', undefined), true);
		assert.strictEqual(flow.steps.at(-1)!.id, 'wait');
		// Later in the same list: the place asked for is the place it ends at.
		assert.strictEqual(moveHttpFlowStep(flow, 'setup', undefined, 2), true);
		assert.deepStrictEqual(flow.steps.slice(0, 2).map(step => step.id), ['vars', 'setup']);
		assert.strictEqual(moveHttpFlowStep(flow, 'setup', 'setup'), false);
		assert.strictEqual(moveHttpFlowStep(flow, 'maybe', 'inner'), false);
		assert.strictEqual(moveHttpFlowStep(flow, 'setup', 'maybe'), true);
		assert.strictEqual(moveHttpFlowStep(flow, 'maybe', 'setup'), false);
		assert.deepStrictEqual(findHttpFlowStep(flow, 'login')!.ancestors.map(step => step.id), ['maybe', 'setup']);
		const copy = duplicateHttpFlowStep(flow, 'maybe')!;
		const copied = httpFlowStepsOf([copy]);
		assert.strictEqual(copied.length, 4);
		assert.ok(copied.every(step => !['maybe', 'inner', 'setup', 'login'].includes(step.id)));
		assert.strictEqual(flow.steps[flow.steps.findIndex(step => step.id === 'maybe') + 1], copy);
		assert.strictEqual(removeHttpFlowStep(flow, 'maybe')!.id, 'maybe');
		assert.strictEqual(findHttpFlowStep(flow, 'login'), undefined);
		assert.strictEqual(removeHttpFlowStep(flow, 'maybe'), undefined);
	});

	test('a step without a name is called by what it does; an inline request becomes one the client sends', () => {
		const flow = parseHttpFlow({ steps: [{ ref: { collection: 'a.http', path: ['Users', 'Get user'] } }, { inline: { method: 'POST', url: 'https://api.test/v1/orders?x=1' } }, { ms: 30 }, { kind: 'set', variables: { a: '1', b: '2' } }, { kind: 'group', role: 'teardown', steps: [] }, { kind: 'repeat', times: 4, steps: [] }, { kind: 'condition', if: { target: 'status', op: 'equals', value: 200 }, steps: [] }, { name: 'Named', ms: 1 }, { inline: { method: 'POST', url: 'http://x', bodyType: 'form', body: { a: 1, b: 'two' } } }] }).flow!;
		assert.deepStrictEqual(flow.steps.map(httpFlowStepLabel), ['Get user', 'POST /v1/orders', 'Wait 30 ms', 'Set a, b', 'Teardown', 'Repeat 4 times', 'If status equals 200', 'Named', 'POST http://x']);
		const request = httpFlowInlineRequest(flow.steps[8] as IHttpFlowRequestStep);
		assert.strictEqual(request.id, flow.steps[8].id);
		assert.strictEqual(request.body.mode, 'urlencoded');
		assert.deepStrictEqual(request.body.urlencoded, [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: 'two', enabled: true }]);
		const json = httpFlowInlineRequest(parseHttpFlow({ steps: [{ inline: { method: 'PUT', url: 'http://x', headers: [{ key: 'X-A', value: '1' }], body: '{"a":1}' } }] }).flow!.steps[0] as IHttpFlowRequestStep);
		assert.deepStrictEqual([json.method, json.body.mode, json.body.language, json.body.raw, json.headers.length, json.auth.type], ['PUT', 'raw', 'json', '{"a":1}', 1, 'none']);
		assert.match(describeHttpFlow(parseHttpFlow(FLOW).flow!), /- Log in \[http\/Shop\.postman_collection\.json > Auth \/ Log in \| status equals 200; \$\.user\.id is of type integer \| extracts token, session, build\]/);
	});

	// --- JSONPath ----------------------------------------------------------------------------------

	test('JSONPath: children, indexes, wildcards and descent', () => {
		assert.deepStrictEqual(httpJsonPath(BODY, '$.user.id'), [41]);
		assert.deepStrictEqual(httpJsonPath(BODY, 'user.name'), ['Ada']);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.items[1].price'), [20]);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.items[-1].id'), [2]);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.items.0.id'), [1]);
		assert.deepStrictEqual(httpJsonPath(BODY, `$['odd key']`), ['x']);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.items[*].id'), [1, 2]);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.items.*.price'), [9.5, 20]);
		assert.deepStrictEqual(httpJsonPath(BODY, '$..id'), [41, 1, 2]);
		assert.deepStrictEqual(httpJsonPath(BODY, '$..tags[0]'), ['a']);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.user.manager'), [null]);
		assert.deepStrictEqual(httpJsonPath(BODY, '$'), [BODY]);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.user.missing.deeper'), []);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.items[9]'), []);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.items['), []);
		assert.deepStrictEqual(httpJsonPath(BODY, '$.user..'), []);
		assert.deepStrictEqual(readHttpJsonPath(BODY, '$.user.manager'), { found: true, value: null });
		assert.deepStrictEqual(readHttpJsonPath(BODY, '$.nope'), { found: false, value: undefined });
		assert.deepStrictEqual(readHttpJsonPath(BODY, '$.items[*].id'), { found: true, value: [1, 2] });
		assert.deepStrictEqual(readHttpJsonPath(BODY, '$..nope'), { found: false, value: [] });
		assert.deepStrictEqual(listHttpJsonPaths({ a: 1, b: { c: 'x' }, list: [{ id: 7 }], 'odd key': true }), [{ path: '$.a', preview: '1' }, { path: '$.b.c', preview: 'x' }, { path: '$.list', preview: '[1]' }, { path: '$.list[0].id', preview: '7' }, { path: `$['odd key']`, preview: 'true' }]);
	});

	// --- Extraction --------------------------------------------------------------------------------

	test('values are taken from the body, headers, cookies, the status and the time', () => {
		const from = response({ ...BODY, note: 'build-482 ok' });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'id', from: 'json', path: '$.user.id' }, from), { name: 'id', value: '41', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'roles', from: 'json', path: '$.user.roles' }, from), { name: 'roles', value: '["admin","dev"]', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'ids', from: 'json', path: '$.items[*].id' }, from), { name: 'ids', value: '[1,2]', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'token', from: 'json', path: '$.token' }, from), { name: 'token', value: 'abc.def', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'rid', from: 'header', path: 'x-request-id' }, from), { name: 'rid', value: 'r-7', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'sid', from: 'cookie', path: 'sid' }, from), { name: 'sid', value: 's1', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'theme', from: 'cookie', path: 'theme' }, from), { name: 'theme', value: 'dark', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 's', from: 'status' }, from), { name: 's', value: '200', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 't', from: 'time' }, from), { name: 't', value: '120', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'build', from: 'regex', path: 'build-(\\d+)' }, from), { name: 'build', value: '482', found: true });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'word', from: 'regex', path: '/BUILD-\\d+/i' }, from), { name: 'word', value: 'build-482', found: true });
		assert.strictEqual(extractHttpFlowValue({ name: 'all', from: 'text' }, response('plain')).value, 'plain');
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'x', from: 'json', path: '$.nope' }, from), { name: 'x', found: false, error: 'the response has no $.nope' });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'x', from: 'json', path: '$.nope', default: 'd' }, from), { name: 'x', value: 'd', found: false, error: 'the response has no $.nope' });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'x', from: 'json', path: '$.a' }, response('<html>')), { name: 'x', found: false, error: 'the response body is not JSON' });
		assert.deepStrictEqual(extractHttpFlowValue({ name: 'x', from: 'cookie', path: 'nope' }, from), { name: 'x', found: false, error: 'the response has no cookie nope' });
		assert.match(extractHttpFlowValue({ name: 'x', from: 'regex', path: '(' }, from).error!, /not a valid regular expression/);
		assert.strictEqual(fillHttpFlowVariables('{{base}}/users/{{ id }}?q={{missing}}', { base: 'http://x', id: '7' }), 'http://x/users/7?q={{missing}}');
	});

	// --- Assertions --------------------------------------------------------------------------------

	test('equals and notEquals, with messages that say what was expected and what came', () => {
		assert.deepStrictEqual(check({ target: 'json', path: '$.user.id', op: 'equals', value: 42 }), { label: '$.user.id equals 42', passed: false, message: 'expected $.user.id to equal 42, got 41', expected: '42', actual: '41' });
		assert.deepStrictEqual(check({ target: 'json', path: '$.user.id', op: 'equals', value: 41 }), { label: '$.user.id equals 41', passed: true, message: '$.user.id equals 41' });
		// A value typed as text, and one that comes from a variable, compare as what they are compared with.
		assert.strictEqual(check({ target: 'json', path: '$.user.id', op: 'equals', value: '41' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.id', op: 'equals', value: '{{id}}' }, { id: '41' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.id', op: 'equals', value: '{{id}}' }, { id: '40' }).message, 'expected $.user.id to equal 40, got 41');
		assert.strictEqual(check({ target: 'json', path: '$.user.active', op: 'equals', value: 'true' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.roles', op: 'equals', value: ['admin', 'dev'] }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.roles', op: 'equals', value: '["admin","dev"]' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.name', op: 'equals', value: 'Bob' }).message, 'expected $.user.name to equal "Bob", got "Ada"');
		assert.strictEqual(check({ target: 'json', path: '$.nope', op: 'equals', value: 1 }).message, 'expected $.nope to equal 1, got nothing');
		assert.strictEqual(check({ target: 'status', op: 'equals', value: 201 }).message, 'expected status to equal 201, got 200');
		assert.strictEqual(check({ target: 'status', op: 'notEquals', value: 500 }).passed, true);
		assert.strictEqual(check({ target: 'status', op: 'notEquals', value: 200 }).message, 'expected status not to equal 200, got 200');
		assert.strictEqual(check({ target: 'header', path: 'x-request-id', op: 'equals', value: 'r-7' }).passed, true);
		assert.strictEqual(check({ target: 'header', path: 'X-Nope', op: 'equals', value: 'a' }).message, 'expected header X-Nope to equal "a", got nothing');
		assert.strictEqual(check({ target: 'variable', path: 'env', op: 'equals', value: 'prod' }, { env: 'prod' }).passed, true);
		assert.strictEqual(check({ target: 'variable', path: 'env', op: 'equals', value: 'prod' }, { env: 'dev' }).message, 'expected {{env}} to equal "prod", got "dev"');
		assert.strictEqual(check({ target: 'variable', path: '{{count}}', op: 'equals', value: 3 }, { count: '3' }).passed, true);
	});

	test('contains, matches, exists and the comparisons', () => {
		assert.strictEqual(check({ target: 'text', op: 'contains', value: '"name":"Ada"' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.roles', op: 'contains', value: 'dev' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.roles', op: 'contains', value: 'ops' }).message, 'expected $.user.roles to contain "ops", got ["admin","dev"]');
		assert.strictEqual(check({ target: 'json', path: '$.user', op: 'contains', value: 'name' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.items[*].id', op: 'contains', value: 2 }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.roles', op: 'notContains', value: 'ops' }).passed, true);
		assert.strictEqual(check({ target: 'text', op: 'notContains', value: 'Ada' }).passed, false);
		assert.strictEqual(check({ target: 'contentType', op: 'contains', value: 'application/json' }).passed, true);
		assert.strictEqual(check({ target: 'contentType', op: 'contains', value: 'xml' }).message, 'expected content type to contain "xml", got "application/json; charset=utf-8"');

		assert.strictEqual(check({ target: 'json', path: '$.token', op: 'matches', value: '^[a-z]+\\.[a-z]+$' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.name', op: 'matches', value: '/^ada$/i' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.name', op: 'matches', value: '^B' }).message, 'expected $.user.name to match "^B", got "Ada"');
		assert.match(check({ target: 'text', op: 'matches', value: '(' }).message, /not a valid regular expression/);

		assert.strictEqual(check({ target: 'json', path: '$.user.manager', op: 'exists' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.boss', op: 'exists' }).message, 'expected $.user.boss to exist, but it does not');
		assert.strictEqual(check({ target: 'json', path: '$.user.boss', op: 'notExists' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.id', op: 'notExists' }).message, 'expected $.user.id not to exist, got 41');
		assert.strictEqual(check({ target: 'header', path: 'X-Request-Id', op: 'exists' }).passed, true);
		assert.strictEqual(check({ target: 'variable', path: 'token', op: 'exists' }).passed, false);
		assert.strictEqual(check({ target: 'variable', path: 'token', op: 'notExists' }, {}, null).passed, true);

		assert.strictEqual(check({ target: 'time', op: 'lt', value: 500 }).passed, true);
		assert.strictEqual(check({ target: 'time', op: 'lt', value: 100 }).message, 'expected response time to be below 100, got 120');
		assert.strictEqual(check({ target: 'time', op: 'lte', value: 120 }).passed, true);
		assert.strictEqual(check({ target: 'status', op: 'gte', value: 200 }).passed, true);
		assert.strictEqual(check({ target: 'status', op: 'gt', value: 200 }).message, 'expected status to be above 200, got 200');
		assert.strictEqual(check({ target: 'size', op: 'gt', value: 10 }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.items[0].price', op: 'gt', value: '{{min}}' }, { min: '9' }).passed, true);
		assert.strictEqual(check({ target: 'variable', path: 'count', op: 'gte', value: 3 }, { count: '3' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user.name', op: 'gt', value: 3 }).passed, false);
		assert.match(check({ target: 'status', op: 'gt', value: 'many' }).message, /the value to compare with is "many"/);
	});

	test('in, type, length and schema', () => {
		assert.strictEqual(check({ target: 'status', op: 'in', value: [200, 201] }).passed, true);
		assert.strictEqual(check({ target: 'status', op: 'in', value: '200, 204' }).passed, true);
		assert.strictEqual(check({ target: 'status', op: 'in', value: '[201,204]' }).message, 'expected status to be one of [201,204], got 200');
		assert.strictEqual(check({ target: 'json', path: '$.user.name', op: 'in', value: ['Ada', 'Bob'] }).passed, true);

		for (const [path, type] of [['$.user.id', 'integer'], ['$.user.id', 'number'], ['$.items[0].price', 'number'], ['$.user.name', 'string'], ['$.user.active', 'boolean'], ['$.user', 'object'], ['$.items', 'array'], ['$.user.manager', 'null']]) {
			assert.strictEqual(check({ target: 'json', path, op: 'type', value: type }).passed, true, `${path} ${type}`);
		}
		assert.strictEqual(check({ target: 'json', path: '$.items[0].price', op: 'type', value: 'integer' }).message, 'expected $.items[0].price to be of type integer, got number (9.5)');
		assert.strictEqual(check({ target: 'json', path: '$.nope', op: 'type', value: 'string' }).message, 'expected $.nope to be of type string, got undefined');

		assert.strictEqual(check({ target: 'json', path: '$.items', op: 'length', value: 2 }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.items', op: 'length', value: '>0' }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.items', op: 'length', value: '<= 1' }).message, 'expected $.items to have length <=1, got 2');
		assert.strictEqual(check({ target: 'json', path: '$.user.name', op: 'length', value: 3 }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user', op: 'length', value: 5 }).passed, true);
		assert.match(check({ target: 'json', path: '$.user.id', op: 'length', value: 1 }).message, /which has no length/);
		assert.match(check({ target: 'json', path: '$.items', op: 'length', value: 'some' }).message, /not a number/);

		const schema = { type: 'object', required: ['user', 'items'], properties: { user: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string', minLength: 2 } } }, items: { type: 'array', items: { type: 'object', properties: { price: { type: 'number', minimum: 0 } } } } } };
		assert.strictEqual(check({ target: 'schema', op: 'schema', value: schema }).passed, true);
		assert.strictEqual(check({ target: 'json', path: '$.user', op: 'schema', value: JSON.stringify(schema.properties.user) }).passed, true);
		assert.strictEqual(check({ target: 'schema', op: 'schema', value: { type: 'object', required: ['total'], properties: { user: { properties: { id: { type: 'string' } } } } } }).message, 'expected body to match the schema: $: missing required property "total"; $.user.id: expected string, got number');
		assert.match(check({ target: 'schema', op: 'schema', value: 7 }).message, /no JSON Schema object/);
		assert.match(check({ target: 'json', path: '$.nope', op: 'schema', value: {} }).message, /does not exist/);
	});

	test('an assertion on a response that is not there, or not JSON, fails with the reason', () => {
		assert.strictEqual(check({ target: 'status', op: 'equals', value: 200 }, {}, null).message, 'expected status to equal 200, but there is no response');
		assert.strictEqual(check({ target: 'json', path: '$.a', op: 'exists' }, {}, response('<html>')).message, 'expected $.a to exist, but the response body is not JSON');
		assert.strictEqual(check({ target: 'json', path: '$.a', op: 'notExists' }, {}, response('<html>')).passed, true);
		assert.strictEqual(check({ target: 'text', op: 'contains', value: '<html' }, {}, response('<html>')).passed, true);
	});

	// --- Schema ------------------------------------------------------------------------------------

	test('the JSON Schema check covers the everyday keywords', () => {
		const schema = {
			type: 'object', required: ['id', 'email'], additionalProperties: false,
			properties: {
				id: { type: 'integer', minimum: 1, maximum: 10 }, email: { type: 'string', pattern: '^\\S+@\\S+$', minLength: 5, maxLength: 12 }, kind: { enum: ['a', 'b'] }, fixed: { const: 1 },
				tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: ['string', 'null'] } },
			},
		};
		assert.deepStrictEqual(validateHttpJsonSchema({ id: 3, email: 'a@b.io', kind: 'a', fixed: 1, tags: ['x', null] }, schema), []);
		assert.deepStrictEqual(validateHttpJsonSchema({ id: 0, email: 'nope', kind: 'c', fixed: 2, tags: [], extra: 1 }, schema), [
			'$.id: expected at least 1, got 0',
			'$.email: expected at least 5 characters, got 4',
			'$.email: expected text matching ^\\S+@\\S+$, got "nope"',
			'$.kind: expected one of ["a","b"], got "c"',
			'$.fixed: expected 1, got 2',
			'$.tags: expected at least 1 items, got 0',
			'$: unexpected property "extra"',
		]);
		assert.deepStrictEqual(validateHttpJsonSchema({ id: 11, email: 'much.too.long@example.com', tags: ['a', 'b', 3] }, schema), ['$.id: expected at most 10, got 11', '$.email: expected at most 12 characters, got 25', '$.tags: expected at most 2 items, got 3', '$.tags[2]: expected string or null, got number']);
		assert.deepStrictEqual(validateHttpJsonSchema({ id: 1.5 }, schema), ['$: missing required property "email"', '$.id: expected integer, got a number that is not whole']);
		assert.deepStrictEqual(validateHttpJsonSchema('x', { type: 'object' }), ['$: expected object, got string']);
		assert.deepStrictEqual(validateHttpJsonSchema([1], { type: 'object' }), ['$: expected object, got array']);
		const inferred = inferHttpJsonSchema(BODY);
		assert.deepStrictEqual(validateHttpJsonSchema(BODY, inferred), []);
		assert.deepStrictEqual(inferred.required, ['user', 'items', 'odd key', 'token']);
		assert.deepStrictEqual(validateHttpJsonSchema({ ...BODY, token: 5 }, inferred), ['$.token: expected string, got number']);
	});

	// --- Data --------------------------------------------------------------------------------------

	test('data rows come from CSV (quoted fields, other separators) and from JSON', () => {
		assert.deepStrictEqual(parseHttpFlowCsv('email,name,note\r\na@x.io,"Ada, the first","said ""hi"""\r\n\r\nb@x.io,Bob\n'), [{ email: 'a@x.io', name: 'Ada, the first', note: 'said "hi"' }, { email: 'b@x.io', name: 'Bob', note: '' }]);
		assert.deepStrictEqual(parseHttpFlowCsv('a;b\n1;"two\nlines"'), [{ a: '1', b: 'two\nlines' }]);
		assert.deepStrictEqual(parseHttpFlowCsv('a\tb\n1\t2'), [{ a: '1', b: '2' }]);
		assert.deepStrictEqual(parseHttpFlowCsv(String.fromCharCode(0xFEFF) + 'a,b\n,\n1,'), [{ a: '1', b: '' }]);
		assert.deepStrictEqual(parseHttpFlowCsv(''), []);
		assert.deepStrictEqual(parseHttpFlowCsv('only,head'), []);
		assert.deepStrictEqual(parseHttpFlowData('[{"id":1,"tags":["a"],"ok":true},{"id":2}]', 'rows.json'), { rows: [{ id: '1', tags: '["a"]', ok: 'true' }, { id: '2' }] });
		assert.deepStrictEqual(parseHttpFlowData('{"rows":[{"a":"x"}]}'), { rows: [{ a: 'x' }] });
		assert.deepStrictEqual(parseHttpFlowData('id,name\n1,Ada', 'rows.csv'), { rows: [{ id: '1', name: 'Ada' }] });
		assert.match(parseHttpFlowData('{"a":1}', 'rows.json').error!, /not a JSON list/);
	});

	// --- Reports -----------------------------------------------------------------------------------

	function sampleRun(): IHttpFlowRun {
		const step = (key: string, kind: IHttpFlowStepRun['kind'], name: string, status: IHttpFlowStepRun['status'], extra: Partial<IHttpFlowStepRun> = {}): IHttpFlowStepRun => ({ key, stepId: key, depth: 0, kind, name, iteration: 0, status, attempts: kind === 'request' && status !== 'skipped' ? 1 : 0, durationMs: 0, asserts: [], extracted: [], ...extra });
		const steps: IHttpFlowStepRun[] = [
			step('g', 'group', 'Sign in', 'failed'),
			step('login', 'request', 'Log in', 'passed', {
				parentKey: 'g', depth: 1, durationMs: 80, method: 'POST', url: 'http://api.test/login', statusCode: 200, attempts: 2,
				asserts: [{ label: 'status equals 200', passed: true, message: 'status equals 200' }], extracted: [{ name: 'token', value: 'abc', found: true }],
				exchange: { method: 'POST', url: 'http://api.test/login', headers: [['Authorization', 'Basic c2VjcmV0'], ['Accept', 'application/json']], body: '{"user":"qa"}', response: { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'set-cookie': 'sid=topsecret' }, body: '{"token":"abc"}', durationMs: 80, size: 15 } },
			}),
			step('me', 'request', 'Get <me> & "you"', 'failed', {
				parentKey: 'g', depth: 1, durationMs: 1500, method: 'GET', url: 'http://api.test/me', statusCode: 500,
				asserts: [{ label: 'status equals 200', passed: false, message: 'expected status to equal 200, got 500', expected: '200', actual: '500' }, { label: '$.id exists', passed: true, message: '$.id exists' }],
				extracted: [{ name: 'userId', found: false, error: 'the response has no $.id' }],
				exchange: { method: 'GET', url: 'http://api.test/me', headers: [], response: { status: 500, statusText: 'Server Error', headers: {}, body: '<b>boom</b>', durationMs: 1500, size: 11 } },
			}),
			step('down', 'request', 'Down', 'error', { error: 'connect ECONNREFUSED', method: 'GET', url: 'http://api.test/down' }),
			step('wait', 'delay', 'Wait 10 ms', 'passed', { durationMs: 10 }),
			step('later', 'request', 'Later', 'skipped', { error: 'an earlier step failed' }),
		];
		return { id: 'r1', flowName: 'Checkout', startedAt: Date.UTC(2026, 0, 2, 3, 4, 5), durationMs: 1700, state: 'failed', environment: 'staging', iterations: 1, iteration: 0, steps, totals: httpFlowTotals(steps), variables: { token: 'abc' } };
	}

	test('totals count the steps that do something, their assertions and every send', () => {
		const run = sampleRun();
		assert.deepStrictEqual(run.totals, { steps: 5, passed: 2, failed: 1, skipped: 1, errors: 1, requests: 4, asserts: 3, assertsFailed: 1 });
		assert.deepStrictEqual(httpFlowRunSummary(run), { at: run.startedAt, durationMs: 1700, state: 'failed', passed: 2, failed: 2, skipped: 1, total: 5 });
		// A loop that gave up fails on its own.
		assert.deepStrictEqual(httpFlowTotals([{ key: 'l', stepId: 'l', depth: 0, kind: 'repeat', name: 'Loop', iteration: 0, status: 'failed', attempts: 3, durationMs: 0, asserts: [], extracted: [], error: 'Gave up after 3 rounds' }]).failed, 1);
	});

	test('JUnit XML: a suite per group, a case per assertion, failures, errors and skips escaped', () => {
		const junit = httpFlowJUnit(sampleRun());
		assert.strictEqual(junit, [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<testsuites name="Checkout" tests="7" failures="2" errors="1" skipped="1" time="1.590">',
			'  <testsuite name="Checkout / Sign in" tests="4" failures="2" errors="0" skipped="0" time="1.580" timestamp="2026-01-02T03:04:05.000Z">',
			'    <testcase name="Log in: status equals 200" classname="Checkout / Sign in" time="0.080"/>',
			'    <testcase name="Get &lt;me&gt; &amp; &quot;you&quot;: status equals 200" classname="Checkout / Sign in" time="1.500">',
			'      <failure message="expected status to equal 200, got 500">expected status to equal 200, got 500</failure>',
			'    </testcase>',
			'    <testcase name="Get &lt;me&gt; &amp; &quot;you&quot;: $.id exists" classname="Checkout / Sign in" time="0.000"/>',
			'    <testcase name="Get &lt;me&gt; &amp; &quot;you&quot;: extract userId" classname="Checkout / Sign in" time="0.000">',
			'      <failure message="the response has no $.id">the response has no $.id</failure>',
			'    </testcase>',
			'  </testsuite>',
			'  <testsuite name="Checkout" tests="3" failures="0" errors="1" skipped="1" time="0.010" timestamp="2026-01-02T03:04:05.000Z">',
			'    <testcase name="Down" classname="Checkout" time="0.000">',
			'      <error message="connect ECONNREFUSED">connect ECONNREFUSED</error>',
			'    </testcase>',
			'    <testcase name="Wait 10 ms" classname="Checkout" time="0.010"/>',
			'    <testcase name="Later" classname="Checkout" time="0.000">',
			'      <skipped message="an earlier step failed"/>',
			'    </testcase>',
			'  </testsuite>',
			'</testsuites>',
			'',
		].join('\n'));
	});

	test('the JSON, Markdown, HTML and text reports say what failed and hide secrets', () => {
		const run = sampleRun();
		const json = JSON.parse(httpFlowReportJson(run));
		assert.deepStrictEqual([json.flow, json.state, json.environment, json.totals.failed, json.steps.length], ['Checkout', 'failed', 'staging', 1, 6]);
		assert.deepStrictEqual(json.steps[1].request.headers, { Authorization: '(hidden)', Accept: 'application/json' });
		assert.strictEqual(json.steps[1].response.headers['set-cookie'], '(hidden)');
		assert.strictEqual(json.steps[1].parent, 'g');
		assert.deepStrictEqual(json.steps[2].asserts[0], { label: 'status equals 200', passed: false, message: 'expected status to equal 200, got 500', expected: '200', actual: '500' });

		const markdown = httpFlowMarkdown(run);
		assert.match(markdown, /^# Checkout\n\n\*\*Failed\*\* on 2026-01-02T03:04:05\.000Z\n/);
		assert.match(markdown, /- Steps: 2 passed, 1 failed, 1 errors, 1 skipped \(of 5\)/);
		assert.match(markdown, /\| FAIL \| &nbsp;&nbsp;Get <me> & "you" \| 500 \| 1\.50 s \|  \|/);
		assert.match(markdown, /\| PASS \| &nbsp;&nbsp;Log in \| 200 \| 80 ms \| 2 \|/);
		assert.match(markdown, /### Sign in \/ Get <me> & "you"\n\n`GET http:\/\/api\.test\/me` returned 500\n\n- expected status to equal 200, got 500\n- could not extract userId: the response has no \$\.id/);
		assert.match(markdown, /### Down\n\n`GET http:\/\/api\.test\/down`\n\n- connect ECONNREFUSED/);

		const page = httpFlowHtml(run);
		assert.match(page, /^<!DOCTYPE html>/);
		assert.ok(!/<script/i.test(page));
		assert.ok(page.includes('Get &lt;me&gt; &amp; &quot;you&quot;'));
		assert.ok(page.includes('&lt;b&gt;boom&lt;/b&gt;'));
		assert.ok(!page.includes('<b>boom</b>'));
		assert.ok(!page.includes('c2VjcmV0') && !page.includes('topsecret'));
		assert.ok(page.includes('<li class="bad">expected status to equal 200, got 500</li>'));
		assert.ok(page.includes('<details open>'));

		const text = httpFlowRunText(run);
		assert.strictEqual(text.split('\n')[0], 'Checkout: Failed: 2 passed, 1 failed, 1 errors, 1 skipped of 5 steps; 2/3 assertions; 4 requests in 1.70 s; environment staging');
		assert.ok(text.includes('  [passed] Log in (POST http://api.test/login) - 200, 80 ms, 2 attempts\n    token = abc'));
		assert.ok(text.includes('  [failed] Get <me> & "you" (GET http://api.test/me) - 500, 1.50 s\n    failed: expected status to equal 200, got 500\n    userId: the response has no $.id\n    response: <b>boom</b>'));
		assert.ok(text.includes('[error] Down (GET http://api.test/down)\n  error: connect ECONNREFUSED'));
		assert.ok(text.includes('[skipped] Later\n  skipped: an earlier step failed'));
	});

	test('the generation prompt asks for steps to add, or for the whole flow again', () => {
		const flow = parseHttpFlow(FLOW).flow!;
		const catalog = [{ collection: 'http/Shop.postman_collection.json', name: 'Shop API', requests: [{ path: ['Auth', 'Log in'], method: 'POST', url: '{{baseUrl}}/login', bodyFields: ['email', 'password'] }] }];
		const add = httpFlowGenerationPrompt(catalog, 'log in', flow);
		assert.ok(add.includes('write only the steps to add after them'));
		assert.ok(add.includes(describeHttpFlow(flow)));
		const rewrite = httpFlowGenerationPrompt(catalog, 'log in', flow, 'rewrite');
		assert.ok(rewrite.includes('Write the whole flow again'));
		assert.ok(!rewrite.includes('write only the steps to add'));
		assert.ok(rewrite.includes(describeHttpFlow(flow)));
		const fresh = httpFlowGenerationPrompt(catalog, '', { ...flow, steps: [] }, 'rewrite');
		assert.ok(!fresh.includes('The flow has these steps'));
		assert.ok(fresh.includes('What to test: the main happy path'));
	});
});
