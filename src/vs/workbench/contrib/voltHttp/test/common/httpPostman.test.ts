/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IHttpCollection, IHttpFolder, IHttpItem, IHttpRequest } from '../../common/httpCollection.js';
import { collectionToPostman, environmentToPostman, isPostmanCollection, isPostmanEnvironment, POSTMAN_SCHEMA_V21, postmanToCollection, postmanToEnvironment } from '../../common/httpPostman.js';

/** The collection without its ids (every load makes new ones). */
function withoutIds(collection: IHttpCollection): unknown {
	const strip = (item: IHttpItem): unknown => item.kind === 'folder' ? { ...item, id: '', items: item.items.map(strip) } : { ...item, id: '' };
	return { ...collection, items: collection.items.map(strip) };
}

const V21 = {
	info: { _postman_id: 'abc-123', name: 'Shop API', description: 'Everything the shop does.', schema: POSTMAN_SCHEMA_V21, _exporter_id: '42' },
	item: [
		{
			name: 'Users',
			description: 'People',
			auth: { type: 'basic', basic: [{ key: 'username', value: 'ada', type: 'string' }, { key: 'password', value: 'secret', type: 'string' }] },
			event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['console.log("folder");'] } }],
			item: [
				{
					name: 'List users',
					event: [{ listen: 'test', script: { type: 'text/javascript', packages: {}, exec: ['pm.test("ok", () => {', '  pm.response.to.have.status(200);', '});'] } }],
					protocolProfileBehavior: { disableBodyPruning: true },
					request: {
						method: 'GET',
						header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Debug', value: '1', disabled: true, description: 'Verbose logs' }],
						url: {
							raw: '{{baseUrl}}/users/:id?page=2',
							host: ['{{baseUrl}}'],
							path: ['users', ':id'],
							query: [{ key: 'page', value: '2' }, { key: 'limit', value: '10', disabled: true, description: 'Page size' }],
							variable: [{ key: 'id', value: '7', description: 'The user' }],
						},
						description: 'Lists users.',
					},
					response: [{ name: 'Example', code: 200, body: '[]' }],
				},
				{
					name: 'Nested',
					item: [
						{
							name: 'Create user',
							request: {
								auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
								method: 'POST',
								header: [],
								body: { mode: 'raw', raw: '{\n  "name": "Ada"\n}', options: { raw: { language: 'json' } } },
								url: { raw: 'https://api.example.com:8443/users', protocol: 'https', host: ['api', 'example', 'com'], port: '8443', path: ['users'] },
							},
							response: [],
						},
					],
				},
			],
		},
		{
			name: 'Login',
			request: {
				auth: { type: 'noauth' },
				method: 'POST',
				header: [],
				body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'ada', type: 'text' }, { key: 'otp', value: '1', type: 'text', disabled: true }] },
				url: { raw: 'https://api.example.com/login', protocol: 'https', host: ['api', 'example', 'com'], path: ['login'] },
			},
			response: [],
		},
		{
			name: 'Upload',
			request: {
				auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key', type: 'string' }, { key: 'value', value: 'k1', type: 'string' }, { key: 'in', value: 'query', type: 'string' }] },
				method: 'POST',
				header: [],
				body: { mode: 'formdata', formdata: [{ key: 'title', value: 'Cat', type: 'text' }, { key: 'photo', type: 'file', src: '/tmp/cat.png' }] },
				url: { raw: 'https://api.example.com/upload', protocol: 'https', host: ['api', 'example', 'com'], path: ['upload'] },
			},
			response: [],
		},
		{
			name: 'Binary',
			request: {
				auth: { type: 'kerberos', kerberos: [{ key: 'username', value: 'ada', type: 'string' }] },
				method: 'PUT',
				header: [],
				body: { mode: 'file', file: { src: '/tmp/data.bin' } },
				url: { raw: 'https://api.example.com/blob', protocol: 'https', host: ['api', 'example', 'com'], path: ['blob'] },
			},
			response: [],
		},
		{
			name: 'Query',
			request: {
				auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'tok', type: 'string' }, { key: 'tokenName', value: 'main', type: 'string' }] },
				method: 'POST',
				header: [],
				body: { mode: 'graphql', graphql: { query: 'query { me { id } }', variables: '{"a":1}' } },
				url: { raw: 'https://api.example.com/graphql', protocol: 'https', host: ['api', 'example', 'com'], path: ['graphql'] },
			},
			response: [],
		},
	],
	auth: { type: 'bearer', bearer: [{ key: 'token', value: 'root', type: 'string' }] },
	event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['// collection test'] } }],
	variable: [{ key: 'baseUrl', value: 'https://api.example.com' }, { key: 'old', value: 'x', disabled: true }],
};

