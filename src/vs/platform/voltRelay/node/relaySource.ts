/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { withWorkingGitOnPath } from '../../voltGit/node/gitExecutable.js';
import { IVoltCloudSourceSummary, VoltCloudSourceMode } from '../common/voltRelay.js';

/**
 * The git side of cloud tasks, run in the user's repository: what to send (a git URL the runner
 * can clone when HEAD is pushed, else a bundle of HEAD; uncommitted and untracked changes as a
 * patch) and how a result comes back (the runner's bundle fetched into a private ref).
 */

export interface IGitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export async function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv, timeoutMs = 5 * 60_000): Promise<IGitResult> {
	const baseEnv = await withWorkingGitOnPath(process.env);
	return new Promise(resolve => {
		execFile('git', [...args], { cwd, env: { ...baseEnv, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) });
		});
	});
}

async function gitOk(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const result = await git(cwd, args, env);
	if (result.code !== 0) {
		throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
	}
	return result.stdout;
}

export interface IPreparedSource {
	readonly summary: IVoltCloudSourceSummary;
	/** Files to upload (deleted by `dispose`). */
	readonly bundleFile?: string;
	readonly patchFile?: string;
	dispose(): Promise<void>;
}

/** A remote a runner elsewhere can clone without the user's SSH keys: https, with no credentials in it. */
export function cloneableRemote(url: string | undefined): boolean {
	return !!url && /^https?:\/\//i.test(url) && !/\/\/[^/]*@/.test(url);
}

export async function prepareCloudSource(repoRoot: string, mode: VoltCloudSourceMode): Promise<IPreparedSource> {
	const top = (await gitOk(repoRoot, ['rev-parse', '--show-toplevel'])).trim();
	const head = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).stdout.trim();
	if (!head) {
		throw new Error('This repository has no commits yet. Make a first commit to run it in the cloud.');
	}
	const branch = (await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || undefined;
	const remote = (await git(top, ['remote', 'get-url', 'origin'])).stdout.trim() || undefined;
	const pushed = remote ? !!(await git(top, ['branch', '-r', '--contains', head])).stdout.trim() : false;
	const useRemote = mode === 'remote' || (mode === 'auto' && pushed && cloneableRemote(remote));
	if (mode === 'remote' && !remote) {
		throw new Error('This repository has no origin remote to clone from.');
	}

	const dir = join(tmpdir(), `volt-cloud-${generateUuid().slice(0, 8)}`);
	await fs.mkdir(dir, { recursive: true });
	const dispose = () => fs.rm(dir, { recursive: true, force: true });
	try {
		let bundleFile: string | undefined;
		if (!useRemote) {
			bundleFile = join(dir, 'source.bundle');
			if (branch) {
				await gitOk(top, ['bundle', 'create', bundleFile, 'HEAD', branch]);
			} else {
				// Detached: a bundle needs a branch to clone, so name the commit for a moment.
				const temp = `refs/heads/volt-cloud-source-${generateUuid().slice(0, 8)}`;
				await gitOk(top, ['update-ref', temp, head]);
				try {
					await gitOk(top, ['bundle', 'create', bundleFile, 'HEAD', temp]);
				} finally {
					await git(top, ['update-ref', '-d', temp]);
				}
			}
		}
		const patchFile = await uncommittedPatch(top, dir);
		const bundleBytes = bundleFile ? (await fs.stat(bundleFile)).size : undefined;
		return {
			summary: {
				mode: useRemote ? 'remote' : 'bundle',
				baseCommit: head,
				...(branch ? { baseBranch: branch } : {}),
				...(useRemote && remote ? { repoUrl: remote } : {}),
				dirty: !!patchFile,
				...(bundleBytes !== undefined ? { bundleBytes } : {}),
			},
			...(bundleFile ? { bundleFile } : {}),
			...(patchFile ? { patchFile } : {}),
			dispose,
		};
	} catch (err) {
		await dispose();
		throw err;
	}
}

/**
 * Staged, unstaged and untracked changes against HEAD, as one binary patch. A throwaway index
 * keeps the user's own staging untouched.
 */
async function uncommittedPatch(top: string, dir: string): Promise<string | undefined> {
	const status = (await gitOk(top, ['status', '--porcelain', '--untracked-files=all'])).trim();
	if (!status) {
		return undefined;
	}
	const env = { GIT_INDEX_FILE: join(dir, 'index') };
	await gitOk(top, ['read-tree', 'HEAD'], env);
	await gitOk(top, ['add', '-A'], env);
	const patch = await gitOk(top, ['diff', '--cached', '--binary', 'HEAD'], env);
	if (!patch.trim()) {
		return undefined;
	}
	const file = join(dir, 'source.patch');
	await fs.writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`);
	return file;
}

/** Fetches `branch` from a result bundle into `refs/volt-cloud/<taskId>`; returns its commit. */
export async function fetchResultBundle(repoRoot: string, bundleFile: string, branch: string, taskId: string): Promise<{ ref: string; commit: string }> {
	const safeId = taskId.replace(/[^\w.-]/g, '');
	const ref = `refs/volt-cloud/${safeId}`;
	const verify = await git(repoRoot, ['bundle', 'verify', bundleFile]);
	if (verify.code !== 0) {
		throw new Error(/lacks|prerequisite/i.test(verify.stderr)
			? 'This repository does not have the commit the task started from (was it made in another clone?).'
			: `The result bundle is not usable: ${verify.stderr.trim().slice(0, 300)}`);
	}
	await gitOk(repoRoot, ['fetch', '-q', '--no-tags', bundleFile, `+refs/heads/${branch}:${ref}`]);
	const commit = (await gitOk(repoRoot, ['rev-parse', ref])).trim();
	return { ref, commit };
}
