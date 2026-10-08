#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import os from 'node:os';
import path from 'node:path';
import { Runner } from '../src/runner/runner.mjs';

const env = process.env;
if (!env.VOLT_RELAY_URL || process.argv.includes('--help')) {
	console.log(`volt-runner — runs Volt cloud tasks for a relay

Environment:
  VOLT_RELAY_URL            the relay, e.g. https://relay.example.com (required)
  VOLT_RELAY_TOKEN          a runner token, or pair once with one of:
  VOLT_RELAY_PAIRING_CODE   from \`volt-relay pair --runner\`
  VOLT_RELAY_ENROLL_KEY     the relay's enrollment key
  VOLT_RUNNER_NAME          shown in Volt's machine picker (default: hostname)
  VOLT_RUNNER_DATA          token and machine id (default: ~/.volt-runner)
  VOLT_RUNNER_WORK          checkouts (default: <data>/work)
  VOLT_RUNNER_MAX_PARALLEL  tasks at once (default 1)
  VOLT_RUNNER_TIMEOUT_MIN   per task (default 30)
  VOLT_RUNNER_LABELS        comma separated, shown in Volt
  VOLT_RUNNER_GIT_PUSH=1    push result branches to the task's git remote
Agent credentials stay on this machine: CLAUDE_CODE_OAUTH_TOKEN(_FILE) / ANTHROPIC_API_KEY for
Claude Code, OPENAI_API_KEY or ~/.codex/auth.json for Codex.`);
	process.exit(env.VOLT_RELAY_URL ? 0 : 1);
}

const dataDir = path.resolve(env.VOLT_RUNNER_DATA ?? path.join(os.homedir(), '.volt-runner'));
const runner = new Runner({
	relayUrl: env.VOLT_RELAY_URL,
	token: env.VOLT_RELAY_TOKEN,
	pairingCode: env.VOLT_RELAY_PAIRING_CODE,
	enrollKey: env.VOLT_RELAY_ENROLL_KEY,
	name: env.VOLT_RUNNER_NAME ?? os.hostname(),
	dataDir,
	workDir: path.resolve(env.VOLT_RUNNER_WORK ?? path.join(dataDir, 'work')),
	maxParallel: Number(env.VOLT_RUNNER_MAX_PARALLEL ?? 1) || 1,
	taskTimeoutMs: (Number(env.VOLT_RUNNER_TIMEOUT_MIN ?? 30) || 30) * 60_000,
	labels: (env.VOLT_RUNNER_LABELS ?? '').split(',').map(label => label.trim()).filter(Boolean),
});

let started = false;
for (let attempt = 0; !started; attempt++) {
	try {
		await runner.start();
		started = true;
	} catch (err) {
		console.error(`[runner] could not start: ${err.message}`);
		if (/Not paired|pairing code|enrollment key/i.test(err.message)) {
			process.exit(1);
		}
		await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)));
	}
}
const stop = async () => {
	await runner.stop();
	setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
