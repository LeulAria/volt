/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildChatSections, chatCounts, type IChatListItem, type IClientStatus, relativeTime, selectProjects } from '@volt/client-core';
import { memo, useMemo, useState } from 'react';
import { useChatItems, useClient, useCollections, useNow, useStatus } from '../app/client';
import { chatPath, navigate } from '../app/router';
import { ConfirmDialog, type IMenuItem, MenuButton, PromptDialog } from '../ui/overlays';
import { Icon, IconButton, LiveTimer, StatusIcon, Wordmark } from '../ui/primitives';

export function connectionText(status: IClientStatus, now: number): { readonly tone: 'ok' | 'busy' | 'warn' | 'error'; readonly text: string } {
	const c = status.connection;
	switch (c.phase) {
		case 'open':
			return { tone: 'ok', text: 'Connected' };
		case 'connecting':
		case 'idle':
			return { tone: 'busy', text: status.ready ? 'Reconnecting…' : 'Connecting…' };
		case 'waiting': {
			const s = c.retryAt ? Math.max(0, Math.ceil((c.retryAt - now) / 1000)) : 0;
			return { tone: 'warn', text: s > 1 ? `Retrying in ${s}s` : 'Retrying…' };
		}
		case 'offline':
			return { tone: 'warn', text: 'Offline' };
		case 'blocked':
			return { tone: 'error', text: c.error?.code === 'Unauthorized' ? 'Signed out' : 'Needs an update' };
		case 'stopped':
			return { tone: 'error', text: 'Disconnected' };
	}
}

export function ConnectionBadge({ compact }: { readonly compact?: boolean }) {
	const status = useStatus();
	const client = useClient();
	const now = useNow(1000, status.connection.phase === 'waiting');
	const { tone, text } = connectionText(status, now || Date.now());
	return (
		<button type="button" className={`conn conn-${tone}${compact ? ' compact' : ''}`} onClick={() => tone !== 'ok' && client.reconnect()} title={tone === 'ok' ? `Connected to ${client.environment.label}` : 'Reconnect now'}>
			<span className="conn-dot" />
			<span className="conn-text">{tone === 'ok' && !compact ? client.environment.label : text}</span>
		</button>
	);
}

const ChatRow = memo(function ChatRow({ item, active }: { readonly item: IChatListItem; readonly active: boolean }) {
	const client = useClient();
	const [renaming, setRenaming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const menu: IMenuItem[] = [
		{ id: 'pin', label: item.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => void client.setPinned(item.id, !item.pinned) },
		{ id: 'rename', label: 'Rename', icon: 'pencil', onSelect: () => setRenaming(true) },
		{ id: 'read', label: item.unread ? 'Mark as read' : 'Mark as unread', icon: 'dot', onSelect: () => item.unread ? client.markRead(item.id) : void client.markUnread(item.id) },
		{ id: 'sep', label: '', separator: true },
		{ id: 'settle', label: item.settled ? 'Unsettle' : 'Settle', icon: 'inbox', onSelect: () => void client.setSettled(item.id, !item.settled) },
		item.snoozed
			? { id: 'wake', label: 'Wake', icon: 'sun', onSelect: () => void client.wake(item.id) }
			: { id: 'snooze', label: 'Snooze for 3 hours', icon: 'moon', onSelect: () => void client.snooze(item.id, Date.now() + 3 * 3_600_000) },
		{ id: 'archive', label: item.archived ? 'Unarchive' : 'Archive', icon: 'archive', onSelect: () => void client.setArchived(item.id, !item.archived) },
		{ id: 'sep2', label: '', separator: true },
		{ id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDeleting(true) },
	];
	const right = item.workingSince && item.status === 'working'
		? <LiveTimer since={item.workingSince} className="cr-time live" />
		: <span className={`cr-time${item.status !== 'idle' ? ` status-text status-${item.status}` : ''}`}>{item.status !== 'idle' && item.status !== 'unread' ? item.statusLabel : relativeTime(item.updatedAt)}</span>;
	return (
		<div className={`chat-row${active ? ' active' : ''}${item.unread ? ' unread' : ''}`}>
			<a className="chat-row-link" href={chatPath(item.id)} onClick={e => {
				if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
					e.preventDefault();
					navigate(chatPath(item.id));
				}
			}}>
				<StatusIcon status={item.status} size={13} />
				<div className="cr-main">
					<div className="cr-top">
						<span className="cr-title">{item.title}</span>
						{right}
					</div>
					<div className="cr-sub">
						{item.pinned ? <Icon name="pin" size={11} className="cr-pin" /> : null}
						{item.projectName ? <span className="cr-project">{item.projectName}</span> : null}
						{item.branch ? <span className="cr-branch"><Icon name="branch" size={10} />{item.branch}</span> : null}
						{item.queued ? <span className="cr-badge"><Icon name="queue" size={10} />{item.queued}</span> : null}
						{item.subagents ? <span className="cr-badge"><Icon name="agents" size={10} />{item.subagents}</span> : null}
						<span className="cr-preview">{item.error ?? item.preview}</span>
					</div>
				</div>
			</a>
			<MenuButton className="icon-btn cr-menu" items={menu} placement="bottom-end" width={210} label="Chat actions"><Icon name="more" size={14} /></MenuButton>
			<PromptDialog open={renaming} title="Rename chat" initial={item.title} onClose={() => setRenaming(false)} onSubmit={title => void client.rename(item.id, title)} />
			<ConfirmDialog open={deleting} title="Delete this chat?" body="Its transcript is removed from Volt on your computer. This can't be undone." confirm="Delete" danger onClose={() => setDeleting(false)} onConfirm={() => void client.deleteChat(item.id)} />
		</div>
	);
});

