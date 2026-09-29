/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { breadcrumbParts, browseDirectory, browseLeaf, BrowseGeneration, ensureTrailingSeparator, parentDirectory, tildify, untildify } from '../../common/browsePath.js';
import { nextFreeName, parseCloneUrl, resolveCloneDestination, sameRemote, sanitizeFolderName } from '../../common/cloneUrl.js';
import { rankFolders } from '../../common/folderSearch.js';

suite('Volt projects: clone URLs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts https, scp-style, ssh and owner/repo shorthand', () => {
		assert.deepStrictEqual(parseCloneUrl('leularia/volt'), { url: 'https://github.com/leularia/volt.git', name: 'volt', host: 'github.com', owner: 'leularia', repo: 'volt' });
		assert.deepStrictEqual(parseCloneUrl('  https://github.com/org/api-server.git '), { url: 'https://github.com/org/api-server.git', name: 'api-server', host: 'github.com', owner: 'org', repo: 'api-server' });
		assert.strictEqual((parseCloneUrl('https://github.com/org/repo/tree/main/src') as { url: string }).url, 'https://github.com/org/repo.git');
		assert.deepStrictEqual(parseCloneUrl('git@gitlab.com:group/sub/proj.git'), { url: 'git@gitlab.com:group/sub/proj.git', name: 'proj', host: 'gitlab.com', owner: 'sub', repo: 'proj' });
		assert.strictEqual((parseCloneUrl('ssh://git@host.xz:2222/path/to/repo.git') as { name: string }).name, 'repo');
		assert.strictEqual((parseCloneUrl('https://dev.azure.com/org/project/_git/my-repo') as { name: string }).name, 'my-repo');
	});

	test('rejects unsafe or unsupported input', () => {
		assert.strictEqual(parseCloneUrl(''), 'empty');
		assert.strictEqual(parseCloneUrl('--upload-pack=touch /tmp/x'), 'unsafe');
		assert.strictEqual(parseCloneUrl('ext::sh -c touch% /tmp/pwned'), 'unsafe');
		assert.strictEqual(parseCloneUrl('https://example.com/a\nb'), 'unsafe');
		assert.strictEqual(parseCloneUrl('ftp://example.com/repo.git'), 'unsupported');
		assert.strictEqual(parseCloneUrl('https://github.com/justowner'), 'unsupported');
	});

	test('destination is parent + name, and names are made safe and unique', () => {
		assert.strictEqual(resolveCloneDestination('/Users/me/code', 'volt'), '/Users/me/code/volt');
		assert.strictEqual(resolveCloneDestination('/Users/me/code/', 'volt'), '/Users/me/code/volt');
		assert.strictEqual(resolveCloneDestination('/', 'volt'), '/volt');
		assert.strictEqual(resolveCloneDestination('C:\\code', 'volt'), 'C:\\code\\volt');
		assert.strictEqual(sanitizeFolderName('..a:b*c'), 'a-b-c');
		assert.strictEqual(nextFreeName('volt', new Set(['volt', 'volt-2'])), 'volt-3');
		assert.strictEqual(nextFreeName('volt', new Set()), 'volt');
	});

	test('recognizes the same remote across protocols', () => {
		assert.ok(sameRemote('git@github.com:Org/Repo.git', 'https://github.com/org/repo'));
		assert.ok(sameRemote('https://user@GitHub.com/org/repo.git/', 'https://github.com/org/repo.git'));
		assert.ok(!sameRemote('https://github.com/org/repo', 'https://github.com/org/other'));
		assert.ok(!sameRemote(undefined, 'https://github.com/org/repo'));
	});
});

suite('Volt projects: browse paths', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('splits a typed path into folder and filter', () => {
		assert.strictEqual(browseDirectory('~/code/ap'), '~/code/');
		assert.strictEqual(browseLeaf('~/code/ap'), 'ap');
		assert.strictEqual(browseDirectory('~/code/'), '~/code/');
		assert.strictEqual(browseLeaf('~/code/'), '');
		assert.strictEqual(browseDirectory('~'), '~/');
		assert.strictEqual(browseDirectory('C:\\Users\\me\\co'), 'C:\\Users\\me\\');
	});

	test('walks up to the root', () => {
		assert.strictEqual(parentDirectory('/Users/me/code/'), '/Users/me/');
		assert.strictEqual(parentDirectory('/Users/'), '/');
		assert.strictEqual(parentDirectory('/'), undefined);
		assert.strictEqual(parentDirectory('~/code/'), '~/');
		assert.strictEqual(parentDirectory('C:\\Users\\'), 'C:\\');
		assert.strictEqual(parentDirectory('C:\\'), undefined);
		assert.strictEqual(ensureTrailingSeparator('/a'), '/a/');
		assert.strictEqual(ensureTrailingSeparator('C:\\a'), 'C:\\a\\');
	});

	test('tildifies only whole home segments', () => {
		assert.strictEqual(tildify('/Users/me/code', '/Users/me'), '~/code');
		assert.strictEqual(tildify('/Users/me', '/Users/me'), '~');
		assert.strictEqual(tildify('/Users/meta/code', '/Users/me'), '/Users/meta/code');
		assert.strictEqual(untildify('~/code', '/Users/me'), '/Users/me/code');
		assert.strictEqual(untildify('/abs', '/Users/me'), '/abs');
	});

	test('breadcrumbs open each ancestor', () => {
		assert.deepStrictEqual(breadcrumbParts('~/code/volt/'), [
			{ label: '~', path: '~/' },
			{ label: 'code', path: '~/code/' },
			{ label: 'volt', path: '~/code/volt/' },
		]);
		assert.deepStrictEqual(breadcrumbParts('/tmp/'), [{ label: '/', path: '/' }, { label: 'tmp', path: '/tmp/' }]);
	});

	test('a newer navigation supersedes an older one', () => {
		const generation = new BrowseGeneration();
		const first = generation.next();
		const second = generation.next();
		assert.ok(!generation.isCurrent(first));
		assert.ok(generation.isCurrent(second));
	});
});

suite('Volt projects: folder search ranking', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exact and prefix beat fuzzy; git repos and projects are boosted', () => {
		const folders = [
			{ name: 'apps', path: '/h/apps' },
			{ name: 'api', path: '/h/work/client/api', gitRepo: true },
			{ name: 'my-api-docs', path: '/h/docs/my-api-docs' },
			{ name: 'a-p-i', path: '/h/x/a-p-i' },
			{ name: 'zzz', path: '/h/zzz' },
		];
		const ranked = rankFolders(folders, 'api', { projects: new Set(), recents: [] }).map(folder => folder.name);
		assert.deepStrictEqual(ranked, ['api', 'my-api-docs', 'a-p-i']);
		const boosted = rankFolders([{ name: 'api-old', path: '/h/api-old' }, { name: 'api-new', path: '/h/api-new' }], 'api', { projects: new Set(['/h/api-new']), recents: [] });
		assert.strictEqual(boosted[0].name, 'api-new');
	});
});
