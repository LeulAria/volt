/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { convertHttpRequest, httpWireRequest, IHttpRequest, newHttpRequest } from '../../common/httpCollection.js';
import { collectionToHttpFile, httpFileToCollection } from '../../common/httpDotHttp.js';
import { collectionToPostman, postmanToCollection } from '../../common/httpPostman.js';
import { graphqlOperationName, httpAiAnswerOf, httpAiBodyOf, httpAiPromptFromBody, httpGrpcTarget, httpGrpcUrl, httpMcpResponseBody, httpMessagesFromBody, httpMessagesToBody, httpRequestBadge, httpScriptFromAnswer, prettyGraphql } from '../../common/httpProtocols.js';

const SAMPLE = [
	'@baseUrl = http://localhost:9992',
	'',
	'### HTTP',
	'GET {{baseUrl}}/users',
	'Authorization: Bearer {{token}}',
	'',
	'### GraphQL',
	'GRAPHQL {{baseUrl}}/graphql',
	'',
	'query GetUsers {',
	'  users {',
	'    id',
	'    name',
	'  }',
	'}',
	'',
	'{ "first": 2 }',
	'',
	'### WebSocket',
	'WS {{wsUrl}}/events',
	'',
	'>>>',
	'{',
	'  "type": "subscribe",',
	'  "channel": "users"',
	'}',
	'',
	'>>>',
	'ping',
	'',
	'### SSE',
	'SSE {{baseUrl}}/events',
	'',
	'### MCP - Initialize',
	'MCP {{mcpUrl}}',
	'',
	'{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }',
	'',
	'### MCP - List Tools',
	'MCP SEND',
	'',
	'{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }',
	'',
	'### Chat',
	'SOCKETIO http://localhost:9990/admin',
	'# @engine-path /socket.io',
	'',
	'>>> hello',
	'{ "name": "Ada" }',
	'',
	'### Sensors',
	'# @subscribe sensors/#',
	'# @subscribe alerts/+',
	'# @client-id volt-test',
	'MQTT mqtt://localhost:9991',
	'Authorization: Basic ada:secret',
	'',
	'>>> sensors/1/set',
	'21.5',
	'',
	'### GetUser',
	'# @proto ./users.proto',
	'GRPC localhost:9995/demo.users.v1.UserService/GetUser',
	'x-trace: abc',
	'',
	'{ "id": "7" }',
	'',
].join('\n');

