/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PERF-SB: the Seatbelt profile merges a rule's path regexes into few alternations, because
 * `sandbox-exec` spends about a millisecond compiling each regex filter. These tests run on every
 * platform and evaluate the profile's filters with JavaScript regexes (the constructs used have the
 * same meaning there); SB-EQ-1 (test/node/seatbeltEquivalence.test.ts) checks the same under the
 * real `sandbox-exec` on macOS.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IResolvedPattern, IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';
import { buildSeatbeltProfile } from '../../common/seatbelt.js';
import { forAll, Gen } from './seededGen.js';
import { buildReferenceSeatbeltProfile } from './seatbeltReference.js';

const BASE: IResolvedSandboxPolicy = {
	name: 'merge', platform: 'darwin', readAll: false,
	read: ['/usr', '/System'], write: ['/private/tmp/run'], writeFiles: [],
	deny: [], protect: [], denyPatterns: [], protectPatterns: [], newRepositoryGuard: [], gitDirs: [],
	network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
	unixSockets: [], systemServices: false, limits: {},
	env: {}, cwd: '/private/tmp/run', tmp: '/private/tmp/run', home: '/Users/me',
};

/** `sandbox-exec` rejects longer literals (measured on macOS 26.6). */
const SBPL_LITERAL_LIMIT = 1023;

interface IRule {
	readonly head: string;
	readonly filters: readonly string[];
}

/** Statements of a profile, each with its filters (one per tab-indented line). */
function rules(profile: string): IRule[] {
	return profile.trim().split(/\n(?=\()/).map(statement => {
		const [head, ...lines] = statement.split('\n\t');
		const filters = lines.map((line, i) => i === lines.length - 1 ? line.replace(/\)$/, '') : line);
		return { head, filters };
	});
}

function literals(profile: string): string[] {
	return [...profile.matchAll(/#"([^"]*)"/g)].map(match => match[1]);
}

const unquote = (text: string) => text.replace(/\\(.)/g, '$1');

/** A filter as a predicate on paths, or undefined for one compared as text (`require-all`, ...). */
function predicate(filter: string, cache: Map<string, RegExp>): ((path: string) => boolean) | undefined {
	let match = /^\(regex #"([^"]*)"\)$/.exec(filter);
	if (match) {
		const source = match[1];
		let regex = cache.get(source);
		if (!regex) {
			regex = new RegExp(source);
			cache.set(source, regex);
		}
		return path => regex!.test(path);
	}
	match = /^\(subpath "((?:[^"\\]|\\.)*)"\)$/.exec(filter);
	if (match) {
		const root = unquote(match[1]);
		return path => root === '/' || path === root || path.startsWith(`${root}/`);
	}
	match = /^\(literal "((?:[^"\\]|\\.)*)"\)$/.exec(filter);
	if (match) {
		const file = unquote(match[1]);
		return path => path === file;
	}
	return undefined;
}

/** Both profiles have the same statements, and each statement matches the same probe paths. */
function assertSameRules(reference: string, merged: string, probes: readonly string[]): void {
	const before = rules(reference);
	const after = rules(merged);
	assert.deepStrictEqual(after.map(r => r.head), before.map(r => r.head), 'the same statements in the same order');
	const cache = new Map<string, RegExp>();
	before.forEach((rule, i) => {
		const split = (filters: readonly string[]) => {
			const tests: ((path: string) => boolean)[] = [];
			const opaque = new Set<string>();
			for (const filter of filters) {
				const test = predicate(filter, cache);
				if (test) {
					tests.push(test);
				} else {
					opaque.add(filter);
				}
			}
			return { tests, opaque };
		};
		const a = split(rule.filters);
		const b = split(after[i].filters);
		assert.deepStrictEqual([...b.opaque].sort(), [...a.opaque].sort(), `${rule.head}: other filters unchanged`);
		for (const probe of probes) {
			assert.strictEqual(b.tests.some(test => test(probe)), a.tests.some(test => test(probe)), `${rule.head}: ${probe}`);
		}
	});
}

const SEGMENTS = ['a', 'A', 'b', 'src', 'Src', '.git', '.GIT', '.env', '.ENV', '.env.local', '.envrc', 'hooks', 'config', 'x.y', 'node_modules', 'ab', 'abc', 'objects', 'info', 'alternates', 'worktrees', 'w', 'HEAD', 'index.lock'];

function path(gen: Gen, depth = 1 + gen.int(4)): string {
	return '/' + Array.from({ length: depth }, () => gen.pick(SEGMENTS)).join('/');
}

function randomPolicy(gen: Gen): IResolvedSandboxPolicy {
	const roots = Array.from({ length: 1 + gen.int(6) }, () => path(gen, 1 + gen.int(3)));
	// Roots below other roots (and file-like names below them): only some suffixes let a nested
	// prefix fold into its parent, which is the merge's riskiest step.
	for (let i = gen.int(4); i > 0; i--) {
		roots.push(`${gen.pick(roots)}/${gen.pick([...SEGMENTS, 'state.json', 'a.json'])}`);
	}
	const names = () => gen.bool(0.7) ? [gen.pick(['.env', '.env.local', '.envrc', '.netrc', 'credentials'])] : [gen.pick(['.git', '.GIT']), gen.pick(['hooks', 'config'])];
	const patterns = (): IResolvedPattern[] => Array.from({ length: gen.int(10) }, () => ({ root: gen.bool(0.1) ? '/' : gen.pick(roots), names: names() }));
	return {
		...BASE,
		readAll: gen.bool(),
		systemServices: gen.bool(),
		write: [...BASE.write, ...gen.some(roots, 3)],
		writeFiles: Array.from({ length: gen.int(3) }, () => `${gen.pick(roots)}/${gen.pick(['state.json', 'a.json', 'A.json'])}`),
		deny: Array.from({ length: gen.int(5) }, () => gen.pick([...roots, path(gen)])),
		protect: Array.from({ length: gen.int(5) }, () => gen.pick([...roots, path(gen)])),
		denyPatterns: patterns(),
		protectPatterns: patterns(),
		newRepositoryGuard: gen.some(roots, 3),
		gitDirs: Array.from({ length: gen.int(4) }, () => ({ root: gen.bool(0.1) ? '/' : gen.pick(roots), anyDepth: gen.bool(0.7) })),
		isolated: gen.bool(0.3) ? [{ root: gen.pick(roots), keep: `${gen.pick(roots)}/mine` }] : undefined,
	};
}

