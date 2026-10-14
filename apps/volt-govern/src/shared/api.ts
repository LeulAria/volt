/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IPolicyDocument, IEffectivePolicy, ScopeType } from './policy.js';
import type { IPrice } from './pricing.js';
import type { AuthHeader } from './providers.js';

/** Shapes of the console API (`/api/govern/*`). Dates are ISO strings on the wire. */

export interface IApiError {
	readonly error: string;
	readonly code?: string;
}

export interface IOverview {
	readonly members: number;
	readonly teams: number;
	readonly devices: number;
	readonly credentials: number;
	readonly mcpApproved: number;
	readonly mcpPending: number;
	readonly skills: number;
	readonly spend30dMicros: number | null;
	readonly requests30d: number;
	readonly tokens30d: number;
	readonly blocked30d: number;
	readonly activeUsers30d: number;
	readonly daily: readonly { readonly day: string; readonly requests: number; readonly tokens: number; readonly costMicros: number }[];
	readonly topModels: readonly { readonly model: string; readonly requests: number; readonly costMicros: number }[];
	readonly alerts: readonly IAlert[];
	readonly setup: { readonly credential: boolean; readonly sso: boolean; readonly scim: boolean; readonly policy: boolean; readonly invited: boolean };
}

export type CredentialAuthKind = 'api_key' | 'oauth_client';

export interface ICredential {
	readonly id: string;
	readonly provider: string;
	readonly label: string;
	readonly baseUrl: string;
	readonly authKind: CredentialAuthKind;
	readonly authHeader: AuthHeader;
	/** The last four characters, or the OAuth client id. Never the secret. */
	readonly hint: string;
	readonly status: 'active' | 'disabled';
	readonly models: readonly string[];
	readonly createdAt: string;
	readonly createdBy: string;
	readonly rotatedAt: string | null;
	readonly lastUsedAt: string | null;
}

export interface ICredentialInput {
	readonly provider: string;
	readonly label: string;
	readonly baseUrl?: string;
	readonly authKind: CredentialAuthKind;
	readonly authHeader?: AuthHeader;
	/** API key (api_key), or client secret (oauth_client). Write only. */
	readonly secret?: string;
	readonly oauth?: { readonly tokenUrl: string; readonly clientId: string; readonly scope?: string };
	readonly models?: readonly string[];
	readonly status?: 'active' | 'disabled';
}

export interface IPolicyRecord {
	readonly scopeType: ScopeType;
	readonly scopeId: string;
	readonly document: IPolicyDocument;
	readonly version: number;
	readonly updatedAt: string | null;
	readonly updatedBy: string | null;
}

export interface IEffectivePolicyPreview {
	readonly userId: string;
	readonly layers: readonly { readonly scopeType: ScopeType; readonly scopeId: string; readonly label: string }[];
	readonly policy: IEffectivePolicy;
}

export type McpStatus = 'approved' | 'blocked' | 'pending';

