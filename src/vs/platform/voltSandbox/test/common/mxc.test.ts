/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	buildMxcRequest, checkMxcEvidence, checkMxcProbe, checkWindowsFloor, classifyWindowsImage, GIT_BASH_REFUSAL, IMxcAttestation, IMxcRequestInput, isWindowsPathInside,
	isWindowsVolumeRoot, MXC_CONFIG_VERSION, mxcControlText, MxcPolicyError, normalizeWindowsPath, parseMxcAttestation, parseMxcStatus, parseWindowsVersion, PE_DYNAMIC_BASE,
	quoteWindowsArgument, readPeInfo, windowsAncestors, windowsCommandLine, workloadEnv, WSL_REFUSAL,
} from '../../common/mxc.js';
import { allEnforcement, checkEnforcement, ISandboxBackendCapabilities } from '../../common/sandboxBackend.js';
import { builtinProfile } from '../../common/sandboxProfiles.js';
import { IResolvedSandboxPolicy } from '../../common/sandboxResolved.js';

const HOME = 'C:\\Users\\dev';
const WS = 'D:\\code\\proj';
const TMP = 'C:\\Users\\dev\\.volt\\sandbox\\runs\\volt-sbx-1\\tmp';
const CTL = 'C:\\Users\\dev\\.volt\\sandbox\\runs\\volt-sbx-1\\ctl';

function policy(overrides: Partial<IResolvedSandboxPolicy> = {}): IResolvedSandboxPolicy {
	return {
		name: 'workspace', platform: 'win32', readAll: false,
		read: ['C:\\Windows', 'C:\\Program Files'],
		write: [WS, TMP], writeFiles: [],
		deny: [`${HOME}\\.ssh`, `${HOME}\\AppData\\Roaming\\Microsoft\\Credentials`],
		protect: [`${WS}\\.git\\config`, `${WS}\\.git\\hooks`, `${WS}\\.vscode`],
		denyPatterns: [], protectPatterns: [], newRepositoryGuard: [],
		network: { mode: 'none', allow: [], loopbackPorts: [], listen: false },
		unixSockets: [], systemServices: false,
		limits: { wallClockSeconds: 600, cpuSeconds: 300, processes: 512 },
		env: { PATH: `${WS}\\node_modules\\.bin;C:\\Program Files\\nodejs`, LANG: 'en_US.UTF-8' },
		cwd: WS, tmp: TMP, home: HOME,
		...overrides,
	};
}

function input(p: IResolvedSandboxPolicy, overrides: Partial<IMxcRequestInput> = {}): IMxcRequestInput {
	return {
		policy: p, helperPath: `${CTL}\\volt-mxc-helper.exe`, controlFile: `${CTL}\\prologue.txt`, controlDir: CTL, systemRoot: 'C:\\Windows',
		patternDeny: [], patternProtect: [], existing: new Set([`${WS}\\.git\\config`, `${WS}\\.git\\hooks`].map(p => p.toLowerCase())), timeoutMs: 630_000,
		...overrides,
	};
}

/** A minimal PE32+ image with an import table naming `imports`. */
function fakePe(imports: readonly string[], dllCharacteristics = PE_DYNAMIC_BASE, machine = 0xaa64): Uint8Array {
	const data = new Uint8Array(0x800);
	const view = new DataView(data.buffer);
	data[0] = 0x4d; data[1] = 0x5a;
	const pe = 0x80;
	view.setUint32(0x3c, pe, true);
	view.setUint32(pe, 0x00004550, true);
	view.setUint16(pe + 4, machine, true);
	view.setUint16(pe + 6, 1, true);
	view.setUint16(pe + 20, 240, true);
	const opt = pe + 24;
	view.setUint16(opt, 0x20b, true);
	view.setUint16(opt + 70, dllCharacteristics, true);
	const section = opt + 240;
	// One section: RVA 0x1000 maps to file offset 0x400.
	view.setUint32(section + 8, 0x400, true);
	view.setUint32(section + 12, 0x1000, true);
	view.setUint32(section + 16, 0x400, true);
	view.setUint32(section + 20, 0x400, true);
	view.setUint32(opt + 112 + 8, 0x1000, true);
	let name = 0x1200;
	imports.forEach((dll, i) => {
		view.setUint32(0x400 + i * 20 + 12, name, true);
		for (let j = 0; j < dll.length; j++) {
			data[name - 0x1000 + 0x400 + j] = dll.charCodeAt(j);
		}
		name += dll.length + 1;
	});
	return data;
}

