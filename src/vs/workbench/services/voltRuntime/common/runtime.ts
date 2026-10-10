/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IVoltSandboxSettings } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { VoltAccessMode } from './access/accessModes.js';
import { AccessDecisionScope, IAccessRequest, IExecutionReceipt, IPermissionRule, PermissionEffect } from './access/accessTypes.js';
import type { IHandoffActivity } from './contextHandoff.js';
import { IVoltEventEnvelope } from './events.js';
import { VoltMode } from './modes.js';
import { IVoltModelOptions } from './models/modelOptions.js';
import { IAgentDetectResult, IVoltCatalogItem, IVoltProviderStatus } from './providers.js';
import { IProviderProfile, IProviderProfileDraft } from './profiles.js';
import { IVoltSendRequest, IVoltSession } from './session.js';
import { IVoltModelAccess } from './models/modelAccess.js';
import type { IHumanAction } from './harness/humanLoop.js';
import type { IAgentQuestionRequest, IAgentQuestionResponse } from './questions.js';
import type { IRunMetrics } from './harness/runMetrics.js';

export const IAgentRuntimeService = createDecorator<IAgentRuntimeService>('agentRuntimeService');

export const OPEN_VOLT_SETTINGS_COMMAND_ID = 'workbench.action.openVoltSettings';
/** Project Settings for a project id or root URI; asks which project without one. */
export const VOLT_PROJECT_SETTINGS_COMMAND_ID = 'volt.projects.settings';

export interface IVoltTaskModels {
	agent?: string;
	plan?: string;
	ask?: string;
	explore?: string;
	/** Dedicated Tab-prediction model. Falls back to the active composer model (D21). */
	tab?: string;
	/** Model for chat titles and other generated text. Falls back to the chat's own model. */
	title?: string;
	/** Model for commit messages and pull request titles and descriptions. Falls back to the text generation model. */
	git?: string;
}

/** An MCP server from the project or user config, and how its connection is doing. */
export interface IVoltMcpServerStatus {
	readonly name: string;
	/** Configured in the project (`.cursor/mcp.json`, ...) or in the home folder. */
	readonly scope: 'project' | 'user';
	/** `idle`: configured but not started yet (servers start with the first run that needs tools). */
	readonly state: 'idle' | 'connecting' | 'ready' | 'error';
}

/** A message of a chat's model transcript as history restores it. */
export interface IVoltSeedMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly model?: string;
	readonly activity?: IHandoffActivity;
	readonly compacted?: boolean;
}

export interface IVoltCompactionPlan {
	readonly kind: 'native' | 'handoff';
	/** `handoff`: estimated tokens the conversation compacts to. */
	readonly tokens?: number;
	/** The model the chat compacts for. */
	readonly label?: string;
}

export interface IAgentRuntimeService extends IVoltModelAccess {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCatalog: Event<void>;
	readonly onDidChangeProfiles: Event<void>;
	readonly onDidChangeProviderStatus: Event<void>;
	readonly onDidChangeAccess: Event<void>;

