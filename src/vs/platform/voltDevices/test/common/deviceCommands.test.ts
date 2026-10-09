/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { androidKeycode, androidLaunchArgv, fitWithin, gzipFrom, jpegSize, parseRawFrame, emulatorFailure, androidSdkCandidates, androidTextChunks, avdLabel, imagePointToInput, iosButtonName, iosInputCommand, isAlreadyBooted, isXcodeLicenseError, looksFoldable, parseAdbDevices, parseAvdList, parseCurrentDeviceState, parseDeviceStates, parseEmuAvdName, parseSimctlDevices, parseSimctlScreen, parseSshTarget, pngFrom, pngSize, postureOfState, remoteScript, scpCommand, shellJoin, shellQuote, simRuntimeLabel, sshCommand, stateForPosture } from '../../common/deviceCommands.js';

const SIMCTL_JSON = JSON.stringify({
	devices: {
		'com.apple.CoreSimulator.SimRuntime.tvOS-18-5': [{ udid: 'TV', name: 'Apple TV', state: 'Shutdown', isAvailable: true }],
		'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
			{ udid: 'A', name: 'iPhone 16', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
			{ udid: 'B', name: 'iPad Air 11-inch (M3)', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3' },
			{ udid: 'C', name: 'iPhone Gone', state: 'Shutdown', isAvailable: false },
		],
		'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'D', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true }],
	},
});

const ENUMERATE = [
	'Port:',
	'    UUID: 34A8D7F2',
	'    Class: Display',
	'    Default width: 1179',
	'Port:',
	'    UUID: 5DF79380',
	'    Class: DisplayAdapter',
	'    Creatable Screen Properties:',
	'    (101) CarPlay:',
	'        Screen ID: 101',
	'        Pixel Size: {720, 480}',
	'        Preferred UI Scale: 1',
	'    Connected Screens:',
	'    (2) TVOut:',
	'        Screen ID: 2',
	'        Screen Type: External',
	'        Pixel Size: {720, 480}',
	'        Preferred UI Scale: 1',
	'    (1) LCD:',
	'        Screen ID: 1',
	'        Name: LCD',
	'        Unique ID: PurpleMain',
	'        Screen Type: Integrated',
	'        Pixel Size: {1179, 2556}',
	'        Preferred UI Scale: 3',
	'        Pixel Format: \'BGRA\'',
].join('\n') + '\n';

const PRINT_STATES = [
	'Supported states: [',
	'  DeviceState{identifier=0, name=\'CLOSED\', app_accessible=true, cancel_when_requester_not_on_top=false},',
	'  DeviceState{identifier=1, name=\'HALF_OPENED\', app_accessible=true, cancel_when_requester_not_on_top=false},',
	'  DeviceState{identifier=2, name=\'OPENED\', app_accessible=true, cancel_when_requester_not_on_top=false},',
	'  DeviceState{identifier=3, name=\'REAR_DISPLAY_STATE\', app_accessible=false, cancel_when_requester_not_on_top=true},',
	'  DeviceState{identifier=4, name=\'CONCURRENT_INNER_DEFAULT\', app_accessible=true, cancel_when_requester_not_on_top=true},',
	']',
].join('\n') + '\n';

suite('Volt devices: commands and parsers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shell quoting survives quotes, spaces and shell syntax', () => {
		assert.strictEqual(shellQuote('emulator-5554'), 'emulator-5554');
		assert.strictEqual(shellQuote('/tmp/a b'), `'/tmp/a b'`);
		assert.strictEqual(shellQuote(`it's; rm -rf ~`), `'it'\\''s; rm -rf ~'`);
		assert.strictEqual(shellQuote(''), `''`);
		assert.strictEqual(shellJoin(['xcrun', 'simctl', 'launch', 'UDID', 'com.example.$App']), `xcrun simctl launch UDID 'com.example.$App'`);
	});

	test('ssh targets parse from user@host:port forms and reject junk', () => {
		assert.deepStrictEqual(parseSshTarget('mac-mini.local'), { host: 'mac-mini.local', user: undefined, port: undefined });
		assert.deepStrictEqual(parseSshTarget('me@10.0.0.4:2222'), { host: '10.0.0.4', user: 'me', port: 2222 });
		assert.deepStrictEqual(parseSshTarget('ci@[::1]:22'), { host: '::1', user: 'ci', port: 22 });
		assert.strictEqual(parseSshTarget('host; rm -rf /'), undefined);
		assert.strictEqual(parseSshTarget('-oProxyCommand=evil'), undefined);
		assert.strictEqual(parseSshTarget('host:99999'), undefined);
	});

	test('ssh commands never prompt and run one quoted script through sh', () => {
		const command = sshCommand({ host: 'mini', user: 'me', port: 2200, identityFile: '/k/id' }, remoteScript(shellJoin(['adb', 'devices', '-l'])));
		assert.strictEqual(command.file, 'ssh');
		const args = command.args;
		assert.ok(args.includes('BatchMode=yes'));
		assert.deepStrictEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', '/k/id']);
		assert.deepStrictEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), ['-p', '2200']);
		assert.strictEqual(args.at(-3), 'me@mini');
		assert.strictEqual(args.at(-2), '--');
		const remote = args.at(-1)!;
		assert.ok(remote.startsWith(`sh -c 'PATH=`));
		assert.ok(remote.includes('Android/sdk/platform-tools'));
		assert.ok(remote.endsWith(`export PATH; adb devices -l'`));
	});

	test('scp copies folders recursively and quotes the remote path for the remote shell', () => {
		const command = scpCommand({ host: 'mini', port: 2200 }, '/build/My App.app', '/tmp/volt-install-1/My App.app');
		assert.strictEqual(command.file, 'scp');
		assert.ok(command.args.includes('-r'));
		assert.deepStrictEqual(command.args.slice(command.args.indexOf('-P'), command.args.indexOf('-P') + 2), ['-P', '2200']);
		assert.strictEqual(command.args.at(-2), '/build/My App.app');
		assert.strictEqual(command.args.at(-1), `mini:'/tmp/volt-install-1/My App.app'`);
	});

	test('simctl lists phones and tablets, booted first, newest runtime next', () => {
		const devices = parseSimctlDevices(SIMCTL_JSON, 'local');
		assert.deepStrictEqual(devices.map(device => device.id), ['B', 'D', 'A']);
		assert.deepStrictEqual(devices[0], { hostId: 'local', platform: 'ios', id: 'B', name: 'iPad Air 11-inch (M3)', kind: 'simulator', state: 'booted', runtime: 'iOS 18.5', model: 'iPad-Air-11-inch-M3' });
		assert.strictEqual(devices[1].runtime, 'iOS 26.0');
		assert.deepStrictEqual(parseSimctlDevices('not json', 'local'), []);
		assert.strictEqual(simRuntimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-17-0'), 'iOS 17.0');
	});

	test('simctl enumerate gives the main screen size and scale, not CarPlay or TV out', () => {
		assert.deepStrictEqual(parseSimctlScreen(ENUMERATE), { width: 1179, height: 2556, scale: 3 });
		assert.strictEqual(parseSimctlScreen('nothing here'), undefined);
		assert.ok(isAlreadyBooted('An error was encountered processing the command (domain=com.apple.CoreSimulatorService.ErrorDomain, code=405):\nUnable to boot device in current state: Booted'));
	});

	test('adb devices -l: states, models and emulators', () => {
		const devices = parseAdbDevices([
			'* daemon not running; starting now at tcp:5037',
			'List of devices attached',
			'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
			'R58M12ABCDE            unauthorized usb:1-1 transport_id:2',
			'192.168.1.20:5555      offline',
			'',
		].join('\n'));
		assert.deepStrictEqual(devices.map(device => [device.serial, device.state, device.emulator]), [
			['emulator-5554', 'booted', true],
			['R58M12ABCDE', 'unauthorized', false],
			['192.168.1.20:5555', 'offline', false],
		]);
		assert.strictEqual(devices[0].model, 'sdk gphone64 arm64');
	});

	test('AVD names from the emulator, its console, and labels', () => {
		assert.deepStrictEqual(parseAvdList('INFO    | Storing crashdata in: /tmp/x\nMedium_Phone_API_36.0\nPixel_9_Pro\nPixel_9_Pro_Fold\n'), ['Medium_Phone_API_36.0', 'Pixel_9_Pro', 'Pixel_9_Pro_Fold']);
		assert.strictEqual(parseEmuAvdName('Pixel_9_Pro_Fold\r\nOK\r\n'), 'Pixel_9_Pro_Fold');
		assert.strictEqual(parseEmuAvdName('OK\r\n'), undefined);
		assert.strictEqual(avdLabel('Pixel_9_Pro_Fold'), 'Pixel 9 Pro Fold');
		assert.ok(looksFoldable('Pixel_9_Pro_Fold'));
		assert.ok(looksFoldable('Galaxy Z Flip'));
		assert.ok(!looksFoldable('Pixel_9_Pro'));
	});

	test('foldable postures map from device_state, whatever the OEM calls them', () => {
		const states = parseDeviceStates(PRINT_STATES);
		assert.strictEqual(states.length, 5);
		assert.strictEqual(stateForPosture(states, 'folded'), 0);
		assert.strictEqual(stateForPosture(states, 'halfOpen'), 1);
		assert.strictEqual(stateForPosture(states, 'open'), 2);
		assert.strictEqual(stateForPosture([{ id: 7, name: 'UNFOLDED' }], 'halfOpen'), undefined);
		assert.strictEqual(postureOfState('HALF_FOLDED'), 'halfOpen');
		assert.strictEqual(postureOfState('FOLDED'), 'folded');
		assert.strictEqual(postureOfState('REAR_DISPLAY_STATE'), undefined);
		assert.deepStrictEqual(parseCurrentDeviceState(`Committed state: DeviceState{identifier=1, name='HALF_OPENED', app_accessible=true}\nPending state: (none)`), { id: 1, name: 'HALF_OPENED' });
	});

	test('Android text: spaces as %s, literal %s split, newlines press Enter, ASCII only', () => {
		assert.deepStrictEqual(androidTextChunks('hello world'), ['hello%sworld']);
		assert.deepStrictEqual(androidTextChunks('a\nb c'), ['a', null, 'b%sc']);
		assert.deepStrictEqual(androidTextChunks('50% off'), ['50%%soff']);
		assert.deepStrictEqual(androidTextChunks('x%sy'), ['x%', 'sy']);
		assert.deepStrictEqual(androidTextChunks(`it's "ok" & done`), [`it's%s"ok"%s&%sdone`]);
		assert.throws(() => androidTextChunks('héllo'), /plain ASCII/);
	});

	test('emulator logs: a broken Quick Boot snapshot, a fatal line, or nothing', () => {
		assert.strictEqual(emulatorFailure(`INFO | boot\nqemu-system-aarch64: error while loading state for instance 0x0 of device 'goldfish_pipe'\nWARNING | Error -5 while loading VM state\nWARNING | Failed to load snapshot 'default_boot'`), 'snapshot');
		assert.strictEqual(emulatorFailure('INFO | x\nPANIC: Missing emulator engine program for \'x86\' CPU.\n'), 'PANIC: Missing emulator engine program for \'x86\' CPU.');
		assert.strictEqual(emulatorFailure('INFO | ok\nFATAL | Running multiple emulators with the same AVD is an experimental feature.'), 'Running multiple emulators with the same AVD is an experimental feature.');
		assert.strictEqual(emulatorFailure('INFO | all good'), undefined);
		// A restored snapshot with broken graphics boots to white frames and floods the log with GL errors.
		const glErrors = Array.from({ length: 6 }, () => '/Volumes/x/gfxstream/host/gl/GLESv2Imp.cpp:glUniformMatrix3fv:4047 error 0x502').join('\n');
		assert.strictEqual(emulatorFailure(`INFO | ok\n${glErrors}`), 'snapshot');
		assert.strictEqual(emulatorFailure('INFO | ok\n/Volumes/x/gfxstream/host/gl/GLESv2Imp.cpp:glUniformMatrix3fv:4047 error 0x502'), undefined);
	});

	test('Android keys and launch commands', () => {
		assert.strictEqual(androidKeycode('back'), 'KEYCODE_BACK');
		assert.strictEqual(androidKeycode('appSwitch'), 'KEYCODE_APP_SWITCH');
		assert.deepStrictEqual(androidLaunchArgv('com.example.app'), ['monkey', '-p', 'com.example.app', '-c', 'android.intent.category.LAUNCHER', '1']);
		assert.deepStrictEqual(androidLaunchArgv('com.example.app/.MainActivity'), ['am', 'start', '-n', 'com.example.app/.MainActivity']);
		assert.deepStrictEqual(androidLaunchArgv('myapp://settings'), ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'myapp://settings']);
	});

	test('iOS input goes through AXe or idb with the right argument shapes', () => {
		assert.deepStrictEqual(iosInputCommand('axe', 'U', { kind: 'tap', x: 100.4, y: 200.6 }), { file: 'axe', args: ['tap', '-x', '100', '-y', '201', '--udid', 'U'] });
		assert.deepStrictEqual(iosInputCommand('idb', 'U', { kind: 'tap', x: 1, y: 2 }), { file: 'idb', args: ['ui', 'tap', '1', '2', '--udid', 'U'] });
		assert.deepStrictEqual(iosInputCommand('axe', 'U', { kind: 'swipe', x1: 0, y1: 500, x2: 0, y2: 100, durationMs: 400 }).args, ['swipe', '--start-x', '0', '--start-y', '500', '--end-x', '0', '--end-y', '100', '--duration', '0.4', '--udid', 'U']);
		assert.deepStrictEqual(iosInputCommand('idb', 'U', { kind: 'type', text: 'hi there' }).args, ['ui', 'text', 'hi there', '--udid', 'U']);
		assert.deepStrictEqual(iosInputCommand('axe', 'U', { kind: 'button', button: 'home' }).args, ['button', 'home', '--udid', 'U']);
		assert.deepStrictEqual(iosInputCommand('idb', 'U', { kind: 'button', button: 'lock' }).args, ['ui', 'button', 'LOCK', '--udid', 'U']);
		assert.deepStrictEqual(iosInputCommand('axe', 'U', { kind: 'button', button: 'enter' }).args, ['key', '40', '--udid', 'U']);
		assert.throws(() => iosButtonName('volumeUp', 'axe'), /no "volumeUp" button/);
	});

	test('Android SDK candidates per platform', () => {
		assert.deepStrictEqual(androidSdkCandidates('darwin', { ANDROID_HOME: '/sdk' }, '/Users/me'), ['/sdk', '/Users/me/Library/Android/sdk']);
		assert.deepStrictEqual(androidSdkCandidates('linux', {}, '/home/me'), ['/home/me/Android/Sdk', '/home/me/Android/sdk']);
		assert.deepStrictEqual(androidSdkCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me'), ['C:\\Users\\me\\AppData\\Local\\Android\\Sdk']);
	});

	test('PNG size and image-to-device coordinates', () => {
		const header = new Uint8Array(24);
		header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
		new DataView(header.buffer).setUint32(16, 1179);
		new DataView(header.buffer).setUint32(20, 2556);
		assert.deepStrictEqual(pngSize(header), { width: 1179, height: 2556 });
		assert.strictEqual(pngSize(new Uint8Array(30)), undefined);

		// screencap on a foldable prints a warning line before the image.
		const warning = new TextEncoder().encode('[Warning: Multiple displays were found, but no display id was specified]\n');
		const withWarning = new Uint8Array(warning.length + header.length);
		withWarning.set(warning);
		withWarning.set(header, warning.length);
		assert.deepStrictEqual(pngSize(pngFrom(withWarning)), { width: 1179, height: 2556 });
		assert.strictEqual(pngFrom(header), header);
		assert.strictEqual(pngSize(pngFrom(warning)), undefined);

		// An agent saw a 472×1024 copy of a 1179×2556 @3x iPhone screen: its (236, 512) is the center in points.
		assert.deepStrictEqual(imagePointToInput(236, 512, { width: 472, height: 1024 }, { width: 1179, height: 2556, scale: 3 }), { x: 197, y: 426 });
		// Android takes pixels; points outside the image clamp to the screen.
		assert.deepStrictEqual(imagePointToInput(600, -5, { width: 500, height: 1000 }, { width: 1080, height: 2160, scale: 1 }), { x: 1079, y: 0 });
	});

	test('an Xcode whose license is not accepted is recognised, so simctl can run directly', () => {
		assert.strictEqual(isXcodeLicenseError(`You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.`), true);
		assert.strictEqual(isXcodeLicenseError('Invalid device: nope'), false);
	});

	test('a raw capture is found after the multi-display warning and parsed with either header size', () => {
		const warning = Buffer.from('[Warning] Multiple displays were found\n');
		const gz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3]);
		assert.deepStrictEqual(Array.from(gzipFrom(Buffer.concat([warning, gz]))!), Array.from(gz));
		assert.deepStrictEqual(Array.from(gzipFrom(gz)!), Array.from(gz));
		assert.strictEqual(gzipFrom(Buffer.from('gzip: not found\n')), undefined);

		const raw = (headerWords: number[], width: number, height: number) => {
			const header = Buffer.alloc(headerWords.length * 4);
			headerWords.forEach((word, i) => header.writeUInt32LE(word, i * 4));
			return Buffer.concat([header, Buffer.alloc(width * height * 4, 7)]);
		};
		const withColorSpace = parseRawFrame(raw([2, 3, 1, 1], 2, 3))!;
		assert.deepStrictEqual([withColorSpace.width, withColorSpace.height, withColorSpace.rgba.length], [2, 3, 24]);
		assert.strictEqual(parseRawFrame(raw([2, 3, 1], 2, 3))!.rgba.length, 24);
		// Not a frame: a PNG, a wrong format, a truncated body.
		assert.strictEqual(parseRawFrame(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), undefined);
		assert.strictEqual(parseRawFrame(raw([2, 3, 9, 1], 2, 3)), undefined);
		assert.strictEqual(parseRawFrame(raw([2, 3, 1, 1], 2, 3).subarray(0, 30)), undefined);
	});

	test('frames shrink to fit, and JPEG sizes are read', () => {
		assert.deepStrictEqual(fitWithin(2076, 2152, 1024), { width: 988, height: 1024 });
		assert.deepStrictEqual(fitWithin(1000, 500, 1024), { width: 1000, height: 500 });
		assert.deepStrictEqual(fitWithin(1000, 500, 0), { width: 1000, height: 500 });
		// SOI, an APP0 segment, then SOF0 for 640x480.
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
		assert.deepStrictEqual(jpegSize(jpeg), { width: 640, height: 480 });
		assert.strictEqual(jpegSize(Buffer.from('not a jpeg')), undefined);
	});
});