export interface IMcpServer {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly transport: 'stdio' | 'http';
	readonly command: string | null;
	readonly url: string | null;
	readonly status: McpStatus;
	readonly tools: readonly { readonly name: string; readonly blocked: boolean }[];
	readonly requestedBy: string | null;
	readonly requestReason: string | null;
	readonly reviewedBy: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export type SkillKind = 'skill' | 'rule' | 'prompt' | 'agent';

export interface ISkill {
	readonly id: string;
	readonly name: string;
	readonly kind: SkillKind;
	readonly description: string;
	readonly content: string;
	readonly version: number;
	readonly status: 'draft' | 'published' | 'archived';
	/** Team ids that receive it; empty means everyone. */
	readonly teams: readonly string[];
	readonly updatedAt: string;
	readonly updatedBy: string;
}

export interface ISkillVersion {
	readonly version: number;
	readonly content: string;
	readonly createdAt: string;
	readonly createdBy: string;
}

export type UsageGroup = 'day' | 'model' | 'provider' | 'user' | 'team' | 'status';

export interface IUsageReport {
	readonly from: string;
	readonly to: string;
	readonly groupBy: UsageGroup;
	readonly totals: IUsageTotals;
	readonly rows: readonly (IUsageTotals & { readonly key: string; readonly label: string })[];
}

export interface IUsageTotals {
	readonly requests: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly costMicros: number | null;
	readonly blocked: number;
	readonly errors: number;
	readonly toolCalls: number;
	readonly avgLatencyMs: number;
}

export interface IRequestLog {
	readonly id: string;
	readonly createdAt: string;
	readonly userId: string;
	readonly userName: string | null;
	readonly provider: string;
	readonly model: string;
	readonly status: 'ok' | 'blocked' | 'error';
	readonly reason: string | null;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costMicros: number | null;
	readonly latencyMs: number;
	readonly toolCalls: number;
	readonly dlpFindings: number;
	readonly client: string | null;
}

export interface IAuditEvent {
	readonly id: string;
	readonly createdAt: string;
	readonly actorId: string | null;
	readonly actorName: string | null;
	readonly actorType: 'user' | 'device' | 'scim' | 'system';
	readonly action: string;
	readonly targetType: string | null;
	readonly targetId: string | null;
	readonly detail: Record<string, unknown>;
	readonly ip: string | null;
}

export interface IDevice {
	readonly id: string;
	readonly userId: string;
	readonly userName: string | null;
	readonly userEmail: string | null;
	readonly name: string;
	readonly platform: string;
	readonly appVersion: string;
	readonly createdAt: string;
	readonly lastSeenAt: string | null;
	readonly revokedAt: string | null;
}

export type PromptLogging = 'off' | 'metadata' | 'redacted' | 'full';

export interface IOrgSettings {
	/** What the gateway keeps of each request beyond counts. */
	readonly promptLogging: PromptLogging;
	readonly retentionDays: { readonly usage: number; readonly audit: number; readonly prompts: number };
	/** Gateway tokens must be used with a proof from the device key they were issued to. */
	readonly requireDeviceBinding: boolean;
	readonly tokenTtlMinutes: number;
	/** Organization price table; wins over the defaults. */
	readonly prices: readonly IPrice[];
	/** Email domains whose people may join (via SSO, or invitation). Empty: any. */
	readonly allowedEmailDomains: readonly string[];
}

export interface IAlert {
	readonly id: string;
	readonly kind: 'budget' | 'security' | 'mcp' | 'credential';
	readonly severity: 'info' | 'warning' | 'error';
	readonly message: string;
	readonly createdAt: string;
	readonly acknowledgedAt: string | null;
}

export interface IScimConnection {
	readonly connectionId: string;
	readonly status: string;
	readonly createdAt: string;
	readonly endpoint: string;
	readonly credentials: readonly { readonly credentialId: string; readonly status: string; readonly expiresAt: string; readonly lastUsedAt: string | null }[];
}

export interface IScimIssued {
	readonly connection: IScimConnection;
	/** Shown once. */
	readonly token: string;
}

export interface IMe {
	readonly user: { readonly id: string; readonly name: string; readonly email: string; readonly image: string | null };
	readonly organization: { readonly id: string; readonly name: string; readonly slug: string } | null;
	readonly role: string | null;
	readonly organizations: readonly { readonly id: string; readonly name: string; readonly slug: string }[];
}

/** What Volt receives from `/api/volt/policy`, signed by the server's Ed25519 key. */
export interface IVoltPolicyBundle {
	readonly organizationId: string;
	readonly userId: string;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly gateway: { readonly anthropic: string; readonly openai: string };
	readonly models: readonly { readonly ref: string; readonly provider: string; readonly model: string; readonly format: 'anthropic' | 'openai' }[];
	readonly policy: IEffectivePolicy;
	readonly mcpServers: readonly { readonly name: string; readonly transport: 'stdio' | 'http'; readonly command: string | null; readonly url: string | null; readonly blockedTools: readonly string[] }[];
	readonly skills: readonly { readonly id: string; readonly name: string; readonly kind: SkillKind; readonly version: number; readonly description: string }[];
}

/** A model the playground may call, with the wire format its key speaks. */
export interface IPlaygroundModel {
	readonly id: string;
	readonly provider: string;
	readonly format: 'anthropic' | 'openai';
}

export interface IPlaygroundRequest {
	readonly format: 'anthropic' | 'openai';
	readonly model: string;
	readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
	readonly system?: string;
	readonly maxTokens?: number;
	readonly stream?: boolean;
}
