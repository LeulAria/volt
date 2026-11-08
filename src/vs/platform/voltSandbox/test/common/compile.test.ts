/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Policy Compiler and the launch path onto the Policy Authority (spec M.3 C2 step 4):
 * LAUNCH-AUTH-1, POL-DET-1 for compile, the compile cache and its epochs, the compile budget
 * (L.1: p95 <= 1 ms), and the shadow-diff property test: over seeded random launches (agents,
 * levels, folders, OSes, networks, managed and workspace policies) and child-chat comparisons
 * (strategies, levels, folders), every place the earlier rules and the Authority disagree is
 * explained by the layer that decided, and nothing else differs.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { bareCapability, capabilityIdCovers } from '../../../voltPlugins/common/capabilityCatalog.js';
import { chatLaunchView, evaluateLaunch, IAdminPolicy, ILaunchDecision, IWorkspaceRestriction, PolicySnapshot } from '../../common/authority.js';
import { compileLaunchPolicy, ILaunchCompileInput, launchCompileRecord, LaunchNotAllowedError, launchPolicyBytes, LaunchPolicyCache, launchPolicyDigest, replayLaunchCompile } from '../../common/compile.js';
import { chatSubject, corePrincipal, ICallContext } from '../../common/principals.js';
import { isAtLeastAsStrict, ISandboxScope } from '../../common/sandboxInheritance.js';
import { agentSandboxPolicy, IAgentSandboxHost, isPathInside, IVoltSandboxRequest, IVoltSandboxSettings, normalizeSandboxPath, SandboxStrategy, strategyAtLeast, VoltSandboxLevel } from '../../common/sandboxPolicy.js';
import { CREDENTIAL_HOME_PATHS } from '../../common/sandboxProfiles.js';
import { forAll, Gen } from './seededGen.js';

const CASES = Math.max(3000, Number(process.env.VOLT_PROPERTY_RUNS) || 0);

const PROVIDERS = ['claude-code', 'codex', 'cursor-acp', 'grok', 'opencode', 'antigravity', 'pi', 'kimi', 'muse', 'fx', 'mystery-acp'];
const OSES = ['darwin', 'linux', 'win32'];
const HOSTS = ['example.com', '*.example.com', 'api.github.com', 'evil.com', 'registry.npmjs.org', 'localhost'];
const PORTS = [3000, 5173, 8080];
const CAPABILITIES = ['files.write', 'files.read:workspace', 'net.connect', 'net.listen:3000', 'net.listen:*', 'agents.send', 'git.write'];

function folders(home: string): string[] {
	return [`${home}/repo`, `${home}/repo/wt`, '/tmp/w', `${home}/other`, `${home}/repo/.git`, `${home}/.ssh`, `${home}/.aws/x`, `${home}/a/../.ssh`, '/', home];
}

function randomLaunch(gen: Gen): { request: IVoltSandboxRequest; host: IAgentSandboxHost; admin?: IAdminPolicy; workspace?: IWorkspaceRestriction } {
	const home = gen.pick(['/Users/me', '/home/me']);
	const network = gen.bool();
	const request: IVoltSandboxRequest = {
		level: gen.pick(['workspace-write', 'read-only'] as const),
		network,
		providerId: gen.pick(PROVIDERS),
		workspaceRoots: gen.some(folders(home), 2),
		...(gen.bool(0.4) ? { extraWritableRoots: gen.some(folders(home), 2) } : {}),
		...(gen.bool(0.4) ? { allowedDomains: gen.some(HOSTS, 3) } : {}),
		...(gen.bool(0.3) ? { listenPorts: gen.some(PORTS, 2) } : {}),
		...(gen.bool(0.3) ? { loopbackPorts: [4321] } : {}),
		...(gen.bool(0.5) ? { stateKey: `c${gen.int(5)}` } : {}),
	};
	const host: IAgentSandboxHost = {
		platform: gen.pick(OSES),
		home,
		tempDirs: ['/tmp', '/var/tmp'],
		uid: 501,
		cacheDir: `${home}/.volt/sandbox-cache/${gen.int(4)}`,
		...(gen.bool() ? { userDataDir: `${home}/.config/Volt` } : {}),
		...(gen.bool(0.3) ? { sshPrivateKeys: [`${home}/.ssh/id_ed25519`] } : {}),
		...(network && gen.bool(0.3) ? { sshAuthSock: '/tmp/ssh-agent.sock' } : {}),
	};
	const adminKind = gen.int(5);
	const admin: IAdminPolicy | undefined = adminKind === 1 ? { denyCapabilities: gen.some(CAPABILITIES, 2) }
		: adminKind === 2 ? { denyHosts: gen.some(['evil.com', '*.example.com', 'registry.npmjs.org', '*'], 2) }
			: adminKind === 3 ? gen.pick<IAdminPolicy>([{ unreadable: true }, { maxThirdPartyClass: 'low' }])
				: undefined;
	const workspace: IWorkspaceRestriction | undefined = gen.bool(0.2) ? { root: `${home}/repo`, ...(gen.bool() ? { trusted: false } : {}), denyCapabilities: gen.some(CAPABILITIES, 2) } : undefined;
	return { request, host, ...(admin ? { admin } : {}), ...(workspace ? { workspace } : {}) };
}

