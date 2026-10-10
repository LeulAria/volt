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
	agentHomeLiveWork,
	AgentHomeWorkState,
	agentPanelTabsMode,
	buildAgentHomeTree,
	compactSessionAge,
	IAgentHomeFolder,
	IAgentHomeNode,
	latestSessionForFolder,
	IAgentOpenDraft,
	isBlankNewChat,
	isTwoLineView,
	sessionSecondLine,
	agentSnoozeAfter,
	agentSnoozeAt,
	agentSnoozePresets,
	sessionMetaParts,
	sessionShowsStatusBadge,
	sessionStatusBadge,
	sessionInWorkingShelf,
	sessionsWithOpenDrafts,
	sessionWorkState,
	sortWorkingSessions,
	uniqueHomeFolders,
	unsentDraftForFolder,
} from '../../browser/home/agentHomeModel.js';
import { IAgentRepoInfo } from '../../browser/home/agentRepoInfo.js';
import { IOrchState, IOrchTask, IOrchThread } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { AGENT_SCRATCH_WORKSPACE_ID } from '../../browser/home/agentHomeWorkspace.js';

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
		// The tree tests were written for project grouping; the sidebar now opens on Status.
		grouping: extra.grouping ?? 'workspace',
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

/** Ids of every agent tab in a tree, depth first. */
function allSessionIds(nodes: readonly IAgentHomeNode[]): string[] {
	const out: string[] = [];
	const walk = (list: readonly IAgentHomeNode[]) => {
		for (const node of list) {
			if (node.element.type === 'session') {
				out.push(node.element.session.id);
			}
			walk(node.children ?? []);
		}
	};
	walk(nodes);
	return out;
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

	test('New Agent finds the newest chat holding only unsent text, never the one on screen', () => {
		const volt = folder('/tmp/volt', { current: true });
		const sessions = [
			session('sent', { workspaceFolder: '/tmp/volt', updatedAt: 50, hasDraft: true }),
			session('archived', { workspaceFolder: '/tmp/volt', updatedAt: 40, turnCount: 0, hasDraft: true, archived: true }),
			session('elsewhere', { workspaceFolder: '/tmp/app', updatedAt: 30, turnCount: 0, hasDraft: true }),
			session('newer', { workspaceFolder: '/tmp/volt', updatedAt: 20, turnCount: 0, hasDraft: true }),
			session('older', { workspaceFolder: '/tmp/volt', updatedAt: 10, turnCount: 0, hasDraft: true }),
			session('blank', { workspaceFolder: '/tmp/volt', updatedAt: 60, turnCount: 0 }),
		];
		assert.strictEqual(unsentDraftForFolder(volt, sessions)?.id, 'newer');
		assert.strictEqual(unsentDraftForFolder(volt, sessions, 'newer')?.id, 'older', 'the chat on screen is skipped');
		assert.strictEqual(unsentDraftForFolder(folder('/tmp/other'), sessions), undefined);
	});

	test('starts with one Workspaces section that carries the filter', () => {
		const tree = buildAgentHomeTree([folder('/tmp/app'), folder('/tmp/volt', { current: true })], [session('chat', { workspaceFolder: '/tmp/volt' })], view());
		assert.deepStrictEqual(tree.map(node => node.element.type), ['section']);
		const workspaces = section(tree);
		assert.ok(workspaces.element.type === 'section' && workspaces.element.key === 'workspaces');
		assert.deepStrictEqual(projectLabels(workspaces), ['volt']);
	});

	test('chats without a project share one No Project group, not a group per scratch folder', () => {
		const tree = buildAgentHomeTree([folder('/tmp/volt', { current: true })], [
			session('repo', { workspaceFolder: '/tmp/volt' }),
			session('a', { workspaceId: AGENT_SCRATCH_WORKSPACE_ID, workspaceLabel: 'No Project', workspaceFolder: '/h/.volt/scratch/2026-10-06-a-11111111', updatedAt: 5 }),
			session('b', { workspaceId: AGENT_SCRATCH_WORKSPACE_ID, workspaceLabel: 'No Project', workspaceFolder: '/h/.volt/scratch/2026-10-06-b-22222222', updatedAt: 6 }),
		], view());
		assert.deepStrictEqual(projectLabels(section(tree)).sort(), ['No Project', 'volt']);
		const scratch = section(tree).children?.find(child => child.element.type === 'folder' && child.element.project.label === 'No Project');
		assert.deepStrictEqual(sessionIds(scratch), ['b', 'a']);
		assert.ok(scratch?.element.type === 'folder' && !scratch.element.project.folder, 'the group has no folder to start a chat in');
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

	test('lists a side chat right under the chat it was opened in, even when it is newer', () => {
		const tree = buildAgentHomeTree([folder('/tmp/volt', { current: true })], [
			session('parent', { workspaceFolder: '/tmp/volt', updatedAt: 10 }),
			session('other', { workspaceFolder: '/tmp/volt', updatedAt: 15 }),
			session('side', { workspaceFolder: '/tmp/volt', updatedAt: 30, parentId: 'parent' }),
		], view());
		const project = section(tree).children?.[0];
		assert.deepStrictEqual(sessionIds(project), ['other', 'parent', 'side']);
		const side = project?.children?.[2].element;
		assert.ok(side?.type === 'session' && side.sideDepth === 1 && side.nested);
	});

	test('lists a side chat on its own when its chat is not listed', () => {
		const tree = buildAgentHomeTree([folder('/tmp/volt', { current: true })], [
			session('side', { workspaceFolder: '/tmp/volt', parentId: 'gone' }),
			session('a', { workspaceFolder: '/tmp/volt', parentId: 'b' }),
			session('b', { workspaceFolder: '/tmp/volt', parentId: 'a' }),
		], view());
		const ids = sessionIds(section(tree).children?.[0]).sort();
		assert.deepStrictEqual(ids, ['a', 'b', 'side']);
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
		assert.deepStrictEqual(groups.map(node => node.collapsed), [true, false], 'Snoozed stays open so its countdowns show');
	});

	test('Status grouping lists Settled and Snooze as headers after Done, only when used', () => {
		const buckets = (tree: readonly IAgentHomeNode[]) => tree.flatMap(node => node.element.type === 'bucket' ? [node.element.id] : []);
		const done = session('done', { status: 'done', turnCount: 1 });
		assert.deepStrictEqual(buckets(buildAgentHomeTree([], [done], view({ grouping: 'status' }))), ['done']);
		const tree = buildAgentHomeTree([], [
			done,
			session('parked', { status: 'done', turnCount: 1, settled: true }),
			session('later', { status: 'done', turnCount: 1, snoozed: true }),
		], view({ grouping: 'status' }));
		assert.deepStrictEqual(buckets(tree), ['done', 'settled', 'snooze']);
		assert.ok(!tree.some(node => node.element.type === 'group'));
		const settled = tree.find(node => node.element.type === 'bucket' && node.element.id === 'settled')!;
		assert.deepStrictEqual(sessionIds(settled), ['parked']);
		assert.ok(settled.element.type === 'bucket' && settled.element.add);
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
		assert.ok(pinned?.element.type === 'bucket');
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
		assert.ok(agents.element.type === 'section' && agents.element.key === 'agents');
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

	test('open new chats show under their workspace as drafts until the first send', () => {
		const volt = folder('/tmp/volt', { current: true });
		const app = folder('/tmp/app');
		const sent = session('sent', { workspaceFolder: '/tmp/volt', updatedAt: 10 });
		const open: IAgentOpenDraft[] = [
			{ id: 'blank', createdAt: 40, workspaceId: 'w', workspaceLabel: 'volt', workspaceFolder: '/tmp/volt' },
			{ id: 'second', createdAt: 30, workspaceId: 'w', workspaceLabel: 'volt', workspaceFolder: '/tmp/volt' },
			{ id: 'elsewhere', createdAt: 35, workspaceId: 'w', workspaceLabel: 'app', workspaceFolder: '/tmp/app' },
		];
		const listed = sessionsWithOpenDrafts([sent], open);
		const tree = buildAgentHomeTree([volt, app], listed, view());
		const projects = section(tree).children ?? [];
		assert.deepStrictEqual(projectLabels(section(tree)), ['volt', 'app']);
		assert.deepStrictEqual(sessionIds(projects[0]), ['blank', 'second', 'sent']);
		assert.deepStrictEqual(sessionIds(projects[1]), ['elsewhere']);
		const blank = listed.find(item => item.id === 'blank');
		assert.ok(blank);
		assert.strictEqual(blank.turnCount, 0);
		assert.strictEqual(blank.title, '');
		assert.deepStrictEqual(sessionMetaParts(blank, { workspace: 'volt' }, view(), 1_000), [], 'the badge says Draft');
		assert.deepStrictEqual(sessionMetaParts(blank, { workspace: 'volt' }, view({ show: ['environment', 'pr'] }), 1_000), ['Draft']);

		// Saved unsent text is already a row. The open editor must not add a second one.
		const typed = session('blank', { title: 'Hello', workspaceFolder: '/tmp/volt', turnCount: 0, hasDraft: true, updatedAt: 40 });
		const once = sessionsWithOpenDrafts([typed, sent], open);
		assert.strictEqual(once.filter(item => item.id === 'blank').length, 1);
		assert.strictEqual(once.find(item => item.id === 'blank')?.title, 'Hello');
		assert.deepStrictEqual(sessionMetaParts(typed, {}, view({ show: ['updated'] }), 1_000), ['Draft']);

		// The first send keeps one row and the age replaces Draft.
		const sentBlank = session('blank', { title: 'Hello', workspaceFolder: '/tmp/volt', turnCount: 1, updatedAt: 1_000 - 5_000 });
		const after = sessionsWithOpenDrafts([sentBlank, sent], open);
		assert.strictEqual(after.filter(item => item.id === 'blank').length, 1);
		assert.strictEqual(after.find(item => item.id === 'blank')?.turnCount, 1);
		assert.deepStrictEqual(sessionMetaParts(sentBlank, {}, view({ show: ['updated'] }), 1_000), ['5s']);

		// A follow-up that has not been sent is still the chat, not a new draft.
		const followUp = session('follow', { turnCount: 3, hasDraft: true, updatedAt: 1_000 - 5_000 });
		assert.deepStrictEqual(sessionMetaParts(followUp, {}, view({ show: ['updated'] }), 1_000), ['5s']);

		// Hiding drafts in the status filter hides the unsent row with the rest.
		const hidden = buildAgentHomeTree([volt], listed, view({ status: ['done'] }));
		assert.deepStrictEqual(sessionIds(section(hidden).children?.[0]), ['sent']);
	});

	test('a new chat with no text is blank, and typed text keeps it', () => {
		const empty = { messages: 0, draft: '', mentions: 0, queued: 0 };
		assert.strictEqual(isBlankNewChat(empty, undefined), true);
		assert.strictEqual(isBlankNewChat(empty, { turnCount: 0, hasDraft: false }), true);
		assert.strictEqual(isBlankNewChat({ ...empty, draft: '  hello' }, undefined), false);
		assert.strictEqual(isBlankNewChat({ ...empty, mentions: 1 }, undefined), false);
		assert.strictEqual(isBlankNewChat({ ...empty, queued: 1 }, undefined), false);
		assert.strictEqual(isBlankNewChat({ ...empty, messages: 1 }, undefined), false);
		assert.strictEqual(isBlankNewChat(empty, { turnCount: 0, hasDraft: true }), false);
		assert.strictEqual(isBlankNewChat(empty, { turnCount: 2 }), false);
	});

	test('two-line tabs: branch (worktree first), else the project, and the model; the Show menu turns parts off', () => {
		const full = view();
		assert.ok(isTwoLineView(full));
		assert.ok(!isTwoLineView(view({ show: ['status', 'updated'] })), 'with nothing for the second line, tabs stay one line');
		assert.ok(isTwoLineView(view({ show: ['pr'] })));

		const worktree = session('w', { worktreeBranch: 'volt/abc12345', model: 'Opus 4.5' });
		assert.deepStrictEqual(sessionSecondLine(worktree, { workspace: 'volt', branch: 'main' }, full), { branch: 'volt/abc12345', model: 'Opus 4.5' });
		assert.deepStrictEqual(sessionSecondLine(session('s'), { workspace: 'volt', branch: 'feature/x' }, full, 'Grok 4.7 High'), { branch: 'feature/x', model: 'Grok 4.7 High' });
		assert.deepStrictEqual(sessionSecondLine(session('s'), { workspace: 'notes' }, full), { place: 'notes' }, 'a folder outside git names its project');
		assert.deepStrictEqual(sessionSecondLine(worktree, { workspace: 'volt' }, view({ show: ['pr'] })), { place: 'volt' }, 'branch and model can be hidden');
	});

	test('the PR filter reads each chat\'s linked pull requests', () => {
		const folder = { uri: URI.file('/p'), name: 'p', current: true, workspace: false };
		const sessions = [session('withPr', { workspaceFolder: '/p' }), session('merged', { workspaceFolder: '/p' }), session('plain', { workspaceFolder: '/p' })];
		const prTags = new Map([['withPr', 'open' as const], ['merged', 'merged' as const]]);
		const ids = (pr: Iterable<'draft' | 'open' | 'merged' | 'closed' | 'none'>) => allSessionIds(buildAgentHomeTree([folder], sessions, view({ pr }), { prTags }));
		assert.deepStrictEqual(ids(['open']), ['withPr']);
		assert.deepStrictEqual(ids(['none']), ['plain']);
		assert.deepStrictEqual(ids(['merged', 'none']).sort(), ['merged', 'plain']);
		assert.deepStrictEqual(allSessionIds(buildAgentHomeTree([folder], sessions, view({ pr: ['open'] }))), [], 'without pull request data every chat is "No PR"');
	});

	test('show toggles control session meta parts', () => {
		const chat = session('chat', { workspaceFolder: '/tmp/volt', updatedAt: 1_000_000 - 5_000 });
		const context = { workspace: 'volt', branch: 'main' };
		assert.deepStrictEqual(sessionMetaParts(chat, context, view({ show: ['updated'] }), 1_000_000), ['5s']);
		assert.deepStrictEqual(sessionMetaParts(chat, context, view({ show: ['workspace', 'branch', 'updated'] }), 1_000_000), ['volt', 'main', '5s']);
		assert.deepStrictEqual(sessionMetaParts(chat, context, view({ show: ['environment', 'pr'] }), 1_000_000), [], 'local and no-PR are not called out');
		assert.strictEqual(sessionMetaParts(chat, context, view({ show: ['machine'] }), 1_000_000).length, 1);
	});

	test('status badge: input, working time, woke, done, draft, limit reached, failed, stopped; none when idle; only for inbox tabs', () => {
		const now = 10 * 60_000;
		assert.deepStrictEqual(sessionStatusBadge(session('w', { status: 'running', lastPromptAt: now - 2 * 60_000 }), now), { kind: 'working', label: 'Working 2m' });
		assert.deepStrictEqual(sessionStatusBadge(session('d', { status: 'done' }), now), { kind: 'done', label: 'Done' });
		assert.deepStrictEqual(sessionStatusBadge(session('n', { status: 'idle', turnCount: 0 }), now), { kind: 'draft', label: 'Draft' });
		assert.strictEqual(sessionStatusBadge(session('i', { status: 'idle', turnCount: 2 }), now), undefined);
		assert.deepStrictEqual(sessionStatusBadge(session('c', { status: 'cancelled' }), now), { kind: 'stopped', label: 'Stopped' });
		assert.deepStrictEqual(sessionStatusBadge(session('l', { status: 'error', summary: 'Usage limit reached · resets 3:20 AM' }), now), { kind: 'limited', label: 'Limit reached' });
		assert.deepStrictEqual(sessionStatusBadge(session('h', { status: 'done', summary: 'You\u2019ve hit your limit · resets 5pm (Asia/Dubai)' }), now), { kind: 'limited', label: 'Limit reached' });
		assert.deepStrictEqual(sessionStatusBadge(session('r', { status: 'done', summary: 'Added a retry when the API rate limit is hit' }), now), { kind: 'done', label: 'Done' });
		assert.deepStrictEqual(sessionStatusBadge(session('f', { status: 'error', summary: 'Connection reset' }), now), { kind: 'failed', label: 'Failed' });
		assert.deepStrictEqual(sessionStatusBadge(session('a', { status: 'running', attention: 'approval' }), now), { kind: 'input', label: 'Input' });
		assert.deepStrictEqual(sessionStatusBadge(session('q', { status: 'running', attention: 'question' }), now), { kind: 'input', label: 'Input' });
		// Back from a timed snooze: Woke, until a new run says Working or the chat asks for something.
		assert.deepStrictEqual(sessionStatusBadge(session('z', { status: 'done', wokeAt: now - 60_000 }), now), { kind: 'woke', label: 'Woke' });
		assert.strictEqual(sessionStatusBadge(session('z', { status: 'running', wokeAt: now - 60_000, lastPromptAt: now - 60_000 }), now)?.kind, 'working');
		assert.strictEqual(sessionStatusBadge(session('z', { status: 'done', wokeAt: now - 60_000, attention: 'question' }), now)?.kind, 'input');

		assert.ok(sessionShowsStatusBadge(session('x'), view()));
		assert.ok(!sessionShowsStatusBadge(session('x'), view({ show: ['updated'] })));
		assert.ok(!sessionShowsStatusBadge(session('x', { settled: true }), view()));
		assert.ok(!sessionShowsStatusBadge(session('x', { snoozed: true }), view()));
	});

	test('working state: a running turn or subagents at work, never a chat that needs the user', () => {
		assert.strictEqual(sessionWorkState(session('r', { status: 'running' })), 'working');
		assert.strictEqual(sessionWorkState(session('a', { status: 'running', attention: 'approval' })), undefined);
		assert.strictEqual(sessionWorkState(session('q', { status: 'done', attention: 'question' }), 'delegating'), undefined);
		assert.strictEqual(sessionWorkState(session('d', { status: 'done' })), undefined);
		assert.strictEqual(sessionWorkState(session('d', { status: 'done', unread: true }), 'delegating'), 'delegating', 'a reply that only says it delegated keeps the chat waiting');
		assert.strictEqual(sessionWorkState(session('e', { status: 'error' }), 'delegating'), undefined, 'a failure needs the user');
		assert.strictEqual(sessionWorkState(session('i', { status: 'interrupted' })), undefined);
		assert.strictEqual(sessionWorkState(session('s', { status: 'done' }), 'working'), 'working', 'a turn starting before history records it');
		assert.ok(!sessionInWorkingShelf(session('p', { status: 'running', pinned: true })), 'pinned chats stay pinned');
		assert.ok(!sessionInWorkingShelf(session('z', { status: 'running', settled: true })));
		assert.ok(sessionInWorkingShelf(session('w', { status: 'running' })));
	});

	test('live work from the orchestrator: active turns, and idle parents of running Volt subagents', () => {
		const thread = (id: string, extra: Partial<IOrchThread> = {}): IOrchThread => ({ id, rootId: id, depth: 0, createdAt: 0, queue: [], inputs: [], turns: 1, handoffs: [], ...extra });
		const task = (id: string, parentId: string, state: IOrchTask['state'], source: IOrchTask['source'] = 'volt'): IOrchTask => ({ id, source, parentId, rootId: parentId, title: id, role: 'general', origin: 'agent', brief: '', isolation: 'shared', depth: 1, createdAt: 0, state, steps: 0, files: [], delivery: 'none', rounds: 0 });
		const turn = { id: 't', kind: 'prompt' as const, prompt: { text: 'x' }, at: 0, phase: 'running' as const };
		const state: Pick<IOrchState, 'threads' | 'tasks'> = {
			threads: {
				running: thread('running', { active: turn }),
				asking: thread('asking', { active: turn, inputs: [{ id: 'i', kind: 'approval', at: 0 }] }),
				parent: thread('parent'),
				blocked: thread('blocked'),
				finished: thread('finished'),
				harness: thread('harness'),
			},
			tasks: {
				a: task('a', 'parent', 'running'),
				b: task('b', 'parent', 'completed'),
				c: task('c', 'blocked', 'running'),
				d: task('d', 'blocked', 'waiting'),
				e: task('e', 'finished', 'completed'),
				f: task('f', 'harness', 'running', 'harness'),
			},
		};
		assert.deepStrictEqual([...agentHomeLiveWork(state)].sort(), [['parent', 'delegating'], ['running', 'working']]);
	});

	test('working shelf: busy chats fold into a collapsed Working group, last sent first, in every grouping', () => {
		const folders = [folder('/tmp/volt', { current: true })];
		const live = new Map<string, AgentHomeWorkState>([['waiting', 'delegating']]);
		const sessions = [
			session('done', { workspaceFolder: '/tmp/volt', status: 'done', updatedAt: 50 }),
			session('older', { workspaceFolder: '/tmp/volt', status: 'running', lastPromptAt: 10, updatedAt: 60 }),
			session('newer', { workspaceFolder: '/tmp/volt', status: 'running', lastPromptAt: 30, updatedAt: 40 }),
			session('waiting', { workspaceFolder: '/tmp/volt', status: 'done', lastPromptAt: 20, unread: true }),
			session('ask', { workspaceFolder: '/tmp/volt', status: 'running', attention: 'question' }),
			session('pin', { workspaceFolder: '/tmp/volt', status: 'running', pinned: true }),
		];
		const options = { workingShelf: true, live };

		const projects = buildAgentHomeTree(folders, sessions, view(), options);
		assert.deepStrictEqual(sessionIds(section(projects).children?.[0]), ['done', 'ask']);
		const group = projects.find(node => node.element.type === 'group');
		assert.ok(group?.element.type === 'group' && group.element.id === 'working' && group.element.count === 3);
		assert.strictEqual(group.collapsed, true);
		assert.deepStrictEqual(sessionIds(group), ['newer', 'waiting', 'older']);
		assert.ok(allSessionIds(projects).includes('pin'));

		const updated = buildAgentHomeTree(folders, sessions, view({ grouping: 'updated' }), { ...options, now: 100 });
		assert.deepStrictEqual(updated.flatMap(node => node.element.type === 'group' ? [node.element.id] : []), ['working']);

		// Status grouping keeps its headers: Working moves below Done, folded, with its count.
		const status = buildAgentHomeTree(folders, [...sessions, session('parked', { status: 'done', settled: true })], view({ grouping: 'status' }), options);
		assert.deepStrictEqual(headers(status), ['pinned', 'needsAttention', 'done', 'working', 'settled']);
		const working = status.find(node => node.element.type === 'bucket' && node.element.id === 'working')!;
		assert.ok(working.element.type === 'bucket' && working.element.count === 3 && working.collapsed);

		// Off: the old layout, busy chats in their project and an expanded Working status header.
		assert.ok(!buildAgentHomeTree(folders, sessions, view(), { live }).some(node => node.element.type === 'group'));
		assert.deepStrictEqual(headers(buildAgentHomeTree(folders, sessions, view({ grouping: 'status' }), { live })), ['pinned', 'needsAttention', 'working', 'done']);
	});

	test('working shelf: an all-busy flat list keeps an Agents header without the empty note', () => {
		const tree = buildAgentHomeTree([], [session('r', { status: 'running' })], view({ grouping: 'updated' }), { workingShelf: true });
		assert.deepStrictEqual(tree.map(node => node.element.type), ['section', 'group']);
		assert.deepStrictEqual(tree[0].children, []);
	});

	test('the Working shelf orders by the user\'s own prompts, not Volt\'s wake-ups', () => {
		const ids = sortWorkingSessions([
			session('a', { createdAt: 1, lastPromptAt: 90, lastUserPromptAt: 10 }),
			session('b', { createdAt: 1, lastPromptAt: 20 }),
			session('c', { createdAt: 30 }),
		]).map(s => s.id);
		assert.deepStrictEqual(ids, ['c', 'b', 'a']);
	});

	test('status badge says Waiting while subagents run, and Working while a turn starts', () => {
		assert.deepStrictEqual(sessionStatusBadge(session('d', { status: 'done', unread: true }), 0, 'delegating'), { kind: 'working', label: 'Waiting' });
		assert.deepStrictEqual(sessionStatusBadge(session('s', { status: 'done' }), 0, 'working'), { kind: 'working', label: 'Working' });
		assert.strictEqual(sessionStatusBadge(session('e', { status: 'error', summary: 'boom' }), 0, 'delegating')?.kind, 'failed');
	});

	test('a snoozed tab counts down to its return', () => {
		const snoozed = session('s', { snoozed: true, snoozedUntil: 1_000 + 2 * 3_600_000, updatedAt: 1 });
		assert.deepStrictEqual(sessionMetaParts(snoozed, {}, view({ show: ['updated'] }), 1_000), ['2h']);
		const freshTwoHours = session('s', { snoozed: true, snoozedUntil: 1_000 + 2 * 3_600_000 - 1_000 });
		assert.deepStrictEqual(sessionMetaParts(freshTwoHours, {}, view({ show: ['updated'] }), 1_000), ['2h'], 'a second in, it still reads 2h');
		const almostDone = session('s', { snoozed: true, snoozedUntil: 1_000 + 20_000 });
		assert.deepStrictEqual(sessionMetaParts(almostDone, {}, view({ show: ['updated'] }), 1_000), ['1m']);
		assert.deepStrictEqual(sessionMetaParts(session('s', { snoozed: true }), {}, view({ show: ['updated'] }), 1_000), []);
	});

	test('snooze presets, durations and date picks', () => {
		const morning = new Date(2026, 9, 4, 9, 55).getTime();
		const presets = agentSnoozePresets(morning);
		assert.deepStrictEqual(presets.map(preset => preset.id), ['hour', 'threeHours', 'evening', 'tomorrow']);
		assert.strictEqual(presets[2].until, new Date(2026, 9, 4, 18, 0).getTime());
		assert.strictEqual(presets[3].until, new Date(2026, 9, 5, 9, 0).getTime());
		// Within an hour of the evening, This evening is no longer offered.
		assert.ok(!agentSnoozePresets(new Date(2026, 9, 4, 17, 30).getTime()).some(preset => preset.id === 'evening'));

		assert.strictEqual(agentSnoozeAfter(0, 2, 'hours'), 7_200_000);
		assert.strictEqual(agentSnoozeAfter(0, 0, 'hours'), undefined);
		assert.strictEqual(agentSnoozeAfter(0, 1.5, 'hours'), undefined, 'whole numbers only');
		assert.strictEqual(agentSnoozeAfter(0, Number.NaN, 'days'), undefined);
		// Days are calendar days: 9:00 stays 9:00 whatever the clock does in between.
		const nine = new Date(2026, 2, 7, 9, 0).getTime();
		assert.strictEqual(agentSnoozeAfter(nine, 2, 'days'), new Date(2026, 2, 9, 9, 0).getTime());
		assert.strictEqual(agentSnoozeAfter(nine, 1, 'weeks'), new Date(2026, 2, 14, 9, 0).getTime());

		const today = new Date(2026, 9, 4).getTime();
		assert.strictEqual(agentSnoozeAt(morning, today, 10 * 60 + 55), new Date(2026, 9, 4, 10, 55).getTime());
		assert.strictEqual(agentSnoozeAt(morning, today, 9 * 60), undefined, 'the past is not a snooze');
		assert.strictEqual(agentSnoozeAt(morning, Number.NaN, 600), undefined);
		assert.strictEqual(agentSnoozeAt(morning, today, 24 * 60), undefined);
	});
});