const ATTESTED: IMxcAttestation = {
	pid: 6120, ok: true, running: true, appContainer: true, inJob: true, sessionId: 2, parentPid: 6808, created: 1,
	appContainerSid: 'S-1-15-2-4120895937-2602915560-1489698829-601494007-2615867018-1289147103-1426181632',
	integrity: 'S-1-16-4096', image: `${CTL}\\volt-mxc-helper.exe`,
};
const READY_LINE = 'ready pid=6120 nonce=abc injob=1 ui=0x0 sentinel=5 public=10013 loopback=10013';

suite('Volt sandbox: MXC (Windows) translation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('Windows build floor (PROBE-WIN)', () => {
		test('parses ver output and dotted versions', () => {
			assert.deepStrictEqual(parseWindowsVersion('Microsoft Windows [Version 10.0.26200.9725]'), { major: 10, minor: 0, build: 26200, ubr: 9725 });
			assert.deepStrictEqual(parseWindowsVersion('10.0.26100.9278'), { major: 10, minor: 0, build: 26100, ubr: 9278 });
			assert.strictEqual(parseWindowsVersion('Windows 11'), undefined);
		});

		test('accepts each release at its floor and refuses one update below', () => {
			for (const [build, ubr, release] of [[26100, 9278, '24H2'], [26200, 9278, '25H2'], [26300, 9550, '26H2'], [28000, 2804, '26H1']] as const) {
				const ok = checkWindowsFloor({ major: 10, minor: 0, build, ubr }, 'Client');
				assert.deepStrictEqual(ok, { ok: true, release });
				const below = checkWindowsFloor({ major: 10, minor: 0, build, ubr: ubr - 1 }, 'Client');
				assert.strictEqual(below.ok, false);
				assert.match(!below.ok ? below.reason : '', /update/);
			}
		});

		test('the hosted windows-11-arm image (26200.9725) is above the floor', () => {
			assert.strictEqual(checkWindowsFloor(parseWindowsVersion('10.0.26200.9725'), 'Client').ok, true);
		});

		test('refuses Windows 10, Windows 11 before 24H2 and Windows Server', () => {
			assert.match(reason(checkWindowsFloor({ major: 10, minor: 0, build: 19045, ubr: 5000 }, 'Client')), /Windows 10/);
			assert.match(reason(checkWindowsFloor({ major: 10, minor: 0, build: 22631, ubr: 5000 }, 'Client')), /older than 24H2/);
			assert.match(reason(checkWindowsFloor({ major: 10, minor: 0, build: 26100, ubr: 9999 }, 'Server')), /Server/);
			assert.match(reason(checkWindowsFloor({ major: 10, minor: 0, build: 26100, ubr: 9999 }, 'Server Core')), /Server/);
			assert.match(reason(checkWindowsFloor(undefined, 'Client')), /version/);
		});

		test('an unlisted newer build passes the floor but leaves the decision to the trial', () => {
			const result = checkWindowsFloor({ major: 10, minor: 0, build: 26691, ubr: 1002 }, 'Client');
			assert.strictEqual(result.ok, true);
			assert.match(result.ok ? result.note ?? '' : '', /trial/);
		});

		function reason(support: ReturnType<typeof checkWindowsFloor>): string {
			assert.strictEqual(support.ok, false);
			return support.ok ? '' : support.reason;
		}
	});

	suite('probe output', () => {
		test('needs the BaseContainer tier with deny paths; AppContainer fallbacks are refused', () => {
			assert.deepStrictEqual(checkMxcProbe({ tier: 'base-container', probes: { baseContainerApiPresent: true, baseContainerSupportsDenyPaths: true, baseContainerSupportsEnumeratePaths: true } }), { ok: true, enumerate: true });
			assert.strictEqual(checkMxcProbe({ tier: 'appcontainer-dacl', probes: { baseContainerApiPresent: false } }).ok, false);
			assert.strictEqual(checkMxcProbe({ tier: 'base-container', probes: { baseContainerApiPresent: true, baseContainerSupportsDenyPaths: false } }).ok, false);
			assert.strictEqual(checkMxcProbe(undefined).ok, false);
		});
	});

	suite('image classifier (WIN-MSYS-1, WIN-ESC-1)', () => {
		test('refuses MSYS2 images by import and by location, including Git\'s launchers', () => {
			assert.deepStrictEqual(classifyWindowsImage('C:\\tools\\x\\bash.exe', readPeInfo(fakePe(['msys-2.0.dll', 'kernel32.dll']))), { kind: 'msys', reason: GIT_BASH_REFUSAL });
			for (const path of ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\Program Files\\Git\\git-bash.exe', 'C:\\msys64\\usr\\bin\\ls.exe']) {
				assert.strictEqual(classifyWindowsImage(path, undefined).reason, GIT_BASH_REFUSAL, path);
			}
		});

		test('refuses Cygwin images', () => {
			const result = classifyWindowsImage('C:\\cygwin64\\bin\\bash.exe', readPeInfo(fakePe(['cygwin1.dll'])));
			assert.deepStrictEqual(result, { kind: 'cygwin', reason: GIT_BASH_REFUSAL });
		});

		test('refuses WSL launchers, including System32 bash.exe', () => {
			for (const path of ['C:\\Windows\\System32\\wsl.exe', 'C:\\Windows\\system32\\bash.exe', 'c:/windows/system32/WSL.EXE', 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\ubuntu.exe']) {
				assert.deepStrictEqual(classifyWindowsImage(path, undefined), { kind: 'wsl', reason: WSL_REFUSAL }, path);
			}
		});

		test('native programs, including Git\'s own git.exe, run', () => {
			assert.deepStrictEqual(classifyWindowsImage('C:\\Program Files\\Git\\cmd\\git.exe', readPeInfo(fakePe(['kernel32.dll', 'zlib1.dll']))), { kind: 'native' });
			assert.deepStrictEqual(classifyWindowsImage('C:\\Program Files\\nodejs\\node.exe', readPeInfo(fakePe(['kernel32.dll']))), { kind: 'native' });
		});

		test('an approved runtime copy is classified but not refused', () => {
			assert.deepStrictEqual(classifyWindowsImage('C:\\Users\\dev\\.volt\\runtimes\\msys\\usr\\bin\\bash.exe', readPeInfo(fakePe(['msys-2.0.dll'])), true), { kind: 'msys' });
		});

		test('reads PE headers, delay imports and the ASLR flag; rejects non-PE data', () => {
			const info = readPeInfo(fakePe(['MSYS-2.0.DLL', 'KERNEL32.dll'], 0, 0x8664));
			assert.deepStrictEqual(info, { machine: 0x8664, dllCharacteristics: 0, imports: ['msys-2.0.dll', 'kernel32.dll'] });
			assert.strictEqual(readPeInfo(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])), undefined);
			assert.strictEqual(readPeInfo(new Uint8Array(0)), undefined);
		});
	});

	suite('Windows paths', () => {
		test('normalizes, compares case-insensitively and lists ancestors', () => {
			assert.strictEqual(normalizeWindowsPath('c:/Users//dev/'), 'C:\\Users\\dev');
			assert.strictEqual(normalizeWindowsPath('C:'), 'C:\\');
			assert.ok(isWindowsPathInside('c:\\users\\DEV\\x', 'C:\\Users\\dev'));
			assert.ok(!isWindowsPathInside('C:\\Users\\devil', 'C:\\Users\\dev'));
			assert.ok(isWindowsPathInside('C:\\a', 'C:\\'));
			assert.deepStrictEqual(windowsAncestors('C:\\a\\b\\c'), ['C:\\', 'C:\\a', 'C:\\a\\b']);
			for (const root of ['C:\\', 'd:', '\\\\server\\share', '\\\\?\\C:\\']) {
				assert.ok(isWindowsVolumeRoot(root), root);
			}
			assert.ok(!isWindowsVolumeRoot('C:\\Windows'));
		});
	});

	suite('command lines', () => {
		test('quotes like CommandLineToArgvW expects', () => {
			assert.strictEqual(quoteWindowsArgument('plain'), 'plain');
			assert.strictEqual(quoteWindowsArgument('two words'), '"two words"');
			assert.strictEqual(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
			assert.strictEqual(quoteWindowsArgument('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
			assert.strictEqual(quoteWindowsArgument(''), '""');
		});

		test('batch files go through cmd.exe and refuse metacharacters', () => {
			assert.strictEqual(windowsCommandLine('C:\\tools\\npx.cmd', ['-y', 'pkg'], 'C:\\Windows\\System32\\cmd.exe'), 'C:\\Windows\\System32\\cmd.exe /d /s /c "C:\\tools\\npx.cmd -y pkg"');
			for (const bad of ['a&calc', 'x|y', '%PATH%', '!x!', 'a"b', 'a^b']) {
				assert.throws(() => windowsCommandLine('C:\\tools\\run.bat', [bad], 'cmd.exe'), MxcPolicyError, bad);
			}
			assert.throws(() => windowsCommandLine('C:\\node.exe', ['a\nb'], 'cmd.exe'), MxcPolicyError);
		});
	});

	suite('request (J.3)', () => {
		test('pins version 1.0.0, BaseContainer, telemetry off and the UI lockdown that keeps Node working', () => {
			const request = buildMxcRequest(input(policy()));
			assert.strictEqual(request.version, MXC_CONFIG_VERSION);
			assert.strictEqual(request.containment, 'processcontainer');
			assert.deepStrictEqual(request.telemetry, { enabled: false });
			assert.deepStrictEqual(request.ui, { disable: false, clipboard: 'none', injection: false });
			assert.deepStrictEqual(request.processContainer.ui, { isolation: 'container', desktopSystemControl: false, systemSettings: 'none', ime: false });
			assert.deepStrictEqual(request.lifecycle, { destroyOnExit: true });
			assert.strictEqual(request.process.inheritDefaultEnv, false);
			assert.strictEqual(request.process.commandLine, `"${CTL}\\volt-mxc-helper.exe" prologue "${CTL}\\prologue.txt"`.replace(/"([^" ]+)"/g, '$1'));
		});

		test('narrow reads: listed folders and the control folder, never a volume root or the profile', () => {
			const request = buildMxcRequest(input(policy()));
			assert.deepStrictEqual([...request.filesystem.readwritePaths], [WS, TMP]);
			assert.ok(request.filesystem.readonlyPaths.includes('C:\\Windows'));
			assert.ok(request.filesystem.readonlyPaths.includes(CTL));
			for (const path of [...request.filesystem.readonlyPaths, ...request.filesystem.readwritePaths]) {
				assert.ok(!isWindowsVolumeRoot(path) && path.toLowerCase() !== HOME.toLowerCase(), path);
			}
			for (const bad of [{ read: ['C:\\'] }, { read: [HOME] }, { read: ['C:\\Users'] }, { write: ['D:\\'] }, { write: ['C:\\Users\\dev'] }, { writeFiles: ['\\\\server\\share'] }]) {
				assert.throws(() => buildMxcRequest(input(policy(bad))), MxcPolicyError, JSON.stringify(bad));
			}
		});

		test('reads of everything are refused, not widened', () => {
			assert.throws(() => buildMxcRequest(input(policy({ readAll: true }))), (err: MxcPolicyError) => err.dimension === 'filesystem.read');
		});

		test('credential denies and pattern matches become deniedPaths', () => {
			const request = buildMxcRequest(input(policy(), { patternDeny: [`${WS}\\.env`, `${WS}\\sub\\.env`] }));
			assert.deepStrictEqual([...request.filesystem.deniedPaths], [`${HOME}\\.ssh`, `${HOME}\\AppData\\Roaming\\Microsoft\\Credentials`, `${WS}\\.env`, `${WS}\\sub\\.env`]);
		});

		test('existing protected paths inside writable roots become read-only grants (a child grant wins over its parent)', () => {
			const request = buildMxcRequest(input(policy(), { patternProtect: [`${WS}\\sub\\.git\\config`] }));
			assert.ok(request.filesystem.readonlyPaths.includes(`${WS}\\.git\\config`));
			assert.ok(request.filesystem.readonlyPaths.includes(`${WS}\\.git\\hooks`));
			assert.ok(request.filesystem.readonlyPaths.includes(`${WS}\\sub\\.git\\config`));
			// Not existing at launch: not granted (protectNew is partial on Windows).
			assert.ok(!request.filesystem.readonlyPaths.includes(`${WS}\\.vscode`));
		});

		test('ancestors of every grant may be listed (tools walk upward), never the grants or denied folders themselves', () => {
			const request = buildMxcRequest(input(policy()));
			const enumerate = request.processContainer.filesystem?.enumeratePaths ?? [];
			for (const expected of ['C:\\', 'D:\\', 'D:\\code', 'C:\\Users', HOME]) {
				assert.ok(enumerate.includes(expected), expected);
			}
			for (const grant of [WS, TMP, 'C:\\Windows']) {
				assert.ok(!enumerate.includes(grant), grant);
			}
		});

		test('network none is Model 3: everything denied, host loopback closed', () => {
			const request = buildMxcRequest(input(policy()));
			assert.deepStrictEqual(request.network, { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } });
			assert.strictEqual(request.runtimeConfig, undefined);
		});

		test('network proxy is Model 2: only Volt\'s proxy, through runtimeConfig.networkProxy', () => {
			const request = buildMxcRequest(input(policy({ network: { mode: 'proxy', allow: ['example.com'], loopbackPorts: [], listen: false } }), { proxyPort: 51234 }));
			assert.deepStrictEqual(request.network, { egress: { default: 'deny' }, ingress: { default: 'allow', hostLoopback: 'allow' } });
			assert.deepStrictEqual(request.runtimeConfig, { networkProxy: 'http://127.0.0.1:51234' });
			assert.throws(() => buildMxcRequest(input(policy({ network: { mode: 'proxy', allow: [], loopbackPorts: [], listen: false } }))), MxcPolicyError);
		});

		test('plain host loopback is never used to reach single ports (MXC#1665)', () => {
			assert.throws(() => buildMxcRequest(input(policy({ network: { mode: 'none', allow: [], loopbackPorts: [3080], listen: false } }))), (err: MxcPolicyError) => err.dimension === 'network.loopbackPorts');
			assert.throws(() => buildMxcRequest(input(policy({ network: { mode: 'proxy', allow: [], loopbackPorts: [3080], listen: false } }), { proxyPort: 1 })), (err: MxcPolicyError) => err.dimension === 'network.loopbackPorts');
		});

		test('"no new processes" and unix sockets are refused (WIN-SPAWN-1)', () => {
			assert.throws(() => buildMxcRequest(input(policy({ limits: { processes: 1 } }))), (err: MxcPolicyError) => err.dimension === 'limits.processes');
			assert.throws(() => buildMxcRequest(input(policy({ unixSockets: ['C:\\x.sock'] }))), (err: MxcPolicyError) => err.dimension === 'host.unixSockets');
		});
	});

	suite('workload environment (WIN-TMP-1, WIN-DLL-1)', () => {
		test('temp folders are the run\'s own; MXC\'s required variables are present', () => {
			const env = workloadEnv(policy({ env: { TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp', path: 'C:\\x' } }), 'C:\\Windows', [WS, TMP]);
			assert.strictEqual(env.TEMP, TMP);
			assert.strictEqual(env.TMP, TMP);
			assert.strictEqual(env.SystemRoot, 'C:\\Windows');
			assert.ok(env.LOCALAPPDATA.startsWith(TMP));
			assert.strictEqual(env.NoDefaultCurrentDirectoryInExePath, '1');
			assert.strictEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1);
		});

		test('writable folders never precede system folders on PATH', () => {
			const env = workloadEnv(policy(), 'C:\\Windows', [WS, TMP]);
			const path = env.PATH.split(';');
			assert.deepStrictEqual(path.slice(0, 2), ['C:\\Windows\\System32', 'C:\\Windows']);
			assert.strictEqual(path[path.length - 1], `${WS}\\node_modules\\.bin`);
		});

		test('system folders lead PATH even when the host lists them later (WIN-DLL-1)', () => {
			const env = workloadEnv(policy({ env: { Path: 'C:\\Program Files\\PowerShell\\7;c:\\windows\\system32;C:\\Program Files\\nodejs;C:\\Windows' } }), 'C:\\Windows', [WS, TMP]);
			assert.deepStrictEqual(env.PATH.split(';'), ['C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0', 'C:\\Program Files\\PowerShell\\7', 'C:\\Program Files\\nodejs']);
		});

		test('names Windows cannot carry are refused', () => {
			assert.throws(() => workloadEnv(policy({ env: { 'A=B': 'x' } }), 'C:\\Windows', []), MxcPolicyError);
			assert.throws(() => workloadEnv(policy({ env: { A: 'x\u0000y' } }), 'C:\\Windows', []), MxcPolicyError);
		});
	});

	suite('prologue control and status', () => {
		test('control file carries the nonce, files, canary and limits, command last', () => {
			const text = mxcControlText({ nonce: 'n1', statusFile: 'C:\\t\\s', goFile: 'C:\\c\\go', sentinel: 'C:\\r\\sentinel', network: 'none', canaryPort: 9, limits: { cpuSeconds: 5, memoryMB: 64 }, commandLine: 'node.exe -e 1' });
			assert.strictEqual(text, 'nonce=n1\nstatus=C:\\t\\s\ngo=C:\\c\\go\nsentinel=C:\\r\\sentinel\nnet=none\ncanaryPort=9\ncpuSeconds=5\nmemoryMB=64\nprocesses=0\ncmd=node.exe -e 1\n');
			assert.throws(() => mxcControlText({ nonce: 'n', statusFile: 's', goFile: 'g', sentinel: 'x', network: 'none', limits: {}, commandLine: 'a\nb' }), MxcPolicyError);
			// WIN-TMP-1: MXC swaps TEMP/TMP for a folder it never creates; the prologue restores the run's.
			assert.match(mxcControlText({ nonce: 'n', statusFile: 's', goFile: 'g', sentinel: 'x', network: 'none', limits: {}, temp: 'C:\\run\\tmp', commandLine: 'a' }), /\ntemp=C:\\run\\tmp\ncmd=a\n$/);
			assert.throws(() => mxcControlText({ nonce: 'n', statusFile: 's', goFile: 'g', sentinel: 'x', network: 'none', limits: {}, temp: 'C:\\a\nb', commandLine: 'a' }), MxcPolicyError);
		});

		test('parses ready, started, limit and exit lines', () => {
			const status = parseMxcStatus(`${READY_LINE}\nstarted pid=5188\nlimit memory 300\nexit 137\n`);
			assert.deepStrictEqual(status.ready, { pid: 6120, nonce: 'abc', inJob: true, ui: 0, sentinel: 5, publicConnect: 10013, loopbackConnect: 10013 });
			assert.strictEqual(status.started, 5188);
			assert.deepStrictEqual(status.limit, { resource: 'memory', value: 300 });
			assert.strictEqual(status.exit, 137);
			assert.strictEqual(parseMxcStatus('nogo\n').nogo, true);
		});

		test('attestation JSON is the last line of the helper\'s output', () => {
			assert.deepStrictEqual(parseMxcAttestation(`noise\n${JSON.stringify(ATTESTED)}\n`), ATTESTED);
			assert.strictEqual(parseMxcAttestation('not json'), undefined);
		});
	});

	suite('external evidence (ATTEST-WIN-1)', () => {
		const expected = { nonce: 'abc', helperPath: `${CTL}\\volt-mxc-helper.exe`, launcherPid: 6808, network: 'none' as const, canaryPort: 9 };
		const ready = parseMxcStatus(READY_LINE);

		test('accepts an attested AppContainer process at Low integrity in a job, started by this run', () => {
			const check = checkMxcEvidence(ready, ATTESTED, expected);
			assert.strictEqual(check.ok, true, check.error);
			assert.strictEqual(check.evidence.appContainerSid, ATTESTED.appContainerSid);
		});

		test('rejects a prologue that ran outside the sandbox (forged ready line)', () => {
			// Measured on windows-11-arm: the helper run unsandboxed attests like this.
			const outside: IMxcAttestation = { ...ATTESTED, appContainer: false, appContainerSid: '', integrity: 'S-1-16-12288', parentPid: 2900 };
			assert.match(checkMxcEvidence(ready, outside, expected).error ?? '', /not in an AppContainer/);
		});

		test('rejects every missing or wrong piece of evidence', () => {
			const cases: [Partial<IMxcAttestation>, RegExp][] = [
				[{ ok: false, error: 'OpenProcess failed: 87' }, /could not be inspected/],
				[{ running: false }, /exited/],
				[{ integrity: 'S-1-16-8192' }, /integrity/],
				[{ inJob: false }, /job/],
				[{ image: 'C:\\evil\\volt-mxc-helper.exe' }, /unexpected program/],
				[{ parentPid: 1 }, /launcher/],
				[{ pid: 1 }, /could not be inspected/],
			];
			for (const [change, error] of cases) {
				assert.match(checkMxcEvidence(ready, { ...ATTESTED, ...change }, expected).error ?? '', error, JSON.stringify(change));
			}
			assert.match(checkMxcEvidence(ready, undefined, expected).error ?? '', /inspected/);
			assert.match(checkMxcEvidence(parseMxcStatus(''), ATTESTED, expected).error ?? '', /ready/);
			assert.match(checkMxcEvidence(parseMxcStatus(READY_LINE.replace('nonce=abc', 'nonce=old')), ATTESTED, expected).error ?? '', /ready/);
		});

		test('rejects a canary that did not fail the expected way', () => {
			for (const [line, error] of [
				[READY_LINE.replace('sentinel=5', 'sentinel=0'), /readable/],
				[READY_LINE.replace('public=10013', 'public=0'), /allowed/],
				[READY_LINE.replace('public=10013', 'public=10060'), /not refused at once/],
				[READY_LINE.replace('loopback=10013', 'loopback=0'), /loopback/],
			] as const) {
				assert.match(checkMxcEvidence(parseMxcStatus(line), ATTESTED, expected).error ?? '', error, line);
			}
			// With host network the network canary is not expected to fail.
			assert.strictEqual(checkMxcEvidence(parseMxcStatus(READY_LINE.replace('public=10013', 'public=-1')), ATTESTED, { ...expected, network: 'host' }).ok, true);
		});
	});

	suite('optional dimensions', () => {
		test('a backend may declare only spec-sanctioned dimensions optional', () => {
			const enforcement = allEnforcement('enforced');
			enforcement['limits.cpu'] = 'partial';
			enforcement['limits.fileSize'] = 'unsupported';
			enforcement['network.loopbackPorts'] = 'unsupported';
			const capabilities: ISandboxBackendCapabilities = {
				backend: 'mxc', available: true, enforcement, notes: {}, details: [], diagnostics: [],
				optional: ['limits.cpu', 'limits.fileSize', 'network.loopbackPorts'],
			};
			const workspace = builtinProfile('workspace');
			const check = checkEnforcement(workspace, capabilities);
			assert.deepStrictEqual(check.unenforced, ['limits.cpu', 'limits.fileSize']);
			assert.deepStrictEqual(check.blocking, []);
			// loopbackPorts is not optional even when the backend says so.
			const withPorts = { ...workspace, network: { ...workspace.network, loopbackPorts: [3080] } };
			assert.deepStrictEqual(checkEnforcement(withPorts, capabilities).blocking, ['network.loopbackPorts']);
		});
	});
});