suite('HTTP client: Postman files', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads a v2.1 collection', () => {
		assert.strictEqual(isPostmanCollection(V21), true);
		const collection = postmanToCollection(V21);
		assert.strictEqual(collection.format, 'postman');
		assert.strictEqual(collection.name, 'Shop API');
		assert.strictEqual(collection.description, 'Everything the shop does.');
		assert.deepStrictEqual(collection.variables, [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }, { key: 'old', value: 'x', enabled: false }]);
		assert.strictEqual(collection.auth.type, 'bearer');
		assert.strictEqual(collection.auth.token, 'root');
		assert.strictEqual(collection.scripts.test, '// collection test');

		const users = collection.items[0] as IHttpFolder;
		assert.strictEqual(users.kind, 'folder');
		assert.strictEqual(users.description, 'People');
		assert.deepStrictEqual([users.auth.type, users.auth.username, users.auth.password], ['basic', 'ada', 'secret']);
		assert.strictEqual(users.scripts.preRequest, 'console.log("folder");');

		const listUsers = users.items[0] as IHttpRequest;
		assert.strictEqual(listUsers.url, '{{baseUrl}}/users/:id?page=2');
		assert.strictEqual(listUsers.description, 'Lists users.');
		assert.strictEqual(listUsers.auth.type, 'inherit');
		assert.deepStrictEqual(listUsers.params, [{ key: 'page', value: '2', enabled: true }, { key: 'limit', value: '10', enabled: false, description: 'Page size' }]);
		assert.deepStrictEqual(listUsers.pathVariables, [{ key: 'id', value: '7', enabled: true, description: 'The user' }]);
		assert.deepStrictEqual(listUsers.headers, [{ key: 'Accept', value: 'application/json', enabled: true }, { key: 'X-Debug', value: '1', enabled: false, description: 'Verbose logs' }]);
		assert.strictEqual(listUsers.scripts.test, 'pm.test("ok", () => {\n  pm.response.to.have.status(200);\n});');

		const create = (users.items[1] as IHttpFolder).items[0] as IHttpRequest;
		assert.deepStrictEqual([create.auth.type, create.auth.token], ['bearer', '{{token}}']);
		assert.deepStrictEqual([create.body.mode, create.body.language, create.body.raw], ['raw', 'json', '{\n  "name": "Ada"\n}']);

		const [, login, upload, binary, query] = collection.items as IHttpRequest[];
		assert.strictEqual(login.auth.type, 'none');
		assert.deepStrictEqual(login.body.urlencoded, [{ key: 'user', value: 'ada', enabled: true }, { key: 'otp', value: '1', enabled: false }]);
		assert.deepStrictEqual([upload.auth.type, upload.auth.keyName, upload.auth.keyValue, upload.auth.keyIn], ['apikey', 'X-Key', 'k1', 'query']);
		assert.deepStrictEqual(upload.body.formdata, [{ key: 'title', value: 'Cat', enabled: true, type: 'text' }, { key: 'photo', value: '/tmp/cat.png', enabled: true, type: 'file' }]);
		assert.deepStrictEqual([binary.body.mode, binary.body.binaryPath, binary.auth.type], ['binary', '/tmp/data.bin', 'other']);
		assert.deepStrictEqual(binary.auth.raw, V21.item[3].request!.auth);
		assert.deepStrictEqual([query.body.mode, query.body.graphqlQuery, query.body.graphqlVariables], ['graphql', 'query { me { id } }', '{"a":1}']);
		assert.deepStrictEqual([query.auth.type, query.auth.token], ['oauth2', 'tok']);

		const ids = new Set<string>();
		const visit = (items: readonly IHttpItem[]) => items.forEach(item => {
			ids.add(item.id);
			if (item.kind === 'folder') {
				visit(item.items);
			}
		});
		visit(collection.items);
		assert.strictEqual(ids.size, 8, 'every item has its own id');
	});

	test('a v2.1 collection survives parse, serialize, parse', () => {
		const first = postmanToCollection(V21);
		const file = collectionToPostman(first);
		const second = postmanToCollection(JSON.parse(JSON.stringify(file)));
		assert.deepStrictEqual(withoutIds(second), withoutIds(first));

		// What the model does not hold is still in the file.
		const info = file.info as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(info), ['_postman_id', 'name', 'description', 'schema', '_exporter_id']);
		assert.strictEqual(info.schema, POSTMAN_SCHEMA_V21);
		const items = file.item as Record<string, unknown>[];
		const listUsers = (items[0].item as Record<string, unknown>[])[0];
		assert.deepStrictEqual(listUsers.response, [{ name: 'Example', code: 200, body: '[]' }]);
		assert.deepStrictEqual(listUsers.protocolProfileBehavior, { disableBodyPruning: true });
		assert.deepStrictEqual((listUsers.event as Record<string, unknown>[])[0].script, { type: 'text/javascript', packages: {}, exec: ['pm.test("ok", () => {', '  pm.response.to.have.status(200);', '});'] });
		assert.deepStrictEqual((listUsers.request as Record<string, unknown>).url, V21.item[0].item![0].request!.url);
		assert.deepStrictEqual(((items[0].item as Record<string, unknown>[])[1].item as Record<string, unknown>[])[0].request, V21.item[0].item![1].item![0].request);
		assert.deepStrictEqual((items[3].request as Record<string, unknown>).auth, V21.item[3].request!.auth, 'an auth type the editor does not edit is written back as it was');
		assert.deepStrictEqual((items[4].request as Record<string, unknown>).auth, V21.item[4].request!.auth, 'oauth2 keeps its other settings');
		assert.deepStrictEqual(file.variable, [{ key: 'baseUrl', value: 'https://api.example.com' }, { key: 'old', value: 'x', disabled: true }]);
		assert.deepStrictEqual(Object.keys(file), ['info', 'item', 'auth', 'event', 'variable']);
	});

	test('every authorization type Postman has maps to the model and back, unknown keys and value types included', () => {
		const auths: Record<string, unknown>[] = [
			{ type: 'jwt', jwt: [{ key: 'algorithm', value: 'RS256', type: 'string' }, { key: 'isSecretBase64Encoded', value: false, type: 'boolean' }, { key: 'payload', value: '{"sub":"{{user}}"}', type: 'string' }, { key: 'addTokenTo', value: 'header', type: 'string' }, { key: 'headerPrefix', value: 'Bearer', type: 'string' }, { key: 'queryParamKey', value: 'token', type: 'string' }, { key: 'header', value: '{}', type: 'string' }, { key: 'privateKey', value: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', type: 'string' }] },
			{ type: 'digest', digest: [{ key: 'username', value: 'ada', type: 'string' }, { key: 'password', value: 'pw', type: 'string' }, { key: 'algorithm', value: 'SHA-256', type: 'string' }, { key: 'disableRetryRequest', value: true, type: 'boolean' }, { key: 'nonceCount', value: 3, type: 'number' }] },
			{ type: 'oauth1', oauth1: [{ key: 'consumerKey', value: 'ck', type: 'string' }, { key: 'consumerSecret', value: 'cs', type: 'string' }, { key: 'signatureMethod', value: 'HMAC-SHA256', type: 'string' }, { key: 'addParamsToHeader', value: true, type: 'boolean' }, { key: 'addEmptyParamsToSign', value: false, type: 'boolean' }, { key: 'version', value: '1.0', type: 'string' }, { key: 'someFutureKey', value: 'kept', type: 'any' }] },
			{ type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'tok', type: 'string' }, { key: 'headerPrefix', value: 'Token', type: 'string' }, { key: 'addTokenTo', value: 'queryParams', type: 'string' }, { key: 'grant_type', value: 'client_credentials', type: 'string' }, { key: 'accessTokenUrl', value: 'https://id.test/token', type: 'string' }, { key: 'clientId', value: 'id', type: 'string' }, { key: 'clientSecret', value: 'cs', type: 'string' }, { key: 'useBrowser', value: true, type: 'boolean' }, { key: 'tokenName', value: 'main', type: 'string' }] },
			{ type: 'hawk', hawk: [{ key: 'authId', value: 'id', type: 'string' }, { key: 'authKey', value: 'key', type: 'string' }, { key: 'algorithm', value: 'sha256', type: 'string' }, { key: 'includePayloadHash', value: true, type: 'boolean' }] },
			{ type: 'awsv4', awsv4: [{ key: 'accessKey', value: 'AK', type: 'string' }, { key: 'secretKey', value: 'SK', type: 'string' }, { key: 'region', value: 'eu-west-1', type: 'string' }, { key: 'service', value: 's3', type: 'string' }, { key: 'sessionToken', value: '', type: 'string' }, { key: 'addAuthDataToQuery', value: false, type: 'boolean' }] },
			{ type: 'ntlm', ntlm: [{ key: 'username', value: 'ada', type: 'string' }, { key: 'password', value: 'pw', type: 'string' }, { key: 'domain', value: 'CORP', type: 'string' }, { key: 'workstation', value: 'PC', type: 'string' }] },
			{ type: 'edgegrid', edgegrid: [{ key: 'accessToken', value: 'at', type: 'string' }, { key: 'clientToken', value: 'ct', type: 'string' }, { key: 'clientSecret', value: 'cs', type: 'string' }, { key: 'headersToSign', value: 'X-A', type: 'string' }, { key: 'maxBodySize', value: '2048', type: 'string' }] },
			{ type: 'asap', asap: [{ key: 'alg', value: 'RS256', type: 'string' }, { key: 'kid', value: 'k1', type: 'string' }, { key: 'iss', value: 'svc', type: 'string' }, { key: 'aud', value: 'other', type: 'string' }, { key: 'privateKey', value: 'pem', type: 'string' }, { key: 'claims', value: '{}', type: 'string' }, { key: 'exp', value: '1h', type: 'string' }] },
		];
		const file = { info: { name: 'Auths', schema: POSTMAN_SCHEMA_V21 }, item: auths.map(auth => ({ name: String(auth.type), request: { method: 'GET', url: 'https://example.com', auth } })) };
		const collection = postmanToCollection(file);
		const requests = collection.items as IHttpRequest[];
		assert.deepStrictEqual(requests.map(request => request.auth.type), ['jwt', 'digest', 'oauth1', 'oauth2', 'hawk', 'awsv4', 'ntlm', 'edgegrid', 'asap']);
		assert.deepStrictEqual(requests[1].auth.params, { username: 'ada', password: 'pw', algorithm: 'SHA-256', disableRetryRequest: 'true', nonceCount: '3' }, 'booleans and numbers are text in the model');
		assert.deepStrictEqual([requests[3].auth.token, requests[3].auth.params?.accessToken, requests[3].auth.params?.headerPrefix, requests[3].auth.params?.addTokenTo], ['tok', undefined, 'Token', 'queryParams']);
		assert.strictEqual(requests[2].auth.params?.someFutureKey, 'kept');
		assert.strictEqual(requests[0].auth.params?.isSecretBase64Encoded, 'false');

		const written = collectionToPostman(collection).item as Record<string, unknown>[];
		assert.deepStrictEqual(written.map(item => (item.request as Record<string, unknown>).auth), auths, 'unedited, every setting is written as it was');

		// Edited: a changed value is written, a new boolean is a boolean, the untouched rows stay as they were.
		requests[2].auth.params = { ...requests[2].auth.params, consumerKey: 'ck2', includeBodyHash: 'true', addParamsToHeader: 'false' };
		requests[4].auth = { ...requests[4].auth, type: 'ntlm', params: { username: 'u', password: 'p' }, raw: undefined };
		const edited = collectionToPostman(collection).item as Record<string, unknown>[];
		assert.deepStrictEqual((edited[2].request as Record<string, unknown>).auth, {
			type: 'oauth1', oauth1: [{ key: 'consumerKey', value: 'ck2', type: 'string' }, { key: 'consumerSecret', value: 'cs', type: 'string' }, { key: 'signatureMethod', value: 'HMAC-SHA256', type: 'string' }, { key: 'addParamsToHeader', value: false, type: 'boolean' }, { key: 'addEmptyParamsToSign', value: false, type: 'boolean' }, { key: 'version', value: '1.0', type: 'string' }, { key: 'someFutureKey', value: 'kept', type: 'any' }, { key: 'includeBodyHash', value: true, type: 'boolean' }],
		});
		assert.deepStrictEqual((edited[4].request as Record<string, unknown>).auth, { type: 'ntlm', ntlm: [{ key: 'username', value: 'u', type: 'string' }, { key: 'password', value: 'p', type: 'string' }] });

		// v2.0 writes an auth's settings as an object.
		const v20 = postmanToCollection({ info: { name: 'Old', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }, item: [{ name: 'a', request: { method: 'GET', url: 'https://example.com', auth: { type: 'hawk', hawk: { authId: 'id', authKey: 'key', includePayloadHash: true } } } }] });
		const hawk = (v20.items[0] as IHttpRequest).auth;
		assert.deepStrictEqual([hawk.type, hawk.params], ['hawk', { authId: 'id', authKey: 'key', includePayloadHash: 'true' }]);
		assert.deepStrictEqual(((collectionToPostman(v20).item as Record<string, unknown>[])[0].request as Record<string, unknown>).auth, { type: 'hawk', hawk: [{ key: 'authId', value: 'id', type: 'string' }, { key: 'authKey', value: 'key', type: 'string' }, { key: 'includePayloadHash', value: true, type: 'boolean' }] });
	});

	test('writes what was edited, and leaves out what is empty', () => {
		const collection = postmanToCollection({ info: { name: 'Small' }, item: [{ name: 'Ping', request: 'https://example.com/ping?a=1' }] });
		const ping = collection.items[0] as IHttpRequest;
		assert.deepStrictEqual([ping.method, ping.url], ['GET', 'https://example.com/ping?a=1']);
		assert.deepStrictEqual(ping.params, [{ key: 'a', value: '1', enabled: true }]);
		ping.params.push({ key: 'b', value: '2', enabled: false });
		ping.scripts.test = 'pm.test("x", () => {});';
		const file = collectionToPostman(collection);
		assert.deepStrictEqual(file, {
			info: { name: 'Small', schema: POSTMAN_SCHEMA_V21 },
			item: [{
				name: 'Ping',
				event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("x", () => {});'] } }],
				request: {
					method: 'GET',
					header: [],
					url: { raw: 'https://example.com/ping?a=1', protocol: 'https', host: ['example', 'com'], path: ['ping'], query: [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }] },
				},
				response: [],
			}],
			auth: { type: 'noauth' },
		});
	});

	test('reads a v2.0 collection', () => {
		const collection = postmanToCollection({
			info: { name: 'Old', description: { content: 'From 2.0', type: 'text/plain' }, schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
			auth: { type: 'basic', basic: { username: 'u', password: 'p' } },
			item: [{
				name: 'Search',
				request: {
					auth: { type: 'bearer', bearer: { token: 't0' } },
					method: 'post',
					header: 'Content-Type: application/json\n//X-Off: 1\n',
					url: 'https://example.com/search?q=cats',
					body: { mode: 'raw', raw: '{"q":"cats"}' },
					description: { content: 'Finds things' },
				},
			}, {
				name: 'Parts',
				request: { method: 'GET', url: { protocol: 'https', host: 'example.com', path: ['a', 'b'], query: [{ key: 'x', value: '1' }, { key: 'y', value: '2', disabled: true }] } },
			}],
		});
		assert.strictEqual(collection.description, 'From 2.0');
		assert.deepStrictEqual([collection.auth.type, collection.auth.username, collection.auth.password], ['basic', 'u', 'p']);
		const [search, parts] = collection.items as IHttpRequest[];
		assert.deepStrictEqual([search.method, search.url, search.description], ['POST', 'https://example.com/search?q=cats', 'Finds things']);
		assert.deepStrictEqual([search.auth.type, search.auth.token], ['bearer', 't0']);
		assert.deepStrictEqual(search.headers, [{ key: 'Content-Type', value: 'application/json', enabled: true }, { key: 'X-Off', value: '1', enabled: false }]);
		assert.deepStrictEqual([search.body.mode, search.body.language], ['raw', 'json']);
		assert.strictEqual(parts.url, 'https://example.com/a/b?x=1');
		assert.deepStrictEqual(parts.params, [{ key: 'x', value: '1', enabled: true }, { key: 'y', value: '2', enabled: false }]);
		assert.strictEqual((collectionToPostman(collection).info as Record<string, unknown>).schema, POSTMAN_SCHEMA_V21, 'saved as v2.1');
	});

	test('refuses what is not a collection', () => {
		assert.strictEqual(isPostmanCollection({ name: 'env', values: [] }), false);
		assert.strictEqual(isPostmanCollection(null), false);
		assert.throws(() => postmanToCollection({ openapi: '3.0.0' }), /Not a Postman collection/);
	});

	test('environments round trip', () => {
		const file = {
			id: 'env-1',
			name: 'Staging',
			values: [
				{ key: 'baseUrl', value: 'https://staging.example.com', type: 'default', enabled: true },
				{ key: 'token', value: 's3cret', type: 'secret', enabled: true },
				{ key: 'off', value: '', type: 'default', enabled: false },
			],
			_postman_variable_scope: 'environment',
			_postman_exported_at: '2026-01-01T00:00:00.000Z',
		};
		assert.strictEqual(isPostmanEnvironment(file), true);
		assert.strictEqual(isPostmanEnvironment(V21), false);
		const environment = postmanToEnvironment(file);
		assert.deepStrictEqual([environment.format, environment.name], ['postman', 'Staging']);
		assert.deepStrictEqual(environment.variables, [
			{ key: 'baseUrl', value: 'https://staging.example.com', enabled: true },
			{ key: 'token', value: 's3cret', enabled: true, secret: true },
			{ key: 'off', value: '', enabled: false },
		]);
		assert.deepStrictEqual(environmentToPostman(environment), file);

		const globals = { values: [{ key: 'g', value: '1' }], _postman_variable_scope: 'globals' };
		assert.strictEqual(isPostmanEnvironment(globals), true);
		assert.strictEqual(postmanToEnvironment(globals).name, 'Globals');
		assert.deepStrictEqual(environmentToPostman({ format: 'postman', name: 'New', variables: [{ key: 'a', value: '1', enabled: true }] }), {
			name: 'New',
			values: [{ key: 'a', value: '1', type: 'default', enabled: true }],
			_postman_variable_scope: 'environment',
		});
		assert.throws(() => postmanToEnvironment({ name: 'x' }), /Not a Postman environment/);
	});
});
