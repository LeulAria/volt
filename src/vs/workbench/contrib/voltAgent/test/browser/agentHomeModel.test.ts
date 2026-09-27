/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentSessionMeta } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { defaultAgentHomeViewState, IAgentHomeViewState } from '../../browser/home/agentHomeFilter.js';
import {
	AGENT_HOME_GROUP_EXPAND_ALL,
	AGENT_HOME_GROUP_LIMIT,
	AGENT_HOME_WEEK_LIMIT,
	agentHomeAddStart,
	agentPanelTabsMode,
	buildAgentHomeTree,
	compactSessionAge,
	IAgentHomeFolder,
	IAgentHomeNode,
	latestSessionForFolder,
	sessionMetaParts,
	uniqueHomeFolders,
} from '../../browser/home/agentHomeModel.js';
import { IAgentRepoInfo } from '../../browser/home/agentRepoInfo.js';

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

type SetOf<T> = T extends ReadonlySet<infer U> ? U : never;

function view(extra: Partial<{
	grouping: IAgentHomeViewState['grouping'];
	chatOrder: IAgentHomeViewState['chatOrder'];
	groupOrder: IAgentHomeViewState['groupOrder'];
	show: Iterable<SetOf<IAgentHomeViewState['show']>>;
	status: Iterable<SetOf<IAgentHomeViewState['status']>>;
	pr: Iterable<SetOf<IAgentHomeViewState['pr']>>;
	source: Iterable<SetOf<IAgentHomeViewState['source']>>;
	archived: IAgentHomeViewState['archived'];
}> = {}): IAgentHomeViewState {
	const base = defaultAgentHomeViewState();
	return {
		...base,
		grouping: extra.grouping ?? base.grouping,
		chatOrder: extra.chatOrder ?? base.chatOrder,
		groupOrder: extra.groupOrder ?? base.groupOrder,
		show: extra.show ? new Set(extra.show) : base.show,
		status: extra.status ? new Set(extra.status) : base.status,
		pr: extra.pr ? new Set(extra.pr) : base.pr,
		source: extra.source ? new Set(extra.source) : base.source,
		archived: extra.archived ?? base.archived,
	};
}

function folder(path: string, extra: Partial<IAgentHomeFolder> = {}): IAgentHomeFolder {
	return { uri: URI.file(path), name: path.split('/').at(-1)!, current: false, workspace: false, ...extra };
}

function section(tree: readonly IAgentHomeNode[]): IAgentHomeNode {
	const found = tree.find(node => node.element.type === 'section');
	assert.ok(found, 'expected a section');
	return found;
}

function projectLabels(node: IAgentHomeNode): string[] {
	return (node.children ?? []).map(child => child.element.type === 'folder' ? child.element.project.label : child.element.type);
}

function sessionIds(node: IAgentHomeNode | undefined): string[] {
	return (node?.children ?? []).map(child => child.element.type === 'session' ? child.element.session.id : child.element.type);
}

function headers(tree: readonly IAgentHomeNode[]): string[] {
	return tree.flatMap(node => node.element.type === 'bucket' ? [node.element.id] : node.element.type === 'section' ? [`section:${node.element.key}`] : []);
}

function repo(path: string, name: string, owner: string, id = `github.com/${owner}/${name}`): IAgentRepoInfo {
	return { id, name, owner, root: URI.file(path), branch: 'main' };
}

