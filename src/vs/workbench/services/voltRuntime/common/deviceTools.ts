/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from './hostTools.js';

export const DEVICE_TOOL_NAMES = [
	'device_list',
	'device_boot',
	'device_shutdown',
	'device_screenshot',
	'device_tap',
	'device_swipe',
	'device_type',
	'device_press_button',
	'device_install_app',
	'device_launch_app',
	'device_set_posture',
] as const;

export const CAPTURE_TOOL_NAMES = ['window_list', 'window_capture', 'window_record_start', 'window_record_stop'] as const;

export type VoltDeviceToolName = typeof DEVICE_TOOL_NAMES[number];
export type VoltCaptureToolName = typeof CAPTURE_TOOL_NAMES[number];

const DEVICE = { type: 'string', description: 'Device name or id from device_list (e.g. "iPhone 16", "Pixel_9_Pro_Fold"). Default: the device this chat used last, or the only booted one.' };
const HOST = { type: 'string', description: 'Machine name from device_list, for simulators on another machine over SSH. Default: any.' };
const SCREENSHOT_AFTER = { type: 'boolean', description: 'Return a screenshot after the action (default true).' };
const COORD_NOTE = 'Coordinates are pixels in the latest device_screenshot image of this device.';

export const DEVICE_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: 'device_list',
		title: 'Listed devices',
		group: 'devices',
		description: 'List iOS simulators and Android emulators/devices on this machine and on the remote machines the user configured (volt.devices.remoteHosts), with their state (booted or shut down). Call it before the other device_* tools.',
		inputSchema: { type: 'object', properties: { host: HOST } },
	},
	{
		name: 'device_boot',
		title: 'Booted device',
		group: 'devices',
		approvalInReadOnlyModes: 'starts a simulator',
		description: 'Boot a simulator or emulator and wait (up to ~50s) until it is ready. Returns a screenshot. If it says still booting, call device_screenshot in a few seconds.',
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST }, required: ['device'] },
	},
	{
		name: 'device_shutdown',
		title: 'Shut down device',
		group: 'devices',
		approvalInReadOnlyModes: 'shuts down a simulator',
		description: 'Shut down a simulator or emulator.',
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST }, required: ['device'] },
	},
	{
		name: 'device_screenshot',
		title: 'Took device screenshot',
		group: 'devices',
		description: `Screenshot a booted simulator or emulator. ${COORD_NOTE} The text gives the image size and how coordinates map.`,
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST, max_side: { type: 'number', description: 'Longest side in pixels, 256-2048. Default 1024.' } } },
	},
	{
		name: 'device_tap',
		title: 'Tapped device',
		group: 'devices',
		approvalInReadOnlyModes: 'taps on the device',
		description: `Tap at x, y on the device screen. ${COORD_NOTE} iOS needs AXe or idb installed.`,
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST, x: { type: 'number' }, y: { type: 'number' }, screenshot: SCREENSHOT_AFTER }, required: ['x', 'y'] },
	},
	{
		name: 'device_swipe',
		title: 'Swiped device',
		group: 'devices',
		approvalInReadOnlyModes: 'swipes on the device',
		description: `Swipe from (x1, y1) to (x2, y2), e.g. to scroll (swipe up to scroll down). ${COORD_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: { device: DEVICE, host: HOST, x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration_ms: { type: 'number', description: 'Default 300.' }, screenshot: SCREENSHOT_AFTER },
			required: ['x1', 'y1', 'x2', 'y2'],
		},
	},
	{
		name: 'device_type',
		title: 'Typed on device',
		group: 'devices',
		approvalInReadOnlyModes: 'types on the device',
		description: 'Type text into the focused field on the device (tap the field first). Newlines press Enter. Android types plain ASCII only.',
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST, text: { type: 'string' }, screenshot: SCREENSHOT_AFTER }, required: ['text'] },
	},
	{
		name: 'device_press_button',
		title: 'Pressed device button',
		group: 'devices',
		approvalInReadOnlyModes: 'presses a device button',
		description: 'Press a hardware or system button. iOS: home, lock, siri, enter, delete. Android: home, back, appSwitch, lock, volumeUp, volumeDown, enter, delete.',
		inputSchema: {
			type: 'object',
			properties: { device: DEVICE, host: HOST, button: { type: 'string', enum: ['home', 'back', 'appSwitch', 'lock', 'volumeUp', 'volumeDown', 'siri', 'enter', 'delete'] }, screenshot: SCREENSHOT_AFTER },
			required: ['button'],
		},
	},
	{
		name: 'device_install_app',
		title: 'Installed app',
		group: 'devices',
		approvalInReadOnlyModes: 'installs an app',
		description: 'Install a build on the device: a simulator .app bundle (iOS) or an .apk (Android). Path on this machine, absolute or relative to the workspace; it is copied to remote machines.',
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST, path: { type: 'string' } }, required: ['path'] },
	},
	{
		name: 'device_launch_app',
		title: 'Launched app',
		group: 'devices',
		approvalInReadOnlyModes: 'launches an app',
		description: 'Launch an app by bundle id (iOS, e.g. com.example.App) or package name (Android, e.g. com.example.app, or com.example.app/.MainActivity), or open a URL / deep link on the device.',
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST, app: { type: 'string', description: 'Bundle id, package name, or URL.' }, screenshot: SCREENSHOT_AFTER }, required: ['app'] },
	},
	{
		name: 'device_set_posture',
		title: 'Changed posture',
		group: 'devices',
		approvalInReadOnlyModes: 'folds the device',
		description: 'Fold or unfold an Android foldable emulator: folded (cover screen), halfOpen (tabletop/book), or open (flat, inner screen). Use it to test foldable layouts.',
		inputSchema: { type: 'object', properties: { device: DEVICE, host: HOST, posture: { type: 'string', enum: ['folded', 'halfOpen', 'open'] }, screenshot: SCREENSHOT_AFTER }, required: ['posture'] },
	},
];

export const CAPTURE_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: 'window_list',
		title: 'Listed windows',
		group: 'capture',
		description: 'List the windows and screens that can be captured (macOS, Windows and Linux), with ids for window_capture and window_record_start.',
		inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Only windows whose title contains this text.' } } },
	},
	{
		name: 'window_capture',
		title: 'Captured window',
		group: 'capture',
		approvalInReadOnlyModes: 'captures a window on the user\'s screen',
		description: 'Screenshot one window or screen (a desktop app, the iOS Simulator window, a native build). Use browser_screenshot for the in-app browser and device_screenshot for simulators.',
		inputSchema: {
			type: 'object',
			properties: {
				window: { type: 'string', description: 'Id from window_list, or text in the window title. Omit for this Volt window.' },
				max_side: { type: 'number', description: 'Longest side in pixels, 256-2560. Default 1280.' },
			},
		},
	},
	{
		name: 'window_record_start',
		title: 'Started recording',
		group: 'capture',
		approvalInReadOnlyModes: 'records a window on the user\'s screen',
		description: 'Start a video recording (WebM, no audio) of one window or screen. A recording badge shows on Volt\'s previews while it runs. Stop with window_record_stop; it stops on its own after max_seconds.',
		inputSchema: {
			type: 'object',
			properties: {
				window: { type: 'string', description: 'Id from window_list, or text in the window title. Omit for this Volt window.' },
				max_seconds: { type: 'number', description: 'Stop after this many seconds (default 60, max 600).' },
			},
		},
	},
	{
		name: 'window_record_stop',
		title: 'Stopped recording',
		group: 'capture',
		description: 'Stop a recording and return the path of the saved .webm file, its length and size.',
		inputSchema: { type: 'object', properties: { recording_id: { type: 'string', description: 'From window_record_start. Default: this chat\'s latest recording.' } } },
	},
];
