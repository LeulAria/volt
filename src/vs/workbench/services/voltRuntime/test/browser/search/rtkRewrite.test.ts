/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IVoltExecFileRequest, IVoltExecFileResult } from '../../../../../../platform/voltStdio/common/voltStdio.js';
import { rtkRewrite } from '../../../browser/tools/shellTool.js';

suite('Volt RTK on Windows: rewrite without a shell', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function stdio(answer: (request: IVoltExecFileRequest) => IVoltExecFileResult | Promise<IVoltExecFileResult>, seen: IVoltExecFileRequest[] = []) {
		return {
			execFile: async (request: IVoltExecFileRequest) => {
				seen.push(request);
				return answer(request);
			},
		};
	}

	test('the command reaches RTK as one argument, quotes and & included', async () => {
		const seen: IVoltExecFileRequest[] = [];
		const command = 'git log --format="%h & %s" & echo done';
		const rewritten = await rtkRewrite(stdio(() => ({ exitCode: 3, stdout: `rtk ${command}\r\n`, stderr: '' }), seen), command, 'C:\\repo');
		assert.strictEqual(rewritten, `rtk ${command}`);
		assert.deepStrictEqual(seen.map(request => [request.file, request.args, request.cwd]), [['rtk', ['rewrite', command], 'C:\\repo']]);
	});

	test('no compact form, RTK missing, failing or slow: the command runs as written', async () => {
		assert.strictEqual(await rtkRewrite(stdio(() => ({ exitCode: 1, stdout: '', stderr: '' })), 'dir', undefined), undefined);
		assert.strictEqual(await rtkRewrite(stdio(() => ({ exitCode: null, stdout: '', stderr: '', error: 'spawn rtk ENOENT' })), 'git status', undefined), undefined);
		assert.strictEqual(await rtkRewrite(stdio(() => ({ exitCode: null, stdout: 'rtk git status', stderr: '', error: 'timed out after 3000 ms' })), 'git status', undefined), undefined);
		assert.strictEqual(await rtkRewrite(stdio(() => Promise.reject(new Error('channel closed'))), 'git status', undefined), undefined);
		assert.strictEqual(await rtkRewrite({}, 'git status', undefined), undefined, 'an older stdio service without execFile');
		assert.strictEqual(await rtkRewrite(stdio(() => ({ exitCode: 3, stdout: 'git status', stderr: '' })), 'git status', undefined), undefined, 'the same command is not a rewrite');
	});
});
