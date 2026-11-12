/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { isAbsolute, join, resolve } from '../../../base/common/path.js';
import { gitSubcommand, hostGitArgs, hostGitArgsError, hostGitEnv, hostGitEnvError, hostGitLayoutError, IGitLayout, IHostGitRequest, IHostGitResult, isRemoteGitCommand } from '../common/hostGit.js';
import { BuildEntryGuard, buildEntryGuard } from './buildEntryGuard.js';
import { withWorkingGitOnPath } from './gitExecutable.js';

/**
 * HostGit (see `common/hostGit.ts`): the one way Volt runs git on the host. `prepareHostGit`
 * checks the repository and returns what to spawn, for callers that stream output (clone
 * progress); `runHostGit` runs it and collects the output. A refusal is never retried without the
 * guards: the call fails and says why.
 */

export class HostGitRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostGitRefusedError';
	}
}

export interface IHostGitOptions {
	/** The environment git starts from: the user's. Default: this process's. */
	readonly baseEnv?: Readonly<Record<string, string | undefined>>;
	/** Default: the shared guard under `~/.volt/trust`. */
	readonly guard?: BuildEntryGuard;
	readonly platform?: NodeJS.Platform;
}

export interface IHostGitInvocation {
	readonly file: string;
	readonly args: readonly string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
}

/** A path no process can create a hook in: `/dev/null` is not a folder, and System32 is not writable. */
function noHooksPath(platform: string): string {
	return platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'volt-no-hooks') : '/dev/null';
}

/**
 * Calls for one folder that start while its check runs (the git graph's burst) share that check.
 * Nothing is cached past it: a result kept longer would be a window for a planted `commondir`.
 */
const layouts = new Map<string, Promise<IGitLayout | undefined>>();

function execGit(args: readonly string[], cwd: string, env: Record<string, string>, timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise(done => {
		execFile('git', [...args], { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
			const code = !err ? 0 : typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : null;
			done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
		});
	});
}

/** `--git-dir`/`--work-tree` for a private snapshot repository (the request's `gitDir`). */
function explicitRepository(request: IHostGitRequest): string[] {
	return request.gitDir ? [`--git-dir=${request.gitDir}`, `--work-tree=${request.cwd}`] : [];
}