suite('Volt sandbox Seatbelt regex merging (PERF-SB)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('PERF-SB law: merged profiles match exactly the paths the unmerged profile did, rule by rule', () => {
		forAll('merge equivalence', gen => {
			const policy = randomPolicy(gen);
			const options = { tag: 'law' };
			const reference = buildReferenceSeatbeltProfile(policy, options);
			const merged = buildSeatbeltProfile(policy, options);
			const probes = new Set<string>(Array.from({ length: 150 }, () => path(gen, 1 + gen.int(7))));
			for (const root of [...policy.write, ...policy.writeFiles, ...policy.deny, ...policy.protect, ...policy.denyPatterns.map(p => p.root), ...policy.gitDirs.map(d => d.root)]) {
				const tails = ['', '/', '/x', 'x', '/.env', '/a/.env', '/.git/hooks/x', '/.git/config', '/.git/objects/info/alternates', '/.git/worktrees/w/HEAD', '/.git/index.lock', '.lock', '.tmp1', '/mine/x',
					'/objects/ab', '/objects/info/alternates', '/HEAD', '/index.lock', '/worktrees/w/HEAD', '/config', '/hooks/x', ...Array.from({ length: 10 }, () => path(gen, 1 + gen.int(5)))];
				for (const tail of tails) {
					probes.add(`${root === '/' ? '' : root}${tail}` || '/');
					probes.add(`${root === '/' ? '' : root}${tail}`.toUpperCase() || '/');
				}
			}
			assertSameRules(reference, merged, [...probes]);
		}, 300);
	});

	test('PERF-SB: an agent-sized profile compiles to few regex filters, each literal under the limit, the same every time', () => {
		const roots = Array.from({ length: 40 }, (_, i) => i % 2 ? `/Users/me/.toolchain-${i}/lib` : `/Users/me/Library/Application Support/tool${i}`);
		const names = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development.local', '.env.test.local', '.envrc'];
		const policy: IResolvedSandboxPolicy = {
			...BASE, systemServices: true,
			read: roots,
			protect: Array.from({ length: 60 }, (_, i) => `/Users/me/repo/.config-${i}`),
			denyPatterns: roots.flatMap(root => names.map(name => ({ root, names: [name] }))),
		};
		const reference = buildReferenceSeatbeltProfile(policy, { tag: 'size' });
		const merged = buildSeatbeltProfile(policy, { tag: 'size' });
		const count = (profile: string) => (profile.match(/\(regex /g) ?? []).length;
		assert.strictEqual(count(reference), 2 + 60 + 280, 'the unmerged profile: one regex per entry');
		assert.ok(count(merged) <= 20, `merged into ${count(merged)} regex filters`);
		for (const literal of literals(merged)) {
			assert.ok(literal.length <= SBPL_LITERAL_LIMIT, `a literal of ${literal.length} bytes`);
		}
		assert.strictEqual(buildSeatbeltProfile(policy, { tag: 'size' }), merged, 'deterministic');
		assertSameRules(reference, merged, [
			...roots.flatMap(root => [root, `${root}/.env`, `${root}/a/.ENV.local`, `${root}/.envrc/x`, `${root}/.env.example`, `${root}x/.env`, `${root.toUpperCase()}/.env`]),
			'/Users/me/repo/.config-1', '/Users/me/repo/.config-10/x', '/Users/me/repo/.CONFIG-59', '/Users/me/repo/.config-60', '/Users/me/repo/.config-1x',
		]);
	});

	test('PERF-SB: duplicates collapse, nested roots fold into their parent, and hostile text is still refused', () => {
		const policy: IResolvedSandboxPolicy = {
			...BASE,
			deny: ['/Users/me/.ssh', '/Users/me/.ssh', '/Users/me/.SSH', '/Users/me/.ssh/keys'],
			denyPatterns: [{ root: '/Users/me/repo', names: ['.env'] }, { root: '/Users/me/repo', names: ['.env'] }, { root: '/Users/me/repo/sub', names: ['.env'] }],
		};
		const profile = buildSeatbeltProfile(policy, { tag: 'd' });
		const deny = rules(profile).find(r => r.head.startsWith('(deny file-read* file-write* (with message'))!;
		assert.deepStrictEqual(deny.filters, [
			'(regex #"^/[uU][sS][eE][rR][sS]/[mM][eE]/\\.[sS][sS][hH](/.*)?$")',
			'(regex #"^/[uU][sS][eE][rR][sS]/[mM][eE]/[rR][eE][pP][oO]/(.*/)?\\.[eE][nN][vV](/.*)?$")',
		]);
		assert.throws(() => buildSeatbeltProfile({ ...BASE, deny: ['/a', '/b"c'] }, { tag: 'z' }), /double quote/);
		assert.throws(() => buildSeatbeltProfile({ ...BASE, denyPatterns: [{ root: '/a', names: ['x"y'] }] }, { tag: 'z' }), /double quote/);
	});
});
