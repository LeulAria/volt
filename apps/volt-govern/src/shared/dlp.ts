/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DlpAction, IDlpPattern } from './policy.js';

/**
 * Secrets the gateway redacts from prompts before they reach a provider. High-precision patterns
 * only (a false positive rewrites a developer's code in the model's view): keys with a fixed,
 * recognizable shape, not "anything that looks random".
 */
export const BUILTIN_SECRET_PATTERNS: readonly IDlpPattern[] = [
	{ name: 'private-key', regex: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----', action: 'redact' },
	{ name: 'aws-access-key', regex: '\\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\\b', action: 'redact' },
	{ name: 'github-token', regex: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\\b|\\bgithub_pat_[A-Za-z0-9_]{60,255}\\b', action: 'redact' },
	{ name: 'gitlab-token', regex: '\\bglpat-[A-Za-z0-9_-]{20,}\\b', action: 'redact' },
	{ name: 'slack-token', regex: '\\bxox[abposr]-[A-Za-z0-9-]{10,}\\b', action: 'redact' },
	{ name: 'stripe-key', regex: '\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\\b', action: 'redact' },
	{ name: 'anthropic-key', regex: '\\bsk-ant-[A-Za-z0-9_-]{20,}\\b', action: 'redact' },
	{ name: 'openai-key', regex: '\\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\\b', action: 'redact' },
	{ name: 'google-api-key', regex: '\\bAIza[0-9A-Za-z_-]{35}\\b', action: 'redact' },
	{ name: 'jwt', regex: '\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b', action: 'redact' },
	{ name: 'connection-string', regex: '\\b(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis|amqp)://[^\\s:@/]+:[^\\s@/]+@[^\\s]+', action: 'redact' },
	{ name: 'volt-gateway-token', regex: '\\bvgt_[A-Za-z0-9_.-]{20,}\\b', action: 'redact' },
];

export interface IDlpFinding {
	readonly pattern: string;
	readonly action: DlpAction;
	readonly count: number;
}

export interface IDlpResult {
	readonly text: string;
	readonly findings: readonly IDlpFinding[];
	readonly blocked: boolean;
}

const compiled = new Map<string, RegExp | null>();

function compile(source: string): RegExp | null {
	let re = compiled.get(source);
	if (re === undefined) {
		try {
			re = new RegExp(source, 'g');
		} catch {
			re = null;
		}
		compiled.set(source, re);
	}
	if (re) {
		re.lastIndex = 0;
	}
	return re;
}

/** Redacts (or flags for blocking) every match. The secret itself never appears in findings. */
export function scanText(text: string, patterns: readonly IDlpPattern[]): IDlpResult {
	let out = text;
	const findings: IDlpFinding[] = [];
	let blocked = false;
	for (const p of patterns) {
		const re = compile(p.regex);
		if (!re) {
			continue;
		}
		let count = 0;
		out = out.replace(re, () => {
			count++;
			return `[REDACTED:${p.name}]`;
		});
		if (count) {
			findings.push({ pattern: p.name, action: p.action, count });
			blocked ||= p.action === 'block';
		}
	}
	return { text: out, findings, blocked };
}

/** Whether a pattern compiles, for the console's editor. */
export function validatePattern(source: string): string | undefined {
	try {
		new RegExp(source, 'g');
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
