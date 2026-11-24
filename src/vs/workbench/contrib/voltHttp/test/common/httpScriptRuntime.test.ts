/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { httpScriptNames, httpScriptRuntime, httpScriptTestSites, httpScriptWorkerSource, IHttpScriptBreak, IHttpScriptInput, IHttpScriptOutput, IHttpScriptValue } from '../../common/httpScriptRuntime.js';

/**
 * The line an error was thrown from inside `new Function` code is read from V8's stack (`<anonymous>:line:col`),
 * the engine Volt runs on. Bun's engine reports its caller's file and line there, so tests that check those lines
 * run under mocha (`npm run test-node`) and are skipped by `npm run test-volt-bun`.
 */
const testOnV8 = (globalThis as { Bun?: unknown }).Bun ? test.skip : test;

function input(script: string, overrides: Partial<IHttpScriptInput> = {}): IHttpScriptInput {
	return {
		script,
		phase: 'test',
		request: { name: 'Get user', method: 'GET', url: 'https://api.test/users/7?full=1', headers: [['Accept', 'application/json']] },
		response: {
			status: 200,
			statusText: 'OK',
			headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': 'abc' },
			body: JSON.stringify({ id: 7, name: 'Ada', tags: ['a', 'b'], profile: { admin: true } }),
			durationMs: 42,
			size: 64,
		},
		variables: { environment: { host: 'env-host', token: 't0' }, collection: { host: 'col-host', version: 'v1' }, globals: { host: 'global-host', region: 'eu' }, local: {} },
		environmentName: 'staging',
		...overrides,
	};
}

function run(script: string, overrides: Partial<IHttpScriptInput> = {}): IHttpScriptOutput {
	return httpScriptRuntime(input(script, overrides));
}

