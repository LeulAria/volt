/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltSandboxSettings } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import type { ICompiledPolicy } from './access/accessTypes.js';
import { IProviderCapabilities } from './capabilities.js';
import { IVoltEvent } from './events.js';
import { IModelOptionDescriptor, IVoltModelOptions } from './models/modelOptions.js';
import { VoltMode } from './modes.js';
import type { IVoltResourceAttachment } from './fileAttachments.js';
import { IProviderProfile } from './profiles.js';
import type { IToolSchema } from './tools/tool.js';

export interface IDetectResult {
	available: boolean;
	version?: string;
	authenticated?: boolean;
	detail?: string;
	/** Account the CLI or API key is signed in as, when it can be read. */
	account?: string;
	/** Plan or subscription tier reported by the provider, e.g. "Claude Max Subscription". */
	plan?: string;
	/** Absolute path of the detected executable, for CLI backed providers. */
	path?: string;
}

export interface IModelInfo {
	id: string;
	label: string;
	qualifier?: string;
	capabilities: IProviderCapabilities;
	/** Reasoning effort, context window, and toggles this specific model exposes. */
	optionDescriptors?: IModelOptionDescriptor[];
	/** Fixed settings baked into the model, shown next to it in the picker. */
	detail?: string;
	/** Provider-supplied blurb for the picker hover. Never invented by Volt. */
	description?: string;
	/** Human context size when the provider reported one, e.g. "300k". */
	contextLabel?: string;
}

export interface IModelToolCall {
	id: string;
	name: string;
	arguments: string;
}

/**
 * A reasoning block tagged with the provider and model that produced it. It is replayed only to
 * that same model: other models either ignore foreign reasoning or reject it.
 */
export interface IModelReasoningBlock {
	readonly provider: string;
	readonly model: string;
	readonly text: string;
	/** Provider-native payload replayed verbatim, e.g. an Anthropic `thinking` block with its signature. */
	readonly opaque?: unknown;
}

/** Assistant content in the order the model produced it. */
export type IModelAssistantPart =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'reasoning'; readonly block: IModelReasoningBlock }
	| { readonly type: 'tool_call'; readonly callId: string };

export interface IModelImage {
	readonly mediaType: string;
	/** Base64 without a data: prefix. */
	readonly data: string;
}

export interface IModelMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: IModelToolCall[];
	callId?: string;
	name?: string;
	/** Assistant only. When present, providers that replay reasoning build content from this. */
	parts?: IModelAssistantPart[];
	/** Tool only: the call failed. */
	isError?: boolean;
	/** Pixels: a tool result's (browser snapshot) or, on a user message, what the user attached. */
	images?: IModelImage[];
}

export interface IModelRequest {
	modelId: string;
	messages: IModelMessage[];
	profile: IProviderProfile;
	apiKey?: string;
	options?: IVoltModelOptions;
	tools?: IToolSchema[];
	/** Output ceiling for this request. Providers fall back to the model's own maximum. */
	maxOutputTokens?: number;
}

export interface IModelProvider {
	readonly id: string;
	readonly label: string;
	detect(profile: IProviderProfile): Promise<IDetectResult>;
	listModels(profile: IProviderProfile, apiKey?: string): Promise<IModelInfo[]>;
	stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent>;
}

export interface IAgentStartRequest {
	/** The Volt chat this agent serves; host tools (questions, browser) bind to it. */
	sessionId?: string;
	cwd?: string;
	mode: VoltMode;
	profile: IProviderProfile;
	/** Model the user picked from this agent's catalog, when it exposes one. */
	modelId?: string;
	options?: IVoltModelOptions;
	/** The chat's OS sandbox. Absent or `off`: the agent runs unconfined. */
	sandbox?: IAgentSandboxStart;
}

/** What an agent provider needs to start its process in the OS sandbox. */
export interface IAgentSandboxStart {
	readonly settings: IVoltSandboxSettings;
	/** The chat's checkout (and the main repository's `.git` for a linked worktree). */
	readonly workspaceRoots: readonly string[];
}

