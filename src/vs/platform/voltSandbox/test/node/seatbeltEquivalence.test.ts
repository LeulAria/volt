/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SB-EQ-1 (PERF-SB): the Seatbelt profile with merged path regexes allows and denies exactly what
 * the profile before the merge did, under the real `sandbox-exec`. For each policy (the agent
 * profile on this machine's real home and toolchains, the `workspace` profile, and a synthetic
 * policy using every rule kind), both profiles are applied to a live process, and:
 * - `sandbox_check` from outside answers file operations for a generated set of probe paths
 *   (every walked `.env`-style match, siblings, parents, children, case variants, every rule's
 *   own paths and their neighbours), which need not exist;
 * - a script inside each sandbox reads, stats and opens for append real files: matches at depth,
 *   symlinks to them and to their folders, and case variants (APFS is case-insensitive).
 * Both answer sets must be identical, and each must contain allows and denies (proof it ran).
 *
 * macOS only. With `VOLT_SANDBOX_REQUIRED` set, a missing `sandbox-exec` or compiler fails the suite.
 */

import assert from 'assert';
import { ChildProcess, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { agentSandboxPolicy } from '../../common/sandboxPolicy.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';
import { IVoltSandboxPolicy } from '../../common/sandboxSchema.js';
import { buildSeatbeltProfile, SANDBOX_EXEC_PATH } from '../../common/seatbelt.js';
import { walkPatterns } from '../../node/bubblewrapBackend.js';
import { ISandboxHostFacts, resolveSandboxPolicy, sandboxHostFacts } from '../../node/sandboxResolver.js';
import { buildReferenceSeatbeltProfile } from '../common/seatbeltReference.js';
import { SANDBOX_REQUIRED, writeSkipNotice } from './sandboxSuiteGate.js';

const isMac = process.platform === 'darwin';
const macTest = isMac ? test : test.skip;

/** Operations `sandbox_check` is asked about for every probe path. */
const OPERATIONS = ['file-read-data', 'file-read-metadata', 'file-write-data', 'file-write-create', 'file-write-unlink'] as const;

/**
 * Reads `<operation>\t<path>` lines and prints `sandbox_check(pid, operation, PATH, path)` for
 * each (1 denied, 0 allowed, -errno), without logging a violation.
 */
const CHECKER_SOURCE = `
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
typedef int (*check_fn)(pid_t, const char *, int, ...);
int main(int argc, char **argv) {
	check_fn check = (check_fn)dlsym(RTLD_DEFAULT, "sandbox_check");
	const int *noReport = (const int *)dlsym(RTLD_DEFAULT, "SANDBOX_CHECK_NO_REPORT");
	if (!check || argc != 2) {
		return 2;
	}
	pid_t pid = (pid_t)atoi(argv[1]);
	int flags = noReport ? *noReport : 0;
	if (check(pid, NULL, 0) != 1) {
		fprintf(stderr, "not sandboxed\\n");
		return 3;
	}
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;
	while ((length = getline(&line, &capacity, stdin)) > 0) {
		if (line[length - 1] == '\\n') {
			line[length - 1] = 0;
		}
		char *tab = strchr(line, '\\t');
		if (!tab) {
			return 4;
		}
		*tab = 0;
		errno = 0;
		int result = check(pid, line, 1 | flags, tab + 1);
		printf("%d\\n", result < 0 ? -(errno ? errno : 1) : result);
	}
	return 0;
}
`;

/** Reads, stats and opens for append each path given; prints `<read><stat><append>` per path. Changes no file that exists. */
const SYSCALL_SCRIPT = [
	'for f in "$@"; do',
	'	if cat -- "$f" >/dev/null 2>&1; then r=1; else r=0; fi',
	'	if [ -e "$f" ]; then m=1; else m=0; fi',
	'	if [ -f "$f" ] && (: >> "$f") 2>/dev/null; then w=1; else w=0; fi',
	'	printf "%s%s%s\\n" "$r" "$m" "$w"',
	'done',
].join('\n');

function execFileText(file: string, args: readonly string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(file, [...args], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => err ? reject(new Error(`${file}: ${err.message} ${stderr}`)) : resolve(stdout));
		child.stdin?.end(input ?? '');
	});
}

/** Letters swapped to the other case, and each path component capitalised: other spellings of the same file on APFS. */
function caseVariants(path: string): string[] {
	const swapped = [...path].map(ch => ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()).join('');
	const capitalised = path.split('/').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('/');
	return [path, path.toUpperCase(), path.toLowerCase(), swapped, capitalised];
}

