/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { httpRequestsOf, IHttpFolder, IHttpRequest } from '../../common/httpCollection.js';
import { curlToRequest, detectHttpImport, isOpenApi, openApiToCollection } from '../../common/httpImport.js';

const OPENAPI3 = {
	openapi: '3.0.3',
	info: { title: 'Pet Store', description: 'Pets, mostly.' },
	servers: [{ url: 'https://{region}.pets.example.com/v1/', variables: { region: { default: 'eu' } } }],
	tags: [{ name: 'pets', description: 'Everything about pets' }],
	components: {
		securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
		parameters: { Limit: { name: 'limit', in: 'query', description: 'Page size', schema: { type: 'integer', default: 20 } } },
		schemas: {
			Pet: {
				type: 'object',
				properties: {
					id: { type: 'integer', readOnly: true },
					name: { type: 'string', example: 'Rex' },
					kind: { type: 'string', enum: ['dog', 'cat'] },
					owner: { $ref: '#/components/schemas/Owner' },
					tags: { type: 'array', items: { type: 'string' } },
				},
			},
			Owner: { type: 'object', properties: { email: { type: 'string', format: 'email' }, pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } },
		},
	},
	paths: {
		'/pets': {
			parameters: [{ $ref: '#/components/parameters/Limit' }],
			get: {
				tags: ['pets'],
				summary: 'List pets',
				parameters: [{ name: 'status', in: 'query', required: true, schema: { type: 'string', enum: ['available', 'sold'] } }, { name: 'X-Trace', in: 'header', schema: { type: 'string' } }],
			},
			post: {
				tags: ['pets'],
				operationId: 'createPet',
				description: 'Adds a pet.',
				requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
			},
		},
		'/pets/{petId}/photo': {
			put: {
				tags: ['pets'],
				parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' }, example: '42' }],
				requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { caption: { type: 'string' }, file: { type: 'string', format: 'binary' } } } } } },
			},
		},
		'/health': { get: {} },
	},
};

const SWAGGER2 = {
	swagger: '2.0',
	info: { title: 'Orders' },
	host: 'orders.example.com',
	basePath: '/api',
	schemes: ['http', 'https'],
	securityDefinitions: { key: { type: 'apiKey', name: 'X-API-Key', in: 'header' } },
	definitions: { Order: { type: 'object', properties: { sku: { type: 'string' }, count: { type: 'integer' }, rush: { type: 'boolean' } } } },
	paths: {
		'/orders': {
			post: { summary: 'Create order', parameters: [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Order' } }] },
		},
		'/orders/{id}/cancel': {
			post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }, { name: 'reason', in: 'formData', type: 'string', required: true }] },
		},
	},
};

