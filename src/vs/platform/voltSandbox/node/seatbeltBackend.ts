/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { allEnforcement, ISandboxBackendCapabilities, SandboxUnavailableError } from '../common/sandboxBackend.js';
import { denialKindForOperation } from '../common/sandboxDenials.js';
import { IResolvedSandboxPolicy } from '../common/sandboxResolved.js';
import { buildSeatbeltProfile, parseSeatbeltLogLine, SANDBOX_EXEC_PATH, SEATBELT_PROLOGUE, SEATBELT_TAG_PREFIX } from '../common/seatbelt.js';
import { ISandboxBackend, ISandboxLaunchOptions, ISandboxLaunchSpec, SandboxConfirmation } from './sandboxBackends.js';

const execFileAsync = promisify(execFile);

/** The watchdog: when Volt's end of its stdin closes (Volt exited or crashed), it kills the run's process group. */
const WATCHDOG = 'read _ ; kill -KILL -- "-$1" 2>/dev/null';
const CONFIRM_TIMEOUT_MS = 15_000;

/**
 * macOS: Seatbelt through `/usr/bin/sandbox-exec`. Deny-default for workloads; allow-default
 * with explicit denies for policies that need the OS's services (agent CLIs).
 */
export class SeatbeltBackend implements ISandboxBackend {

	readonly id = 'seatbelt' as const;
	private capabilities: Promise<ISandboxBackendCapabilities> | undefined;
	private monitor: ChildProcess | undefined;
	private readonly listeners = new Map<string, ISandboxLaunchOptions['onDenial']>();

	probe(): Promise<ISandboxBackendCapabilities> {
		this.capabilities ??= this.doProbe();
		return this.capabilities;
	}

	private async doProbe(): Promise<ISandboxBackendCapabilities> {
		const enforcement = allEnforcement('enforced');
		const notes: ISandboxBackendCapabilities['notes'] = {
			'process.tree': 'No PID namespace: the run is a process group plus its descendants and tagged processes. A process that double-forks, calls setsid and clears its environment outlives the kill, still sandboxed.',
			'limits.processes': 'RLIMIT_NPROC counts every process of the user on macOS, so it cannot cap one sandbox.',
			'limits.memory': 'macOS does not enforce RLIMIT_AS or RLIMIT_RSS.',
			'syscalls': 'Seatbelt mediates operations (files, mach services, IOKit, sysctl), not raw system calls.',
		};
		enforcement['process.tree'] = 'partial';
		enforcement['limits.processes'] = 'unsupported';
		enforcement['limits.memory'] = 'unsupported';
		enforcement['syscalls'] = 'partial';
		if (!existsSync(SANDBOX_EXEC_PATH)) {
			return { backend: 'seatbelt', available: false, enforcement: allEnforcement('unsupported'), notes, details: [], diagnostics: [`${SANDBOX_EXEC_PATH} is missing.`] };
		}
		// A real trial: a deny-default profile must start a process and keep it from writing.
		const profile = '(version 1)(deny default)(allow process-exec process-fork)(allow file-read* (literal "/") (subpath "/usr") (subpath "/System") (subpath "/bin"))(allow file-read-metadata)';
		try {
			await execFileAsync(SANDBOX_EXEC_PATH, ['-p', profile, '/usr/bin/true'], { timeout: 10_000 });
		} catch (err) {
			return { backend: 'seatbelt', available: false, enforcement: allEnforcement('unsupported'), notes, details: [], diagnostics: [`sandbox-exec could not start a sandboxed process: ${(err as Error).message}`] };
		}
		const escaped = await execFileAsync(SANDBOX_EXEC_PATH, ['-p', profile, '/usr/bin/touch', '/private/tmp/.volt-sandbox-probe'], { timeout: 10_000 }).then(() => true, () => false);
		if (escaped) {
			return { backend: 'seatbelt', available: false, enforcement: allEnforcement('unsupported'), notes, details: [], diagnostics: ['A trial sandbox could write outside its policy; Seatbelt is not enforcing.'] };
		}
		const version = await execFileAsync('/usr/bin/sw_vers', ['-productVersion']).then(r => r.stdout.trim(), () => 'unknown');
		return { backend: 'seatbelt', available: true, enforcement, notes, details: [`macOS ${version}`, `${SANDBOX_EXEC_PATH}`], diagnostics: [] };
	}

