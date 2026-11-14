/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { CodeIntelHost, setCodeIntelErrorProbe } from '../../browser/host/codeIntelHost.js';

const FILE = URI.file('/repo/src/a.ts');

suite('Volt code intelligence: the new-errors check after an agent write', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const TEXT = 'export const a = 1;\n';

	teardown(() => setCodeIntelErrorProbe(undefined));

	function setup(owned: boolean, onDisk = TEXT): { host: CodeIntelHost; markers: MarkerService; opened: () => number } {
		const disposables = store.add(new DisposableStore());
		const markers = new MarkerService();
		disposables.add({ dispose: () => markers.dispose() });
		const features = new LanguageFeaturesService();
		if (owned) {
			disposables.add(features.hoverProvider.register({ pattern: '**/*.ts' }, { provideHover: () => undefined }));
		}
		let opened = 0;
		const textModels = {
			createModelReference: async (uri: URI) => {
				opened++;
				const model: ITextModel = createTextModel(TEXT, 'typescript', undefined, uri);
				return { object: { textEditorModel: model }, dispose: () => model.dispose() };
			},
		} as unknown as ITextModelService;
		const files = { readFile: async () => ({ value: VSBuffer.fromString(onDisk) }) } as unknown as IFileService;
		const host = disposables.add(new CodeIntelHost(markers, textModels, features as ILanguageFeaturesService, files));
		return { host, markers, opened: () => opened };
	}

	/** A language service that answers after `ms` for the model's current text. */
	function probe(answer: boolean | undefined, ms = 100): { asked: () => number } {
		let asked = 0;
		setCodeIntelErrorProbe({ errorFree: async () => { asked++; await timeout(ms); return answer; } });
		return { asked: () => asked };
	}

	function error(message: string) {
		return { severity: MarkerSeverity.Error, message, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2, source: 'ts' };
	}

	test('a clean edit waits only out the rest of the window counted from the write, not a full one from the check', () => runWithFakedTimers({}, async () => {
		const { host, opened } = setup(true);
		host.noteWrite(FILE);
		await timeout(0);
		assert.strictEqual(opened(), 1, 'the write opens the file for its language service right away');
		await timeout(2_500); // the agent writes its report
		const started = Date.now();
		assert.deepStrictEqual(await host.newErrors(FILE, new Map()), []);
		const waited = Date.now() - started;
		assert.ok(waited <= 600, `waited ${waited} ms`);
		assert.strictEqual(opened(), 1, 'one reference for the write and the check');
	}));

	test('errors reported while the agent went on are found at once', () => runWithFakedTimers({}, async () => {
		const { host, markers } = setup(true);
		host.noteWrite(FILE);
		await timeout(800);
		markers.changeOne('ts', FILE, [error('Type \'string\' is not assignable to type \'number\'.')]);
		await timeout(1_000);
		const started = Date.now();
		const found = await host.newErrors(FILE, new Map());
		assert.ok(Date.now() - started < 50);
		assert.deepStrictEqual(found.map(item => item.message), ['Type \'string\' is not assignable to type \'number\'.']);
	}));

	test('errors that come during the check are still waited for, and a baseline error is not new', () => runWithFakedTimers({}, async () => {
		const { host, markers } = setup(true);
		host.noteWrite(FILE);
		await timeout(0);
		const check = host.newErrors(FILE, new Map([['ts::old', 1]]));
		await timeout(1_200);
		markers.changeOne('ts', FILE, [error('old'), error('new one')]);
		const found = await check;
		assert.deepStrictEqual(found.map(item => item.message), ['new one']);
	}));

	test('a file no language service owns is not waited for', () => runWithFakedTimers({}, async () => {
		const { host } = setup(false);
		host.noteWrite(FILE);
		await timeout(2_000);
		const started = Date.now();
		assert.deepStrictEqual(await host.newErrors(FILE, new Map()), []);
		assert.ok(Date.now() - started < 50, `waited ${Date.now() - started} ms`);
	}));

	test('a check right after the first open gives the language extension a moment to activate', () => runWithFakedTimers({}, async () => {
		const { host } = setup(false);
		const started = Date.now();
		host.noteWrite(FILE);
		await host.newErrors(FILE, new Map());
		const waited = Date.now() - started;
		assert.ok(waited >= 900 && waited <= 1_100, `waited ${waited} ms`);
	}));

	test('a clean edit checked right after the write ends when the language service says the text has no errors', () => runWithFakedTimers({}, async () => {
		const { host } = setup(true);
		const { asked } = probe(true);
		const written = Date.now();
		host.noteWrite(FILE);
		await timeout(100); // the agent's turn ends right after its edit
		assert.deepStrictEqual(await host.newErrors(FILE, new Map()), []);
		const waited = Date.now() - written;
		assert.strictEqual(asked(), 1);
		assert.ok(waited <= 450, `ended ${waited} ms after the write, not at the 3 s cap`);
	}));

	test('a file reopened long after its write waits for the language service answer, not 3 s', () => runWithFakedTimers({}, async () => {
		const { host } = setup(true);
		probe(true, 250);
		host.noteWrite(FILE);
		await timeout(120_000); // the document was closed again; the turn went on
		const started = Date.now();
		assert.deepStrictEqual(await host.newErrors(FILE, new Map()), []);
		const waited = Date.now() - started;
		assert.ok(waited <= 450, `waited ${waited} ms`);
	}));

	test('errors the language service reports, an answer for other text, or no answer keep the full wait', () => runWithFakedTimers({}, async () => {
		for (const [answer, onDisk] of [[false, TEXT], [undefined, TEXT], [true, 'export const a = "x";\n']] as const) {
			const { host } = setup(true, onDisk);
			probe(answer);
			host.noteWrite(FILE);
			await timeout(100);
			const started = Date.now();
			await host.newErrors(FILE, new Map());
			const waited = Date.now() - started;
			assert.ok(waited >= 2_800, `${answer}/${onDisk === TEXT}: waited ${waited} ms`);
		}
	}));

	test('a clean answer does not cut the wait while error markers are still on the file', () => runWithFakedTimers({}, async () => {
		const { host, markers } = setup(true);
		probe(true);
		markers.changeOne('ts', FILE, [error('old')]);
		await timeout(0);
		host.noteWrite(FILE);
		await timeout(0);
		const check = host.newErrors(FILE, new Map());
		await timeout(1_500);
		markers.changeOne('ts', FILE, []); // the language service clears the stale error
		const started = Date.now();
		assert.deepStrictEqual(await check, []);
		assert.ok(Date.now() - started <= 450, 'ends once the markers settle');
	}));
});
