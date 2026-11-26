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
	/**
	 * Asked once and never again (a Tab prediction changes with every keystroke): providers with
	 * explicit prompt caching leave a prompt made only of these out of the cache, since a cache
	 * write costs more than a plain read and would never be hit.
	 */
	ephemeral?: boolean;
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
	/**
	 * A session that only writes text for Volt (the predictor behind Tab, the composer's ghost text
	 * and dictation): no Volt MCP servers, no stall recovery, a short cancel, and where the agent
	 * allows it (see {@link IAgentProvider.takesSystemPrompt}) `systemPrompt` in place of its own,
	 * no tools, hooks or saved transcript, and the least thinking.
	 */
	textOnly?: { readonly systemPrompt: string };
	/**
	 * The session serves a Volt subagent (a delegated task): its brief carries what it needs, so
	 * agents that allow it start without the user's memory index, long skill descriptions and their
	 * own subagent tool (Volt's delegate_task nests instead), and every agent gets only the host
	 * tool groups the profile needs. See `claudeWorkRulesMeta` and `SUBAGENT_HOST_TOOL_GROUPS`.
	 */
	subagent?: boolean | VoltSubagentProfile;
	/**
	 * Continue this agent session (ACP `session/resume`) in a new process instead of starting a new
	 * one: the chat's agent was stopped while idle and picks up exactly where it was. When the agent
	 * cannot resume it, a new session starts (its handle has no `resumed`) and the caller briefs it.
	 */
	resumeSessionId?: string;
	/**
	 * With a resume: the sandbox config overlay the stopped agent ran with (its handle's `stateKey`).
	 * The agent's transcript lives there, and an agent that began as a pooled spare ran under the
	 * pool's key, not the chat's: resumed under the chat's key it would find no session.
	 */
	resumeStateKey?: string;
}

/**
 * What a Volt subagent's agent needs: `readonly` for research and review (and any task of an Ask or
 * Plan chat), `work` for the rest. Read-only subagents start from a short prompt of their own and
 * without file-changing tools; both get only the host tool groups their role uses.
 */
export type VoltSubagentProfile = 'readonly' | 'work';

/** `true` (saved by older builds, or a caller that does not know the role) reads as `work`. */
export function subagentProfile(value: boolean | VoltSubagentProfile | undefined): VoltSubagentProfile | undefined {
	return value === 'readonly' || value === 'work' ? value : value === true ? 'work' : undefined;
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
	/** The session continues the one `IAgentStartRequest.resumeSessionId` named: it knows the conversation so far. */
	resumed?: boolean;
	/** The sandbox config overlay the agent runs with, when Volt wraps it (see `IAgentStartRequest.resumeStateKey`). */
	stateKey?: string;
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
	/**
	 * The session can be stopped and continued later in a new process (see `IAgentStartRequest.resumeSessionId`).
	 * `died`: its process is already gone (it crashed or was killed mid-turn) and the restart asks whether
	 * the session it left on disk can be continued.
	 */
	canResume?(session: IAgentSessionHandle, died?: boolean): boolean;
	send(session: IAgentSessionHandle, msg: IAgentMessage, profile: IProviderProfile, token: CancellationToken): AsyncIterable<IVoltEvent>;
	interrupt(session: IAgentSessionHandle): Promise<void>;
	dispose(session: IAgentSessionHandle): Promise<void>;
	setRunContext?(session: IAgentSessionHandle, context: { sessionId: string; runId: string; mode: VoltMode }): void;
	applyAccessPolicy?(session: IAgentSessionHandle, policy: ICompiledPolicy): Promise<void>;
	/** "Allow host" for the running agent: its sandbox's proxy lets these hosts through from the next connection, without a restart. */
	allowSandboxDomains?(session: IAgentSessionHandle, domains: readonly string[]): Promise<void>;
	/** The execution host's id of the running agent's process: what a denial card's approval names (P4). */
	sandboxProcessId?(session: IAgentSessionHandle): string | undefined;
	/** The agent advertised the slash command `/name` for this session. */
	supportsCommand?(session: IAgentSessionHandle, name: string): boolean;
	/** The running turn takes messages without stopping (ACP `_session/steering`). */
	canSteer?(session: IAgentSessionHandle): boolean;
	/** Puts a message into the running turn; false when the agent refused it. */
	steer?(session: IAgentSessionHandle, text: string, images?: readonly IModelImage[]): Promise<boolean>;
	/**
	 * A `textOnly` session of this agent runs on the request's system prompt instead of the agent's
	 * own, with no tools. Otherwise the caller teaches the session with a first prompt.
	 */
	takesSystemPrompt?(): boolean;
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
