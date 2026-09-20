/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pulls the structured tool payload off an ACP `tool_call` / `tool_call_update`.
 *
 * Cursor, t3code, and pi all put the interesting fields in slightly different
 * places (`rawInput`, `input`, `_meta`, `item`, `locations`). The UI needs one
 * JSON blob with pattern / glob / path / offset so the explore trail can say
 * "Grepped foo in src" instead of just "grep".
 */

const INPUT_KEYS = ['rawInput', 'input', 'arguments', 'params', 'args'] as const;
const PATH_KEYS = ['path', 'file', 'uri', 'target', 'filename', 'target_file', 'targetFile', 'file_path', 'filePath', 'relative_path', 'relativePath'];
const LOCATION_ONLY_KEYS = new Set(['path', 'file', 'uri', 'line', 'lineNumber', 'line_number', 'startLine', 'endLine', 'files']);

export function collectAcpToolInput(update: Record<string, unknown>): string | undefined {
	const raw = pickNested(update, INPUT_KEYS);
	const location = firstToolLocation(update);
	const files = allToolLocationPaths(update);
	if (typeof raw === 'string' && raw.trim()) {
		if (location && !raw.includes(location.path)) {
			const parsed = parseRecord(raw);
			if (parsed) {
				return JSON.stringify(withFiles(withLocation(parsed, location), files));
			}
			return JSON.stringify(withFiles({ path: location.path, line: location.line, text: raw }, files));
		}
		const parsed = parseRecord(raw);
		return parsed ? JSON.stringify(withFiles(parsed, files)) : raw;
	}
	const record = asRecord(raw);
	if (record) {
		return JSON.stringify(withFiles(withLocation({ ...record }, location), files));
	}
	if (location) {
		return JSON.stringify(withFiles({ path: location.path, line: location.line }, files));
	}
	if (files.length) {
		return JSON.stringify({ files });
	}
	return undefined;
}

export function mergeToolInput(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (!incoming?.trim()) {
		return existing;
	}
	if (!existing?.trim()) {
		return incoming;
	}
	if (existing === incoming || existing.includes(incoming)) {
		return existing;
	}
	if (incoming.includes(existing) && parseRecord(incoming)) {
		return incoming;
	}
	const current = parseRecord(existing);
	const next = parseRecord(incoming);
	if (current && next) {
		if (isLocationOnly(next) && hasSearchScope(current)) {
			const files = mergeFileLists(current.files, next.files);
			if (!current.pattern && !current.glob && !current.query && !current.offset && !current.startLine && !current.line && next.line !== undefined) {
				return JSON.stringify(files ? { ...current, line: next.line, files } : { ...current, line: next.line });
			}
			return files ? JSON.stringify({ ...current, files }) : existing;
		}
		const files = mergeFileLists(current.files, next.files);
		return JSON.stringify(files ? { ...current, ...next, files } : { ...current, ...next });
	}
	if (next) {
		return incoming;
	}
	return existing + incoming;
}

function pickNested(update: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (update[key] !== undefined && update[key] !== null) {
			return update[key];
		}
	}
	for (const nest of [asRecord(update._meta), asRecord(update.item), asRecord(update.data)]) {
		if (!nest) {
			continue;
		}
		for (const key of keys) {
			if (nest[key] !== undefined && nest[key] !== null) {
				return nest[key];
			}
		}
	}
	return undefined;
}

function firstToolLocation(update: Record<string, unknown>): { path: string; line?: number } | undefined {
	const paths = allToolLocationPaths(update);
	if (!paths.length) {
		return undefined;
	}
	const buckets = [update.locations, asRecord(update._meta)?.locations, asRecord(update.item)?.locations];
	for (const locations of buckets) {
		if (!Array.isArray(locations) || !locations.length) {
			continue;
		}
		const first = asRecord(locations[0]);
		const line = Number(first?.line ?? first?.lineNumber ?? first?.line_number);
		return { path: paths[0], line: Number.isFinite(line) && line > 0 ? line : undefined };
	}
	return { path: paths[0] };
}

function allToolLocationPaths(update: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const buckets = [update.locations, asRecord(update._meta)?.locations, asRecord(update.item)?.locations];
	for (const locations of buckets) {
		if (!Array.isArray(locations)) {
			continue;
		}
		for (const location of locations) {
			const rec = asRecord(location);
			const path = rec ? asString(rec.path) ?? asString(rec.uri) ?? asString(rec.file) : asString(location);
			if (!path || seen.has(path)) {
				continue;
			}
			seen.add(path);
			paths.push(path);
		}
	}
	return paths;
}

function withFiles(record: Record<string, unknown>, files: string[]): Record<string, unknown> {
	const merged = mergeFileLists(record.files, files);
	if (merged) {
		record.files = merged;
	}
	return record;
}

function mergeFileLists(...lists: unknown[]): string[] | undefined {
	const files: string[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		if (!Array.isArray(list)) {
			continue;
		}
		for (const value of list) {
			if (typeof value !== 'string' || !value || seen.has(value)) {
				continue;
			}
			seen.add(value);
			files.push(value);
		}
	}
	return files.length ? files : undefined;
}

function withLocation(record: Record<string, unknown>, location: { path: string; line?: number } | undefined): Record<string, unknown> {
	if (!location) {
		return record;
	}
	if (!PATH_KEYS.some(key => asString(record[key]))) {
		record.path = location.path;
		if (location.line !== undefined && record.line === undefined) {
			record.line = location.line;
		}
	}
	return record;
}

function hasSearchScope(record: Record<string, unknown>): boolean {
	return PATH_KEYS.some(key => asString(record[key]))
		|| !!asString(record.target_directory)
		|| !!asString(record.targetDirectory)
		|| !!asString(record.directory)
		|| !!asString(record.pattern)
		|| !!asString(record.glob)
		|| !!asString(record.query);
}

function isLocationOnly(record: Record<string, unknown>): boolean {
	const keys = Object.keys(record);
	return keys.length > 0 && keys.every(key => LOCATION_ONLY_KEYS.has(key));
}

function parseRecord(value: string): Record<string, unknown> | undefined {
	const trimmed = value.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	try {
		return asRecord(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}
