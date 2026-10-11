/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, firstLine, uriPath } from './format';
import type { StatusTone } from './theme';
import type {
	IAccessRequest, ICatalogItem, IOrchTask, IOrchThread, IProjectRecord, IProviderStatus, IQuestionRequest, IRuntimeState, ISessionMeta, ISessionSummary
} from './types';

/** The mirrored collections, as the client holds them (each replaced when it changes). */
export type Collections = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type ChatStatus = Exclude<StatusTone, 'done'>;

export interface IChatListItem {
	readonly id: string;
	readonly title: string;
	readonly projectId?: string;
	readonly projectName?: string;
	readonly folder?: string;
	readonly branch?: string;
	readonly model?: string;
	readonly mode?: string;
	readonly status: ChatStatus;
	readonly statusLabel: string;
	readonly updatedAt: number;
	/** When the running turn started (the row's live timer). */
	readonly workingSince?: number;
	readonly preview: string;
	readonly pinned: boolean;
	readonly archived: boolean;
	readonly settled: boolean;
	readonly snoozed: boolean;
	readonly snoozedUntil?: number;
	readonly unread: boolean;
	readonly queued: number;
	readonly subagents: number;
	readonly error?: string;
}

export interface IChatSection {
	readonly key: string;
	readonly title: string;
	readonly items: readonly IChatListItem[];
	/** Shelves (Snoozed, Settled) start folded. */
	readonly shelf?: boolean;
}

export interface IProjectItem {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly chats: number;
	readonly lastActiveAt: number;
}

function col<T>(cols: Collections, name: string): Readonly<Record<string, T>> {
	return (cols[name] ?? {}) as Readonly<Record<string, T>>;
}

export function historyOf(cols: Collections): Readonly<Record<string, ISessionMeta>> {
	return col<ISessionMeta>(cols, 'history');
}

export function threadsOf(cols: Collections): Readonly<Record<string, IOrchThread>> {
	return col<IOrchThread>(cols, 'orch.threads');
}

export function tasksOf(cols: Collections): Readonly<Record<string, IOrchTask>> {
	return col<IOrchTask>(cols, 'orch.tasks');
}

export function sessionsOf(cols: Collections): Readonly<Record<string, ISessionSummary>> {
	return col<ISessionSummary>(cols, 'sessions');
}

export function runtimeOf(cols: Collections): IRuntimeState {
	return (cols['runtime'] ?? {}) as IRuntimeState;
}

export function pendingApprovals(cols: Collections): readonly IAccessRequest[] {
	const pending = (cols['access'] as { pending?: unknown } | undefined)?.pending;
	return Array.isArray(pending) ? pending as IAccessRequest[] : [];
}

export function approvalsFor(cols: Collections, sessionId: string): readonly IAccessRequest[] {
	return pendingApprovals(cols).filter(request => request.sessionId === sessionId);
}

export function questionsFor(cols: Collections, sessionId: string): readonly IQuestionRequest[] {
	const value = col<unknown>(cols, 'questions')[sessionId];
	return Array.isArray(value) ? value as IQuestionRequest[] : [];
}

export function projectRecords(cols: Collections): IProjectRecord[] {
	const projects = col<unknown>(cols, 'projects');
	return Object.entries(projects)
		.filter(([key, value]) => key.startsWith('project:') && value && typeof value === 'object')
		.map(([, value]) => value as IProjectRecord)
		.filter(project => !project.scratch);
}

export function bindingsOf(cols: Collections): Readonly<Record<string, string>> {
	const bindings = col<unknown>(cols, 'projects')['bindings'];
	return (bindings && typeof bindings === 'object' ? bindings : {}) as Readonly<Record<string, string>>;
}

export function projectOf(cols: Collections, sessionId: string): IProjectRecord | undefined {
	const projectId = bindingsOf(cols)[sessionId];
	if (!projectId) {
		return undefined;
	}
	const record = col<unknown>(cols, 'projects')[`project:${projectId}`];
	return record as IProjectRecord | undefined;
}

//#region Chat status

