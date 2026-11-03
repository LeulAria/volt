/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { homedir } from 'os';
import { delimiter, join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { withCliDirsOnPath, withWorkingGitOnPath } from '../../node/gitExecutable.js';

suite('Volt git executable', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	(isWindows ? test.skip : test)('a Dock launch PATH gains the usual CLI folders (gh in Homebrew), after the ones it has', () => {
		const path = withCliDirsOnPath(['/usr/bin', '/bin', '/usr/local/bin'].join(delimiter))!.split(delimiter);
		assert.deepStrictEqual(path, ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local', 'bin'), join(homedir(), 'bin')]);
		assert.deepStrictEqual(withCliDirsOnPath(undefined)!.split(delimiter)[0], '/opt/homebrew/bin');
	});

	(isWindows ? test.skip : test)('an empty PATH still finds the system git', async () => {
		const path = (await withWorkingGitOnPath({ PATH: '' })).PATH!.split(delimiter);
		assert.ok(path.includes('/usr/bin'));
		assert.ok(path.includes('/opt/homebrew/bin'));
	});
});
