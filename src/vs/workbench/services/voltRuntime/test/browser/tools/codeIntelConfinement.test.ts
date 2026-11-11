/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { confineCodeIntel, HOVER_WITHHELD, ICodeIntelRules } from '../../../browser/tools/codeIntelConfinement.js';
import { ICodeIntelHost, ICodeLocation, ICodeNavIndex, ITextFileChange, runCodeAction, runCodeNav, runDiagnostics } from '../../../browser/tools/codeTools.js';
import { inVoltWorktree, LSP_ENABLED_SETTING, LSP_WORKTREES_SETTING, lspOffMessage, lspPolicy } from '../../../common/codeIntelligence.js';
import { IToolContext } from '../../../common/tools/tool.js';

const ROOT = URI.file('/ws');
const at = (path: string, line: number, preview?: string): ICodeLocation => ({ uri: URI.file(path), line, column: 1, ...(preview ? { preview } : {}) });

/** A language server that sees the whole machine: the project, a secret outside it, and a hook inside it. */
function wideHost(changes: readonly ITextFileChange[] = []): ICodeIntelHost & { readonly asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		diagnostics: async () => [
			{ uri: URI.file('/ws/src/a.ts'), line: 1, column: 1, severity: 'error', message: 'a is broken' },
			{ uri: URI.file('/Users/me/.aws/credentials.ts'), line: 2, column: 1, severity: 'error', message: 'aws_secret = AKIA-SECRET' },
		],
		definitions: async () => [at('/Users/me/secrets/keys.ts', 4, 'export const KEY = "sk-live-123"')],
		references: async () => [at('/ws/src/a.ts', 3, 'use(KEY)'), at('/Users/me/secrets/keys.ts', 4, 'export const KEY = "sk-live-123"'), at('/ws/src/b.ts', 7, 'use(KEY)')],
		symbols: async uri => { asked.push(`symbols ${uri.path}`); return [{ name: 'KEY', kind: 'const', line: 4, endLine: 4, depth: 0 }]; },
		columnOf: async () => 5,
		lspAllowed: () => true,
		wordAt: async uri => { asked.push(`wordAt ${uri.path}`); return 'KEY'; },
		fileText: async uri => { asked.push(`fileText ${uri.path}`); return uri.path.startsWith('/Users/me/') ? 'export const KEY = "sk-live-123";\n' : 'export const KEY = 1;\n'; },
		hover: async () => 'const KEY: "sk-live-123"',
		workspaceSymbols: async () => [{ name: 'KEY', kind: 'const', uri: URI.file('/Users/me/secrets/keys.ts'), line: 4, column: 1 }, { name: 'KEY', kind: 'const', uri: URI.file('/ws/src/a.ts'), line: 1, column: 1 }],
		calls: async () => [{ name: 'leak', kind: 'function', uri: URI.file('/Users/me/secrets/keys.ts'), line: 9, column: 1, sites: [9] }, { name: 'main', kind: 'function', uri: URI.file('/ws/src/a.ts'), line: 2, column: 1, sites: [3] }],
		rename: async () => changes,
		format: async () => changes,
		codeActions: async () => [{ title: 'Add import' }],
		applyCodeAction: async () => changes,
	};
}

const rules = {
	readRefusal: async (path: string) => path.startsWith('/ws/') ? undefined : `${path} is outside the workspace`,
	writeRefusal: async (path: string) => path.startsWith('/ws/.git/') || path.startsWith('/ws/.vscode/') ? `${path} is protected` : path.startsWith('/ws/') ? undefined : `${path} is outside the workspace`,
};

/** Volt's code index, which reads the same whole project. */
const wideIndex: ICodeNavIndex = {
	definitions: async () => [at('/Users/me/secrets/keys.ts', 4, 'export const KEY = "sk-live-123"'), at('/ws/src/a.ts', 1, 'export const KEY = 1')],
	references: async () => [at('/Users/me/secrets/keys.ts', 4), at('/ws/src/b.ts', 7, 'use(KEY)')],
	outline: async () => [{ name: 'KEY', kind: 'const', line: 4, endLine: 4, depth: 0 }],
};

