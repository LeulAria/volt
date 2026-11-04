/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { folderGrantError, IFolderGrantContext, inheritedSandboxSettings, isAtLeastAsStrict, stricterSandboxSettings } from '../../common/sandboxInheritance.js';
import { IVoltSandboxSettings } from '../../common/sandboxPolicy.js';

const OFF: IVoltSandboxSettings = { level: 'off', network: true };
const WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: true };
const WRITE_OFFLINE: IVoltSandboxSettings = { level: 'workspace-write', network: false };
const READ: IVoltSandboxSettings = { level: 'read-only', network: true };

const MAC: IFolderGrantContext = {
	home: '/Users/me',
	workspaceRoots: ['/Users/me/code/repo'],
	userDataDir: '/Users/me/Library/Application Support/Volt',
};

suite('Volt sandbox inheritance', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the stricter level wins: read-only > workspace-write > off', () => {
		assert.strictEqual(stricterSandboxSettings(WRITE, READ).level, 'read-only');
		assert.strictEqual(stricterSandboxSettings(READ, WRITE).level, 'read-only');
		assert.strictEqual(stricterSandboxSettings(OFF, WRITE).level, 'workspace-write');
		assert.strictEqual(stricterSandboxSettings(WRITE, OFF).level, 'workspace-write');
		assert.deepStrictEqual(stricterSandboxSettings(OFF, OFF), OFF);
	});

	test('off on either side returns the other side unchanged', () => {
		const child: IVoltSandboxSettings = { level: 'read-only', network: false, extraWritableRoots: ['/data'], allowedDomains: ['example.com'] };
		assert.deepStrictEqual(stricterSandboxSettings(OFF, child), child);
		assert.deepStrictEqual(stricterSandboxSettings(child, { level: 'off', network: false }), child);
	});

	test('network off beats on', () => {
		assert.strictEqual(stricterSandboxSettings(WRITE, WRITE_OFFLINE).network, false);
		assert.strictEqual(stricterSandboxSettings(WRITE_OFFLINE, READ).network, false);
		assert.strictEqual(stricterSandboxSettings(WRITE, READ).network, true);
	});

	test('extra writable folders: only what both grant', () => {
		const parent: IVoltSandboxSettings = { ...WRITE, extraWritableRoots: ['/data', '/shared/cache'] };
		const child: IVoltSandboxSettings = { ...WRITE, extraWritableRoots: ['/data/sub', '/shared', '/other'] };
		assert.deepStrictEqual([...stricterSandboxSettings(parent, child).extraWritableRoots ?? []].sort(), ['/data/sub', '/shared/cache']);
		assert.strictEqual(stricterSandboxSettings(parent, WRITE).extraWritableRoots, undefined, 'a child with none gets none');
		assert.strictEqual(stricterSandboxSettings(WRITE, child).extraWritableRoots, undefined, 'a parent with none gives none');
	});

	test('allowed hosts: only what both reach', () => {
		const parent: IVoltSandboxSettings = { ...WRITE_OFFLINE, allowedDomains: ['*.example.com', 'pypi.org'] };
		const child: IVoltSandboxSettings = { ...WRITE_OFFLINE, allowedDomains: ['api.example.com', 'evil.com'] };
		assert.deepStrictEqual(stricterSandboxSettings(parent, child).allowedDomains, ['api.example.com']);
		// A parent with network on reaches every host, so the offline child keeps its own list.
		assert.deepStrictEqual(stricterSandboxSettings({ ...WRITE, allowedDomains: [] }, child).allowedDomains, ['api.example.com', 'evil.com']);
		// An offline parent with no extra hosts leaves an online child offline with none.
		const result = stricterSandboxSettings(WRITE_OFFLINE, { ...WRITE, allowedDomains: ['x.com'] });
		assert.strictEqual(result.network, false);
		assert.strictEqual(result.allowedDomains, undefined);
	});

	test('isAtLeastAsStrict', () => {
		assert.ok(isAtLeastAsStrict(READ, WRITE));
		assert.ok(!isAtLeastAsStrict(WRITE, READ));
		assert.ok(isAtLeastAsStrict(WRITE, WRITE));
		assert.ok(isAtLeastAsStrict(OFF, OFF));
		assert.ok(isAtLeastAsStrict(WRITE, OFF));
		assert.ok(!isAtLeastAsStrict(OFF, WRITE));
		assert.ok(!isAtLeastAsStrict(WRITE, WRITE_OFFLINE), 'network on is weaker');
		assert.ok(isAtLeastAsStrict(WRITE_OFFLINE, WRITE));
		assert.ok(!isAtLeastAsStrict({ ...WRITE, extraWritableRoots: ['/data'] }, WRITE), 'an extra folder the other lacks');
		assert.ok(isAtLeastAsStrict({ ...WRITE, extraWritableRoots: ['/data/sub'] }, { ...WRITE, extraWritableRoots: ['/data'] }));
		assert.ok(!isAtLeastAsStrict({ ...WRITE_OFFLINE, allowedDomains: ['evil.com'] }, WRITE_OFFLINE), 'a host the other lacks');
		assert.ok(isAtLeastAsStrict({ ...WRITE_OFFLINE, allowedDomains: ['api.example.com'] }, { ...WRITE_OFFLINE, allowedDomains: ['*.example.com'] }));
		assert.ok(isAtLeastAsStrict({ ...WRITE_OFFLINE, allowedDomains: ['evil.com'] }, WRITE), 'the other reaches every host');
	});

	test('the stricter settings are at least as strict as both sides', () => {
		const sides: IVoltSandboxSettings[] = [
			OFF, WRITE, WRITE_OFFLINE, READ,
			{ ...READ, network: false, extraWritableRoots: ['/a', '/b/c'], allowedDomains: ['*.x.com'] },
			{ ...WRITE_OFFLINE, extraWritableRoots: ['/a/b', '/b'], allowedDomains: ['api.x.com', 'y.com'] },
		];
		for (const a of sides) {
			for (const b of sides) {
				const result = stricterSandboxSettings(a, b);
				assert.ok(isAtLeastAsStrict(result, a), `${JSON.stringify(result)} vs ${JSON.stringify(a)}`);
				assert.ok(isAtLeastAsStrict(result, b), `${JSON.stringify(result)} vs ${JSON.stringify(b)}`);
			}
		}
	});

	test('inheritedSandboxSettings: only when the parent is sandboxed and the child is weaker', () => {
		assert.strictEqual(inheritedSandboxSettings(OFF, WRITE), undefined);
		assert.strictEqual(inheritedSandboxSettings(WRITE, READ), undefined);
		assert.deepStrictEqual(inheritedSandboxSettings(READ, OFF), READ);
		assert.deepStrictEqual(inheritedSandboxSettings(WRITE_OFFLINE, READ), { level: 'read-only', network: false });
	});

	test('folderGrantError refuses the disk, home and its parents', () => {
		assert.ok(folderGrantError('/', MAC));
		assert.ok(folderGrantError('/Users/me', MAC));
		assert.ok(folderGrantError('/Users/me/', MAC));
		assert.ok(folderGrantError('/Users', MAC));
		assert.ok(folderGrantError('relative/path', MAC));
	});

	test('folderGrantError refuses system folders but not temp', () => {
		for (const folder of ['/System/Library', '/usr', '/usr/local/lib', '/bin', '/sbin', '/etc', '/private/etc', '/Library/LaunchDaemons', '/opt/homebrew', '/var/db', '/private/var/root', '/Applications/Volt.app', '/Volumes', '/Volumes/External']) {
			assert.ok(folderGrantError(folder, MAC), folder);
		}
		for (const folder of ['/var/folders/ab/xyz/T/build', '/private/var/folders/ab/xyz/T', '/tmp', '/private/tmp/scratch', '/Volumes/External/project']) {
			assert.strictEqual(folderGrantError(folder, MAC), undefined, folder);
		}
	});

	test('folderGrantError refuses credentials, startup files and folders containing them', () => {
		for (const folder of ['/Users/me/.ssh', '/Users/me/.aws/cli', '/Users/me/.gnupg', '/Users/me/.config/gcloud', '/Users/me/.kube', '/Users/me/.docker', '/Users/me/.config/gh', '/Users/me/Library/Keychains', '/Users/me/Library/Application Support/Google/Chrome/Default', '/Users/me/Library/LaunchAgents', '/Users/me/.config', '/Users/me/Library', '/Users/me/Library/Application Support']) {
			assert.ok(folderGrantError(folder, MAC), folder);
		}
	});

	test('folderGrantError refuses Volt\'s data folder and protected names', () => {
		assert.ok(folderGrantError('/Users/me/Library/Application Support/Volt/User', MAC));
		for (const folder of ['/Users/me/code/other/.git', '/Users/me/code/other/.git/hooks', '/Users/me/code/repo/.vscode', '/Users/me/code/other/.husky', '/Users/me/code/other/.claude', '/Users/me/code/repo/.claude/commands']) {
			assert.ok(folderGrantError(folder, MAC), folder);
		}
	});

	test('folderGrantError refuses parents of the chat\'s checkout, allows ordinary folders', () => {
		assert.ok(folderGrantError('/Users/me/code', MAC));
		const worktree: IFolderGrantContext = { ...MAC, workspaceRoots: ['/Users/me/.volt/worktrees/x/repo-1', '/Users/me/code/repo/.git'] };
		assert.ok(folderGrantError('/Users/me/code/repo', worktree), 'the main checkout of a worktree chat');
		for (const folder of ['/Users/me/code/other', '/Users/me/code/repo/build', '/Users/me/Desktop/notes', '/data/cache', '/Users/me/.volt/worktrees/x/repo-2']) {
			assert.strictEqual(folderGrantError(folder, MAC), undefined, folder);
		}
	});
});
