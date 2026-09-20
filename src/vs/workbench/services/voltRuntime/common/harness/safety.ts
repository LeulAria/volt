/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RiskLevel } from '../access/accessTypes.js';
import { classifyRisk } from '../access/riskClassifier.js';
import { IIntentSignals } from './intake.js';
import { IIntent } from './intent.js';

/**
 * Safety boundary. The access broker decides allow/ask/deny; this decides *what kind of
 * danger* a payload is, independently of policy, so a misconfigured "auto" mode cannot
 * silently ship a secret or a `rm -rf`.
 *
 * Every check is fail-closed: an unrecognised shape is treated as riskier than a recognised
 * safe one. The runtime still has to ask the user - this module only names the reason.
 */

export type SafetyKind =
	| 'secret'
	| 'command'
	| 'file'
	| 'network'
	| 'sandbox';

export interface ISecretHit {
	readonly kind: string;
	readonly start: number;
	readonly end: number;
}

export interface ISafetyFinding {
	readonly kind: SafetyKind;
	readonly risk: RiskLevel;
	readonly reason: string;
	/** Present for secrets so the caller can redact rather than log the value. */
	readonly hits?: readonly ISecretHit[];
}

export interface ISafetyPosture {
	readonly risk: RiskLevel;
	readonly requireApproval: boolean;
	readonly sandbox: boolean;
	readonly findings: readonly ISafetyFinding[];
}

const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
	['aws-access-key', /AKIA[0-9A-Z]{16}/g],
	['github-token', /gh[pousr]_[A-Za-z0-9_]{20,}/g],
	['openai-key', /sk-[A-Za-z0-9_-]{20,}/g],
	['private-key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g],
	['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
	['generic-secret', /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi],
];

const CREDENTIAL_PATH = /(\.env($|\.)|id_rsa|id_ed25519|\.pem\b|\.p12\b|credentials|\.ssh\/|authorized_keys)/i;

const SENSITIVE_DIR = /(^|\/)(\.git|node_modules|\.volt\/secrets)(\/|$)/i;

const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

const BLOCKED_HOST = /^(metadata\.google\.internal|169\.266\.169\.254|169\.254\.169\.254)$/i;

export function scanSecrets(text: string): ISecretHit[] {
	if (!text) {
		return [];
	}
	const hits: ISecretHit[] = [];
	for (const [kind, pattern] of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			hits.push({ kind, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
		}
	}
	return hits;
}

export function redactSecrets(text: string): string {
	let out = text;
	for (const [kind, pattern] of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		out = out.replace(pattern, `[redacted:${kind}]`);
	}
	return out;
}

export function assessCommand(command: string): ISafetyFinding {
	const risk = classifyRisk('shell', command);
	return {
		kind: 'command',
		risk,
		reason: risk === 'safe' || risk === 'low'
			? `Command is ${risk}.`
			: `Command risk is ${risk}.`,
	};
}

export function assessFile(path: string, action: 'read' | 'edit' = 'read'): ISafetyFinding {
	if (CREDENTIAL_PATH.test(path)) {
		return { kind: 'file', risk: 'critical', reason: `Refuses ${action} of a credential path: ${path}.` };
	}
	if (SENSITIVE_DIR.test(path) && action === 'edit') {
		return { kind: 'file', risk: 'high', reason: `Editing ${path} is outside the project source.` };
	}
	return { kind: 'file', risk: action === 'edit' ? 'low' : 'safe', reason: `${action} ${path}` };
}

/**
 * Network allowlist. A host that is not on the list is denied unless the list
 * is empty (empty means "policy has not restricted the network yet").
 */
export function networkAllowed(url: string, allowlist: readonly string[] = []): { allowed: boolean; host: string; reason: string } {
	const finding = assessNetwork(url);
	let host = '';
	try {
		host = new URL(url).hostname;
	} catch {
		host = url.replace(/^https?:\/\//, '').split(/[/:?]/)[0] ?? url;
	}
	if (finding.risk === 'critical') {
		return { allowed: false, host, reason: finding.reason };
	}
	if (!allowlist.length) {
		return { allowed: true, host, reason: finding.reason };
	}
	const ok = allowlist.some(entry => host === entry || host.endsWith(`.${entry}`));
	return { allowed: ok, host, reason: ok ? `Allowlisted host ${host}.` : `Host ${host} is not on the network allowlist.` };
}

export function assessNetwork(url: string): ISafetyFinding {
	let host = '';
	try {
		host = new URL(url).hostname;
	} catch {
		host = url.replace(/^https?:\/\//, '').split(/[/:?]/)[0] ?? url;
	}
	if (BLOCKED_HOST.test(host)) {
		return { kind: 'network', risk: 'critical', reason: `Blocked link-local / metadata host: ${host}.` };
	}
	if (PRIVATE_HOST.test(host)) {
		return { kind: 'network', risk: 'low', reason: `Local host ${host}.` };
	}
	return { kind: 'network', risk: 'medium', reason: `External host ${host || url}.` };
}

/**
 * The stance the rest of the run should take, derived from the request itself - before any
 * tool has been called. A critical ask still runs, but every mutating tool starts at `ask`.
 */
export function safetyPosture(signals: IIntentSignals, intent: IIntent): ISafetyPosture {
	const findings: ISafetyFinding[] = [];
	if (signals.risk === 'critical' || signals.risk === 'high') {
		findings.push({ kind: 'command', risk: signals.risk, reason: `The request itself is ${signals.risk} risk.` });
	}
	if (signals.autonomy === 'supervised') {
		findings.push({ kind: 'sandbox', risk: 'low', reason: 'The user asked to approve work before it happens.' });
	}
	const sandbox = signals.risk === 'critical' || intent.lane === 'mission';
	if (sandbox) {
		findings.push({ kind: 'sandbox', risk: signals.risk, reason: 'Mutating work should stay inside the workspace sandbox.' });
	}
	return {
		risk: signals.risk,
		requireApproval: signals.autonomy === 'supervised' || signals.risk === 'critical' || signals.risk === 'high',
		sandbox,
		findings,
	};
}

export function worstFinding(findings: readonly ISafetyFinding[]): ISafetyFinding | undefined {
	if (!findings.length) {
		return undefined;
	}
	const rank: Record<RiskLevel, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
	return [...findings].sort((a, b) => rank[b.risk] - rank[a.risk])[0];
}