export function chatStatus(
	meta: ISessionMeta | undefined,
	thread: IOrchThread | undefined,
	approvals: number,
	questions: number,
): { readonly status: ChatStatus; readonly label: string } {
	if (approvals > 0 || thread?.inputs.some(input => input.kind === 'approval') || meta?.attention === 'approval') {
		return { status: 'approval', label: 'Needs approval' };
	}
	if (questions > 0 || thread?.inputs.some(input => input.kind === 'question') || meta?.attention === 'question') {
		return { status: 'question', label: 'Has a question' };
	}
	if (thread?.limit) {
		return { status: 'limit', label: 'Usage limit' };
	}
	if (thread?.active || meta?.status === 'running') {
		return { status: 'working', label: thread?.active?.phase === 'cancelling' ? 'Stopping' : 'Working' };
	}
	if (thread?.moving || thread?.pendingMove) {
		return { status: 'working', label: 'Moving' };
	}
	if (thread?.queue.length) {
		return { status: 'queued', label: `${thread.queue.length} queued` };
	}
	if (meta?.status === 'error' || (thread?.last?.outcome === 'failed' && thread.pause === 'failed')) {
		return { status: 'failed', label: 'Failed' };
	}
	if (meta?.unread) {
		return { status: 'unread', label: 'Done' };
	}
	if (thread?.pause === 'interrupted' || meta?.status === 'interrupted') {
		return { status: 'stopped', label: 'Interrupted' };
	}
	if (meta?.status === 'cancelled') {
		return { status: 'stopped', label: 'Stopped' };
	}
	return { status: 'idle', label: '' };
}

//#endregion

//#region Chat list

const itemCache = new Map<string, IChatListItem>();

function sameItem(a: IChatListItem, b: IChatListItem): boolean {
	for (const key of Object.keys(b) as (keyof IChatListItem)[]) {
		if (a[key] !== b[key]) {
			return false;
		}
	}
	return Object.keys(a).length === Object.keys(b).length;
}

let lastInputs: readonly unknown[] = [];
let lastItems: readonly IChatListItem[] = [];

/**
 * Every listed chat (not subagent chats or side chats), newest first. Row objects are reused when
 * nothing about a chat changed, so list rows keyed on identity skip their re-render.
 */
export function selectChatItems(cols: Collections): readonly IChatListItem[] {
	const inputs = [cols['history'], cols['orch.threads'], cols['orch.tasks'], cols['access'], cols['questions'], cols['projects'], cols['sessions']];
	if (inputs.length === lastInputs.length && inputs.every((value, i) => value === lastInputs[i])) {
		return lastItems;
	}
	lastInputs = inputs;
	const history = historyOf(cols);
	const threads = threadsOf(cols);
	const sessions = sessionsOf(cols);
	const approvals = pendingApprovals(cols);
	const liveTasks = new Map<string, number>();
	for (const task of Object.values(tasksOf(cols))) {
		if (task && (task.state === 'running' || task.state === 'queued' || task.state === 'waiting')) {
			liveTasks.set(task.parentId, (liveTasks.get(task.parentId) ?? 0) + 1);
		}
	}
	const items: IChatListItem[] = [];
	for (const meta of Object.values(history)) {
		if (!meta || meta.subagent || meta.parentId) {
			continue;
		}
		const thread = threads[meta.id];
		const session = sessions[meta.id];
		const { status, label } = chatStatus(meta, thread, approvals.filter(a => a.sessionId === meta.id).length, questionsFor(cols, meta.id).length);
		const project = projectOf(cols, meta.id);
		const folder = meta.workspaceFolder ?? uriPath(project?.root);
		const next: IChatListItem = {
			id: meta.id,
			title: meta.title?.trim() || firstLine(meta.preview, 80) || 'New chat',
			...(project ? { projectId: project.id } : {}),
			...(project?.displayName || meta.workspaceLabel ? { projectName: project?.displayName ?? meta.workspaceLabel } : {}),
			...(folder ? { folder } : {}),
			...(meta.worktreeBranch ?? session?.worktreeBranch ? { branch: meta.worktreeBranch ?? session?.worktreeBranch } : {}),
			...(meta.model ? { model: meta.model } : {}),
			...(meta.mode ? { mode: meta.mode } : {}),
			status,
			statusLabel: label,
			updatedAt: Math.max(meta.updatedAt ?? 0, thread?.active?.at ?? 0),
			...(thread?.active ? { workingSince: thread.active.at } : meta.status === 'running' && meta.lastPromptAt ? { workingSince: meta.lastPromptAt } : {}),
			preview: firstLine(meta.summary || meta.preview),
			pinned: !!meta.pinned,
			archived: !!meta.archived,
			settled: !!meta.settled,
			snoozed: !!meta.snoozed,
			...(meta.snoozedUntil ? { snoozedUntil: meta.snoozedUntil } : {}),
			unread: !!meta.unread,
			queued: thread?.queue.length ?? 0,
			subagents: liveTasks.get(meta.id) ?? 0,
			...(status === 'failed' && thread?.last?.error ? { error: firstLine(thread.last.error, 160) } : {}),
		};
		const cached = itemCache.get(meta.id);
		const item = cached && sameItem(cached, next) ? cached : next;
		itemCache.set(meta.id, item);
		items.push(item);
	}
	items.sort((a, b) => b.updatedAt - a.updatedAt);
	lastItems = items;
	return items;
}

