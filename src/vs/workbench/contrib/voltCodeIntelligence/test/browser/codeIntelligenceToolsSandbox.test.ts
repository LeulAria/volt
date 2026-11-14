/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { IVoltCodeIndexService } from '../../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IVoltHostToolCall, IVoltHostToolProvider, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { withSandboxPathRules } from '../../../../services/voltRuntime/common/sandboxPathRules.js';
import { CodeIntelligenceHostTools } from '../../browser/codeIntelligenceTools.js';

suite('Code intelligence host tools for a sandboxed chat', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('DEV-SBX-16: the window serving a sandboxed chat\'s language-server call for the agent server applies the gate\'s rules, and refuses without them', async () => {
		let provider: IVoltHostToolProvider | undefined;
		const hostTools = { registerToolProvider: (registered: IVoltHostToolProvider) => { provider = registered; return toDisposable(() => provider = undefined); } } as unknown as IVoltHostToolService;
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		// The window's Problems list: the chat's project, and a file of the user's credentials folder the editor has open.
		const markers = store.add(new MarkerService());
		const marker = (message: string) => [{ severity: MarkerSeverity.Error, message, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }];
		markers.changeOne('ts', URI.file('/ws/src/a.ts'), marker('a is broken'));
		markers.changeOne('ts', URI.file('/Users/me/.aws/config.ts'), marker('aws_secret_access_key = AKIA-SECRET'));
		// The agent window: no folders of its own.
		const workspace = { getWorkspace: () => ({ folders: [] }), isInsideWorkspace: () => false, onDidChangeWorkspaceFolders: Event.None } as unknown as IWorkspaceContextService;
		store.add(new CodeIntelligenceHostTools(hostTools, {} as IVoltCodeIndexService, {} as ISearchService, fileService, new TestConfigurationService(), workspace, markers, {} as ITextModelService, {} as ILanguageFeaturesService, { files: { get: () => undefined } } as unknown as ITextFileService));
		assert.ok(provider);

		// The call as the agent server sends it: the sandbox and the folders its gate judged by, no closures.
		const sandbox: IVoltSandboxSettings = { level: 'workspace-write', network: false };
		const fromServer: IVoltHostToolCall = { sessionId: 'chat-1', cwd: '/ws', sandbox, sandboxPaths: { roots: ['/ws'], home: '/Users/me', platform: 'darwin' } };
		// What the window's RemoteVoltHostToolService hands its providers.
		const call = withSandboxPathRules(fromServer, fileService);
		assert.ok(call.readRefusal && call.writeRefusal, 'the gate\'s rules, rebuilt from the folders');

		const confined = await provider.invoke('diagnostics', {}, call);
		assert.strictEqual(confined.error, undefined);
		assert.match(confined.text ?? '', /^1 error, 0 other:\nsrc\/a\.ts:1:1 error: a is broken$/);
		assert.doesNotMatch(confined.text ?? '', /AKIA|aws/);
		// Unsandboxed: the whole list, as before.
		assert.match((await provider.invoke('diagnostics', {}, { cwd: '/ws' })).text ?? '', /^2 errors, 0 other:.*AKIA-SECRET/s);

		// A sandboxed call whose rules Volt does not have: nothing is asked of the language servers.
		const blind = await provider.invoke('code_nav', { op: 'references', path: 'src/a.ts', line: 1, symbol: 'a' }, { ...fromServer, sandboxPaths: undefined });
		assert.match(blind.error ?? '', /^code_nav was not run: Volt cannot tell which files this sandboxed chat may read\. Search with your own tools instead/);
		const readRuleOnly: IVoltHostToolCall = { ...fromServer, readRefusal: call.readRefusal };
		const noWrite = await provider.invoke('code_action', { op: 'rename', path: 'src/a.ts', line: 1, symbol: 'a', new_name: 'b' }, readRuleOnly);
		assert.match(noWrite.error ?? '', /^code_action did not start: no file was changed\. Volt cannot tell which files this sandboxed chat may write\. Edit the files with your own tools instead\.$/);
	});
});
