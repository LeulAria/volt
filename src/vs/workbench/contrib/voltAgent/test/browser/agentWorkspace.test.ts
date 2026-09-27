/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { AgentWorkspaceService, createAgentWorkspace, mergeAgentWorkspaces, reviveAgentWorkspaces } from '../../browser/workspace/agentWorkspace.js';
import { chooseAgentBrowserSurfaceMount } from '../../browser/workspace/agentBrowserMount.js';
import { surfaceDropAccepted, shouldOpenSurfaceSplit, isLastOpenSurface, shouldHideAgentQuickOpenRail, surfaceKindForMenuAction } from '../../browser/workspace/agentSurfaceHost.js';
import { agentSurfaceMenuItems } from '../../browser/workspace/agentSurfaceMenu.js';

suite('Agent workspaces', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('each agent gets its own clean workspace', () => {
		const service = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		service.update('a', 'terminals', [{ id: 't1', cwd: '/repo' }]);
		service.setMemory('a', 'note', 'keep');

		const b = service.getOrCreate('b');
		assert.deepStrictEqual(b.terminals, []);
		assert.deepStrictEqual(b.memory, {});
		assert.deepStrictEqual(service.get('a')?.terminals, [{ id: 't1', cwd: '/repo' }]);
		assert.deepStrictEqual(service.get('a')?.memory, { note: 'keep' });
	});

	test('activating switches the active workspace once', () => {
		const service = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		const seen: (string | undefined)[] = [];
		store.add(service.onDidChangeActive(w => seen.push(w?.sessionId)));
		service.activate('a');
		service.activate('a');
		service.activate('b');
		service.delete('b');
		assert.deepStrictEqual(seen, ['a', 'b', undefined]);
		assert.strictEqual(service.active, undefined);
	});

	test('persists across reloads', async () => {
		const storage = store.add(new InMemoryStorageService());
		const first = store.add(new AgentWorkspaceService(storage));
		first.activate('a');
		first.update('a', 'layout', { dock: 'terminal' });
		await storage.flush();

		const second = store.add(new AgentWorkspaceService(storage));
		assert.strictEqual(second.active?.sessionId, 'a');
		assert.deepStrictEqual(second.get('a')?.layout, { dock: 'terminal' });
	});

	test('revive keeps idle sessions, repairs missing slots, and drops malformed entries', () => {
		const now = 100 * 24 * 60 * 60 * 1000;
		const fresh = createAgentWorkspace('fresh', now);
		const revived = reviveAgentWorkspaces([
			fresh,
			{ sessionId: 'partial', lastActiveAt: now - 1 },
			{ sessionId: 'stale', lastActiveAt: 0, terminals: [{ id: 't-old', cwd: '/repo' }] },
			{ lastActiveAt: now },
			null,
		], now);
		assert.deepStrictEqual([...revived.keys()], ['fresh', 'partial', 'stale']);
		assert.deepStrictEqual(revived.get('partial')?.files, []);
		assert.deepStrictEqual(revived.get('partial')?.surfaces, []);
		assert.strictEqual(revived.get('stale')?.surfaces[0]?.kind, 'terminal');
		assert.deepStrictEqual(reviveAgentWorkspaces('junk', now).size, 0);
	});

	test('a save keeps what another window stored in the meantime', async () => {
		const storage = store.add(new InMemoryStorageService());
		const windowA = store.add(new AgentWorkspaceService(storage));
		const windowB = store.add(new AgentWorkspaceService(storage));
		windowA.update('a', 'layout', { dock: 'browser' });
		await storage.flush();
		windowB.update('b', 'layout', { dock: 'terminal' });
		await storage.flush();

		const reloaded = store.add(new AgentWorkspaceService(storage));
		assert.deepStrictEqual(reloaded.get('a')?.layout, { dock: 'browser' });
		assert.deepStrictEqual(reloaded.get('b')?.layout, { dock: 'terminal' });
	});

	test('merge: a record changed here wins, otherwise the newer one, and local deletes stick', () => {
		const record = (id: string, updatedAt: number, dock: string) => ({ ...createAgentWorkspace(id, 0), updatedAt, layout: { dock } });
		const stored = new Map([
			['a', record('a', 5, 'stored')],
			['b', record('b', 5, 'stored')],
			['c', record('c', 5, 'stored')],
		]);
		const local = new Map([
			['a', record('a', 1, 'local-edited')],
			['b', record('b', 1, 'local-stale')],
		]);
		const merged = mergeAgentWorkspaces(stored, local, new Set(['a']), new Set(['c']));
		assert.strictEqual(merged.get('a')?.layout.dock, 'local-edited');
		assert.strictEqual(merged.get('b')?.layout.dock, 'stored');
		assert.strictEqual(merged.has('c'), false);
	});

	test('revive drops terminal instance ids, which restart with every window load', () => {
		const revived = reviveAgentWorkspaces([{
			sessionId: 'a',
			lastActiveAt: 1,
			surfaces: [{ kind: 'terminal', id: 't1', title: 'Terminal', cwd: '/repo', terminalInstanceId: 3 }],
		}], 1);
		assert.deepStrictEqual(revived.get('a')?.surfaces, [{ kind: 'terminal', id: 't1', title: 'Terminal', cwd: '/repo' }]);
	});

	test('drops: tabs and terminals open beside the chat, files do only on the open tools', () => {
		const tab = { terminals: false, editorTabs: true, files: true };
		const terminal = { terminals: true, editorTabs: false, files: false };
		const file = { terminals: false, editorTabs: false, files: true };
		assert.strictEqual(surfaceDropAccepted(tab, false, false, true), true);
		assert.strictEqual(surfaceDropAccepted(terminal, false, false, true), true);
		assert.strictEqual(surfaceDropAccepted(tab, false, false, false), false, 'left half stays a mention');
		assert.strictEqual(surfaceDropAccepted(file, false, false, true), false, 'a file on the chat stays a mention');
		assert.strictEqual(surfaceDropAccepted(file, true, true, true), true);
		assert.strictEqual(surfaceDropAccepted(tab, true, false, true), false, 'over the chat while tools are open');
	});

	test('tools split stays while a surface remains, and closes with the last tab', () => {
		assert.strictEqual(shouldOpenSurfaceSplit(0), false);
		assert.strictEqual(shouldOpenSurfaceSplit(1), true);
		assert.strictEqual(shouldOpenSurfaceSplit(3), true);

		const service = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		const first = service.openSurface('a', { kind: 'browser', url: 'https://example.com', title: 'example.com' }, false);
		const second = service.openSurface('a', { kind: 'terminal', title: 'Terminal', cwd: '/repo' }, false);
		assert.strictEqual(shouldOpenSurfaceSplit(service.get('a')?.surfaces.length ?? 0), true);

		service.closeSurface('a', first.id);
		assert.strictEqual(service.get('a')?.surfaces.length, 1);
		assert.strictEqual(service.get('a')?.surfaces[0]?.id, second.id);
		assert.strictEqual(service.get('a')?.layout.activeSurfaceId, second.id);
		assert.strictEqual(shouldOpenSurfaceSplit(service.get('a')?.surfaces.length ?? 0), true);

		service.closeSurface('a', second.id);
		assert.strictEqual(service.get('a')?.surfaces.length, 0);
		assert.strictEqual(service.get('a')?.layout.activeSurfaceId, undefined);
		assert.strictEqual(shouldOpenSurfaceSplit(service.get('a')?.surfaces.length ?? 0), false);
		assert.strictEqual(isLastOpenSurface(['only'], 'only'), true);
		assert.strictEqual(isLastOpenSurface(['only'], 'other'), false);
		assert.strictEqual(isLastOpenSurface(['a', 'b'], 'a'), false);
	});

	test('vertical Quick Open rail hides only while the tools pane is open', () => {
		assert.strictEqual(shouldHideAgentQuickOpenRail(true), true);
		assert.strictEqual(shouldHideAgentQuickOpenRail(false), false);
		assert.strictEqual(shouldHideAgentQuickOpenRail(shouldOpenSurfaceSplit(0)), false);
		assert.strictEqual(shouldHideAgentQuickOpenRail(shouldOpenSurfaceSplit(2)), true);
	});

	test('+ menu actions map to surface kinds, and Changes reuses one tab', () => {
		assert.strictEqual(surfaceKindForMenuAction('terminal'), 'terminal');
		assert.strictEqual(surfaceKindForMenuAction('changes'), 'changes');
		assert.strictEqual(surfaceKindForMenuAction('sideChat'), 'chat');
		assert.strictEqual(surfaceKindForMenuAction('browser'), 'browser');
		assert.strictEqual(surfaceKindForMenuAction('file'), 'file');
		assert.deepStrictEqual(agentSurfaceMenuItems().map(item => item.id), ['file', 'terminal', 'browser', 'changes', 'sideChat']);

		const service = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		const first = service.openSurface('a', { kind: 'changes', title: 'Changes' }, true);
		const again = service.openSurface('a', { kind: 'changes', title: 'Changes' }, true);
		assert.strictEqual(again.id, first.id);
		assert.strictEqual(service.get('a')?.surfaces.length, 1);
		assert.strictEqual(service.get('a')?.layout.activeSurfaceId, first.id);
	});

	test('agent browser surfaces mount the IDE browser chrome, not a bare webview', () => {
		assert.strictEqual(chooseAgentBrowserSurfaceMount(), 'ide-chrome');
	});

	test('a file opened twice stays one surface, and another chat keeps its own', () => {
		const service = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		service.openSurface('a', { kind: 'file', resource: 'file:///repo-a/src/index.ts', title: 'index.ts' }, true);
		service.openSurface('a', { kind: 'terminal', title: 'Terminal', cwd: '/repo-a' }, false);
		service.openSurface('b', { kind: 'browser', url: 'https://example.com', title: 'example.com' }, false);
		const again = service.openSurface('a', { kind: 'file', resource: 'file:///repo-a/src/index.ts', title: 'index.ts' }, true);

		assert.strictEqual(service.get('a')?.surfaces.length, 2);
		assert.strictEqual(service.get('a')?.layout.activeSurfaceId, again.id);
		assert.strictEqual(service.get('b')?.surfaces.length, 1);
		assert.strictEqual(service.get('b')?.surfaces[0]?.kind, 'browser');
	});

	test('scratch memory drops values that are too large to store', () => {
		const service = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		service.setMemory('a', 'note', 'keep');
		service.setMemory('a', 'blob', 'x'.repeat(9000));
		assert.deepStrictEqual(service.get('a')?.memory, { note: 'keep' });
	});

	test('split ratio stays inside the pane', () => {
		const service = store.add(new AgentWorkspaceService(store.add(new InMemoryStorageService())));
		service.setSplitRatio('a', 0.99);
		service.setSplitRatio('a', Number.NaN);
		assert.strictEqual(service.get('a')?.layout.splitRatio, 0.5);
		service.setSplitRatio('a', 0.1);
		assert.strictEqual(service.get('a')?.layout.splitRatio, 0.25);
	});
});
