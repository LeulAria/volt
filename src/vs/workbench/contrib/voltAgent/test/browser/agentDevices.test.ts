/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltDevice } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { describeHostToolActivity } from '../../browser/blocks/agentHostToolActivity.js';
import { formatRecordingTime } from '../../browser/capture/recordingStatus.js';
import { frameForDevice } from '../../browser/devices/devicePreview.js';
import { keepUserFocus, shouldRestoreFocus } from '../../browser/preview/agentFocusGuard.js';
import { DEFAULT_ORBIT, describeDevice, findDevice, findHost, hingeAngle, orbitAfterDrag, parseRemoteHosts } from '../../common/agentDevices.js';
import { isVoltHostTool } from '../../../../services/voltRuntime/common/hostTools.js';

function device(overrides: Partial<IVoltDevice>): IVoltDevice {
	return { hostId: 'local', platform: 'ios', id: 'U1', name: 'iPhone 16', kind: 'simulator', state: 'shutdown', ...overrides };
}

suite('Volt devices: model, preview and focus', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('remote hosts from the setting: strings, objects, unique ids, junk dropped', () => {
		const hosts = parseRemoteHosts([
			'me@mac-mini.local:2222',
			{ name: 'Mac mini', host: 'build@10.0.0.9', identityFile: '~/.ssh/ci', androidSdk: '/opt/sdk' },
			{ name: 'Mac mini', host: 'other.local', user: 'ops', port: 22 },
			{ name: 'bad', host: 'x; rm -rf /' },
			{ name: 'no host' },
			42,
		]);
		assert.deepStrictEqual(hosts, [
			{ id: 'ssh:mac-mini-local', label: 'mac-mini.local', ssh: { host: 'mac-mini.local', user: 'me', port: 2222, identityFile: undefined }, androidSdk: undefined },
			{ id: 'ssh:mac-mini', label: 'Mac mini', ssh: { host: '10.0.0.9', user: 'build', port: undefined, identityFile: '~/.ssh/ci' }, androidSdk: '/opt/sdk' },
			{ id: 'ssh:mac-mini-2', label: 'Mac mini', ssh: { host: 'other.local', user: 'ops', port: 22, identityFile: undefined }, androidSdk: undefined },
		]);
		assert.deepStrictEqual(parseRemoteHosts(undefined), []);
		assert.strictEqual(findHost(hosts, 'mac mini')?.id, 'ssh:mac-mini');
		assert.strictEqual(findHost(hosts, '10.0.0.9')?.id, 'ssh:mac-mini');
		assert.strictEqual(findHost(hosts, 'nope'), undefined);
	});

	test('device lookup: id, then name, then part of a name; booted breaks ties', () => {
		const devices = [
			device({ id: 'A', name: 'iPhone 16', state: 'shutdown' }),
			device({ id: 'B', name: 'iPhone 16 Pro', state: 'booted' }),
			device({ id: 'Pixel_9_Pro_Fold', name: 'Pixel 9 Pro Fold', platform: 'android', kind: 'emulator', state: 'booted', serial: 'emulator-5554' }),
			device({ id: 'Pixel_9_Pro', name: 'Pixel 9 Pro', platform: 'android', kind: 'emulator' }),
		];
		assert.deepStrictEqual(findDevice(devices, 'A'), { kind: 'found', device: devices[0] });
		assert.deepStrictEqual(findDevice(devices, 'iphone 16'), { kind: 'found', device: devices[0] });
		assert.deepStrictEqual(findDevice(devices, 'emulator-5554'), { kind: 'found', device: devices[2] });
		assert.deepStrictEqual(findDevice(devices, 'pixel_9_pro_fold'), { kind: 'found', device: devices[2] });
		// "pixel" matches both Pixels; the booted one wins.
		assert.deepStrictEqual(findDevice(devices, 'pixel'), { kind: 'found', device: devices[2] });
		assert.strictEqual(findDevice(devices, 'galaxy').kind, 'none');
		// No query: the only booted device, else ambiguous.
		assert.strictEqual(findDevice([devices[0], devices[1]], undefined).kind, 'found');
		assert.strictEqual(findDevice(devices, undefined).kind, 'ambiguous');
		assert.strictEqual(findDevice([devices[0]], undefined).kind, 'none');
		assert.strictEqual(describeDevice(devices[2], 'This Computer'), '- Pixel 9 Pro Fold (id: Pixel_9_Pro_Fold) · Android emulator · booted · on This Computer');
	});

	test('3D orbit follows the drag and stays within limits; postures set the hinge', () => {
		assert.deepStrictEqual(orbitAfterDrag(DEFAULT_ORBIT, 0, 0, 900), DEFAULT_ORBIT);
		assert.deepStrictEqual(orbitAfterDrag({ yaw: 0, pitch: 0 }, 450, -100, 900), { yaw: 70, pitch: 20 });
		assert.deepStrictEqual(orbitAfterDrag({ yaw: 0, pitch: 0 }, -90, 0, 900), { yaw: -18, pitch: 0 });
		assert.deepStrictEqual(orbitAfterDrag({ yaw: 0, pitch: 0 }, 0, -10000, 900), { yaw: 0, pitch: 45 });
		assert.strictEqual(hingeAngle('open'), 0);
		assert.strictEqual(hingeAngle('halfOpen'), 90);
		assert.strictEqual(hingeAngle('folded'), 180);
	});

	test('simulators get the frame of their model', () => {
		assert.strictEqual(frameForDevice(device({ model: 'iPhone-16' }), 393, 852).shape, 'island');
		assert.strictEqual(frameForDevice(device({ model: 'iPhone-13' }), 390, 844).shape, 'notch');
		assert.strictEqual(frameForDevice(device({ model: 'iPhone-SE-3rd-generation' }), 375, 667).shape, 'home');
		assert.strictEqual(frameForDevice(device({ model: 'iPad-Air-11-inch-M3' }), 820, 1180).shape, 'tablet');
		assert.strictEqual(frameForDevice(device({ model: 'iPhone-17-Pro' }), 402, 874).shape, 'island');
		const fold = frameForDevice(device({ platform: 'android', name: 'Pixel 9 Pro Fold' }), 791, 820);
		assert.deepStrictEqual([fold.shape, fold.os, fold.radius], ['punch', 'android', 26]);
	});

	test('recording time reads like a clock', () => {
		assert.strictEqual(formatRecordingTime(0), '0:00');
		assert.strictEqual(formatRecordingTime(7_900), '0:07');
		assert.strictEqual(formatRecordingTime(750_000), '12:30');
		assert.strictEqual(formatRecordingTime(3_723_000), '1:02:03');
	});

	test('device and window tools are Volt host tools with readable activity rows', () => {
		assert.ok(isVoltHostTool('mcp__volt__device_tap'));
		assert.ok(isVoltHostTool('volt: window_capture'));
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__device_tap', undefined, JSON.stringify({ x: 120.4, y: 300, device: 'iPhone 16' })), { tool: 'device_tap', label: 'Tapped', detail: '120, 300 on iPhone 16' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__device_set_posture', undefined, JSON.stringify({ posture: 'halfOpen' })), { tool: 'device_set_posture', label: 'Changed posture to', detail: 'half open' });
		assert.deepStrictEqual(describeHostToolActivity('mcp__volt__window_record_start', undefined, JSON.stringify({ window: 'Simulator' })), { tool: 'window_record_start', label: 'Started recording', detail: 'Simulator' });
	});

	test('focus goes back to the composer only when agent input pulled it into the page', () => {
		const doc = document;
		const composer = doc.createElement('textarea');
		const webview = doc.createElement('webview');
		const other = doc.createElement('input');
		doc.body.append(composer, webview, other);
		try {
			assert.ok(shouldRestoreFocus(composer, webview, doc.body));
			assert.ok(shouldRestoreFocus(composer, doc.body, doc.body));
			assert.ok(shouldRestoreFocus(composer, null, doc.body));
			// The user moved on to another field on purpose, or had the page focused: leave it.
			assert.ok(!shouldRestoreFocus(composer, other, doc.body));
			assert.ok(!shouldRestoreFocus(webview, composer, doc.body));
			assert.ok(!shouldRestoreFocus(doc.body, webview, doc.body));
			assert.ok(!shouldRestoreFocus(composer, composer, doc.body));
		} finally {
			composer.remove();
			webview.remove();
			other.remove();
		}
	});

	test('keepUserFocus puts the caret back after the work steals it', async () => {
		const doc = document;
		const composer = doc.createElement('textarea');
		const page = doc.createElement('iframe');
		doc.body.append(composer, page);
		try {
			composer.focus();
			if (doc.activeElement !== composer) {
				return; // the test window has no focus (headless run): nothing to observe
			}
			const result = await keepUserFocus(doc, async () => {
				page.focus();
				await new Promise(resolve => setTimeout(resolve, 0));
				return 'done';
			});
			assert.strictEqual(result, 'done');
			assert.strictEqual(doc.activeElement, composer);
		} finally {
			composer.remove();
			page.remove();
		}
	});
});
