/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	dominantRepoOwner,
	IAgentRepoInfo,
	parseGitConfigRemotes,
	parseGitHead,
	parseGitRemoteUrl,
	repoDisplayName,
	repoInitials,
	repoSlug,
} from '../../browser/home/agentRepoInfo.js';

function repo(name: string, owner?: string): IAgentRepoInfo {
	return { id: `github.com/${owner ?? ''}/${name}`, name, owner, root: URI.file(`/src/${name}`) };
}

suite('Agent home repository info', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses scp, https, ssh and local remotes', () => {
		assert.deepStrictEqual(parseGitRemoteUrl('git@github.com:leularia/volt.git'), { host: 'github.com', owner: 'leularia', name: 'volt' });
		assert.deepStrictEqual(parseGitRemoteUrl('https://github.com/microsoft/vscode'), { host: 'github.com', owner: 'microsoft', name: 'vscode' });
		assert.deepStrictEqual(parseGitRemoteUrl('https://user@gitlab.com/group/sub/app.git/'), { host: 'gitlab.com', owner: 'group/sub', name: 'app' });
		assert.deepStrictEqual(parseGitRemoteUrl('ssh://git@host.dev:2222/team/tool.git'), { host: 'host.dev', owner: 'team', name: 'tool' });
		assert.deepStrictEqual(parseGitRemoteUrl('/Users/me/mirrors/volt.git'), { host: '', owner: undefined, name: 'volt' });
		assert.deepStrictEqual(parseGitRemoteUrl('C:\\mirrors\\volt'), { host: '', owner: undefined, name: 'volt' });
		assert.strictEqual(parseGitRemoteUrl('  '), undefined);
	});

	test('reads remotes from git config in file order', () => {
		const remotes = parseGitConfigRemotes([
			'[core]',
			'\tbare = false',
			'[remote "upstream"]',
			'\turl = https://github.com/microsoft/vscode.git',
			'[remote "origin"]',
			'\turl = git@github.com:leularia/volt.git',
			'\tfetch = +refs/heads/*:refs/remotes/origin/*',
			'[branch "main"]',
			'\tremote = origin',
		].join('\n'));
		assert.deepStrictEqual([...remotes], [
			['upstream', 'https://github.com/microsoft/vscode.git'],
			['origin', 'git@github.com:leularia/volt.git'],
		]);
	});

	test('reads the branch, or a short commit when detached', () => {
		assert.strictEqual(parseGitHead('ref: refs/heads/main\n'), 'main');
		assert.strictEqual(parseGitHead('ref: refs/heads/feature/sidebar-groups'), 'feature/sidebar-groups');
		assert.strictEqual(parseGitHead('e5610eb1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7'), 'e5610eb');
		assert.strictEqual(parseGitHead('garbage'), undefined);
	});

	test('initials take the first letter of two words, else two letters', () => {
		assert.strictEqual(repoInitials('volt'), 'VO');
		assert.strictEqual(repoInitials('aria-icons'), 'AI');
		assert.strictEqual(repoInitials('Agent-Test'), 'AT');
		assert.strictEqual(repoInitials('FalconWebsite'), 'FW');
		assert.strictEqual(repoInitials('dho/firm-contacts'), 'FC');
		assert.strictEqual(repoInitials('JEv'), 'JE');
		assert.strictEqual(repoInitials('hotelerp'), 'HO');
		assert.strictEqual(repoInitials('x'), 'X');
		assert.strictEqual(repoInitials(''), '');
	});

	test('hides the owner most repositories share', () => {
		const mine = [repo('volt', 'leularia'), repo('aria-icons', 'LeulAria'), repo('vscode', 'microsoft')];
		const self = dominantRepoOwner(mine);
		assert.strictEqual(self, 'leularia');
		assert.strictEqual(repoDisplayName(mine[0], self), 'volt');
		assert.strictEqual(repoDisplayName(mine[1], self), 'aria-icons');
		assert.strictEqual(repoDisplayName(mine[2], self), 'microsoft/vscode');
		assert.strictEqual(repoSlug(mine[0]), 'leularia/volt');
		assert.strictEqual(repoDisplayName(repo('scratch'), self), 'scratch');
	});
});