	async launch(policy: IResolvedSandboxPolicy, command: string, args: readonly string[], options: ISandboxLaunchOptions): Promise<ISandboxLaunchSpec> {
		const capabilities = await this.probe();
		if (!capabilities.available) {
			throw new SandboxUnavailableError(`macOS sandbox unavailable: ${capabilities.diagnostics.join(' ')}`, 'unavailable', [], capabilities.diagnostics);
		}
		let profile: string;
		try {
			profile = buildSeatbeltProfile(policy, { tag: options.tag, proxyPort: options.proxyPort });
		} catch (err) {
			throw new SandboxUnavailableError((err as Error).message, 'unavailable');
		}
		const limit = (value: number | undefined, scale = 1) => value === undefined ? '-' : String(Math.max(1, Math.floor(value * scale)));
		// `ulimit -f` counts 1024-byte blocks in macOS /bin/sh (measured: 2048 blocks allowed a 2 MB file).
		const prologueArgs = [limit(policy.limits.cpuSeconds), limit(policy.limits.fileSizeMB, 1024), limit(policy.limits.openFiles)];
		this.listen(options.tag, options.onDenial);
		let watchdog: ChildProcess | undefined;
		let pgid: number | undefined;
		return {
			command: SANDBOX_EXEC_PATH,
			args: ['-p', profile, '--', '/bin/sh', '-c', SEATBELT_PROLOGUE, 'volt-sandbox', ...prologueArgs, command, ...args],
			env: { ...policy.env, VOLT_SANDBOX_TAG: options.tag },
			cwd: policy.cwd,
			extraStdio: ['pipe'],
			// fd 3: the prologue's ready line.
			extraStdioDirections: ['out'],
			confirm: child => {
				pgid = child.pid;
				if (pgid) {
					watchdog = spawn('/bin/sh', ['-c', WATCHDOG, 'volt-sandbox-watchdog', String(pgid)], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
					watchdog.on('error', () => undefined);
					watchdog.unref();
				}
				return confirmFromStatusPipe(child);
			},
			terminate: async child => {
				const target = child.pid ?? pgid;
				if (target) {
					await killRun(target, options.tag);
				}
			},
			dispose: async () => {
				// The run is over: the watchdog must not fire later at a recycled process group.
				watchdog?.kill('SIGKILL');
				watchdog = undefined;
				// Late denials of a process that just exited still arrive for a moment.
				setTimeout(() => this.unlisten(options.tag), 2_000);
			},
		};
	}

	// --- denials from the kernel log ------------------------------------------------------------

	private listen(tag: string, onDenial: ISandboxLaunchOptions['onDenial']): void {
		this.listeners.set(tag, onDenial);
		if (this.monitor) {
			return;
		}
		const child = spawn('/usr/bin/log', ['stream', '--style', 'ndjson', '--predicate', `eventMessage CONTAINS "${SEATBELT_TAG_PREFIX}"`], { stdio: ['ignore', 'pipe', 'ignore'] });
		this.monitor = child;
		let buffer = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			buffer += data;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const violation = parseSeatbeltLogLine(line);
				const listener = violation && this.listeners.get(violation.tag);
				const kind = violation && denialKindForOperation(violation.operation);
				if (violation && listener && kind) {
					listener({ kind: kind === 'launch' ? 'launch' : kind, target: violation.target, source: 'os', process: violation.process });
				}
			}
		});
		child.on('error', () => undefined);
		child.on('close', () => {
			if (this.monitor === child) {
				this.monitor = undefined;
			}
		});
	}

	private unlisten(tag: string): void {
		this.listeners.delete(tag);
		if (!this.listeners.size && this.monitor) {
			const monitor = this.monitor;
			this.monitor = undefined;
			monitor.kill();
		}
	}

	dispose(): void {
		this.monitor?.kill();
		this.monitor = undefined;
		this.listeners.clear();
	}
}