suite('HTTP client: import', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('cURL: a plain GET with headers and quotes', () => {
		const request = curlToRequest(`curl 'https://api.example.com/users?page=2' -H "Accept: application/json" -H 'X-Note: it'\\''s fine' --compressed -sS`)!;
		assert.deepStrictEqual([request.name, request.method, request.url], ['', 'GET', 'https://api.example.com/users?page=2']);
		assert.deepStrictEqual(request.params, [{ key: 'page', value: '2', enabled: true }]);
		assert.deepStrictEqual(request.headers, [{ key: 'Accept', value: 'application/json', enabled: true }, { key: 'X-Note', value: 'it\'s fine', enabled: true }]);
		assert.strictEqual(request.body.mode, 'none');
	});

	test('cURL: a multi-line POST with a JSON body and a bearer token', () => {
		const request = curlToRequest([
			'curl --location --request POST "https://api.example.com/users" \\',
			'  --header \'Content-Type: application/json\' \\',
			'  --header \'Authorization: Bearer abc.def\' \\',
			'  --data-raw \'{',
			'    "name": "Ada \\"the first\\""',
			'}\'',
		].join('\n'))!;
		assert.deepStrictEqual([request.method, request.url], ['POST', 'https://api.example.com/users']);
		assert.deepStrictEqual([request.auth.type, request.auth.token], ['bearer', 'abc.def']);
		assert.deepStrictEqual([request.body.mode, request.body.language], ['raw', 'json']);
		assert.strictEqual(request.body.raw, '{\n    "name": "Ada \\"the first\\""\n}');
		assert.deepStrictEqual(request.headers, [], 'the content type and the auth are the body\'s and the auth\'s to say');
	});

	test('cURL: -d without a content type is a form, and POST', () => {
		const request = curlToRequest('curl https://example.com/login -d user=ada -d "pass=p w" --data-urlencode "note=a&b"')!;
		assert.strictEqual(request.method, 'POST');
		assert.strictEqual(request.body.mode, 'urlencoded');
		assert.deepStrictEqual(request.body.urlencoded, [{ key: 'user', value: 'ada', enabled: true }, { key: 'pass', value: 'p w', enabled: true }, { key: 'note', value: 'a&b', enabled: true }]);
	});

	test('cURL: --json, -u, -G, -I, -F and attached short flags', () => {
		const json = curlToRequest('curl --json \'{"a":1}\' -u ada:s3:cret https://example.com/a')!;
		assert.deepStrictEqual([json.method, json.body.mode, json.body.language, json.body.raw], ['POST', 'raw', 'json', '{"a":1}']);
		assert.deepStrictEqual([json.auth.type, json.auth.username, json.auth.password], ['basic', 'ada', 's3:cret']);
		assert.deepStrictEqual(json.headers, [{ key: 'Accept', value: 'application/json', enabled: true }]);

		const get = curlToRequest('curl -G https://example.com/search -d q=cats --data-urlencode "tag=a b" -H"X-A:1"')!;
		assert.deepStrictEqual([get.method, get.url, get.body.mode], ['GET', 'https://example.com/search?q=cats&tag=a%20b', 'none']);
		assert.deepStrictEqual(get.headers, [{ key: 'X-A', value: '1', enabled: true }]);

		assert.strictEqual(curlToRequest('curl -I https://example.com')!.method, 'HEAD');
		assert.strictEqual(curlToRequest('curl -XDELETE -o /dev/null --max-time 5 https://example.com/x')!.method, 'DELETE');
		assert.strictEqual(curlToRequest('curl --unknown-flag value https://example.com/y')!.url, 'https://example.com/y');
		assert.strictEqual(curlToRequest('curl --url=https://example.com/z -A agent/1.0')!.headers[0].value, 'agent/1.0');

		const form = curlToRequest('curl -F "title=Cat" -F photo=@/tmp/cat.png;type=image/png -H "Content-Type: multipart/form-data" https://example.com/upload')!;
		assert.deepStrictEqual([form.method, form.body.mode], ['POST', 'formdata']);
		assert.deepStrictEqual(form.body.formdata, [{ key: 'title', value: 'Cat', enabled: true, type: 'text' }, { key: 'photo', value: '/tmp/cat.png', enabled: true, type: 'file' }]);
		assert.deepStrictEqual(form.headers, []);
	});

	test('cURL: Windows continuations, $\'...\' and what is not cURL', () => {
		const windows = curlToRequest('curl "https://example.com/a" ^\r\n  -H "Accept: */*" ^\r\n  -X PUT')!;
		assert.deepStrictEqual([windows.method, windows.url, windows.headers.length], ['PUT', 'https://example.com/a', 1]);
		const ansi = curlToRequest(`curl https://example.com/b -H 'Content-Type: text/plain' --data-binary $'line one\\nit\\'s two'`)!;
		assert.deepStrictEqual([ansi.body.mode, ansi.body.language, ansi.body.raw], ['raw', 'text', 'line one\nit\'s two']);
		assert.strictEqual(curlToRequest('wget https://example.com'), undefined);
		assert.strictEqual(curlToRequest('curl -s'), undefined);
	});

	test('OpenAPI 3', () => {
		assert.strictEqual(isOpenApi(OPENAPI3), true);
		const collection = openApiToCollection(OPENAPI3);
		assert.deepStrictEqual([collection.format, collection.name, collection.description], ['postman', 'Pet Store', 'Pets, mostly.']);
		assert.deepStrictEqual(collection.variables, [{ key: 'baseUrl', value: 'https://eu.pets.example.com/v1', enabled: true }, { key: 'bearerToken', value: '', enabled: true }]);
		assert.deepStrictEqual([collection.auth.type, collection.auth.token], ['bearer', '{{bearerToken}}']);
		assert.deepStrictEqual(collection.items.map(item => `${item.kind}:${item.name}`), ['folder:pets', 'request:GET /health']);

		const pets = collection.items[0] as IHttpFolder;
		assert.strictEqual(pets.description, 'Everything about pets');
		const [listPets, create, photo] = pets.items as IHttpRequest[];
		assert.deepStrictEqual([listPets.name, listPets.method, listPets.url, listPets.auth.type], ['List pets', 'GET', '{{baseUrl}}/pets?status=available', 'inherit']);
		assert.deepStrictEqual(listPets.params, [{ key: 'limit', value: '20', enabled: false, description: 'Page size' }, { key: 'status', value: 'available', enabled: true }]);
		assert.deepStrictEqual(listPets.headers, [{ key: 'X-Trace', value: '', enabled: false }]);

		assert.deepStrictEqual([create.name, create.method, create.description, create.body.mode, create.body.language], ['createPet', 'POST', 'Adds a pet.', 'raw', 'json']);
		assert.deepStrictEqual(JSON.parse(create.body.raw), { name: 'Rex', kind: 'dog', owner: { email: 'user@example.com', pets: [] }, tags: ['string'] });

		assert.deepStrictEqual([photo.name, photo.url], ['PUT /pets/{petId}/photo', '{{baseUrl}}/pets/:petId/photo']);
		assert.deepStrictEqual(photo.pathVariables, [{ key: 'petId', value: '42', enabled: true }]);
		assert.deepStrictEqual([photo.body.mode, photo.body.formdata], ['formdata', [{ key: 'caption', value: 'string', enabled: true, type: 'text' }, { key: 'file', value: '', enabled: true, type: 'file' }]]);
	});

	test('Swagger 2', () => {
		const collection = openApiToCollection(SWAGGER2);
		assert.strictEqual(collection.name, 'Orders');
		assert.deepStrictEqual(collection.variables, [{ key: 'baseUrl', value: 'https://orders.example.com/api', enabled: true }, { key: 'apiKey', value: '', enabled: true }]);
		assert.deepStrictEqual([collection.auth.type, collection.auth.keyName, collection.auth.keyValue, collection.auth.keyIn], ['apikey', 'X-API-Key', '{{apiKey}}', 'header']);
		const [create, cancel] = collection.items as IHttpRequest[];
		assert.deepStrictEqual([create.name, create.url, create.body.mode], ['Create order', '{{baseUrl}}/orders', 'raw']);
		assert.deepStrictEqual(JSON.parse(create.body.raw), { sku: 'string', count: 0, rush: false });
		assert.deepStrictEqual([cancel.name, cancel.url], ['POST /orders/{id}/cancel', '{{baseUrl}}/orders/:id/cancel']);
		assert.deepStrictEqual(cancel.pathVariables, [{ key: 'id', value: '', enabled: true }]);
		assert.deepStrictEqual([cancel.body.mode, cancel.body.urlencoded], ['urlencoded', [{ key: 'reason', value: '', enabled: true }]]);
		assert.throws(() => openApiToCollection({ info: {} }), /Not an OpenAPI/);
	});

	test('detects what a text is', () => {
		const postman = detectHttpImport(JSON.stringify({ info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'R', request: { method: 'GET', url: 'https://example.com' } }] }));
		assert.ok(postman.kind === 'collection' && postman.source === 'postman' && postman.collection.name === 'C');

		const environment = detectHttpImport(JSON.stringify({ name: 'Local', values: [{ key: 'a', value: '1', enabled: true }], _postman_variable_scope: 'environment' }));
		assert.ok(environment.kind === 'environment' && environment.environment.name === 'Local' && environment.environment.variables.length === 1);

		const openapi = detectHttpImport(JSON.stringify(OPENAPI3));
		assert.ok(openapi.kind === 'collection' && openapi.source === 'openapi' && httpRequestsOf(openapi.collection.items).length === 4);

		const yaml = detectHttpImport([
			'openapi: 3.0.0',
			'info:',
			'  title: Yaml API',
			'servers:',
			'  - url: https://yaml.example.com',
			'paths:',
			'  /things/{id}:',
			'    get:',
			'      summary: Get thing',
			'      parameters:',
			'        - name: id',
			'          in: path',
			'          required: true',
			'          schema:',
			'            type: string',
		].join('\n'), 'api.yaml');
		assert.ok(yaml.kind === 'collection' && yaml.source === 'openapi');
		const thing = yaml.kind === 'collection' ? yaml.collection.items[0] as IHttpRequest : undefined;
		assert.deepStrictEqual([thing?.name, thing?.url], ['Get thing', '{{baseUrl}}/things/:id']);
		assert.strictEqual(yaml.kind === 'collection' && yaml.collection.variables[0].value, 'https://yaml.example.com');

		const har = detectHttpImport(JSON.stringify({
			log: {
				entries: [
					{ request: { method: 'POST', url: 'https://example.com/api?x=1', headers: [{ name: ':authority', value: 'example.com' }, { name: 'Content-Type', value: 'application/json' }, { name: 'Content-Length', value: '7' }, { name: 'X-A', value: '1' }], postData: { mimeType: 'application/json', text: '{"a":1}' } } },
					{ request: { method: 'GET', url: 'https://example.com/b', headers: [] } },
				],
			},
		}), 'session.har');
		assert.ok(har.kind === 'collection' && har.source === 'har' && har.collection.name === 'session');
		const posted = har.kind === 'collection' ? har.collection.items[0] as IHttpRequest : undefined;
		assert.deepStrictEqual([posted?.method, posted?.url, posted?.body.mode, posted?.body.raw], ['POST', 'https://example.com/api?x=1', 'raw', '{"a":1}']);
		assert.deepStrictEqual(posted?.headers, [{ key: 'X-A', value: '1', enabled: true }]);

		const curl = detectHttpImport('  curl -X PATCH https://example.com/c\n');
		assert.ok(curl.kind === 'request' && curl.source === 'curl' && curl.request.method === 'PATCH');

		const http = detectHttpImport('@host = https://example.com\n\n### Ping\nGET {{host}}/ping\n\n###\nPOST {{host}}/echo\nContent-Type: application/json\n\n{"a":1}\n', 'requests.http');
		assert.ok(http.kind === 'collection' && http.source === 'http' && http.collection.format === 'http' && http.collection.name === 'requests');
		assert.strictEqual(http.kind === 'collection' && httpRequestsOf(http.collection.items).length, 2);

		assert.strictEqual(detectHttpImport('   ').kind, 'unknown');
		assert.strictEqual(detectHttpImport('{"dev":{"host":"x"}}').kind, 'unknown');
		assert.strictEqual(detectHttpImport('{ not json').kind, 'unknown');
		assert.strictEqual(detectHttpImport('just some words, nothing more').kind, 'unknown');
		assert.strictEqual(detectHttpImport('curl -s').kind, 'unknown');
	});
});
