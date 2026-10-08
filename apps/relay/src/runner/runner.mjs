/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AGENTS, detectAgents, parseAgentLine } from './agents.mjs';
import { LoadSampler } from './load.mjs';

const VERSION = '0.1.0';

/**
 * A Volt runner: joins a relay, reports its load and agent CLIs every few seconds, claims cloud
 * tasks, checks the code out (a git URL, or a git bundle Volt uploaded for unpushed work), runs
 * the agent headlessly, streams what it does, and hands back the result as a git bundle plus a
 * patch (and a pushed branch when it may push). Every connection is outbound.
 */
export class Runner {

	constructor(config) {
		this.config = {
			name: os.hostname(),
			maxParallel: 1,
			heartbeatMs: 5_000,
			taskTimeoutMs: 30 * 60_000,
			labels: [],
			...config,
		};
		this.relay = this.config.relayUrl.replace(/\/+$/, '');
		this.sampler = new LoadSampler();
		this.active = new Map();
		this.stopped = false;
		this.slotWaiters = [];
	}

	log(...args) {
		console.log(`[runner ${this.config.name}]`, ...args);
	}

	async start() {
		await fsp.mkdir(this.config.dataDir, { recursive: true });
		await fsp.mkdir(this.config.workDir, { recursive: true });
		this.token = await this.ensureToken();
		this.agents = await detectAgents();
		this.gitPush = await this.canPush();
		this.log('agents', JSON.stringify(this.agents));
		this.sampler.sample();
		await this.heartbeat().catch(err => this.log('first heartbeat failed:', err.message));
		this.heartbeatTimer = setInterval(() => void this.heartbeat().catch(err => this.log('heartbeat failed:', err.message)), this.config.heartbeatMs);
		// Credentials can be added while the runner runs (a token file mounted later): look again now and then.
		this.detectTimer = setInterval(() => void detectAgents().then(agents => this.agents = agents), 60_000);
		void this.claimLoop();
	}

	async stop() {
		this.stopped = true;
		clearInterval(this.heartbeatTimer);
		clearInterval(this.detectTimer);
		for (const job of this.active.values()) {
			job.abort('Runner stopped.');
		}
	}

	//#region Relay

	async api(method, route, body, options = {}) {
		const response = await fetch(`${this.relay}/api${route}`, {
			method,
			headers: {
				...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
				...(body !== undefined && !options.raw ? { 'content-type': 'application/json' } : {}),
			},
			body: body === undefined ? undefined : options.raw ? body : JSON.stringify(body),
			...(options.raw ? { duplex: 'half' } : {}),
			signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
		});
		const text = await response.text();
		const value = text ? JSON.parse(text) : {};
		if (!response.ok) {
			const err = new Error(value.error ?? `${response.status} ${response.statusText}`);
			err.status = response.status;
			throw err;
		}
		return value;
	}

	/** A saved token, else pair with a one-time code or the relay's enrollment key. */
	async ensureToken() {
		if (this.config.token) {
			return this.config.token;
		}
		const file = path.join(this.config.dataDir, 'token');
		try {
			return (await fsp.readFile(file, 'utf8')).trim();
		} catch {
			// Not paired yet.
		}
		if (!this.config.pairingCode && !this.config.enrollKey) {
			throw new Error('Not paired: set VOLT_RELAY_TOKEN, VOLT_RELAY_PAIRING_CODE (from `volt-relay pair --runner`) or VOLT_RELAY_ENROLL_KEY.');
		}
		const machineFile = path.join(this.config.dataDir, 'machine-id');
		let machineId;
		try {
			machineId = (await fsp.readFile(machineFile, 'utf8')).trim();
		} catch {
			machineId = `m-${crypto.randomBytes(8).toString('hex')}`;
			await fsp.writeFile(machineFile, machineId);
		}
		const result = await this.api('POST', '/pair', {
			kind: 'runner',
			name: this.config.name,
			machineId,
			...(this.config.pairingCode ? { code: this.config.pairingCode } : { enrollKey: this.config.enrollKey }),
		});
		await fsp.writeFile(file, result.token, { mode: 0o600 });
		this.log(`paired with ${this.relay} as ${result.device.id}`);
		return result.token;
	}