export interface IChatListFilter {
	readonly query?: string;
	readonly projectId?: string;
	readonly archived?: boolean;
}

function matches(item: IChatListItem, query: string): boolean {
	const q = query.toLowerCase();
	return item.title.toLowerCase().includes(q)
		|| item.preview.toLowerCase().includes(q)
		|| (item.projectName?.toLowerCase().includes(q) ?? false)
		|| (item.branch?.toLowerCase().includes(q) ?? false);
}

const DAY = 86_400_000;

/** The home list's sections, T3 style: what needs you and what is running first, then by day. */
export function buildChatSections(items: readonly IChatListItem[], filter: IChatListFilter = {}, now = Date.now()): IChatSection[] {
	const query = filter.query?.trim();
	const visible = items.filter(item => (!!filter.archived === item.archived)
		&& (!filter.projectId || item.projectId === filter.projectId)
		&& (!query || matches(item, query)));
	if (filter.archived || query) {
		return visible.length ? [{ key: filter.archived ? 'archived' : 'results', title: filter.archived ? 'Archived' : 'Results', items: visible }] : [];
	}
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const startToday = today.getTime();
	const buckets: Record<string, IChatListItem[]> = { pinned: [], attention: [], working: [], today: [], yesterday: [], week: [], earlier: [], snoozed: [], settled: [] };
	for (const item of visible) {
		const attention = item.status === 'approval' || item.status === 'question' || item.status === 'failed' || item.status === 'limit';
		if (item.pinned) {
			buckets.pinned.push(item);
		} else if (attention) {
			buckets.attention.push(item);
		} else if (item.status === 'working' || item.status === 'queued') {
			buckets.working.push(item);
		} else if (item.snoozed) {
			buckets.snoozed.push(item);
		} else if (item.settled) {
			buckets.settled.push(item);
		} else if (item.updatedAt >= startToday) {
			buckets.today.push(item);
		} else if (item.updatedAt >= startToday - DAY) {
			buckets.yesterday.push(item);
		} else if (item.updatedAt >= startToday - 6 * DAY) {
			buckets.week.push(item);
		} else {
			buckets.earlier.push(item);
		}
	}
	const sections: IChatSection[] = [];
	const add = (key: string, title: string, shelf = false) => {
		if (buckets[key].length) {
			sections.push({ key, title, items: buckets[key], ...(shelf ? { shelf } : {}) });
		}
	};
	add('pinned', 'Pinned');
	add('attention', 'Needs you');
	add('working', 'Working');
	add('today', 'Today');
	add('yesterday', 'Yesterday');
	add('week', 'Previous 7 days');
	add('earlier', 'Earlier');
	add('snoozed', 'Snoozed', true);
	add('settled', 'Settled', true);
	return sections;
}

export interface IChatCounts {
	readonly attention: number;
	readonly working: number;
	readonly archived: number;
}

export function chatCounts(items: readonly IChatListItem[]): IChatCounts {
	let attention = 0;
	let working = 0;
	let archived = 0;
	for (const item of items) {
		if (item.archived) {
			archived++;
		} else if (item.status === 'approval' || item.status === 'question') {
			attention++;
		} else if (item.status === 'working') {
			working++;
		}
	}
	return { attention, working, archived };
}

//#endregion

//#region Projects and models

