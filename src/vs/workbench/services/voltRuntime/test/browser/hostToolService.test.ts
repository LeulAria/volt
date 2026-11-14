/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../platform/files/common/files.js';
import { HOST_MCP_TOKEN_TTL_MS, hostMcpSessionToken, parseHostMcpSessionToken } from '../../../../../platform/voltHostMcp/common/voltHostMcpAuth.js';
import { IGrant } from '../../../../../platform/voltSandbox/common/grants.js';
import { extensionSubject } from '../../../../../platform/voltSandbox/common/principals.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltChatFileRequest, IVoltChatFileResult, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { VoltHostToolService } from '../../browser/host/hostToolService.js';
import { dataUrlBytes, decodeDataUrl, encodeImage, scaleScreenshot } from '../../browser/host/imageCodec.js';
import { createBrowserTools } from '../../browser/tools/browserTool.js';
import { BrowserBlockReason, IVoltBrowserAccessService } from '../../common/browserAccess.js';
import { AUTOMATE_BROWSER_COMMAND_ID, BROWSER_PAGE_URL_COMMAND_ID, IVoltBrowserAutomationOptions, IVoltHostFlowApproval, IVoltHostToolApproval, IVoltHostToolCall, IVoltHostToolOwner, IVoltHostToolInvocation, IVoltMcpServer, VOLT_HOST_TOOLS } from '../../common/hostTools.js';
import { chatInSubtree } from '../../common/hostToolSandbox.js';
import { VoltMode } from '../../common/modes.js';
import { createImage, IRgbaImage } from '../../common/tools/imageAnalysis.js';

interface ICommandCall {
	readonly id: string;
	readonly args: unknown[];
}

function fill(image: IRgbaImage, x0: number, y0: number, w: number, h: number, rgb: readonly [number, number, number]): IRgbaImage {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) {
			const p = (y * image.width + x) * 4;
			image.data[p] = rgb[0];
			image.data[p + 1] = rgb[1];
			image.data[p + 2] = rgb[2];
		}
	}
	return image;
}

