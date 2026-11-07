/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IAgentTerminalInfo } from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';
import { AgentTaskOutputProcess } from '../../browser/terminals/agentTaskTerminal.js';

suite('AgentTaskOutputProcess', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const file = URI.from({ scheme: 'mem', path: '/task.output' });

	function info(status: IAgentTerminalInfo['status'], exitCode?: number): IAgentTerminalInfo {
		return { id: 't1', chatId: 'c1', command: 'npm test', label: 'npm test', cwd: '/repo', status, startedAt: 0, lastActivity: 0, urls: [], viewable: true, kind: 'agent-task', outputFile: file.fsPath, ...(exitCode !== undefined ? { exitCode } : {}) };
	}

	function setup(current: () => IAgentTerminalInfo | undefined) {
		const files = store.add(new FileService(new NullLogService()));
		store.add(files.registerProvider('mem', store.add(new InMemoryFileSystemProvider())));
		const process = store.add(new AgentTaskOutputProcess(file, 'npm test', '/repo', current, files));
		const data: string[] = [];
		store.add(process.onProcessData(e => data.push(typeof e === 'string' ? e : e.data)));
		return { files, process, text: () => data.join('') };
	}

	test('replays the file as terminal lines, then says how the task ended', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { files, process, text } = setup(() => info('completed', 0));
		await files.writeFile(file, VSBuffer.fromString('one\ntwo\r\nthree\n'));
		await process.start();
		await new Promise(resolve => setTimeout(resolve, 10));
		const shown = text();
		assert.ok(shown.startsWith('\x1b[2m$ npm test\x1b[0m\r\n'), shown);
		assert.ok(shown.includes('one\r\ntwo\r\nthree\r\n'), shown);
		assert.ok(shown.includes('npm test: exited 0'), shown);
	}));

	test('follows what a running task appends until it ends', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		let status: IAgentTerminalInfo = info('running');
		const { files, process, text } = setup(() => status);
		await files.writeFile(file, VSBuffer.fromString('first\n'));
		await process.start();
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.ok(text().includes('first\r\n'));
		assert.ok(!text().includes('exited'));

		await files.writeFile(file, VSBuffer.fromString('first\nsecond\n'));
		status = info('failed', 2);
		await new Promise(resolve => setTimeout(resolve, 1000));
		const shown = text();
		assert.strictEqual(shown.split('first').length, 2, 'earlier output is not repeated');
		assert.ok(shown.includes('second\r\n'), shown);
		assert.ok(shown.includes('npm test: exited 2'), shown);
	}));

	test('a file not written yet is not an error', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { process, text } = setup(() => undefined);
		await process.start();
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.ok(text().includes('npm test: no longer tracked'), text());
	}));
});
