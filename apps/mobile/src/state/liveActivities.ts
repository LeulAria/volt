/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	approvalsFor, catalogItem, historyOf, questionsFor, runtimeOf, sessionsOf, tasksOf, threadsOf, type VoltClient
} from '@volt/client-core';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { chatView, type IAgentChatView, type IChatSources } from 'volt-mobile-widgets/src/agentState.ts';
import { runPlan, type IActivityHost } from 'volt-mobile-widgets/src/driver.ts';
import { planActivities, planLaunchSweep, type ITrackedActivity } from 'volt-mobile-widgets/src/planner.ts';

const TRACKED_KEY = 'volt.liveActivities.v1';
const WATCHED = ['history', 'orch.threads', 'orch.tasks', 'access', 'questions', 'sessions'];

/**
 * Live Activities and the Dynamic Island for running chats (iOS, in builds that include the
 * widget extension from apps/mobile-widgets). Everything else (Expo Go, Android) skips this.
 * Plans come from the widgets package's pure planner; this file only feeds it the client's state.
 */
export function startLiveActivities(client: VoltClient): () => void {
	if (Platform.OS !== 'ios' || !requireOptionalNativeModule('VoltWidgets')) {
		return () => undefined;
	}
	// Loaded only where the native module exists: importing it elsewhere throws.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const native = require('volt-mobile-widgets/src/native.ts') as typeof import('volt-mobile-widgets/src/native.ts');
	if (!native.isSupported()) {
		return () => undefined;
	}
	const host: IActivityHost = native.activityHost();
	const server = client.environment.label;
	let tracked: ITrackedActivity[] = [];
	let loaded = false;
	let running = false;
	let again = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const views = (): IAgentChatView[] => {
		const cols = client.getCollections();
		const history = historyOf(cols);
		const threads = threadsOf(cols);
		const sessions = sessionsOf(cols);
		const tasks = Object.values(tasksOf(cols));
		const runtime = runtimeOf(cols);
		const now = Date.now();
		const ids = new Set([...Object.keys(threads), ...Object.values(history).filter(m => m && !m.subagent && now - (m.updatedAt ?? 0) < 6 * 3_600_000).map(m => m.id)]);
		const out: IAgentChatView[] = [];
		for (const id of ids) {
			const meta = history[id];
			if (meta?.subagent || threads[id]?.parentId) {
				continue;
			}
			const session = sessions[id];
			const ref = threads[id]?.active?.prompt?.modelRef ?? threads[id]?.modelRef ?? session?.providerRef;
			const item = catalogItem(runtime, ref);
			const src = {
				meta,
				thread: threads[id],
				session,
				tasks: tasks.filter(task => task.parentId === id),
				questions: questionsFor(cols, id),
				approvals: approvalsFor(cols, id),
				...(item ? { provider: item.providerId, modelLabel: item.label } : {}),
			} as unknown as IChatSources;
			const view = chatView(id, src, now);
			if (view) {
				out.push(view);
			}
		}
		return out;
	};

	const plan = async () => {
		if (disposed) {
			return;
		}
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			if (!loaded) {
				loaded = true;
				tracked = JSON.parse(await AsyncStorage.getItem(TRACKED_KEY) ?? '[]') as ITrackedActivity[];
				const live = await native.listLiveActivities();
				const liveIds = new Set(live.filter(a => a.activityState === 'active' || a.activityState === 'stale').map(a => a.activityId));
				tracked = tracked.filter(a => liveIds.has(a.activityId));
				tracked = await runPlan(tracked, planLaunchSweep(tracked, views()).actions, host, Date.now());
			}
			const result = planActivities(tracked, views(), Date.now(), undefined, server);
			if (result.actions.length) {
				tracked = await runPlan(tracked, result.actions, host, Date.now());
				await AsyncStorage.setItem(TRACKED_KEY, JSON.stringify(tracked));
			}
			if (result.nextCheckAt) {
				schedule(Math.max(250, result.nextCheckAt - Date.now()));
			}
		} catch (err) {
			console.warn('[volt] live activities', err);
		} finally {
			running = false;
			if (again) {
				again = false;
				schedule(300);
			}
		}
	};

	const schedule = (ms: number) => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			void plan();
		}, ms);
	};

	const unsubscribes = WATCHED.map(name => client.subscribe(`col:${name}`, () => schedule(800)));
	const stopRequests = native.onStopRequested(event => {
		if (!event.handled) {
			void client.stop(event.chatId);
		}
	});
	schedule(1_500);
	return () => {
		disposed = true;
		unsubscribes.forEach(unsubscribe => unsubscribe());
		stopRequests.remove();
		if (timer) {
			clearTimeout(timer);
		}
	};
}
