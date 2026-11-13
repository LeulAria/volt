/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileChangesEvent, IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../path/common/pathService.js';
import { VoltMemoryService } from '../../browser/memory/voltMemoryService.js';
import { IVoltHostToolProvider, IVoltHostToolService } from '../../common/hostTools.js';
import { IVoltSessionContextService } from '../../common/sessionContext.js';

suite('Volt memory context (sandboxed host)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const fileChanges = store.add(new Emitter<FileChangesEvent>());
		const fileService = { onDidFilesChange: fileChanges.event, onDidRunOperation: Event.None } as unknown as IFileService;
		let provider: IVoltHostToolProvider | undefined;
		const hostTools = { registerToolProvider: (p: IVoltHostToolProvider) => { provider = p; return Disposable.None; } } as unknown as IVoltHostToolService;
		const environment = { userRoamingDataHome: URI.file('/u/User') } as unknown as IEnvironmentService;
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/w') }] }), onDidChangeWorkspaceFolders: Event.None } as unknown as IWorkspaceContextService;
		const reads: Array<(text: string) => void> = [];
		let notes = 'note A';
		const stdio: Partial<IVoltStdioService> = {
			pluginAvailability: async () => ({ sandboxed: true }),
			pluginContext: () => new Promise<string | undefined>(resolve => reads.push(resolve)),
			invokePluginTool: async () => { notes = 'note B'; return { text: 'saved' }; },
		};
		const service = store.add(new VoltMemoryService(fileService, environment, workspace, hostTools, new NullLogService(), {} as IPathService, { rootFor: () => undefined } as unknown as IVoltSessionContextService, stdio as IVoltStdioService, new TestConfigurationService()));
		const answer = async () => {
			for (let i = 0; i < 20 && !reads.length; i++) {
				await Promise.resolve();
			}
			reads.shift()!(notes);
		};
		return { service, reads, answer, provider: () => provider! };
	}

	test('a later turn gets the last block at once instead of waiting for the host', async () => {
		const { service, reads, answer } = setup();
		const first = service.context();
		await answer();
		assert.strictEqual(await first, 'note A');
		// Fresh: no read at all, and no wait on the host.
		assert.strictEqual(await service.context(), 'note A');
		assert.strictEqual(reads.length, 0);
	});

	test('a change to the notes drops the block, so the next turn reads them again', async () => {
		const { service, answer, provider } = setup();
		const first = service.context();
		await answer();
		await first;
		await provider().invoke('memory_write', { name: 'x', content: 'y' });
		const next = service.context();
		await answer();
		assert.strictEqual(await next, 'note B');
	});

	test('concurrent first reads share one host call', async () => {
		const { service, reads, answer } = setup();
		const a = service.context();
		const b = service.context();
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		assert.strictEqual(reads.length, 1);
		await answer();
		assert.deepStrictEqual(await Promise.all([a, b]), ['note A', 'note A']);
	});
});
