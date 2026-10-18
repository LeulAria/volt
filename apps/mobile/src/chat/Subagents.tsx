/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ChatStatus, duration, type IOrchTask, tasksOf } from '@volt/client-core';
import { router } from 'expo-router';
import { memo, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useCollections } from '../state/client';
import { useTheme } from '../theme/theme';
import { Icon, LiveTimer, StatusIcon, T, Tap } from '../ui/core';

export function isTaskLive(task: IOrchTask): boolean {
	return task.state === 'running' || task.state === 'queued' || task.state === 'waiting';
}

export function taskStatus(task: IOrchTask): ChatStatus {
	switch (task.state) {
		case 'running': return 'working';
		case 'waiting': return task.waitingOn === 'approval' ? 'approval' : 'question';
		case 'queued': return 'queued';
		case 'failed': return 'failed';
		case 'cancelled':
		case 'interrupted': return 'stopped';
		default: return 'unread';
	}
}

export const TASK_STATE_LABEL: Record<IOrchTask['state'], string> = {
	queued: 'Queued', running: 'Working', waiting: 'Waiting for you', completed: 'Done', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted',
};

/** A chat's subagents, newest first. */
export function useChatTasks(chatId: string): readonly IOrchTask[] {
	const cols = useCollections(['orch.tasks']);
	return useMemo(() => Object.values(tasksOf(cols)).filter(task => task?.parentId === chatId).sort((a, b) => (b.createdAt ?? b.startedAt ?? 0) - (a.createdAt ?? a.startedAt ?? 0)), [cols, chatId]);
}

export function openSubagent(task: IOrchTask): void {
	router.push({ pathname: '/subagent/[id]', params: { id: task.id } } as never);
}

/**
 * The chat's subagents above the composer, as the desktop's subagent card: running ones listed
 * with what they are doing, finished ones folded into one line. Each opens its own screen.
 */
export const SubagentsTray = memo(function SubagentsTray({ chatId }: { readonly chatId: string }) {
	const { p } = useTheme();
	const tasks = useChatTasks(chatId);
	const live = tasks.filter(isTaskLive);
	const [open, setOpen] = useState(false);
	if (!tasks.length) {
		return null;
	}
	const done = tasks.length - live.length;
	const failed = tasks.filter(task => task.state === 'failed').length;
	const shown = open ? tasks : live;
	return (
		<View style={{ borderRadius: 16, backgroundColor: p.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: p.stroke, overflow: 'hidden' }}>
			<Tap haptics="selection" onPress={() => setOpen(o => !o)} accessibilityLabel={open ? 'Hide subagents' : 'Show all subagents'} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12 }}>
				<Icon name="agents" size={15} color={live.length ? p.info : p.fgSecondary} />
				<T variant="small" weight="600" color={live.length ? p.info : p.fgSecondary}>{live.length ? `${live.length} ${live.length === 1 ? 'subagent' : 'subagents'} working` : `${tasks.length} ${tasks.length === 1 ? 'subagent' : 'subagents'}`}</T>
				<T variant="small" color={p.fgTertiary} numberOfLines={1} style={{ flex: 1 }}>{[done ? `${done} finished` : undefined, failed ? `${failed} failed` : undefined].filter(Boolean).join(' · ')}</T>
				<View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}><Icon name="chevronUp" size={14} color={p.fgQuaternary} /></View>
			</Tap>
			{shown.slice(0, open ? 20 : 3).map(task => <TaskRow key={task.id} task={task} />)}
		</View>
	);
});

export const TaskRow = memo(function TaskRow({ task, inset = true }: { readonly task: IOrchTask; readonly inset?: boolean }) {
	const { p } = useTheme();
	const live = isTaskLive(task);
	const status = taskStatus(task);
	const detail = [live && task.activity ? task.activity : TASK_STATE_LABEL[task.state], task.modelLabel, task.steps ? `${task.steps} ${task.steps === 1 ? 'step' : 'steps'}` : undefined].filter(Boolean).join(' · ');
	return (
		<Tap haptics="selection" onPress={() => openSubagent(task)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: inset ? StyleSheet.hairlineWidth : 0, borderColor: p.strokeFaint }}>
			<View style={{ width: 18, alignItems: 'center' }}><StatusIcon status={status} size={14} /></View>
			<View style={{ flex: 1, minWidth: 0 }}>
				<T variant="small" weight="600" numberOfLines={1}>{task.title}</T>
				<T variant="footnote" color={task.state === 'failed' ? p.danger : p.fgTertiary} numberOfLines={1}>{task.state === 'failed' && task.error ? task.error : detail}</T>
			</View>
			{live && task.startedAt ? <LiveTimer since={task.startedAt} color={p.info} /> : task.startedAt && task.endedAt ? <T variant="footnote" color={p.fgQuaternary}>{duration(task.endedAt - task.startedAt)}</T> : null}
			<Icon name="chevronRight" size={13} color={p.fgQuaternary} />
		</Tap>
	);
});