	async heartbeat() {
		const load = this.sampler.sample();
		const response = await this.api('POST', '/heartbeat', {
			name: this.config.name,
			version: VERSION,
			load: { ...load, running: this.active.size, slots: Math.max(0, this.config.maxParallel - this.active.size), ...this.config.extraLoad?.() },
			caps: {
				agents: this.agents,
				maxParallel: this.config.maxParallel,
				os: `${os.platform()}`,
				arch: os.arch(),
				gitPush: this.gitPush,
				labels: this.config.labels,
			},
			running: [...this.active.keys()],
		});
		for (const id of response.cancel ?? []) {
			this.active.get(id)?.abort('Cancelled from Volt.');
		}
	}

	async claimLoop() {
		let backoff = 1000;
		while (!this.stopped) {
			if (this.active.size >= this.config.maxParallel) {
				await new Promise(resolve => this.slotWaiters.push(resolve));
				continue;
			}
			try {
				const ready = Object.fromEntries(Object.entries(this.agents ?? {}).map(([name, agent]) => [name, agent.installed && agent.credentials]));
				const { task } = await this.api('POST', '/runner/claim?wait=25', { agents: ready }, { timeoutMs: 40_000 });
				backoff = 1000;
				if (task) {
					void this.runTask(task);
				}
			} catch (err) {
				if (this.stopped) {
					return;
				}
				this.log('claim failed:', err.message);
				await sleep(backoff);
				backoff = Math.min(30_000, backoff * 2);
			}
		}
	}

	//#endregion

	//#region Tasks