suite('Agent home list model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('agent panels never show a tab strip', () => {
		assert.strictEqual(agentPanelTabsMode(0), 'none');
		assert.strictEqual(agentPanelTabsMode(1), 'single');
	});

	test('formats compact ages the way the sidebar shows them', () => {
		const now = 1_000_000;
		assert.strictEqual(compactSessionAge(now - 2_000, now), '2s');
		assert.strictEqual(compactSessionAge(now - 120_000, now), '2m');
		assert.strictEqual(compactSessionAge(now - 15 * 3600_000, now), '15h');
		assert.strictEqual(compactSessionAge(now - 3 * 86400_000, now), '3d');
	});

	test('finds the latest session of a folder', () => {
		const volt = folder('/tmp/volt', { current: true });
		assert.strictEqual(latestSessionForFolder(volt, [
			session('old', { workspaceFolder: '/tmp/volt', updatedAt: 10 }),
			session('new', { workspaceFolder: '/tmp/volt', updatedAt: 20 }),
		])?.id, 'new');
	});

	test('starts with one Workspaces section that carries the filter', () => {
		const tree = buildAgentHomeTree([folder('/tmp/app'), folder('/tmp/volt', { current: true })], [session('chat', { workspaceFolder: '/tmp/volt' })], view());
		assert.deepStrictEqual(tree.map(node => node.element.type), ['section']);
		const workspaces = section(tree);
		assert.ok(workspaces.element.type === 'section' && workspaces.element.key === 'workspaces' && workspaces.element.filter);
		assert.deepStrictEqual(projectLabels(workspaces), ['volt']);
	});

	test('nests agent tabs under their project, newest first', () => {
		const tree = buildAgentHomeTree([folder('/tmp/volt', { current: true })], [
			session('older', { workspaceFolder: '/tmp/volt', updatedAt: 10 }),
			session('newer', { workspaceFolder: '/tmp/volt', updatedAt: 20 }),
		], view());
		const project = section(tree).children?.[0];
		assert.ok(project?.element.type === 'folder');
		assert.strictEqual(project.collapsed, false);
		assert.deepStrictEqual(sessionIds(project), ['newer', 'older']);
		const first = project.children?.[0].element;
		assert.ok(first?.type === 'session' && first.nested);
	});

	test('lists sessions whose folder the sidebar does not know', () => {
		const tree = buildAgentHomeTree([], [session('lost', { workspaceFolder: '/tmp/elsewhere' })], view());
		assert.deepStrictEqual(projectLabels(section(tree)), ['elsewhere']);
	});

	test('shows Settled and Snooze only when used; snooze wins', () => {
		const folders = [folder('/tmp/volt', { current: true })];
		const empty = buildAgentHomeTree(folders, [session('chat', { workspaceFolder: '/tmp/volt' })], view());
		assert.ok(!empty.some(node => node.element.type === 'group'));
		const tree = buildAgentHomeTree(folders, [
			session('active', { workspaceFolder: '/tmp/volt' }),
			session('done', { workspaceFolder: '/tmp/volt', settled: true }),
			session('both', { workspaceFolder: '/tmp/volt', settled: true, snoozed: true }),
		], view());
		const groups = tree.filter(node => node.element.type === 'group');
		assert.deepStrictEqual(groups.map(node => node.element.type === 'group' ? node.element.id : ''), ['settled', 'snooze']);
		assert.deepStrictEqual(sessionIds(groups[0]), ['done']);
		assert.deepStrictEqual(sessionIds(groups[1]), ['both']);
		assert.ok(groups.every(node => node.collapsed));
	});

	test('drops duplicate rows for the same folder', () => {
		const volt = folder('/tmp/volt', { current: true });
		const duplicate = { ...folder('/tmp/volt'), name: 'volt-copy' };
		assert.deepStrictEqual(uniqueHomeFolders([duplicate, volt, folder('/tmp/app'), volt]).map(f => f.name), ['volt', 'app']);
		const tree = buildAgentHomeTree([volt, duplicate, folder('/tmp/app')], [
			session('chat', { workspaceFolder: '/tmp/volt' }),
			session('other', { workspaceFolder: '/tmp/app' }),
		], view());
		assert.strictEqual(section(tree).children?.length, 2);
	});

	test('filters by status and PR', () => {
		const folders = [folder('/tmp/volt')];
		const sessions = [
			session('done', { workspaceFolder: '/tmp/volt', status: 'done', updatedAt: 3 }),
			session('running', { workspaceFolder: '/tmp/volt', status: 'running', updatedAt: 2 }),
			session('error', { workspaceFolder: '/tmp/volt', status: 'error', updatedAt: 1 }),
		];
		assert.deepStrictEqual(sessionIds(section(buildAgentHomeTree(folders, sessions, view({ status: ['working'] }))).children?.[0]), ['running']);
		const noPr = section(buildAgentHomeTree(folders, sessions, view({ pr: ['open'] })));
		assert.deepStrictEqual(noPr.children?.map(child => child.element.type), ['empty']);
		assert.ok(noPr.children?.[0].element.type === 'empty' && noPr.children[0].element.filtered);
	});

	test('orders chats by status when selected', () => {
		const tree = buildAgentHomeTree([folder('/tmp/volt', { current: true })], [
			session('done', { workspaceFolder: '/tmp/volt', status: 'done', updatedAt: 30 }),
			session('error', { workspaceFolder: '/tmp/volt', status: 'error', updatedAt: 10 }),
			session('running', { workspaceFolder: '/tmp/volt', status: 'running', updatedAt: 20 }),
		], view({ chatOrder: 'status' }));
		assert.deepStrictEqual(sessionIds(section(tree).children?.[0]), ['error', 'running', 'done']);
	});

	test('orders projects manually or by latest activity', () => {
		const folders = [folder('/tmp/a'), folder('/tmp/b')];
		const sessions = [session('a', { workspaceFolder: '/tmp/a', updatedAt: 1 }), session('b', { workspaceFolder: '/tmp/b', updatedAt: 9 })];
		assert.deepStrictEqual(projectLabels(section(buildAgentHomeTree(folders, sessions, view({ groupOrder: 'manual' })))), ['a', 'b']);
		assert.deepStrictEqual(projectLabels(section(buildAgentHomeTree(folders, sessions, view({ groupOrder: 'updated' })))), ['b', 'a']);
	});

	test('status grouping lists agent tabs under fixed status headers', () => {
		const tree = buildAgentHomeTree([folder('/tmp/a'), folder('/tmp/b')], [
			session('done', { workspaceFolder: '/tmp/b', status: 'done' }),
			session('run', { workspaceFolder: '/tmp/a', status: 'running' }),
			session('ask', { workspaceFolder: '/tmp/a', status: 'running', attention: 'approval' }),
			session('draft', { workspaceFolder: '/tmp/a', status: 'idle', turnCount: 0, hasDraft: true }),
			session('pin', { workspaceFolder: '/tmp/a', pinned: true }),
		], view({ grouping: 'status' }));
		assert.deepStrictEqual(headers(tree), ['pinned', 'needsAttention', 'working', 'draft', 'done']);
		const pinned = tree.find(node => node.element.type === 'bucket' && node.element.id === 'pinned');
		assert.ok(pinned?.element.type === 'bucket' && pinned.element.filter, 'filter sits on the first header');
		assert.deepStrictEqual(sessionIds(pinned), ['pin']);
		const done = tree.find(node => node.element.type === 'bucket' && node.element.id === 'done');
		assert.deepStrictEqual(sessionIds(done), ['done'], 'pinned tabs are not repeated');
		const row = done?.children?.[0].element;
		assert.ok(row?.type === 'session' && !row.nested);
	});

	test('updated grouping buckets by day', () => {
		const now = new Date(2026, 8, 27, 15).getTime();
		const tree = buildAgentHomeTree([], [
			session('today', { updatedAt: now - 1000 }),
			session('old', { updatedAt: new Date(2026, 0, 1).getTime() }),
			session('yesterday', { updatedAt: new Date(2026, 8, 26, 12).getTime() }),
		], view({ grouping: 'updated' }), { now });
		assert.deepStrictEqual(headers(tree), ['today', 'yesterday', 'older']);
		assert.strictEqual(tree.find(node => node.element.type === 'bucket' && node.element.id === 'today')?.collapsed, false);
		assert.strictEqual(tree.find(node => node.element.type === 'bucket' && node.element.id === 'yesterday')?.collapsed, false);
		assert.strictEqual(tree.find(node => node.element.type === 'bucket' && node.element.id === 'older')?.collapsed, true);
	});

	test('updated Last 7 Days shows 7 children plus Show more', () => {
		const now = new Date(2026, 8, 27, 15).getTime();
		const day = 86_400_000;
		const weekSessions = Array.from({ length: AGENT_HOME_WEEK_LIMIT + 4 }, (_, i) => session(`w${i}`, {
			updatedAt: now - 2 * day - i * 1_000,
		}));
		const tree = buildAgentHomeTree([], weekSessions, view({ grouping: 'updated' }), { now });
		const week = tree.find(node => node.element.type === 'bucket' && node.element.id === 'week');
		assert.ok(week);
		assert.strictEqual(week.collapsed, false);
		assert.strictEqual(week.children?.length, AGENT_HOME_WEEK_LIMIT + 1);
		const more = week.children?.at(-1)?.element;
		assert.ok(more?.type === 'more' && more.hidden === 4);
		const few = buildAgentHomeTree([], weekSessions.slice(0, 5), view({ grouping: 'updated' }), { now });
		const smallWeek = few.find(node => node.element.type === 'bucket' && node.element.id === 'week');
		assert.strictEqual(smallWeek?.children?.length, 5);
		assert.ok(!smallWeek?.children?.some(child => child.element.type === 'more'));
		const month = buildAgentHomeTree([], [
			session('m', { updatedAt: now - 20 * day }),
		], view({ grouping: 'updated' }), { now }).find(node => node.element.type === 'bucket' && node.element.id === 'month');
		assert.strictEqual(month?.collapsed, true);
	});

	test('environment grouping puts local tabs on this machine', () => {
		const tree = buildAgentHomeTree([], [session('a'), session('b')], view({ grouping: 'environment' }));
		assert.deepStrictEqual(headers(tree), ['local']);
	});

	test('an empty flat grouping keeps a header for the filter', () => {
		const tree = buildAgentHomeTree([], [session('a', { status: 'done' })], view({ grouping: 'status', status: ['working'] }));
		const agents = section(tree);
		assert.ok(agents.element.type === 'section' && agents.element.key === 'agents' && agents.element.filter);
		assert.deepStrictEqual(agents.children?.map(child => child.element.type), ['empty']);
	});

	test('long groups page behind a Show more row', () => {
		const sessions = Array.from({ length: AGENT_HOME_GROUP_LIMIT + 3 }, (_, i) => session(`s${i}`, { updatedAt: 100 - i }));
		const first = buildAgentHomeTree([], sessions, view({ grouping: 'environment' }));
		const bucket = first.find(node => node.element.type === 'bucket');
		assert.strictEqual(bucket?.children?.length, AGENT_HOME_GROUP_LIMIT + 1);
		const more = bucket?.children?.at(-1)?.element;
		assert.ok(more?.type === 'more' && more.hidden === 3 && more.groupKey === 'bucket:local');
		const all = buildAgentHomeTree([], sessions, view({ grouping: 'environment' }), { limits: new Map([['bucket:local', AGENT_HOME_GROUP_EXPAND_ALL]]) });
		assert.strictEqual(all.find(node => node.element.type === 'bucket')?.children?.length, AGENT_HOME_GROUP_LIMIT + 3);
	});

	test('group-header + starts a project for folders and none for flat buckets', () => {
		const project = buildAgentHomeTree([folder('/tmp/volt')], [session('a', { workspaceFolder: '/tmp/volt' })], view()).find(node => node.element.type === 'section')?.children?.[0]?.element;
		assert.ok(project?.type === 'folder');
		const folderStart = agentHomeAddStart(project);
		assert.ok(folderStart?.kind === 'folder');
		assert.strictEqual(folderStart.name, 'volt');
		assert.strictEqual(folderStart.root.fsPath, URI.file('/tmp/volt').fsPath);
		const env = buildAgentHomeTree([], [session('a')], view({ grouping: 'environment' })).find(node => node.element.type === 'bucket')?.element;
		assert.ok(env?.type === 'bucket' && env.add);
		assert.deepStrictEqual(agentHomeAddStart(env), { kind: 'none' });
		const status = buildAgentHomeTree([], [session('a', { status: 'done' })], view({ grouping: 'status' })).find(node => node.element.type === 'bucket')?.element;
		assert.ok(status?.type === 'bucket');
		assert.deepStrictEqual(agentHomeAddStart(status), { kind: 'none' });
	});

	test('repository grouping merges clones and names multi-repo tabs', () => {
		const repos = new Map<string, IAgentRepoInfo>([
			['/src/volt', repo('/src/volt', 'volt', 'leularia')],
			['/tmp/volt-clone', repo('/tmp/volt-clone', 'volt', 'leularia')],
			['/src/aria', repo('/src/aria', 'aria-icons', 'leularia')],
			['/src/vscode', repo('/src/vscode', 'vscode', 'microsoft')],
		]);
		const tree = buildAgentHomeTree([folder('/src/volt'), folder('/src/aria')], [
			session('a', { workspaceFolder: '/src/volt', updatedAt: 5 }),
			session('b', { workspaceFolder: '/tmp/volt-clone', updatedAt: 4 }),
			session('c', { workspaceFolder: '/src/aria', updatedAt: 3 }),
			session('d', { workspaceFolder: '/src/volt', workspaceFolders: ['/src/volt', '/src/vscode'], updatedAt: 2 }),
		], view({ grouping: 'repository' }), { repos });
		const repositories = section(tree);
		assert.ok(repositories.element.type === 'section' && repositories.element.key === 'repositories');
		assert.deepStrictEqual(projectLabels(repositories), ['volt', 'aria-icons', 'volt, microsoft/vscode']);
		assert.deepStrictEqual(sessionIds(repositories.children?.[0]), ['a', 'b']);
		const multi = repositories.children?.[2].element;
		assert.ok(multi?.type === 'folder' && multi.project.multi && !multi.project.folder);
		const volt = repositories.children?.[0].element;
		assert.ok(volt?.type === 'folder' && volt.project.folder?.uri.fsPath === URI.file('/src/volt').fsPath, 'new chats go to the registered folder');
	});

	test('workspace grouping gives multi-folder tabs and workspace files their own row', () => {
		const wsFile = folder('/tmp/app.code-workspace', { name: 'app', workspace: true, workspaceId: 'ws-app' });
		const tree = buildAgentHomeTree([folder('/tmp/volt'), wsFile], [
			session('single', { workspaceFolder: '/tmp/volt', updatedAt: 3 }),
			session('multi', { workspaceFolder: '/tmp/volt', workspaceFolders: ['/tmp/volt', '/tmp/vscode'], updatedAt: 2 }),
			session('file', { workspaceId: 'ws-app', workspaceFolder: '/tmp/app', updatedAt: 1 }),
		], view());
		const workspaces = section(tree);
		assert.deepStrictEqual(projectLabels(workspaces), ['volt', 'app', 'volt, vscode']);
		const onlyWorkspaces = section(buildAgentHomeTree([folder('/tmp/volt'), wsFile], [
			session('single', { workspaceFolder: '/tmp/volt' }),
			session('file', { workspaceId: 'ws-app', workspaceFolder: '/tmp/app' }),
		], view({ source: ['workspaceFile'] })));
		assert.deepStrictEqual(projectLabels(onlyWorkspaces), ['app']);
	});

	test('show toggles control session meta parts', () => {
		const chat = session('chat', { workspaceFolder: '/tmp/volt', updatedAt: 1_000_000 - 5_000 });
		const context = { workspace: 'volt', branch: 'main' };
		assert.deepStrictEqual(sessionMetaParts(chat, context, view({ show: ['updated'] }), 1_000_000), ['5s']);
		assert.deepStrictEqual(sessionMetaParts(chat, context, view({ show: ['workspace', 'branch', 'updated'] }), 1_000_000), ['volt', 'main', '5s']);
		assert.deepStrictEqual(sessionMetaParts(chat, context, view({ show: ['environment', 'pr'] }), 1_000_000), [], 'local and no-PR are not called out');
		assert.strictEqual(sessionMetaParts(chat, context, view({ show: ['machine'] }), 1_000_000).length, 1);
	});
});
