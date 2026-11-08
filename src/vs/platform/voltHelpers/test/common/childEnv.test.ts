/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { childEnvFromHost, isHostInternalEnvName, isInheritableEnvName, isSecretLikeEnvName } from '../../common/childEnv.js';

suite('Volt child environment allow rule (F.7, INV-24)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Volt\'s and Electron\'s plumbing never passes', () => {
		for (const name of ['VSCODE_IPC_HOOK', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK_EXTHOST', 'VSCODE_NLS_CONFIG', 'VSCODE_PID', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'NODE_CHANNEL_FD', 'GOOGLE_API_KEY']) {
			assert.ok(isHostInternalEnvName(name), name);
			assert.ok(!isInheritableEnvName(name), name);
		}
	});

	test('secret-looking names never pass, including *_KEY, *_PAT and *_JWT (B-41)', () => {
		for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN', 'STRIPE_KEY', 'GITLAB_PAT', 'SUPABASE_JWT', 'DB_PASSWORD', 'PGPASSWORD', 'DATABASE_URL', 'SENTRY_DSN', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SESSION_COOKIE', 'MY_PASSPHRASE', 'AZURE_CONNECTION_STRING', 'my_secret']) {
			assert.ok(isSecretLikeEnvName(name), name);
			assert.ok(!isInheritableEnvName(name), name);
		}
	});

	test('the user\'s ordinary environment passes', () => {
		for (const name of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'JAVA_HOME', 'GOPATH', 'CARGO_HOME', 'NVM_DIR', 'SSH_AUTH_SOCK', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_ASKPASS', 'KEYCHAIN', 'TERM_SESSION_ID', 'EDITOR', 'NODE_OPTIONS', 'VOLT_AGENT_SERVER_LOG']) {
			assert.ok(isInheritableEnvName(name), name);
		}
	});

	test('childEnvFromHost copies only inheritable names and drops undefined values', () => {
		const env = childEnvFromHost({ PATH: '/usr/bin', HOME: '/h', VSCODE_IPC_HOOK: '/tmp/main.sock', ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'sk-canary', EMPTY: undefined });
		assert.deepStrictEqual(env, { PATH: '/usr/bin', HOME: '/h' });
	});
});