suite('Volt host tool service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { pageUrl?: string; files?: Map<string, Uint8Array>; links?: ReadonlyMap<string, string>; dangling?: ReadonlySet<string>; onAutomate?: (name: string, args: Record<string, unknown>, page: { url?: string }) => void } = {}) {
		const calls: ICommandCall[] = [];
		const page: { url?: string } = { url: options.pageUrl };
		const commands = {
			_serviceBrand: undefined,
			onWillExecuteCommand: Event.None,
			onDidExecuteCommand: Event.None,
			executeCommand: async (id: string, ...args: unknown[]) => {
				calls.push({ id, args });
				if (id === BROWSER_PAGE_URL_COMMAND_ID) {
					return page.url;
				}
				if (id === AUTOMATE_BROWSER_COMMAND_ID) {
					options.onAutomate?.(String(args[1]), args[2] as Record<string, unknown>, page);
				}
				return { text: `ran ${String(args[1])}` };
			},
		} as unknown as ICommandService;
		const written = new Map<string, string>();
		// Symlinks: a path at or below a link resolves into its target.
		const real = (path: string) => {
			for (const [link, target] of options.links ?? []) {
				if (path === link || path.startsWith(`${link}/`)) {
					return target + path.slice(link.length);
				}
			}
			return path;
		};
		const files = {
			readFile: async (uri: URI) => {
				const bytes = options.files?.get(uri.path) ?? (written.has(uri.path) ? VSBuffer.fromString(written.get(uri.path)!).buffer : undefined);
				if (!bytes) {
					throw new Error('missing');
				}
				return { value: VSBuffer.wrap(bytes) };
			},
			writeFile: async (uri: URI, content: VSBuffer) => {
				written.set(uri.path, content.toString());
				return {};
			},
			// A dangling link (its target not made yet): realpath fails on it and below it, stat sees the link itself.
			realpath: async (uri: URI) => {
				if ([...options.dangling ?? []].some(link => uri.path === link || uri.path.startsWith(`${link}/`))) {
					throw new Error(`ENOENT: ${uri.path}`);
				}
				return URI.file(real(uri.path));
			},
			stat: async (uri: URI) => {
				if (options.dangling?.has(uri.path)) {
					return { isSymbolicLink: true };
				}
				throw new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND);
			},
		} as unknown as IFileService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService;
		const blocked = new Map<string | undefined, BrowserBlockReason>();
		const access = { blockReason: (sessionId: string | undefined) => blocked.get(sessionId) } as unknown as IVoltBrowserAccessService;
		// The execution host's race-free file operations for sandboxed chats (SEC3-3), over the same files.
		const chatFiles: IVoltChatFileRequest[] = [];
		const stdio = {
			chatFile: async (request: IVoltChatFileRequest): Promise<IVoltChatFileResult> => {
				chatFiles.push(request);
				const path = URI.file(request.path).path;
				if (request.op === 'read') {
					const bytes = options.files?.get(path) ?? (written.has(path) ? VSBuffer.fromString(written.get(path)!).buffer : undefined);
					return bytes ? { ok: true, path, content: VSBuffer.wrap(bytes).toString() } : { ok: false, reason: `${path} does not exist`, refusal: 'missing' };
				}
				written.set(path, request.content ?? '');
				return { ok: true, path, existed: false };
			},
		} as unknown as IVoltStdioService;
		const service = store.add(new VoltHostToolService(commands, files, workspace, access, stdio));
		const modes = new Map<string, VoltMode>();
		service.setSessionResolver({ mode: id => modes.get(id), cwd: () => undefined });
		// What the MCP bridge registers: each chat's sandbox and the folder it works in.
		const sandboxes = new Map<string, IVoltSandboxSettings>();
		const folders = new Map<string, string>();
		service.setSandboxResolver({ settings: id => sandboxes.get(id) ?? { level: 'off', network: true }, folder: id => folders.get(id) ?? '/ws' });
		const automated = () => calls.filter(call => call.id === AUTOMATE_BROWSER_COMMAND_ID);
		return { service, calls, modes, automated, blocked, written, page, sandboxes, folders, chatFiles };
	}

	/** A provider serving `names`, recording what ran. */
	function serve(service: VoltHostToolService, names: readonly string[]): string[] {
		const ran: string[] = [];
		store.add(service.registerToolProvider({
			tools: names.map(name => ({ name, title: name, description: '', inputSchema: {} })),
			invoke: async name => { ran.push(name); return { text: `ran ${name}` }; },
		}));
		return ran;
	}

	const WORKSPACE_WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: false };
	const READ_ONLY: IVoltSandboxSettings = { level: 'read-only', network: false };

	test('hands each chat\'s agent a token for its own session and groups, never the server secret', () => {
		const { service } = setup();
		assert.deepStrictEqual(service.getMcpServers('s1'), []);
		service.setMcpEndpoint('http://127.0.0.1:4000/mcp', 'tok');
		// The token carries the lease it was issued with (key epoch, expiry) and is signed over it.
		const bearer = (servers: readonly IVoltMcpServer[]) => servers[0].headers[0].value.replace(/^Bearer /, '');
		const before = Date.now();
		const lease = parseHostMcpSessionToken(bearer(service.getMcpServers('chat 1')));
		assert.ok(lease && lease.epoch >= before && lease.expiry === lease.epoch + HOST_MCP_TOKEN_TTL_MS, 'a lease from now, valid for a day');
		assert.deepStrictEqual(service.getMcpServers('chat 1'), [{ type: 'http', name: 'volt', url: 'http://127.0.0.1:4000/mcp/chat%201', headers: [{ name: 'Authorization', value: `Bearer ${hostMcpSessionToken('tok', 'chat 1', undefined, lease)}` }] }]);
		const grouped = service.getMcpServers('s', { groups: ['core', 'image'] })[0];
		assert.strictEqual(grouped.url, 'http://127.0.0.1:4000/mcp/s?groups=core,image');
		const groupedLease = parseHostMcpSessionToken(bearer([grouped]))!;
		assert.deepStrictEqual(grouped.headers, [{ name: 'Authorization', value: `Bearer ${hostMcpSessionToken('tok', 's', ['core', 'image'], groupedLease)}` }]);
		assert.notStrictEqual(hostMcpSessionToken('tok', 's', ['core', 'image'], groupedLease), hostMcpSessionToken('tok', 's', undefined, groupedLease));
		// The same chat always gets the same config, so a live agent session is not mistaken for a stale one.
		assert.deepStrictEqual(service.getMcpServers('chat 1'), service.getMcpServers('chat 1'));
		// Without a chat there is nothing to authenticate as: the server is listed (Volt has tools) with no credentials.
		assert.deepStrictEqual(service.getMcpServers(), [{ type: 'http', name: 'volt', url: 'http://127.0.0.1:4000/mcp', headers: [] }]);
		assert.ok(JSON.stringify([service.getMcpServers('chat 1'), service.getMcpServers()]).indexOf('Bearer tok') < 0);
	});

	test('IPC-2: revoking a chat announces an epoch at or above its tokens\' and issues later tokens above it', () => {
		const { service } = setup();
		service.setMcpEndpoint('http://127.0.0.1:4000/mcp', 'tok');
		const leaseOf = (sessionId: string) => parseHostMcpSessionToken(service.getMcpServers(sessionId)[0].headers[0].value.replace(/^Bearer /, ''))!;
		const first = leaseOf('chat 1');
		const other = leaseOf('chat 2');
		const revoked: { sessionId: string; epoch: number }[] = [];
		store.add(service.onDidRevokeMcpSession(event => revoked.push(event)));
		service.revokeMcpSession('chat 1');
		assert.strictEqual(revoked.length, 1);
		assert.strictEqual(revoked[0].sessionId, 'chat 1');
		assert.ok(revoked[0].epoch >= first.epoch, 'the server refuses the old token (epoch <= the revoked one)');
		const second = leaseOf('chat 1');
		assert.ok(second.epoch > revoked[0].epoch, 'a token issued after the revocation is above it');
		assert.notDeepStrictEqual(second, first);
		assert.deepStrictEqual(leaseOf('chat 2'), other, 'another chat keeps its token');
		// Many revocations in the same millisecond still order strictly.
		for (let i = 0; i < 5; i++) {
			service.revokeMcpSession('chat 1');
		}
		assert.ok(revoked.slice(1).every((event, i) => event.epoch > revoked[i].epoch));
		assert.ok(leaseOf('chat 1').epoch > revoked.at(-1)!.epoch);
	});

	test('sandbox gate: escapes, memory, new chats and unknown tools are refused for a sandboxed chat; an unsandboxed chat is unaffected', async () => {
		const { service } = setup();
		const names = ['terminal_start', 'task_watch', 'app_open', 'docker_ensure', 'device_install_app', 'device_launch_app', 'desktop_act', 'window_capture', 'worktree_handoff', 'thread_merge_back', 'rename_branch', 'memory_write', 'skill_write', 'memory_read', 'thread_launch', 'delegate_task', 'brand_new_tool', 'manage_automations', 'automation', 'device_act', 'render_chart'];
		const ran = serve(service, names);
		const sandboxed = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		const error = async (name: string, args: Record<string, unknown> = {}, call = sandboxed) => (await service.invokeTool(name, args, call)).error ?? '';

		// Terminals and docker_ensure run in the chat's own sandbox now (sandboxPty.ts, F.6): the gate lets them through, the tools carry the sandbox.
		assert.strictEqual(await error('terminal_start', { command: 'npm test' }), '');
		assert.strictEqual(await error('docker_ensure'), '');
		assert.strictEqual(await error('terminal_start', {}, { sessionId: 's1', sandbox: READ_ONLY }), '');
		assert.deepStrictEqual(ran.splice(0), ['terminal_start', 'docker_ensure', 'terminal_start']);
		for (const name of ['task_watch', 'app_open', 'device_install_app', 'device_launch_app', 'desktop_act', 'window_capture', 'worktree_handoff', 'thread_merge_back', 'rename_branch']) {
			assert.match(await error(name), /would run outside it\./, name);
		}
		assert.match(await error('memory_write', { name: 'x', content: 'y' }), /would save something later chats read outside the sandbox/);
		assert.match(await error('skill_write'), /later chats read/);
		// New chats inherit the caller's sandbox, so these run; one in a new worktree does not (Volt runs its setup outside).
		assert.strictEqual(await error('thread_launch', { prompt: 'go' }), '');
		assert.strictEqual(await error('delegate_task', { task: 'go' }), '');
		assert.match(await error('thread_launch', { prompt: 'go', workspace: { type: 'worktree' } }), /would run outside it/);
		assert.match(await error('brand_new_tool'), /^brand_new_tool was not run: .*is not cleared to run from a sandboxed chat/);
		assert.match(await error('manage_automations', { action: 'create' }), /would run outside it/);
		assert.match(await error('manage_automations', { action: 'run_now' }), /would run outside it/);
		assert.match(await error('automation', { action: 'open_pr' }), /would run outside it/);
		assert.match(await error('automation', { action: 'send_slack' }), /network off, and automation would reach the internet/);
		assert.match(await error('device_act', { script: 'launch com.example.app\ntap "Sign in"' }), /Steps that open a deep link or an app/);
		assert.match(await error('device_act', { run: 'login' }), /saved flows/);
		assert.match(await error('app_open', {}, { sessionId: 's1', sandbox: READ_ONLY }), /Volt's read-only sandbox/);
		assert.deepStrictEqual(ran, ['thread_launch', 'delegate_task'], 'only the chat starts ran: they inherit the sandbox');
		ran.length = 0;

		// What stays inside Volt runs.
		assert.strictEqual(await error('memory_read', { name: 'x' }), '');
		assert.strictEqual(await error('render_chart', {}), '');
		assert.strictEqual(await error('manage_automations', { action: 'list' }), '');
		assert.strictEqual(await error('automation', { action: 'memory_read' }), '');
		assert.strictEqual(await error('automation', { action: 'send_slack' }, { sessionId: 's1', sandbox: { ...WORKSPACE_WRITE, network: true } }), '');
		assert.strictEqual(await error('device_act', { script: 'tap "Sign in"\ntype "Email" a@b.co' }), '');
		assert.deepStrictEqual(ran, ['memory_read', 'render_chart', 'manage_automations', 'automation', 'automation', 'device_act']);

		// No sandbox, or the sandbox off: every tool runs as before.
		ran.length = 0;
		for (const name of names) {
			assert.strictEqual((await service.invokeTool(name, { action: 'create' }, { sessionId: 's1' })).text, `ran ${name}`, name);
			assert.strictEqual((await service.invokeTool(name, { action: 'create' }, { sessionId: 's1', sandbox: { level: 'off', network: false } })).text, `ran ${name}`, name);
		}
		assert.strictEqual(ran.length, names.length * 2);
	});

	test('GATE-XCHAT-1: a sandboxed chat cannot read another chat (thread_read); its own chat it may', async () => {
		const { service } = setup();
		const ran = serve(service, ['thread_read']);
		const call = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		for (const id of ['other', 'volt://session/other']) {
			const refused = await service.invokeTool('thread_read', { thread_id: id }, call);
			assert.match(refused.error ?? '', /^thread_read was not run: .*would read other chats, which needs the agents\.read:other permission/, id);
		}
		assert.strictEqual((await service.invokeTool('thread_read', {}, call)).text, 'ran thread_read', 'its own transcript');
		assert.strictEqual((await service.invokeTool('thread_read', { thread_id: 's1' }, call)).text, 'ran thread_read');
		assert.deepStrictEqual(ran.splice(0), ['thread_read', 'thread_read']);
		// Unsandboxed: as before.
		assert.strictEqual((await service.invokeTool('thread_read', { thread_id: 'other' }, { sessionId: 's1' })).text, 'ran thread_read');
	});

	test('GATE-XCHAT-2: a sandboxed chat cannot search other chats (thread_search)', async () => {
		const { service } = setup();
		const ran = serve(service, ['thread_search']);
		assert.match((await service.invokeTool('thread_search', { query: 'token' }, { sessionId: 's1', sandbox: READ_ONLY })).error ?? '', /agents\.read:other/);
		assert.match((await service.invokeTool('thread_search', { query: 'token', project: 'this' }, { sessionId: 's1', sandbox: WORKSPACE_WRITE })).error ?? '', /agents\.read:other/);
		assert.deepStrictEqual(ran, []);
		assert.strictEqual((await service.invokeTool('thread_search', { query: 'token' }, { sessionId: 's1', sandbox: { level: 'off', network: true } })).text, 'ran thread_search');
	});

	test('GATE-XCHAT-4: a sandboxed chat reads its own subtree (subagents, side chats) through thread_read, thread_wait, queue_list and worktree_status; no other chat', async () => {
		const { service } = setup();
		// What the bridge registers: parents as the history records them (s1 -> agent-1 -> agent-2; other is unrelated).
		const parents = new Map([['agent-1', 's1'], ['agent-2', 'agent-1'], ['side', 'other']]);
		service.setSandboxResolver({ settings: () => ({ level: 'off', network: true }), folder: () => '/ws', inSubtree: (sessionId, chatId) => chatInSubtree(sessionId, chatId, id => parents.get(id)) });
		const tools = ['thread_read', 'thread_wait', 'queue_list', 'worktree_status'];
		const ran = serve(service, tools);
		const call = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		for (const name of tools) {
			const args = (id: string) => name === 'thread_wait' ? { thread_ids: [id] } : { thread_id: id };
			assert.strictEqual((await service.invokeTool(name, args('agent-1'), call)).text, `ran ${name}`, `${name}: its subagent`);
			assert.strictEqual((await service.invokeTool(name, args('agent-2'), call)).text, `ran ${name}`, `${name}: its subagent's subagent`);
			for (const other of ['other', 'side']) {
				assert.match((await service.invokeTool(name, args(other), call)).error ?? '', /agents\.read:other/, `${name}: ${other}`);
			}
		}
		assert.match((await service.invokeTool('thread_wait', { thread_ids: ['agent-1', 'other'] }, call)).error ?? '', /agents\.read:other/, 'one chat outside its subtree refuses the whole wait');
		assert.match((await service.invokeTool('thread_read', { thread_id: 's1' }, { sessionId: 'agent-1', sandbox: WORKSPACE_WRITE })).error ?? '', /agents\.read:other/, 'a subagent does not read its parent');
		assert.strictEqual(ran.length, tools.length * 2);
		// Unsandboxed: as before.
		for (const name of tools) {
			assert.strictEqual((await service.invokeTool(name, { thread_id: 'other', thread_ids: ['other'] }, { sessionId: 's1' })).text, `ran ${name}`);
		}
	});

	test('the native loop\'s calls are judged by the chat\'s own sandbox, which they do not carry', async () => {
		const { service, sandboxes } = setup();
		const ran = serve(service, ['thread_read', 'app_open']);
		sandboxes.set('s2', WORKSPACE_WRITE);
		assert.match((await service.invokeTool('thread_read', { thread_id: 'other' }, { sessionId: 's2', source: 'native' })).error ?? '', /agents\.read:other/);
		assert.match((await service.invokeTool('app_open', { target: 'Calculator' }, { sessionId: 's2', source: 'native' })).error ?? '', /would run outside it/);
		assert.deepStrictEqual(ran, []);
		assert.strictEqual((await service.invokeTool('thread_read', { thread_id: 'other' }, { sessionId: 's3', source: 'native' })).text, 'ran thread_read', 'a chat without a sandbox');
	});

	test('sandbox gate: browser_run edits write only where the OS sandbox lets the agent write, never through a link', async () => {
		const { service, written } = setup({ pageUrl: 'http://localhost:3000/', links: new Map([['/ws/rc', '/Users/someone/.zshrc'], ['/ws/out', '/elsewhere']]) });
		const run = (path: string, sandbox?: IVoltSandboxSettings) => service.invokeTool('browser_run', { edits: [{ path, content: 'x' }] }, { sessionId: 's1', ...(sandbox ? { sandbox } : {}) });
		// The page is the chat's dev server: a local port the user granted (B-16: no other local page with the network off).
		const DEV_SERVER: IVoltSandboxSettings = { ...WORKSPACE_WRITE, listenPorts: [3000] };

		const ok = await run('src/app.ts', DEV_SERVER);
		assert.strictEqual(ok.error, undefined);
		assert.ok(written.has('/ws/src/app.ts'));
		for (const path of ['.git/config', '.vscode/tasks.json', '.claude/settings.json', '.git/hooks/pre-commit', 'rc', 'out/x.ts', '/etc/x', '../x.ts']) {
			const refused = await run(path, DEV_SERVER);
			assert.match(refused.error ?? '', /^browser_run did not start: no file was changed\./, path);
		}
		assert.match((await run('src/other.ts', { ...READ_ONLY, listenPorts: [3000] })).error ?? '', /sandbox is read-only/);
		assert.match((await run('src/other.ts', WORKSPACE_WRITE)).error ?? '', /local server on a port this chat's sandbox was not granted/, 'the page itself, on a port not granted');
		assert.deepStrictEqual([...written.keys()], ['/ws/src/app.ts']);

		// Unsandboxed: as before (inside the project).
		assert.strictEqual((await run('.vscode/tasks.json')).error, undefined);
	});

	test('SEC3-2: a path through a link that does not resolve (a dangling link, its target not made yet) is refused, for reads and writes', async () => {
		const DEV_SERVER: IVoltSandboxSettings = { ...WORKSPACE_WRITE, listenPorts: [3000] };
		const { service, written, chatFiles } = setup({ pageUrl: 'http://localhost:3000/', dangling: new Set(['/ws/evil', '/ws/evdir', '/ws/pic.png', '/ws/.volt']) });
		// `/ws/evil` -> ~/Library/LaunchAgents/x.plist, `/ws/evdir` -> a folder not made yet: writing follows the link out.
		for (const path of ['evil', 'evdir/x.plist', '/ws/evil']) {
			const refused = await service.invokeTool('browser_run', { edits: [{ path, content: '<plist/>' }] }, { sessionId: 's1', sandbox: DEV_SERVER });
			assert.match(refused.error ?? '', /^browser_run did not start: no file was changed\. .*does not resolve/, path);
		}
		assert.match((await service.invokeTool('image_inspect', { path: 'pic.png' }, { sessionId: 's1', sandbox: DEV_SERVER })).error ?? '', /does not resolve/);
		assert.match((await service.invokeTool('browser_act', { script: 'reload', save: 'x' }, { sessionId: 's1', sandbox: DEV_SERVER })).error ?? '', /^browser_act did not start: no file was changed/, 'a flow saved under a dangling .volt would follow it');
		assert.strictEqual(written.size, 0);
		assert.deepStrictEqual(chatFiles, []);
	});

	test('SEC3-3: a sandboxed chat\'s browser_run edits are read and written race-free by the execution host, only over the text they were made against', async () => {
		const DEV_SERVER: IVoltSandboxSettings = { ...WORKSPACE_WRITE, listenPorts: [3000] };
		const files = new Map([['/ws/src/app.ts', VSBuffer.fromString('const a = 1;\n').buffer]]);
		const { service, written, chatFiles } = setup({ pageUrl: 'http://localhost:3000/', files });
		const result = await service.invokeTool('browser_run', { edits: [{ path: 'src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, { path: 'src/new.ts', content: 'export {};' }] }, { sessionId: 's1', sandbox: DEV_SERVER });
		assert.strictEqual(result.error, undefined);
		assert.deepStrictEqual(chatFiles.map(request => [request.op, request.path, request.chatId, request.expected]), [
			['read', '/ws/src/app.ts', 's1', undefined],
			['read', '/ws/src/new.ts', 's1', undefined],
			['write', '/ws/src/app.ts', 's1', 'const a = 1;\n'],
			['write', '/ws/src/new.ts', 's1', undefined],
		]);
		assert.deepStrictEqual(chatFiles[2].sandbox, DEV_SERVER);
		assert.ok(chatFiles[2].roots.includes('/ws'));
		assert.strictEqual(written.get('/ws/src/app.ts'), 'const a = 2;\n');
		// The execution host refuses (a link swapped in after the gate's check): the edit reports what was not written.
		const stdioRefuses = { chatFile: async () => ({ ok: false, reason: '/ws/dir/a.ts goes through a symbolic link', refusal: 'symlink' }) } as unknown as IVoltStdioService;
		const other = store.add(new VoltHostToolService({ executeCommand: async () => 'http://localhost:3000/' } as unknown as ICommandService, { realpath: async (uri: URI) => uri } as unknown as IFileService, { getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService, { blockReason: () => undefined } as unknown as IVoltBrowserAccessService, stdioRefuses));
		other.setSessionResolver({ mode: () => undefined, cwd: () => undefined });
		other.setSandboxResolver({ settings: () => ({ level: 'off', network: true }), folder: () => '/ws' });
		assert.match((await other.invokeTool('browser_run', { edits: [{ path: 'dir/a.ts', content: 'x' }] }, { sessionId: 's1', sandbox: DEV_SERVER })).error ?? '', /symbolic link/);
		// A host without race-free files: refused, nothing written another way.
		const bare = store.add(new VoltHostToolService({ executeCommand: async () => 'http://localhost:3000/' } as unknown as ICommandService, { realpath: async (uri: URI) => uri, writeFile: async () => { throw new Error('the file service must not be used'); } } as unknown as IFileService, { getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService, { blockReason: () => undefined } as unknown as IVoltBrowserAccessService, {} as IVoltStdioService));
		bare.setSessionResolver({ mode: () => undefined, cwd: () => undefined });
		bare.setSandboxResolver({ settings: () => ({ level: 'off', network: true }), folder: () => '/ws' });
		assert.match((await bare.invokeTool('browser_run', { edits: [{ path: 'src/a.ts', content: 'x' }] }, { sessionId: 's1', sandbox: DEV_SERVER })).error ?? '', /cannot open files safely/);
	});

	test('sandbox gate: image and page reads stay in the workspace and temp, never through a link out of it', async () => {
		const png = dataUrlBytes(await encodeImage(createImage(8, 8, [1, 2, 3]), 'png')).bytes;
		const files = new Map([['/ws/design/ref.png', png], ['/tmp/shot.png', png], ['/etc/secret.png', png], ['/Users/someone/.ssh/key.png', png]]);
		const { service } = setup({ files, links: new Map([['/ws/design/key.png', '/Users/someone/.ssh/key.png']]) });
		serve(service, ['html_render', 'canvas_render', 'screens_capture']);
		const sandboxed = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		const inspect = async (path: string, call: IVoltHostToolCall = sandboxed) => service.invokeTool('image_inspect', { path }, call);

		assert.ok((await inspect('design/ref.png')).text?.includes('Size: 8×8'));
		assert.ok((await inspect('/tmp/shot.png')).text?.includes('Size: 8×8'));
		for (const path of ['/etc/secret.png', 'design/key.png', '../etc/secret.png', '/ws/../etc/secret.png', '/ws/%2E%2E/etc/secret.png', 'file:///etc/secret.png']) {
			assert.match((await inspect(path)).error ?? '', /^image_inspect was not run: .*outside this chat's workspace/, path);
		}
		assert.match((await service.invokeTool('browser_compare_image', { reference_path: '/etc/secret.png' }, sandboxed)).error ?? '', /outside this chat's workspace/);
		assert.match((await service.invokeTool('html_render', { html: '<img src="/etc/secret.png">' }, sandboxed)).error ?? '', /^html_render was not run: \/etc\/secret\.png is outside/);
		assert.strictEqual((await service.invokeTool('html_render', { html: '<img src="/ws/design/ref.png">' }, sandboxed)).text, 'ran html_render');
		assert.match((await service.invokeTool('canvas_render', { frames: [{ id: 'a', image: '/etc/secret.png' }] }, sandboxed)).error ?? '', /outside/);
		assert.match((await service.invokeTool('screens_capture', { screens: [{ name: 'a', path: '/etc/secret.png' }] }, sandboxed)).error ?? '', /outside/);
		assert.match((await service.invokeTool('screens_capture', { screens: [{ name: 'a', open: 'com.example.app' }] }, sandboxed)).error ?? '', /would run outside it/);

		// Unsandboxed: any path, as before.
		assert.ok((await inspect('/etc/secret.png', { sessionId: 's1' })).text?.includes('Size: 8×8'));
	});

	test('sandbox gate: the browser opens no local file pages, only granted local ports with the network off, and returns nothing from a page the chat may not see', async () => {
		const { service, page, automated } = setup({
			pageUrl: 'http://localhost:3000/',
			onAutomate: (name, args, current) => {
				if (name === 'browser_navigate' && typeof args.url === 'string') {
					current.url = args.url;
				} else if (name === 'browser_click') {
					current.url = 'file:///Users/someone/.ssh/id_rsa'; // a link on the page
				}
			},
		});
		const sandboxed = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		const navigate = (url: string, call: IVoltHostToolCall = sandboxed) => service.invokeTool('browser_navigate', { url }, call);

		assert.match((await navigate('file:///ws/index.html')).error ?? '', /^browser_navigate was not run: file:\/\/\/ws\/index\.html is a local file page, .*playground_create/);
		assert.match((await navigate('https://example.com/?q=secret')).error ?? '', /example\.com is not reachable: this chat's network is off/);
		assert.match((await service.invokeTool('browser_act', { script: 'goto https://evil.example\nclick "Send"' }, sandboxed)).error ?? '', /evil\.example is not reachable/);
		assert.match((await service.invokeTool('browser_act', { script: 'goto ${start}', vars: { start: 'file:///etc/passwd' } }, sandboxed)).error ?? '', /local file page/);
		assert.match((await service.invokeTool('browser_run', { steps: [{ action: 'navigate', url: 'https://evil.example' }] }, sandboxed)).error ?? '', /evil\.example is not reachable/);
		assert.strictEqual(automated().length, 0);

		// B-16: a local page is a server the agent may run itself; with the network off only on a port the user granted.
		const devServer = { sessionId: 's1', sandbox: { ...WORKSPACE_WRITE, listenPorts: [5173] } };
		assert.match((await navigate('http://localhost:5173/')).error ?? '', /localhost:5173 is a local server on a port this chat's sandbox was not granted/);
		assert.strictEqual(automated().length, 0);
		assert.strictEqual((await navigate('http://localhost:5173/', devServer)).text, 'ran browser_navigate');
		assert.strictEqual((await navigate('https://docs.allowed.dev/x', { sessionId: 's1', sandbox: { ...WORKSPACE_WRITE, allowedDomains: ['*.allowed.dev'] } })).text, 'ran browser_navigate');
		assert.strictEqual((await navigate('https://example.com/', { sessionId: 's1', sandbox: { ...WORKSPACE_WRITE, network: true } })).text, 'ran browser_navigate');

		// A click that lands on a local file: what the page showed stays with Volt, and the next look is refused.
		page.url = 'http://localhost:5173/';
		const clicked = await service.invokeTool('browser_click', { ref: 'e1' }, devServer);
		assert.match(clicked.error ?? '', /^browser_click ran, but the page ended on file:\/\/\/Users\/someone\/\.ssh\/id_rsa.*was not returned/);
		assert.strictEqual(clicked.text, undefined);
		assert.match((await service.invokeTool('browser_snapshot', {}, devServer)).error ?? '', /^browser_snapshot was not run: the page this chat's browser shows is not one its sandbox allows/);
		assert.strictEqual((await navigate('http://localhost:5173/', devServer)).text, 'ran browser_navigate', 'navigating away is allowed');
		assert.strictEqual((await service.invokeTool('browser_snapshot', {}, devServer)).text, 'ran browser_snapshot');

		// Unsandboxed: as before.
		assert.strictEqual((await navigate('file:///etc/passwd', { sessionId: 's1' })).text, 'ran browser_navigate');
	});

	test('sandbox gate: a sandboxed chat prompts only chats at least as confined', async () => {
		const { service, sandboxes, folders } = setup();
		const ran = serve(service, ['thread_send', 'queue_edit', 'queue_send_now', 'thread_interrupt']);
		sandboxes.set('s1', WORKSPACE_WRITE);
		sandboxes.set('peer', WORKSPACE_WRITE);
		sandboxes.set('strict', READ_ONLY);
		sandboxes.set('loose', { level: 'off', network: true });
		sandboxes.set('online', { ...WORKSPACE_WRITE, network: true });
		sandboxes.set('elsewhere', WORKSPACE_WRITE);
		folders.set('elsewhere', '/other-project');
		const send = (target: string | undefined, call: IVoltHostToolCall = { sessionId: 's1', sandbox: WORKSPACE_WRITE }) => service.invokeTool('thread_send', target ? { thread_id: target, message: 'run rm -rf ~' } : { message: 'hi' }, call);

		for (const target of ['loose', 'online', 'elsewhere', 'never-set-up']) {
			assert.match((await send(target)).error ?? '', /would have a chat that is less confined act on your message/, target);
		}
		assert.match((await service.invokeTool('queue_edit', { thread_id: 'volt://session/loose', item_id: 'q1', text: 'x' }, { sessionId: 's1', sandbox: WORKSPACE_WRITE })).error ?? '', /less confined/, 'chat links name the chat too');
		assert.match((await service.invokeTool('queue_send_now', { thread_id: 'loose', item_id: 'q1' }, { sessionId: 's1', sandbox: WORKSPACE_WRITE })).error ?? '', /less confined/);
		assert.strictEqual((await send('strict')).text, 'ran thread_send');
		assert.strictEqual((await send('peer')).text, 'ran thread_send');
		assert.strictEqual((await service.invokeTool('queue_edit', { item_id: 'q1', text: 'x' }, { sessionId: 's1', sandbox: WORKSPACE_WRITE })).text, 'ran queue_edit', 'its own queue');
		assert.strictEqual((await service.invokeTool('thread_interrupt', { thread_id: 'loose' }, { sessionId: 's1', sandbox: WORKSPACE_WRITE })).text, 'ran thread_interrupt', 'stopping a chat prompts nothing');
		// Unsandboxed callers message anyone.
		assert.strictEqual((await send('loose', { sessionId: 's1' })).text, 'ran thread_send');

		// Without the resolver the gate cannot judge the other chat: refused.
		service.setSandboxResolver(undefined);
		assert.match((await send('strict')).error ?? '', /less confined/);
		assert.deepStrictEqual(ran, ['thread_send', 'thread_send', 'queue_edit', 'thread_interrupt', 'thread_send']);
	});

	test('Ask mode refuses browser_evaluate without an approver, and asks the approver when there is one', async () => {
		const { service, modes, automated } = setup();
		modes.set('s1', 'ask');
		const refused = await service.invokeTool('browser_evaluate', { expression: 'document.title' }, { sessionId: 's1' });
		assert.match(refused.error ?? '', /not run: in Ask mode it needs the user's approval because it runs JavaScript/);
		assert.strictEqual(automated().length, 0);

		const asked: IVoltHostToolApproval[] = [];
		let allow = false;
		service.setApprover({ approve: async request => { asked.push(request); return allow; } });
		const denied = await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1' });
		assert.match(denied.error ?? '', /did not allow/);
		allow = true;
		const allowed = await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1' });
		assert.strictEqual(allowed.text, 'ran browser_evaluate');
		assert.strictEqual(asked.length, 2);
		assert.strictEqual(asked[0].mode, 'ask');
		assert.strictEqual(automated().length, 1);

		// Agent mode, or a mode the caller passes explicitly, decides too.
		modes.set('s1', 'agent');
		service.setApprover(undefined);
		assert.strictEqual((await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1' })).text, 'ran browser_evaluate');
		assert.ok((await service.invokeTool('browser_evaluate', { expression: '1' }, { sessionId: 's1', mode: 'plan' })).error);
	});

	test('a provider can require approval in every mode, and is told when it was given', async () => {
		const { service, modes } = setup();
		modes.set('s1', 'agent');
		const invoked: string[] = [];
		const approved: string[] = [];
		store.add(service.registerToolProvider({
			tools: [{ name: 'desktop_act', title: 'Acted', description: '', inputSchema: {} }],
			invoke: async name => { invoked.push(name); return { text: 'done' }; },
			needsApproval: async () => approved.length ? undefined : 'controls apps on your Mac',
			approved: (_name, _args, call) => { approved.push(call.sessionId!); },
		}));
		assert.match((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).error ?? '', /needs the user's approval/);
		assert.match((await service.invokeTool('desktop_act', {}, undefined)).error ?? '', /needs the user's approval/);
		let allow = false;
		const asked: IVoltHostToolApproval[] = [];
		service.setApprover({ approve: async request => { asked.push(request); return allow; } });
		assert.match((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).error ?? '', /did not allow desktop_act/);
		allow = true;
		assert.strictEqual((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).text, 'done');
		assert.strictEqual((await service.invokeTool('desktop_act', {}, { sessionId: 's1' })).text, 'done');
		assert.strictEqual(asked.length, 2, 'once approved, the provider stops asking');
		assert.strictEqual(asked[0].mode, 'agent');
		assert.deepStrictEqual(approved, ['s1']);
		assert.deepStrictEqual(invoked, ['desktop_act', 'desktop_act']);
		service.setApprover(undefined);
	});

	test('Plan mode judges clicks by the page the chat shows', async () => {
		const remote = setup({ pageUrl: 'https://mail.example.com/inbox' });
		remote.modes.set('s1', 'plan');
		assert.match((await remote.service.invokeTool('browser_click', { element: 'Delete', ref: 'e3' }, { sessionId: 's1' })).error ?? '', /mail\.example\.com/);
		assert.strictEqual((await remote.service.invokeTool('browser_snapshot', {}, { sessionId: 's1' })).text, 'ran browser_snapshot');

		const local = setup({ pageUrl: 'http://localhost:5173/' });
		local.modes.set('s1', 'plan');
		assert.strictEqual((await local.service.invokeTool('browser_click', { element: 'Add', ref: 'e3' }, { sessionId: 's1' })).text, 'ran browser_click');
	});

	test('passes cancellation through and only reports MCP calls to the transcript', async () => {
		const { service, automated } = setup();
		const seen: IVoltHostToolInvocation[] = [];
		store.add(service.onDidInvokeTool(call => seen.push(call)));
		const cancel = new CancellationTokenSource();
		await service.invokeTool('browser_snapshot', {}, { sessionId: 's1', token: cancel.token, source: 'mcp' });
		await service.invokeTool('browser_snapshot', {}, { sessionId: 's1', source: 'native' });
		assert.strictEqual(seen.length, 1);
		const options = automated()[0].args[3] as IVoltBrowserAutomationOptions;
		cancel.cancel();
		assert.strictEqual(options.token?.isCancellationRequested, true);
		assert.strictEqual((await service.invokeTool('browser_snapshot', {}, { sessionId: 's1', token: cancel.token })).error, 'Cancelled.');
		assert.ok((await service.invokeTool('browser_click', { element: 'x', ref: 'e1' })).error?.includes('need a Volt chat'));
		cancel.dispose();
	});

	test('image_inspect and browser_compare_image read images relative to the workspace', async () => {
		const reference = fill(createImage(120, 80, [243, 244, 246]), 20, 20, 60, 30, [255, 255, 255]);
		const png = dataUrlBytes(await encodeImage(reference, 'png')).bytes;
		const { service, automated } = setup({ files: new Map([['/ws/design/ref.png', png]]) });

		const inspected = await service.invokeTool('image_inspect', { path: 'design/ref.png', points: [{ x: 30, y: 30 }], crop: { x: 20, y: 20, w: 20, h: 10 } });
		assert.ok(inspected.text?.includes('Size: 120×80'), inspected.text);
		assert.ok(inspected.text?.includes('(30, 30) #ffffff'), inspected.text);
		assert.ok(inspected.text?.includes('x 20, y 20, 60×30 fill #ffffff'), inspected.text);
		assert.match(inspected.image ?? '', /^data:image\/png;base64,/);

		const compared = await service.invokeTool('browser_compare_image', { reference_path: 'design/ref.png' }, { sessionId: 's1' });
		assert.strictEqual(compared.text, 'ran browser_compare_image');
		const options = automated()[0].args[3] as IVoltBrowserAutomationOptions;
		assert.deepStrictEqual([options.reference?.width, options.reference?.height], [120, 80]);
		assert.strictEqual(options.referenceLabel, 'design/ref.png');

		assert.match((await service.invokeTool('image_inspect', { path: 'missing.png' })).error ?? '', /Could not read/);
	});

	test('screenshots come down to CSS pixels and the size cap', async () => {
		const retina = await encodeImage(createImage(800, 600, [10, 20, 30]), 'png');
		const css = await scaleScreenshot(retina, { maxSide: 1280, targetWidth: 400 });
		assert.deepStrictEqual([css.width, css.height, css.sourceWidth], [400, 300, 800]);
		assert.match(css.dataUrl, /^data:image\/jpeg;base64,/);
		const capped = await scaleScreenshot(retina, { maxSide: 256, format: 'webp' });
		assert.deepStrictEqual([capped.width, capped.height], [256, 192]);
		const crop = await scaleScreenshot(retina, { maxSide: 1280, targetWidth: 400, crop: { x: 100, y: 50, w: 50, h: 40 } });
		assert.deepStrictEqual([crop.width, crop.height], [50, 40]);
		const decoded = await decodeDataUrl(css.dataUrl);
		assert.ok(Math.abs(decoded.data[0] - 10) <= 3);
	});

	test('native browser tools mirror every browser and image host tool', () => {
		const { service } = setup();
		const tools = createBrowserTools(service);
		assert.deepStrictEqual(tools.map(tool => tool.name), VOLT_HOST_TOOLS.filter(tool => tool.group !== 'core').map(tool => tool.name));
		assert.ok(tools.find(tool => tool.name === 'browser_snapshot')?.parallelSafe);
		assert.ok(!tools.find(tool => tool.name === 'browser_click')?.parallelSafe);
	});

	test('native tools pass the chat, mode and abort signal', async () => {
		const { service, automated } = setup();
		const controller = new AbortController();
		const tool = createBrowserTools(service).find(item => item.name === 'browser_evaluate')!;
		const refused = await tool.execute({ expression: '1' }, { signal: controller.signal, sessionId: 's9', mode: 'ask' });
		assert.strictEqual(refused.isError, true);
		const ran = await tool.execute({ expression: '1' }, { signal: controller.signal, sessionId: 's9', mode: 'agent' });
		assert.strictEqual(ran.text, 'ran browser_evaluate');
		assert.strictEqual(automated()[0].args[0], 's9');
	});

	test('blocked browser access refuses every browser tool with a reason, without touching the page', async () => {
		const { service, automated, blocked } = setup();
		blocked.set('s1', 'chat');
		const refused = await service.invokeTool('browser_click', { element: 'Buy', ref: 'e2' }, { sessionId: 's1' });
		assert.match(refused.error ?? '', /^browser_click was not run: the user turned off browser access for agents in this chat\. Do not retry/);
		assert.match((await service.invokeTool('browser_navigate', { url: 'http://localhost:3000' }, { sessionId: 's1' })).error ?? '', /turned off browser access/);
		assert.strictEqual(automated().length, 0);

		// The setting blocks calls without a chat too (the visible pane's screenshot).
		blocked.set(undefined, 'setting');
		assert.match((await service.invokeTool('browser_screenshot', {})).error ?? '', /volt\.browser\.allowAgents/);

		// Other chats and non-browser tools are unaffected.
		assert.strictEqual((await service.invokeTool('browser_snapshot', {}, { sessionId: 's2' })).text, 'ran browser_snapshot');
		assert.strictEqual(automated().length, 1);
	});

	test('provider tools marked for approval ask in Ask and Plan modes and run freely in Agent mode', async () => {
		const { service, modes } = setup();
		const ran: string[] = [];
		store.add(service.registerToolProvider({
			tools: [
				{ name: 'device_tap', title: 'Tapped', description: '', inputSchema: {}, approvalInReadOnlyModes: 'taps on the device' },
				{ name: 'device_list', title: 'Listed', description: '', inputSchema: {} },
			],
			invoke: async name => { ran.push(name); return { text: `ran ${name}` }; },
		}));
		modes.set('s1', 'plan');
		assert.match((await service.invokeTool('device_tap', { x: 1, y: 2 }, { sessionId: 's1' })).error ?? '', /in Plan mode it needs the user's approval because it taps on the device/);
		assert.strictEqual((await service.invokeTool('device_list', {}, { sessionId: 's1' })).text, 'ran device_list');
		const asked: IVoltHostToolApproval[] = [];
		service.setApprover({ approve: async request => { asked.push(request); return true; } });
		assert.strictEqual((await service.invokeTool('device_tap', { x: 1, y: 2 }, { sessionId: 's1' })).text, 'ran device_tap');
		assert.strictEqual(asked[0].reason, 'taps on the device');
		modes.set('s1', 'agent');
		assert.strictEqual((await service.invokeTool('device_tap', { x: 1, y: 2 }, { sessionId: 's1' })).text, 'ran device_tap');
		assert.strictEqual(asked.length, 1);
		assert.deepStrictEqual(ran, ['device_list', 'device_tap', 'device_tap']);
	});

	test('PERM-FLOW-1: a network-off chat calling an extension\'s network tool is refused until the flow card allows it; for this chat holds until revoked, once is spent', async () => {
		const { service } = setup();
		const ran: string[] = [];
		const owner: IVoltHostToolOwner = { extensionId: 'acme.linear', label: 'Linear', firstParty: false, toolClass: 'network', declared: [{ id: 'tools.register' }, { id: 'net.connect', targets: ['api.linear.app'] }] };
		store.add(service.registerToolProvider({
			tools: [{ name: 'linear_sync', title: 'Synced', description: '', inputSchema: {} }, { name: 'linear_write', title: 'Wrote', description: '', inputSchema: {} }],
			invoke: async name => { ran.push(name); return { text: `ran ${name}` }; },
			owner,
		}));
		const offline = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		const sync = () => service.invokeTool('linear_sync', { issue: 'L-1' }, offline);
		// No one to ask: refused, saying why.
		assert.match((await sync()).error ?? '', /belongs to Linear, which can send what it is given to any host .* needs the user's approval/);

		const asked: IVoltHostFlowApproval[] = [];
		let answer: 'once' | 'chat' | undefined;
		service.setApprover({ approve: async () => false, approveFlow: async request => { asked.push(request); return answer; } });
		assert.match((await sync()).error ?? '', /did not allow sending this chat's content/);
		assert.deepStrictEqual(asked.map(request => [request.sessionId, request.name, request.extension, request.hosts]), [['s1', 'linear_sync', 'Linear', 'all']], 'unsandboxed extension code can reach anything: the card says so');

		answer = 'once';
		assert.strictEqual((await sync()).text, 'ran linear_sync');
		assert.deepStrictEqual(service.flowApprovals('s1'), [], 'once is spent by the call it allowed');
		answer = undefined;
		assert.ok((await sync()).error, 'asked again after once');

		answer = 'chat';
		assert.strictEqual((await sync()).text, 'ran linear_sync');
		answer = undefined;
		assert.strictEqual((await sync()).text, 'ran linear_sync', 'for this chat: not asked again');
		assert.ok((await service.invokeTool('linear_sync', {}, { sessionId: 's2', sandbox: WORKSPACE_WRITE })).error, 'only this chat');
		assert.deepStrictEqual(service.flowApprovals('s1').map(grant => [grant.kind, grant.scope.targets, grant.scope.hosts]), [['session', ['plugin:acme.linear@local'], ['*']]], 'visible');
		assert.strictEqual(service.revokeFlowApprovals('s1'), 1);
		assert.ok((await sync()).error, 'revocable');
		assert.strictEqual(asked.length, 6);

		// A chat with the network on is compatible: no card. Unsandboxed chats are not gated at all.
		assert.strictEqual((await service.invokeTool('linear_sync', {}, { sessionId: 's3', sandbox: { ...WORKSPACE_WRITE, network: true } })).text, 'ran linear_sync');
		assert.strictEqual((await service.invokeTool('linear_sync', {}, { sessionId: 's4', sandbox: { level: 'off', network: false } })).text, 'ran linear_sync');
		assert.strictEqual(asked.length, 6);

		// Shadow mode: the earlier rule (every unknown tool refused) acts, and the difference is recorded.
		const diffs: string[] = [];
		store.add(service.onDidShadowDiff(diff => diffs.push(`${diff.what}:${diff.legacy}:${diff.mode}`)));
		service.setPolicyAuthorityMode('shadow');
		assert.ok((await service.invokeTool('linear_sync', {}, { sessionId: 's3', sandbox: { ...WORKSPACE_WRITE, network: true } })).error);
		service.setPolicyAuthorityMode('enforce');
		assert.deepStrictEqual(diffs, ['linear_sync:deny:shadow']);
		assert.deepStrictEqual(ran, ['linear_sync', 'linear_sync', 'linear_sync', 'linear_sync', 'linear_sync']);
		service.setApprover(undefined);
	});

	test('UX-GRANT-2: "Allow for This Chat" on a flow card is kept in the grant store, holds after a restart, and goes when revoked there', async () => {
		const owner: IVoltHostToolOwner = { extensionId: 'acme.linear', label: 'Linear', firstParty: false, toolClass: 'network', declared: [{ id: 'tools.register' }, { id: 'net.connect', targets: ['api.linear.app'] }] };
		const offline = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		const kept: IGrant[] = [];
		const grantStore = { persist: async (grant: IGrant) => { kept.push(grant); }, revoke: async (ids: readonly string[]) => { ids.forEach(id => kept.splice(kept.findIndex(grant => grant.id === id), 1)); } };
		const serveLinear = (service: ReturnType<typeof setup>['service']) => store.add(service.registerToolProvider({ tools: [{ name: 'linear_sync', title: 'Synced', description: '', inputSchema: {} }], invoke: async () => ({ text: 'ran' }), owner }));

		const first = setup().service;
		serveLinear(first);
		first.setFlowGrantStore(grantStore);
		first.setApprover({ approve: async () => false, approveFlow: async () => 'chat' });
		assert.strictEqual((await first.invokeTool('linear_sync', {}, offline)).text, 'ran');
		assert.deepStrictEqual(kept.map(grant => [grant.subject, grant.kind, grant.sessionId]), [['chat:s1', 'session', 's1']], 'persisted as a session grant of the chat');

		// A restart: a new gate, the store's grants loaded, nobody to ask.
		const second = setup().service;
		serveLinear(second);
		second.setApprover({ approve: async () => false, approveFlow: async () => undefined });
		assert.ok((await second.invokeTool('linear_sync', {}, offline)).error, 'refused before the store is read');
		second.setStoredFlowGrants(kept);
		assert.strictEqual((await second.invokeTool('linear_sync', {}, offline)).text, 'ran', 'holds after the restart');
		// Revoked on the Access page: the store no longer has it.
		second.setStoredFlowGrants([]);
		assert.ok((await second.invokeTool('linear_sync', {}, offline)).error, 'gone when revoked');
		first.setApprover(undefined);
		second.setApprover(undefined);
	});

	test('PERM-FLOW-2: a sandboxed extension\'s tool flows are judged by its declared hosts plus the "Allow host" grants in the grant store (05-limitations #26)', async () => {
		const { service } = setup();
		const owner: IVoltHostToolOwner = { extensionId: 'acme.linear', label: 'Linear', firstParty: false, sandboxed: true, toolClass: 'network', declared: [{ id: 'tools.register' }, { id: 'net.connect', targets: ['api.linear.app'] }] };
		store.add(service.registerToolProvider({ tools: [{ name: 'linear_sync', title: 'Synced', description: '', inputSchema: {} }], invoke: async () => ({ text: 'ran' }), owner }));
		const chat = { sessionId: 's1', sandbox: { ...WORKSPACE_WRITE, allowedDomains: ['api.linear.app'] } };
		const sync = () => service.invokeTool('linear_sync', {}, chat);
		assert.strictEqual((await sync()).text, 'ran', 'its declared host is one the chat reaches');

		// The user allowed it another host (the broker's session grant of its host process).
		const allowHost: IGrant = { id: 'g-host', subject: extensionSubject('acme.linear', false), capability: 'net.connect@1', scope: { targets: ['paste.evil.com'] }, kind: 'session', sessionId: 'p:t3-run', source: 'user', grantedAt: 1, lastUsedAt: 1, epoch: 4 };
		const asked: IVoltHostFlowApproval[] = [];
		service.setApprover({ approve: async () => false, approveFlow: async request => { asked.push(request); return undefined; } });
		service.setStoredHostGrants([allowHost, { ...allowHost, id: 'g-chat', subject: 'chat:s1', scope: { targets: ['other.com'] } }]);
		assert.ok((await sync()).error, 'it can now send what it is given to paste.evil.com');
		assert.deepStrictEqual(asked.map(request => request.hosts), [['paste.evil.com']], 'the card names the granted host the chat does not reach');
		// Revoked on the Access page: the store no longer has it.
		service.setStoredHostGrants([]);
		assert.strictEqual((await sync()).text, 'ran');
		assert.strictEqual(asked.length, 1);
		service.setApprover(undefined);
	});

	test('PERM-FLOW-1: an extension tool whose class the gate can\'t judge without its arguments stays refused in a sandboxed chat', async () => {
		const { service } = setup();
		for (const toolClass of ['writes', 'reads', 'escapes', 'spawns', 'browser'] as const) {
			const registration = service.registerToolProvider({
				tools: [{ name: `ext_${toolClass}`, title: toolClass, description: '', inputSchema: {} }],
				invoke: async () => ({ text: 'ran' }),
				owner: { extensionId: 'acme.tools', label: 'Tools', firstParty: false, toolClass, declared: [] },
			});
			assert.ok((await service.invokeTool(`ext_${toolClass}`, {}, { sessionId: 's1', sandbox: { ...WORKSPACE_WRITE, network: true } })).error, toolClass);
			registration.dispose();
		}
	});

	test('DEV-SBX-11: the gate refuses a sandboxed chat\'s debug sessions, tasks, notebook kernels, ssh and editor commands before the IDE runs anything; the rest reaches it with the path rules', async () => {
		const { service } = setup();
		const calls: { name: string; args: Record<string, unknown>; call: IVoltHostToolCall | undefined }[] = [];
		store.add(service.registerToolProvider({
			tools: ['tests', 'debug', 'tasks', 'ide', 'code_nav', 'diagnostics', 'code_action', 'watch_job', 'unwatch_job'].map(name => ({ name, title: name, description: '', inputSchema: {} })),
			invoke: async (name, args, call) => { calls.push({ name, args, call }); return { text: `ran ${name}` }; },
		}));
		const sandboxed = { sessionId: 's1', sandbox: WORKSPACE_WRITE };
		const refused: [string, Record<string, unknown>, RegExp][] = [
			['debug', { op: 'start', program: 'a.js' }, /^debug was not run: this chat runs in Volt's sandbox, and debug \(op start\) would run outside it\. Run the program with your own shell tool instead/],
			['debug', { op: 'attach', port: 9229 }, /debug \(op attach\) would run outside it/],
			['debug', { op: 'evaluate', expression: 'process.env' }, /debug \(op evaluate\) would run outside it\. It would run code in a debug session outside the sandbox/],
			['debug', { op: 'breakpoints', path: 'a.js', line: 2, condition: 'x' }, /debug \(op breakpoints\) would run outside it/],
			['tasks', { op: 'run', name: 'build' }, /^tasks was not run: .*tasks \(op run\) would run outside it\. Run the task's command with your own shell tool instead/],
			['ide', { capability: 'notebook', op: 'run', args: { path: 'n.ipynb' } }, /ide \(notebook run\) would run outside it\. The notebook's kernel runs outside the sandbox/],
			['ide', { capability: 'remote', op: 'exec', args: { host: 'prod', command: 'ls' } }, /ide \(remote exec\) would run outside it\. ssh would run with the user's keys/],
			['ide', { capability: 'remote', op: 'hosts' }, /~\/\.ssh is a credential folder/],
			['ide', { capability: 'extensions', op: 'run', args: { command: 'workbench.action.terminal.new' } }, /ide \(extensions run\) would run outside it\. Editor and extension commands run outside the sandbox/],
			['ide', { capability: 'http', op: 'send', args: { method: 'POST', url: 'https://collector.example.net/x' } }, /^ide was not run: collector\.example\.net is not reachable: this chat's network is off/],
			['code_nav', { op: 'references', path: '/etc/passwd', line: 1, symbol: 'root' }, /^code_nav was not run: .*A sandboxed chat reads files only in its workspace/],
			['code_action', { op: 'rename', path: '.vscode/tasks.json', line: 1, symbol: 'x', new_name: 'y' }, /^code_action did not start: no file was changed/],
		];
		for (const [name, args, expected] of refused) {
			assert.match((await service.invokeTool(name, args, sandboxed)).error ?? '', expected, `${name} ${JSON.stringify(args)}`);
		}
		assert.deepStrictEqual(calls.map(item => item.name), [], 'the IDE ran none of them');

		const allowed: [string, Record<string, unknown>][] = [
			['tests', { op: 'run', targets: ['test/a.test.js'] }],
			['tests', { op: 'list' }],
			['debug', { op: 'state' }],
			['debug', { op: 'breakpoints', path: 'a.js', line: 2 }],
			['tasks', { op: 'list' }],
			['ide', { capability: 'git', op: 'branches' }],
			['ide', { capability: 'docker', op: 'ps' }],
			['code_nav', { op: 'references', path: 'src/a.ts', line: 1, symbol: 'x' }],
			['code_action', { op: 'rename', path: 'src/a.ts', line: 1, symbol: 'x', new_name: 'y' }],
			['watch_job', { title: 'build', check: 'test -f out/done' }],
		];
		for (const [name, args] of allowed) {
			assert.strictEqual((await service.invokeTool(name, args, sandboxed)).text, `ran ${name}`, `${name} ${JSON.stringify(args)}`);
		}
		assert.strictEqual(calls.length, allowed.length);
		// Each carries the gate's rules, for files the provider finds rather than files the agent named (a rename's other files).
		const rename = calls.find(item => item.name === 'code_action')!.call!;
		assert.ok(rename.readRefusal && rename.writeRefusal && rename.sandboxPaths);
		assert.strictEqual(await rename.writeRefusal('/ws/src/b.ts'), undefined);
		assert.match(await rename.writeRefusal('/ws/.git/hooks/pre-commit') ?? '', /./, 'a hook is not the chat\'s to write');
		assert.match(await rename.readRefusal!('/etc/passwd') ?? '', /./);
		assert.strictEqual(await rename.readRefusal!('/ws/src/b.ts'), undefined);
	});
});