export interface IAgentSessionHandle {
	id: string;
	providerSessionId?: string;
}

export interface IAgentMessage {
	text: string;
	mode: VoltMode;
	/**
	 * Optional short lead the harness prepends to the user's text for this turn only, e.g. the
	 * lane framing for a question or the run plan when the user asked to see something running.
	 * Built by the context pack; providers never invent their own.
	 */
	lead?: string;
	/** Images the user attached to this turn. */
	images?: readonly IModelImage[];
	/** Files the user attached to this turn (see `acpResourceBlock`). */
	resources?: readonly IVoltResourceAttachment[];
}

export interface IAgentProvider {
	readonly id: string;
	readonly label: string;
	detect(profile: IProviderProfile): Promise<IDetectResult>;
	/**
	 * Models the CLI offers. Agents that pick their own model can leave this out and the runtime
	 * publishes a single entry for the agent itself.
	 */
	listModels?(profile: IProviderProfile): Promise<IModelInfo[]>;
	start(req: IAgentStartRequest): Promise<IAgentSessionHandle>;
	/**
	 * The same agent conversation, continued in another folder (`req.cwd`): the chat moved to
	 * another checkout, and an agent's working directory is fixed per session. A new agent process
	 * resumes the session there (ACP `session/resume`) and `session` is let go. Undefined when the
	 * agent cannot resume; the caller then starts a fresh session briefed with a recap.
	 */
	resumeIn?(session: IAgentSessionHandle, req: IAgentStartRequest): Promise<IAgentSessionHandle | undefined>;
	/** False when the CLI process has already exited and the next send must start a new session. */
	isLive?(session: IAgentSessionHandle): boolean;
	send(session: IAgentSessionHandle, msg: IAgentMessage, profile: IProviderProfile, token: CancellationToken): AsyncIterable<IVoltEvent>;
	interrupt(session: IAgentSessionHandle): Promise<void>;
	dispose(session: IAgentSessionHandle): Promise<void>;
	setRunContext?(session: IAgentSessionHandle, context: { sessionId: string; runId: string; mode: VoltMode }): void;
	applyAccessPolicy?(session: IAgentSessionHandle, policy: ICompiledPolicy): Promise<void>;
	/** The agent advertised the slash command `/name` for this session. */
	supportsCommand?(session: IAgentSessionHandle, name: string): boolean;
	/** The running turn takes messages without stopping (ACP `_session/steering`). */
	canSteer?(session: IAgentSessionHandle): boolean;
	/** Puts a message into the running turn; false when the agent refused it. */
	steer?(session: IAgentSessionHandle, text: string): Promise<boolean>;
}

export interface IVoltCatalogItem {
	ref: string;
	kind: 'model' | 'agent';
	providerId: string;
	profileId: string;
	id: string;
	label: string;
	qualifier?: string;
	enabled: boolean;
	capabilities: IProviderCapabilities;
	optionDescriptors?: IModelOptionDescriptor[];
	detail?: string;
	description?: string;
	contextLabel?: string;
}

export interface IAgentDetectResult extends IDetectResult {
	providerId: string;
	profileId: string;
	label: string;
}

/**
 * Health of a connected provider as shown in the Providers settings page and in the
 * provider rail of the composer model picker.
 *
 * - `authenticated`: reachable and signed in
 * - `available`: reachable but the account could not be confirmed
 * - `disabled`: turned off by the user
 * - `missing`: the CLI or endpoint could not be found
 * - `checking`: a health check is in flight and nothing is known yet
 */
export type VoltProviderState = 'authenticated' | 'available' | 'disabled' | 'missing' | 'checking';

export interface IVoltProviderStatus {
	profileId: string;
	providerId: string;
	kind: 'model' | 'agent';
	label: string;
	state: VoltProviderState;
	enabled: boolean;
	version?: string;
	account?: string;
	plan?: string;
	detail?: string;
	earlyAccess?: boolean;
	checkedAt?: number;
	models: IVoltCatalogItem[];
}