export function Sidebar({ activeChatId }: { readonly activeChatId?: string }) {
	const client = useClient();
	const status = useStatus();
	const items = useChatItems();
	const cols = useCollections(['projects', 'history']);
	const projects = useMemo(() => selectProjects(cols), [cols]);
	const [query, setQuery] = useState('');
	const [archived, setArchived] = useState(false);
	const [projectId, setProjectId] = useState<string | undefined>();
	const [openShelves, setOpenShelves] = useState<Record<string, boolean>>({});
	const sections = useMemo(() => buildChatSections(items, { query, archived, ...(projectId ? { projectId } : {}) }), [items, query, archived, projectId]);
	const counts = useMemo(() => chatCounts(items), [items]);
	const project = projects.find(p => p.id === projectId);
	const filterItems: IMenuItem[] = [
		{ id: 'all', label: 'All projects', icon: 'layers', checked: !projectId, onSelect: () => setProjectId(undefined) },
		...(projects.length ? [{ id: 'sep', label: '', separator: true }] : []),
		...projects.map(p => ({ id: p.id, label: p.name, icon: 'folder' as const, detail: `${p.chats} chats`, checked: p.id === projectId, onSelect: () => setProjectId(p.id) })),
	];

	return (
		<aside className="sidebar">
			<div className="sb-head">
				<Wordmark />
				<span className="sb-head-spacer" />
				<IconButton icon="compose" label="New chat" onClick={() => navigate('/new')} />
			</div>
			<div className="sb-env">
				<ConnectionBadge />
			</div>
			<div className="sb-search">
				<Icon name="search" size={14} />
				<input value={query} placeholder="Search chats" onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Escape' && setQuery('')} />
				{query ? <IconButton icon="close" label="Clear" size={12} onClick={() => setQuery('')} /> : null}
			</div>
			<div className="sb-filters">
				<button type="button" className={`sb-tab${!archived ? ' on' : ''}`} onClick={() => setArchived(false)}>
					Chats{counts.attention ? <span className="sb-count attention">{counts.attention}</span> : counts.working ? <span className="sb-count">{counts.working}</span> : null}
				</button>
				<button type="button" className={`sb-tab${archived ? ' on' : ''}`} onClick={() => setArchived(true)}>Archived</button>
				<span className="sb-head-spacer" />
				<MenuButton className={`pill pill-quiet sb-project${projectId ? ' on' : ''}`} items={filterItems} placement="bottom-end" width={240} label="Filter by project">
					<Icon name="filter" size={12} /><span className="pill-text">{project?.name ?? 'All'}</span>
				</MenuButton>
			</div>
			<div className="sb-list">
				{!status.ready ? (
					<div className="sb-loading">{[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton-row"><span className="skeleton dot" /><span className="skeleton line" /></div>)}</div>
				) : sections.length ? sections.map(section => {
					const open = !section.shelf || openShelves[section.key] || !!query;
					return (
						<div key={section.key} className="sb-section">
							<button type="button" className="sb-section-title" onClick={() => section.shelf && setOpenShelves(s => ({ ...s, [section.key]: !open }))}>
								<span>{section.title}</span>
								{section.shelf ? <><span className="sb-section-count">{section.items.length}</span><Icon name="chevronRight" size={11} className={`sb-shelf-chevron${open ? ' open' : ''}`} /></> : null}
							</button>
							{open ? section.items.map(item => <ChatRow key={item.id} item={item} active={item.id === activeChatId} />) : null}
						</div>
					);
				}) : (
					<div className="sb-empty">
						<Icon name={query ? 'search' : archived ? 'archive' : 'message'} size={18} />
						<span>{query ? 'No chats match.' : archived ? 'Nothing archived.' : 'No chats yet.'}</span>
						{!query && !archived ? <button type="button" className="link-btn" onClick={() => navigate('/new')}>Start one</button> : null}
					</div>
				)}
			</div>
			<div className="sb-foot">
				<button type="button" className="sb-foot-btn" onClick={() => navigate('/settings')}>
					<Icon name="settings" size={15} />Settings
				</button>
				<span className="sb-head-spacer" />
				{counts.attention ? <button type="button" className="sb-foot-btn" onClick={() => void client.markAllRead()} title="Mark all as read"><Icon name="checkCircle" size={14} /></button> : null}
			</div>
		</aside>
	);
}
