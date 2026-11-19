/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IHttpRequestSpec } from '../../../../services/voltRuntime/common/ide/httpFile.js';
import { HTTP_SNIPPET_TARGETS, httpSnippet } from '../../common/httpCodegen.js';

const GET: IHttpRequestSpec = { method: 'GET', url: 'https://api.example.com/users?page=2', headers: [['Accept', 'application/json']], line: 0 };
const POST: IHttpRequestSpec = {
	method: 'POST',
	url: 'https://api.example.com/users',
	headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer {{token}}']],
	body: '{"name":"Ada","admin":true,"tags":["a"],"note":null}',
	line: 0,
};
const TEXT: IHttpRequestSpec = { method: 'PUT', url: 'https://example.com/note', headers: [['Content-Type', 'text/plain']], body: 'it\'s "quoted"\nline two', line: 0 };

suite('HTTP client: code snippets', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every target is listed with a language', () => {
		assert.deepStrictEqual(HTTP_SNIPPET_TARGETS.map(target => target.id), ['curl', 'httpie', 'wget', 'powershell', 'fetch', 'axios', 'node', 'python', 'go', 'java', 'kotlin', 'csharp', 'php', 'ruby', 'swift', 'rust', 'dart']);
		for (const target of HTTP_SNIPPET_TARGETS) {
			assert.ok(target.label && target.language);
			assert.ok(httpSnippet(target.id, GET).includes('https://api.example.com/users?page=2'), target.id);
		}
	});

	test('cURL', () => {
		assert.strictEqual(httpSnippet('curl', GET), `curl 'https://api.example.com/users?page=2' \\\n  -H 'Accept: application/json'`);
		assert.strictEqual(httpSnippet('curl', TEXT), [
			`curl -X PUT 'https://example.com/note' \\`,
			`  -H 'Content-Type: text/plain' \\`,
			`  --data-raw 'it'\\''s "quoted"\nline two'`,
		].join('\n'));
	});

	test('HTTPie and Wget', () => {
		assert.strictEqual(httpSnippet('httpie', GET), `http GET 'https://api.example.com/users?page=2' \\\n  'Accept:application/json'`);
		assert.ok(httpSnippet('httpie', POST).startsWith(`http --raw '{"name":"Ada","admin":true,"tags":["a"],"note":null}' POST 'https://api.example.com/users'`));
		assert.strictEqual(httpSnippet('wget', POST), [
			`wget --quiet --method=POST \\`,
			`  --header='Content-Type: application/json' \\`,
			`  --header='Authorization: Bearer {{token}}' \\`,
			`  --body-data='{"name":"Ada","admin":true,"tags":["a"],"note":null}' \\`,
			`  --output-document=- \\`,
			`  'https://api.example.com/users'`,
		].join('\n'));
	});

	test('fetch', () => {
		assert.strictEqual(httpSnippet('fetch', POST), [
			'const response = await fetch("https://api.example.com/users", {',
			'  method: "POST",',
			'  headers: {',
			'    "Content-Type": "application/json",',
			'    "Authorization": "Bearer {{token}}",',
			'  },',
			'  body: JSON.stringify({',
			'    "name": "Ada",',
			'    "admin": true,',
			'    "tags": [',
			'      "a"',
			'    ],',
			'    "note": null',
			'  }),',
			'});',
			'',
			'console.log(response.status);',
			'console.log(await response.text());',
		].join('\n'));
		assert.ok(httpSnippet('fetch', TEXT).includes('  body: "it\'s \\"quoted\\"\\nline two",'));
		assert.ok(!httpSnippet('fetch', GET).includes('body'));
	});

	test('axios', () => {
		const snippet = httpSnippet('axios', POST);
		assert.ok(snippet.startsWith('import axios from "axios";\n\nconst response = await axios({\n  method: "post",\n  url: "https://api.example.com/users",'));
		assert.ok(snippet.includes('  data: {\n    "name": "Ada",'));
		assert.ok(httpSnippet('axios', TEXT).includes('  data: "it\'s \\"quoted\\"\\nline two",'));
	});

	test('Python', () => {
		assert.strictEqual(httpSnippet('python', POST), [
			'import requests',
			'',
			'url = "https://api.example.com/users"',
			'headers = {',
			'    "Content-Type": "application/json",',
			'    "Authorization": "Bearer {{token}}",',
			'}',
			'payload = {',
			'    "name": "Ada",',
			'    "admin": True,',
			'    "tags": [',
			'        "a",',
			'    ],',
			'    "note": None,',
			'}',
			'',
			'response = requests.request("POST", url, headers=headers, json=payload)',
			'',
			'print(response.status_code)',
			'print(response.text)',
		].join('\n'));
		assert.ok(httpSnippet('python', TEXT).includes('payload = "it\'s \\"quoted\\"\\nline two"\n'));
		assert.ok(httpSnippet('python', GET).includes('requests.request("GET", url, headers=headers)'));
	});

	test('Go', () => {
		const snippet = httpSnippet('go', POST);
		assert.ok(snippet.includes('\tpayload := strings.NewReader(`{"name":"Ada","admin":true,"tags":["a"],"note":null}`)'));
		assert.ok(snippet.includes('\treq, err := http.NewRequest("POST", "https://api.example.com/users", payload)'));
		assert.ok(snippet.includes('\treq.Header.Add("Authorization", "Bearer {{token}}")'));
		const plain = httpSnippet('go', GET);
		assert.ok(plain.includes('http.NewRequest("GET", "https://api.example.com/users?page=2", nil)'));
		assert.ok(!plain.includes('"strings"'));
		assert.ok(httpSnippet('go', { ...TEXT, body: 'a `tick`' }).includes('strings.NewReader("a `tick`")'));
	});

	test('a body that is not valid JSON goes out as text', () => {
		const spec: IHttpRequestSpec = { ...POST, body: '{"id": {{id}}}' };
		assert.ok(httpSnippet('fetch', spec).includes('  body: "{\\"id\\": {{id}}}",'));
		assert.ok(httpSnippet('python', spec).includes('data=payload.encode("utf-8")'));
	});
});
