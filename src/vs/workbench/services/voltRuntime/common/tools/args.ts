/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function asRecord(args: unknown): Record<string, unknown> {
	return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

export function pickString(args: unknown, ...keys: string[]): string | undefined {
	const record = asRecord(args);
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value;
		}
	}
	return undefined;
}

/** Like pickString, but an empty string is a real value (write_file of an empty file). */
export function pickStringAllowEmpty(args: unknown, ...keys: string[]): string | undefined {
	const record = asRecord(args);
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string') {
			return value;
		}
	}
	return undefined;
}

export function pickNumber(args: unknown, ...keys: string[]): number | undefined {
	const record = asRecord(args);
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
			return Number(value);
		}
	}
	return undefined;
}

export function pickBoolean(args: unknown, key: string): boolean {
	const value = asRecord(args)[key];
	return value === true || value === 'true';
}
