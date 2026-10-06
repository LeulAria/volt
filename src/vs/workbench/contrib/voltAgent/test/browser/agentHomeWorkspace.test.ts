/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	agentHomeWorkspaceEntries,
	cloneFolderName,
	commitFailureSummary,
	filterAgentHomeWorkspaceEntries,
	freeFolderName,
	gitErrorSummary,
	namedProjectReadme,
	newFolderNameProblem,
	newProjectNameProblem,
	projectFolderSlug,
	resolveCloneUrl,
	scratchFolderName,
} from '../../browser/home/agentHomeWorkspace.js';

suite('Agent home workspace menu', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const tilde = (uri: URI) => uri.path.replace(/^\/Users\/me/, '~');
	const folder = (path: string) => ({ uri: URI.file(path), name: path.split('/').pop()! });

	test('lists recent folders first, then registered projects, once each', () => {
		const entries = agentHomeWorkspaceEntries(
			[folder('/Users/me/Desktop/VOLT/volt'), folder('/Users/me/Desktop/hotel')],
			[folder('/Users/me/Desktop/hotel'), folder('/Users/me/Documents/ecomm')],
			tilde,
		);
		assert.deepStrictEqual(entries.map(entry => entry.path), ['~/Desktop/VOLT/volt', '~/Desktop/hotel', '~/Documents/ecomm']);
		assert.deepStrictEqual(entries.map(entry => entry.name), ['volt', 'hotel', 'ecomm']);
	});

	test('search matches every word in the path and puts name matches first', () => {
		const entries = agentHomeWorkspaceEntries([
			folder('/Users/me/Desktop/Projects/FALCON/hotel'),
			folder('/Users/me/Desktop/Projects/aria-icon'),
			folder('/Users/me/Documents/Project/hotel-erp'),
		], [], tilde);
		assert.deepStrictEqual(filterAgentHomeWorkspaceEntries(entries, 'HOTEL').map(entry => entry.name), ['hotel', 'hotel-erp']);
		assert.deepStrictEqual(filterAgentHomeWorkspaceEntries(entries, 'projects').map(entry => entry.name), ['hotel', 'aria-icon']);
		assert.deepStrictEqual(filterAgentHomeWorkspaceEntries(entries, 'falcon hotel').map(entry => entry.name), ['hotel']);
		assert.deepStrictEqual(filterAgentHomeWorkspaceEntries(entries, '   ').length, 3);
		assert.deepStrictEqual(filterAgentHomeWorkspaceEntries(entries, 'nothing'), []);
	});

	test('clone URLs: full URLs pass through, shorthand points at the host', () => {
		assert.strictEqual(resolveCloneUrl('github', 'https://github.com/microsoft/vscode.git'), 'https://github.com/microsoft/vscode.git');
		assert.strictEqual(resolveCloneUrl('url', 'git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
		assert.strictEqual(resolveCloneUrl('url', 'ssh://git@host:22/owner/repo'), 'ssh://git@host:22/owner/repo');
		assert.strictEqual(resolveCloneUrl('github', ' owner/repo '), 'https://github.com/owner/repo');
		assert.strictEqual(resolveCloneUrl('gitlab', 'group/sub/repo'), 'https://gitlab.com/group/sub/repo');
		assert.strictEqual(resolveCloneUrl('bitbucket', 'team/repo'), 'https://bitbucket.org/team/repo');
		assert.strictEqual(resolveCloneUrl('url', 'gitlab.example.com/team/repo'), 'https://gitlab.example.com/team/repo');
	});

	test('clone URLs: rejects what git clone must not get', () => {
		assert.strictEqual(resolveCloneUrl('url', 'owner/repo'), undefined);
		assert.strictEqual(resolveCloneUrl('github', ''), undefined);
		assert.strictEqual(resolveCloneUrl('github', 'owner repo'), undefined);
		assert.strictEqual(resolveCloneUrl('github', '--upload-pack=touch/x'), undefined);
		assert.strictEqual(resolveCloneUrl('github', 'repo'), undefined);
	});

	test('clone folder name comes from the last path segment', () => {
		assert.strictEqual(cloneFolderName('https://github.com/microsoft/vscode.git'), 'vscode');
		assert.strictEqual(cloneFolderName('git@github.com:owner/my-repo.git'), 'my-repo');
		assert.strictEqual(cloneFolderName('https://gitlab.com/group/sub/repo/'), 'repo');
		assert.strictEqual(cloneFolderName('https://host/owner/repo?ref=main#readme'), 'repo');
		assert.strictEqual(cloneFolderName('https://host/'), 'host');
		assert.strictEqual(cloneFolderName('..'), undefined);
	});

	test('free folder name counts up past taken names', async () => {
		const taken = new Set(['new-project', 'new-project-2']);
		assert.strictEqual(await freeFolderName('new-project', async name => taken.has(name)), 'new-project-3');
		assert.strictEqual(await freeFolderName('volt', async () => false), 'volt');
	});

	test('new folder names', () => {
		assert.strictEqual(newFolderNameProblem('my-app'), undefined);
		assert.ok(newFolderNameProblem('  '));
		assert.ok(newFolderNameProblem('a/b'));
		assert.ok(newFolderNameProblem('..'));
	});

	test('project folder slug: ascii words joined by dashes', () => {
		assert.strictEqual(projectFolderSlug('My Cool App'), 'my-cool-app');
		assert.strictEqual(projectFolderSlug('  Café Résumé!! '), 'cafe-resume');
		assert.strictEqual(projectFolderSlug('../../etc'), 'etc');
		assert.strictEqual(projectFolderSlug('日本語'), 'project');
		assert.strictEqual(projectFolderSlug('CON'), 'con-project');
		assert.strictEqual(projectFolderSlug('a'.repeat(80)).length, 64);
		assert.strictEqual(projectFolderSlug(`${'a'.repeat(63)} b`), 'a'.repeat(63), 'no trailing dash after the cut');
	});

	test('scratch folder: local date, first five words, eight id characters', () => {
		const day = new Date(2026, 8, 5, 23, 30);
		assert.strictEqual(scratchFolderName(day, 'Convert these PNGs to WebP, please, quickly', 'A1B2-C3D4-E5F6'), '2026-09-05-convert-these-pngs-to-webp-a1b2c3d4');
		assert.strictEqual(scratchFolderName(day, '???', 'abcdef0123'), '2026-09-05-abcdef01');
		assert.strictEqual(scratchFolderName(day, `${'x'.repeat(60)} y`, 'ff'), `2026-09-05-${'x'.repeat(48)}-ff`);
	});

	test('new project README and commit failures', async () => {
		assert.strictEqual(namedProjectReadme(' Weather Bot '), '# Weather Bot\n');
		assert.match(commitFailureSummary('Author identity unknown\n\n*** Please tell me who you are.\n'), /user\.name and user\.email/);
		assert.strictEqual(commitFailureSummary('error: gpg failed to sign the data\nfatal: failed to write commit object\n'), 'gpg failed to sign the data');
		assert.ok(commitFailureSummary(''));
		assert.ok(newProjectNameProblem('  '));
		assert.strictEqual(newProjectNameProblem('Weather'), undefined);
		// Taken names count up, as for new folders.
		const taken = new Set(['weather-bot']);
		assert.strictEqual(await freeFolderName(projectFolderSlug('Weather Bot'), async name => taken.has(name)), 'weather-bot-2');
	});

	test('git error summary keeps the fatal line', () => {
		assert.strictEqual(gitErrorSummary(`Cloning into '/Users/me/repo'...\nremote: Repository not found.\nfatal: repository 'https://github.com/x/y/' not found\n`), `repository 'https://github.com/x/y/' not found`);
		assert.strictEqual(gitErrorSummary('zsh: command not found: git\n'), 'zsh: command not found: git');
		assert.strictEqual(gitErrorSummary(''), undefined);
	});
});
