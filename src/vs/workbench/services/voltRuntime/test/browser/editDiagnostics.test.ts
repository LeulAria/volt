/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeIntelHost, IDiagnostic } from '../../browser/tools/codeTools.js';
import { formatEditDiagnostics, withEditDiagnostics } from '../../browser/tools/editDiagnostics.js';
import { IToolContext, IVoltTool } from '../../common/tools/tool.js';

const ROOT = URI.file('/repo');

function edit(isError = false): IVoltTool {
	return {
		name: 'edit_file', group: 'edit', kind: 'edit', description: 'Edit a file.', schema: {}, parallelSafe: false, snippet: 'edit_file',
		execute: async () => ({ callId: '', name: 'edit_file', kind: 'edit', text: 'Edited src/a.ts', ...(isError ? { isError: true } : {}) }),
	};
}

function host(found: IDiagnostic[], allowed = true): ICodeIntelHost & { asked: URI[] } {
	const asked: URI[] = [];
	return {
		asked,
		diagnostics: async (uris: readonly URI[] | undefined) => { asked.push(...(uris ?? [])); return found; },
		lspAllowed: () => allowed,
	} as unknown as ICodeIntelHost & { asked: URI[] };
}

const ctx: IToolContext = { signal: new AbortController().signal };

function error(line: number, message: string): IDiagnostic {
	return { uri: URI.file('/repo/src/a.ts'), line, column: 3, severity: 'error', message, source: 'ts', code: '2322' };
}

suite('Volt edit tools answer with the file\'s errors', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('an edit that leaves errors lists them in its own result; a clean one says so', async () => {
		const withErrors = host([error(12, 'Type \'string\' is not assignable to type \'number\'.\nmore detail')]);
		const tool = withEditDiagnostics(edit(), withErrors, () => ROOT);
		assert.ok(tool.description.endsWith('after the write.'));
		const result = await tool.execute({ path: 'src/a.ts', old_string: 'a', new_string: 'b' }, ctx);
		assert.strictEqual(result.text, 'Edited src/a.ts\n1 error in src/a.ts now (some may predate this edit):\n  12:3 Type \'string\' is not assignable to type \'number\'. [ts 2322]');
		assert.strictEqual(withErrors.asked[0].fsPath, URI.file('/repo/src/a.ts').fsPath);
		const clean = await withEditDiagnostics(edit(), host([]), () => ROOT).execute({ path: 'src/a.ts' }, ctx);
		assert.strictEqual(clean.text, 'Edited src/a.ts\nNo errors in src/a.ts.');
	});

	test('a failed edit, or a file language servers may not read, is answered as it was', async () => {
		const failed = await withEditDiagnostics(edit(true), host([error(1, 'x')]), () => ROOT).execute({ path: 'src/a.ts' }, ctx);
		assert.strictEqual(failed.text, 'Edited src/a.ts');
		const off = host([error(1, 'x')], false);
		const notAllowed = await withEditDiagnostics(edit(), off, () => ROOT).execute({ path: 'src/a.ts' }, ctx);
		assert.strictEqual(notAllowed.text, 'Edited src/a.ts');
		assert.strictEqual(off.asked.length, 0);
	});

	test('many errors are capped and counted', () => {
		const text = formatEditDiagnostics(Array.from({ length: 9 }, (_, index) => error(index + 1, `e${index}`)), 'src/a.ts');
		assert.ok(text.startsWith('9 errors in src/a.ts now'));
		assert.ok(text.endsWith('...and 3 more (diagnostics lists them)'));
	});
});
