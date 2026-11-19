/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { emptyHttpAuth, emptyHttpCollection, emptyHttpFolder, emptyHttpRequest, findHttpItemByPath, httpParamsFromUrl, httpPathVariablesFor, httpUrlWithQuery, httpWireRequest, IHttpRequest, keepHttpIds } from '../../common/httpCollection.js';
import { collectionToHttpFile, httpFileToCollection, parseHttpClientEnvFile, refreshHttpFileModel, syncHttpRequestUrl, updateHttpClientEnvFile } from '../../common/httpDotHttp.js';

const FILE = [
	'# Shop API requests',
	'@host = https://api.test',
	'',
	'### Log in',
	'# Gets a token for the other requests.',
	'# @name login',
	'POST {{host}}/login',
	'Content-Type: application/json',
	'# X-Debug: 1',
	'',
	'{ "user": "a" }',
	'',
	'> {%',
	'client.test("ok", () => client.assert(response.status === 200));',
	'%}',
	'',
	'###',
	'# keep this comment exactly',
	'GET {{host}}/users/:id?page=1',
	'    &limit=10',
	'Authorization: Bearer {{login.response.body.$.token}}',
	'',
].join('\n');

function requests(text: string): IHttpRequest[] {
	return httpFileToCollection(text, 'shop').items.filter((item): item is IHttpRequest => item.kind === 'request');
}

