/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { buildAgentHomeTree, compactSessionAge, latestSessionForFolder, shouldShowAgentEditorTabs, uniqueHomeFolders } from '../../browser/home/agentHomeModel.js';

function session(id: string, extra: Partial<IAgentSessionMeta> = {}): IAgentSessionMeta {
	return {
		id,
		title: id,
		createdAt: 1,
		updatedAt: 1,
		workspaceId: 'w',
		workspaceLabel: 'volt',
		turnCount: 1,
		preview: id,
		status: 'done',
		...extra,
	};
}

suite('Agent home list model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('hides editor tabs when only one agent is open', () => {
		assert.strictEqual(shouldShowAgentEditorTabs(0), false);
		assert.strictEqual(shouldShowAgentEditorTabs(1), false);
		assert.strictEqual(shouldShowAgentEditorTabs(2), true);
	});

	test('formats compact ages the way the sidebar shows them', () => {
		const now = 1_000_000;
		assert.strictEqual(compactSessionAge(now - 2_000, now), '2s');
		assert.strictEqual(compactSessionAge(now - 120_000, now), '2m');
		assert.strictEqual(compactSessionAge(now - 15 * 3600_000, now), '15h');
		assert.strictEqual(compactSessionAge(now - 3 * 86400_000, now), '3d');
	});

	test('nests the latest session under a matching workspace', () => {
		const folder = { uri: URI.file('/tmp/volt'), name: 'volt', current: true, workspace: false };
		const older = session('old', { workspaceFolder: '/tmp/volt', updatedAt: 10, title: 'older' });
		const newer = session('new', { workspaceFolder: '/tmp/volt', updatedAt: 20, title: 'newer' });
		assert.strictEqual(latestSessionForFolder(folder, [older, newer])?.id, 'new');
	});

	test('keeps New Chat and Search as root siblings of Projects and Workspaces', () => {
		const tree = buildAgentHomeTree(
			[{ uri: URI.file('/tmp/app'), name: 'app', current: false, workspace: false }],
			[{ uri: URI.file('/tmp/volt'), name: 'volt', current: true, workspace: false }],
			[session('chat', { workspaceFolder: '/tmp/volt', title: 'Setup' })],
		);
		assert.deepStrictEqual(tree.map(node => node.element.type), ['newChat', 'action', 'action', 'action', 'section', 'section']);
		assert.ok(tree.every(node => node.element.type !== 'folder' && node.element.type !== 'session'));
		const projects = tree[4];
		const workspaces = tree[5];
		assert.ok(projects.element.type === 'section' && projects.element.key === 'projects');
		assert.strictEqual(projects.collapsed, false);
		assert.ok(workspaces.element.type === 'section' && workspaces.element.key === 'workspaces');
		assert.strictEqual(workspaces.collapsed, false);
		assert.strictEqual(workspaces.children?.[0].element.type, 'folder');
		assert.strictEqual(workspaces.children?.[0].collapsed, false);
		assert.strictEqual(workspaces.children?.[0].children?.[0].element.type, 'session');
	});

	test('drops duplicate workspace and project rows for the same folder', () => {
		const volt = { uri: URI.file('/tmp/volt'), name: 'volt', current: true, workspace: false };
		const duplicate = { uri: URI.file('/tmp/volt'), name: 'volt-copy', current: false, workspace: false };
		const other = { uri: URI.file('/tmp/app'), name: 'app', current: false, workspace: false };
		assert.deepStrictEqual(uniqueHomeFolders([duplicate, volt, other, volt]).map(folder => folder.name), ['volt', 'app']);
		const tree = buildAgentHomeTree([volt, duplicate], [volt, other, duplicate], []);
		assert.strictEqual(tree[4].children?.filter(child => child.element.type === 'folder').length, 1);
		assert.strictEqual(tree[5].children?.length, 2);
		assert.strictEqual(tree[5].children?.[0].element.type, 'folder');
		assert.strictEqual(tree[5].children?.[1].element.type, 'folder');
	});

	test('scopes session identities to the parent folder', () => {
		const tree = buildAgentHomeTree(
			[],
			[
				{ uri: URI.file('/tmp/volt'), name: 'volt', current: true, workspace: false },
				{ uri: URI.file('/tmp/other'), name: 'other', current: false, workspace: false },
			],
			[session('chat', { workspaceFolder: '/tmp/volt', title: 'Setup' })],
		);
		const sessionNode = tree[5].children?.[0].children?.[0];
		assert.ok(sessionNode?.element.type === 'session');
		assert.strictEqual(sessionNode.element.folderKey, URI.file('/tmp/volt').toString());
		assert.strictEqual(sessionNode.element.session.id, 'chat');
	});

	test('nests every matching agent tab under a project', () => {
		const tree = buildAgentHomeTree(
			[{ uri: URI.file('/tmp/volt'), name: 'volt', current: true, workspace: false }],
			[],
			[
				session('older', { workspaceFolder: '/tmp/volt', updatedAt: 10, title: 'older' }),
				session('newer', { workspaceFolder: '/tmp/volt', updatedAt: 20, title: 'newer' }),
			],
		);
		const project = tree[4].children?.[1];
		assert.strictEqual(project?.element.type, 'folder');
		assert.strictEqual(project?.collapsed, false);
		assert.deepStrictEqual(project?.children?.map(child => child.element.type === 'session' ? child.element.session.id : ''), ['newer', 'older']);
	});
});
