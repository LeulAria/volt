/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltSandboxPolicy } from '../../common/sandboxSchema.js';
import { sandboxLaunchNotices } from '../../node/sandboxLauncher.js';

suite('Volt sandbox launch notices', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const network = (mode: IVoltSandboxPolicy['network']['mode'], listenPorts?: number[], listen = false): Pick<IVoltSandboxPolicy, 'network'> =>
		({ network: { mode, allow: [], loopbackPorts: [], listen, ...(listenPorts ? { listenPorts } : {}) } });

	test('macOS limits nobody can change say nothing in the chat', () => {
		const notices = sandboxLaunchNotices(['process.tree', 'limits.memory', 'limits.processes', 'syscalls'], 'seatbelt', network('proxy'));
		assert.deepStrictEqual(notices, { warnings: [], notes: [] });
	});

	test('a project in a privacy-protected folder gets one quiet note that says how to fix it', () => {
		const { warnings, notes } = sandboxLaunchNotices(['process.tree', 'platform.tcc'], 'seatbelt', network('proxy'));
		assert.deepStrictEqual(warnings, []);
		assert.strictEqual(notes.length, 1);
		assert.match(notes[0].title, /privacy permissions/);
		assert.match(notes[0].detail, /Desktop, Documents, Downloads/);
		assert.match(notes[0].detail, /move the project/);
		assert.doesNotMatch(`${notes[0].title} ${notes[0].detail}`, /platform\.tcc/);
	});

	test('the Linux listening warning is only for bubblewrap on the host network with ports granted', () => {
		assert.deepStrictEqual(sandboxLaunchNotices([], 'seatbelt', network('host', [3000])).warnings, []);
		assert.deepStrictEqual(sandboxLaunchNotices([], 'bubblewrap', network('proxy', [3000])).warnings, []);
		assert.deepStrictEqual(sandboxLaunchNotices([], 'bubblewrap', network('host')).warnings, []);
		const warnings = sandboxLaunchNotices(['filesystem.protectNew'], 'bubblewrap', network('host', [3000])).warnings;
		assert.strictEqual(warnings.length, 1);
		assert.match(warnings[0], /Linux cannot limit listening/);
		assert.match(warnings[0], /Turn the network off/);
		assert.strictEqual(sandboxLaunchNotices([], 'bubblewrap', network('host', undefined, true)).warnings.length, 1);
	});
});
