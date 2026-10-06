/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_SETUP, agentSetupInfo, authCheckCommand, installCommand, parseAuthCheck, parseCredentialsFile } from '../../common/agentSetup.js';
import { formatEnvText, normalizeProjectSettings, parseEnvText, projectForPath, readWorktreeSetup, stepsFromText, withProjectSettings, writeWorktreeSetup } from '../../common/projectSettings.js';

/** `CLI_AGENT_DEFINITIONS` ids (browser code, so listed here). */
const CLI_AGENT_IDS_FOR_TEST = ['codex', 'claude-code', 'cursor-acp', 'grok', 'opencode', 'antigravity', 'kimi', 'muse'];

suite('Volt setup: agent CLIs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every agent Volt runs has setup info', () => {
		for (const id of CLI_AGENT_IDS_FOR_TEST) {
			assert.ok(agentSetupInfo(id), id);
		}
		assert.strictEqual(new Set(AGENT_SETUP.map(info => info.id)).size, AGENT_SETUP.length);
		assert.strictEqual(installCommand(agentSetupInfo('claude-code')!, 'mac'), 'curl -fsSL https://claude.ai/install.sh | bash');
		assert.strictEqual(installCommand(agentSetupInfo('claude-code')!, 'windows'), 'irm https://claude.ai/install.ps1 | iex');
		// No verified script for Grok: the wizard links the guide.
		assert.strictEqual(installCommand(agentSetupInfo('grok')!, 'mac'), undefined);
	});

	test('status commands use the found executable', () => {
		assert.strictEqual(authCheckCommand({ kind: 'claudeStatus' }, 'claude'), 'claude auth status');
		assert.strictEqual(authCheckCommand({ kind: 'codexStatus' }, 'codex'), 'codex login status');
		assert.strictEqual(authCheckCommand({ kind: 'cursorStatus' }, 'agent'), 'agent status --format json');
		assert.strictEqual(authCheckCommand({ kind: 'none' }, 'kimi'), undefined);
	});

	test('reads claude auth status', () => {
		const check = { kind: 'claudeStatus' } as const;
		assert.deepStrictEqual(parseAuthCheck(check, 0, '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"a@b.c"}', ''), { kind: 'signedIn', account: 'a@b.c', plan: 'Claude Max' });
		assert.deepStrictEqual(parseAuthCheck(check, 1, '{"loggedIn":false,"authMethod":"none"}', ''), { kind: 'signedOut' });
		assert.deepStrictEqual(parseAuthCheck(check, 1, 'Not logged in. Run claude auth login to authenticate.', ''), { kind: 'signedOut' });
		assert.deepStrictEqual(parseAuthCheck(check, null, '', ''), { kind: 'unknown' });
		assert.deepStrictEqual(parseAuthCheck(check, 2, 'error: unknown command', ''), { kind: 'unknown' });
	});

	test('reads codex login status from either stream', () => {
		const check = { kind: 'codexStatus' } as const;
		assert.deepStrictEqual(parseAuthCheck(check, 0, '', 'Logged in using ChatGPT\n'), { kind: 'signedIn', plan: 'ChatGPT' });
		assert.deepStrictEqual(parseAuthCheck(check, 0, 'Logged in using an API key - sk-***', ''), { kind: 'signedIn', plan: 'API key' });
		assert.deepStrictEqual(parseAuthCheck(check, 1, 'Not logged in', ''), { kind: 'signedOut' });
		assert.deepStrictEqual(parseAuthCheck(check, 1, 'Error loading config', ''), { kind: 'unknown' });
	});

	test('reads cursor-agent status, which exits 0 either way', () => {
		const check = { kind: 'cursorStatus' } as const;
		assert.deepStrictEqual(parseAuthCheck(check, 0, '{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"me@x.io"}}', ''), { kind: 'signedIn', account: 'me@x.io' });
		assert.deepStrictEqual(parseAuthCheck(check, 0, '{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}', ''), { kind: 'signedOut' });
		assert.deepStrictEqual(parseAuthCheck(check, 0, '\u2713 Logged in as me@x.io', ''), { kind: 'signedIn', account: 'me@x.io' });
		assert.deepStrictEqual(parseCredentialsFile(true), { kind: 'signedIn' });
		assert.deepStrictEqual(parseCredentialsFile(false), { kind: 'signedOut' });
		assert.deepStrictEqual(parseCredentialsFile(undefined), { kind: 'unknown' });
	});
});