suite('Volt HTTP client: .http files as collections', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a file loads as a flat collection: variables, names, scripts, disabled headers, auth read from headers', () => {
		const collection = httpFileToCollection(FILE, 'shop');
		assert.deepStrictEqual(collection.variables, [{ key: 'host', value: 'https://api.test', enabled: true }]);
		const [login, users] = requests(FILE);
		assert.strictEqual(login.name, 'login');
		assert.strictEqual(login.description, 'Gets a token for the other requests.');
		assert.strictEqual(login.line, 7);
		assert.deepStrictEqual(login.headers, [{ key: 'X-Debug', value: '1', enabled: false }], 'the content type is the body\'s; the commented header is kept, off');
		assert.deepStrictEqual([login.body.mode, login.body.language, login.body.raw], ['raw', 'json', '{ "user": "a" }']);
		assert.strictEqual(login.scripts.test, 'client.test("ok", () => client.assert(response.status === 200));');
		assert.strictEqual(users.url, '{{host}}/users/:id?page=1&limit=10');
		assert.deepStrictEqual(users.params.map(row => [row.key, row.value]), [['page', '1'], ['limit', '10']]);
		assert.deepStrictEqual(users.pathVariables.map(row => row.key), ['id']);
		assert.deepStrictEqual([users.auth.type, users.auth.token], ['bearer', '{{login.response.body.$.token}}']);
	});

	test('saving writes only the block that changed; the others stay as they were typed', () => {
		const collection = httpFileToCollection(FILE, 'shop');
		assert.strictEqual(collectionToHttpFile(collection), FILE.replace('### Log in\n', '### Log in\n').replace(/\n$/, '\n'), 'untouched: the same text');
		const users = collection.items[1] as IHttpRequest;
		users.method = 'DELETE';
		users.pathVariables[0].value = '42';
		users.params.push({ key: 'debug', value: '1', enabled: false });
		const text = collectionToHttpFile(collection);
		assert.ok(text.includes('### Log in\n# Gets a token for the other requests.\n# @name login\nPOST {{host}}/login\nContent-Type: application/json\n# X-Debug: 1\n\n{ "user": "a" }\n\n> {%'), 'the first block, comments and all');
		assert.ok(text.includes('###\n# keep this comment exactly\n# @path-variable id 42\n# @disabled-param debug=1\nDELETE {{host}}/users/:id?page=1&limit=10\nAuthorization: Bearer {{login.response.body.$.token}}'));
		const again = requests(text)[1];
		assert.deepStrictEqual([again.method, again.pathVariables[0].value, again.params.at(-1)], ['DELETE', '42', { key: 'debug', value: '1', enabled: false }]);
		// After a save the model takes its new lines from the text, and ids survive a reload from disk.
		refreshHttpFileModel(collection, text);
		assert.strictEqual(collectionToHttpFile(collection), text);
		const reloaded = httpFileToCollection(text, 'shop');
		keepHttpIds(reloaded, collection);
		assert.deepStrictEqual(reloaded.items.map(item => item.id), collection.items.map(item => item.id));
	});

	test('adding, removing and reordering requests keeps the file well formed', () => {
		const collection = httpFileToCollection(FILE, 'shop');
		const added = emptyHttpRequest('List orders', 'none');
		added.url = '{{host}}/orders';
		added.body.mode = 'urlencoded';
		added.body.urlencoded = [{ key: 'q', value: 'a b', enabled: true }];
		added.method = 'POST';
		added.scripts.preRequest = 'request.variables.set("x", "1");';
		collection.items.unshift(added);
		collection.items.pop();
		collection.variables.push({ key: 'token', value: 'abc', enabled: true });
		const text = collectionToHttpFile(collection);
		const [first, second] = requests(text);
		assert.strictEqual(requests(text).length, 2);
		assert.deepStrictEqual([first.name, first.method, first.body.mode, first.body.urlencoded[0].value, first.scripts.preRequest], ['List orders', 'POST', 'urlencoded', 'a b', 'request.variables.set("x", "1");']);
		assert.strictEqual(second.name, 'login');
		assert.deepStrictEqual(httpFileToCollection(text, 'shop').variables.map(row => row.key), ['host', 'token']);
		assert.ok(text.startsWith('# Shop API requests\n\n@host = https://api.test\n@token = abc\n\n### List orders\n< {%'), text);
	});

	test('a Postman collection exports to .http: folders into names, inherited auth into headers', () => {
		const collection = emptyHttpCollection('Shop', 'postman');
		collection.auth = { ...emptyHttpAuth('bearer'), token: '{{token}}' };
		const folder = emptyHttpFolder('Users');
		const request = emptyHttpRequest('Create user');
		request.method = 'POST';
		request.url = '{{baseUrl}}/users';
		request.body.mode = 'graphql';
		request.body.graphqlQuery = 'query { me { id } }';
		request.body.graphqlVariables = '{ "a": 1 }';
		folder.items.push(request);
		collection.items.push(folder);
		const text = collectionToHttpFile(collection);
		assert.ok(text.includes('### Users / Create user\nPOST {{baseUrl}}/users\nX-Request-Type: GraphQL\nAuthorization: Bearer {{token}}\nContent-Type: application/json\n\nquery { me { id } }\n\n{ "a": 1 }'), text);
		const back = requests(text)[0];
		assert.deepStrictEqual([back.body.mode, back.body.graphqlQuery, back.auth.type], ['graphql', 'query { me { id } }', 'bearer']);
		assert.strictEqual(findHttpItemByPath(collection, ['Users', 'Create user'])?.id, request.id);
	});

	test('what goes out: inherited auth, path variables, encoded bodies', () => {
		const collection = emptyHttpCollection('Shop', 'postman');
		const folder = emptyHttpFolder('Users');
		folder.auth = { ...emptyHttpAuth('apikey'), keyName: 'api_key', keyValue: '{{key}}', keyIn: 'query' };
		const request = emptyHttpRequest('Update');
		request.method = 'PUT';
		syncHttpRequestUrl(request, 'https://api.test/users/:id/posts/:post?expand=1');
		request.pathVariables[0].value = '7';
		request.pathVariables[1].value = '{{post}}';
		request.body.mode = 'urlencoded';
		request.body.urlencoded = [{ key: 'name', value: 'A B&C', enabled: true }, { key: 'off', value: 'x', enabled: false }, { key: 'v', value: '{{name}}', enabled: true }];
		const wire = httpWireRequest(request, [folder], collection);
		assert.strictEqual(wire.spec.url, 'https://api.test/users/7/posts/{{post}}?expand=1&api_key={{key}}');
		assert.deepStrictEqual(wire.spec.headers, [['Content-Type', 'application/x-www-form-urlencoded']]);
		assert.strictEqual(wire.spec.body, 'name=A+B%26C&v={{name}}');
		request.auth = { ...emptyHttpAuth('basic'), username: 'u', password: 'p' };
		request.body.mode = 'formdata';
		request.body.formdata = [{ key: 'file', value: './a.png', enabled: true, type: 'file' }];
		const form = httpWireRequest(request, [folder], collection);
		assert.deepStrictEqual(form.spec.headers, [['Authorization', 'Basic u:p']], 'its own auth wins; the multipart content type is the sender\'s');
		assert.deepStrictEqual(form.formdata, [{ key: 'file', value: './a.png', enabled: true, type: 'file' }]);
	});

	test('the params table and the URL follow each other', () => {
		const params = httpParamsFromUrl('https://x/a?b=1&c', [{ key: 'old', value: '0', enabled: false, description: 'kept' }]);
		assert.deepStrictEqual(params, [{ key: 'old', value: '0', enabled: false, description: 'kept' }, { key: 'b', value: '1', enabled: true }, { key: 'c', value: '', enabled: true }]);
		assert.strictEqual(httpUrlWithQuery('https://x/a?b=1#frag', [{ key: 'q', value: '{{term}}', enabled: true }, { key: 'off', value: '1', enabled: false }, { key: 'flag', value: '', enabled: true }]), 'https://x/a?q={{term}}&flag#frag');
		assert.deepStrictEqual(httpPathVariablesFor('https://x:8080/a/:id/b/:id/:slug', [{ key: 'slug', value: 's', enabled: true }]), [{ key: 'id', value: '', enabled: true }, { key: 'slug', value: 's', enabled: true }], 'a port is not a path variable');
	});

	test('http-client.env.json: one environment changes, the others stay', () => {
		const text = '{"$shared":{"v":"1"},"dev":{"host":"localhost","n":3}}';
		assert.deepStrictEqual(parseHttpClientEnvFile(text).map(item => [item.name, item.variables.map(row => `${row.key}=${row.value}`)]), [['$shared', ['v=1']], ['dev', ['host=localhost', 'n=3']]]);
		const next = JSON.parse(updateHttpClientEnvFile(text, 'prod', [{ key: 'host', value: 'api.test', enabled: true }, { key: 'off', value: 'x', enabled: false }]));
		assert.deepStrictEqual(next, { $shared: { v: '1' }, dev: { host: 'localhost', n: 3 }, prod: { host: 'api.test' } });
		assert.deepStrictEqual(Object.keys(JSON.parse(updateHttpClientEnvFile(text, 'dev', undefined))), ['$shared']);
	});
});
