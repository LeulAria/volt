/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The launcher on the Policy Authority (spec M.3 C2 step 4, F.5): principal from the registry ->
 * `evaluateLaunch` -> compile -> backend. A recording backend stands in for Seatbelt/bubblewrap, so
 * the test sees exactly which policies reach a backend; the launcher, the SandboxManager and the
 * resolver are the real ones. Runs on every platform (nothing is spawned).
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IAdminPolicy, PolicyAuthorityMode } from '../../common/authority.js';
import { launchPolicyBytes, launchPolicyDigest, replayLaunchCompile } from '../../common/compile.js';
import { allEnforcement, ISandboxBackendCapabilities, SandboxUnavailableError } from '../../common/sandboxBackend.js';
import { agentSandboxPolicy, IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';
import { ISandboxBackend, ISandboxLaunchSpec } from '../../node/sandboxBackends.js';
import { launchSubject, sandboxCacheKey, VoltSandboxLauncher } from '../../node/sandboxLauncher.js';
import { SandboxManager } from '../../node/sandboxManager.js';
import { SandboxPolicyFiles } from '../../node/sandboxPolicyFiles.js';
import { sandboxHostFacts } from '../../node/sandboxResolver.js';

class RecordingBackend implements ISandboxBackend {
	readonly id = 'seatbelt' as const;
	readonly launched: IResolvedSandboxPolicy[] = [];
	probes = 0;

	async probe(): Promise<ISandboxBackendCapabilities> {
		this.probes++;
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

suite('Volt sandbox launcher on the Policy Authority (C2 step 4)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let ws: string;
	let backend: RecordingBackend;
	let mode: PolicyAuthorityMode;
	let admin: IAdminPolicy;
	const warnings: string[] = [];
	const cacheDirs = new Set<string>();

	setup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-launch-auth-')));
		ws = join(root, 'repo');
		await fs.mkdir(ws);
		backend = new RecordingBackend();
		mode = 'enforce';
		admin = {};
		warnings.length = 0;
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
		return disposables.add(new VoltSandboxLauncher(join(root, 'user-data'), { info: () => undefined, warn: message => warnings.push(message) }, {
			manager,
			mode: () => mode,
			admin: async () => admin,
			executionHost: 'test',
			// Not the developer's own `~/.volt/sandbox.json`.
			policyFiles: new SandboxPolicyFiles(join(root, 'no-user-policy.json')),
		}));
	}

	function request(extra: Partial<IVoltSandboxRequest> = {}): IVoltSandboxRequest {
		const value: IVoltSandboxRequest = { level: 'workspace-write', network: false, providerId: 'mystery-acp', workspaceRoots: [ws], ...extra };
		cacheDirs.add(sandboxCacheKey(value));
		return value;
	}

	async function prepare(l: VoltSandboxLauncher, r: IVoltSandboxRequest) {
		return l.prepare('/bin/echo', ['hi'], r, { cwd: ws, hostEnv: { PATH: '/usr/bin:/bin', HOME: root } });
	}

	test('LAUNCH-AUTH-1: a launch the Authority denies never reaches a backend', async () => {
		admin = { denyCapabilities: ['files.write'] };
		const l = launcher();
		const facts = await sandboxHostFacts();
		const r = request();
		await assert.rejects(prepare(l, r), (err: unknown) => err instanceof SandboxUnavailableError && /sandbox policy refused this launch/.test(err.message) && err.status === 'unavailable');
		assert.strictEqual(backend.launched.length, 0, 'no policy reached the backend');
		assert.strictEqual(backend.probes, 0, 'the backend was not even probed');
		await assert.rejects(fs.stat(join(facts.home, '.volt', 'sandbox-cache', sandboxCacheKey(r))), 'no package cache was created for it');
		assert.strictEqual(l.livePrincipals, 0, 'its principal was retired');
		assert.strictEqual(l.shadowDiffs.length, 1);
		assert.strictEqual(l.shadowDiffs[0].kind, 'refused');
		assert.strictEqual(l.shadowDiffs[0].decision.deniedBy, 'admin');
		assert.strictEqual(l.shadowDiffs[0].mode, 'enforce');

		// The floor refuses a credential folder as an allowed one, whatever the managed policy says.
		admin = {};
		const floor = launcher();
		await assert.rejects(prepare(floor, request({ extraWritableRoots: [join(facts.home, '.ssh')] })), SandboxUnavailableError);
		assert.strictEqual(floor.shadowDiffs[0].decision.deniedBy, 'floor');
		assert.strictEqual(backend.launched.length, 0);
	});

	test('enforce: an allowed launch runs the compiled policy, the principal is sealed with the resolved hash', async () => {
		const l = launcher();
		const r = request({ allowedDomains: ['example.com'] });
		const launch = await prepare(l, r);
		try {
			assert.strictEqual(backend.launched.length, 1);
			assert.strictEqual(launch.principal.subject, launchSubject(r));
			assert.strictEqual(launch.principal.kind, 'agent');
			assert.strictEqual(launch.principal.executionHost, 'test');
			assert.match(launch.principal.launchPolicyHash, /^[0-9a-f]{64}$/, 'SHA-256 of the resolved policy');
			assert.ok(Object.isFrozen(launch.principal));
			assert.strictEqual(l.shadowDiffs.length, 0, 'no difference from the earlier composition');
			assert.strictEqual(l.livePrincipals, 1);
			// POL-DET-1 against the launcher's own compile log.
			const [record] = l.compileLog;
			const replayed = replayLaunchCompile(JSON.parse(JSON.stringify(record)), { allow: true, epoch: record.input.epoch, reason: 'allowed', requests: [] });
			assert.strictEqual(launchPolicyDigest(replayed.policy), record.policyDigest);
			assert.strictEqual(launchPolicyBytes(replayed.policy), launchPolicyBytes(agentSandboxPolicy(record.input.request, record.input.host)));
		} finally {
			launch.dispose();
		}
		assert.strictEqual(l.livePrincipals, 0, 'disposing the launch retires its principal');
	});

	test('shadow: the earlier composition acts and the Authority\'s refusal is recorded', async () => {
		mode = 'shadow';
		admin = { denyHosts: ['registry.npmjs.org'] };
		const l = launcher();
		const launch = await prepare(l, request());
		try {
			assert.strictEqual(backend.launched.length, 1, 'shadow mode runs what the earlier rules allowed');
			assert.strictEqual(l.shadowDiffs.length, 1);
			assert.deepStrictEqual([l.shadowDiffs[0].kind, l.shadowDiffs[0].mode, l.shadowDiffs[0].decision.code, l.shadowDiffs[0].decision.denied?.target], ['refused', 'shadow', 'admin-host', 'registry.npmjs.org']);
			assert.ok(warnings.some(line => line.includes('policy authority shadow') && line.includes('the earlier composition acted')), 'logged');
		} finally {
			launch.dispose();
		}
	});

	test('epochs: an invalidation drops cached compiles and the next launch judges the new policy', async () => {
		const l = launcher();
		const r = request();
		(await prepare(l, r)).dispose();
		(await prepare(l, r)).dispose();
		assert.deepStrictEqual([l.cacheStats.hits, l.cacheStats.misses, l.cacheStats.size], [1, 1, 1], 'the second launch of the same input is a cache hit');
		const epoch = l.invalidate({ admin: { denyCapabilities: ['net.connect'] } });
		assert.strictEqual(l.cacheStats.size, 0);
		assert.strictEqual(l.cacheStats.epoch, epoch);
		await assert.rejects(prepare(l, r), SandboxUnavailableError);
		assert.strictEqual(backend.launched.length, 2, 'the refused launch after the change reached no backend');
		assert.strictEqual(l.shadowDiffs.at(-1)?.decision.epoch, epoch, 'judged at the new epoch');
		l.invalidate({ admin: {} });
		(await prepare(l, r)).dispose();
		assert.strictEqual(backend.launched.length, 3);
	});
});