suite('HTTP client script runtime', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pm.test with expect chains: passes and readable failures', () => {
		const out = run(`
			pm.test('passes', () => {
				const body = pm.response.json();
				pm.expect(body.id).to.equal(7);
				pm.expect(body.id).to.eql(7).and.to.be.a('number');
				pm.expect(body).to.be.an('object').that.has.property('name', 'Ada');
				pm.expect(body).to.have.property('profile').that.deep.equals({ admin: true });
				pm.expect(body.tags).to.be.an('array').with.lengthOf(2);
				pm.expect(body.tags).to.include('a').and.not.include('z');
				pm.expect(body.tags).to.have.members(['b', 'a']);
				pm.expect(body.tags).to.have.length.above(1);
				pm.expect(body).to.have.keys('id', 'name');
				pm.expect(body).to.have.any.keys('nope', 'id');
				pm.expect(body).to.include({ id: 7 });
				pm.expect(body.name).to.match(/^A/).and.to.have.string('da');
				pm.expect(body.id).to.be.above(6).and.below(8).and.within(7, 7).and.at.least(7).and.at.most(7);
				pm.expect(body.id).to.be.oneOf([1, 7]);
				pm.expect(1.05).to.be.closeTo(1, 0.1);
				pm.expect(body.missing).to.be.undefined;
				pm.expect(null).to.be.null;
				pm.expect(body.name).to.exist;
				pm.expect('').to.be.empty;
				pm.expect(body.profile.admin).to.be.true;
				pm.expect(body.id).to.be.ok;
				pm.expect(() => { throw new Error('boom'); }).to.throw('boom');
				pm.expect(() => 1).to.not.throw();
				pm.expect(body.id).to.satisfy(value => value % 7 === 0);
				pm.expect(new Date()).to.be.an.instanceof(Date);
			});
			pm.test('fails', () => { pm.expect(404).to.equal(200); });
			pm.test('fails negated', () => { pm.expect('a').to.not.equal('a'); });
			pm.test('fails with note', () => { pm.expect([1], 'the list').to.have.lengthOf(2); });
			pm.test.skip('later');
		`);
		assert.strictEqual(out.error, undefined);
		assert.deepStrictEqual(out.tests, [
			{ name: 'passes', passed: true },
			{ name: 'fails', passed: false, error: 'expected 404 to equal 200' },
			{ name: 'fails negated', passed: false, error: `expected 'a' to not equal 'a'` },
			{ name: 'fails with note', passed: false, error: 'the list: expected [1] to have a length of 2 but got 1' },
			{ name: 'later', passed: true, skipped: true },
		]);
	});

	test('pm.response helpers', () => {
		const out = run(`
			pm.test('ok', () => {
				pm.response.to.have.status(200);
				pm.response.to.have.status('OK');
				pm.response.to.be.ok;
				pm.response.to.be.success;
				pm.response.to.not.be.error;
				pm.response.to.not.be.notFound;
				pm.response.to.have.header('content-type');
				pm.response.to.have.header('x-request-id', 'abc');
				pm.response.to.not.have.header('x-missing');
				pm.response.to.have.body();
				pm.response.to.have.jsonBody('profile.admin');
				pm.response.to.not.have.jsonBody('profile.nope');
				pm.response.to.be.json;
				pm.expect(pm.response.code).to.equal(200);
				pm.expect(pm.response.status).to.equal('OK');
				pm.expect(pm.response.headers.get('CONTENT-TYPE')).to.include('json');
				pm.expect(pm.response.headers.has('x-request-id')).to.be.true;
				pm.expect(pm.response.responseTime).to.be.below(100);
				pm.expect(pm.response.responseSize).to.equal(64);
				pm.expect(pm.response.text()).to.include('Ada');
				pm.expect(pm.expect(pm.response).to.have.status).to.be.a('function');
			});
			pm.test('status fails', () => { pm.response.to.have.status(201); });
			pm.test('flag fails', () => { pm.response.to.be.notFound; });
		`);
		assert.deepStrictEqual(out.tests, [
			{ name: 'ok', passed: true },
			{ name: 'status fails', passed: false, error: 'expected the response to have status 201 but got 200' },
			{ name: 'flag fails', passed: false, error: 'expected the response to be 404 Not Found but its status is 200' },
		]);

		const invalid = run(`pm.test('json', () => { pm.response.json(); });`, { response: { status: 500, statusText: 'Internal Server Error', headers: {}, body: '<html>', durationMs: 1, size: 6 } });
		assert.strictEqual(invalid.tests[0].passed, false);
		assert.ok(invalid.tests[0].error?.startsWith('The response body is not valid JSON'));
	});

	test('variables: set, unset, precedence and replaceIn', () => {
		const out = run(`
			pm.test('reads', () => {
				pm.expect(pm.variables.get('host')).to.equal('env-host');
				pm.expect(pm.variables.get('version')).to.equal('v1');
				pm.expect(pm.variables.get('region')).to.equal('eu');
				pm.expect(pm.variables.get('nope')).to.be.undefined;
				pm.expect(pm.collectionVariables.get('host')).to.equal('col-host');
				pm.expect(pm.globals.get('host')).to.equal('global-host');
				pm.expect(pm.environment.name).to.equal('staging');
				pm.expect(pm.environment.has('token')).to.be.true;
				pm.expect(pm.variables.replaceIn('{{host}}/{{version}}/{{nope}}')).to.equal('env-host/v1/{{nope}}');
				pm.expect(pm.info.requestName).to.equal('Get user');
				pm.expect(pm.info.eventName).to.equal('test');
			});
			pm.variables.set('host', 'local-host');
			pm.environment.set('userId', pm.response.json().id);
			pm.environment.set('profile', { admin: true });
			pm.environment.unset('token');
			pm.collectionVariables.set('version', 'v2');
			pm.globals.clear();
			pm.test('local wins', () => pm.expect(pm.variables.get('host')).to.equal('local-host'));
		`);
		assert.strictEqual(out.error, undefined);
		assert.ok(out.tests.every(item => item.passed), JSON.stringify(out.tests));
		assert.deepStrictEqual(out.variables, {
			environment: { host: 'env-host', userId: '7', profile: '{"admin":true}' },
			collection: { host: 'col-host', version: 'v2' },
			globals: {},
			local: { host: 'local-host' },
		});
	});

	test('a pre-request script changes the request', () => {
		const out = run(`
			pm.request.headers.add({ key: 'X-Trace', value: 'one' });
			pm.request.headers.upsert({ key: 'accept', value: 'text/plain' });
			pm.request.headers.add({ key: 'X-Drop', value: '1' });
			pm.request.headers.remove('x-drop');
			pm.request.url = pm.request.url.toString().replace('/7', '/8');
			pm.request.url.addQueryParams('page=2');
			pm.request.method = 'post';
			pm.request.body.raw = JSON.stringify({ at: pm.variables.get('host') });
			pm.variables.set('stamp', 5);
			console.log(pm.request.url.getHost(), pm.request.url.getPath(), pm.request.url.getQueryString(), typeof pm.response);
		`, { phase: 'preRequest' });
		assert.strictEqual(out.error, undefined);
		assert.deepStrictEqual(out.request, {
			name: 'Get user',
			method: 'POST',
			url: 'https://api.test/users/8?full=1&page=2',
			headers: [['accept', 'text/plain'], ['X-Trace', 'one']],
			body: '{"at":"env-host"}',
		});
		assert.deepStrictEqual(out.variables.local, { stamp: '5' });
		assert.deepStrictEqual(out.logs, [{ level: 'log', text: 'api.test /users/8 full=1&page=2 undefined' }]);
	});

	test('Postman\'s older API: tests[], responseBody, postman.*', () => {
		const out = run(`
			var data = JSON.parse(responseBody);
			tests['status is 200'] = responseCode.code === 200;
			tests['is fast'] = responseTime < 10;
			postman.setEnvironmentVariable('name', data.name);
			postman.setGlobalVariable('seen', 1);
			tests['reads back'] = postman.getEnvironmentVariable('name') === 'Ada' && postman.getGlobalVariable('seen') === '1';
			postman.clearEnvironmentVariable('host');
			environment.direct = 3;
		`);
		assert.strictEqual(out.error, undefined);
		assert.deepStrictEqual(out.tests, [
			{ name: 'status is 200', passed: true },
			{ name: 'is fast', passed: false, error: 'tests[...] was set to a falsy value' },
			{ name: 'reads back', passed: true },
		]);
		assert.deepStrictEqual(out.variables.environment, { token: 't0', name: 'Ada', direct: '3' });
		assert.strictEqual(out.variables.globals.seen, '1');
	});

	test('JetBrains handlers: client.test, client.assert, client.global', () => {
		const out = run(`
			client.test('status', function () {
				client.assert(response.status === 200, 'not 200');
				client.assert(response.contentType.mimeType === 'application/json');
				client.assert(response.headers.valueOf('x-request-id') === 'abc');
				client.assert(response.headers.valueOf('x-none') === null);
			});
			client.test('fails', function () { client.assert(response.body.id === 8, 'wrong id'); });
			client.global.set('userName', response.body.name);
			client.log('saved', client.global.get('userName'), client.global.isEmpty());
			client.global.clear('token');
		`);
		assert.strictEqual(out.error, undefined);
		assert.deepStrictEqual(out.tests, [{ name: 'status', passed: true }, { name: 'fails', passed: false, error: 'wrong id' }]);
		assert.deepStrictEqual(out.variables.environment, { host: 'env-host', userName: 'Ada' });
		assert.deepStrictEqual(out.logs, [{ level: 'log', text: 'saved Ada false' }]);

		const pre = run(`request.variables.set('nonce', request.environment.get('token') + '-' + request.method + '-' + request.url());`, { phase: 'preRequest' });
		assert.deepStrictEqual(pre.variables.local, { nonce: 't0-GET-https://api.test/users/7?full=1' });
	});

	test('console is captured and capped', () => {
		const out = run(`
			console.log('a', 1, { b: [true, null] }, undefined);
			console.info('i');
			console.warn('w');
			console.error(new Error('e'));
			console.debug('d');
			console.log('x'.repeat(5000));
			for (let i = 0; i < 300; i++) { console.log(i); }
		`);
		assert.deepStrictEqual(out.logs.slice(0, 5), [
			{ level: 'log', text: 'a 1 {"b":[true,null]} undefined' },
			{ level: 'info', text: 'i' },
			{ level: 'warn', text: 'w' },
			{ level: 'error', text: 'e' },
			{ level: 'log', text: 'd' },
		]);
		assert.strictEqual(out.logs[5].text.length, 4003);
		assert.strictEqual(out.logs.length, 200);
	});

	test('a syntax error and a runtime error are reported, not thrown', () => {
		const syntax = run(`pm.test('never', () => {`);
		assert.ok(syntax.error && /SyntaxError/.test(syntax.error), syntax.error);
		assert.deepStrictEqual(syntax.tests, []);

		const runtime = run(`pm.test('before', () => {}); missingFunction(); pm.test('after', () => {});`);
		assert.strictEqual(runtime.error, 'ReferenceError: missingFunction is not defined');
		assert.deepStrictEqual(runtime.tests, [{ name: 'before', passed: true }]);

		const thrown = run(`throw new Error('stop here');`);
		assert.strictEqual(thrown.error, 'stop here');

		const required = run(`require('lodash');`);
		assert.ok(required.error?.startsWith('require is not available'));

		const unsupported = run(`pm.test('x', () => { pm.expect(1).to.be.frozen; });`);
		assert.strictEqual(unsupported.tests[0].error, `expect: 'frozen' is not supported in Volt's HTTP client scripts`);

		const empty = httpScriptRuntime({} as IHttpScriptInput);
		assert.deepStrictEqual(empty.tests, []);
		assert.strictEqual(empty.error, undefined);
	});

	test('setNextRequest, sendRequest and async tests', () => {
		assert.strictEqual(run(`pm.test('t', () => {});`).nextRequest, undefined);
		assert.strictEqual(run(`pm.execution.setNextRequest('Login');`).nextRequest, 'Login');
		assert.strictEqual(run(`postman.setNextRequest(null);`).nextRequest, null);

		const sent = run(`pm.sendRequest('https://example.com', (err, res) => { pm.test('callback', () => pm.expect(err.message).to.include('not supported')); });`);
		assert.deepStrictEqual(sent.logs, [{ level: 'error', text: 'pm.sendRequest is not supported' }]);
		assert.deepStrictEqual(sent.tests, [{ name: 'callback', passed: true }]);

		const later = run(`pm.test('async', async () => { pm.expect(1).to.equal(2); });`);
		assert.strictEqual(later.tests[0].passed, false);
		assert.ok(later.tests[0].error?.startsWith('Asynchronous tests are not supported'));
	});

	test('onlyTests runs the named tests alone: the rest of the script still runs, other tests are neither called nor reported', () => {
		const script = `
			const body = pm.response.json();
			pm.environment.set('seen', String(body.id));
			let calls = 0;
			pm.test('status', () => { calls++; pm.response.to.have.status(200); });
			pm.test('name', () => { calls++; pm.expect(body.name).to.equal('Grace'); });
			pm.test.skip('later');
			client.test('handler', () => { calls++; });
			tests['legacy ok'] = true;
			tests['legacy bad'] = false;
			console.log('calls ' + calls);
		`;
		const one = run(script, { onlyTests: ['name'] });
		assert.deepStrictEqual(one.tests, [{ name: 'name', passed: false, error: one.tests[0].error }]);
		assert.ok(one.tests[0].error?.includes('Grace'));
		assert.deepStrictEqual(one.logs, [{ level: 'log', text: 'calls 1' }]);
		assert.strictEqual(one.variables.environment.seen, '7', 'what the script does outside its tests still happens');

		assert.deepStrictEqual(run(script, { onlyTests: ['status', 'later', 'handler', 'legacy bad'] }).tests.map(test => `${test.name}:${test.skipped ? 'skip' : test.passed}`), ['status:true', 'later:skip', 'handler:true', 'legacy bad:false']);
		assert.deepStrictEqual(run(script, { onlyTests: ['nothing by that name'] }).tests, []);
		assert.strictEqual(run(script).tests.length, 6, 'without it every test runs');
	});

	test('httpScriptTestSites finds the tests a script names literally, with the line each starts on', () => {
		const sites = httpScriptTestSites([
			'// pm.test("in a comment", () => {});',
			'pm.test("Status code is 200", function () {',
			'    pm.response.to.have.status(200);',
			'});',
			'/* pm.test("in a block",',
			'   () => {}); */',
			'pm.test(\'It\\\'s JSON\', () => {});',
			'const text = "pm.test(\\"in a string\\", fn)";',
			'pm.test(`plain template`, () => {});',
			'pm.test(`built ${name}`, () => {});',
			'pm.test(title, () => {});',
			'pm.test.skip("not yet");',
			'  client.test("handler", function () {',
			'  });',
			'tests["legacy"] = responseCode.code === 200;',
			'mypm.test("someone else\'s", () => {});',
		].join('\n'));
		assert.deepStrictEqual(sites, [
			{ name: 'Status code is 200', line: 2 },
			{ name: 'It\'s JSON', line: 7 },
			{ name: 'plain template', line: 9 },
			{ name: 'not yet', line: 12 },
			{ name: 'handler', line: 13 },
			{ name: 'legacy', line: 15 },
		]);
		assert.deepStrictEqual(httpScriptTestSites(''), []);
		assert.deepStrictEqual(httpScriptTestSites('pm.test("cut off'), []);
	});

	test('the worker source is self-contained and answers a message', () => {
		const posted: IHttpScriptOutput[] = [];
		const self: { postMessage(value: IHttpScriptOutput): void; onmessage?: (event: { data: IHttpScriptInput }) => void; fetch?: unknown } = {
			postMessage: value => posted.push(value),
			fetch: () => { throw new Error('the network is not for scripts'); },
		};
		new Function('self', httpScriptWorkerSource())(self);
		assert.strictEqual(self.fetch, undefined);
		assert.strictEqual(typeof self.onmessage, 'function');
		self.onmessage!({ data: input(`pm.test('in the worker', () => { pm.response.to.have.status(200); pm.expect(pm.response.json().tags).to.have.lengthOf(2); }); pm.environment.set('seen', 'yes');`) });
		assert.strictEqual(posted.length, 1);
		assert.deepStrictEqual(posted[0].tests, [{ name: 'in the worker', passed: true }]);
		assert.strictEqual(posted[0].variables.environment.seen, 'yes');
		// Plain data only: what a worker's postMessage can clone.
		assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[0])), posted[0]);
	});

	// --- What a test did (`detail`) ------------------------------------------------------------------

	const DETAIL_SCRIPT = [
		/*  1 */ `pm.test('ok', () => {`,
		/*  2 */ `	console.log('inside');`,
		/*  3 */ `	pm.expect(1).to.equal(1);`,
		/*  4 */ `	pm.expect([1]).to.not.include(2);`,
		/*  5 */ `});`,
		/*  6 */ `console.log('outside');`,
		/*  7 */ `pm.test('bad', () => {`,
		/*  8 */ `	pm.expect({ a: 1, b: [1, 2] }).to.eql({ a: 1, b: [1, 3] });`,
		/*  9 */ `});`,
		/* 10 */ `pm.test('throws', () => {`,
		/* 11 */ `	console.warn('before');`,
		/* 12 */ `	missing();`,
		/* 13 */ `});`,
		/* 14 */ `client.test('handler', function () { client.assert(true, 'fine'); client.assert(false, 'not fine'); });`,
		/* 15 */ `pm.test.skip('later');`,
		/* 16 */ `nope.x = 1;`,
	].join('\n');

	testOnV8('detail: each test carries its duration, assertions, expected and actual, and the line it failed on', () => {
		const out = run(DETAIL_SCRIPT, { detail: true });
		assert.deepStrictEqual(out.tests.map(test => test.name), ['ok', 'bad', 'throws', 'handler', 'later']);
		const [ok, bad, throws, handler, later] = out.tests;

		assert.ok(typeof ok.durationMs === 'number' && ok.durationMs >= 0 && ok.durationMs < 5000);
		assert.deepStrictEqual(ok.assertions, [
			{ passed: true, message: 'expected 1 to equal 1', expected: '1', actual: '1', operator: 'equal' },
			{ passed: true, message: 'expected [1] to not include 2', expected: '2', actual: '[\n  1\n]', operator: 'not include' },
		]);
		assert.strictEqual(ok.errorLine, undefined);
		assert.strictEqual(ok.expected, undefined);

		assert.strictEqual(bad.passed, false);
		assert.strictEqual(bad.error, 'expected {"a":1,"b":[1,2]} to deeply equal {"a":1,"b":[1,3]}');
		assert.strictEqual(bad.expected, JSON.stringify({ a: 1, b: [1, 3] }, null, 2));
		assert.strictEqual(bad.actual, JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
		assert.strictEqual(bad.errorLine, 8);
		assert.deepStrictEqual(bad.assertions, [{ passed: false, message: bad.error, expected: bad.expected, actual: bad.actual, operator: 'deep equal' }]);

		assert.strictEqual(throws.error, 'ReferenceError: missing is not defined');
		assert.strictEqual(throws.errorLine, 12);
		assert.strictEqual(throws.assertions, undefined);
		assert.strictEqual(throws.expected, undefined);

		assert.deepStrictEqual(handler.assertions, [{ passed: true, message: 'fine' }, { passed: false, message: 'not fine' }]);
		assert.strictEqual(handler.errorLine, 14);
		assert.deepStrictEqual(later, { name: 'later', passed: true, skipped: true });

		// A console line knows the test it came from.
		assert.deepStrictEqual(out.logs, [
			{ level: 'log', text: 'inside', test: 'ok' },
			{ level: 'log', text: 'outside' },
			{ level: 'warn', text: 'before', test: 'throws' },
		]);
		assert.strictEqual(out.error, 'ReferenceError: nope is not defined');
		assert.strictEqual(out.errorLine, 16);

		// Without `detail`, the same script reports what it always did.
		const plain = run(DETAIL_SCRIPT);
		assert.deepStrictEqual(plain.tests, out.tests.map(test => ({ name: test.name, passed: test.passed, ...(test.skipped ? { skipped: true } : {}), ...(test.error !== undefined ? { error: test.error } : {}) })));
		assert.deepStrictEqual(plain.logs, out.logs.map(log => ({ level: log.level, text: log.text })));
		assert.strictEqual(plain.errorLine, undefined);
	});

	test('detail: assertions and previews are capped, and only the failing assertion gives expected and actual', () => {
		const out = run(`
			pm.test('many', () => { for (let i = 0; i < 80; i++) { pm.expect(i).to.be.at.least(0); } });
			pm.test('long', () => { pm.expect('x'.repeat(5000)).to.equal('y'); });
			pm.test('lines', () => { pm.expect('a\\nb').to.equal('a\\nc'); });
			pm.test('status', () => { pm.response.to.have.status(404); });
			pm.test('caught', () => { try { pm.expect(1).to.equal(2); } catch (e) { } throw new Error('my own'); });
			pm.test('outer', () => { pm.test('inner', () => { pm.expect(1).to.equal(1); console.log('in inner'); }); console.log('in outer'); pm.expect(2).to.be.above(1); });
		`, { detail: true });
		const byName = new Map(out.tests.map(test => [test.name, test]));
		assert.strictEqual(byName.get('many')!.assertions!.length, 50);
		assert.strictEqual(byName.get('many')!.assertionCount, 80);
		assert.strictEqual(byName.get('many')!.assertions![0].operator, 'at least');
		assert.strictEqual(byName.get('long')!.actual!.length, 2003);
		assert.strictEqual(byName.get('long')!.expected, '"y"');
		assert.strictEqual(byName.get('lines')!.actual, 'a\nb');
		assert.strictEqual(byName.get('lines')!.expected, 'a\nc');
		assert.strictEqual(byName.get('status')!.expected, '404');
		assert.strictEqual(byName.get('status')!.actual, '200');
		// The error the test ended with is its own: the caught assertion's values are not its values.
		assert.strictEqual(byName.get('caught')!.error, 'my own');
		assert.strictEqual(byName.get('caught')!.expected, undefined);
		assert.strictEqual(byName.get('caught')!.assertions!.length, 1);
		// A test inside a test keeps its own assertions and console lines.
		assert.deepStrictEqual(byName.get('inner')!.assertions!.map(item => item.operator), ['equal']);
		assert.deepStrictEqual(byName.get('outer')!.assertions!.map(item => item.operator), ['above']);
		assert.deepStrictEqual(out.logs, [{ level: 'log', text: 'in inner', test: 'inner' }, { level: 'log', text: 'in outer', test: 'outer' }]);
	});

	// --- Breakpoints -----------------------------------------------------------------------------------

	const BREAK_SCRIPT = [
		/*  1 */ `// the response, once`,
		/*  2 */ `const body = pm.response.json();`,
		/*  3 */ `let count = 0;`,
		/*  4 */ `pm.test('named', function () {`,
		/*  5 */ `	const { id, tags: [first] } = body;`,
		/*  6 */ `	pm.environment.set('seen', 'yes');`,
		/*  7 */ `	count++;`,
		/*  8 */ `	let later = id + 1;`,
		/*  9 */ `	pm.expect(later).to.equal(8);`,
		/* 10 */ `});`,
		/* 11 */ `for (let i = 0; i < 3; i++) {`,
		/* 12 */ `	count += i;`,
		/* 13 */ `}`,
		/* 14 */ `pm.test('other', () => {`,
		/* 15 */ `	pm.expect(count).to.equal(4);`,
		/* 16 */ `});`,
	].join('\n');

	const localsOf = (stop: IHttpScriptBreak): Record<string, string> => Object.fromEntries(stop.scopes[0].variables.map(variable => [variable.name, variable.preview]));
	const variable = (stop: IHttpScriptBreak, scope: string, name: string): IHttpScriptValue | undefined => stop.scopes.find(item => item.name === scope)?.variables.find(item => item.name === name);

	test('breakpoints: the variables in reach are recorded each time a marked line is about to run', () => {
		const out = run(BREAK_SCRIPT, { breakpoints: [7, 12, 1] });
		assert.deepStrictEqual(out.breakpointLines, [2, 7, 12], 'line 1 is a comment: its breakpoint lands on line 2');
		assert.deepStrictEqual(out.tests, [{ name: 'named', passed: true }, { name: 'other', passed: true }]);
		const stops = out.breaks!;
		assert.deepStrictEqual(stops.map(stop => [stop.order, stop.line, stop.hit, stop.test]), [[1, 2, 1, undefined], [2, 7, 1, 'named'], [3, 12, 1, undefined], [4, 12, 2, undefined], [5, 12, 3, undefined]]);
		assert.deepStrictEqual(stops[1].scopes.map(scope => scope.name), ['Local', 'Response', 'Request', 'Variables']);

		// Line 2 has not run yet: `body` and `count` are declared further down.
		assert.deepStrictEqual(localsOf(stops[0]), { body: 'not initialised', count: 'not initialised' });
		assert.strictEqual(stops[0].scopes[0].variables[0].type, 'uninitialised');
		// Inside the test: its own names first, `later` not reached yet, then the script's.
		assert.deepStrictEqual(localsOf(stops[1]), { id: '7', first: '"a"', later: 'not initialised', body: '{id: 7, name: "Ada", tags: Array(2), profile: {...}}', count: '0' });
		const body = variable(stops[1], 'Local', 'body')!;
		assert.strictEqual(body.type, 'object');
		assert.deepStrictEqual(body.children!.map(child => `${child.name}:${child.type}:${child.preview}`), ['id:number:7', 'name:string:"Ada"', 'tags:array:(2) ["a", "b"]', 'profile:object:{admin: true}']);
		assert.deepStrictEqual(body.children![2].children, [{ name: '0', type: 'string', preview: '"a"' }, { name: '1', type: 'string', preview: '"b"' }]);
		// The loop: the same line, three times, with the values of each time.
		assert.deepStrictEqual(stops.slice(2).map(stop => localsOf(stop)), [{ i: '0', body: body.preview, count: '1' }, { i: '1', body: body.preview, count: '1' }, { i: '2', body: body.preview, count: '2' }]);

		// The other scopes, as they are at that moment.
		assert.strictEqual(variable(stops[1], 'Response', 'status')!.preview, '200');
		assert.strictEqual(variable(stops[1], 'Response', 'time')!.preview, '42');
		assert.strictEqual(variable(stops[1], 'Response', 'body')!.children![0].preview, '7');
		assert.strictEqual(variable(stops[1], 'Response', 'headers')!.children![1].preview, '"abc"');
		assert.strictEqual(variable(stops[1], 'Request', 'method')!.preview, '"GET"');
		assert.strictEqual(variable(stops[1], 'Request', 'url')!.preview, '"https://api.test/users/7?full=1"');
		assert.deepStrictEqual(variable(stops[0], 'Variables', 'environment')!.children!.map(child => child.name), ['host', 'token']);
		assert.deepStrictEqual(variable(stops[1], 'Variables', 'environment')!.children!.map(child => `${child.name}=${child.preview}`), ['host="env-host"', 'token="t0"', 'seen="yes"']);

		// Before the request there is no response to show.
		const pre = run(`const stamp = 5;\npm.variables.set('stamp', stamp);\npm.request.headers.add('X-Stamp', '5');\nconst done = true;`, { phase: 'preRequest', breakpoints: [4] });
		assert.deepStrictEqual(pre.breaks!.map(stop => stop.scopes.map(scope => scope.name)), [['Local', 'Request', 'Variables']]);
		assert.deepStrictEqual(localsOf(pre.breaks![0]), { stamp: '5', done: 'not initialised' });
		assert.strictEqual(variable(pre.breaks![0], 'Request', 'headers')!.children![1].name, 'X-Stamp');
		assert.strictEqual(variable(pre.breaks![0], 'Variables', 'local')!.children![0].preview, '"5"');

		// No breakpoints asked: nothing about them in the answer. Asked but none reached: an empty list.
		assert.strictEqual(run(BREAK_SCRIPT).breaks, undefined);
		assert.strictEqual(run(BREAK_SCRIPT).breakpointLines, undefined);
		const unreached = run(`if (false) {\n	console.log('never');\n}`, { breakpoints: [2] });
		assert.deepStrictEqual([unreached.breaks, unreached.breakpointLines], [[], [2]]);
		assert.deepStrictEqual(run(BREAK_SCRIPT, { breakpoints: [] }).breaks, []);
	});

	testOnV8('breakpoints: a script reports the same with them as without', () => {
		const scripts = [
			DETAIL_SCRIPT,
			BREAK_SCRIPT,
			[
				`'use strict';`,
				`function pick(x) {`,
				`	if (x > 1) return 'big';`,
				`	else if (x > 0)`,
				`		return 'small';`,
				`	else`,
				`		return 'none';`,
				`}`,
				`class Box {`,
				`	static made = 0;`,
				`	constructor(v) { this.v = v; Box.made++; }`,
				`	get double() {`,
				`		return this.v * 2;`,
				`	}`,
				`}`,
				`const text = \`a \${ pick(2) } { \${ [1, 2].map(n => \`<\${ n }>\`).join('') }\`;`,
				`const re = /[/{]+\\}?/;`,
				`pm.test('picks', () => {`,
				`	pm.expect([pick(2), pick(1), pick(0)]).to.eql(['big', 'small', 'none']);`,
				`	pm.expect(text).to.equal('a big { <1><2>');`,
				`	pm.expect(re.test('{')).to.be.true;`,
				`});`,
				`pm.test('boxes', function () {`,
				`	const box = new Box(4);`,
				`	switch (box.double) {`,
				`		case 8:`,
				`			console.log('eight');`,
				`			break;`,
				`		default:`,
				`			throw new Error('not eight');`,
				`	}`,
				`	let seen = 0;`,
				`	for (const key in { a: 1, b: 2 }) seen += key.length;`,
				`	while (seen < 5) seen++;`,
				`	do seen--; while (seen > 3)`,
				`	try {`,
				`		JSON.parse('{');`,
				`	} catch ({ message }) {`,
				`		console.log(typeof message);`,
				`	} finally {`,
				`		seen = seen ? seen + 1 : -1`,
				`	}`,
				`	pm.expect([seen, Box.made]).to.eql([4, 1]);`,
				`	pm.expect(seen).to.equal(5); // fails here`,
				`});`,
				`const later = async () => {`,
				`	await null;`,
				`	return 1;`,
				`};`,
				`pm.test('async', () => later());`,
				`pm.environment.set('picked', pick(1));`,
				`undefinedThing.call();`,
				`pm.test('never', () => { });`,
			].join('\n'),
		];
		for (const script of scripts) {
			const every = Array.from({ length: script.split('\n').length }, (_, index) => index + 1);
			const plain = run(script, { detail: true });
			const stopped = run(script, { detail: true, breakpoints: every });
			const timeless = (out: IHttpScriptOutput) => out.tests.map(({ durationMs: _durationMs, ...rest }) => rest);
			assert.deepStrictEqual(timeless(stopped), timeless(plain));
			assert.deepStrictEqual(stopped.logs, plain.logs);
			assert.deepStrictEqual([stopped.error, stopped.errorLine], [plain.error, plain.errorLine]);
			assert.deepStrictEqual(stopped.variables, plain.variables);
			assert.ok(script === BREAK_SCRIPT || (plain.error && plain.errorLine), 'the other two end on an error with a known line');
			assert.ok(stopped.breaks!.length >= stopped.breakpointLines!.length / 2, 'most lines were reached');
			assert.deepStrictEqual(stopped.breaks!.map(stop => stop.order), stopped.breaks!.map((_, index) => index + 1));
		}
		const last = run(scripts[2], { detail: true, breakpoints: [1] });
		assert.deepStrictEqual(last.breakpointLines, [3], 'a directive and a function declaration are not places to stop');
		assert.strictEqual(last.tests.find(test => test.name === 'boxes')!.errorLine, 44);
		assert.strictEqual(last.errorLine, 52);

		// A script that does not parse fails the same way: nothing was put into it.
		const broken = `pm.test('never', () => {`;
		assert.deepStrictEqual(run(broken, { breakpoints: [1] }).error, run(broken).error);
		assert.deepStrictEqual(run(broken, { breakpoints: [1] }).breaks, []);
	});

	test('breakpoints: stops and values are capped', () => {
		const loop = run(`let total = 0;\nfor (let i = 0; i < 500; i++) {\n	total += i;\n}\npm.test('sum', () => pm.expect(total).to.equal(124750));`, { breakpoints: [3] });
		assert.strictEqual(loop.breaks!.length, 200);
		assert.strictEqual(loop.breaksCapped, true);
		assert.deepStrictEqual(loop.breaks![199].hit, 200);
		assert.deepStrictEqual(loop.logs, [{ level: 'warn', text: 'Breakpoints: only the first 200 stops were recorded.' }]);
		assert.deepStrictEqual(loop.tests, [{ name: 'sum', passed: true }], 'the script itself runs to its end');

		const values = run([
			`const big = Array.from({ length: 100 }, (_, i) => i);`,
			`const deep = { a: { b: { c: { d: { e: 1 } } } } };`,
			`const ring = { name: 'ring' }; ring.self = ring;`,
			`const long = 'x'.repeat(5000);`,
			`const wide = {}; for (let i = 0; i < 100; i++) { wide['k' + i] = { v: [i, i, i, i, i, i, i, i, i, i] }; }`,
			`const fn = function named() { }; const when = new Date(0); const re = /a+/g; const err = new TypeError('bad');`,
			`const map = new Map([['one', 1], [{ k: 1 }, 2]]); const set = new Set(['a']); const nothing = null; let unset;`,
			`const trap = { get boom() { throw new Error('no'); }, fine: 1 };`,
			`console.log('here');`,
		].join('\n'), { breakpoints: [9] });
		const stop = values.breaks![0];
		const local = (name: string) => variable(stop, 'Local', name)!;
		assert.strictEqual(local('big').children!.length, 61);
		assert.deepStrictEqual(local('big').children![60], { name: '...', type: 'more', preview: '40 more' });
		assert.strictEqual(local('big').preview, '(100) [0, 1, 2, 3, 4, 5, 6, 7, ...]');
		// Four levels: deep, a, b, c; `c` shows what it holds but does not open.
		const c = local('deep').children![0].children![0].children![0];
		assert.deepStrictEqual(c, { name: 'c', type: 'object', preview: '{d: {...}}' });
		assert.deepStrictEqual(local('ring').children, [{ name: 'name', type: 'string', preview: '"ring"' }, { name: 'self', type: 'object', preview: '[Circular]' }]);
		assert.strictEqual(local('long').preview.length, 300);
		assert.deepStrictEqual([local('fn').preview, local('when').preview, local('re').preview, local('err').preview, local('nothing').type, local('unset').preview], ['function named()', '1970-01-01T00:00:00.000Z', '/a+/g', 'TypeError: bad', 'null', 'undefined']);
		assert.deepStrictEqual([local('fn').type, local('when').type, local('re').type, local('err').type, local('map').type, local('set').type], ['function', 'Date', 'RegExp', 'TypeError', 'Map', 'Set']);
		assert.deepStrictEqual(local('map').children!.map(child => child.name), ['one', '1']);
		assert.strictEqual(local('set').preview, 'Set(1) ["a"]');
		assert.deepStrictEqual(local('trap').children!.map(child => child.preview), ['"[no]"', '1']);
		// One stop does not record without end: a wide and deep value stops opening.
		const size = (value: IHttpScriptValue): number => 1 + (value.children ?? []).reduce((sum, child) => sum + size(child), 0);
		assert.ok(stop.scopes[0].variables.reduce((sum, value) => sum + size(value), 0) < 1000);
		assert.ok(stop.scopes.every(scope => scope.variables.every(function short(value: IHttpScriptValue): boolean { return value.preview.length <= 300 && (value.children ?? []).every(short); })));
		assert.deepStrictEqual(JSON.parse(JSON.stringify(values.breaks)), values.breaks, 'plain data: a worker can post it');
	});

	test('breakpoints: with onlyTests, a test that is not run does not stop', () => {
		const script = `pm.test('a', () => {\n	console.log('a');\n});\npm.test('b', () => {\n	console.log('b');\n});\nconsole.log('end');`;
		const all = run(script, { breakpoints: [2, 5, 7] });
		assert.deepStrictEqual(all.breaks!.map(stop => [stop.line, stop.test]), [[2, 'a'], [5, 'b'], [7, undefined]]);
		const only = run(script, { breakpoints: [2, 5, 7], onlyTests: ['b'] });
		assert.deepStrictEqual(only.breaks!.map(stop => [stop.line, stop.test]), [[5, 'b'], [7, undefined]]);
		assert.deepStrictEqual(only.breakpointLines, [2, 5, 7]);
		assert.deepStrictEqual(only.tests, [{ name: 'b', passed: true }]);
	});

	test('breakpoints and failure lines in the worker: the script is compiled with its breakpoints in', () => {
		const post = (source: string, data: IHttpScriptInput): IHttpScriptOutput => {
			const posted: IHttpScriptOutput[] = [];
			const self: { postMessage(value: IHttpScriptOutput): void; onmessage?: (event: { data: IHttpScriptInput }) => void } = { postMessage: value => posted.push(value) };
			new Function('self', source)(self);
			self.onmessage!({ data });
			return posted[0];
		};
		assert.ok(httpScriptNames().includes('__voltBreak'), 'a compiled script takes the breakpoint function');
		const plain = post(httpScriptWorkerSource(DETAIL_SCRIPT), input(DETAIL_SCRIPT, { detail: true }));
		assert.deepStrictEqual(plain.tests.map(test => test.errorLine), [undefined, 8, 12, 14, undefined]);
		assert.strictEqual(plain.errorLine, 16);
		assert.strictEqual(plain.breaks, undefined);

		const stopped = post(httpScriptWorkerSource(DETAIL_SCRIPT, [1, 2, 8, 9]), input(DETAIL_SCRIPT, { detail: true, breakpoints: [1, 2, 8, 9] }));
		assert.deepStrictEqual(stopped.breakpointLines, [1, 2, 8, 10]);
		assert.deepStrictEqual(stopped.breaks!.map(stop => [stop.line, stop.test]), [[1, undefined], [2, 'ok'], [8, 'bad'], [10, undefined]]);
		assert.deepStrictEqual(stopped.tests.map(test => test.errorLine), [undefined, 8, 12, 14, undefined]);
		assert.strictEqual(stopped.errorLine, 16);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(stopped)), stopped);

		const again = post(httpScriptWorkerSource(BREAK_SCRIPT, [7]), input(BREAK_SCRIPT, { breakpoints: [7], onlyTests: ['other'] }));
		assert.deepStrictEqual([again.breaks, again.breakpointLines], [[], [7]]);
	});

	test('detail: a passing assertion reads as what held; only a failure says what came instead', () => {
		const out = run([
			`pm.test('status', () => pm.response.to.have.status(200));`,
			`pm.test('wrong status', () => pm.response.to.have.status(201));`,
			`pm.test('header', () => pm.response.to.have.header('X-Request-Id', 'abc'));`,
			`pm.test('length', () => pm.expect(pm.response.json().tags).to.have.lengthOf(2));`,
		].join('\n'), { detail: true });
		const messages = out.tests.map(test => test.assertions?.map(assertion => assertion.message));
		assert.deepStrictEqual(messages, [
			['expected the response to have status 200'],
			['expected the response to have status 201 but got 200'],
			[`expected the response to have header 'X-Request-Id' of 'abc'`],
			['expected ["a","b"] to have a length of 2'],
		]);
	});
});
