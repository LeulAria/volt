/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sandbox policy files on a launch: `~/.volt/sandbox.json` (trusted) and the workspace's
 * `.volt/sandbox.json` (narrow only) are read at every launch, through the real launcher, manager
 * and resolver. A recording backend stands in for Seatbelt/bubblewrap, so the test sees exactly
 * which resolved policy reaches a backend; runs on every platform. The real sandboxed run that
 * proves a repository's deny blocks is in `sandboxSecurity.test.ts` (POLFILE-REAL-1).
 */

import assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAdminPolicy } from '../../common/authority.js';
import { allEnforcement, ISandboxBackendCapabilities, SandboxUnavailableError } from '../../common/sandboxBackend.js';
import { IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { ISandboxBackend, ISandboxLaunchSpec } from '../../node/sandboxBackends.js';
import { sandboxCacheKey, VoltSandboxLauncher } from '../../node/sandboxLauncher.js';
import { SandboxManager } from '../../node/sandboxManager.js';
import { SandboxPolicyFiles } from '../../node/sandboxPolicyFiles.js';
import { resolveSandboxPolicy, sandboxHostFacts } from '../../node/sandboxResolver.js';

class RecordingBackend implements ISandboxBackend {
	readonly id = 'seatbelt' as const;
	readonly launched: IResolvedSandboxPolicy[] = [];

	async probe(): Promise<ISandboxBackendCapabilities> {
		return { backend: 'seatbelt', available: true, enforcement: allEnforcement('enforced'), notes: {}, details: ['recording backend'], diagnostics: [] };
	}

	async launch(policy: IResolvedSandboxPolicy, command: string, args: readonly string[]): Promise<ISandboxLaunchSpec> {
		this.launched.push(policy);
		return {
			command, args, env: { ...policy.env }, cwd: policy.cwd, extraStdio: [], extraStdioDirections: [],
			confirm: async () => ({ ok: false, error: 'the recording backend never runs anything' }),
			terminate: () => undefined,
			dispose: async () => undefined,
		};
	}
}

suite('Volt sandbox policy files on a launch (item 23)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let ws: string;
	let extra: string;
	let userFile: string;
	let backend: RecordingBackend;
	let admin: IAdminPolicy;
	const cacheDirs = new Set<string>();

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-polfile-')));
		ws = join(root, 'repo');
		extra = join(root, 'extra');
		userFile = join(root, 'user-sandbox.json');
		await fs.mkdir(join(ws, '.volt'), { recursive: true });
		await fs.mkdir(join(ws, 'private'));
		await fs.mkdir(extra);
		backend = new RecordingBackend();
		admin = {};
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
		const facts = await sandboxHostFacts();
		for (const key of cacheDirs) {
			await fs.rm(join(facts.home, '.volt', 'sandbox-cache', key), { recursive: true, force: true });
		}
		cacheDirs.clear();
	});

	function launcher(): VoltSandboxLauncher {
		const manager = new SandboxManager(undefined, { backend, runRoot: join(root, 'runs') });
		return disposables.add(new VoltSandboxLauncher(join(root, 'user-data'), { info: () => undefined, warn: () => undefined }, {
			manager,
			admin: async () => admin,
			executionHost: 'test',
			policyFiles: new SandboxPolicyFiles(userFile),
		}));
	}

	function request(extraFields: Partial<IVoltSandboxRequest> = {}): IVoltSandboxRequest {
		const value: IVoltSandboxRequest = { level: 'workspace-write', network: false, providerId: 'mystery-acp', workspaceRoots: [ws], allowedDomains: ['a.example.com', 'b.example.com'], ...extraFields };
		cacheDirs.add(sandboxCacheKey(value));
		return value;
	}

	async function prepare(l: VoltSandboxLauncher, r: IVoltSandboxRequest = request()) {
		return l.prepare('/bin/echo', ['hi'], r, { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin', HOME: root } });
	}

	const writeUser = (value: unknown) => fs.writeFile(userFile, typeof value === 'string' ? value : JSON.stringify(value, undefined, '\t'));
	const writeRepo = (value: unknown) => fs.writeFile(join(ws, '.volt', 'sandbox.json'), typeof value === 'string' ? value : JSON.stringify(value, undefined, '\t'));

	test('POLFILE-USER-2: the user\'s file alone widens a real launch; without it nothing changes', async () => {
		const l = launcher();
		const before = await prepare(l);
		before.dispose();
		await writeUser({ schemaVersion: 1, filesystem: { write: [extra] }, network: { allow: ['example.com'], listenPorts: [4321] } });
		const launch = await prepare(l);
		try {
			const [plain, widened] = backend.launched;
			assert.ok(!plain.write.includes(extra) && widened.write.includes(extra), 'the folder is writable only with the file');
			assert.ok(!plain.network.allow.includes('example.com') && widened.network.allow.includes('example.com'));
			assert.ok(widened.network.listenPorts?.includes(4321));
			assert.deepStrictEqual(launch.warnings.filter(line => /sandbox\.json/.test(line)), [], 'nothing ignored, nothing to say');
		} finally {
			launch.dispose();
		}
	});

	test('POLFILE-REPO-2: the repository\'s file alone narrows a real launch, and its widenings are listed in the chat', async () => {
		// The home folder is not writable for an agent (the workspace and temp folders are).
		const elsewhere = join((await sandboxHostFacts()).home, 'volt-polfile-elsewhere');
		await writeRepo({ schemaVersion: 1, filesystem: { deny: ['${workspace}/private'], write: ['${home}/volt-polfile-elsewhere', '${workspace}'] }, network: { mode: 'host', allow: ['a.example.com', 'evil.example.net'] } });
		const l = launcher();
		const launch = await prepare(l);
		try {
			const resolved = backend.launched[0];
			assert.ok(resolved.deny.includes(join(ws, 'private')), 'the repository\'s deny');
			assert.deepStrictEqual([resolved.network.mode, resolved.network.allow], ['proxy', ['a.example.com']]);
			assert.ok(!resolved.write.includes(elsewhere) && !resolved.writeFiles.includes(elsewhere));
			const line = launch.warnings.find(warning => warning.startsWith('Ignored from .volt/sandbox.json:'));
			assert.ok(line && line.includes('network.mode host') && line.includes('network.allow evil.example.net') && line.includes(`filesystem.write ${elsewhere}`), line);
			const info = await l.policyFilesInfo(request());
			assert.deepStrictEqual(info.files.map(file => [file.source, file.state]), [['workspace', 'loaded']]);
			assert.deepStrictEqual(info.ignored.map(note => `${note.source} ${note.field} ${note.value}`).sort(), [`workspace filesystem.write ${elsewhere}`, 'workspace network.allow evil.example.net', 'workspace network.mode host']);
			assert.strictEqual(info.refusal, undefined);
		} finally {
			launch.dispose();
		}
	});

	test('POLFILE-ALL-2: user, repository and managed policy together; the managed policy beats both', async () => {
		await writeUser({ schemaVersion: 1, filesystem: { write: [extra] }, network: { allow: ['blocked.example.net', 'api.example.org', 'blocked2.example.net'] } });
		await writeRepo({ schemaVersion: 1, filesystem: { deny: ['${workspace}/private'] }, network: { allow: ['api.example.org', 'a.example.com', 'blocked2.example.net'] } });
		admin = { denyHosts: ['blocked.example.net', 'blocked2.example.net'], denyCapabilities: ['files.write'] };
		const l = launcher();
		// `files.write` denied: only a read-only chat launches, and the user's writable folder goes.
		await assert.rejects(prepare(l), SandboxUnavailableError);
		const launch = await prepare(l, request({ level: 'read-only' }));
		try {
			const resolved = backend.launched[0];
			assert.ok(!resolved.write.includes(extra), 'the managed policy dropped the user\'s folder');
			assert.deepStrictEqual([...resolved.network.allow].sort(), ['a.example.com', 'api.example.org'], 'the user\'s host and the chat\'s, as far as the repository kept them; never a managed deny');
			assert.ok(resolved.deny.includes(join(ws, 'private')));
			const line = launch.warnings.find(warning => warning.startsWith('Ignored from ~/.volt/sandbox.json:'));
			assert.ok(line && line.includes('network.allow blocked.example.net') && line.includes(`filesystem.write ${extra}`) && /organization/.test(line), line);
			assert.ok(launch.warnings.some(warning => warning.startsWith('Ignored from .volt/sandbox.json:') && warning.includes('network.allow blocked2.example.net')), 'the repository cannot bring back what the managed policy dropped');
		} finally {
			launch.dispose();
		}
	});

	test('POLFILE-ERR-1: a broken user file refuses the launch, naming the file and the line; nothing reaches a backend', async () => {
		const l = launcher();
		await writeUser('{\n\t"schemaVersion": 1,\n\t"network": { "mode": "proxy" "allow": [] }\n}');
		await assert.rejects(prepare(l), (err: unknown) => err instanceof SandboxUnavailableError && err.message.includes(userFile) && /line 3: not valid JSON/.test(err.message));
		await writeUser('{\n\t"schemaVersion": 1,\n\t"filesystem": {\n\t\t"write": ["~/scratch"]\n\t}\n}');
		await assert.rejects(prepare(l), (err: unknown) => err instanceof SandboxUnavailableError && /line 4: filesystem\.write\[0\] must be absolute/.test(err.message));
		assert.strictEqual(backend.launched.length, 0);
		assert.strictEqual(l.livePrincipals, 0);
		const info = await l.policyFilesInfo(request());
		assert.match(info.refusal ?? '', /line 4/);
		assert.deepStrictEqual(info.files.map(file => [file.source, file.state]), [['user', 'error']]);
		// Fixed: the next launch runs.
		await writeUser({ schemaVersion: 1 });
		(await prepare(l)).dispose();
		assert.strictEqual(backend.launched.length, 1);
	});

	test('POLFILE-ERR-2: a broken, linked or special repository file is ignored with a warning, never a refusal or a hang', async () => {
		const repoFile = join(ws, '.volt', 'sandbox.json');
		const cases: [string, () => Promise<void>, RegExp][] = [
			['syntax', () => writeRepo('{ "schemaVersion": 1, }'), /line 1: not valid JSON/],
			['schema', () => writeRepo({ schemaVersion: 1, network: { mode: 'everything' } }), /network\.mode must be one of/],
			['symlink', async () => { await fs.rm(repoFile, { force: true }); await fs.writeFile(join(root, 'elsewhere.json'), '{"schemaVersion":1}'); await fs.symlink(join(root, 'elsewhere.json'), repoFile); }, /symbolic link/],
			['directory', async () => { await fs.rm(repoFile, { force: true }); await fs.mkdir(repoFile); }, /not a regular file/],
		];
		if (process.platform !== 'win32') {
			cases.push(['fifo', async () => { await fs.rm(repoFile, { recursive: true, force: true }); execFileSync('mkfifo', [repoFile]); }, /not a regular file/]);
		}
		const l = launcher();
		for (const [name, make, problem] of cases) {
			await make();
			const launch = await prepare(l);
			try {
				const warning = launch.warnings.find(line => line.startsWith('Volt ignored'));
				assert.ok(warning && warning.includes(repoFile) && problem.test(warning), `${name}: ${warning}`);
			} finally {
				launch.dispose();
			}
			await fs.rm(repoFile, { recursive: true, force: true });
		}
		assert.strictEqual(backend.launched.length, cases.length, 'every launch ran');
	});

	test('POLFILE-CACHE-1: read at every launch, parsed again only after a change; a warm read costs under 1 ms', async () => {
		await writeUser({ schemaVersion: 1, network: { allow: ['example.com'] } });
		await writeRepo({ schemaVersion: 1, filesystem: { deny: ['${workspace}/private'] } });
		const files = new SandboxPolicyFiles(userFile);
		const home = (await sandboxHostFacts()).home;
		const first = await files.read(home, [ws], {});
		assert.deepStrictEqual(first.files.map(file => file.state), ['loaded', 'loaded']);
		const rounds = 500;
		const start = performance.now();
		for (let i = 0; i < rounds; i++) {
			await files.read(home, [ws], {});
		}
		// Measured 0.026 ms per launch for both files on an M-series Mac (2026-11-09).
		const warm = (performance.now() - start) / rounds;
		assert.ok(warm < 1, `a warm read takes ${warm.toFixed(3)} ms`);
		// An edit (same size, new content) is picked up at the next launch.
		await writeUser({ schemaVersion: 1, network: { allow: ['example.org'] } });
		const edited = await files.read(home, [ws], {});
		assert.deepStrictEqual(edited.layers[0].layer.network?.allow, ['example.org']);
		await fs.rm(userFile);
		assert.deepStrictEqual((await files.read(home, [ws], {})).files.map(file => file.source), ['workspace'], 'a removed file is gone at once');
	});

	test('POLFILE-B32-2: a narrowed write that resolves outside through a symlink is dropped at load and refused by the resolver in a race', async () => {
		const outside = await fs.mkdtemp(join(root, 'outside-'));
		await fs.mkdir(join(ws, 'src'));
		await fs.symlink('/usr', join(ws, 'link'));
		await writeRepo({ schemaVersion: 1, filesystem: { write: ['${workspace}/link', '${workspace}/src'] } });
		const l = launcher();
		const launch = await prepare(l);
		try {
			const resolved = backend.launched[0];
			assert.ok(!resolved.write.some(path => path === '/usr' || path.startsWith('/usr/')), 'the link\'s target is not writable');
			assert.ok(resolved.write.includes(join(ws, 'src')), 'the plain sub-folder is');
			assert.ok(launch.warnings.some(line => line.includes(`filesystem.write ${join(ws, 'link')}`) && /symlink/.test(line)), launch.warnings.join('\n'));
		} finally {
			launch.dispose();
		}
		// The race: the check above saw a folder, and by the time the resolver looks it is a symlink.
		await fs.mkdir(join(ws, 'swapped'));
		const policy = { ...builtinProfile('workspace'), filesystem: { ...builtinProfile('workspace').filesystem, write: [join(ws, 'swapped')] } };
		const facts = await sandboxHostFacts();
		const context = { workspaceRoots: [ws], hostEnv: { PATH: '/usr/bin:/bin' }, contained: [{ field: 'filesystem.write' as const, path: join(ws, 'swapped'), within: [ws] }] };
		await resolveSandboxPolicy(policy, context, facts, await fs.mkdtemp(join(root, 'run-')));
		await fs.rm(join(ws, 'swapped'), { recursive: true });
		await fs.symlink(outside, join(ws, 'swapped'));
		await assert.rejects(resolveSandboxPolicy(policy, context, facts, await fs.mkdtemp(join(root, 'run-'))), (err: unknown) => err instanceof SandboxUnavailableError && /resolves to .*outside what that layer could narrow/.test(err.message));
	});
});
