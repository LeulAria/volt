/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IVoltCodeIndexOptions } from '../../common/voltCodeIndex.js';
import { CodeIndexEngine } from '../../node/codeIndexEngine.js';

/**
 * `instant_grep` with `path` set to one file: a sandboxed chat's search answered "not indexed"
 * (8 calls in the hotel-repo benchmark), because the index only took folders.
 */
suite('Volt code index: searching one file', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let base: string;
	let ws: string;
	let engine: CodeIndexEngine;

	suiteSetup(async () => {
		base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), `volt-index-file-${generateUuid().slice(0, 8)}-`)));
		ws = join(base, 'ws');
		await fs.mkdir(join(ws, 'src', 'reservation'), { recursive: true });
		await fs.writeFile(join(ws, 'src', 'reservation', 'reservation.service.ts'), 'export class ReservationService {\n\tcancel() { assertTransition(a, \'cancelled\'); }\n\tcheckIn() { assertTransition(a, \'checked_in\'); }\n}\n');
		await fs.writeFile(join(ws, 'src', 'reservation', 'reservation.controller.ts'), 'export class ReservationController {\n\tcheckIn() { return this.service.checkIn(); }\n}\n');
		await fs.writeFile(join(ws, 'src', 'reservation', 'reservation.service.spec.ts'), 'assertTransition(x, y);\n');
		engine = new CodeIndexEngine(join(base, 'data'), () => { });
	});

	suiteTeardown(async () => {
		await engine?.dispose();
		await fs.rm(base, { recursive: true, force: true });
	});

	const search = (folder: string, options: IVoltCodeIndexOptions) =>
		engine.search({ root: ws, folder, pattern: 'assertTransition', isRegExp: false, caseSensitive: true, multiline: false, maxMatches: 50, options, waitMs: 30_000 });

	for (const [label, options] of [['a sandboxed chat', { confined: true }], ['the shared index', {}]] as const) {
		test(`${label}: a file inside the root is searched, and only that file`, async () => {
			const result = await search(join(ws, 'src', 'reservation', 'reservation.service.ts'), options);
			assert.strictEqual(result.kind, 'results', JSON.stringify(result));
			assert.deepStrictEqual(result.kind === 'results' ? result.files.map(file => [file.path, file.lines.map(line => line.line)]) : undefined, [['src/reservation/reservation.service.ts', [2, 3]]]);
		});
	}

	test('a file that is not a prefix of its neighbours: reservation.service.ts does not pull in reservation.service.spec.ts', async () => {
		const result = await search(join(ws, 'src', 'reservation', 'reservation.service.ts'), { confined: true });
		assert.deepStrictEqual(result.kind === 'results' ? result.files.map(file => file.path) : result, ['src/reservation/reservation.service.ts']);
	});

	test('a regex through the index on one file', async () => {
		const result = await engine.search({ root: ws, folder: join(ws, 'src', 'reservation', 'reservation.controller.ts'), pattern: 'check(In|Out)\\(', isRegExp: true, caseSensitive: true, multiline: false, maxMatches: 50, options: { confined: true }, waitMs: 30_000 });
		assert.deepStrictEqual(result.kind === 'results' ? result.files.map(file => [file.path, file.lines.map(line => line.line)]) : result, [['src/reservation/reservation.controller.ts', [2]]]);
	});

	test('a file that does not exist is still "not indexed"', async () => {
		const result = await search(join(ws, 'src', 'reservation', 'missing.ts'), { confined: true });
		assert.deepStrictEqual(result, { kind: 'fallback', reason: 'not indexed' });
	});
});