	async runTask(task) {
		const controller = new AbortController();
		let abortReason;
		const job = { abort: reason => { abortReason = reason; controller.abort(); } };
		this.active.set(task.id, job);
		const events = new EventBatch(this, task.id, () => job.abort('Cancelled from Volt.'));
		const dir = path.join(this.config.workDir, task.id);
		const repo = path.join(dir, 'repo');
		const short = task.id.replace(/^task_/, '').replace(/[^\w]/g, '').slice(0, 8).toLowerCase();
		const branch = `volt/cloud-${short}`;
		const signal = controller.signal;
		this.log(`task ${task.id}: ${task.title}`);
		try {
			const agent = AGENTS[task.agent];
			if (!agent || !this.agents?.[task.agent]?.installed) {
				throw new Error(`${task.agent} is not installed on ${this.config.name}.`);
			}
			events.push({ t: 'status', status: 'preparing', progress: 'Getting the code' });
			await fsp.rm(dir, { recursive: true, force: true });
			await fsp.mkdir(dir, { recursive: true });
			const base = await this.checkout(task, dir, repo, signal, events);
			await git(repo, ['checkout', '-q', '-b', branch, base], signal);
			await git(repo, ['config', 'user.name', process.env.VOLT_RUNNER_GIT_NAME || 'Volt Runner'], signal);
			await git(repo, ['config', 'user.email', process.env.VOLT_RUNNER_GIT_EMAIL || 'runner@volt.local'], signal);
			let start = base;
			if (task.source.patchBlob) {
				events.push({ t: 'log', stream: 'system', text: 'Applying uncommitted changes from Volt.' });
				const patch = path.join(dir, 'source.patch');
				await this.download(task.source.patchBlob, patch, signal);
				await git(repo, ['apply', '--index', '--whitespace=nowarn', patch], signal);
				await git(repo, ['commit', '-q', '--allow-empty', '-m', `Uncommitted changes from ${task.origin?.deviceName ?? 'Volt'}`], signal);
				start = (await git(repo, ['rev-parse', 'HEAD'], signal)).trim();
			}

			events.push({ t: 'status', status: 'running', progress: `Running ${agent.label}` });
			const state = {};
			const exit = await this.runAgent(task, agent, repo, signal, events, state);
			if (signal.aborted) {
				throw new Error(abortReason ?? 'Cancelled.');
			}

			events.push({ t: 'status', status: 'finishing', progress: 'Collecting changes' });
			await git(repo, ['add', '-A'], signal);
			const staged = await git(repo, ['diff', '--cached', '--quiet'], signal).then(() => false, () => true);
			if (staged) {
				await git(repo, ['commit', '-q', '-m', `${task.title}\n\nCloud task ${task.id} on ${this.config.name}.`], signal);
			}
			const head = (await git(repo, ['rev-parse', 'HEAD'], signal)).trim();
			const result = { branch, baseCommit: start, headCommit: head, summary: state.summary, noChanges: head === start };
			if (!result.noChanges) {
				const numstat = await git(repo, ['diff', '--numstat', start, head], signal);
				result.files = numstat.split('\n').filter(Boolean).map(line => {
					const [insertions, deletions, ...rest] = line.split('\t');
					return { path: rest.join('\t'), insertions: Number(insertions) || 0, deletions: Number(deletions) || 0 };
				});
				result.stats = {
					files: result.files.length,
					insertions: result.files.reduce((sum, file) => sum + file.insertions, 0),
					deletions: result.files.reduce((sum, file) => sum + file.deletions, 0),
				};
				// The bundle's prerequisite is the commit Volt sent, which the local repo has.
				const bundle = path.join(dir, 'result.bundle');
				const range = base === head ? branch : `${base}..${branch}`;
				await git(repo, ['bundle', 'create', bundle, range], signal);
				result.bundleBlob = (await this.upload(bundle, 'result-bundle', task.id)).id;
				const patch = path.join(dir, 'result.patch');
				await fsp.writeFile(patch, await git(repo, ['diff', '--binary', start, head], signal));
				result.patchBlob = (await this.upload(patch, 'result-patch', task.id)).id;
				if (task.push && task.source.repoUrl && this.gitPush) {
					try {
						await git(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], signal);
						result.pushed = { remote: task.source.repoUrl, branch };
					} catch (err) {
						events.push({ t: 'log', stream: 'stderr', text: `Push failed: ${err.message}` });
					}
				}
			}
			await events.flush();
			const failed = exit !== 0 || state.failed;
			await this.api('POST', `/runner/tasks/${task.id}/complete`, {
				status: failed && result.noChanges ? 'failed' : 'succeeded',
				result,
				...(failed ? { error: state.error ?? `${agent.label} exited with code ${exit}.` } : {}),
			});
			this.log(`task ${task.id} done: ${result.noChanges ? 'no changes' : `${result.stats.files} files`}`);
		} catch (err) {
			await events.flush().catch(() => undefined);
			const cancelled = signal.aborted;
			this.log(`task ${task.id} ${cancelled ? 'cancelled' : 'failed'}:`, err.message);
			await this.api('POST', `/runner/tasks/${task.id}/complete`, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? (abortReason ?? 'Cancelled.') : err.message }).catch(e => this.log('could not report the failure:', e.message));
		} finally {
			events.close();
			this.active.delete(task.id);
			this.slotWaiters.splice(0).forEach(resolve => resolve());
			if (!process.env.VOLT_RUNNER_KEEP_WORK) {
				await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
			}
		}
	}

	/** Clones the task's code and returns the commit to start from. */
	async checkout(task, dir, repo, signal, events) {
		const source = task.source;
		if (source.repoUrl) {
			events.push({ t: 'log', stream: 'system', text: `Cloning ${redactUrl(source.repoUrl)}` });
			await git(dir, ['clone', '-q', '--no-checkout', source.repoUrl, repo], signal, 10 * 60_000);
		}
		if (source.bundleBlob) {
			const bundle = path.join(dir, 'source.bundle');
			events.push({ t: 'log', stream: 'system', text: 'Downloading the code Volt uploaded' });
			await this.download(source.bundleBlob, bundle, signal);
			if (source.repoUrl) {
				await git(repo, ['fetch', '-q', bundle, '+refs/*:refs/volt-source/*'], signal);
			} else {
				await git(dir, ['clone', '-q', '--no-checkout', bundle, repo], signal);
			}
		}
		const base = source.baseCommit || (await git(repo, ['rev-parse', 'HEAD'], signal)).trim();
		await git(repo, ['checkout', '-q', '--detach', base], signal);
		events.push({ t: 'log', stream: 'system', text: `Checked out ${base.slice(0, 10)}${source.baseBranch ? ` (${source.baseBranch})` : ''}` });
		return base;
	}

	runAgent(task, agent, cwd, signal, events, state) {
		const { args, env } = agent.command(task);
		return new Promise((resolve, reject) => {
			const child = spawn(agent.binary(), args, {
				cwd,
				env: { ...process.env, ...env, VOLT_CLOUD_TASK: task.id, CI: '1' },
				stdio: ['pipe', 'pipe', 'pipe'],
				detached: true,
			});
			const kill = () => {
				try {
					process.kill(-child.pid, 'SIGTERM');
				} catch {
					child.kill('SIGTERM');
				}
			};
			signal.addEventListener('abort', kill, { once: true });
			const timeout = setTimeout(() => {
				state.failed = true;
				state.error = `Stopped after ${Math.round(this.config.taskTimeoutMs / 60_000)} minutes.`;
				kill();
			}, this.config.taskTimeoutMs);
			child.stdin.end(`${task.prompt}\n`);
			let buffer = '';
			child.stdout.on('data', chunk => {
				buffer += chunk.toString('utf8');
				let index;
				while ((index = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					for (const event of parseAgentLine(task.agent, line, state)) {
						events.push(event);
					}
				}
			});
			let stderr = '';
			child.stderr.on('data', chunk => {
				const text = chunk.toString('utf8');
				stderr = (stderr + text).slice(-4000);
				events.push({ t: 'log', stream: 'stderr', text });
			});
			child.on('error', err => {
				clearTimeout(timeout);
				reject(err);
			});
			child.on('close', code => {
				clearTimeout(timeout);
				signal.removeEventListener('abort', kill);
				if (buffer.trim()) {
					for (const event of parseAgentLine(task.agent, buffer, state)) {
						events.push(event);
					}
				}
				if (code !== 0 && !state.error) {
					state.error = stderr.trim().split('\n').slice(-3).join('\n') || undefined;
				}
				resolve(code ?? 1);
			});
		});
	}

	async download(blobId, file, signal) {
		const response = await fetch(`${this.relay}/api/blobs/${blobId}`, { headers: { authorization: `Bearer ${this.token}` }, signal });
		if (!response.ok || !response.body) {
			throw new Error(`Could not download ${blobId}: ${response.status}`);
		}
		await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
	}

	async upload(file, kind, taskId) {
		const stat = await fsp.stat(file);
		return this.api('PUT', `/blobs?kind=${encodeURIComponent(kind)}&task=${encodeURIComponent(taskId)}`, fs.createReadStream(file), { raw: true, timeoutMs: 10 * 60_000, size: stat.size });
	}

	/** Pushing needs credentials the operator set up (a token in the URL, a credential helper or SSH key). */
	async canPush() {
		return process.env.VOLT_RUNNER_GIT_PUSH === '1';
	}

	//#endregion
}