suite('Volt Client: kinds of request', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const requestsOf = (text: string) => httpFileToCollection(text, 'api').items.filter((item): item is IHttpRequest => item.kind === 'request');

	test('an .http file names each kind on its request line, with messages after >>>', () => {
		const requests = requestsOf(SAMPLE);
		assert.deepStrictEqual(requests.map(request => `${httpRequestBadge(request)} ${request.name}`), ['GET HTTP', 'GQL GraphQL', 'WS WebSocket', 'SSE SSE', 'MCP MCP - Initialize', 'MCP MCP - List Tools', 'IO Chat', 'MQTT Sensors', 'gRPC GetUser']);
		const [, graphql, ws, sse, mcpInit, mcpList, io, mqtt, grpc] = requests;
		assert.strictEqual(graphql.body.mode, 'graphql');
		assert.match(graphql.body.graphqlQuery, /^query GetUsers \{[\s\S]*\}$/);
		assert.strictEqual(graphql.body.graphqlVariables.trim(), '{ "first": 2 }');
		assert.deepStrictEqual(ws.messages, [{ body: '{\n  "type": "subscribe",\n  "channel": "users"\n}' }, { body: 'ping' }]);
		assert.strictEqual(sse.method, 'GET');
		assert.strictEqual(mcpInit.url, '{{mcpUrl}}');
		assert.strictEqual(mcpList.url, '{{mcpUrl}}', 'MCP SEND talks to the server of the block above');
		assert.deepStrictEqual(io.messages, [{ target: 'hello', body: '{ "name": "Ada" }' }]);
		assert.deepStrictEqual(io.options, { path: '/socket.io' });
		assert.deepStrictEqual(mqtt.options, { subscribe: 'sensors/#\nalerts/+', clientId: 'volt-test' });
		assert.deepStrictEqual(mqtt.messages, [{ target: 'sensors/1/set', body: '21.5' }]);
		assert.strictEqual(mqtt.auth.type, 'basic');
		assert.strictEqual(grpc.options?.proto, './users.proto');
		assert.strictEqual(grpc.body.raw, '{ "id": "7" }');
		assert.deepStrictEqual(grpc.headers.map(row => row.key), ['x-trace']);
		assert.deepStrictEqual(httpGrpcTarget(grpc.url), { address: 'localhost:9995', service: 'demo.users.v1.UserService', method: 'GetUser' });
	});

	test('untouched blocks are written back as they were; a changed one in its kind\'s own form', () => {
		const collection = httpFileToCollection(SAMPLE, 'api');
		assert.strictEqual(collectionToHttpFile(collection), SAMPLE);

		const requests = collection.items.filter((item): item is IHttpRequest => item.kind === 'request');
		requests[2].messages!.push({ body: 'bye' });
		requests[5].body.raw = '{ "jsonrpc": "2.0", "id": 3, "method": "ping" }';
		requests[7].options!.qos = '1';
		const text = collectionToHttpFile(collection);
		assert.match(text, /WS \{\{wsUrl\}\}\/events\n\n>>>\n\{\n {2}"type": "subscribe",\n {2}"channel": "users"\n\}\n\n>>>\nping\n\n>>>\nbye\n/);
		assert.match(text, /MCP SEND\n\n\{ "jsonrpc": "2\.0", "id": 3, "method": "ping" \}/, 'still SEND: same server as the block above');
		assert.match(text, /# @subscribe sensors\/#\n# @subscribe alerts\/\+\n# @client-id volt-test\n# @qos 1\n# @name Sensors\nMQTT mqtt:\/\/localhost:9991\nAuthorization: Basic ada:secret\n\n>>> sensors\/1\/set\n21\.5/);
		// And what was written reads back the same.
		const again = requestsOf(text);
		assert.deepStrictEqual(again[2].messages, requests[2].messages);
		assert.deepStrictEqual(again[7].options, requests[7].options);
		assert.strictEqual(again[5].url, '{{mcpUrl}}');
	});

	test('a Postman collection keeps the kind, messages and options in the item\'s volt key', () => {
		const ws = newHttpRequest('ws', 'Events', 'none');
		ws.url = 'ws://localhost:9988';
		ws.messages = [{ body: '{"type":"subscribe"}' }];
		const mqtt = newHttpRequest('mqtt', 'Sensors', 'none');
		mqtt.url = 'mqtt://localhost:9991';
		mqtt.options = { subscribe: 'a/#' };
		const plain = newHttpRequest('http', 'Health', 'none');
		const collection = postmanToCollection({ info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] });
		collection.items.push(ws, mqtt, plain);
		const json = collectionToPostman(collection) as { item: { volt?: unknown }[] };
		assert.deepStrictEqual(json.item.map(item => item.volt), [{ protocol: 'ws', messages: [{ body: '{"type":"subscribe"}' }] }, { protocol: 'mqtt', options: { subscribe: 'a/#' } }, undefined]);
		const back = postmanToCollection(JSON.parse(JSON.stringify(json))).items as IHttpRequest[];
		assert.deepStrictEqual(back.map(item => [item.protocol, item.messages, item.options]), [['ws', [{ body: '{"type":"subscribe"}' }], undefined], ['mqtt', undefined, { subscribe: 'a/#' }], [undefined, undefined, undefined]]);
	});

	test('what goes out: GraphQL names its operation, MCP accepts both answer forms, SOAP is text/xml', () => {
		const graphql = newHttpRequest('graphql', '', 'none');
		graphql.url = 'http://x/graphql';
		graphql.body.graphqlQuery = 'query GetUsers($first: Int) { users(first: $first) { id } }';
		graphql.body.graphqlVariables = '{ "first": 2 }';
		const wire = httpWireRequest(graphql).spec;
		assert.strictEqual(wire.method, 'POST');
		assert.deepStrictEqual(JSON.parse(wire.body!), { query: graphql.body.graphqlQuery, variables: { first: 2 }, operationName: 'GetUsers' });
		assert.strictEqual(graphqlOperationName('query A { a } query B { b }'), undefined, 'two operations: the server is not told which');

		const mcp = httpWireRequest(newHttpRequest('mcp', '', 'none')).spec;
		assert.deepStrictEqual(mcp.headers, [['Accept', 'application/json, text/event-stream'], ['Content-Type', 'application/json']]);
		assert.strictEqual(JSON.parse(mcp.body!).method, 'tools/list');

		const soap = httpWireRequest(newHttpRequest('soap', '', 'none')).spec;
		assert.deepStrictEqual(soap.headers, [['SOAPAction', ''], ['Content-Type', 'text/xml; charset=utf-8']]);

		const ai = newHttpRequest('ai', '', 'none');
		assert.strictEqual(ai.auth.token, '{{OPENAI_API_KEY}}');
		convertHttpRequest(ai, 'http');
		assert.strictEqual(ai.protocol, undefined);
		assert.strictEqual(ai.method, 'POST');
	});

	test('messages, GraphQL layout, MCP event streams, AI bodies and gRPC targets', () => {
		assert.deepStrictEqual(httpMessagesFromBody('first\n===\nsecond\n=== wait-for-server\n>>> topic/a\nthird'), [{ body: 'first' }, { body: 'second' }, { target: 'topic/a', body: 'third' }]);
		assert.strictEqual(httpMessagesToBody([{ body: 'a' }, { target: 't', body: 'b' }]), '>>>\na\n\n>>> t\nb');
		assert.strictEqual(prettyGraphql('query {\ncontinent(code: "EU") {\nid\ncode\n}\n}'), 'query {\n  continent(code: "EU") {\n    id\n    code\n  }\n}');

		const stream = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
		assert.strictEqual(httpMcpResponseBody('text/event-stream', stream, 2), '{"jsonrpc":"2.0","id":2,"result":{"ok":true}}');
		assert.strictEqual(httpMcpResponseBody('application/json', '{"a":1}', 2), '{"a":1}');

		const anthropic = httpAiBodyOf({ provider: 'anthropic', model: 'claude-sonnet-5-5', system: 'Be brief', prompt: 'Hi' });
		assert.deepStrictEqual(JSON.parse(anthropic), { model: 'claude-sonnet-5-5', max_tokens: 1024, system: 'Be brief', messages: [{ role: 'user', content: 'Hi' }] });
		assert.deepStrictEqual(httpAiPromptFromBody('https://api.anthropic.com/v1/messages', anthropic), { provider: 'anthropic', model: 'claude-sonnet-5-5', system: 'Be brief', prompt: 'Hi', maxTokens: 1024 });
		const openai = httpAiBodyOf({ provider: 'openai', model: 'm', system: 'S', prompt: 'P', temperature: 0.2 });
		assert.deepStrictEqual(httpAiPromptFromBody('https://api.openai.com/v1/chat/completions', openai), { provider: 'openai', model: 'm', system: 'S', prompt: 'P', temperature: 0.2 });
		assert.strictEqual(httpAiPromptFromBody('https://api.openai.com/v1/chat/completions', '{"model":"m","messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":"c"}]}'), undefined, 'several turns: edited as JSON');
		assert.deepStrictEqual(httpAiAnswerOf('{"model":"m","choices":[{"message":{"content":"Hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}'), { text: 'Hello', model: 'm', inputTokens: 3, outputTokens: 1, stop: 'stop' });
		assert.deepStrictEqual(httpAiAnswerOf('{"model":"c","content":[{"type":"text","text":"Hi"}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":2}}'), { text: 'Hi', model: 'c', inputTokens: 5, outputTokens: 2, stop: 'end_turn' });

		assert.strictEqual(httpGrpcUrl('localhost:9995', 'a.B', 'C'), 'localhost:9995/a.B/C');
		assert.deepStrictEqual(httpGrpcTarget('https://api.example.com:443/a.B/C'), { address: 'https://api.example.com:443', service: 'a.B', method: 'C' });
		assert.deepStrictEqual(httpGrpcTarget('localhost:9995'), { address: 'localhost:9995', service: '', method: '' });
	});

	test('a model\'s answer becomes a script: fences and the agent session\'s insert tags are dropped', () => {
		assert.strictEqual(httpScriptFromAnswer('<insert>pm.test("a", () => {});\n</insert>'), 'pm.test("a", () => {});');
		assert.strictEqual(httpScriptFromAnswer('Here you go:\n```javascript\npm.test("a", () => {});\n```\nDone.'), 'pm.test("a", () => {});');
		assert.strictEqual(httpScriptFromAnswer('pm.test("a", () => {});\r\n'), 'pm.test("a", () => {});');
	});
});
