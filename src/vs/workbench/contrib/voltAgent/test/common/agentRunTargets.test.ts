/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentRunPrompt, detectRunScripts, findLocalUrl, IAgentRunProjectFiles, runCommandFor, runOpensBrowser } from '../../common/agentRunTargets.js';

function files(names: string[], extra: Partial<IAgentRunProjectFiles> = {}): IAgentRunProjectFiles {
	return { names: new Set(names), platform: 'mac', ...extra };
}

const FLUTTER_PUBSPEC = 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n';

suite('agentRunTargets', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a Flutter project runs on the platforms it has folders for', () => {
		const [flutter] = detectRunScripts(files(['pubspec.yaml', 'ios', 'android', 'web', 'macos', 'lib'], { pubspec: FLUTTER_PUBSPEC }));
		assert.strictEqual(flutter.id, 'flutter');
		assert.deepStrictEqual(flutter.devices, ['ios', 'android', 'browser', 'desktop']);
	});

	test('a Dart package without Flutter is a terminal run', () => {
		const [dart] = detectRunScripts(files(['pubspec.yaml'], { pubspec: 'name: tool\n' }));
		assert.strictEqual(dart.id, 'dart');
		assert.deepStrictEqual(dart.devices, []);
	});

	test('Flutter takes the device the user picked', () => {
		const [flutter] = detectRunScripts(files(['pubspec.yaml', 'ios'], { pubspec: FLUTTER_PUBSPEC }));
		assert.strictEqual(runCommandFor(flutter, { kind: 'ios', id: 'ABC-123', name: 'iPhone 16' }), 'flutter run -d ABC-123');
		assert.strictEqual(runCommandFor(flutter, { kind: 'android', id: 'emulator-5554', name: 'Pixel' }), 'flutter run -d emulator-5554');
		// Served for Volt's browser instead of opening Chrome.
		assert.strictEqual(runCommandFor(flutter, { kind: 'browser', name: 'Volt Browser' }), 'flutter run -d web-server');
		assert.strictEqual(runCommandFor(flutter, { kind: 'desktop', id: 'macos', name: 'macOS' }), 'flutter run -d macos');
		assert.strictEqual(runCommandFor(flutter, { kind: 'android', id: 'My Phone', name: 'My Phone' }), `flutter run -d 'My Phone'`);
	});

	test('Expo and React Native pass the device on', () => {
		const expoPkg = JSON.stringify({ dependencies: { expo: '^52.0.0', 'react-native': '0.76.0' }, scripts: { start: 'expo start' } });
		const [expo] = detectRunScripts(files(['package.json'], { packageJson: expoPkg }));
		assert.strictEqual(expo.id, 'expo');
		assert.strictEqual(runCommandFor(expo, { kind: 'ios', id: 'X', name: 'iPhone' }), 'npx expo start --ios');
		assert.strictEqual(runCommandFor(expo, { kind: 'browser', name: 'Volt Browser' }), 'npx expo start --web');

		const rnPkg = JSON.stringify({ dependencies: { 'react-native': '0.76.0' } });
		const [rn] = detectRunScripts(files(['package.json', 'ios', 'android'], { packageJson: rnPkg }));
		assert.strictEqual(rn.id, 'react-native');
		assert.strictEqual(runCommandFor(rn, { kind: 'ios', id: 'UDID', name: 'iPhone' }), 'npx react-native run-ios --udid UDID');
		assert.strictEqual(runCommandFor(rn, { kind: 'android', id: 'emulator-5554', name: 'Pixel' }), 'npx react-native run-android --deviceId emulator-5554');
	});

	test('package.json scripts: the ones that start something, preferred first, with the project\'s package manager', () => {
		const pkg = JSON.stringify({
			scripts: { build: 'vite build', test: 'vitest', preview: 'vite preview', dev: 'vite', 'start:api': 'node server.js', lint: 'eslint .' },
			devDependencies: { vite: '^6.0.0' },
		});
		const scripts = detectRunScripts(files(['package.json', 'pnpm-lock.yaml'], { packageJson: pkg }));
		assert.deepStrictEqual(scripts.map(script => script.label), ['pnpm dev', 'pnpm preview', 'pnpm start:api']);
		assert.deepStrictEqual(scripts.map(script => script.devices), [['browser'], ['browser'], []]);
		assert.strictEqual(runOpensBrowser(scripts[0], undefined), true);
		assert.strictEqual(runOpensBrowser(scripts[2], undefined), false);
	});

	test('npm start and npm run', () => {
		const pkg = JSON.stringify({ scripts: { start: 'react-scripts start', dev: 'node --watch index.js' } });
		const scripts = detectRunScripts(files(['package.json'], { packageJson: pkg }));
		assert.deepStrictEqual(scripts.map(script => script.command), ['npm run dev', 'npm start']);
		assert.deepStrictEqual(scripts.map(script => script.stack), ['node', 'web']);
	});

	test('other stacks, and a plain index.html when nothing else runs', () => {
		assert.deepStrictEqual(detectRunScripts(files(['manage.py', 'go.mod'])).map(script => script.id), ['django', 'go']);
		assert.deepStrictEqual(detectRunScripts(files(['Cargo.toml'])).map(script => script.command), ['cargo run']);
		assert.deepStrictEqual(detectRunScripts(files(['index.html', 'style.css'])).map(script => script.id), ['static']);
		assert.deepStrictEqual(detectRunScripts(files(['README.md'])), []);
		assert.deepStrictEqual(detectRunScripts(files(['package.json'], { packageJson: '{ not json' })), []);
	});

	test('the local address in a run\'s output', () => {
		assert.strictEqual(findLocalUrl('  VITE v6.0.0  ready in 300 ms\n\n  >  Local:   http://localhost:5173/\n  >  Network: use --host'), 'http://localhost:5173/');
		assert.strictEqual(findLocalUrl('lib/main.dart is being served at http://localhost:54321.'), 'http://localhost:54321');
		assert.strictEqual(findLocalUrl('Starting development server at http://127.0.0.1:8000/'), 'http://127.0.0.1:8000/');
		assert.strictEqual(findLocalUrl('listening on http://0.0.0.0:3000'), 'http://localhost:3000');
		assert.strictEqual(findLocalUrl('Debugger listening on ws://127.0.0.1:9229/abc'), undefined);
		assert.strictEqual(findLocalUrl('compiled successfully'), undefined);
	});

	test('the agent prompt names the picked device, or asks for one', () => {
		const picked = agentRunPrompt({ folder: '/p', device: 'iPhone 16', runners: ['flutter run'] });
		assert.ok(picked.includes('Run it on iPhone 16'));
		assert.ok(picked.includes('flutter run'));
		assert.ok(!picked.includes('ask_question'));
		const unpicked = agentRunPrompt({ folder: '/p', runners: [] });
		assert.ok(unpicked.includes('ask_question'));
		assert.ok(unpicked.includes('device_boot'));
		assert.ok(unpicked.includes('browser_navigate'));
	});
});
