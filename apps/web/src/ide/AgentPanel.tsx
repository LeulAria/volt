/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatStatus, historyOf, threadsOf } from '@volt/client-core';
import { useChatItems, useCollections } from '../app/client';
import { chatPath, navigate } from '../app/router';
import { ChatView, openPathInEditor } from '../chat/ChatView';
import { NewChat } from '../home/NewChat';
import { type IMenuItem, MenuButton } from '../ui/overlays';
import { StatusIcon } from '../ui/primitives';
import { Codicon } from './icons';
import { useActiveRoot } from './roots';
import { setAgentChat, toggleAgentPanel, useWorkbench } from './workbench';

/**
 * The agent beside the editor (the desktop's agent side panel): the chat in front, or a new one
 * in the open project, while files stay open in the middle.
 */
export function AgentPanel() {
	const chatId = useWorkbench(s => s.agentChatId);
	const chats = useChatItems();
	const cols = useCollections(['history', 'orch.threads', 'projects']);
	const { root } = useActiveRoot();
	const meta = chatId ? historyOf(cols)[chatId] : undefined;
	const status = chatId ? chatStatus(meta, threadsOf(cols)[chatId], 0, 0) : undefined;
	const items: IMenuItem[] = [
		{ id: 'new', label: 'New Chat', icon: 'compose', onSelect: () => setAgentChat(undefined) },
		{ id: 's', label: '', separator: true },
		{ id: 'h', label: 'Recent', header: true },
		...chats.filter(c => !c.archived).slice(0, 14).map(c => ({ id: c.id, label: c.title, detail: [c.projectName, c.status !== 'idle' ? c.statusLabel : undefined].filter(Boolean).join(' · '), checked: c.id === chatId, onSelect: () => setAgentChat(c.id) })),
	];
	const projectId = root?.kind === 'project' ? root.id : undefined;
	return (
		<aside className="agent-panel">
			<div className="panel-head">
				<MenuButton className="panel-picker" items={items} placement="bottom-start" width={320} label="Switch chat">
					{status ? <StatusIcon status={status.status} size={13} /> : <Codicon name="comment-discussion" />}
					<span className="panel-title">{chatId ? meta?.title || 'New chat' : 'New Chat'}</span>
					<Codicon name="chevron-down" size={12} />
				</MenuButton>
				<span className="panel-spacer" />
				<button type="button" className="ide-icon-btn" title="New Chat" onClick={() => setAgentChat(undefined)}><Codicon name="add" /></button>
				{chatId ? <button type="button" className="ide-icon-btn" title="Open in Editor" onClick={() => navigate(chatPath(chatId))}><Codicon name="link-external" /></button> : null}
				<button type="button" className="ide-icon-btn" title="Hide Agent Panel (⌘L)" onClick={() => toggleAgentPanel(false)}><Codicon name="close" /></button>
			</div>
			<div className="panel-body">
				{chatId
					? <ChatView key={chatId} chatId={chatId} variant="panel" openPath={openPathInEditor} />
					: <NewChat key={projectId ?? 'none'} compact initialProjectId={projectId} onStarted={id => setAgentChat(id)} />}
			</div>
		</aside>
	);
}
