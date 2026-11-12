/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEgressHostGranted } from '../../../../platform/webview/common/voltWebviewEgress.js';

/**
 * `vscode.env.openExternal` and `asExternalUri` from an extension (spec I.10, B-37): a link that
 * leaves Volt for another app or a host the extension wasn't granted is shown to the user, in
 * Volt's words, before it opens. Pure, so the decisions are tested without a workbench.
 */

/** Who asked, as core knows it (the id is checked against the calling extension host). */
export interface IExternalOpenCaller {
	/** Undefined: the host didn't say which of its extensions asked, or named one it doesn't run. */
	readonly extensionId: string | undefined;
	/** Shipped with Volt (VS Code's and Volt's built-ins): first party never prompts (G.10, G.12). */
	readonly builtin: boolean;
	/** In `volt.extensions.sandboxed`. */
	readonly sandboxed: boolean;
	/** Its granted `net.connect` hosts (`*`: any). */
	readonly grantedHosts: readonly string[];
}

export type ExternalOpenDecision =
	| { readonly kind: 'allow' }
	| { readonly kind: 'confirm'; readonly reason: 'scheme' | 'host' };

/**
 * - web links (`http`, `https`): open as before (VS Code's link protection still asks about
 *   untrusted domains), except a sandboxed extension's to a host it wasn't granted: confirm;
 * - Volt's own scheme: open (Volt handles it, and asks before an extension's URI handler runs);
 * - any other scheme (`file`, `mailto`, `ssh`, an app's protocol): confirm, because it starts
 *   another app;
 * - a built-in asks for nothing; an unknown caller is treated as a sandboxed one when its host
 *   runs a sandboxed extension.
 */
export function externalOpenDecision(url: string, caller: IExternalOpenCaller, productScheme: string | undefined): ExternalOpenDecision {
	if (caller.builtin && !caller.sandboxed) {
		return { kind: 'allow' };
	}
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
	if (scheme === 'http' || scheme === 'https') {
		return caller.sandboxed && !isEgressHostGranted(url, caller.grantedHosts) ? { kind: 'confirm', reason: 'host' } : { kind: 'allow' };
	}
	if (scheme && productScheme && scheme === productScheme.toLowerCase()) {
		return { kind: 'allow' };
	}
	return { kind: 'confirm', reason: 'scheme' };
}

/**
 * `asExternalUri` only resolves a URI (and may forward a port): it asks only for a sandboxed
 * extension's web URI to a host it wasn't granted.
 */
export function externalUriDecision(url: string, caller: IExternalOpenCaller): ExternalOpenDecision {
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
	return caller.sandboxed && (scheme === 'http' || scheme === 'https') && !isEgressHostGranted(url, caller.grantedHosts)
		? { kind: 'confirm', reason: 'host' }
		: { kind: 'allow' };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * How often one extension may ask (G.12): at most one prompt a minute and three a day; after two
 * refusals it is refused without asking until Volt restarts. The same URL asked again within two
 * seconds shares the prompt already showing.
 */
export class ExternalOpenPromptBudget {

	static readonly PER_MINUTE = 1;
	static readonly PER_DAY = 3;
	static readonly REFUSALS = 2;
	static readonly COALESCE_MS = 2_000;

	private readonly asked = new Map<string, number[]>();
	private readonly refusals = new Map<string, number>();
	private readonly pending = new Map<string, { readonly at: number; readonly answer: Promise<boolean> }>();

	constructor(private readonly now: () => number = Date.now) { }

	/**
	 * Asks through `prompt` if the budget allows, else answers false without asking. `key` is the
	 * extension (unknown callers share one key).
	 */
	async ask(key: string, url: string, prompt: () => Promise<boolean>): Promise<{ readonly allowed: boolean; readonly asked: boolean; readonly reason?: string }> {
		const now = this.now();
		const pendingKey = `${key}\n${url}`;
		const shared = this.pending.get(pendingKey);
		if (shared && now - shared.at < ExternalOpenPromptBudget.COALESCE_MS) {
			return { allowed: await shared.answer, asked: false };
		}
		const exhausted = this.exhausted(key, now);
		if (exhausted) {
			return { allowed: false, asked: false, reason: exhausted };
		}
		this.asked.set(key, [...(this.asked.get(key) ?? []).filter(at => now - at < DAY), now]);
		const answer = prompt();
		this.pending.set(pendingKey, { at: now, answer });
		let allowed = false;
		try {
			allowed = await answer;
		} finally {
			if (this.pending.get(pendingKey)?.answer === answer) {
				this.pending.delete(pendingKey);
			}
		}
		if (!allowed) {
			this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
		}
		return { allowed, asked: true };
	}

	/** Why `key` may not ask now; undefined when it may. */
	exhausted(key: string, now: number = this.now()): string | undefined {
		if ((this.refusals.get(key) ?? 0) >= ExternalOpenPromptBudget.REFUSALS) {
			return 'refused twice already';
		}
		const times = (this.asked.get(key) ?? []).filter(at => now - at < DAY);
		if (times.length >= ExternalOpenPromptBudget.PER_DAY) {
			return 'asked three times today';
		}
		if (times.filter(at => now - at < MINUTE).length >= ExternalOpenPromptBudget.PER_MINUTE) {
			return 'asked less than a minute ago';
		}
		return undefined;
	}
}
