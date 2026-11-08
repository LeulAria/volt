/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Race-free host file operations (B-17, INV-12): safeOpen.ts and the sandbox file broker.
 *
 * RACE-1..3 run a second process that keeps swapping a folder or the file itself for a symlink to
 * a folder outside the root while 1,000 writes (or reads) go through the broker, and check that no
 * byte lands outside (or comes back from outside).
 *
 * macOS runs everything (O_NOFOLLOW_ANY). Linux needs the `volt-fsd` helper: the container rig
 * builds it (`scripts/volt-sandbox-linux-test.sh files`); without it the Linux cases skip loudly,
 * or FAIL when VOLT_SANDBOX_REQUIRED is set; the Node-only path for a build without the helper
 * (existing files only) runs on Linux either way. Windows is compile-checked only (no test here).
 */

import assert from 'assert';
import { spawn, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { recordHelperHash } from '../../../voltHelpers/node/helperIntegrity.js';
import { IResolvedSandboxPolicy } from '../../../voltSandbox/common/sandboxResolved.js';
import { brokerReadFile, brokerWriteFile, policyFileRequest } from '../../node/sandboxFileBroker.js';
import { componentsBelow, ISafeOpenOptions, SafeOpenError, safeReadFile, safeWriteFile } from '../../node/safeOpen.js';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const required = !!process.env.VOLT_SANDBOX_REQUIRED;
/** The Linux helper: built by the rig into this path, or into `.build` of a checkout. */
const fsdPath = isLinux ? [process.env.VOLT_FSD_PATH, join(process.cwd(), '.build', 'volt-fsd')].find((path): path is string => !!path && existsSync(path)) : undefined;
const supported = isMac || (isLinux && !!fsdPath);
const RACE_OPS = 1_000;

if (isLinux && !fsdPath) {
	const message = 'volt-fsd is not built here: the race-free file tests cannot run on Linux';
	if (required) {
		throw new Error(`${message} (VOLT_SANDBOX_REQUIRED is set; failing instead of skipping)`);
	}
	console.warn(`\n\n!!! ${message}. They are SKIPPED. Build it with scripts/volt-sandbox-linux-test.sh files.\n`);
}
if (fsdPath) {
	// The rig built it: the hash recorded for this run, as a build records it in product.json.
	recordHelperHash('volt-fsd', createHash('sha256').update(readFileSync(fsdPath)).digest('hex'));
}

const options: ISafeOpenOptions = { fsdPath };
const safeTest = supported ? test : test.skip;

interface IFixture {
	/** The writable root (a real path). */
	readonly ws: string;
	/** Outside the root: what a swapped symlink points at. */
	readonly outside: string;
	readonly base: string;
}

async function fixture(): Promise<IFixture> {
	const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-safe-open-')));
	const ws = join(base, 'ws');
	const outside = join(base, 'home');
	await fs.mkdir(ws);
	await fs.mkdir(outside);
	return { ws, outside, base };
}

function policy(f: IFixture): IResolvedSandboxPolicy {
	return {
		name: 'test',
		platform: process.platform,
		readAll: false,
		read: [],
		write: [f.ws],
		writeFiles: [],
		deny: [join(f.ws, 'secrets')],
		protect: [join(f.ws, '.git')],
		denyPatterns: [{ root: f.ws, names: ['.env'] }],
		protectPatterns: [],
		newRepositoryGuard: [],
		network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
		unixSockets: [],
		systemServices: false,
		limits: {},
		env: {},
		cwd: f.ws,
		tmp: join(f.base, 'tmp'),
		home: f.outside,
	};
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		return err instanceof SafeOpenError ? err.refusal : `other: ${err}`;
	}
	return 'none';
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

/**
 * A process that swaps `target` between a real folder (or file) and a symlink to `linkTo`, as
 * fast as it can, until killed. Renames are atomic: `target` is always one or the other (or briefly
 * absent).
 */
function startFlipper(target: string, linkTo: string, kind: 'dir' | 'file'): { readonly child: ChildProcess; readonly flips: () => Promise<number> } {
	const script = `
		const fs = require('fs');
		const target = process.argv[1], linkTo = process.argv[2], kind = process.argv[3];
		const real = target + '.real', link = target + '.link';
		const present = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
		const restore = () => {
			if (!present(real)) { if (kind === 'dir') { fs.mkdirSync(real); } else { fs.writeFileSync(real, 'workspace'); } }
			if (!present(link)) { fs.symlinkSync(linkTo, link); }
		};
		// Puts 'from' at the target for a moment and back; a folder the writer made meanwhile is cleared away.
		const flip = from => {
			// The writer may be filling that folder meanwhile, so clearing it can fail too: try again next round.
			try { fs.renameSync(from, target); } catch { try { fs.rmSync(target, { recursive: true, force: true }); } catch { } return; }
			try { fs.renameSync(target, from); } catch { }
			flips++;
		};
		let flips = 0;
		process.on('SIGTERM', () => { fs.writeFileSync(target + '.flips', String(flips)); process.exit(0); });
		const tick = () => {
			for (let i = 0; i < 200; i++) {
				restore();
				flip(real);
				flip(link);
			}
			setImmediate(tick);
		};
		tick();
	`;
	const child = spawn(process.execPath, ['-e', script, target, linkTo, kind], { env: { ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
	return {
		child,
		flips: async () => {
			// A flipper that died early has no count to report: 0, which the tests' flip check fails on.
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise(resolve => child.once('exit', resolve));
				child.kill('SIGTERM');
				await exited;
			}
			return Number(await fs.readFile(`${target}.flips`, 'utf8').catch(() => '0'));
		},
	};
}

suite('Volt race-free host file operations (B-17)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let f: IFixture;
	const flippers: ChildProcess[] = [];

	setup(async () => {
		f = await fixture();
	});

	teardown(async () => {
		for (const child of flippers.splice(0)) {
			child.kill('SIGKILL');
		}
		await fs.rm(f.base, { recursive: true, force: true });
	});

	test('componentsBelow: only plain paths strictly inside the root', () => {
		assert.deepStrictEqual(componentsBelow('/r', '/r/a/b.txt'), ['a', 'b.txt']);
		for (const path of ['/r', '/r/../x', '/rx/a', '/elsewhere', 'r/a']) {
			assert.throws(() => componentsBelow('/r', path), SafeOpenError, path);
		}
	});

	safeTest('writes and creates folders; the result says what was there before', async () => {
		const path = join(f.ws, 'src', 'deep', 'a.ts');
		const created = await safeWriteFile({ root: f.ws, path }, Buffer.from('one'), options);
		assert.strictEqual(created.before, undefined);
		assert.strictEqual(created.finalPath, path);
		const second = await safeWriteFile({ root: f.ws, path }, Buffer.from('two!'), options);
		assert.strictEqual(second.before?.toString(), 'one');
		assert.strictEqual(await fs.readFile(path, 'utf8'), 'two!');
		const read = await safeReadFile({ root: f.ws, path }, options);
		assert.strictEqual(read.content.toString(), 'two!');
	});

	safeTest('refuses a symlinked file, a symlinked folder and a hard link, and leaves the targets alone', async () => {
		await fs.writeFile(join(f.outside, '.zshrc'), 'user');
		await fs.symlink(join(f.outside, '.zshrc'), join(f.ws, 'file-link'));
		await fs.symlink(f.outside, join(f.ws, 'dir-link'));
		await fs.link(join(f.outside, '.zshrc'), join(f.ws, 'hard'));
		assert.strictEqual(await refusal(safeWriteFile({ root: f.ws, path: join(f.ws, 'file-link') }, Buffer.from('x'), options)), 'symlink');
		assert.strictEqual(await refusal(safeWriteFile({ root: f.ws, path: join(f.ws, 'dir-link', '.zshrc') }, Buffer.from('x'), options)), 'symlink');
		assert.strictEqual(await refusal(safeWriteFile({ root: f.ws, path: join(f.ws, 'dir-link', 'new', 'x') }, Buffer.from('x'), options)), 'symlink');
		assert.strictEqual(await refusal(safeReadFile({ root: f.ws, path: join(f.ws, 'dir-link', '.zshrc') }, options)), 'symlink');
		assert.strictEqual(await refusal(safeWriteFile({ root: f.ws, path: join(f.ws, 'hard'), refuseHardLinks: true }, Buffer.from('x'), options)), 'hardlink');
		assert.strictEqual(await fs.readFile(join(f.outside, '.zshrc'), 'utf8'), 'user');
		assert.deepStrictEqual(await listAll(f.outside), ['.zshrc']);
	});

	safeTest('the floor is checked on the final path', async () => {
		const seen: string[] = [];
		const why = await refusal(safeWriteFile({ root: f.ws, path: join(f.ws, 'a.txt'), floor: final => { seen.push(final); return seen.length > 1 ? 'denied after open' : undefined; } }, Buffer.from('x'), options));
		assert.strictEqual(why, 'floor');
		assert.deepStrictEqual(seen, [join(f.ws, 'a.txt'), join(f.ws, 'a.txt')], 'once before the open, once on the opened file');
		assert.strictEqual(existsSync(join(f.ws, 'a.txt')) ? await fs.readFile(join(f.ws, 'a.txt'), 'utf8') : '', '', 'nothing written');
	});

	safeTest('the broker: the sandbox policy on the real path, deny patterns, protected and denied folders', async () => {
		const p = policy(f);
		await fs.mkdir(join(f.ws, 'secrets'));
		await fs.writeFile(join(f.ws, 'secrets', 'k'), 'secret');
		await fs.mkdir(join(f.ws, '.git'));
		await fs.symlink(f.outside, join(f.ws, 'home'));
		await brokerWriteFile(p, join(f.ws, 'ok.txt'), Buffer.from('fine'), options);
		assert.strictEqual(await fs.readFile(join(f.ws, 'ok.txt'), 'utf8'), 'fine');
		assert.strictEqual(await refusal(brokerWriteFile(p, join(f.ws, 'home', '.zshrc'), Buffer.from('x'), options)), 'floor', 'resolves outside the writable root');
		assert.strictEqual(await refusal(brokerWriteFile(p, join(f.ws, 'sub', '.env'), Buffer.from('x'), options)), 'floor', 'deny pattern');
		assert.strictEqual(await refusal(brokerWriteFile(p, join(f.ws, '.git', 'config'), Buffer.from('x'), options)), 'floor', 'protected');
		assert.strictEqual(await refusal(brokerReadFile(p, join(f.ws, 'secrets', 'k'), options)), 'floor', 'denied');
		assert.strictEqual(await refusal(brokerWriteFile(p, 'relative.txt', Buffer.from('x'), options)), 'outside');
		assert.strictEqual((await brokerReadFile(p, join(f.ws, 'ok.txt'), options)).content.toString(), 'fine');
		assert.strictEqual((await policyFileRequest(p, join(f.ws, 'a', 'b'), 'write')).root, f.ws);
		assert.deepStrictEqual(await listAll(f.outside), []);
	});

	safeTest('RACE-1: a folder flipped to a symlink to home during 1,000 writes: no byte lands outside', async function () {
		this.timeout(120_000);
		const flipper = startFlipper(join(f.ws, 'dir'), f.outside, 'dir');
		flippers.push(flipper.child);
		await new Promise(resolve => setTimeout(resolve, 100));
		const p = policy(f);
		let written = 0;
		const refused = new Map<string, number>();
		for (let i = 0; i < RACE_OPS; i++) {
			try {
				await brokerWriteFile(p, join(f.ws, 'dir', '.zshrc'), Buffer.from(`write ${i}`), options);
				written++;
			} catch (err) {
				const key = err instanceof SafeOpenError ? err.refusal : 'other';
				refused.set(key, (refused.get(key) ?? 0) + 1);
			}
		}
		const flips = await flipper.flips();
		assert.deepStrictEqual(await listAll(f.outside), [], `nothing outside (written ${written}, refused ${JSON.stringify([...refused])}, flips ${flips})`);
		assert.ok(flips > 50, `the folder kept flipping (${flips})`);
		assert.ok(written > 0, 'some writes landed in the real folder');
		assert.strictEqual(refused.get('other') ?? 0, 0, 'every failure is a typed refusal');
	});

	safeTest('RACE-2: the file itself flipped to a symlink to a file at home during 1,000 writes: the home file never changes', async function () {
		this.timeout(120_000);
		const victim = join(f.outside, '.bashrc');
		await fs.writeFile(victim, 'user');
		const flipper = startFlipper(join(f.ws, 'rc'), victim, 'file');
		flippers.push(flipper.child);
		await new Promise(resolve => setTimeout(resolve, 100));
		const p = policy(f);
		let written = 0;
		for (let i = 0; i < RACE_OPS; i++) {
			try {
				await brokerWriteFile(p, join(f.ws, 'rc'), Buffer.from(`write ${i}`), options);
				written++;
			} catch (err) {
				assert.ok(err instanceof SafeOpenError, String(err));
			}
		}
		const flips = await flipper.flips();
		assert.strictEqual(await fs.readFile(victim, 'utf8'), 'user', `home file untouched (written ${written}, flips ${flips})`);
		assert.deepStrictEqual(await listAll(f.outside), ['.bashrc']);
		assert.ok(flips > 50, `the file kept flipping (${flips})`);
	});

	(isLinux ? test : test.skip)('Linux without volt-fsd: an existing file is written race-free (RACE-1 on edits); creating one is refused', async function () {
		this.timeout(120_000);
		const p = policy(f);
		const noHelper: ISafeOpenOptions = {};
		assert.strictEqual(await refusal(brokerWriteFile(p, join(f.ws, 'new.txt'), Buffer.from('x'), noHelper)), 'helper');
		assert.strictEqual(existsSync(join(f.ws, 'new.txt')), false);
		await fs.writeFile(join(f.ws, 'edit.txt'), 'one');
		assert.strictEqual((await brokerWriteFile(p, join(f.ws, 'edit.txt'), Buffer.from('two'), noHelper)).before?.toString(), 'one');
		assert.strictEqual(await fs.readFile(join(f.ws, 'edit.txt'), 'utf8'), 'two');
		await fs.link(join(f.ws, 'edit.txt'), join(f.ws, 'edit-link.txt'));
		assert.strictEqual(await refusal(brokerWriteFile(p, join(f.ws, 'edit.txt'), Buffer.from('x'), noHelper)), 'hardlink');

		// The folder holds the file to edit; its swapped-in link points at a home with the same name.
		await fs.writeFile(join(f.outside, '.zshrc'), 'user');
		await fs.mkdir(join(f.ws, 'dir.real'));
		await fs.writeFile(join(f.ws, 'dir.real', '.zshrc'), 'workspace');
		const flipper = startFlipper(join(f.ws, 'dir'), f.outside, 'dir');
		flippers.push(flipper.child);
		await new Promise(resolve => setTimeout(resolve, 100));
		let written = 0;
		for (let i = 0; i < RACE_OPS; i++) {
			try {
				await brokerWriteFile(p, join(f.ws, 'dir', '.zshrc'), Buffer.from(`write ${i}`), noHelper);
				written++;
			} catch (err) {
				assert.ok(err instanceof SafeOpenError, String(err));
			}
		}
		const flips = await flipper.flips();
		assert.strictEqual(await fs.readFile(join(f.outside, '.zshrc'), 'utf8'), 'user', `home file untouched (written ${written}, flips ${flips})`);
		assert.deepStrictEqual(await listAll(f.outside), ['.zshrc']);
		assert.ok(flips > 50, `the folder kept flipping (${flips})`);
		assert.ok(written > 0, 'some edits landed in the real folder');
	});

	safeTest('RACE-3: a folder flipped to a symlink during 1,000 reads: a canary at home never comes back', async function () {
		this.timeout(120_000);
		await fs.writeFile(join(f.outside, 'id_rsa'), 'CANARY-PRIVATE-KEY');
		// The real folder holds a file of the same name, so a read that lands there is allowed.
		await fs.mkdir(join(f.ws, 'keys.real'));
		await fs.writeFile(join(f.ws, 'keys.real', 'id_rsa'), 'workspace copy');
		const flipper = startFlipper(join(f.ws, 'keys'), f.outside, 'dir');
		flippers.push(flipper.child);
		await new Promise(resolve => setTimeout(resolve, 100));
		const p = policy(f);
		let read = 0;
		for (let i = 0; i < RACE_OPS; i++) {
			try {
				const result = await brokerReadFile(p, join(f.ws, 'keys', 'id_rsa'), options);
				assert.ok(!result.content.toString().includes('CANARY'), `read ${i} returned the canary`);
				read++;
			} catch (err) {
				if (err instanceof assert.AssertionError) {
					throw err;
				}
				assert.ok(err instanceof SafeOpenError, String(err));
			}
		}
		const flips = await flipper.flips();
		assert.ok(flips > 50, `the folder kept flipping (${flips}; ${read} reads answered)`);
	});
});
