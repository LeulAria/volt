/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { FFF_VERSION } from '../../../voltCodeIndex/common/fff.js';
import { FffEngine } from '../../../voltCodeIndex/node/fffEngine.js';
import { DEVICE_HUB_PACKAGE, DEVICE_HUB_VERSION } from '../../../voltDevices/common/deviceHubPin.js';
import { DeviceHub } from '../../../voltDevices/node/deviceHub.js';
import { HelperIntegrity, HelperRefusedError, IHelperIntegrityOptions, IVoltHelpersManifest, machOSlice, treeDigest, VOLT_HELPERS_MANIFEST } from '../../node/helperIntegrity.js';

function sha256(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** A stand-in for a swapped helper: what an attacker drops in place of the real binary. */
const STUB = '#!/bin/sh\necho swapped\n';

suite('Volt helper integrity (INV-27)', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let base: string;
	let outRoot: string;

	setup(async () => {
		base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-helpers-')));
		outRoot = join(base, 'out');
		await fs.mkdir(join(outRoot, 'volt-helpers'), { recursive: true });
	});

	teardown(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	const target = `${process.platform}-${process.arch}`;

	function integrity(overrides: Partial<IHelperIntegrityOptions> = {}): HelperIntegrity {
		return new HelperIntegrity({
			outRoot: () => outRoot,
			platform: process.platform,
			arch: process.arch,
			developerMode: false,
			signing: () => undefined,
			appSigner: async () => undefined,
			...overrides,
		});
	}

	/** Puts `files` (id -> name -> bytes) under out/volt-helpers and lists them in the manifest. */
	async function bundle(files: Record<string, Record<string, string>>, digest: (bytes: Buffer) => string = sha256): Promise<void> {
		const helpers: Record<string, { files: { path: string; sha256: Record<string, string> }[] }> = {};
		for (const [id, entries] of Object.entries(files)) {
			helpers[id] = { files: [] };
			for (const [name, content] of Object.entries(entries)) {
				const bytes = Buffer.from(content);
				await fs.writeFile(join(outRoot, 'volt-helpers', name), bytes, { mode: 0o755 });
				helpers[id].files.push({ path: `volt-helpers/${name}`, sha256: { [target]: digest(bytes) } });
			}
		}
		const manifest: IVoltHelpersManifest = { version: 1, helpers };
		await fs.writeFile(join(outRoot, VOLT_HELPERS_MANIFEST), JSON.stringify(manifest));
	}

	test('HELPER-1: a swapped speech helper is refused with a reason', async () => {
		await bundle({ speech: { 'volt-speech': '#!/bin/sh\necho speech\n' } });
		const checker = integrity();
		const helper = join(outRoot, 'volt-helpers', 'volt-speech');
		assert.strictEqual(await checker.bundledPath('speech'), helper);
		assert.deepStrictEqual(await checker.verify('speech', helper), { ok: true });

		// Replaced by rename (a new inode), as a same-user process would do it.
		const planted = join(base, 'planted');
		await fs.writeFile(planted, STUB, { mode: 0o755 });
		await fs.rename(planted, helper);
		const verdict = await checker.verify('speech', helper);
		assert.strictEqual(verdict.ok, false);
		assert.match(verdict.reason ?? '', /does not match this build's manifest/);
		await assert.rejects(checker.assert('speech', helper), (err: unknown) => err instanceof HelperRefusedError && /speech/.test(err.message));
	});

	test('HELPER-1: an in-place rewrite that restores mtime is still refused (the cache keys on ctime)', async () => {
		await bundle({ speech: { 'volt-speech': '#!/bin/sh\necho speech\n' } });
		const checker = integrity();
		const helper = join(outRoot, 'volt-helpers', 'volt-speech');
		assert.ok((await checker.verify('speech', helper)).ok);
		const before = await fs.stat(helper);
		await fs.writeFile(helper, '#!/bin/sh\necho speeX\n');
		await fs.utimes(helper, before.atime, before.mtime);
		assert.strictEqual((await checker.verify('speech', helper)).ok, false);
	});

	test('HELPER-1: a helper outside the bundle, a symlink, or a missing manifest is refused', async () => {
		await bundle({ speech: { 'volt-speech': 'real' } });
		const checker = integrity();
		const elsewhere = join(base, 'volt-speech');
		await fs.writeFile(elsewhere, 'real');
		assert.match((await checker.verify('speech', elsewhere)).reason ?? '', /is not the speech helper this build ships/);
		const link = join(base, 'link');
		await fs.symlink(join(outRoot, 'volt-helpers', 'volt-speech'), link);
		assert.match((await checker.verify('speech', link)).reason ?? '', /not a regular file/);
		await fs.rm(join(outRoot, VOLT_HELPERS_MANIFEST));
		assert.match((await integrity().verify('speech', join(outRoot, 'volt-helpers', 'volt-speech'))).reason ?? '', /no helper manifest/);
	});

	test('HELPER-2: a swapped desktop helper and its script are refused', async () => {
		await bundle({ desktop: { 'volt-desktop': 'desktop binary' }, 'desktop-script': { 'volt_desktop_linux.py': 'print("hi")\n' } });
		const checker = integrity();
		const binary = join(outRoot, 'volt-helpers', 'volt-desktop');
		const script = join(outRoot, 'volt-helpers', 'volt_desktop_linux.py');
		assert.ok((await checker.verify('desktop', binary)).ok);
		assert.ok((await checker.verify('desktop-script', script)).ok);
		await fs.writeFile(binary, STUB);
		await fs.writeFile(script, 'import os; os.system("id")\n');
		assert.strictEqual((await checker.verify('desktop', binary)).ok, false);
		assert.strictEqual((await checker.verify('desktop-script', script)).ok, false);
		// One helper's file does not pass as another's.
		assert.strictEqual((await checker.verify('speech', binary)).ok, false);
	});

	test('HELPER-3: a swapped FFF binary is refused, and FFF is skipped with the reason', async () => {
		const tools = join(base, 'tools');
		const managed = join(tools, 'fff', FFF_VERSION, process.platform === 'win32' ? 'fff-mcp.exe' : 'fff-mcp');
		await fs.mkdir(join(tools, 'fff', FFF_VERSION), { recursive: true });
		await fs.writeFile(managed, `#!/usr/bin/env node\nconsole.log('fff-mcp ${FFF_VERSION} (stub)');\n`, { mode: 0o755 });
		const verdict = await integrity().verify('fff', managed);
		assert.strictEqual(verdict.ok, false);
		assert.match(verdict.reason ?? '', /not the FFF release Volt pins/);
		const fff = new FffEngine(tools, () => { }, { callMs: 1_000, firstCallMs: 2_000, retryAfterMs: 0 }, integrity());
		try {
			const status = await fff.status();
			assert.strictEqual(status.state, 'error');
			assert.strictEqual(status.managed, true);
			assert.match(status.error ?? '', /refused: .*not the FFF release Volt pins/);
			const found = await fff.findFiles(base, 'a', 5);
			assert.strictEqual(found.kind, 'skipped');
			assert.match(found.kind === 'skipped' ? found.reason : '', /refused/);
		} finally {
			fff.dispose();
		}
	});

	test('HELPER-4: a swapped file in the installed device hub is refused before launch', async () => {
		const tools = join(base, 'tools');
		const dir = join(tools, DEVICE_HUB_PACKAGE, DEVICE_HUB_VERSION);
		const cli = join(dir, 'node_modules', DEVICE_HUB_PACKAGE, 'dist', 'server');
		await fs.mkdir(cli, { recursive: true });
		await fs.writeFile(join(cli, 'cli.mjs'), 'process.exit(0)\n');
		await fs.writeFile(join(dir, '.install-complete'), `pinned ${DEVICE_HUB_VERSION}\n`);
		const verdict = await integrity().verify('device-hub', dir);
		assert.strictEqual(verdict.ok, false);
		assert.match(verdict.reason ?? '', /not the one Volt pins/);
		let npmAsked = false;
		const hub = new DeviceHub(tools, async () => ({ ...process.env }), async name => {
			npmAsked ||= name === 'npm';
			return undefined;
		}, new NullLogService(), async () => [], integrity());
		try {
			await assert.rejects(hub.prewarm(), (err: unknown) => err instanceof HelperRefusedError && /device-hub/.test(err.message));
			// Refused from the existing install: nothing was reinstalled and nothing ran.
			assert.strictEqual(npmAsked, false);
		} finally {
			hub.dispose();
		}
	});

	test('developer mode: runtime-built helpers are pinned for the session, refused in a packaged build', async () => {
		const built = join(base, 'volt-speech');
		await fs.writeFile(built, 'built at runtime', { mode: 0o755 });
		assert.match((await integrity().trustDeveloperHelper('speech', built)).reason ?? '', /only in the unsigned helpers developer mode/);
		const dev = integrity({ developerMode: true });
		assert.strictEqual((await dev.verify('speech', built)).ok, false, 'not pinned yet');
		assert.ok((await dev.trustDeveloperHelper('speech', built)).ok);
		assert.ok((await dev.verify('speech', built)).ok);
		await fs.writeFile(built, STUB);
		assert.match((await dev.verify('speech', built)).reason ?? '', /changed since Volt built it/);
		assert.strictEqual((await dev.trustDeveloperHelper('speech', built)).ok, false);
	});

	test('a universal Mach-O is checked by this architecture\'s slice', () => {
		const arm = Buffer.from('arm64 slice bytes');
		const x64 = Buffer.from('x86_64 slice bytes!');
		const header = Buffer.alloc(8 + 2 * 20);
		header.writeUInt32BE(0xcafebabe, 0);
		header.writeUInt32BE(2, 4);
		const armAt = header.length;
		const x64At = armAt + arm.length;
		header.writeUInt32BE(0x0100000c, 8);
		header.writeUInt32BE(armAt, 16);
		header.writeUInt32BE(arm.length, 20);
		header.writeUInt32BE(0x01000007, 28);
		header.writeUInt32BE(x64At, 36);
		header.writeUInt32BE(x64.length, 40);
		const fat = Buffer.concat([header, arm, x64]);
		assert.deepStrictEqual(machOSlice(fat, 'arm64'), arm);
		assert.deepStrictEqual(machOSlice(fat, 'x64'), x64);
		assert.strictEqual(machOSlice(fat, 'ia32'), undefined);
		const thin = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
		assert.deepStrictEqual(machOSlice(thin, 'arm64'), thin);
	});

	(process.platform === 'darwin' ? test : test.skip)('macOS: lipo keeps each slice, and a signed build requires Volt\'s team signature', async () => {
		const source = join(base, 'main.c');
		await fs.writeFile(source, 'int main(void) { return 0; }\n');
		const arm = join(base, 'h-arm64');
		const x64 = join(base, 'h-x64');
		execFileSync('/usr/bin/cc', ['-arch', 'arm64', '-o', arm, source]);
		execFileSync('/usr/bin/cc', ['-arch', 'x86_64', '-o', x64, source]);
		const helper = join(outRoot, 'volt-helpers', 'volt-desktop');
		execFileSync('/usr/bin/lipo', ['-create', arm, x64, '-output', helper]);
		const manifest: IVoltHelpersManifest = {
			version: 1,
			helpers: { desktop: { files: [{ path: 'volt-helpers/volt-desktop', sha256: { 'darwin-arm64': sha256(await fs.readFile(arm)), 'darwin-x64': sha256(await fs.readFile(x64)) } }] } },
		};
		await fs.writeFile(join(outRoot, VOLT_HELPERS_MANIFEST), JSON.stringify(manifest));
		assert.deepStrictEqual(await integrity({ arch: 'arm64' }).verify('desktop', helper), { ok: true });
		assert.deepStrictEqual(await integrity({ arch: 'x64' }).verify('desktop', helper), { ok: true });

		// A signed build: the ad-hoc helper is not signed by Volt's team, so it is refused.
		const signed = await integrity({ signing: () => ({ darwinTeamId: 'ABCDE12345' }) }).verify('desktop', helper);
		assert.strictEqual(signed.ok, false);
		assert.match(signed.reason ?? '', /not signed by Volt's team ABCDE12345/);
		const derived = await integrity({ appSigner: async () => 'ABCDE12345' }).verify('desktop', helper);
		assert.strictEqual(derived.ok, false);
		assert.match(derived.reason ?? '', /not signed by Volt's team/);
	});

	test('the device hub tree digest covers every file but the hub\'s own runtime downloads', async () => {
		const root = join(base, 'tree');
		await fs.mkdir(join(root, 'a', 'b'), { recursive: true });
		await fs.writeFile(join(root, 'a', 'b', 'x.js'), 'x');
		await fs.writeFile(join(root, 'y.js'), 'y');
		const first = await treeDigest(root);
		assert.strictEqual(await treeDigest(root), first);
		await fs.writeFile(join(root, 'a', 'shadow.js'), 'added');
		const added = await treeDigest(root);
		assert.notStrictEqual(added, first, 'an added file changes the digest');
		assert.strictEqual(await treeDigest(root, path => path === 'a/shadow.js'), first);
	});
});
