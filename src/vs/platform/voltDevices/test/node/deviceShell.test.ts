/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { remoteScript, shellJoin } from '../../common/deviceCommands.js';

function sh(command: string): Promise<string> {
	return new Promise((resolve, reject) => execFile('/bin/sh', ['-c', command], (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
}

(isWindows ? suite.skip : suite)('Volt devices: remote shell quoting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('arguments reach the remote program intact through the login shell and sh -c', async () => {
		const argv = ['printf', '%s\\n', `it's`, 'a b', '$HOME', '`id`', '; rm -rf ~', `"q"`, 'https://x.dev/?q=\'a b\'&x=1'];
		// ssh hands the command string to the remote login shell, which is what `sh -c <string>` does here.
		const out = await sh(remoteScript(shellJoin(argv), '/opt/android sdk'));
		assert.deepStrictEqual(out.split('\n').slice(0, -1), argv.slice(2));
	});

	test('the remote PATH includes the SDK given in the settings and the default places', async () => {
		const out = await sh(remoteScript('printf %s "$PATH"', '/opt/android sdk'));
		assert.ok(out.startsWith('/opt/android sdk/platform-tools:/opt/android sdk/emulator:'), out);
		assert.ok(out.includes('/Library/Android/sdk/platform-tools'));
		assert.ok(out.includes('/opt/homebrew/bin'));
	});
});
