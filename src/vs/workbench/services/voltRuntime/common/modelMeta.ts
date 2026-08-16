/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
