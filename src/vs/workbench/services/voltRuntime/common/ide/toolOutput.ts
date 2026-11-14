/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The last pass over what an IDE tool hands the model: credentials that commonly turn up in
 * container env dumps, CI logs, HTTP responses and `kubectl describe` are masked, and output
 * past a size no single call should cost is cut to its head and tail. Each capability already
 * shapes its own output; this is the guard that holds when one does not.
 */

const REDACTED = '[redacted]';

interface IRule {
	readonly pattern: RegExp;
	readonly replace: string | ((match: string, ...groups: string[]) => string);
}

const RULES: readonly IRule[] = [
	// PEM private keys, whole block.
	{ pattern: /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, replace: (_match, kind: string) => `-----BEGIN ${kind}PRIVATE KEY----- ${REDACTED} -----END ${kind}PRIVATE KEY-----` },
	// Credentials in URLs: scheme://user:password@host.
	{ pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, replace: `$1${REDACTED}@` },
	// Authorization headers.
	{ pattern: /\b(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1${REDACTED}` },
	// Provider token formats.
	{ pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
	{ pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, replace: REDACTED },
	{ pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: REDACTED },
	{ pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
	{ pattern: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}\b/g, replace: REDACTED },
	{ pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
	{ pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
	{ pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
	{ pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: REDACTED },
	// NAME=value for environment-style names (upper case, as env dumps print them).
	{ pattern: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"'`]{6,}\3/g, replace: `$1$2$3${REDACTED}$3` },
	// "apiKey": "value" in JSON and YAML-ish output: keys that end in a secret word.
	{ pattern: /(["']?[A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*:\s*["'])[^"'\n]{6,}(["'])/gi, replace: `$1${REDACTED}$2` },
];

export interface IRedaction {
	readonly text: string;
	readonly count: number;
}

/** `text` with credentials masked, and how many were. */
export function redactSecrets(text: string): IRedaction {
	let count = 0;
	let out = text;
	for (const rule of RULES) {
		out = out.replace(rule.pattern, (...args: unknown[]) => {
			const match = args[0] as string;
			const replaced = typeof rule.replace === 'string'
				? match.replace(new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')), rule.replace)
				: rule.replace(match, ...(args.slice(1, -2) as string[]));
			if (replaced !== match) {
				count++;
			}
			return replaced;
		});
	}
	return { text: out, count };
}

/** What one tool result may cost, in characters (about 15k tokens). */
export const MAX_TOOL_TEXT = 60_000;

/** Head and tail of an over-long result, with a line that says what was cut and how to get less. */
export function capToolText(text: string, max = MAX_TOOL_TEXT): string {
	if (text.length <= max) {
		return text;
	}
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n\n[... ${omitted} characters omitted. Ask for less: a narrower target, a path, a smaller tail or limit ...]\n\n${text.slice(-tail)}`;
}

/** Both passes, in order: redaction first, so a cut never splits a secret into a visible half. */
export function guardToolText(text: string): string {
	const redacted = redactSecrets(text);
	const capped = capToolText(redacted.text);
	return redacted.count ? `${capped}\n[Volt masked ${redacted.count} credential${redacted.count === 1 ? '' : 's'} in this output.]` : capped;
}
