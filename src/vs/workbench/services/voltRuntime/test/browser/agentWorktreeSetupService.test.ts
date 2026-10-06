/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { AgentWorktreeSetupService } from '../../browser/git/agentWorktreeSetupService.js';

/** Runs nothing: each command's exit code comes from `exits` (by substring), output echoes its markers. */
class FakeStdio {
	readonly commands: string[] = [];
	readonly exits = new Map<string, number>();
	/** Commands containing this never finish on their own (until cancelled). */
	hang: string | undefined;
	private readonly hanging = new Set<string>();

	asService(): IVoltStdioService {
		return {
			onData: Event.None,
			onExit: Event.None,
			exec: request => this.exec(request),
			cancelExec: async id => { this.hanging.delete(id); },
			jobOutput: async id => this.job(id),
			jobWait: async id => {
				await timeout(5);
				return this.job(id);
			},
		} as Partial<IVoltStdioService> as IVoltStdioService;
	}

	private job(id: string): IVoltJobOutput {
		return { id, command: '', output: '', offset: 0, running: this.hanging.has(id), exitCode: this.hanging.has(id) ? null : 130 };
	}

	private async exec(request: IVoltExecRequest): Promise<IVoltExecResult> {
		this.commands.push(request.command);
		const markers = [...request.command.matchAll(/::volt-setup-step (\d+)/g)].map(match => `::volt-setup-step ${match[1]}`);
		if (this.hang && request.command.includes(this.hang)) {
			this.hanging.add(request.id);
			return { id: request.id, exitCode: null, stdout: '', stderr: '', combined: markers.join('\n'), truncated: false, durationMs: 1, timedOut: false, cancelled: false, running: true };
		}
		let exitCode = 0;
		let output = markers.join('\n');
		for (const [needle, code] of this.exits) {
			if (request.command.includes(needle)) {
				exitCode = code;
				// The shell stops at the failing command: only the markers up to it were printed.
				const index = markers.findIndex((_, i) => request.command.split('::volt-setup-step')[i + 1]?.includes(needle));
				output = markers.slice(0, index + 1).join('\n') + '\nnpm ERR! boom';
			}
		}
		return { id: request.id, exitCode, stdout: output, stderr: '', combined: output, truncated: false, durationMs: 1, timedOut: false, cancelled: false, running: false };
	}
}

suite('Agent worktree setup service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(files: Record<string, string>) {
		const disposables = store.add(new DisposableStore());
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		for (const [path, content] of Object.entries(files)) {
			await fileService.writeFile(URI.file(path), VSBuffer.fromString(content));
		}
		await fileService.createFolder(URI.file('/wt/a'));
		const stdio = new FakeStdio();
		const service = disposables.add(new AgentWorktreeSetupService(stdio.asService(), fileService, new NullLogService()));
		return { service, stdio };
	}

	const request = { repoRoot: '/repo', worktreePath: '/wt/a', branch: 'volt/a' };

	test('nothing to set up shows nothing; a project file runs its steps in order', async () => {
		const empty = await setup({});
		await empty.service.run('chat', request);
		assert.strictEqual(empty.service.get('chat'), undefined);
		assert.strictEqual(empty.stdio.commands.length, 0);

		const { service, stdio } = await setup({
			'/repo/t3.json': JSON.stringify({ scripts: [{ name: 'Install', command: 'npm ci', runOnWorktreeCreate: true, async: false }] }),
			'/wt/a/.gitmodules': '[submodule "lib"]',
		});
		await service.run('chat', request);
		const status = service.get('chat')!;
		assert.strictEqual(status.phase, 'done');
		assert.deepStrictEqual(status.steps.map(step => [step.label, step.state]), [['Initialize submodules', 'done'], ['Install', 'done']]);
		assert.ok(stdio.commands[0].includes('git submodule update --init --recursive'));
	});

	test('a failing step fails the setup; Retry runs from that step and not the ones that finished', async () => {
		const { service, stdio } = await setup({ '/repo/.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['echo one', 'npm ci', 'echo three'] }) });
		stdio.exits.set('npm ci', 1);
		await assert.rejects(service.run('chat', request), /npm ci/);
		let status = service.get('chat')!;
		assert.strictEqual(status.phase, 'failed');
		assert.deepStrictEqual(status.steps.map(step => step.state), ['done', 'failed', 'pending']);
		assert.match(status.steps[1].tail ?? '', /npm ERR! boom/);
		assert.ok(service.needsRetry('chat'));

		stdio.exits.clear();
		await service.retry('chat');
		status = service.get('chat')!;
		assert.strictEqual(status.phase, 'done');
		assert.ok(!stdio.commands.at(-1)!.includes('echo one'), 'the finished step did not run again');
		assert.ok(stdio.commands.at(-1)!.includes('npm ci'));
		assert.ok(!service.needsRetry('chat'));
	});

	test('Cancel stops the running step; async project scripts do not hold the agent up', async () => {
		const { service, stdio } = await setup({ '/repo/volt.json': JSON.stringify({ scripts: [{ name: 'Install', command: 'pnpm i', runOnWorktreeCreate: true, async: false }, { name: 'Warm cache', command: 'pnpm build', runOnWorktreeCreate: true }] }) });
		stdio.hang = 'pnpm i';
		const running = service.run('chat', request);
		await timeout(20);
		assert.strictEqual(service.get('chat')?.steps[0].state, 'running');
		await service.cancel('chat');
		await assert.rejects(running, /cancelled/);
		assert.strictEqual(service.get('chat')?.phase, 'cancelled');

		stdio.hang = 'pnpm build';
		await service.retry('chat');
		assert.strictEqual(service.get('chat')?.steps[0].state, 'done', 'the blocking step is done and the agent may start');
		assert.strictEqual(service.get('chat')?.steps[1].state, 'running', 'the async script keeps going');
		await service.cancel('chat');
		for (let i = 0; i < 50 && service.get('chat')?.phase === 'running'; i++) {
			await timeout(5);
		}
		assert.strictEqual(service.get('chat')?.phase, 'cancelled');
	});
});