/** Waits for the prologue's marker on fd 3, or the launcher's failure. */
export function confirmFromStatusPipe(child: ChildProcess): Promise<SandboxConfirmation> {
	return new Promise(resolve => {
		const status = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
		let done = false;
		let text = '';
		let stderr = '';
		const finish = (result: SandboxConfirmation) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(result);
			}
		};
		const timer = setTimeout(() => finish({ ok: false, error: 'the sandbox did not confirm in time' }), CONFIRM_TIMEOUT_MS);
		child.stderr?.on('data', (data: Buffer | string) => { stderr = (stderr + data.toString()).slice(-2_000); });
		if (!status) {
			finish({ ok: false, error: 'no status pipe' });
			return;
		}
		status.on('data', (data: Buffer | string) => {
			text += data.toString();
			const match = /volt-sandbox-ready (\d+)/.exec(text);
			if (match) {
				finish({ ok: true, detail: `Seatbelt applied (pid ${match[1]})` });
			}
		});
		status.on('error', () => undefined);
		child.once('exit', (code, signal) => setTimeout(() => finish({ ok: false, error: `sandbox-exec exited before the workload started (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}` }), 50));
	});
}

/**
 * Kills a run: its process group, every descendant reachable through parent pids (including
 * ones that moved to their own group or session), and any process still carrying the run's tag.
 */
export async function killRun(pgid: number, tag: string): Promise<void> {
	const kill = (pid: number, group = false) => {
		try {
			process.kill(group ? -pid : pid, 'SIGKILL');
		} catch {
			// Gone already.
		}
	};
	// Snapshot the tree first: once the root dies, its children are reparented and lose the link.
	// One scan gives parents, groups and environments (the tag).
	const table = await processTable(tag);
	kill(pgid, true);
	const children = new Map<number, number[]>();
	for (const row of table) {
		const list = children.get(row.ppid) ?? [];
		list.push(row.pid);
		children.set(row.ppid, list);
	}
	const doomed = new Set<number>(table.filter(row => row.pgid === pgid).map(row => row.pid));
	const queue = [pgid, ...doomed];
	while (queue.length) {
		const pid = queue.pop()!;
		for (const child of children.get(pid) ?? []) {
			if (!doomed.has(child)) {
				doomed.add(child);
				queue.push(child);
			}
		}
	}
	for (const row of table) {
		// Still carrying the run's tag: started inside it and moved away (setsid), env kept.
		if (row.tagged) {
			doomed.add(row.pid);
		}
	}
	for (const pid of doomed) {
		if (pid !== process.pid) {
			kill(pid);
		}
	}
}

interface IProcessRow { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly tagged: boolean }

/** Every process: pid, parent, group, and whether its environment holds `VOLT_SANDBOX_TAG=<tag>` (visible for this user's processes). */
async function processTable(tag: string): Promise<IProcessRow[]> {
	const needle = /^[a-f0-9]{8,64}$/.test(tag) ? `VOLT_SANDBOX_TAG=${tag}` : undefined;
	try {
		const { stdout } = await execFileAsync('/bin/ps', ['-E', '-ww', '-axo', 'pid=,ppid=,pgid=,command='], { timeout: 5_000, maxBuffer: 64 * 1024 * 1024 });
		const rows: IProcessRow[] = [];
		for (const line of stdout.split('\n')) {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
			if (match) {
				rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tagged: !!needle && match[4].includes(needle) });
			}
		}
		return rows;
	} catch {
		return [];
	}
}
