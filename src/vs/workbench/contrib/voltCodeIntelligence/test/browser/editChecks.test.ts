/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { CodeIntelHost, setCodeIntelErrorProbe } from '../../../../services/voltRuntime/browser/host/codeIntelHost.js';
import { IDiagnostic } from '../../../../services/voltRuntime/browser/tools/codeTools.js';
import { NO_HOOK_OUTPUT } from '../../../../services/voltRuntime/browser/tools/editDiagnostics.js';
import { EditChecks } from '../../browser/editChecks.js';

let files = 0;
/** Each test checks its own file (what the language service last said about a file is kept per window). */
let FILE = URI.file('/repo/src/a.ts');
const BEFORE = 'export const a: number = 1;\nexport const old: number = "x";\n';
const AFTER = 'export const a: number = "one";\nexport const old: number = "x";\n';

suite('Volt edit checks: no language service for a read, the first edit still gets its check', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => { FILE = URI.file(`/edit-checks/${++files}/src/a.ts`); });
	teardown(() => setCodeIntelErrorProbe(undefined));

	/**
	 * A window whose TypeScript service is not running: it starts when the first document is opened
	 * and answers `startMs` later, about the text the document has then.
	 */
	function window(startMs: number): { checks: EditChecks; host: CodeIntelHost; opened: () => number; write: (text: string) => void; asked: () => string[]; features: LanguageFeaturesService; model: () => ITextModel | undefined } {
		const disposables = store.add(new DisposableStore());
		const markers = new MarkerService();
		disposables.add({ dispose: () => markers.dispose() });
		const features = new LanguageFeaturesService();
		let onDisk = BEFORE;
		let opened = 0;
		let startedAt: number | undefined;
		let model: ITextModel | undefined;
		const textModels = {
			createModelReference: async (uri: URI) => {
				opened++;
				startedAt ??= Date.now();
				const created = model = createTextModel(onDisk, 'typescript', undefined, uri);
				return {
					object: { textEditorModel: created, isDirty: () => false, resolve: async () => { if (created.getValue() !== onDisk) { created.setValue(onDisk); } } },
					dispose: () => created.dispose(),
				};
			},
		} as unknown as ITextModelService;
		const files = { readFile: async () => ({ value: VSBuffer.fromString(onDisk) }) } as unknown as IFileService;
		const asked: string[] = [];
		setCodeIntelErrorProbe({
			errorFree: async () => undefined,
			errors: async (checked): Promise<IDiagnostic[] | undefined> => {
				if (startedAt === undefined || Date.now() - startedAt < startMs) {
					return undefined; // still starting
				}
				const text = checked.getValue();
				asked.push(text);
				return text.split('\n').flatMap((line, index): IDiagnostic[] => /: number = "/.test(line)
					? [{ uri: checked.uri, line: index + 1, column: 14, severity: 'error', message: `Type 'string' is not assignable to type 'number' (${/const (\w+)/.exec(line)?.[1]}).`, source: 'ts', code: '2322' }]
					: []);
			},
		});
		const host = disposables.add(new CodeIntelHost(markers, textModels, features as ILanguageFeaturesService, files));
		return { checks: new EditChecks(host), host, opened: () => opened, write: text => { onDisk = text; }, asked: () => asked, features, model: () => model };
	}

	const context = (output: string): string | undefined => JSON.parse(output).hookSpecificOutput?.additionalContext;

	test('a read opens nothing while no language service is up, and warms the file once one is', () => runWithFakedTimers({}, async () => {
		const { checks, host, opened, features } = window(0);
		assert.strictEqual(await checks.run('read', FILE, 'src/a.ts', 'chat'), NO_HOOK_OUTPUT);
		await timeout(1_000);
		assert.strictEqual(opened(), 0, 'no document, so no language service is started for a read');

		// The user opens a TypeScript file in an editor tab: its service starts and registers providers.
		const tab = store.add(createTextModel('export {};\n', 'typescript', undefined, URI.file('/repo/src/tab.ts')));
		store.add(features.hoverProvider.register({ pattern: '**/*.ts' }, { provideHover: () => undefined }));
		host.setDocuments({ open: () => [tab], holdReload: () => Disposable.None });
		assert.strictEqual(await checks.run('read', FILE, 'src/a.ts', 'chat'), NO_HOOK_OUTPUT);
		await timeout(1_000);
		assert.strictEqual(opened(), 1, 'the read warms the file as before');
	}));

	test('the first edit starts the language service and is told the error it added, not the one that was there', () => runWithFakedTimers({}, async () => {
		const { checks, opened, write, asked, model } = window(4_000);
		const started = Date.now();
		assert.strictEqual(await checks.run('before', FILE, 'src/a.ts', 'chat'), NO_HOOK_OUTPUT);
		assert.strictEqual(opened(), 1);
		assert.ok(Date.now() - started <= 1_600, `the edit was held ${Date.now() - started} ms`);
		write(AFTER); // the edit, while the service is still starting
		const output = await checks.run('after', FILE, 'src/a.ts', 'chat');
		assert.deepStrictEqual(asked().slice(0, 2), [BEFORE, AFTER], 'asked about the text before the edit first, then the new text');
		assert.strictEqual(context(output), '[Volt] This edit added 1 error in src/a.ts (language server):\n  1:14 Type \'string\' is not assignable to type \'number\' (a). [ts 2322]');
		assert.ok(Date.now() - started <= 5_000, `answered ${Date.now() - started} ms after the edit's start`);
		assert.strictEqual(model()?.getValue(), AFTER);

		// The next edit of the file: the service is up, nothing new is added.
		assert.strictEqual(await checks.run('before', FILE, 'src/a.ts', 'chat'), NO_HOOK_OUTPUT);
		write(`${AFTER}export const b = 2;\n`);
		assert.strictEqual(await checks.run('after', FILE, 'src/a.ts', 'chat'), NO_HOOK_OUTPUT);
	}));

	test('a clean first edit says nothing', () => runWithFakedTimers({}, async () => {
		const { checks, write } = window(3_000);
		await checks.run('before', FILE, 'src/a.ts', 'chat');
		write(`${BEFORE}export const b = 2;\n`);
		assert.strictEqual(await checks.run('after', FILE, 'src/a.ts', 'chat'), NO_HOOK_OUTPUT);
	}));

	test('a service slower than the hook may wait: its answer goes out with the chat\'s next hook answer, once', () => runWithFakedTimers({}, async () => {
		const { checks, write } = window(12_000);
		await checks.run('before', FILE, 'src/a.ts', 'chat');
		write(AFTER);
		const started = Date.now();
		assert.strictEqual(await checks.run('after', FILE, 'src/a.ts', 'chat'), NO_HOOK_OUTPUT);
		assert.ok(Date.now() - started <= 7_100, `the hook waited ${Date.now() - started} ms`);
		await timeout(6_000);
		assert.strictEqual(await checks.run('read', undefined, '', 'other chat'), NO_HOOK_OUTPUT, 'another chat is not told');
		assert.strictEqual(context(await checks.run('read', undefined, '', 'chat')), '[Volt] An earlier edit added 1 error in src/a.ts (language server, which was still starting when the edit was made):\n  1:14 Type \'string\' is not assignable to type \'number\' (a). [ts 2322]');
		assert.strictEqual(await checks.run('read', undefined, '', 'chat'), NO_HOOK_OUTPUT);
	}));
});
