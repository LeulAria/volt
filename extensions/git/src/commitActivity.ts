/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { detectCodingAgents } from './agentAttribution';

/** One local calendar day: its midnight (epoch ms), commits, and commits whose trailers name a coding agent. */
export type CommitActivityDay = [day: number, commits: number, agents: number];

/**
 * `git log` arguments for activity: one record per commit, `<committer time>\x1f<Co-authored-by trailers>\x1e`.
 * Trailers only, never bodies, so a long history stays a few bytes per commit.
 */
export function commitActivityArgs(walkStdin: boolean): string[] {
	return [
		'log',
		'--format=%ct%x1f%(trailers:key=Co-authored-by,unfold)%x1e',
		...(walkStdin ? ['--stdin'] : ['--branches', '--remotes', '--tags']),
	];
}

/** Buckets the records into local days, oldest first. */
export function parseCommitActivity(stdout: string): CommitActivityDay[] {
	const days = new Map<number, CommitActivityDay>();
	for (const record of stdout.split('\x1e')) {
		const separator = record.indexOf('\x1f');
		if (separator === -1) {
			continue;
		}
		const seconds = Number(record.slice(0, separator).trim());
		if (!Number.isFinite(seconds) || seconds <= 0) {
			continue;
		}
		const date = new Date(seconds * 1000);
		date.setHours(0, 0, 0, 0);
		const day = date.getTime();
		let bucket = days.get(day);
		if (!bucket) {
			bucket = [day, 0, 0];
			days.set(day, bucket);
		}
		bucket[1]++;
		const trailers = record.slice(separator + 1);
		if (trailers.length > 16 && detectCodingAgents(trailers).length) {
			bucket[2]++;
		}
	}
	return [...days.values()].sort((a, b) => a[0] - b[0]);
}