function context(): IToolContext {
	return { signal: new AbortController().signal };
}

suite('Volt code intelligence for a sandboxed chat', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('DEV-SBX-12: code_nav and diagnostics answer only with files the chat\'s sandbox may read', async () => {
		const wide = wideHost();
		const { host, nav } = confineCodeIntel(wide, wideIndex, rules);
		const nav$ = (args: Record<string, unknown>) => runCodeNav(host, ROOT, args, nav).then(result => result.text);

		const references = await nav$({ op: 'references', path: 'src/a.ts', line: 3, symbol: 'KEY' });
		assert.match(references, /^2 references:/);
		assert.match(references, /src\/a\.ts:3/);
		assert.match(references, /src\/b\.ts:7/);
		assert.doesNotMatch(references, /secrets|sk-live/);

		// The only definition is outside: the language server's answer is dropped, the index answers with what is readable.
		const definition = await nav$({ op: 'definition', path: 'src/a.ts', line: 3, symbol: 'KEY' });
		assert.doesNotMatch(definition, /secrets|sk-live/);
		assert.match(definition, /from the code index.*\nsrc\/a\.ts:1:1 {2}export const KEY = 1$/s);

		const inspect = await nav$({ op: 'inspect', path: 'src/a.ts', line: 3, symbol: 'KEY' });
		assert.doesNotMatch(inspect, /sk-live|secrets/, 'no body, hover or reference from the secret file');
		assert.ok(!wide.asked.some(item => item.includes('/Users/me/')), 'its text and outline were never asked for');

		// Hover: the type comes from the declaration, which the chat may not read.
		const hover = await nav$({ op: 'hover', path: 'src/a.ts', line: 3, symbol: 'KEY' });
		assert.strictEqual(hover, `src/a.ts:3:5:\n${HOVER_WITHHELD}`);

		assert.doesNotMatch(await nav$({ op: 'workspace_symbols', query: 'KEY' }), /secrets/);
		const callers = await nav$({ op: 'callers', path: 'src/a.ts', line: 3, symbol: 'KEY' });
		assert.match(callers, /^1 caller of KEY:\nfunction main/);

		// A file the chat may not read is not opened at all, even if a call names it.
		assert.deepStrictEqual(await host.symbols(URI.file('/Users/me/secrets/keys.ts')), []);
		assert.strictEqual(await host.fileText!(URI.file('/Users/me/secrets/keys.ts')), undefined);
		assert.strictEqual(await host.wordAt(URI.file('/Users/me/secrets/keys.ts'), 1, 1), undefined);
		assert.strictEqual(await nav!.outline(ROOT, URI.file('/Users/me/secrets/keys.ts')), undefined);
		assert.ok(!wide.asked.some(item => item.includes('/Users/me/')));

		// Diagnostics: the workspace's whole Problems list, cut to the readable files.
		const diagnostics = (await runDiagnostics(host, ROOT, {})).text;
		assert.match(diagnostics, /a is broken/);
		assert.doesNotMatch(diagnostics, /AKIA|aws/);

		// Unconfined: as before (the native loop and unsandboxed chats).
		assert.match(await runCodeNav(wide, ROOT, { op: 'references', path: 'src/a.ts', line: 3, symbol: 'KEY' }, wideIndex).then(result => result.text), /^3 references:/);
	});

	test('DEV-SBX-13: code_action changes nothing unless every file it changes is one the sandbox lets the chat write', async () => {
		const written: string[] = [];
		const write = async (change: ITextFileChange) => {
			written.push(change.uri.path);
			return { added: 1, removed: 1, text: '' };
		};
		const rename = (changes: readonly ITextFileChange[], withRules: ICodeIntelRules = rules) => {
			const { host } = confineCodeIntel(wideHost(changes), undefined, withRules);
			return runCodeAction(host, ROOT, { op: 'rename', path: 'src/a.ts', line: 1, symbol: 'KEY', new_name: 'TOKEN' }, write, context());
		};
		const edit = (path: string): ITextFileChange => ({ uri: URI.file(path), before: 'KEY', after: 'TOKEN' });

		// The rename's other files include a git hook: refused whole, before the first file is written.
		const intoHook = await rename([edit('/ws/src/a.ts'), edit('/ws/.git/hooks/pre-commit')]);
		assert.strictEqual(intoHook.isError, true);
		assert.match(intoHook.text, /^Nothing was changed: the edit also changes \/ws\/\.git\/hooks\/pre-commit, which this chat's sandbox may not write \(\/ws\/\.git\/hooks\/pre-commit is protected\)/);
		// Outside the workspace (the user's other project that imports it): refused too.
		assert.match((await rename([edit('/ws/src/a.ts'), edit('/Users/me/other/main.ts')])).text, /^Nothing was changed: .*\/Users\/me\/other\/main\.ts.*it may not read it/);
		// Without the gate's write rule Volt cannot tell: nothing is written.
		assert.match((await rename([edit('/ws/src/a.ts')], { readRefusal: rules.readRefusal })).text, /Volt cannot tell which files this sandboxed chat may write/);
		assert.deepStrictEqual(written, []);

		// Inside what it may write: every file.
		const ok = await rename([edit('/ws/src/a.ts'), edit('/ws/src/b.ts')]);
		assert.strictEqual(ok.isError, undefined);
		assert.deepStrictEqual(written, ['/ws/src/a.ts', '/ws/src/b.ts']);

		// format and fix go through the same check.
		const { host } = confineCodeIntel(wideHost([edit('/ws/.vscode/tasks.json')]), undefined, rules);
		assert.match((await runCodeAction(host, ROOT, { op: 'format', path: 'src/a.ts' }, write, context())).text, /^Nothing was changed: .*tasks\.json/);
		assert.match((await runCodeAction(host, ROOT, { op: 'fix', path: 'src/a.ts', line: 1 }, write, context())).text, /^Nothing was changed: .*tasks\.json/);
		assert.strictEqual(written.length, 2);
	});

	test('DEV-LSP-1: a project the user opened gets language servers by default, in or out of the window\'s folders; a chat\'s worktree follows its setting', () => {
		const configuration = new TestConfigurationService();
		const policy = lspPolicy(configuration, uri => uri.path.startsWith('/Users/me/volt/'));
		// The live pass: an agent window (no folders of its own) on a project in /tmp.
		assert.strictEqual(policy(URI.file('/tmp/v4-devrepo/src/a.ts')), true);
		assert.strictEqual(policy(URI.file('/Users/me/volt/src/a.ts')), true);
		assert.strictEqual(inVoltWorktree('/Users/me/.volt/worktrees/-ey1qf4/volt-f24fd65b/src/a.ts'), true);
		assert.strictEqual(policy(URI.file('/Users/me/.volt/worktrees/-ey1qf4/volt-f24fd65b/src/a.ts')), false, 'worktrees are opt-in');
		configuration.setUserConfiguration(LSP_WORKTREES_SETTING, true);
		assert.strictEqual(policy(URI.file('/Users/me/.volt/worktrees/-ey1qf4/volt-f24fd65b/src/a.ts')), true);
		configuration.setUserConfiguration(LSP_ENABLED_SETTING, false);
		assert.strictEqual(policy(URI.file('/tmp/v4-devrepo/src/a.ts')), false);
		// Off says what to do instead.
		assert.match(lspOffMessage('diagnostics'), /Enable LSPs.*Run the project's type checker or linter with your shell tool/);
		assert.match(lspOffMessage('code_action'), /nothing was changed\. Edit the files with your own edit tools; code_nav definition and references \(pass symbol\) still answer from the code index/);
	});
});
