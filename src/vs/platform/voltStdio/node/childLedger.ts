/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { Disposable } from '../../../base/common/lifecycle.js';
import { dirname } from '../../../base/common/path.js';

interface ILedgerEntry {
	readonly pid: number;
	/** The program as spawned; a reused pid runs something else. */
	readonly command: string;
}

const WRITE_DELAY_MS = 200;
const KILL_GRACE_MS = 2_000;
const KILL_POLL_MS = 50;

/**
 * The process groups a long-lived process (the agent server) started: agent CLIs and shell
 * commands, each spawned detached in its own group. When that process is killed outright they
 * keep running with no parent; the next start reads the ledger and stops the ones still orphaned.
 */
export class ChildLedger extends Disposable {

	private readonly entries = new Map<number, ILedgerEntry>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private writing: Promise<void> = Promise.resolve();

	constructor(private readonly file: string) {
		super();
		this._register({ dispose: () => clearTimeout(this.timer) });
	}

	add(pid: number | undefined, command: string): void {
		if (pid) {
			this.entries.set(pid, { pid, command });
			this.schedule();
		}
	}

	delete(pid: number | undefined): void {
		if (pid && this.entries.delete(pid)) {
			this.schedule();
		}
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			const text = JSON.stringify([...this.entries.values()]);
			this.writing = this.writing.then(async () => {
				await fs.mkdir(dirname(this.file), { recursive: true });
				const temp = `${this.file}.${process.pid}.tmp`;
				await fs.writeFile(temp, text, { mode: 0o600 });
				await fs.rename(temp, this.file);
			}).catch(() => { /* best effort */ });
		}, WRITE_DELAY_MS);
	}

	/**
	 * Stops the groups a previous run left behind: only processes the ledger names that lost their
	 * parent (ppid 1) and still run the recorded program. Resolves with how many it stopped.
	 */
	static async reapOrphans(file: string): Promise<number> {
		if (process.platform === 'win32') {
			return 0;
		}
		let entries: ILedgerEntry[];
		try {
			entries = JSON.parse(await fs.readFile(file, 'utf8'));
		} catch {
			return 0;
		}
		await fs.rm(file, { force: true });
		const table = await processTable();
		const orphans: number[] = [];
		for (const entry of Array.isArray(entries) ? entries : []) {
			if (!Number.isInteger(entry?.pid) || entry.pid <= 1 || typeof entry.command !== 'string') {
				continue;
			}
			const members = table.filter(row => row.pgid === entry.pid);
			const leader = table.find(row => row.pid === entry.pid);
			// A group id is not handed out again while the group has members, so with its leader gone
			// they are still ours; a live leader must have lost its parent and run the same program.
			const ours = leader ? leader.pgid === entry.pid && leader.ppid === 1 && leader.command.includes(entry.command) : members.length > 0;
			if (ours) {
				orphans.push(entry.pid);
			}
		}
		for (const pid of orphans) {
			signalGroup(pid, 'SIGTERM');
		}
		// Most stop at once: wait only while some group still has members, then force the rest.
		const deadline = Date.now() + KILL_GRACE_MS;
		let left = orphans;
		while (left.length && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, KILL_POLL_MS));
			left = left.filter(groupAlive);
		}
		for (const pid of left) {
			signalGroup(pid, 'SIGKILL');
		}
		return orphans.length;
	}
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// gone
		}
	}
}

interface IProcessRow {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	readonly command: string;
}

function processTable(): Promise<IProcessRow[]> {
	return new Promise(resolve => execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }, (err, stdout) => {
		const rows: IProcessRow[] = [];
		for (const line of err ? [] : stdout.split('\n')) {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			if (match) {
				rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] });
			}
		}
		resolve(rows);
	}));
}
