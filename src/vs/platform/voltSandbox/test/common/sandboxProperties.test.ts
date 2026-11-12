/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * K.2 property tests (POL-PROP-1..8, INV-18): the composition and agent-policy laws, checked on
 * inputs from a seeded generator (fast-check is not a dependency). Every run uses the same seeds,
 * so a failure names the seed and the input that broke the law; `VOLT_PROPERTY_RUNS` raises the
 * count for a nightly run.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { evaluateCapabilities } from '../../common/sandboxCapabilities.js';
import { allowCovers, composeSandboxPolicy, entryInside, ISandboxLayer, SandboxLayerSource } from '../../common/sandboxComposition.js';
import { agentSandboxPolicy, IAgentSandboxHost, IVoltSandboxRequest } from '../../common/sandboxPolicy.js';
import { builtinProfile, CREDENTIAL_HOME_PATHS, credentialDenyEntries, isSecretEnvName, SandboxProfileId } from '../../common/sandboxProfiles.js';
import { IVoltSandboxPolicy, IVoltSandboxPolicyLayer, SANDBOX_DIMENSIONS, SANDBOX_NETWORK_MODES, SandboxDimension } from '../../common/sandboxSchema.js';

const RUNS = Number(process.env.VOLT_PROPERTY_RUNS) || 1000;

