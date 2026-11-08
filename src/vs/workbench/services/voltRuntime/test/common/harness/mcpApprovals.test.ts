/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { canonicalJson, IVoltMcpApprovalRecord, mcpConfigDigest, mcpEffectiveConfig, mcpServerSpec, VoltMcpApprovalStore } from '../../../common/harness/mcpApprovals.js';
import { McpServerConfig, mergeMcpServerEntries } from '../../../common/harness/mcpConfig.js';

const server: McpServerConfig = { name: 'x', kind: 'stdio', command: 'node', args: ['server.js'], env: { B: '2', A: '1' }, cwd: '/repo' };

suite('Volt MCP approvals: digest', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('canonical JSON sorts keys at every level and drops undefined', () => {
		assert.strictEqual(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
		assert.strictEqual(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
	});

	test('the digest is SHA-256 of the canonical {command, args, env, cwd, binary}', async () => {
		// printf '%s' '{"args":["server.js"],"binary":"/usr/bin/node","command":"node","cwd":"/repo","env":{"A":"1","B":"2"},"kind":"stdio"}' | shasum -a 256
		assert.strictEqual(await mcpConfigDigest(server, '/usr/bin/node'), '5eab439424d8ae4f6db4d3cef596c4da033aa49b22f9779ea8264bb29073a825');
	});

	test('every pinned field changes the digest; key order and the name do not', async () => {
		const base = await mcpConfigDigest(server, '/usr/bin/node');
		const variants: [string, McpServerConfig, string | undefined][] = [
			['command', { ...server, command: 'nodejs' }, '/usr/bin/node'],
			['args', { ...server, args: ['server.js', '--x'] }, '/usr/bin/node'],
			['arg order', { ...server, args: ['--x', 'server.js'] }, '/usr/bin/node'],
			['env value', { ...server, env: { A: '1', B: '3' } }, '/usr/bin/node'],
			['env name', { ...server, env: { A: '1', B: '2', C: '' } }, '/usr/bin/node'],
			['cwd', { ...server, cwd: '/other' }, '/usr/bin/node'],
			['binary', server, '/tmp/node'],
			['no binary', server, undefined],
		];
		const digests = new Set([base]);
		for (const [label, config, binary] of variants) {
			const digest = await mcpConfigDigest(config, binary);
			assert.ok(!digests.has(digest), `${label} changes the digest`);
			digests.add(digest);
		}
		assert.strictEqual(await mcpConfigDigest({ ...server, name: 'renamed', env: { A: '1', B: '2' } }, '/usr/bin/node'), base);
		assert.notStrictEqual(await mcpConfigDigest({ name: 'h', kind: 'http', url: 'https://a.example/mcp', headers: { X: '1' } }, undefined), await mcpConfigDigest({ name: 'h', kind: 'http', url: 'https://a.example/mcp', headers: { X: '2' } }, undefined));
	});

	test('the spec shows env and header names, never values, and the effective working folder', () => {
		const spec = mcpServerSpec(mcpEffectiveConfig({ ...server, cwd: undefined }, URI.file('/project')), '/usr/bin/node');
		assert.deepStrictEqual(spec, { kind: 'stdio', command: 'node', args: ['server.js'], envNames: ['A', 'B'], cwd: URI.file('/project').fsPath, binary: '/usr/bin/node' });
		assert.deepStrictEqual(mcpServerSpec({ name: 'h', kind: 'http', url: 'https://a.example', headers: { Authorization: 'secret' } }, undefined), { kind: 'http', url: 'https://a.example', headerNames: ['Authorization'] });
	});

	test('MCP-1: user entries win over project entries whatever the read order; volt is never taken', () => {
		const entry = (name: string, scope: 'project' | 'user', command: string) => ({ config: { name, kind: 'stdio' as const, command, args: [], env: {} }, scope });
		const merged = mergeMcpServerEntries([entry('github', 'project', 'evil'), entry('volt', 'project', 'evil'), entry('github', 'user', 'good'), entry('docs', 'project', 'docs')]);
		assert.deepStrictEqual(merged.map(item => [item.config.name, item.scope, item.config.kind === 'stdio' && item.config.command]), [['github', 'user', 'good'], ['docs', 'project', 'docs']]);
	});
});

suite('Volt MCP approvals: store', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const FILE = URI.file('/userData/voltMcpApprovals.json');

	async function setup() {
		const disposables = store.add(new DisposableStore());
		const files = disposables.add(new FileService(new NullLogService()));
		disposables.add(files.registerProvider('file', disposables.add(new InMemoryFileSystemProvider())));
		await files.createFolder(URI.file('/userData'));
		return { files, approvals: new VoltMcpApprovalStore(FILE, files, new NullLogService()) };
	}

	const record = (root: string, name: string, digest: string, decision: 'allow' | 'deny' = 'allow'): IVoltMcpApprovalRecord =>
		({ root, name, digest, decision, spec: { kind: 'stdio', command: 'c', args: [], envNames: [], cwd: root }, at: 1 });

	test('a decision holds only for its digest, one per (folder, name)', async () => {
		const { approvals } = await setup();
		await approvals.set(record('/a', 'tool', 'd1'));
		assert.strictEqual((await approvals.decision('/a', 'tool', 'd1'))?.decision, 'allow');
		assert.strictEqual(await approvals.decision('/a', 'tool', 'd2'), undefined);
		assert.strictEqual(await approvals.decision('/b', 'tool', 'd1'), undefined, 'another folder');
		assert.strictEqual(await approvals.decision('/a', 'other', 'd1'), undefined, 'another name');
		await approvals.set(record('/a', 'tool', 'd2'));
		assert.strictEqual(await approvals.decision('/a', 'tool', 'd1'), undefined, 'the old approval is gone');
		assert.strictEqual((await approvals.latest('/a', 'tool'))?.digest, 'd2');
		assert.strictEqual((await approvals.list()).length, 1);
	});

	test('writes replace the file through a temporary file, concurrent writes all land', async () => {
		const { files, approvals } = await setup();
		await Promise.all([approvals.set(record('/a', 'one', 'd')), approvals.set(record('/a', 'two', 'd')), approvals.set(record('/b', 'one', 'd', 'deny'))]);
		assert.deepStrictEqual((await approvals.list()).map(item => `${item.root}:${item.name}:${item.decision}`).sort(), ['/a:one:allow', '/a:two:allow', '/b:one:deny']);
		const children = (await files.resolve(URI.file('/userData'))).children?.map(child => child.name);
		assert.deepStrictEqual(children, ['voltMcpApprovals.json'], 'no temporary file left behind');
		await approvals.remove('/a', 'one');
		assert.deepStrictEqual((await approvals.list()).map(item => `${item.root}:${item.name}`).sort(), ['/a:two', '/b:one']);
		await approvals.remove('/a');
		assert.deepStrictEqual((await approvals.list()).map(item => `${item.root}:${item.name}`), ['/b:one']);
	});

	test('a malformed or foreign file approves nothing', async () => {
		const { files, approvals } = await setup();
		await files.writeFile(FILE, VSBuffer.fromString('{not json'));
		assert.deepStrictEqual(await approvals.list(), []);
		await files.writeFile(FILE, VSBuffer.fromString(JSON.stringify({ version: 1, approvals: [{ root: '/a', name: 'x', digest: 'd', decision: 'yes', spec: {} }, { root: '/a' }] })));
		assert.deepStrictEqual(await approvals.list(), []);
		assert.strictEqual(await approvals.decision('/a', 'x', 'd'), undefined);
	});
});
