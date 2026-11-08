/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Principals (spec F.1): who a permission decision is about. Pure types and helpers; the registry
 * that mints them and binds them to channels is `node/principalRegistry.ts`.
 *
 * Grants attach to the subject (stable across restarts and instances); decisions are about the
 * principal (one running instance). The on-behalf-of chain is built by core when it routes a call,
 * never taken from a payload.
 */

/** Who a grant is about: stable across restarts and instances. */
export type SubjectKey =
	| `plugin:${string}@${string}`        // `${publisher}.${name}@${signer}`; unsigned local: `@local`
	| `firstparty:${string}`              // `volt.<feature>`
	| `chat:${string}`                    // chat id; the agent CLI and everything it starts
	| `mcp:${string}`                     // sha256 of the canonical server config
	| `mcp-http:${string}`
	| `helper:${string}`                  // signed helper id
	| `package-fetch:${string}`           // lockfile digest
	| 'user';                             // only for user-action spawns; never minted for a sandbox

export type PrincipalKind = 'agent' | 'mcp' | 't2' | 't3' | 't3-web' | 'helper' | 'task' | 'package-fetch';

/** One running instance. Minted by the registry (or by core for an in-process caller), never by the workload. */
export interface IPrincipal {
	/** 128-bit random, base64url. */
	readonly id: string;
	readonly subject: SubjectKey;
	readonly kind: PrincipalKind;
	/** sha256 of the installed bundle (plugins, extensions). */
	readonly packageDigest?: string;
	/** Fingerprint, `volt` or `local`. */
	readonly signer?: string;
	/** Server instance id. */
	readonly executionHost: string;
	/** The principal id this one was started for (tasks, children). */
	readonly parent?: string;
	/** F.3; empty for a principal that runs in core's own process. */
	readonly launchPolicyHash: string;
	readonly createdAt: number;
}

/** G.7: minted by core's UI layer for a real input event; valid for 1 s and single use. */
export interface IUserGestureToken {
	readonly id: string;
	/** The principal id it targets. */
	readonly principal: string;
	readonly issuedAt: number;
	readonly consumed: boolean;
}

export const GESTURE_TOKEN_TTL_MS = 1000;

/** Carried on every broker request and every spawn. Built by core from channels, never from payloads. */
export interface ICallContext {
	/** The immediate caller (from the channel). */
	readonly principal: IPrincipal;
	/** Outermost first: e.g. `[chat, plugin]`. */
	readonly onBehalfOf: readonly IPrincipal[];
	readonly gesture?: IUserGestureToken;
	/** Set by core: the principal's own UI is in the foreground and focused (G.3's other way to prompt). */
	readonly foreground?: boolean;
	readonly requestId: string;
}

/** Longest on-behalf-of chain core builds; a longer one is refused rather than walked. */
export const MAX_CALL_CHAIN = 8;

const SUBJECT_PATTERN = /^(?:user|(?:plugin):[^\s@:]+@[^\s]+|(?:firstparty|chat|mcp|mcp-http|helper|package-fetch):[^\s]+)$/;

/** The text as a subject key, or undefined when it is not one. */
export function parseSubjectKey(text: string): SubjectKey | undefined {
	return text.length <= 512 && SUBJECT_PATTERN.test(text) ? text as SubjectKey : undefined;
}

export function chatSubject(chatId: string): SubjectKey {
	return `chat:${chatId}`;
}

/** A Volt extension: `firstparty:volt.x` for a built-in under a first-party ceiling, else `plugin:pub.name@signer`. */
export function extensionSubject(extensionId: string, firstParty: boolean, signer = 'local'): SubjectKey {
	const id = extensionId.toLowerCase();
	return firstParty ? `firstparty:${id}` : `plugin:${id}@${signer}`;
}

export function isFirstPartySubject(subject: SubjectKey): subject is `firstparty:${string}` {
	return subject.startsWith('firstparty:');
}

export function isPluginSubject(subject: SubjectKey): subject is `plugin:${string}@${string}` {
	return subject.startsWith('plugin:');
}

export function isChatSubject(subject: SubjectKey): subject is `chat:${string}` {
	return subject.startsWith('chat:');
}

/** The extension id of a `plugin:` or `firstparty:` subject. */
export function subjectExtensionId(subject: SubjectKey): string | undefined {
	if (isFirstPartySubject(subject)) {
		return subject.slice('firstparty:'.length);
	}
	if (isPluginSubject(subject)) {
		const rest = subject.slice('plugin:'.length);
		return rest.slice(0, rest.indexOf('@'));
	}
	return undefined;
}

/** The chat id of a `chat:` subject. */
export function subjectChatId(subject: SubjectKey): string | undefined {
	return isChatSubject(subject) ? subject.slice('chat:'.length) : undefined;
}

/**
 * A principal for code that runs in core's own process on a subject's behalf (the window's
 * extension API, a chat's host tool calls): no launch policy, minted by core from its own record.
 */
export function corePrincipal(id: string, subject: SubjectKey, kind: PrincipalKind, createdAt = 0): IPrincipal {
	return { id, subject, kind, executionHost: 'core', launchPolicyHash: '', createdAt };
}

/** Whether `token` lets core prompt for `principalId` at `asOf` (G.7: unconsumed, for it, under 1 s old). */
export function gestureValid(token: IUserGestureToken | undefined, principalId: string, asOf: number): boolean {
	return !!token && !token.consumed && token.principal === principalId && asOf >= token.issuedAt && asOf - token.issuedAt <= GESTURE_TOKEN_TTL_MS;
}
