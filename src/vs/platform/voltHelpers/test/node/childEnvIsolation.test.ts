/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { VoltStdioService } from '../../../voltStdio/node/voltStdioService.js';
import { isSecretLikeEnvName } from '../../common/childEnv.js';

/** What the main process carries that no child may: its IPC sockets, run-as-Node, and the user's secrets. */
const PLANTED: Record<string, string> = {
	VSCODE_IPC_HOOK: '/tmp/volt-test-main.sock',
	VSCODE_IPC_HOOK_CLI: '/tmp/volt-test-cli.sock',
	ELECTRON_RUN_AS_NODE: '1',
	VOLT_CANARY_API_KEY: 'canary-api-key',
	GITHUB_TOKEN: 'canary-github-token',
	AWS_SECRET_ACCESS_KEY: 'canary-aws',
	VOLT_CANARY_PLAIN: 'kept',
};

function envNames(output: string): Set<string> {
	return new Set(output.split('\n').map(line => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]).filter((name): name is string => !!name));
}

(process.platform === 'win32' ? suite.skip : suite)('Volt children never inherit the IPC socket or secrets (ENV-IPC-1, MAC-ENV-2)', function () {

	this.timeout(30_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const saved: Record<string, string | undefined> = {};
	let userData: string;

	setup(async () => {
		// VSCODE_CLI skips resolving a login shell: the test sees exactly the environment it planted.
		for (const [name, value] of Object.entries({ ...PLANTED, VSCODE_CLI: '1' })) {
			saved[name] = process.env[name];
			process.env[name] = value;
		}
		userData = join(tmpdir(), `volt-env-${generateUuid()}`);
		await fs.mkdir(userData, { recursive: true });
	});

	teardown(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		await fs.rm(userData, { recursive: true, force: true });
	});

	function assertClean(names: Set<string>, where: string): void {
		assert.ok(names.has('PATH'), `${where}: the child got no PATH, so the check saw no environment`);
		assert.ok(names.has('VOLT_CANARY_PLAIN'), `${where}: ordinary variables must still pass`);
		for (const name of names) {
			assert.ok(!/^VSCODE_IPC_HOOK/.test(name), `${where}: ${name} reached the child (ENV-IPC-1)`);
			assert.ok(!/^ELECTRON_/.test(name), `${where}: ${name} reached the child`);
			assert.ok(!isSecretLikeEnvName(name), `${where}: secret-looking ${name} reached the child (MAC-ENV-2)`);
		}
	}

	test('ENV-IPC-1 / MAC-ENV-2: commands, files and agent processes start without them', async () => {
		const stdio = store.add(new VoltStdioService(new NullLogService(), new TestConfigurationService(), userData));

		const exec = await stdio.exec({ id: generateUuid(), command: 'env', timeoutMs: 15_000 });
		assert.strictEqual(exec.exitCode, 0, exec.stderr);
		assertClean(envNames(exec.stdout), 'exec');

		const file = await stdio.execFile({ file: '/usr/bin/env', args: [], timeoutMs: 15_000 });
		assert.strictEqual(file.exitCode, 0, file.stderr);
		assertClean(envNames(file.stdout), 'execFile');

		let output = '';
		const exited = new Promise<void>(resolve => {
			store.add(stdio.onExit(() => resolve()));
		});
		store.add(stdio.onData(e => output += e.data));
		await stdio.spawn({ command: '/usr/bin/env', args: [] });
		await exited;
		// Output is flushed per tick: give the last chunk a moment.
		await new Promise(resolve => setTimeout(resolve, 50));
		assertClean(envNames(output), 'spawn');
	});

	test('a caller that needs a variable sets it on purpose', async () => {
		const stdio = store.add(new VoltStdioService(new NullLogService(), new TestConfigurationService(), userData));
		const exec = await stdio.exec({ id: generateUuid(), command: 'env', timeoutMs: 15_000, env: { ELECTRON_RUN_AS_NODE: '1' } });
		assert.ok(envNames(exec.stdout).has('ELECTRON_RUN_AS_NODE'));
	});
});