	getOrCreateSession(key: string): IVoltSession;
	/**
	 * Restore a session's model transcript from durable history when it has none yet. `forkedFrom`
	 * marks a fork, so its first agent is briefed as one.
	 */
	seedSession(key: string, messages: readonly IVoltSeedMessage[], options?: { readonly forkedFrom?: string }): void;
	/**
	 * How `/compact` would run in this chat on `providerRef` now: the agent's own (`native`: Claude
	 * Code's `/compact`, Codex's, or Volt's summarizer for native models), or Volt's handoff summary
	 * and a fresh session (`handoff`, with its estimated size). Undefined when there is nothing to compact.
	 */
	compactionPlan(sessionId: string, providerRef: string | undefined): IVoltCompactionPlan | undefined;
	/**
	 * The user rewrote history: keep only the first `userTurns` user messages (and the replies
	 * between them). Model-side transcripts are cut to match, so the old turns are forgotten.
	 */
	truncateSession(sessionId: string, userTurns: number): void;
	/**
	 * Stops the chat's agent so its next prompt starts a fresh one, which reads skills, plugins,
	 * MCP servers and rules again and gets the conversation as a recap. Also drops what a fresh
	 * agent would otherwise reuse (parked spares, cached skills, failed MCP servers).
	 * False, with nothing changed, while a run is active, unless `cancel` stops that run first.
	 */
	restartAgent(sessionId: string, options?: { readonly cancel?: boolean }): Promise<boolean>;
	/** Starts the selected ACP agent ahead of the first message. No-op for native models. */
	prewarmAgent(sessionId: string, providerRef: string | undefined, mode: VoltMode): void;
	/** Restore the checkout a chat already created, so a reload does not fall through to the open folder. */
	rememberWorktree(sessionId: string, path: string | undefined, branch: string | undefined): void;
	/**
	 * The chat moved to another checkout (`path` undefined: the project's own). Its next turn runs
	 * there: an ACP agent resumes its session in the new folder when it can, else a fresh one is
	 * briefed with the conversation. `note` opens that turn for the model; `announce` is the
	 * transcript notice it starts with. Refused while a turn runs.
	 */
	relocate(sessionId: string, path: string | undefined, branch: string | undefined, note: { readonly model: string; readonly announce: string }): boolean;
	/** The checkout a chat works in now: its worktree, else the project folder. */
	workingFolder(sessionId: string): string | undefined;
	send(sessionId: string, request: IVoltSendRequest): Promise<string>;
	/** A run that takes messages between steps is live in this chat (native loop, or an ACP agent with steering). */
	canSteer(sessionId: string): boolean;
	/** The chat's live agent advertised the slash command `/name` (e.g. `compact`). */
	supportsCommand(sessionId: string, name: string): boolean;
	/**
	 * Sends `text` into the live native run, which reads it before its next step. Not a user turn:
	 * `truncateSession` does not count it. False (nothing sent) when no native run is live.
	 */
	steer(sessionId: string, text: string): boolean;
	/**
	 * Like `steer`, for any agent that takes messages mid-turn: the native loop's inbox, or an ACP
	 * agent's `_session/steering` (Claude, Codex). Resolves false when nothing took it.
	 */
	steerAsync(sessionId: string, text: string): Promise<boolean>;
	cancel(sessionId: string): Promise<void>;
	pause(sessionId: string): Promise<void>;
	resume(sessionId: string): Promise<void>;
	forkSession(sessionId: string): Promise<string>;
	redirect(sessionId: string, text: string): Promise<string>;
	applyHuman(sessionId: string, action: IHumanAction): Promise<void>;
	onEvent(sessionId: string, listener: (e: IVoltEventEnvelope) => void): IDisposable;
	/** The chat a session id belongs to: itself, or the chat that adopted a warm spare agent running under that alias. */
	chatFor(sessionId: string): string;
	/** Every event from every session, after its own listeners ran. */
	readonly onDidEmit: Event<IVoltEventEnvelope>;

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
	/** The chat's OS sandbox, or the default for chats that never set one. */
	getSandboxSettings(sessionId: string): IVoltSandboxSettings;
	setSandboxSettings(sessionId: string, settings: IVoltSandboxSettings): Promise<void>;
	getDefaultSandboxSettings(): IVoltSandboxSettings;
	setDefaultSandboxSettings(settings: IVoltSandboxSettings): Promise<void>;
	respondToAccessRequest(requestId: string, effect: Extract<PermissionEffect, 'allow' | 'deny'>, scope?: AccessDecisionScope, pattern?: string): void;
	/** Questions an agent is waiting on in this chat, oldest first. */
	getPendingQuestions(sessionId: string): readonly IAgentQuestionRequest[];
	/** False when no agent is still waiting for these answers (its turn ended); send them as a message instead. */
	respondToQuestions(requestId: string, response: IAgentQuestionResponse): boolean;
	/** Fires with the session id when its pending questions change. */
	readonly onDidChangeQuestions: Event<string>;
	listPendingAccessRequests(sessionId?: string): IAccessRequest[];
	listReceipts(sessionId?: string): IExecutionReceipt[];
	listProjectRules(): IPermissionRule[];
	setProjectRules(rules: IPermissionRule[]): Promise<void>;
	listSavedApprovals(): IPermissionRule[];
	revokeSavedApproval(index: number): Promise<void>;

	/**
	 * Timings and meters of recent finished runs, newest last (send to prepared, agent ready,
	 * prompt, first event, first text, end; tools, retries, stalls, loops, compactions).
	 */
	getRunMetrics(sessionId?: string): readonly IRunMetrics[];

	/** MCP servers configured for the project and the user, with their connection state. */
	listMcpServers(root: URI | undefined): Promise<readonly IVoltMcpServerStatus[]>;

	/**
	 * One small tool-less call for generated text (commit messages, pull request descriptions):
	 * the text generation model when one is set in Settings, else the chat's model, else the first
	 * enabled one. The `git` slot tries the git text model first. Undefined when no model answered.
	 */
	generateText(prompt: string, options?: { readonly sessionId?: string; readonly timeoutMs?: number; readonly slot?: 'title' | 'git' }): Promise<string | undefined>;
}