suite('Volt setup: project settings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('stored settings are cleaned up and cleared settings drop out', () => {
		assert.deepStrictEqual(normalizeProjectSettings({ p1: { defaultModel: 'claude-code:sonnet', env: { OK: '1', 'BAD NAME': 'x', NUM: 3 } }, p2: { junk: true }, p3: 'x' }), { p1: { defaultModel: 'claude-code:sonnet', env: { OK: '1' } } });
		assert.deepStrictEqual(normalizeProjectSettings(undefined), {});
		const map = withProjectSettings({}, 'p1', { defaultModel: 'm' });
		assert.deepStrictEqual(map, { p1: { defaultModel: 'm' } });
		assert.deepStrictEqual(withProjectSettings(map, 'p1', { defaultModel: undefined, env: {} }), {});
	});

	test('environment text reads like a .env file', () => {
		const parsed = parseEnvText('# comment\nexport A=1\nB = "two words"\n\nC=\'x=y\'\nnot a var\n1BAD=x\nA=3');
		assert.deepStrictEqual(parsed.env, { A: '3', B: 'two words', C: 'x=y' });
		assert.deepStrictEqual(parsed.invalidLines, [6, 7]);
		assert.strictEqual(formatEnvText({ A: '1', B: 'two words' }), 'A=1\nB="two words"');
		assert.deepStrictEqual(parseEnvText(formatEnvText({ A: '1', B: 'two words', C: 'a#b' })).env, { A: '1', B: 'two words', C: 'a#b' });
	});

	test('worktree setup round-trips .volt/worktrees.json and keeps other keys', () => {
		assert.deepStrictEqual(readWorktreeSetup(undefined, 'unix'), { steps: [], script: false });
		assert.deepStrictEqual(readWorktreeSetup('{"setup-worktree":["npm ci"," cp $ROOT_WORKTREE_PATH/.env .env "]}', 'unix'), { steps: ['npm ci', 'cp $ROOT_WORKTREE_PATH/.env .env'], script: false });
		assert.deepStrictEqual(readWorktreeSetup('{"setup-worktree":["a"],"setup-worktree-unix":"setup.sh"}', 'unix'), { steps: ['setup.sh'], script: true });
		assert.deepStrictEqual(readWorktreeSetup('{"setup-worktree":["a"],"setup-worktree-unix":"setup.sh"}', 'windows'), { steps: ['a'], script: false });
		assert.ok(readWorktreeSetup('{nope', 'unix').error);
		const written = writeWorktreeSetup('{"setup-worktree-windows":["x"]}', stepsFromText('npm ci\n\n  pnpm build  \n'));
		assert.deepStrictEqual(JSON.parse(written!), { 'setup-worktree': ['npm ci', 'pnpm build'], 'setup-worktree-windows': ['x'] });
		assert.deepStrictEqual(JSON.parse(writeWorktreeSetup(written, [])!), { 'setup-worktree-windows': ['x'] });
		assert.strictEqual(writeWorktreeSetup('{"setup-worktree":["a"]}', []), undefined);
	});

	test('a working folder belongs to the deepest project holding it', () => {
		const projects = [{ id: 'a', root: '/src/app' }, { id: 'b', root: '/src/app/packages/web' }, { id: 'c', root: 'C:\\Code\\Api' }];
		assert.strictEqual(projectForPath('/src/app', projects, false)?.id, 'a');
		assert.strictEqual(projectForPath('/src/app/lib', projects, false)?.id, 'a');
		assert.strictEqual(projectForPath('/src/app/packages/web/src', projects, false)?.id, 'b');
		assert.strictEqual(projectForPath('/src/application', projects, false), undefined);
		assert.strictEqual(projectForPath('c:\\code\\api\\x', projects, true)?.id, 'c');
		assert.strictEqual(projectForPath(undefined, projects, false), undefined);
	});
});
