/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tiered write-failure coaching (Cline). An empty `contents` is almost always
 * a truncated tool call, not a real intent to wipe the file. The second miss
 * teaches chunking; the third forbids another full write.
 */

const fails = new Map<string, number>();

export function noteWriteFail(path: string): number {
	const key = normalize(path);
	const next = (fails.get(key) ?? 0) + 1;
	fails.set(key, next);
	return next;
}

export function noteWriteOk(path: string): void {
	fails.delete(normalize(path));
}

export function writeFailCount(path: string): number {
	return fails.get(normalize(path)) ?? 0;
}

export function resetWriteCoach(): void {
	fails.clear();
}

export function writeFailCoaching(path: string, count: number, contextPressure = false): string {
	const pressure = contextPressure ? ' The context window looks tight, so a full rewrite is likely to be cut off again.' : '';
	if (count >= 3) {
		return `contents was empty for ${path} (${count} times). Do not call write_file again for this path. Use edit_file in small unique hunks, or split the file across several writes.${pressure}`;
	}
	if (count === 2) {
		return `contents was empty for ${path} again. Write a skeleton first, then edit_file the missing pieces. A second full overwrite will almost certainly truncate.${pressure}`;
	}
	return `contents is required to write ${path}. If the previous call was cut off, retry with a smaller file or use edit_file.${pressure}`;
}

function normalize(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
