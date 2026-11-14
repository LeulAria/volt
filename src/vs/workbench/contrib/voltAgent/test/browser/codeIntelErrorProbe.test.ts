/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { typeScriptErrorFree } from '../../browser/ide/codeIntelHierarchy.js';

suite('Volt code intelligence: tsserver answers whether an edited file has errors', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function commands(answer: (command: string) => unknown): { service: ICommandService; calls: unknown[][] } {
		const calls: unknown[][] = [];
		const service = {
			executeCommand: async (id: string, ...args: unknown[]) => {
				calls.push([id, ...args]);
				const result = answer(args[0] as string);
				if (result instanceof Error) {
					throw result;
				}
				return result;
			},
		} as unknown as ICommandService;
		return { service, calls };
	}

	function model(language: string) {
		const disposables = store.add(new DisposableStore());
		return disposables.add(createTextModel('const a = 1;\n', language, undefined, URI.file('/repo/a.ts')));
	}

	test('no syntax or type errors: error free; suggestions and warnings do not count', async () => {
		const { service, calls } = commands(command => ({ success: true, body: command === 'semanticDiagnosticsSync' ? [{ category: 'suggestion' }, { category: 'warning' }] : [] }));
		assert.strictEqual(await typeScriptErrorFree(service, model('typescript'), CancellationToken.None), true);
		assert.deepStrictEqual(calls.map(call => [call[0], call[1]]).sort(), [['typescript.tsserverRequest', 'semanticDiagnosticsSync'], ['typescript.tsserverRequest', 'syntacticDiagnosticsSync']]);
		assert.strictEqual((calls[0][2] as { file: URI }).file.toString(), URI.file('/repo/a.ts').toString());
	});

	test('an error in either answer: not error free', async () => {
		const { service } = commands(command => ({ success: true, body: command === 'syntacticDiagnosticsSync' ? [{ category: 'error' }] : [] }));
		assert.strictEqual(await typeScriptErrorFree(service, model('javascript'), CancellationToken.None), false);
	});

	test('a failed request, no TypeScript extension or another language: no answer', async () => {
		assert.strictEqual(await typeScriptErrorFree(commands(() => ({ success: false })).service, model('typescript'), CancellationToken.None), undefined);
		assert.strictEqual(await typeScriptErrorFree(commands(() => new Error('command not found')).service, model('typescriptreact'), CancellationToken.None), undefined);
		assert.strictEqual(await typeScriptErrorFree(commands(() => undefined).service, model('javascriptreact'), CancellationToken.None), undefined);
		const { service, calls } = commands(() => ({ success: true, body: [] }));
		assert.strictEqual(await typeScriptErrorFree(service, model('python'), CancellationToken.None), undefined);
		assert.strictEqual(calls.length, 0);
	});
});
