/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { IVoltStdioService, IVoltStdioSpawnOptions } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { McpHost } from '../../browser/host/mcpHost.js';
import { diffMcpServerSpec, VoltMcpApprovalStore } from '../../common/harness/mcpApprovals.js';

const ROOT = URI.file('/repo');
const HOME = URI.file('/home/me');
const MARKER = URI.file('/repo/pwned');
/** HTTP servers are not part of these tests. */
const NO_REQUESTS = undefined as unknown as IRequestService;

/**
 * Processes as the MCP host would start them. `touch <file>` creates the file, as the real command
 * would: a repository's server that ran leaves the marker behind. Any other command is an MCP
 * server that answers `initialize` and lists one tool.
 */
class FakeProcesses {
	readonly spawns: IVoltStdioSpawnOptions[] = [];
	readonly killed: string[] = [];
	private readonly onDataEmitter = new Emitter<{ id: string; data: string }>();
	private readonly onExitEmitter = new Emitter<{ id: string; code: number | null }>();
	private next = 0;
	/** Where PATH finds every command. */
	pathDir = '/usr/bin';

	constructor(private readonly files: FileService, store: DisposableStore) {
		store.add(this.onDataEmitter);
		store.add(this.onExitEmitter);
	}

	asService(): IVoltStdioService {
		return {
			onData: this.onDataEmitter.event,
			onExit: this.onExitEmitter.event,
			spawn: async (options: IVoltStdioSpawnOptions) => {
				this.spawns.push(options);
				const id = `p${this.next++}`;
				if (options.command === 'touch') {
					for (const arg of options.args ?? []) {
						await this.files.writeFile(URI.file(arg), VSBuffer.fromString(''));
					}
					setTimeout(() => this.onExitEmitter.fire({ id, code: 0 }), 0);
				}
				return id;
			},
			write: async (id: string, data: string) => {
				for (const line of data.split('\n').filter(Boolean)) {
					const message = JSON.parse(line) as { id?: number; method?: string };
					if (message.id === undefined) {
						continue;
					}
					const result = message.method === 'tools/list' ? { tools: [{ name: 'hello', description: 'Says hello.' }] } : {};
					setTimeout(() => this.onDataEmitter.fire({ id, data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n' }), 0);
				}
			},
			kill: async (id: string) => { this.killed.push(id); },
			which: async (command: string) => `${this.pathDir}/${command}`,
		} as unknown as IVoltStdioService;
	}
}

suite('Volt MCP host: project servers need trust and an approval (B-02)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup(options: { trusted: boolean; project?: object; user?: object }) {
		const disposables = store.add(new DisposableStore());
		const files = disposables.add(new FileService(new NullLogService()));
		disposables.add(files.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		await files.createFolder(ROOT);
		await files.createFolder(HOME);
		if (options.project) {
			await files.writeFile(joinPath(ROOT, '.mcp.json'), VSBuffer.fromString(JSON.stringify(options.project)));
		}
		if (options.user) {
			await files.writeFile(joinPath(HOME, '.cursor/mcp.json'), VSBuffer.fromString(JSON.stringify(options.user)));
		}
		const processes = new FakeProcesses(files, disposables);
		const approvals = new VoltMcpApprovalStore(URI.file('/userData/voltMcpApprovals.json'), files, new NullLogService());
		const trust = { trusted: options.trusted };
		const newHost = () => disposables.add(new McpHost(files, processes.asService(), NO_REQUESTS, new NullLogService(), {
			approvals,
			trusted: async () => trust.trusted,
		}));
		const host = newHost();
		/** What composer focus does with a native model, then what the send does. */
		const focusAndSend = async () => {
			await host.prewarm(ROOT, HOME);
			const tools = await host.tools(ROOT, HOME, 200);
			await timeout(5);
			return tools;
		};
		const writeProject = (config: object) => files.writeFile(joinPath(ROOT, '.mcp.json'), VSBuffer.fromString(JSON.stringify(config)));
		/** Hosts close their connections a moment after they are disposed. */
		const close = async () => {
			disposables.dispose();
			await timeout(5);
		};
		return { files, processes, approvals, host, newHost, trust, focusAndSend, writeProject, close };
	}

	const pwn = { mcpServers: { pwn: { command: 'touch', args: [MARKER.fsPath] } } };

	test('REPO-1: an untrusted repository\'s .mcp.json runs nothing on composer focus, and the card shows the exact command', async () => {
		const { files, processes, host, focusAndSend } = await setup({ trusted: false, project: pwn });
		assert.deepStrictEqual(await focusAndSend(), []);
		assert.deepStrictEqual(processes.spawns, [], 'nothing was spawned');
		assert.strictEqual(await files.exists(MARKER), false, 'the marker was not created');
		const [request] = await host.approvalRequests(ROOT, HOME);
		assert.strictEqual(request.name, 'pwn');
		assert.strictEqual(request.approval, 'needed');
		assert.strictEqual(request.file, '.mcp.json');
		assert.deepStrictEqual(request.spec, { kind: 'stdio', command: 'touch', args: [MARKER.fsPath], envNames: [], cwd: ROOT.fsPath, binary: '/usr/bin/touch' });
		assert.deepStrictEqual((await host.servers(ROOT, HOME)).map(server => [server.name, server.scope, server.approval]), [['pwn', 'project', 'needed']]);
	});

	test('REPO-2: a trusted folder still runs nothing before the server is approved', async () => {
		const { files, processes, host, focusAndSend } = await setup({ trusted: true, project: pwn });
		await focusAndSend();
		assert.deepStrictEqual(processes.spawns, []);
		assert.strictEqual(await files.exists(MARKER), false);
		assert.strictEqual((await host.approvalRequests(ROOT, HOME))[0]?.approval, 'needed');
	});

	test('REPO-2: an approval without trust runs nothing (untrusted), a denial runs nothing and stops asking', async () => {
		const { processes, host, trust, focusAndSend } = await setup({ trusted: true, project: { mcpServers: { tool: { command: 'fake-mcp', args: ['a'] } } } });
		const [request] = await host.approvalRequests(ROOT, HOME);
		await host.decide(ROOT, HOME, 'tool', request.digest, true);
		trust.trusted = false;
		await focusAndSend();
		assert.deepStrictEqual(processes.spawns, []);
		assert.strictEqual((await host.approvalRequests(ROOT, HOME))[0]?.approval, 'untrusted');

		trust.trusted = true;
		await host.decide(ROOT, HOME, 'tool', request.digest, false);
		await focusAndSend();
		assert.deepStrictEqual(processes.spawns, []);
		assert.deepStrictEqual(await host.approvalRequests(ROOT, HOME), []);
		assert.strictEqual((await host.servers(ROOT, HOME))[0].approval, 'denied');
	});

	test('REPO-3: approved runs; editing the args re-prompts with a diff, stops it, and the old approval is never used', async () => {
		const { processes, host, focusAndSend, writeProject, close } = await setup({ trusted: true, project: { mcpServers: { tool: { command: 'fake-mcp', args: ['--port', '1'] } } } });
		const [first] = await host.approvalRequests(ROOT, HOME);
		await host.decide(ROOT, HOME, 'tool', first.digest, true);
		const tools = await focusAndSend();
		assert.deepStrictEqual(tools.map(tool => tool.name), ['mcp__tool__hello']);
		assert.strictEqual(processes.spawns.length, 1);
		assert.deepStrictEqual(processes.spawns[0], { command: 'fake-mcp', args: ['--port', '1'], cwd: ROOT.fsPath, env: {} });
		assert.deepStrictEqual(await host.approvalRequests(ROOT, HOME), []);

		await writeProject({ mcpServers: { tool: { command: 'fake-mcp', args: ['--port', '2'] } } });
		assert.deepStrictEqual(await focusAndSend(), []);
		assert.strictEqual(processes.spawns.length, 1, 'the changed server did not start');
		assert.deepStrictEqual(processes.killed, ['p0'], 'the running one was stopped');
		const [second] = await host.approvalRequests(ROOT, HOME);
		assert.strictEqual(second.approval, 'changed');
		assert.notStrictEqual(second.digest, first.digest);
		assert.ok(second.previous);
		assert.deepStrictEqual(diffMcpServerSpec(second.previous, second.spec), [{ field: 'args', before: '["--port","1"]', after: '["--port","2"]' }]);
		// The card drawn for the old command can't approve the new one.
		await assert.rejects(() => host.decide(ROOT, HOME, 'tool', first.digest, true), /changed since it was shown/);

		await host.decide(ROOT, HOME, 'tool', second.digest, true);
		await focusAndSend();
		assert.deepStrictEqual(processes.spawns.map(spawn => spawn.args), [['--port', '1'], ['--port', '2']]);
		await close();
	});

	test('REPO-3: revoking an approval stops the server and it does not start again', async () => {
		const { processes, host, approvals, focusAndSend, close } = await setup({ trusted: true, project: { mcpServers: { tool: { command: 'fake-mcp' } } } });
		const [request] = await host.approvalRequests(ROOT, HOME);
		await host.decide(ROOT, HOME, 'tool', request.digest, true);
		await focusAndSend();
		assert.strictEqual(processes.spawns.length, 1);
		await host.revoke(request.realRoot, 'tool');
		await timeout(5);
		assert.deepStrictEqual(processes.killed, ['p0']);
		assert.deepStrictEqual(await approvals.list(), []);
		await focusAndSend();
		assert.strictEqual(processes.spawns.length, 1);
		assert.strictEqual((await host.approvalRequests(ROOT, HOME))[0]?.approval, 'needed');
		await close();
	});

	test('MCP-1: on a name clash the user\'s server wins, and user servers run with no prompt', async () => {
		const { files, processes, host, focusAndSend, close } = await setup({
			trusted: true,
			user: { mcpServers: { github: { command: 'fake-mcp', args: ['user'] } } },
			project: { mcpServers: { github: { command: 'touch', args: [MARKER.fsPath] } } },
		});
		const tools = await focusAndSend();
		assert.deepStrictEqual(tools.map(tool => tool.name), ['mcp__github__hello']);
		assert.deepStrictEqual(processes.spawns.map(spawn => [spawn.command, spawn.args]), [['fake-mcp', ['user']]]);
		assert.strictEqual(await files.exists(MARKER), false);
		assert.deepStrictEqual(await host.approvalRequests(ROOT, HOME), []);
		assert.deepStrictEqual((await host.servers(ROOT, HOME)).map(server => [server.name, server.scope, server.approval]), [['github', 'user', undefined]]);
		await close();
	});

	test('MCP-2: a changed environment value or binary changes the digest and asks again', async () => {
		const { processes, host, writeProject } = await setup({ trusted: true, project: { mcpServers: { tool: { command: 'fake-mcp', env: { TOKEN: 'a' } } } } });
		const [first] = await host.approvalRequests(ROOT, HOME);
		assert.deepStrictEqual(first.spec.kind === 'stdio' && first.spec.envNames, ['TOKEN'], 'names only, never values');
		assert.ok(!JSON.stringify(first).includes('"a"'));
		await host.decide(ROOT, HOME, 'tool', first.digest, true);

		await writeProject({ mcpServers: { tool: { command: 'fake-mcp', env: { TOKEN: 'b' } } } });
		const [second] = await host.approvalRequests(ROOT, HOME);
		assert.strictEqual(second.approval, 'changed');
		assert.ok(second.previous);
		assert.deepStrictEqual(diffMcpServerSpec(second.previous, second.spec), [], 'only a value the card does not show changed');

		await writeProject({ mcpServers: { tool: { command: 'fake-mcp', env: { TOKEN: 'a' } } } });
		assert.deepStrictEqual(await host.approvalRequests(ROOT, HOME), [], 'back to the approved server');
		assert.deepStrictEqual(processes.spawns, []);
	});

	test('MCP-2: the same command resolving to another binary on PATH is a different server', async () => {
		const { processes, host, newHost } = await setup({ trusted: true, project: { mcpServers: { tool: { command: 'fake-mcp' } } } });
		const [first] = await host.approvalRequests(ROOT, HOME);
		await host.decide(ROOT, HOME, 'tool', first.digest, true);
		processes.pathDir = '/tmp/evil';
		// A fresh host: one keeps a resolved binary for a short while.
		const [second] = await newHost().approvalRequests(ROOT, HOME);
		assert.strictEqual(second.approval, 'changed');
		assert.ok(second.previous);
		assert.deepStrictEqual(diffMcpServerSpec(second.previous, second.spec), [{ field: 'binary', before: '/usr/bin/fake-mcp', after: '/tmp/evil/fake-mcp' }]);
	});

	test('MCP-3: a project server named volt never shadows Volt\'s own tools', async () => {
		const { processes, host, focusAndSend } = await setup({ trusted: true, project: { mcpServers: { volt: { command: 'touch', args: [MARKER.fsPath] } } } });
		await focusAndSend();
		assert.deepStrictEqual(processes.spawns, []);
		assert.deepStrictEqual(await host.servers(ROOT, HOME), []);
	});

	test('MCP-4: tool names that meet at 64 characters keep the user server\'s tool', async () => {
		const long = 'a'.repeat(60);
		const { host, focusAndSend, close } = await setup({
			trusted: true,
			user: { mcpServers: { [`${long}x`]: { command: 'fake-mcp', args: ['user'] } } },
			project: { mcpServers: { [`${long}y`]: { command: 'fake-mcp', args: ['project'] } } },
		});
		const [request] = await host.approvalRequests(ROOT, HOME);
		await host.decide(ROOT, HOME, request.name, request.digest, true);
		await focusAndSend();
		const tools = await host.tools(ROOT, HOME, 200);
		assert.strictEqual(tools.length, 1);
		assert.ok(tools[0].description.startsWith(`[MCP ${long}x]`));
		await close();
	});
});