/** Mulberry32: small, fast and the same on every platform. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

class Gen {
	constructor(private readonly next: () => number) { }
	int(max: number): number { return Math.floor(this.next() * max); }
	bool(p = 0.5): boolean { return this.next() < p; }
	pick<T>(values: readonly T[]): T { return values[this.int(values.length)]; }
	some<T>(values: readonly T[], max = 4): T[] { return [...new Set(Array.from({ length: this.int(max + 1) }, () => this.pick(values)))]; }
}

/** Run `law` on RUNS seeds; a failure says which seed. */
function forAll(name: string, law: (gen: Gen, seed: number) => void): void {
	for (let seed = 1; seed <= RUNS; seed++) {
		try {
			law(new Gen(rng(seed * 7919)), seed);
		} catch (err) {
			throw new Error(`${name} failed for seed ${seed}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

const PATHS = ['${workspace}', '${workspace}/src', '${workspace}/src/a', '${workspace}/link', '${workspace}/link/x', '${tmp}', '${tmp}/x', '${system}', '${path}', '${home}/.ssh', '${home}/notes', '/opt/tools', '/opt/tools/bin', '/etc', '/', '/ws', '/ws/link', '/ws/link/deep', '/ws/src', '/outside', '/outside/x'];
const HOSTS = ['*', 'example.com', '*.example.com', 'api.example.com', 'evil.com', 'evil.com:6379', 'example.com:8443', 'api.example.com:443', 'example.com:80', '10.0.0.1', '*.github.com', 'github.com:22'];
const PORTS = [22, 80, 443, 3000, 5432, 6379, 8080];
const ENV = ['*', 'PATH', 'HOME', 'LANG', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'STRIPE_KEY', 'MY_PAT', 'NODE_OPTIONS', 'VOLT_SANDBOX_X', 'HTTPS_PROXY', 'CARGO_HOME'];
const SOCKETS = ['/var/run/docker.sock', '/tmp/a.sock', '${tmp}/b.sock'];
const SOURCES: readonly SandboxLayerSource[] = ['user', 'workspace', 'execution'];

/** `/ws/link` is a symlink to `/outside`; everything else is its own real path. */
function realpath(path: string): string | undefined {
	if (path === '/ws/link' || path.startsWith('/ws/link/')) {
		return `/outside${path.slice('/ws/link'.length)}`;
	}
	return path;
}

function randomLayer(gen: Gen): IVoltSandboxPolicyLayer {
	const layer: { -readonly [K in keyof IVoltSandboxPolicyLayer]: IVoltSandboxPolicyLayer[K] } = { schemaVersion: 1 };
	if (gen.bool(0.7)) {
		layer.filesystem = {
			...(gen.bool() ? { read: gen.some(PATHS) } : {}),
			...(gen.bool() ? { write: gen.some(PATHS.filter(path => path !== '/' && path !== '${system}' && path !== '${path}')) } : {}),
			...(gen.bool(0.3) ? { deny: gen.some(PATHS) } : {}),
			...(gen.bool(0.3) ? { protect: gen.some(PATHS) } : {}),
			...(gen.bool(0.2) ? { unmask: gen.some(['${home}/.ssh', '${home}/.aws']) } : {}),
		};
	}
	if (gen.bool(0.7)) {
		layer.network = {
			...(gen.bool() ? { mode: gen.pick(SANDBOX_NETWORK_MODES) } : {}),
			...(gen.bool() ? { allow: gen.some(HOSTS) } : {}),
			...(gen.bool(0.4) ? { loopbackPorts: gen.some(PORTS) } : {}),
			...(gen.bool(0.4) ? { listen: gen.bool() } : {}),
			...(gen.bool(0.4) ? { listenPorts: gen.some(PORTS) } : {}),
		};
	}
	if (gen.bool(0.4)) {
		layer.env = { ...(gen.bool() ? { inherit: gen.some(ENV) } : {}), ...(gen.bool() ? { set: { LANG: 'C', NODE_OPTIONS: '--inspect', VOLT_SANDBOX_X: '1' } } : {}) };
	}
	if (gen.bool(0.3)) {
		layer.host = { ...(gen.bool() ? { unixSockets: gen.some(SOCKETS) } : {}), ...(gen.bool() ? { systemServices: gen.bool() } : {}) };
	}
	if (gen.bool(0.3)) {
		layer.process = { limits: { ...(gen.bool() ? { cpuSeconds: 1 + gen.int(1000) } : {}), ...(gen.bool() ? { memoryMB: 16 + gen.int(4096) } : {}) } };
	}
	if (gen.bool(0.3)) {
		layer.bestEffort = gen.some(SANDBOX_DIMENSIONS);
	}
	return layer;
}

/** A starting policy: a built-in profile, possibly widened by a trusted user layer. */
function randomBase(gen: Gen): IVoltSandboxPolicy {
	const base = builtinProfile(gen.pick<SandboxProfileId>(['restricted', 'workspace', 'network']));
	if (!gen.bool(0.6)) {
		return base;
	}
	const user = randomLayer(gen);
	// Users widen, but a user layer is not where the floor's optional set grows.
	return composeSandboxPolicy(base, [{ source: 'user', trusted: true, layer: { ...user, bestEffort: undefined } }]).policy;
}

const NETWORK_RANK = { none: 0, proxy: 1, host: 2 } as const;
/** F.3: dimensions that may run best effort. Everything else is mandatory. */
const OPTIONAL_DIMENSIONS: ReadonlySet<SandboxDimension> = new Set(['filesystem.protectNew', 'process.tree', 'limits.memory', 'limits.processes', 'limits.cpu']);

/** POL-PROP-1/2: `out` allows nothing `caller` does not, dimension by dimension (paths also after realpath). */
function assertWithin(out: IVoltSandboxPolicy, caller: IVoltSandboxPolicy, withRealpath: boolean): void {
	const pathWithin = (path: string, parents: readonly string[]) => parents.some(parent => entryInside(path, parent)
		&& (!withRealpath || !path.startsWith('/') || parent === '/' || entryInside(realpath(path) ?? path, realpath(parent) ?? parent)));
	for (const path of out.filesystem.read) {
		assert.ok(pathWithin(path, caller.filesystem.read), `read ${path} not within ${caller.filesystem.read.join(',')}`);
	}
	for (const path of out.filesystem.write) {
		assert.ok(pathWithin(path, caller.filesystem.write), `write ${path} not within ${caller.filesystem.write.join(',')}`);
	}
	for (const path of caller.filesystem.deny) {
		assert.ok(out.filesystem.deny.includes(path), `deny ${path} lost`);
	}
	for (const path of caller.filesystem.protect) {
		assert.ok(out.filesystem.protect.includes(path), `protect ${path} lost`);
	}
	assert.deepStrictEqual([...out.filesystem.unmask].sort(), [...caller.filesystem.unmask].sort(), 'unmask changed');
	assert.ok(NETWORK_RANK[out.network.mode] <= NETWORK_RANK[caller.network.mode], `network ${out.network.mode} > ${caller.network.mode}`);
	if (out.network.mode === 'proxy' && caller.network.mode === 'proxy') {
		for (const host of out.network.allow) {
			assert.ok(caller.network.allow.some(parent => allowCovers(parent, host)), `host ${host} not covered by ${caller.network.allow.join(',')}`);
		}
	}
	for (const port of out.network.loopbackPorts) {
		assert.ok(caller.network.loopbackPorts.includes(port), `loopback port ${port}`);
	}
	assert.ok(!out.network.listen || caller.network.listen, 'listen widened');
	for (const port of out.network.listenPorts ?? []) {
		assert.ok(caller.network.listen || (caller.network.listenPorts ?? []).includes(port), `listen port ${port}`);
	}
	for (const socket of out.host.unixSockets) {
		assert.ok(caller.host.unixSockets.includes(socket), `socket ${socket}`);
	}
	assert.ok(!out.host.systemServices || caller.host.systemServices, 'system services widened');
	for (const [key, value] of Object.entries(out.process.limits)) {
		const have = caller.process.limits[key as keyof typeof caller.process.limits];
		assert.ok(have === undefined || (value !== undefined && value <= have), `limit ${key} raised`);
	}
	for (const dimension of out.bestEffort) {
		assert.ok(caller.bestEffort.includes(dimension), `best effort ${dimension} added`);
	}
	for (const name of out.env.inherit) {
		assert.ok(caller.env.inherit.includes(name) || (name !== '*' && caller.env.inherit.includes('*') && !isSecretEnvName(name)), `env ${name} inherited`);
	}
	assert.ok(!('NODE_OPTIONS' in out.env.set && !('NODE_OPTIONS' in caller.env.set)), 'an injection hook was set');
}

suite('Volt sandbox properties (K.2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('POL-PROP-1: untrusted layers compile to a policy within the caller on every dimension', () => {
		forAll('POL-PROP-1', gen => {
			const caller = randomBase(gen);
			const layers: ISandboxLayer[] = Array.from({ length: 1 + gen.int(3) }, () => ({ source: gen.pick(SOURCES.filter(source => source !== 'user')), trusted: false, layer: randomLayer(gen) }));
			assertWithin(composeSandboxPolicy(caller, layers).policy, caller, false);
		});
	});

	test('POL-PROP-2: untrusted layers never widen, also once symlinks are resolved', () => {
		forAll('POL-PROP-2', gen => {
			const caller = randomBase(gen);
			const layers: ISandboxLayer[] = Array.from({ length: 1 + gen.int(3) }, () => ({ source: 'workspace', trusted: false, layer: randomLayer(gen) }));
			const { policy } = composeSandboxPolicy(caller, layers, { realpath });
			assertWithin(policy, caller, true);
			// Each step narrows the one before it too.
			let current = caller;
			for (const layer of layers) {
				const next = composeSandboxPolicy(current, [layer], { realpath }).policy;
				assertWithin(next, current, true);
				current = next;
			}
		});
	});

	test('POL-PROP-3: a symlinked untrusted entry whose real path leaves the trusted roots is dropped', () => {
		forAll('POL-PROP-3', gen => {
			const caller = composeSandboxPolicy(builtinProfile('workspace'), [{ source: 'user', trusted: true, layer: { schemaVersion: 1, filesystem: { read: ['/ws'], write: ['/ws'] } } }]).policy;
			const through = gen.pick(['/ws/link', '/ws/link/deep', '/ws/link/x/y']);
			const plain = gen.pick(['/ws/src', '/ws/src/a']);
			const field = gen.pick(['read', 'write'] as const);
			const { policy, ignored } = composeSandboxPolicy(caller, [{ source: 'workspace', trusted: false, layer: { schemaVersion: 1, filesystem: { [field]: [through, plain] } } }], { realpath });
			assert.ok(!policy.filesystem[field].includes(through), `${through} kept`);
			assert.ok(policy.filesystem[field].includes(plain), `${plain} dropped`);
			assert.ok(ignored.some(note => note.value === through && note.reason.includes('symlink')), 'the drop is recorded');
		});
	});

	test('POL-PROP-4: `*` covers a host only on ports 80 and 443', () => {
		forAll('POL-PROP-4', gen => {
			const host = gen.pick(['evil.com', 'example.org', 'a.b.c.dev', '10.1.2.3']);
			const port = gen.bool(0.3) ? gen.pick([80, 443]) : 1 + gen.int(65535);
			const entry = gen.bool(0.2) ? host : `${host}:${port}`;
			const expected = entry === host || port === 80 || port === 443;
			assert.strictEqual(allowCovers('*', entry), expected, entry);
			assert.ok(!allowCovers('*', '*.anything.com:6379'));
			// An untrusted layer cannot reach a non-web port through `*`.
			const caller = composeSandboxPolicy(builtinProfile('network'), [{ source: 'user', trusted: true, layer: { schemaVersion: 1, network: { allow: ['*'] } } }]).policy;
			const { policy } = composeSandboxPolicy(caller, [{ source: 'workspace', trusted: false, layer: { schemaVersion: 1, network: { allow: [entry] } } }]);
			assert.strictEqual(policy.network.allow.includes(entry), expected, entry);
		});
	});

	test('POL-PROP-5: the credential floor appears in every output', () => {
		const floor = credentialDenyEntries();
		forAll('POL-PROP-5', gen => {
			const layers: ISandboxLayer[] = Array.from({ length: gen.int(4) }, () => ({ source: gen.pick(SOURCES), trusted: gen.bool(), layer: randomLayer(gen) }));
			const { policy } = composeSandboxPolicy(builtinProfile(gen.pick<SandboxProfileId>(['restricted', 'workspace', 'network'])), layers);
			for (const entry of floor) {
				assert.ok(policy.filesystem.deny.includes(entry), `${entry} missing`);
			}
		});
	});

	test('POL-PROP-6: a capability grant never exceeds what was requested (the ceiling)', () => {
		const ALL = ['fs.read:workspace', 'fs.write:workspace', 'fs.read:/opt/tools', 'net.connect:api.github.com', 'net.connect:*', 'net.listen:3000', 'net.loopback:5432', 'env:CARGO_HOME', 'socket:/tmp/a.sock', 'git.local', 'process.exec'];
		forAll('POL-PROP-6', gen => {
			const requested = gen.some(ALL, 6);
			const granted = new Set(gen.some([...ALL, 'net.host', 'fs.write:/opt/tools'], 8));
			const ceiling = evaluateCapabilities(requested, new Set(requested)).policy;
			const out = evaluateCapabilities(requested, granted).policy;
			assertWithin(out, ceiling, false);
		});
	});

	test('POL-PROP-7: credential paths are denied for every agent request', () => {
		const exempt = new Set(['Library/Keychains']);
		forAll('POL-PROP-7', gen => {
			const home = gen.pick(['/Users/me', '/home/me']);
			const providerId = gen.pick(['claude-code', 'codex', 'cursor-acp', 'grok', 'opencode', 'antigravity', 'pi', 'kimi', 'fx', 'mystery-acp', '']);
			const network = gen.bool();
			const request: IVoltSandboxRequest = {
				level: gen.pick(['workspace-write', 'read-only'] as const),
				network,
				providerId,
				workspaceRoots: gen.some([`${home}/repo`, `${home}/.ssh`, `${home}`, '/', `${home}/.aws/x`, '/tmp/w'], 3),
				extraWritableRoots: gen.some([`${home}/out`, `${home}/.config`, '/'], 2),
				...(gen.bool(0.3) ? { listenPorts: gen.some(PORTS) } : {}),
			};
			const host: IAgentSandboxHost = { platform: gen.pick(['darwin', 'linux']), home, tempDirs: ['/tmp'], cacheDir: `${home}/.volt/sandbox-cache`, userDataDir: `${home}/.config/Volt` };
			const policy = agentSandboxPolicy(request, host);
			for (const relative of CREDENTIAL_HOME_PATHS.filter(path => !exempt.has(path) && !(path === '.ssh' && network))) {
				assert.ok(policy.filesystem.deny.includes(`${home}/${relative}`), `${providerId}: ~/${relative} readable`);
			}
			assert.ok(policy.filesystem.deny.includes(`${home}/.config/Volt`), 'Volt\'s user data');
			for (const other of ['.codex/auth.json', '.gemini/oauth_creds.json', '.grok/auth.json'].filter(path => !(providerId === 'codex' && path.startsWith('.codex')) && !(providerId === 'antigravity' && path.startsWith('.gemini')) && !(providerId === 'grok' && path.startsWith('.grok')))) {
				assert.ok(policy.filesystem.deny.includes(`${home}/${other}`), `${providerId}: another agent's ${other}`);
			}
			assert.ok(!policy.filesystem.write.some(path => path === '/' || path === home), 'never / or home writable');
			assert.ok(!policy.filesystem.read.includes('/') && !policy.filesystem.read.includes(home), 'narrow reads');
			assert.ok(!policy.env.inherit.includes('*'), 'env allow list');
		});
	});

	test('POL-PROP-8: bestEffort never contains a mandatory dimension', () => {
		forAll('POL-PROP-8', gen => {
			const layers: ISandboxLayer[] = Array.from({ length: gen.int(4) }, () => ({ source: gen.pick(SOURCES.filter(source => source !== 'user')), trusted: false, layer: randomLayer(gen) }));
			const { policy } = composeSandboxPolicy(randomBase(gen), layers);
			for (const dimension of policy.bestEffort) {
				assert.ok(OPTIONAL_DIMENSIONS.has(dimension), `${dimension} is mandatory`);
			}
			const agent = agentSandboxPolicy(
				{ level: gen.pick(['workspace-write', 'read-only'] as const), network: gen.bool(), providerId: gen.pick(['claude-code', 'codex', 'opencode', 'mystery']), workspaceRoots: ['/w'], ...(gen.bool() ? { listenPorts: [3000] } : {}) },
				{ platform: gen.pick(['darwin', 'linux', 'win32']), home: '/home/me', tempDirs: ['/tmp'], cacheDir: '/home/me/.volt/sandbox-cache' },
			);
			for (const dimension of agent.bestEffort) {
				assert.ok(OPTIONAL_DIMENSIONS.has(dimension), `agent: ${dimension} is mandatory`);
			}
		});
	});

	test('composition records where each entry came from', () => {
		const user: IVoltSandboxPolicyLayer = { schemaVersion: 1, filesystem: { write: ['/data'] }, network: { mode: 'proxy', allow: ['api.example.com'], listenPorts: [3000] } };
		const repo: IVoltSandboxPolicyLayer = { schemaVersion: 1, filesystem: { write: ['/data/sub', '/elsewhere'] } };
		const { origins } = composeSandboxPolicy(builtinProfile('workspace'), [{ source: 'user', trusted: true, layer: user }, { source: 'workspace', trusted: false, layer: repo }]);
		assert.strictEqual(origins['filesystem.write:/data/sub'], 'workspace');
		assert.strictEqual(origins['filesystem.write:/elsewhere'], undefined, 'dropped entries have no origin');
		assert.strictEqual(origins['filesystem.read:${system}'], 'builtin');
		assert.strictEqual(origins['network.allow:api.example.com'], 'user');
		assert.strictEqual(origins['network.listenPorts:3000'], 'user');
	});
});
