/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { darwinTeamRequirement, verifyVoltInstaller, VoltExec, VoltInstallerSignatureError, win32PublisherMatches } from '../../node/voltInstallerSignature.js';

/** INV-28: platform signature checks before the updater installs anything (SUP-4, SUP-5). */
suite('Volt installer signature', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface ICall { readonly file: string; readonly args: readonly string[]; readonly env?: NodeJS.ProcessEnv }

	/** A fake process runner: answers each call with the next result, or rejects like a failed exit. */
	function fakeExec(results: ({ stdout?: string; stderr?: string } | Error)[]): { run: VoltExec; calls: ICall[] } {
		const calls: ICall[] = [];
		const run: VoltExec = async (file, args, options) => {
			calls.push({ file, args, env: options?.env });
			const result = results.shift();
			if (!result) {
				throw new Error('unexpected call');
			}
			if (result instanceof Error) {
				throw result;
			}
			return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
		};
		return { run, calls };
	}

	const logs: string[] = [];
	const log = (message: string) => logs.push(message);
	setup(() => logs.length = 0);

	const authenticode = (status: string, subject: string) => ({ stdout: JSON.stringify({ Status: status, Subject: subject }) });

	test('SUP-4: a Windows installer without a valid Authenticode signature by the pinned publisher is refused', async () => {
		const pins = { win32Publisher: 'CN=Volt ADK' };
		for (const [status, subject] of [['NotSigned', ''], ['HashMismatch', 'CN=Volt ADK'], ['NotTrusted', 'CN=Volt ADK'], ['Valid', 'CN=Someone Else, O=Someone Else']]) {
			const { run } = fakeExec([authenticode(status, subject)]);
			await assert.rejects(verifyVoltInstaller('win32', 'C:\\Temp\\VoltSetup.exe', pins, log, run), VoltInstallerSignatureError);
		}
		// PowerShell failing to run is a refusal, never a pass.
		await assert.rejects(verifyVoltInstaller('win32', 'C:\\Temp\\VoltSetup.exe', pins, log, fakeExec([new Error('spawn ENOENT')]).run), /Could not check/);
		await assert.rejects(verifyVoltInstaller('win32', 'C:\\Temp\\VoltSetup.exe', pins, log, fakeExec([{ stdout: 'garbage' }]).run), /Could not read/);

		const { run, calls } = fakeExec([authenticode('Valid', 'CN=Volt ADK, O=Volt ADK, L=Addis Ababa, C=ET')]);
		assert.strictEqual(await verifyVoltInstaller('win32', 'C:\\Temp\\VoltSetup.exe', pins, log, run), 'verified');
		assert.match(calls[0].file, /powershell\.exe$/i);
		assert.strictEqual(calls[0].env?.['VOLT_VERIFY_FILE'], 'C:\\Temp\\VoltSetup.exe');
		assert.ok(!calls[0].args.some(arg => arg.includes('VoltSetup.exe')), 'the path goes through the environment, not the script');
		assert.deepStrictEqual(Object.keys(calls[0].env ?? {}).filter(key => !['SystemRoot', 'windir', 'VOLT_VERIFY_FILE', 'PSModulePath', 'TEMP', 'TMP', 'USERPROFILE'].includes(key)), [], 'no other environment reaches PowerShell');
	});

	test('SUP-4: publisher pins match the signer subject', () => {
		const subject = 'CN=Volt ADK, O=Volt ADK, L=Addis Ababa, C=ET';
		assert.ok(win32PublisherMatches(subject, 'CN=Volt ADK'));
		assert.ok(win32PublisherMatches(subject, 'volt adk'));
		assert.ok(win32PublisherMatches(subject, 'CN=Volt ADK,O=Volt ADK, L=Addis Ababa,C=ET'));
		assert.ok(!win32PublisherMatches(subject, 'CN=Volt'));
		assert.ok(!win32PublisherMatches(subject, 'CN=Volt ADK, O=Other'));
		assert.ok(!win32PublisherMatches('CN=Volt ADK Evil', 'CN=Volt ADK'));
		assert.ok(!win32PublisherMatches('O=Volt ADK', 'Volt ADK'));
	});

	test('SUP-5: another channel\'s macOS app not signed by the pinned team is refused', async () => {
		const pins = { darwinTeamIdentifier: 'ABCDE12345' };
		const unsigned = Object.assign(new Error('Command failed'), { stderr: 'Volt Nightly.app: code object is not signed at all' });
		await assert.rejects(verifyVoltInstaller('darwin', '/tmp/x/Volt Nightly.app', pins, log, fakeExec([unsigned]).run), /not signed by team ABCDE12345: Volt Nightly\.app: code object is not signed at all/);
		// Passing the requirement but reporting another team (belt and braces) is refused too.
		await assert.rejects(verifyVoltInstaller('darwin', '/tmp/x/Volt Nightly.app', pins, log, fakeExec([{}, { stderr: 'TeamIdentifier=ZZZZZ99999' }]).run), /signed by team ZZZZZ99999, not ABCDE12345/);
		await assert.rejects(verifyVoltInstaller('darwin', '/tmp/x/Volt Nightly.app', { darwinTeamIdentifier: 'abc" or true' }, log, fakeExec([]).run), /not a team id/);

		const { run, calls } = fakeExec([{}, { stderr: 'Identifier=com.volt.nightly\nTeamIdentifier=ABCDE12345\n' }]);
		assert.strictEqual(await verifyVoltInstaller('darwin', '/tmp/x/Volt Nightly.app', pins, log, run), 'verified');
		assert.deepStrictEqual(calls[0], { file: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', '-R', `=${darwinTeamRequirement('ABCDE12345')}`, '/tmp/x/Volt Nightly.app'], env: undefined });
	});

	test('SUP-5: real codesign refuses an unsigned app bundle (macOS)', async function () {
		if (!isMacintosh) {
			this.skip(); // codesign exists only on macOS; the fake-runner tests above cover the logic everywhere
		}
		this.timeout(30000);
		const root = await fs.promises.mkdtemp(join(tmpdir(), 'volt-sup5-'));
		try {
			const app = join(root, 'Volt Nightly.app');
			await fs.promises.mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
			await fs.promises.writeFile(join(app, 'Contents', 'MacOS', 'Volt Nightly'), '#!/bin/sh\necho tampered\n', { mode: 0o755 });
			await assert.rejects(verifyVoltInstaller('darwin', app, { darwinTeamIdentifier: 'ABCDE12345' }, log), /not signed by team ABCDE12345/);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test('without pins nothing is run and the skip is logged', async () => {
		const { run, calls } = fakeExec([]);
		assert.strictEqual(await verifyVoltInstaller('darwin', '/tmp/Volt Beta.app', undefined, log, run), 'unpinned');
		assert.strictEqual(await verifyVoltInstaller('win32', 'C:\\Temp\\VoltSetup.exe', { darwinTeamIdentifier: 'ABCDE12345' }, log, run), 'unpinned');
		assert.strictEqual(calls.length, 0);
		assert.strictEqual(logs.length, 2);
		assert.match(logs[0], /darwinTeamIdentifier/);
		assert.match(logs[1], /win32Publisher/);
	});
});
