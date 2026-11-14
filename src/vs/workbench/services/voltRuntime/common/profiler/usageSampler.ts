/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltProfileFile } from './profileFormats.js';

/**
 * Memory and CPU of any command over time, whatever language it is in: a POSIX `sh` script runs
 * the command in the background and, every interval, sums the resident memory and CPU share of
 * its whole process tree from `ps` (macOS and Linux print the same columns), one line per sample.
 * It exits with the command's exit code. Arguments: output file, interval in seconds, command.
 */
export const USAGE_SAMPLER_SCRIPT = [
	'out=$1; interval=$2',
	'sh -c "$3" &',
	'pid=$!',
	'while kill -0 "$pid" 2>/dev/null; do',
	'  ps -A -o pid= -o ppid= -o rss= -o pcpu= 2>/dev/null | awk -v root="$pid" \'{ parent[$1] = $2; rss[$1] = $3; cpu[$1] = $4 } END { r = 0; c = 0; for (p in parent) { q = p; for (d = 0; d < 64 && q != "" && q > 0; d++) { if (q == root) { r += rss[p]; c += cpu[p]; break } q = parent[q] } } printf "%d %.1f\\n", r, c }\' >> "$out"',
	'  sleep "$interval"',
	'done',
	'wait "$pid"',
].join('\n');

/**
 * The sampler's lines (`<rss KB> <cpu %>`) as a Volt usage profile. Samples are spread evenly over
 * the measured wall time: `ps` takes a few milliseconds per round, so the loop's own clock drifts.
 */
export function usageProfile(lines: string, wallMs: number, command: string, exitCode: number | null): IVoltProfileFile {
	const samples = lines.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(values => values.length >= 2 && values.every(Number.isFinite));
	const step = samples.length > 1 ? wallMs / (samples.length - 1) : 0;
	return {
		$volt: 'profile',
		title: `usage: ${command.length > 48 ? `${command.slice(0, 47)}\u2026` : command}`,
		kind: 'usage',
		series: [
			{ name: 'Memory (RSS, process tree)', unit: 'bytes', points: samples.map(([kb], index) => [index * step, kb * 1024] as const) },
			{ name: 'CPU (process tree)', unit: 'percent', points: samples.map(([, cpu], index) => [index * step, cpu] as const) },
		],
		meta: { command, wall: `${(wallMs / 1000).toFixed(2)}s`, exit: exitCode === null ? 'none' : String(exitCode), samples: String(samples.length) },
	};
}
