/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** First non-empty string among values a provider might use for a description or name. */
export function pickText(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

export function pickNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			return value;
		}
		if (typeof value === 'string') {
			const parsed = parseContextTokens(value);
			if (parsed) {
				return parsed;
			}
		}
	}
	return undefined;
}

/** `300k`, `1m`, `200000` -> token count. */
export function parseContextTokens(value: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/i.exec(value.trim());
	if (!match) {
		return undefined;
	}
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) {
		return undefined;
	}
	const unit = match[2]?.toLowerCase();
	if (unit === 'm') {
		return Math.round(amount * 1_000_000);
	}
	if (unit === 'k') {
		return Math.round(amount * 1_000);
	}
	return Math.round(amount);
}

/** `200000` -> `200k`, `1000000` -> `1m`. */
export function formatContextLabel(tokens: number): string {
	if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
		return `${tokens / 1_000_000}m`;
	}
	if (tokens >= 1_000 && tokens % 1_000 === 0) {
		return `${tokens / 1_000}k`;
	}
	if (tokens >= 1_000_000) {
		return `${Number((tokens / 1_000_000).toFixed(1))}m`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}k`;
	}
	return String(tokens);
}

export function contextLabelFromTokens(tokens: number | undefined): string | undefined {
	return tokens ? formatContextLabel(tokens) : undefined;
}

/** Picker labels use 200K / 1M, matching the CLI catalogs. */
export function formatContextChoice(value: string): string {
	const tokens = parseContextTokens(value);
	if (!tokens) {
		return value.trim().toUpperCase();
	}
	if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
		return `${tokens / 1_000_000}M`;
	}
	if (tokens >= 1_000 && tokens % 1_000 === 0) {
		return `${tokens / 1_000}K`;
	}
	if (tokens >= 1_000_000) {
		return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}K`;
	}
	return String(tokens);
}

/**
 * A raw model id a harness reports (`claude-opus-5-5[1m]`, `claude-sonnet-5-5-20261001`) as the
 * name people read: `Opus 5.5 · 1M`, `Sonnet 5.5`. A label that already reads as a name is kept.
 */
export function readableModelLabel(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) {
		return undefined;
	}
	const wide = /\[1m\]$/i.test(value);
	const id = value.replace(/\[[^\]]*\]$/, '').trim();
	if (/\s/.test(id) || /[A-Z]/.test(id)) {
		return wide ? `${id} · 1M` : id;
	}
	const claude = /^(?:anthropic[./])?(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?(?:-\d{8})?$/i.exec(id);
	let name: string;
	if (claude) {
		name = `${claude[1].charAt(0).toUpperCase()}${claude[1].slice(1).toLowerCase()} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
	} else if (/^[a-z0-9][a-z0-9._-]*$/i.test(id) && id.includes('-')) {
		name = id.split('-').map(part => /^gpt/i.test(part) ? part.replace(/^gpt/i, 'GPT') : /^\d/.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
	} else {
		name = id;
	}
	return wide ? `${name} · 1M` : name;
}