/** Paths at, around, above and below every rule of `policy`, in several spellings. */
function probePaths(policy: IResolvedSandboxPolicy, extra: readonly string[]): string[] {
	const out = new Set<string>();
	const add = (path: string) => {
		for (const variant of caseVariants(path)) {
			out.add(variant);
		}
	};
	const around = (path: string) => {
		for (const p of [path, `${path}/x`, `${path}/a/b`, `${path}x`, `${path}.x`, `${path}/.env`, dirname(path)]) {
			add(p);
		}
	};
	for (const path of [...policy.read, ...policy.write, ...policy.deny, ...policy.protect, ...policy.unixSockets, policy.tmp, policy.cwd, policy.home]) {
		around(path);
	}
	for (const file of policy.writeFiles) {
		around(file);
		for (const suffix of ['.lock', '.tmp', '.tmp.123', '.backup', '.bak', '.swp', '.swpx', '.lock/x', 'x.lock', '.LOCK', '.Tmp1', '.locked']) {
			add(`${file}${suffix}`);
		}
	}
	for (const pattern of [...policy.denyPatterns, ...policy.protectPatterns]) {
		const base = pattern.root === '/' ? '' : pattern.root;
		const names = pattern.names.join('/');
		add(base || '/');
		add(dirname(base || '/'));
		const first = pattern.names[0];
		const last = pattern.names[pattern.names.length - 1];
		const near = [`${base}/${names}`, `${base}/a/${names}`, `${base}/a/b/c/${names}`, `${base}/${names}/x`, `${base}/a/${names}/x/y`];
		const unlike = [`${base}/${names}x`, `${base}/x${names}`, `${base}/a/${names}.example`, `${base}${names}`, `${base}/${first}`, `${base}/a/${last}`];
		for (const p of [...near, ...unlike]) {
			add(p);
		}
	}
	for (const dir of policy.gitDirs) {
		const gits = dir.anyDepth ? [`${dir.root}/.git`, `${dir.root}/sub/.git`, `${dir.root}/a/b/.git`] : [dir.root];
		for (const git of gits) {
			for (const rel of ['', '/config', '/HEAD', '/index', '/index.lock', '/objects/ab/cd', '/objects/info/alternates', '/objects/info/http-alternates', '/objects/info/commit-graph',
				'/refs/heads/main', '/logs/HEAD', '/hooks/pre-commit', '/worktrees/w/HEAD', '/worktrees/w/commondir', '/worktrees/w/objects/info/alternates', '/MERGE_HEAD', '/config.lock',
				'/description', '/packed-refs', '/rebase-merge/done', '/info/exclude', 'x', '/../config']) {
				add(`${git}${rel}`);
			}
		}
	}
	for (const root of policy.newRepositoryGuard) {
		for (const p of [`${root}/.git`, `${root}/a/.git`, `${root}/.gitx`, `${root}/a/b/.git`, `${root}/a.git`]) {
			add(p);
		}
	}
	for (const { root, keep } of policy.isolated ?? []) {
		around(root);
		around(keep);
		add(`${root}/other/x`);
	}
	for (const path of extra) {
		around(path);
	}
	for (const path of ['/', '/etc/passwd', '/private/etc/hosts', '/Users', '/usr/bin/git', '/bin/sh', '/dev/null', '/dev/tty', '/dev/ttys001', '/tmp/x', '/private/tmp/x', '/private/var/run/mDNSResponder']) {
		add(path);
	}
	// The checker's protocol is one tab-separated line per query.
	return [...out].filter(path => path.startsWith('/') && !/[\t\n\r"]/.test(path)).sort();
}

suite('Volt sandbox Seatbelt profile equivalence (SB-EQ-1, real sandbox-exec)', function () {

	this.timeout(300_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let ws: string;
	let checker: string;
	let host: ISandboxHostFacts;
	let available = false;
	const children: ChildProcess[] = [];

	suiteSetup(async function () {
		if (!isMac) {
			return;
		}
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-eq-')));
		ws = join(root, 'ws');
		const files = ['.env', 'a/b/.env.local', 'a/.env.production', '.envrc', '.env.example', 'deep/1/2/3/4/.env.test.local', 'src/index.ts', 'a/b/notes.md',
			'.git/config', '.git/HEAD', '.git/hooks/pre-commit', '.git/objects/info/alternates', 'sub/.git/config', 'sub/.git/index', '.vscode/tasks.json', '.gitmodules'];
		for (const file of files) {
			await fs.mkdir(dirname(join(ws, file)), { recursive: true });
			await fs.writeFile(join(ws, file), 'x\n');
		}
		await fs.mkdir(join(root, 'outside'), { recursive: true });
		await fs.writeFile(join(root, 'outside', '.env'), 'x\n');
		await fs.symlink(join(ws, 'a', 'b', '.env.local'), join(ws, 'link-env'));
		await fs.symlink(join(ws, 'a'), join(ws, 'link-dir'));
		await fs.symlink(join(root, 'outside', '.env'), join(ws, 'link-outside'));
		await fs.symlink(join(ws, 'src', 'index.ts'), join(ws, 'src', '.env'));
		host = await sandboxHostFacts();
		try {
			await fs.access(SANDBOX_EXEC_PATH);
			await fs.writeFile(join(root, 'checker.c'), CHECKER_SOURCE);
			checker = join(root, 'checker');
			await execFileText('/usr/bin/cc', ['-O1', '-o', checker, join(root, 'checker.c')]);
			available = true;
		} catch (err) {
			if (SANDBOX_REQUIRED) {
				throw new Error(`SB-EQ-1 cannot run: ${(err as Error).message} (CI requires the sandbox; failing instead of skipping)`);
			}
			writeSkipNotice(`[volt-sandbox] SB-EQ-1 cannot run: ${(err as Error).message}`, 'The Seatbelt equivalence suite is');
		}
	});

	suiteTeardown(async () => {
		for (const child of children) {
			child.kill('SIGKILL');
		}
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (isMac && !available) {
			this.skip();
		}
	});

	const resolve = async (policy: IVoltSandboxPolicy, name: string) => {
		const runTmp = await fs.mkdtemp(join(root, `run-${name}-`));
		return (await resolveSandboxPolicy(policy, { workspaceRoots: [ws], hostEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: host.home, LANG: 'C' } }, host, runTmp)).policy;
	};

	/** Every existing fixture path below the workspace (symlinks not followed) and the case variants of each. */
	const fixturePaths = async () => {
		const out: string[] = [];
		const walk = async (dir: string) => {
			for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				out.push(...caseVariants(path).filter(p => p.startsWith(ws) || p.toLowerCase().startsWith(ws.toLowerCase())));
				if (entry.isDirectory()) {
					await walk(path);
				}
			}
		};
		await walk(ws);
		out.push(join(ws, 'link-dir', 'b', '.env.local'), join(ws, 'LINK-DIR', 'B', '.ENV.LOCAL'), join(root, 'outside', '.env'));
		return [...new Set(out)].sort();
	};

	/** Applies `profile` to a live process and returns `sandbox_check`'s answer for every (operation, path). */
	async function checkProfile(profile: string, name: string, paths: readonly string[]): Promise<string[]> {
		const file = join(root, `${name}.sb`);
		await fs.writeFile(file, profile);
		const child = spawn(SANDBOX_EXEC_PATH, ['-f', file, '/bin/sh', '-c', 'echo ready; exec /bin/sleep 120'], { stdio: ['ignore', 'pipe', 'pipe'] });
		children.push(child);
		try {
			await new Promise<void>((resolveReady, reject) => {
				let stderr = '';
				child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
				child.stdout?.once('data', () => resolveReady());
				child.once('exit', code => reject(new Error(`sandbox-exec exited ${code}: ${stderr}`)));
			});
			const input = OPERATIONS.flatMap(operation => paths.map(path => `${operation}\t${path}`)).join('\n') + '\n';
			const answers = (await execFileText(checker, [String(child.pid)], input)).trim().split('\n');
			assert.strictEqual(answers.length, OPERATIONS.length * paths.length, 'one answer per query');
			return answers;
		} finally {
			child.kill('SIGKILL');
		}
	}

	/** Runs the syscall script inside `profile` over `paths`. */
	async function syscalls(profile: string, name: string, paths: readonly string[]): Promise<string[]> {
		const file = join(root, `${name}.sys.sb`);
		await fs.writeFile(file, profile);
		const lines = (await execFileText(SANDBOX_EXEC_PATH, ['-f', file, '/bin/sh', '-c', SYSCALL_SCRIPT, 'sh', ...paths])).trim().split('\n');
		assert.strictEqual(lines.length, paths.length, 'one line per path');
		return lines;
	}

	async function assertEquivalent(name: string, policy: IResolvedSandboxPolicy): Promise<{ reference: string; merged: string }> {
		const options = { tag: 'eq' };
		const reference = buildReferenceSeatbeltProfile(policy, options);
		const merged = buildSeatbeltProfile(policy, options);
		const walkable = { ...policy, denyPatterns: policy.denyPatterns.filter(p => p.root.startsWith(root)), protectPatterns: policy.protectPatterns.filter(p => p.root.startsWith(root)) };
		const walked = await walkPatterns(walkable, { collectSockets: false });
		const matches = [...walked.deny, ...walked.protect].map(match => match.path);
		const fixtures = await fixturePaths();
		const paths = probePaths(policy, [...matches, ...fixtures]);

		const before = await checkProfile(reference, `${name}-reference`, paths);
		const after = await checkProfile(merged, `${name}-merged`, paths);
		const differences: string[] = [];
		OPERATIONS.forEach((operation, o) => paths.forEach((path, p) => {
			const index = o * paths.length + p;
			if (before[index] !== after[index]) {
				differences.push(`${operation} ${path}: reference ${before[index]}, merged ${after[index]}`);
			}
		}));
		assert.deepStrictEqual(differences.slice(0, 50), [], `${name}: ${differences.length} of ${before.length} answers differ`);
		// Proof the checks ran: no errors, and both allows and denies for reads.
		assert.ok(before.every(answer => answer === '0' || answer === '1'), `${name}: every answer is an allow or a deny`);
		const reads = before.slice(0, paths.length);
		assert.ok(reads.includes('0') && reads.includes('1'), `${name}: reads both allowed and denied`);

		const sysBefore = await syscalls(reference, `${name}-reference`, fixtures);
		const sysAfter = await syscalls(merged, `${name}-merged`, fixtures);
		const sysDifferences = fixtures.filter((_, i) => sysBefore[i] !== sysAfter[i]).map(path => `${path}: reference ${sysBefore[fixtures.indexOf(path)]}, merged ${sysAfter[fixtures.indexOf(path)]}`);
		assert.deepStrictEqual(sysDifferences, [], `${name}: real file operations differ`);
		assert.ok(sysBefore.some(line => line.startsWith('1')) && sysBefore.some(line => line.startsWith('0')), `${name}: real reads both allowed and denied`);
		return { reference, merged };
	}

	const regexCount = (profile: string) => (profile.match(/\(regex /g) ?? []).length;

	macTest('SB-EQ-1: the agent profile (this machine\'s toolchains, narrow reads) allows and denies what it did before the merge', async () => {
		const policy = await resolve(agentSandboxPolicy(
			{ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [ws] },
			{ platform: process.platform, home: host.home, tempDirs: [host.tmpRoot], cacheDir: join(root, 'cache') },
		), 'agent');
		assert.ok(policy.denyPatterns.length > 20, `the agent profile carries its narrow-read deny patterns (${policy.denyPatterns.length})`);
		const { reference, merged } = await assertEquivalent('agent', policy);
		assert.ok(regexCount(merged) * 4 < regexCount(reference), `merged: ${regexCount(merged)} regex filters, reference: ${regexCount(reference)}`);
		// The env-style denies are in force: the workspace's own and one at depth, in any spelling.
		const answers = await checkProfile(merged, 'agent-spot', [join(ws, '.env'), join(ws, 'A', 'B', '.ENV.LOCAL'), join(ws, 'src', 'index.ts'), join(ws, '.env.example')]);
		assert.deepStrictEqual(answers.slice(0, 4), ['1', '1', '0', '0']);
	});

	macTest('SB-EQ-1: the workspace profile (deny by default) allows and denies what it did before the merge', async () => {
		await assertEquivalent('workspace', await resolve(builtinProfile('workspace'), 'workspace'));
	});

	macTest('SB-EQ-1: every rule kind (git allow list, write files, nested and duplicate roots, multi-name patterns, isolation) is unchanged', async () => {
		const base = await resolve(builtinProfile('workspace'), 'synthetic');
		const git = join(root, 'main', '.git');
		const policy: IResolvedSandboxPolicy = {
			...base,
			readAll: true,
			write: [...base.write, git],
			writeFiles: [join(root, 'state.json'), join(root, 'other.json'), join(root, 'Mixed.Case.json')],
			deny: [...base.deny, join(root, 'secret'), join(root, 'secret', 'inner'), join(root, 'SECRET-2'), join(root, '1234')],
			protect: [...base.protect, join(ws, '.vscode'), join(ws, '.vscode'), join(ws, 'a', '.idea')],
			denyPatterns: [...base.denyPatterns, { root: ws, names: ['.env'] }, { root: join(ws, 'a'), names: ['.env'] }, { root: ws, names: ['.netrc'] }, { root: '/', names: ['.pgpass'] }, { root: ws, names: ['config', 'credentials.json'] }],
			protectPatterns: [...base.protectPatterns, { root: ws, names: ['.git', 'hooks'] }, { root: ws, names: ['.git', 'config'] }, { root: join(ws, 'sub'), names: ['.git', 'hooks'] }, { root: git, names: ['commondir'] }],
			newRepositoryGuard: [ws, join(ws, 'sub')],
			gitDirs: [{ root: ws, anyDepth: true }, { root: join(ws, 'sub'), anyDepth: true }, { root: git, anyDepth: false }, { root: '/', anyDepth: true }],
			isolated: [{ root: join(root, 'runs'), keep: join(root, 'runs', 'mine') }],
		};
		await assertEquivalent('synthetic', policy);
	});
});