function judge(request: IVoltSandboxRequest, host: IAgentSandboxHost, admin?: IAdminPolicy, workspace?: IWorkspaceRestriction, epoch = 1): ILaunchDecision {
	const subject = chatSubject(request.stateKey ?? 'run');
	const snapshot = PolicySnapshot.build({ epoch, asOf: 1000, chats: [chatLaunchView(subject, request)], home: host.home, ...(admin ? { admin } : {}), ...(workspace ? { workspace } : {}) });
	const context: ICallContext = { principal: corePrincipal('launch-1', subject, 'agent'), onBehalfOf: [], requestId: 'launch' };
	return evaluateLaunch(snapshot, context, request.workspaceRoots);
}

function inputOf(request: IVoltSandboxRequest, host: IAgentSandboxHost, epoch = 1): ILaunchCompileInput {
	return { subject: chatSubject(request.stateKey ?? 'run'), epoch, request, host };
}

/** A credential folder, or a path the floor can't place (`..`). */
function credentialPath(target: string, home: string): boolean {
	const path = normalizeSandboxPath(target);
	return path.split('/').includes('..') || CREDENTIAL_HOME_PATHS.some(dir => isPathInside(path, `${home}/${dir}`));
}

/** Why the Authority refused a launch the earlier composition ran, or undefined when nothing explains it. */
function explainRefusal(decision: ILaunchDecision, home: string, admin: IAdminPolicy | undefined, workspace: IWorkspaceRestriction | undefined): string | undefined {
	const denied = decision.denied;
	if (!denied) {
		return undefined;
	}
	const listed = (ids: readonly string[] | undefined) => !!ids?.some(id => capabilityIdCovers(id, denied.capability) || bareCapability(id) === bareCapability(denied.capability));
	switch (decision.deniedBy) {
		case 'floor':
			return decision.code === 'credential' && denied.target && credentialPath(denied.target, home) ? 'floor: a credential folder (or `..`) as a workspace or allowed folder' : undefined;
		case 'admin':
			if (decision.code === 'admin-capability' && listed(admin?.denyCapabilities)) {
				return `admin: denies ${denied.capability}`;
			}
			return decision.code === 'admin-host' && admin?.denyHosts?.length ? 'admin: denies a host the launch reaches' : undefined;
		case 'workspace':
			return decision.code === 'workspace-policy' && listed(workspace?.denyCapabilities) ? `workspace: denies ${denied.capability}` : undefined;
		default:
			return undefined;
	}
}

// The pre-Authority rule for child chats (sandboxInheritance.ts before C2 step 4), the oracle the shadow diff compares with.
const LEVEL_RANK: Readonly<Record<VoltSandboxLevel, number>> = { 'off': 0, 'workspace-write': 1, 'read-only': 2 };
function legacyPatternCovered(pattern: string, by: string): boolean {
	const p = pattern.trim().toLowerCase();
	const b = by.trim().toLowerCase();
	if (b === '*' || p === b) {
		return true;
	}
	if (p === '*' || !b.startsWith('*.')) {
		return false;
	}
	const base = b.slice(2);
	const name = p.startsWith('*.') ? p.slice(2) : p;
	return name === base || name.endsWith(`.${base}`);
}
function legacyIsAtLeastAsStrict(a: IVoltSandboxSettings, b: IVoltSandboxSettings, scopes?: { readonly a?: ISandboxScope; readonly b?: ISandboxScope }): boolean {
	if (b.level === 'off') {
		return true;
	}
	if (a.level === 'off' || LEVEL_RANK[a.level] < LEVEL_RANK[b.level]) {
		return false;
	}
	if (!strategyAtLeast(scopes?.a?.strategy ?? 'wrap', scopes?.b?.strategy ?? 'wrap')) {
		return false;
	}
	if (a.network && !b.network) {
		return false;
	}
	if ((a.listenPorts ?? []).some(port => !(b.listenPorts ?? []).includes(port))) {
		return false;
	}
	const writes = (s: IVoltSandboxSettings, scope?: ISandboxScope) => [...(s.extraWritableRoots ?? []), ...(s.level === 'workspace-write' ? scope?.roots ?? [] : [])].map(normalizeSandboxPath);
	const bWrites = writes(b, scopes?.b);
	if (!writes(a, scopes?.a).every(root => bWrites.some(allowed => isPathInside(root, allowed)))) {
		return false;
	}
	return b.network || (a.allowedDomains ?? []).every(domain => (b.allowedDomains ?? []).some(allowed => legacyPatternCovered(domain, allowed)));
}