/** Where git finds the repository for `cwd`, as real paths; undefined when it is not in one. */
async function gitLayout(cwd: string, env: Record<string, string>, explicit: readonly string[]): Promise<IGitLayout | undefined> {
	const guard = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooksPath(process.platform)}`, '-c', 'protocol.ext.allow=never', ...explicit];
	let result = await execGit([...guard, 'rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], cwd, env);
	let bare = false;
	if (result.code !== 0 && /must be run in a work tree/i.test(result.stderr)) {
		bare = true;
		result = await execGit([...guard, 'rev-parse', '--git-dir', '--git-common-dir'], cwd, env);
	}
	if (result.code !== 0) {
		return undefined;
	}
	const [gitDir, commonDir, toplevel] = result.stdout.split(/\r?\n/).map(line => line.trim());
	if (!gitDir || !commonDir) {
		return undefined;
	}
	const real = (path: string) => fs.realpath(isAbsolute(path) ? path : resolve(cwd, path)).catch(() => resolve(cwd, path));
	let dotGit: string | undefined;
	if (explicit.length) {
		dotGit = await real(explicit[0].slice('--git-dir='.length));
	} else if (!bare && toplevel) {
		const entry = join(toplevel, '.git');
		const st = await fs.stat(entry).catch(() => undefined);
		const pointer = st?.isFile() ? /^gitdir:\s*(.+)$/m.exec(await fs.readFile(entry, 'utf8').catch(() => ''))?.[1]?.trim() : undefined;
		dotGit = st?.isDirectory() ? await real(entry) : pointer ? await real(resolve(toplevel, pointer)) : undefined;
	}
	return {
		gitDir: await real(gitDir),
		commonDir: await real(commonDir),
		...(!bare && toplevel ? { toplevel: await real(toplevel) } : {}),
		...(dotGit ? { dotGit } : {}),
	};
}

function sharedLayout(cwd: string, env: Record<string, string>, explicit: readonly string[]): Promise<IGitLayout | undefined> {
	const key = `${cwd}\0${env.PATH ?? ''}\0${explicit.join('\0')}`;
	const running = layouts.get(key);
	if (running) {
		return running;
	}
	const value = gitLayout(cwd, env, explicit).finally(() => layouts.delete(key));
	layouts.set(key, value);
	return value;
}

/** The user's own `core.sshCommand` (global config), so Volt's override keeps it; `ssh` otherwise. */
let sshCommand: { readonly at: number; readonly value: Promise<string> } | undefined;
/** The system config's credential helpers, which `GIT_CONFIG_NOSYSTEM` would drop for pushes and fetches. */
let systemHelpers: { readonly at: number; readonly value: Promise<string[]> } | undefined;
const SETTINGS_TTL_MS = 60_000;

function userSshCommand(env: Record<string, string>): Promise<string> {
	if (!sshCommand || Date.now() - sshCommand.at > SETTINGS_TTL_MS) {
		sshCommand = { at: Date.now(), value: execGit(['config', '--global', '--get', 'core.sshCommand'], process.cwd(), env).then(r => r.code === 0 && r.stdout.trim() ? r.stdout.trim() : 'ssh') };
	}
	return sshCommand.value;
}

function systemCredentialHelpers(env: Record<string, string>, platform: string): Promise<string[]> {
	if (platform === 'win32') {
		return Promise.resolve([]);
	}
	if (!systemHelpers || Date.now() - systemHelpers.at > SETTINGS_TTL_MS) {
		const { GIT_CONFIG_NOSYSTEM: _drop, ...withSystem } = env;
		systemHelpers = { at: Date.now(), value: execGit(['config', '--system', '--get-all', 'credential.helper'], process.cwd(), withSystem).then(r => r.code === 0 ? r.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : []) };
	}
	return systemHelpers.value;
}

/** Changes the guard holds for this repository that point git at other objects or another folder. */
const REDIRECTS = /\/(?:objects\/info\/(?:http-)?alternates|commondir|gitdir)$/;

/**
 * Checks the repository and builds the command. Throws `HostGitRefusedError` when the repository
 * is not one git made on its own (a planted `commondir`), when a file that redirects git changed
 * while a sandboxed writer worked here, or when the user's hooks were asked for while a hook or
 * git config change is unreviewed.
 */
export async function prepareHostGit(request: IHostGitRequest, options: IHostGitOptions = {}): Promise<IHostGitInvocation> {
	const platform = options.platform ?? process.platform;
	const argsError = hostGitArgsError(request.args) ?? hostGitEnvError(request.env);
	if (argsError) {
		throw new HostGitRefusedError(argsError);
	}
	const base = await withWorkingGitOnPath({ ...(options.baseEnv ?? process.env) });
	const env = hostGitEnv(base, request.env, platform);
	const explicit = explicitRepository(request);
	const layout = await sharedLayout(request.cwd, env, explicit);
	if (layout) {
		const fold = platform === 'darwin' || platform === 'win32';
		const error = hostGitLayoutError(layout, request.expectedRoots, fold);
		if (error) {
			throw new HostGitRefusedError(`Volt did not run git here: ${error}. A sandboxed agent may have redirected this repository; check its .git folder.`);
		}
		if (layout.toplevel) {
			const changes = await (options.guard ?? buildEntryGuard()).changes(layout.toplevel);
			const redirect = changes.find(change => REDIRECTS.test(change.path.replace(/\\/g, '/')));
			if (redirect) {
				throw new HostGitRefusedError(`Volt did not run git here: ${redirect.path} ${redirect.kind === 'added' ? 'appeared' : 'changed'} while a sandboxed agent worked in ${layout.toplevel}. Review it before Volt runs git there again.`);
			}
			if (request.hooks === 'user' && changes.some(change => change.group === 'git')) {
				throw new HostGitRefusedError(`git hooks or config changed in ${layout.toplevel} since an agent worked there; review them before Volt runs your hooks.`);
			}
		}
	}
	const remote = isRemoteGitCommand(request.args);
	const hasSsh = !!env.GIT_SSH_COMMAND || !!env.GIT_SSH;
	const args = hostGitArgs([...explicit, ...request.args], {
		hooksPath: request.hooks === 'user' ? undefined : noHooksPath(platform),
		...(remote && !hasSsh ? { sshCommand: await userSshCommand(env) } : {}),
		...(remote ? { credentialHelpers: await systemCredentialHelpers(env, platform) } : {}),
	});
	return { file: 'git', args, env, cwd: request.cwd };
}

/** Runs git through HostGit and collects its output. Never throws; a refusal is `refused: true`. */
export async function runHostGit(request: IHostGitRequest, options: IHostGitOptions = {}, onSpawn?: (child: ChildProcess) => void): Promise<IHostGitResult> {
	let invocation: IHostGitInvocation;
	try {
		invocation = await prepareHostGit(request, options);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: null, stdout: '', stderr: message, error: message, refused: err instanceof HostGitRefusedError };
	}
	const maxBytes = request.maxBytes ?? 64 * 1024 * 1024;
	return new Promise<IHostGitResult>(done => {
		let settled = false;
		const finish = (result: IHostGitResult) => {
			if (!settled) {
				settled = true;
				done(result);
			}
		};
		let child: ChildProcess;
		try {
			child = spawn(invocation.file, [...invocation.args], { cwd: invocation.cwd, env: invocation.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (err) {
			finish({ exitCode: null, stdout: '', stderr: '', error: String(err) });
			return;
		}
		onSpawn?.(child);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let sizes = [0, 0];
		let failure: string | undefined;
		let timedOut = false;
		const timer = request.timeoutMs ? setTimeout(() => {
			timedOut = true;
			failure = `timed out after ${request.timeoutMs} ms`;
			child.kill('SIGKILL');
		}, request.timeoutMs) : undefined;
		const collect = (into: Buffer[], index: number) => (chunk: Buffer) => {
			sizes = index === 0 ? [sizes[0] + chunk.length, sizes[1]] : [sizes[0], sizes[1] + chunk.length];
			if (sizes[index] > maxBytes) {
				failure ??= `git ${gitSubcommand(request.args) ?? ''} printed more than ${maxBytes} bytes`;
				child.kill('SIGKILL');
				return;
			}
			into.push(chunk);
		};
		child.stdout!.on('data', collect(stdout, 0));
		child.stderr!.on('data', collect(stderr, 1));
		child.on('error', err => {
			clearTimeout(timer);
			finish({ exitCode: null, stdout: '', stderr: Buffer.concat(stderr).toString('utf8'), error: `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`.trim() });
		});
		child.on('close', code => {
			clearTimeout(timer);
			finish({
				exitCode: failure ? null : code,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
				...(failure ? { error: failure } : {}),
				...(timedOut ? { timedOut } : {}),
			});
		});
		child.stdin!.on('error', () => { /* the exit code reports it */ });
		child.stdin!.end(request.input);
	});
}
