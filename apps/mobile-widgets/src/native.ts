/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter, requireNativeModule } from 'expo-modules-core';
import type { IActivityHost } from './driver.ts';
import type { IAgentActivityAttributes, IAgentActivityContentState, IWidgetSnapshot } from './model.ts';

// Thin typed wrapper over ios/VoltWidgetsModule.swift. Everything here is iOS-only: on other
// platforms `requireNativeModule` throws, so callers check `isSupported()` first.

export interface IVoltWidgetsInfo {
	readonly appGroup: string | null;
	readonly supported: boolean;
	readonly enabled: boolean;
	readonly frequentPushesEnabled: boolean;
	readonly pushToStartSupported: boolean;
}

export interface INativeActivityOptions {
	/** Unix seconds after which the system shows the activity as stale. */
	readonly staleAt?: number;
	/** 0–100: decides which activity the Dynamic Island shows when several run. */
	readonly relevance?: number;
	readonly alert?: { readonly title: string; readonly body: string };
	/** Whether to request a push token (ActivityKit updates over APNs). Default true. */
	readonly push?: boolean;
}

export interface INativeStartResult {
	readonly activityId: string;
	readonly pushEnabled: boolean;
	readonly pushToken: string | null;
}

export interface INativeActivity {
	readonly activityId: string;
	readonly chatId: string;
	readonly provider: string;
	readonly activityState: 'active' | 'ended' | 'dismissed' | 'stale' | 'unknown';
	readonly state: string;
	readonly pushToken: string | null;
}

export interface INativeEndOptions {
	/** Unix seconds the ended activity leaves the Lock Screen; 0 or past = now. */
	readonly dismissAt?: number;
}

export interface INativeEvents {
	onPushToken: { activityId: string; chatId: string; token: string };
	onPushToStartToken: { token: string };
	onActivityState: { activityId: string; chatId: string; state: string };
	onStopRequested: { chatId: string; handled: boolean };
}

interface IVoltWidgetsModule {
	getInfo(): IVoltWidgetsInfo;
	startActivity(attributesJson: string, stateJson: string, options?: INativeActivityOptions): Promise<INativeStartResult>;
	updateActivity(activityId: string, stateJson: string, options?: INativeActivityOptions): Promise<boolean>;
	endActivity(activityId: string, stateJson: string | null, options?: INativeEndOptions): Promise<boolean>;
	endAllActivities(): Promise<number>;
	listActivities(): Promise<INativeActivity[]>;
	getPushToken(activityId: string): Promise<string | null>;
	getPushToStartToken(): Promise<string | null>;
	setWidgetData(json: string): Promise<boolean>;
	readWidgetData(): Promise<string | null>;
	reloadWidgets(): void;
	setConnection(server: string | null, token: string | null): void;
}

const module = requireNativeModule<IVoltWidgetsModule>('VoltWidgets');
const emitter = new EventEmitter<INativeEvents>(module);

export function isSupported(): boolean {
	return module.getInfo().supported;
}

export function getInfo(): IVoltWidgetsInfo {
	return module.getInfo();
}

export function startLiveActivity(attributes: IAgentActivityAttributes, state: IAgentActivityContentState, options?: INativeActivityOptions): Promise<INativeStartResult> {
	return module.startActivity(JSON.stringify(attributes), JSON.stringify(state), options);
}

export function updateLiveActivity(activityId: string, state: IAgentActivityContentState, options?: INativeActivityOptions): Promise<boolean> {
	return module.updateActivity(activityId, JSON.stringify(state), options);
}

export function endLiveActivity(activityId: string, state?: IAgentActivityContentState, options?: INativeEndOptions): Promise<boolean> {
	return module.endActivity(activityId, state ? JSON.stringify(state) : null, options);
}

export function endAllLiveActivities(): Promise<number> {
	return module.endAllActivities();
}

export function listLiveActivities(): Promise<INativeActivity[]> {
	return module.listActivities();
}

export function setWidgetSnapshot(snapshot: IWidgetSnapshot): Promise<boolean> {
	return module.setWidgetData(JSON.stringify(snapshot));
}

export function readWidgetSnapshot(): Promise<string | null> {
	return module.readWidgetData();
}

export function reloadWidgets(): void {
	module.reloadWidgets();
}

/** The paired server and its token, kept in the keychain so a Lock Screen Stop can reach it. */
export function setConnection(server: string | null, token: string | null): void {
	module.setConnection(server, token);
}

export function onPushToken(listener: (event: INativeEvents['onPushToken']) => void) {
	return emitter.addListener('onPushToken', listener);
}

export function onPushToStartToken(listener: (event: INativeEvents['onPushToStartToken']) => void) {
	return emitter.addListener('onPushToStartToken', listener);
}

export function onActivityState(listener: (event: INativeEvents['onActivityState']) => void) {
	return emitter.addListener('onActivityState', listener);
}

export function onStopRequested(listener: (event: INativeEvents['onStopRequested']) => void) {
	return emitter.addListener('onStopRequested', listener);
}

/** Carries a plan out with ActivityKit. */
export function activityHost(): IActivityHost {
	return {
		async start(action) {
			const result = await startLiveActivity(action.attributes, action.state, { staleAt: action.staleAt, relevance: action.relevance });
			return result.activityId;
		},
		async update(action) {
			await updateLiveActivity(action.activityId, action.state, { staleAt: action.staleAt, relevance: action.relevance, alert: action.alert });
		},
		async end(action) {
			// ActivityKit shows an alert only on an update, so a finished turn's alert goes out as one first.
			if (action.alert && action.state) {
				await updateLiveActivity(action.activityId, action.state, { alert: action.alert });
			}
			await endLiveActivity(action.activityId, action.state, { dismissAt: action.dismissAt });
		},
	};
}