/** Batches log events into one request every 400 ms; a `cancel` answer aborts the task. */
class EventBatch {

	constructor(runner, taskId, onCancel) {
		this.runner = runner;
		this.taskId = taskId;
		this.onCancel = onCancel;
		this.queue = [];
		this.sending = Promise.resolve();
		this.timer = setInterval(() => void this.flush(), 400);
	}

	push(event) {
		this.queue.push({ at: Date.now(), ...event });
		if (event.t === 'status') {
			void this.flush();
		}
	}

	flush() {
		this.sending = this.sending.then(async () => {
			if (!this.queue.length) {
				return;
			}
			const events = this.queue.splice(0);
			try {
				const response = await this.runner.api('POST', `/runner/tasks/${this.taskId}/events`, { events });
				if (response.cancel) {
					this.onCancel();
				}
			} catch (err) {
				if (err.status === 409) {
					this.onCancel();
				} else {
					// Keep them for the next try; the relay may be restarting.
					this.queue.unshift(...events);
				}
			}
		});
		return this.sending;
	}

	close() {
		clearInterval(this.timer);
	}
}

function git(cwd, args, signal, timeout = 5 * 60_000) {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, signal, timeout, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 800)}`));
			} else {
				resolve(String(stdout));
			}
		});
	});
}

function redactUrl(url) {
	return String(url).replace(/\/\/[^@/]+@/, '//***@');
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