export function selectProjects(cols: Collections): IProjectItem[] {
	const bindings = bindingsOf(cols);
	const history = historyOf(cols);
	const stats = new Map<string, { chats: number; last: number }>();
	for (const [sessionId, projectId] of Object.entries(bindings)) {
		const meta = history[sessionId];
		if (!meta || meta.subagent) {
			continue;
		}
		const stat = stats.get(projectId) ?? { chats: 0, last: 0 };
		stat.chats++;
		stat.last = Math.max(stat.last, meta.updatedAt ?? 0);
		stats.set(projectId, stat);
	}
	return projectRecords(cols)
		.map(project => {
			const path = uriPath(project.root) ?? '';
			return { id: project.id, name: project.displayName || basename(path) || project.id, path, chats: stats.get(project.id)?.chats ?? 0, lastActiveAt: stats.get(project.id)?.last ?? 0 };
		})
		.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.name.localeCompare(b.name));
}

export interface IModelGroup {
	readonly key: string;
	readonly label: string;
	readonly providerId: string;
	readonly state?: IProviderStatus['state'];
	readonly models: readonly ICatalogItem[];
}

/** Enabled models grouped by provider account, in catalog order. */
export function selectModelGroups(runtime: IRuntimeState): IModelGroup[] {
	const statuses = new Map((runtime.providerStatuses ?? []).map(status => [status.profileId, status]));
	const groups = new Map<string, { label: string; providerId: string; state?: IProviderStatus['state']; models: ICatalogItem[] }>();
	for (const item of runtime.catalog ?? []) {
		const enabled = runtime.enabledModels?.[item.ref] ?? item.enabled;
		if (!enabled) {
			continue;
		}
		const status = statuses.get(item.profileId);
		if (status && (status.state === 'disabled' || status.state === 'missing')) {
			continue;
		}
		let group = groups.get(item.profileId);
		if (!group) {
			group = { label: status?.label ?? providerName(item.providerId), providerId: item.providerId, ...(status ? { state: status.state } : {}), models: [] };
			groups.set(item.profileId, group);
		}
		group.models.push(item);
	}
	return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

export function catalogItem(runtime: IRuntimeState, ref: string | undefined): ICatalogItem | undefined {
	return ref ? runtime.catalog?.find(item => item.ref === ref) : undefined;
}

export function modelLabel(runtime: IRuntimeState, ref: string | undefined): string {
	const item = catalogItem(runtime, ref);
	if (item) {
		return item.qualifier ? `${item.label} ${item.qualifier}` : item.label;
	}
	if (!ref) {
		return 'Auto';
	}
	return ref.replace(/^(agent|model):/, '').split(/[/:@]/).pop() ?? ref;
}

const PROVIDER_NAMES: Record<string, string> = {
	'claude-code': 'Claude Code', claude: 'Claude', anthropic: 'Anthropic', codex: 'Codex', openai: 'OpenAI', cursor: 'Cursor', 'cursor-acp': 'Cursor',
	gemini: 'Gemini', 'gemini-cli': 'Gemini CLI', grok: 'Grok', xai: 'xAI', opencode: 'OpenCode', ollama: 'Ollama', lmstudio: 'LM Studio', openrouter: 'OpenRouter', kimi: 'Kimi',
};

export function providerName(providerId: string): string {
	return PROVIDER_NAMES[providerId] ?? providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/** Provider family for brand colours (claude, codex, cursor, gemini...). */
export function providerFamily(providerId: string | undefined): string {
	const id = (providerId ?? '').toLowerCase();
	if (/claude|anthropic/.test(id)) {
		return 'claude';
	}
	if (/codex|openai|gpt/.test(id)) {
		return 'codex';
	}
	if (/cursor/.test(id)) {
		return 'cursor';
	}
	if (/gemini|google|antigravity/.test(id)) {
		return 'gemini';
	}
	if (/grok|xai/.test(id)) {
		return 'grok';
	}
	return id || 'generic';
}

export const PROVIDER_COLORS: Readonly<Record<string, string>> = {
	claude: '#D97757',
	codex: '#10A37F',
	cursor: '#9CA3AF',
	gemini: '#4C8DF6',
	grok: '#A1A1AA',
	generic: '#81A1C1',
};

//#endregion
