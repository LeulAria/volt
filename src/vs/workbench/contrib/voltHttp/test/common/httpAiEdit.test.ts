/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyHttpAiEdit, HTTP_AI_SECRET, httpAiEditMentions, httpAiEditPrompt, httpAiEditView, parseHttpAiEditAnswer } from '../../common/httpAiEdit.js';
import { emptyHttpAuth, emptyHttpRequest, IHttpRequest } from '../../common/httpCollection.js';

function request(): IHttpRequest {
	const r = emptyHttpRequest('Get user');
	r.url = '{{baseUrl}}/users/:id?expand=orders';
	r.params = [{ key: 'expand', value: 'orders', enabled: true }];
	r.pathVariables = [{ key: 'id', value: '7', enabled: true }];
	r.headers = [{ key: 'Authorization', value: 'Bearer abc.def', enabled: true }, { key: 'Accept', value: 'application/json', enabled: true }];
	r.auth = { ...emptyHttpAuth('basic'), username: 'ada', password: 'hunter2' };
	return r;
}

suite('Volt HTTP client: Edit with AI', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the model sees the request with its secrets masked, and a {{variable}} by name', () => {
		const r = request();
		r.headers.push({ key: 'X-API-Key', value: '{{apiKey}}', enabled: true });
		const view = httpAiEditView(r);
		assert.deepStrictEqual(view.headers, [
			{ key: 'Authorization', value: HTTP_AI_SECRET },
			{ key: 'Accept', value: 'application/json' },
			{ key: 'X-API-Key', value: '{{apiKey}}' },
		]);
		assert.deepStrictEqual(view.auth, { type: 'basic', username: 'ada', password: HTTP_AI_SECRET });
		const prompt = httpAiEditPrompt(r, [{ role: 'user', text: 'make it GET' }, { role: 'assistant', text: 'Done.' }], 'add a test', [], ['baseUrl', 'token']);
		assert.ok(!prompt.includes('hunter2') && !prompt.includes('abc.def'), 'no secret reaches the prompt');
		assert.ok(prompt.includes('{{baseUrl}}, {{token}}'));
		assert.ok(prompt.includes('User: make it GET\nYou: Done.'));
		assert.ok(prompt.trimEnd().endsWith('User: add a test'));
	});

	test('answers are read with or without fences, and plain text is a reply', () => {
		assert.deepStrictEqual(parseHttpAiEditAnswer('```json\n{"reply":"Switched to POST.","request":{"method":"post"}}\n```'), { reply: 'Switched to POST.', request: { method: 'post' } });
		assert.deepStrictEqual(parseHttpAiEditAnswer('Sure! {"reply": "It returns a user.", "request": {}}'), { reply: 'It returns a user.' });
		assert.deepStrictEqual(parseHttpAiEditAnswer('It returns the user with id 7.'), { reply: 'It returns the user with id 7.' });
		assert.deepStrictEqual(parseHttpAiEditAnswer('<insert>{"reply":"ok"}</insert>'), { reply: 'ok' });
		assert.deepStrictEqual(parseHttpAiEditAnswer('{not json'), { reply: '{not json' });
	});

	test('a change is applied field by field; a kept secret stays as it was', () => {
		const r = request();
		const changed = applyHttpAiEdit(r, {
			method: 'post',
			url: '{{baseUrl}}/users',
			headers: [{ key: 'Authorization', value: HTTP_AI_SECRET }, { key: 'Content-Type', value: 'application/json' }],
			body: { mode: 'raw', language: 'json', raw: '{\n  "name": "Ada"\n}' },
			auth: { type: 'basic', password: HTTP_AI_SECRET, username: 'grace' },
			scripts: { test: 'pm.test("created", () => pm.response.to.have.status(201));' },
			unknown: 'ignored',
		});
		assert.deepStrictEqual(changed, ['method', 'URL', 'headers', 'body', 'authorization', 'scripts']);
		assert.strictEqual(r.method, 'POST');
		assert.strictEqual(r.url, '{{baseUrl}}/users');
		assert.deepStrictEqual(r.params, [], 'the query rows follow the URL');
		assert.deepStrictEqual(r.headers.map(row => [row.key, row.value]), [['Authorization', 'Bearer abc.def'], ['Content-Type', 'application/json']]);
		assert.deepStrictEqual([r.body.mode, r.body.language, r.body.raw], ['raw', 'json', '{\n  "name": "Ada"\n}']);
		assert.deepStrictEqual([r.auth.type, r.auth.username, r.auth.password], ['basic', 'grace', 'hunter2']);
		assert.ok(r.scripts.test.includes('created'));
	});

	test('a JSON body sent as an object, headers as a map, params on their own, a new auth type', () => {
		const r = request();
		applyHttpAiEdit(r, { body: { raw: { name: 'Ada', admin: false } }, headers: { Accept: 'text/plain' }, params: [{ key: 'page', value: '2' }], auth: { type: 'bearer', token: '{{token}}' } });
		assert.deepStrictEqual([r.body.mode, r.body.language, JSON.parse(r.body.raw)], ['raw', 'json', { name: 'Ada', admin: false }]);
		assert.deepStrictEqual(r.headers, [{ key: 'Accept', value: 'text/plain', enabled: true }]);
		assert.strictEqual(r.url, '{{baseUrl}}/users/:id?page=2');
		assert.deepStrictEqual([r.auth.type, r.auth.token, r.auth.password], ['bearer', '{{token}}', ''], 'a new type starts empty');
	});

	test('the kind changes, and nothing changes for an empty answer', () => {
		const r = request();
		assert.deepStrictEqual(applyHttpAiEdit(r, {}), []);
		assert.deepStrictEqual(applyHttpAiEdit(r, { protocol: 'graphql', body: { graphqlQuery: 'query { users { id } }' } }), ['kind', 'body']);
		assert.strictEqual(r.protocol, 'graphql');
		assert.strictEqual(r.body.graphqlQuery, 'query { users { id } }');
		assert.deepStrictEqual(applyHttpAiEdit(r, { protocol: 'nope' }), []);
	});

	test('@ mentions name the longest matching request', () => {
		const labels = ['Shop/Users/Get user', 'Shop/Users/Get user by id', 'Shop/Auth/Log in'];
		assert.deepStrictEqual(httpAiEditMentions('like @Shop/Users/Get user by id but for orders, logged in as @Shop/Auth/Log in', labels), ['Shop/Users/Get user by id', 'Shop/Auth/Log in']);
		assert.deepStrictEqual(httpAiEditMentions('no mentions here', labels), []);
	});
});
