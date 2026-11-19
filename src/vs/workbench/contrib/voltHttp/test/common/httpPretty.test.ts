/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { HTTP_SNIPPET_TARGETS, httpSnippet } from '../../common/httpCodegen.js';
import { detectHttpBodyLanguage, prettyHttpBody } from '../../common/httpPretty.js';

suite('Volt HTTP client: Pretty', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a minified page comes back on indented lines, scripts and styles included', () => {
		const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Shop</title><style>body{margin:0;color:red}a:hover{color:blue}</style><script nonce="x">(function(){var a="</b>;{";if(a){go(a)}})();</script></head><body><div class="a > b"><p>Hello <b>you</b></p><br><pre>  keep\n   this</pre></div></body></html>';
		assert.strictEqual(prettyHttpBody(html, 'html'), [
			'<!doctype html>',
			'<html lang="en">',
			'  <head>',
			'    <meta charset="UTF-8">',
			'    <title>Shop</title>',
			'    <style>',
			'      body {',
			'        margin:0;',
			'        color:red;',
			'      }',
			'      a:hover {',
			'        color:blue;',
			'      }',
			'    </style>',
			'    <script nonce="x">',
			'      (function(){',
			'        var a="</b>;{";',
			'        if(a){',
			'          go(a)',
			'        }',
			'      })();',
			'    </script>',
			'  </head>',
			'  <body>',
			'    <div class="a > b">',
			'      <p>',
			'        Hello',
			'        <b>you</b>',
			'      </p>',
			'      <br>',
			'      <pre>',
			'  keep\n   this',
			'      </pre>',
			'    </div>',
			'  </body>',
			'</html>',
		].join('\n'));
	});

	test('XML, JSON, CSS and JavaScript; what cannot be parsed comes back as it was', () => {
		assert.strictEqual(prettyHttpBody('<?xml version="1.0"?><a><b id="1"/><c>text</c><d><![CDATA[<x>]]></d></a>', 'xml'), '<?xml version="1.0"?>\n<a>\n  <b id="1"/>\n  <c>text</c>\n  <d>\n    <![CDATA[<x>]]>\n  </d>\n</a>');
		assert.strictEqual(prettyHttpBody('{"a":[1,{"b":null}]}', 'json'), '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ]\n}');
		assert.strictEqual(prettyHttpBody('{not json', 'json'), '{not json');
		assert.strictEqual(prettyHttpBody('@media (min-width:1px){a{b:url(data:x;y,z)}}', 'css'), '@media (min-width:1px) {\n  a {\n    b:url(data:x;y,z);\n  }\n}');
		assert.strictEqual(prettyHttpBody('var k=/#|;{$/;for(var i=0;i<2;i++){f(i)}if(x){y()}else{z=a/b;}// done', 'javascript'), 'var k=/#|;{$/;\nfor(var i=0;i<2;i++){\n  f(i)\n}\nif(x){\n  y()\n}else{\n  z=a/b;\n}\n// done');
		assert.strictEqual(prettyHttpBody('const t=`a;{${b}`;g({})', 'javascript'), 'const t=`a;{${b}`;\ng({})');
	});

	test('a body says what it is when its content type does not', () => {
		assert.strictEqual(detectHttpBodyLanguage('text/html; charset=utf-8', '<p>'), 'html');
		assert.strictEqual(detectHttpBodyLanguage('', '  <!DOCTYPE html><html>'), 'html');
		assert.strictEqual(detectHttpBodyLanguage('text/plain', '{"a":1}'), 'json');
		assert.strictEqual(detectHttpBodyLanguage('application/problem+json', 'x'), 'json');
		assert.strictEqual(detectHttpBodyLanguage('image/svg+xml', '<svg/>'), 'xml');
		assert.strictEqual(detectHttpBodyLanguage('', '<a><b/></a>'), 'xml');
		assert.strictEqual(detectHttpBodyLanguage('text/javascript', 'x'), 'javascript');
		assert.strictEqual(detectHttpBodyLanguage('', 'hello < world'), 'plaintext');
	});

	test('every snippet language writes the method, URL, headers and body', () => {
		const spec = { method: 'POST', url: 'https://api.example.com/users?a=1', headers: [['Content-Type', 'application/json'], ['X-Token', 'it\'s $5 #{x}']] as [string, string][], body: '{"name":"Ada"}', line: 0 };
		assert.strictEqual(HTTP_SNIPPET_TARGETS.length, 17);
		for (const { id } of HTTP_SNIPPET_TARGETS) {
			const text = httpSnippet(id, spec);
			assert.ok(text.includes('api.example.com/users?a=1'), `${id}: url`);
			assert.ok(/POST/i.test(text), `${id}: method`);
			assert.ok(text.includes('X-Token'), `${id}: header`);
			assert.ok(text.includes('Ada'), `${id}: body`);
		}
		assert.ok(httpSnippet('powershell', spec).includes(`'X-Token' = 'it''s $5 #{x}'`));
		assert.ok(httpSnippet('kotlin', spec).includes('.addHeader("X-Token", "it\'s \\$5 #{x}")'));
		assert.ok(httpSnippet('ruby', spec).includes('request["X-Token"] = "it\'s $5 \\#{x}"'));
		assert.ok(httpSnippet('php', spec).includes(`'X-Token: it\\'s $5 #{x}',`));
		assert.ok(httpSnippet('java', { ...spec, method: 'GET', body: undefined }).includes('.method("GET", HttpRequest.BodyPublishers.noBody())'));
	});
});
