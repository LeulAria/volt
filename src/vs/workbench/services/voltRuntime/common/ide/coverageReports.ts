/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Line coverage of one file, from whatever report a runner wrote. */
export interface IFileCoverageSummary {
	/** As the report names it (absolute, or relative to the project). */
	readonly path: string;
	readonly covered: number;
	readonly total: number;
	/** 1-based lines with code that never ran. */
	readonly uncovered: readonly number[];
}

/** Report file names, most specific first; the controller picks the newest that exists. */
export const COVERAGE_REPORT_FILES = ['coverage/coverage-final.json', 'coverage/lcov.info', 'lcov.info', 'coverage/cobertura-coverage.xml', 'coverage.xml', 'coverage.out', 'cover.out'] as const;

export function parseCoverage(fileName: string, text: string): IFileCoverageSummary[] {
	if (fileName.endsWith('.json')) {
		return parseIstanbul(text);
	}
	if (fileName.endsWith('.info')) {
		return parseLcov(text);
	}
	if (fileName.endsWith('.xml')) {
		return parseCobertura(text);
	}
	return parseGoCover(text);
}

function summary(path: string, lines: ReadonlyMap<number, number>): IFileCoverageSummary {
	const uncovered = [...lines].filter(([, hits]) => hits === 0).map(([line]) => line).sort((a, b) => a - b);
	return { path, covered: lines.size - uncovered.length, total: lines.size, uncovered };
}

/** Istanbul's coverage-final.json (jest, vitest, nyc, c8). Lines are statement start lines. */
export function parseIstanbul(text: string): IFileCoverageSummary[] {
	const json = JSON.parse(text) as Record<string, { path?: string; s?: Record<string, number>; statementMap?: Record<string, { start?: { line?: number } }> }>;
	return Object.entries(json).map(([key, file]) => {
		const lines = new Map<number, number>();
		for (const [id, hits] of Object.entries(file.s ?? {})) {
			const line = file.statementMap?.[id]?.start?.line;
			if (line) {
				lines.set(line, Math.max(lines.get(line) ?? 0, hits));
			}
		}
		return summary(file.path ?? key, lines);
	});
}

export function parseLcov(text: string): IFileCoverageSummary[] {
	const out: IFileCoverageSummary[] = [];
	let path: string | undefined;
	let lines = new Map<number, number>();
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line.startsWith('SF:')) {
			path = line.slice(3);
			lines = new Map();
		} else if (line.startsWith('DA:')) {
			const [number, hits] = line.slice(3).split(',');
			lines.set(Number(number), Number(hits));
		} else if (line === 'end_of_record' && path) {
			out.push(summary(path, lines));
			path = undefined;
		}
	}
	return out;
}

/** Cobertura XML (coverage.py `coverage xml`, many JVM and .NET tools). */
export function parseCobertura(text: string): IFileCoverageSummary[] {
	const byFile = new Map<string, Map<number, number>>();
	for (const cls of text.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
		const lines = byFile.get(cls[1]) ?? new Map<number, number>();
		for (const line of cls[2].matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) {
			lines.set(Number(line[1]), Math.max(lines.get(Number(line[1])) ?? 0, Number(line[2])));
		}
		byFile.set(cls[1], lines);
	}
	return [...byFile].map(([path, lines]) => summary(path, lines));
}

/** `go test -coverprofile` output: `file:start.col,end.col statements count`. */
export function parseGoCover(text: string): IFileCoverageSummary[] {
	const byFile = new Map<string, Map<number, number>>();
	for (const match of text.matchAll(/^(.+?):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/gm)) {
		const lines = byFile.get(match[1]) ?? new Map<number, number>();
		for (let line = Number(match[2]); line <= Number(match[3]); line++) {
			lines.set(line, Math.max(lines.get(line) ?? 0, Number(match[4])));
		}
		byFile.set(match[1], lines);
	}
	return [...byFile].map(([path, lines]) => summary(path, lines));
}

/** Lines as ranges: [3, 4, 5, 9] -> "3-5, 9". */
export function lineRanges(lines: readonly number[], max = 40): string {
	const ranges: string[] = [];
	let start: number | undefined;
	let previous: number | undefined;
	for (const line of [...lines, Number.NaN]) {
		if (start !== undefined && previous !== undefined && line === previous + 1) {
			previous = line;
			continue;
		}
		if (start !== undefined && previous !== undefined) {
			ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
		}
		start = line;
		previous = line;
	}
	return ranges.length > max ? `${ranges.slice(0, max).join(', ')}, ... (${ranges.length - max} more ranges)` : ranges.join(', ');
}
