/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { VoltAccessMode } from './access/accessModes.js';
import { AccessDecisionScope, IAccessRequest, IExecutionReceipt, IPermissionRule, PermissionEffect } from './access/accessTypes.js';
import { IVoltEventEnvelope } from './events.js';
import { VoltMode } from './modes.js';
import { IVoltModelOptions } from './models/modelOptions.js';
import { IAgentDetectResult, IVoltCatalogItem, IVoltProviderStatus } from './providers.js';
import { IProviderProfile, IProviderProfileDraft } from './profiles.js';
import { IVoltSendRequest, IVoltSession } from './session.js';
import { IVoltModelAccess } from './models/modelAccess.js';
import type { IHumanAction } from './harness/humanLoop.js';

export const IAgentRuntimeService = createDecorator<IAgentRuntimeService>('agentRuntimeService');

export const OPEN_VOLT_SETTINGS_COMMAND_ID = 'workbench.action.openVoltSettings';

export interface IVoltTaskModels {
	agent?: string;
	plan?: string;
	ask?: string;
	explore?: string;
	/** Dedicated Tab-prediction model. Falls back to the active composer model (D21). */
	tab?: string;
}

export interface IAgentRuntimeService extends IVoltModelAccess {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCatalog: Event<void>;
	readonly onDidChangeProfiles: Event<void>;
	readonly onDidChangeProviderStatus: Event<void>;
	readonly onDidChangeAccess: Event<void>;

	getOrCreateSession(key: string): IVoltSession;
	/** Restore a session's model transcript from durable history when it has none yet. */
	seedSession(key: string, messages: readonly { role: 'user' | 'assistant'; content: string }[]): void;
	send(sessionId: string, request: IVoltSendRequest): Promise<string>;
	cancel(sessionId: string): Promise<void>;
	pause(sessionId: string): Promise<void>;
	resume(sessionId: string): Promise<void>;
	forkSession(sessionId: string): Promise<string>;
	redirect(sessionId: string, text: string): Promise<string>;
	applyHuman(sessionId: string, action: IHumanAction): Promise<void>;
	onEvent(sessionId: string, listener: (e: IVoltEventEnvelope) => void): IDisposable;

	listCatalog(): IVoltCatalogItem[];
	isCatalogLoading(): boolean;
	listProfiles(): IProviderProfile[];
	upsertProfile(draft: IProviderProfileDraft, secret?: string): Promise<IProviderProfile>;
	deleteProfile(id: string): Promise<void>;
	setModelEnabled(ref: string, enabled: boolean): Promise<void>;
	isModelEnabled(ref: string): boolean;
	getTaskModels(): IVoltTaskModels;
	setTaskModel(slot: keyof IVoltTaskModels, ref: string | undefined): Promise<void>;
	getModeProfile(mode: VoltMode): string | undefined;
	setModeProfile(mode: VoltMode, profileId: string | undefined): Promise<void>;
	refreshCatalog(): Promise<void>;
	detectAgents(): Promise<IAgentDetectResult[]>;

	listProviderStatuses(): IVoltProviderStatus[];
	refreshProviders(): Promise<void>;
	setProfileEnabled(profileId: string, enabled: boolean): Promise<void>;
	getLastProviderCheck(): number | undefined;
	getHealthCheckInterval(): number;
	setHealthCheckInterval(seconds: number): Promise<void>;

	getModelOptions(ref: string): IVoltModelOptions;
	setModelOptions(ref: string, options: IVoltModelOptions): Promise<void>;

	getAccessMode(): VoltAccessMode;
	setAccessMode(mode: VoltAccessMode): Promise<void>;
	respondToAccessRequest(requestId: string, effect: Extract<PermissionEffect, 'allow' | 'deny'>, scope?: AccessDecisionScope, pattern?: string): void;
	listPendingAccessRequests(sessionId?: string): IAccessRequest[];
	listReceipts(sessionId?: string): IExecutionReceipt[];
	listProjectRules(): IPermissionRule[];
	setProjectRules(rules: IPermissionRule[]): Promise<void>;
	listSavedApprovals(): IPermissionRule[];
	revokeSavedApproval(index: number): Promise<void>;
}
