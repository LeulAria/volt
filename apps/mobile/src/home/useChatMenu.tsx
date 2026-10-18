/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IChatListItem } from '@volt/client-core';
import { router } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';
import { useClient } from '../state/client';
import { ActionSheet, ConfirmSheet, InputSheet } from '../ui/sheets';
import { chatActions } from './chatActions';

export function openChat(item: Pick<IChatListItem, 'id'>): void {
	router.push({ pathname: '/chat/[id]', params: { id: item.id } });
}

/** A chat row's long-press menu (every chat action) with its rename and delete sheets. */
export function useChatMenu(): { readonly show: (item: IChatListItem) => void; readonly sheets: ReactNode } {
	const client = useClient();
	const [menuFor, setMenuFor] = useState<IChatListItem | undefined>();
	const [renaming, setRenaming] = useState<IChatListItem | undefined>();
	const [deleting, setDeleting] = useState<IChatListItem | undefined>();
	const show = useCallback((item: IChatListItem) => setMenuFor(item), []);
	const sheets = (
		<>
			<ActionSheet visible={!!menuFor} onClose={() => setMenuFor(undefined)} title={menuFor?.title} subtitle={menuFor?.projectName}
				actions={menuFor ? [{ label: 'Open', icon: 'message', onPress: () => openChat(menuFor) }, ...chatActions(client, menuFor, { rename: () => setRenaming(menuFor), remove: () => setDeleting(menuFor) })] : []} />
			<InputSheet visible={!!renaming} onClose={() => setRenaming(undefined)} title="Rename chat" initial={renaming?.title} onSubmit={title => renaming && void client.rename(renaming.id, title)} />
			<ConfirmSheet visible={!!deleting} onClose={() => setDeleting(undefined)} title="Delete this chat?" body="Its transcript is removed from Volt on your computer. This can't be undone." confirm="Delete" destructive onConfirm={() => deleting && void client.deleteChat(deleting.id)} />
		</>
	);
	return { show, sheets };
}
