/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where Volt's transpiled sources are in a checkout of the Volt repository (`apps/relay/src/runner` → `out`). */
const CHECKOUT_OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'out');
const LAUNCHER = 'vs/platform/voltSandbox/node/sandboxLauncher.js';

/** Volt's provider id for each agent the runner drives: picks the agent's state folders and API hosts in its sandbox profile. */
const PROVIDERS = { claude: 'claude-code', codex: 'codex' };

/**
 * Volt's OS sandbox for a task's agent (05-limitations item 20): the launcher Volt starts a sandboxed
 * chat's agent CLI with (`VoltSandboxLauncher`: Seatbelt on macOS, bubblewrap on Linux), loaded from a
 * Volt build's transpiled sources. The agent then writes only the task's checkout, temp and its own
 * state; reads the system, its toolchains, the checkout and its own config, never the rest of the
 * home folder (the runner's token and data) or credential folders; and can't write files that run
 * code outside the sandbox (git hooks and config, editor tasks, agent hooks). The network stays on:
 * tasks install packages and the agent reaches its API. The container, when there is one, stays the
 * outer boundary.
 *
 * `VOLT_RUNNER_SANDBOX`: `auto` (default) uses it where it loads and the OS can give it, else runs the
 * agent as before and says so in the task's log; `required` refuses to start without it; `off` never
 * uses it. `VOLT_RUNNER_SANDBOX_OUT`: a Volt build's `out` folder (default: the checkout's own).
 *
 * Returns `{ mode, sandbox }` with `sandbox` undefined and `reason` set when there is none.
 */
export async function loadRunnerSandbox({ env = process.env, platform = process.platform, dataDir, log = () => undefined, importModule = specifier => import(specifier) } = {}) {
	const mode = runnerSandboxMode(env);
	if (mode === 'off') {
		return { mode, reason: 'VOLT_RUNNER_SANDBOX=off' };
	}
	if (platform === 'win32') {
		return { mode, reason: 'Windows has no sandbox the runner can apply' };
	}
	const outDir = path.resolve(env.VOLT_RUNNER_SANDBOX_OUT || CHECKOUT_OUT);
	if (!fs.existsSync(path.join(outDir, LAUNCHER))) {
		return { mode, reason: `no Volt build with its sandbox at ${outDir} (set VOLT_RUNNER_SANDBOX_OUT to a Volt checkout's out folder)` };
	}
	try {
		// As Volt's bootstrap sets it: the macOS backend finds its helper from the build's root.
		globalThis._VSCODE_FILE_ROOT ??= outDir;
		const { VoltSandboxLauncher } = await importModule(pathToFileURL(path.join(outDir, LAUNCHER)).href);
		// Volt's user data, never readable by a sandboxed agent: the runner's own folder for it.
		const stateDir = path.join(dataDir, 'sandbox');
		fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const launcher = new VoltSandboxLauncher(stateDir, { info: message => log(message), warn: message => log(message), error: message => log(message), trace: () => undefined, debug: () => undefined });
		const support = await launcher.getSupport();
		if (!support.filesystem) {
			launcher.dispose();
			return { mode, reason: support.detail || 'this machine cannot give the agent Volt\'s sandbox' };
		}
		return { mode, sandbox: new RunnerSandbox(launcher, support) };
	} catch (err) {
		return { mode, reason: `Volt's sandbox did not load: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export function runnerSandboxMode(env = process.env) {
	const value = String(env.VOLT_RUNNER_SANDBOX ?? '').trim().toLowerCase();
	return value === 'off' || value === '0' || value === 'false' ? 'off' : value === 'required' || value === 'require' ? 'required' : 'auto';
}

/** One task's agent in Volt's sandbox. */
export class RunnerSandbox {

	constructor(launcher, support) {
		this.launcher = launcher;
		this.support = support;
	}

	/** `seatbelt` or `bubblewrap`: what the heartbeat reports. */
	get mechanism() {
		return this.support.mechanism;
	}

	get detail() {
		return this.support.detail;
	}

	/**
	 * The launch for `binary args` of `agent` with `checkout` as its only workspace. `hostEnv` is the
	 * allow-listed environment the sandbox profile filters again; `env` is what the runner sets on
	 * purpose (the agent's credentials, the task id). The agent's own config folder gets a copy per
	 * task, so it can save its state without writing the operator's.
	 */
	prepare({ taskId, agent, binary, args, checkout, hostEnv, env }) {
		return this.launcher.prepare(binary, args, {
			level: 'workspace-write',
			network: true,
			providerId: PROVIDERS[agent] ?? agent,
			workspaceRoots: [checkout],
			stateKey: `runner-${taskId}`,
		}, { cwd: checkout, hostEnv, env, label: `${agent} task ${taskId}` });
	}

	async shutdown() {
		await this.launcher.shutdown?.().catch(() => undefined);
		this.launcher.dispose();
	}
}
