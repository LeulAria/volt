/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { VoltStdioService } from '../../node/voltStdioService.js';

/** INV-13: the stdio service's sandbox checks and file broker fail closed for a process it does not know. */
suite('Volt stdio sandbox file access (B-17)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let userData: string;
	let cli: string | undefined;

	setup(async () => {
		userData = await fs.mkdtemp(join(tmpdir(), 'volt-stdio-files-'));
		// As if started from a terminal: the service takes this environment instead of spawning a login shell for it.
		cli = process.env['VSCODE_CLI'];
		process.env['VSCODE_CLI'] = '1';
	});

	teardown(async () => {
		if (cli === undefined) {
			delete process.env['VSCODE_CLI'];
		} else {
			process.env['VSCODE_CLI'] = cli;
		}
		await fs.rm(userData, { recursive: true, force: true });
	});

	test('sandboxAllows(unknown) is false; a running unsandboxed process stays unconfined; a gone one is unknown again', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		// The first spawn resolves the user's shell environment.
		this.timeout(60_000);
		const service = store.add(new VoltStdioService(new NullLogService(), new TestConfigurationService(), userData));
		assert.strictEqual(await service.sandboxAllows('no-such-process', join(userData, 'a.txt'), 'write'), false);
		assert.strictEqual(await service.sandboxAllows('no-such-process', join(userData, 'a.txt'), 'read'), false);
		const id = await service.spawn({ command: '/bin/sleep', args: ['30'], context: { principal: 'volt', reason: 'volt', sandboxed: false } });
		assert.strictEqual(await service.sandboxAllows(id, join(userData, 'a.txt'), 'write'), true, 'started without a sandbox');
		const exited = new Promise<void>(resolve => {
			const listener = service.onExit(e => {
				if (e.id === id) {
					listener.dispose();
					resolve();
				}
			});
		});
		await service.kill(id);
		await exited;
		assert.strictEqual(await service.sandboxAllows(id, join(userData, 'a.txt'), 'write'), false, 'gone: unknown, refused');
	});

	test('the file broker refuses a process that is not a running sandboxed spawn', async () => {
		const service = store.add(new VoltStdioService(new NullLogService(), new TestConfigurationService(), userData));
		const path = join(userData, 'a.txt');
		const write = await service.sandboxWriteFile('no-such-process', path, 'x');
		assert.strictEqual(write.ok, false);
		const read = await service.sandboxReadFile('no-such-process', path);
		assert.strictEqual(read.ok, false);
		assert.strictEqual(await fs.stat(path).then(() => true, () => false), false, 'nothing written');
	});

	// macOS: Seatbelt is always there. Linux needs bubblewrap and volt-fsd (the container rig).
	(process.platform === 'darwin' ? test : test.skip)('a sandboxed agent\'s files: written in its workspace, refused through a link or outside it', async function () {
		this.timeout(60_000);
		const service = store.add(new VoltStdioService(new NullLogService(), new TestConfigurationService(), userData));
		// The workspace not under the per-user temp folder (the agent profile denies other runs' temp
		// there), and "home" there for that reason: outside everything the sandbox may write (/tmp is writable).
		const base = await fs.realpath(await fs.mkdtemp('/tmp/volt-stdio-ws-'));
		const ws = join(base, 'ws');
		const home = join(await fs.realpath(userData), 'home');
		await fs.mkdir(ws);
		await fs.mkdir(home);
		await fs.writeFile(join(home, '.zshrc'), 'user');
		await fs.symlink(home, join(ws, 'h'));
		const id = await service.spawn({ command: '/bin/sleep', args: ['30'], cwd: ws, sandbox: { level: 'workspace-write', network: false, providerId: '', workspaceRoots: [ws] }, context: { principal: 'chat:test', reason: 'agent', sandboxed: true } });
		try {
			const ok = await service.sandboxWriteFile(id, join(ws, 'src', 'a.ts'), 'hello');
			assert.ok(ok.ok, JSON.stringify(ok));
			assert.strictEqual(await fs.readFile(join(ws, 'src', 'a.ts'), 'utf8'), 'hello');
			const again = await service.sandboxWriteFile(id, join(ws, 'src', 'a.ts'), 'bye');
			assert.ok(again.ok && again.content === 'hello', 'the content before comes back');
			const read = await service.sandboxReadFile(id, join(ws, 'src', 'a.ts'));
			assert.ok(read.ok && read.content === 'bye');
			for (const path of [join(ws, 'h', '.zshrc'), join(home, '.zshrc'), join(ws, '.git', 'config')]) {
				const refused = await service.sandboxWriteFile(id, path, 'pwned');
				assert.strictEqual(refused.ok, false, path);
			}
			assert.strictEqual(await fs.readFile(join(home, '.zshrc'), 'utf8'), 'user');
		} finally {
			await service.kill(id);
			await fs.rm(base, { recursive: true, force: true });
		}
	});
});