/** Loopback names (always reachable for a sandboxed chat) and a trailing-dot spelling of a listed host: the Authority's `domainAllowed` reads them as what they are. */
function loopbackOrSpelling(host: string): boolean {
	const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
	return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost') || name.endsWith('.');
}

/** Measured numbers for the run's log. Not `console.*`: the Electron runner fails a test that used the console. */
function report(line: string): void {
	if (typeof process !== 'undefined') {
		process.stderr.write(`${line}\n`);
	}
}

suite('Volt policy compiler and launch authority (C2 step 4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const host: IAgentSandboxHost = { platform: 'darwin', home: '/Users/me', tempDirs: ['/tmp'], cacheDir: '/Users/me/.volt/sandbox-cache/a' };
	const request: IVoltSandboxRequest = { level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: ['/Users/me/repo'], allowedDomains: ['example.com'], listenPorts: [3000], stateKey: 'c1' };

	test('LAUNCH-AUTH-1 (compile): a launch the Authority denies is never compiled', () => {
		const decision = judge(request, host, { denyCapabilities: ['files.write'] });
		assert.strictEqual(decision.allow, false);
		assert.strictEqual(decision.deniedBy, 'admin');
		assert.deepStrictEqual(decision.denied, { capability: 'files.write', target: '/Users/me/repo', surface: 'launch' });
		assert.throws(() => compileLaunchPolicy(decision, inputOf(request, host)), LaunchNotAllowedError);
		const cache = new LaunchPolicyCache();
		assert.throws(() => cache.compile(decision, inputOf(request, host)), LaunchNotAllowedError);
		assert.strictEqual(cache.size, 0, 'nothing cached for a refused launch');
	});

	test('LAUNCH-AUTH-1 (layers): floor, admin and workspace each refuse a launch the chat\'s settings allow', () => {
		const refused = (decision: ILaunchDecision) => `${decision.deniedBy}/${decision.code}`;
		assert.strictEqual(refused(judge({ ...request, extraWritableRoots: ['/Users/me/.ssh'] }, host)), 'floor/credential');
		assert.strictEqual(refused(judge(request, host, { denyHosts: ['*.anthropic.com'] })), 'admin/admin-host', 'the agent\'s own API is a host the launch reaches');
		assert.strictEqual(refused(judge({ ...request, network: true }, host, { denyHosts: ['*'] })), 'admin/admin-host');
		assert.strictEqual(refused(judge(request, host, { denyCapabilities: ['net.listen:3000'] })), 'admin/admin-capability');
		assert.strictEqual(refused(judge(request, host, undefined, { root: '/Users/me/repo', denyCapabilities: ['files.write'] })), 'workspace/workspace-policy');
		assert.strictEqual(judge({ ...request, level: 'read-only' }, host, undefined, { root: '/Users/me/repo', denyCapabilities: ['files.write'] }).allow, true, 'a read-only launch writes nothing');
		// Third-party-only admin rules and a distrusted workspace don't refuse a chat's own agent.
		assert.strictEqual(judge(request, host, { unreadable: true, maxThirdPartyClass: 'none' }, { trusted: false }).allow, true);
		const unknown = evaluateLaunch(PolicySnapshot.build({ epoch: 1, asOf: 0 }), { principal: corePrincipal('x', chatSubject('ghost'), 'agent'), onBehalfOf: [], requestId: 'r' }, ['/Users/me/repo']);
		assert.strictEqual(refused(unknown), 'manifest/unknown-subject', 'a chat the snapshot doesn\'t hold');
	});

	test('LAUNCH-AUTH-1 (addresses): a non-public address in the chat\'s hosts is refused per connection, not at launch', () => {
		for (const address of ['192.168.1.20', '10.0.0.5:8080', '127.0.0.1', '[::1]:3000', 'http://172.16.0.1']) {
			const decision = judge({ ...request, allowedDomains: ['example.com', address] }, host);
			assert.strictEqual(decision.allow, true, `${address} does not refuse the chat`);
			assert.ok(!decision.requests.some(r => r.target === address), `${address} is not a launch request`);
		}
		assert.ok(judge({ ...request, allowedDomains: ['93.184.216.34'] }, host).requests.some(r => r.target === '93.184.216.34'), 'a public address is still a launch request');
		assert.strictEqual(judge(request, host, { denyHosts: ['example.com'] }).deniedBy, 'admin', 'host rules still refuse at launch');
	});

	test('POL-DET-1 (compile): a logged launch replays to byte-identical policy', () => {
		forAll('POL-DET-1 compile', gen => {
			const { request, host } = randomLaunch(gen);
			const input = inputOf(request, host, 1 + gen.int(9));
			const decision = judge(request, host, undefined, undefined, input.epoch);
			if (!decision.allow) {
				return;
			}
			const compiled = compileLaunchPolicy(decision, input);
			assert.ok(Object.isFrozen(compiled.policy) && Object.isFrozen(compiled.policy.filesystem.write), 'immutable');
			// The record goes through JSON, as a decision log would store it.
			const record = JSON.parse(JSON.stringify(launchCompileRecord(compiled, input)));
			const replayed = replayLaunchCompile(record, decision);
			assert.strictEqual(launchPolicyBytes(replayed.policy), launchPolicyBytes(compiled.policy));
			assert.strictEqual(launchPolicyDigest(replayed.policy), record.policyDigest);
			assert.strictEqual(replayed.inputDigest, compiled.inputDigest);
		}, 500);
		const decision = judge(request, host);
		const record = launchCompileRecord(compileLaunchPolicy(decision, inputOf(request, host)), inputOf(request, host));
		assert.throws(() => replayLaunchCompile({ ...record, input: { ...record.input, epoch: 99 } }, decision), /does not match its digest/);
	});

	test('compile cache: keyed by (input digest, subject), frozen entries, dropped by a new epoch', () => {
		const cache = new LaunchPolicyCache(4);
		const decision = judge(request, host);
		const first = cache.compile(decision, inputOf(request, host, 1));
		assert.strictEqual(cache.compile(decision, inputOf(request, host, 1)), first, 'same input, same epoch: the cached entry');
		assert.deepStrictEqual([cache.hits, cache.misses], [1, 1]);
		const other = cache.compile(decision, { ...inputOf(request, host, 1), subject: chatSubject('c2') });
		assert.notStrictEqual(other, first, 'another principal\'s subject is another entry');
		assert.strictEqual(cache.size, 2);
		// A new epoch (a grant, policy or managed-policy change) drops everything.
		const next = cache.compile(decision, inputOf(request, host, 2));
		assert.notStrictEqual(next, first);
		assert.strictEqual(cache.size, 1);
		assert.strictEqual(cache.currentEpoch, 2);
		// A compile for an older epoch runs but is never cached.
		cache.compile(decision, inputOf(request, host, 1));
		assert.strictEqual(cache.size, 1);
		cache.invalidate(3);
		assert.strictEqual(cache.size, 0);
		// Bounded.
		for (let i = 0; i < 10; i++) {
			cache.compile(decision, { ...inputOf(request, host, 3), subject: chatSubject(`k${i}`) });
		}
		assert.strictEqual(cache.size, 4);
		assert.strictEqual(launchPolicyBytes(first.policy), launchPolicyBytes(next.policy), 'the epoch is not part of the policy');
	});

	test('shadow diff (launch): 0 unexplained differences over seeded launches', () => {
		const explained = new Map<string, number>();
		let allowed = 0;
		forAll('shadow diff launch', gen => {
			const { request, host, admin, workspace } = randomLaunch(gen);
			const legacy = agentSandboxPolicy(request, host);
			const decision = judge(request, host, admin, workspace);
			if (decision.allow) {
				allowed++;
				const compiled = compileLaunchPolicy(decision, inputOf(request, host));
				assert.strictEqual(launchPolicyBytes(compiled.policy), launchPolicyBytes(legacy), 'an allowed launch compiles to exactly the earlier policy');
				return;
			}
			const why = explainRefusal(decision, host.home, admin, workspace);
			assert.ok(why, `unexplained refusal: ${decision.deniedBy}/${decision.code} ${decision.reason} (${JSON.stringify(decision.denied)})`);
			explained.set(why, (explained.get(why) ?? 0) + 1);
			if (!admin && !workspace) {
				assert.strictEqual(decision.deniedBy, 'floor', 'with no managed or workspace policy only the floor refuses');
			}
		}, CASES);
		assert.ok(allowed > CASES / 3, `enough allowed launches compared (${allowed})`);
		assert.ok(explained.size >= 3, 'the generator reaches the floor, admin and workspace layers');
		report(`shadow diff (launch): ${CASES} cases, ${allowed} allowed and byte-identical, refusals by cause: ${[...explained].map(([why, n]) => `${n} ${why}`).join('; ')}`);
	});

	test('shadow diff (inheritance): child-chat coverage on the Authority matches the earlier rule, except loopback and spelling', () => {
		const LEVELS: readonly VoltSandboxLevel[] = ['off', 'workspace-write', 'read-only'];
		const STRATEGIES: readonly (SandboxStrategy | undefined)[] = ['wrap', 'native', 'none', undefined];
		const ROOTS = ['/ws', '/ws/a', '/ws/a/', '/ws/b', '/wsx', '/other', '/ws//a', '/'];
		const DOMAINS = ['example.com', '*.example.com', 'api.example.com', 'localhost', '127.0.0.1', '[::1]', 'example.com.', '*', 'EXAMPLE.com'];
		const settings = (gen: Gen): IVoltSandboxSettings => ({
			level: gen.pick(LEVELS),
			network: gen.bool(),
			...(gen.bool(0.4) ? { extraWritableRoots: gen.some(ROOTS, 2) } : {}),
			...(gen.bool(0.5) ? { allowedDomains: gen.some(DOMAINS, 3) } : {}),
			...(gen.bool(0.3) ? { listenPorts: gen.some(PORTS, 2) } : {}),
		});
		const scope = (gen: Gen): ISandboxScope | undefined => gen.bool(0.2) ? undefined : {
			...(gen.bool(0.8) ? { strategy: gen.pick(STRATEGIES) } : {}),
			...(gen.bool(0.7) ? { roots: gen.some(ROOTS, 2) } : {}),
		};
		let diffs = 0;
		forAll('shadow diff inheritance', gen => {
			const a = settings(gen);
			const b = settings(gen);
			const scopes = gen.bool(0.8) ? { a: scope(gen), b: scope(gen) } : undefined;
			const legacy = legacyIsAtLeastAsStrict(a, b, scopes);
			const now = isAtLeastAsStrict(a, b, scopes);
			if (legacy === now) {
				return;
			}
			diffs++;
			// Only one explanation: the target lists a loopback name or a trailing-dot spelling the caller doesn't, and the Authority reads it as reachable already.
			assert.ok(now && !legacy && !b.network && (a.allowedDomains ?? []).some(loopbackOrSpelling), `unexplained: ${JSON.stringify({ a, b, scopes, legacy, now })}`);
		}, CASES);
		report(`shadow diff (inheritance): ${CASES} cases, ${diffs} explained differences (a loopback or trailing-dot host the caller lacks; no other)`);
	});

	test('compile budget: p95 <= 1 ms (L.1)', () => {
		const inputs: { decision: ILaunchDecision; input: ILaunchCompileInput }[] = [];
		forAll('compile inputs', gen => {
			const { request, host } = randomLaunch(gen);
			const decision = judge(request, host);
			if (decision.allow) {
				inputs.push({ decision, input: inputOf(request, host) });
			}
		}, 1500);
		const time = (run: (entry: typeof inputs[number]) => void): number => {
			const samples: number[] = [];
			for (const entry of inputs) {
				const start = performance.now();
				run(entry);
				samples.push(performance.now() - start);
			}
			samples.sort((x, y) => x - y);
			return samples[Math.floor(samples.length * 0.95)];
		};
		// Warm the JIT first.
		time(entry => compileLaunchPolicy(entry.decision, entry.input));
		const compile = time(entry => compileLaunchPolicy(entry.decision, entry.input));
		const cache = new LaunchPolicyCache(inputs.length);
		const miss = time(entry => cache.compile(entry.decision, entry.input));
		const hit = time(entry => cache.compile(entry.decision, entry.input));
		const judged = time(entry => judge(entry.input.request, entry.input.host));
		report(`compile p95: ${compile.toFixed(3)} ms; cached miss ${miss.toFixed(3)} ms, hit ${hit.toFixed(3)} ms; evaluateLaunch ${judged.toFixed(3)} ms (${inputs.length} launches)`);
		assert.ok(compile <= 1, `compile p95 ${compile} ms`);
		assert.ok(miss <= 1, `cached compile (miss) p95 ${miss} ms`);
	});
});
