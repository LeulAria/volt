/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	computeFileChangePreview,
	FILE_CHANGE_PREVIEW_EXPANDED_MAX,
	FILE_CHANGE_PREVIEW_FULL_LIMIT,
	FILE_CHANGE_PREVIEW_LARGE_MAX,
	chooseFileChangeDiffStyle,
	fileChangeVerb,
	formatChangeStats,
	parseToolFileChange,
	parseUnifiedDiff,
} from '../../browser/fileChangePreviewModel.js';

suite('FileChangePreview', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('small change shows the whole diff', () => {
		const preview = computeFileChangePreview({
			path: 'prompt-updates.md',
			original: [
				'Keep the chrome quiet.',
				'App header: keep it compact',
			].join('\n'),
			modified: [
				'Keep the chrome quiet.',
				'- App header: keep it **compact** (tight vertical padding);',
				'App header: keep it compact',
			].join('\n'),
		});
		assert.strictEqual(preview.name, 'prompt-updates.md');
		assert.strictEqual(preview.additions, 1);
		assert.strictEqual(preview.deletions, 0);
		assert.ok(preview.additions + preview.deletions < FILE_CHANGE_PREVIEW_FULL_LIMIT);
		assert.strictEqual(preview.truncated, false);
		assert.ok(preview.lines.some(line => line.kind === 'insert'));
		assert.ok(preview.lines.some(line => line.kind === 'context'));
		assert.ok(preview.lines.length >= 2);
	});

	test('change under 12 lines is not clipped', () => {
		const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const modified = original.slice();
		modified[4] = 'changed 5';
		modified[5] = 'changed 6';
		modified.splice(6, 0, 'added 7');
		const preview = computeFileChangePreview({
			path: 'SKILL.md',
			original: original.join('\n'),
			modified: modified.join('\n'),
		});
		assert.ok(preview.additions + preview.deletions < FILE_CHANGE_PREVIEW_FULL_LIMIT);
		assert.strictEqual(preview.truncated, false);
		assert.ok(preview.lines.filter(line => line.kind !== 'context').length >= 3);
	});

	test('large change shows at most 5 review lines', () => {
		const original = Array.from({ length: 80 }, (_, i) => `old ${i + 1}`);
		const modified = Array.from({ length: 90 }, (_, i) => `new ${i + 1}`);
		const preview = computeFileChangePreview({
			path: 'docs.py',
			original: original.join('\n'),
			modified: modified.join('\n'),
		});
		assert.ok(preview.additions + preview.deletions >= FILE_CHANGE_PREVIEW_FULL_LIMIT);
		assert.ok(preview.lines.length <= FILE_CHANGE_PREVIEW_LARGE_MAX);
		assert.ok(preview.lines.length >= 2);
		assert.ok(preview.truncated);
		assert.strictEqual(preview.additions, 90);
		assert.strictEqual(preview.deletions, 80);
		assert.ok(preview.lines.some(line => line.kind === 'delete'));
		assert.ok(preview.lines.some(line => line.kind === 'insert'));
	});

	test('header keeps full +45-36 counts while preview stays short', () => {
		const original = Array.from({ length: 36 }, (_, i) => `KNOWN_MENU ${i}`);
		const modified = [
			'context before',
			'KNOWN_SCREENS = [',
			'    "Laundry Item Master",',
			...Array.from({ length: 43 }, (_, i) => `    "Screen ${i}"`),
		];
		const preview = computeFileChangePreview({
			path: 'docs.py',
			original: original.join('\n'),
			modified: modified.join('\n'),
		});
		assert.ok(preview.additions >= FILE_CHANGE_PREVIEW_FULL_LIMIT);
		assert.ok(preview.lines.length <= FILE_CHANGE_PREVIEW_LARGE_MAX);
		assert.deepStrictEqual(formatChangeStats(preview.additions, preview.deletions), {
			added: `+${preview.additions}`,
			removed: `-${preview.deletions}`,
		});
	});

	test('formatChangeStats matches the compact +2-1 header', () => {
		assert.deepStrictEqual(formatChangeStats(2, 1), { added: '+2', removed: '-1' });
		assert.deepStrictEqual(formatChangeStats(1, 0), { added: '+1', removed: undefined });
		assert.deepStrictEqual(formatChangeStats(0, 2), { added: undefined, removed: '-2' });
	});

	test('parses a unified diff hunk', () => {
		const hunks = parseUnifiedDiff([
			'--- a/SKILL.md',
			'+++ b/SKILL.md',
			'@@ -253,2 +254,3 @@',
			'-Bottom of Doc.html',
			'-Playlist index.html',
			'+Playlist index.html menu tree',
			'+Channel output/index.html',
		].join('\n'));
		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].additions, 2);
		assert.strictEqual(hunks[0].deletions, 2);
		assert.deepStrictEqual(hunks[0].lines.map(line => line.kind), ['delete', 'delete', 'insert', 'insert']);
	});

	test('uses explorer-style file names from the resource', () => {
		const preview = computeFileChangePreview({
			uri: URI.file('/repo/src/BookingDetailPage.tsx'),
			original: '{breadcrumbStrip}\n',
			modified: '',
		});
		assert.strictEqual(preview.name, 'BookingDetailPage.tsx');
		assert.strictEqual(preview.additions, 0);
		assert.ok(preview.deletions >= 1);
	});

	test('expanded huge change shows a longer review slice', () => {
		const original = Array.from({ length: 80 }, (_, i) => `old ${i + 1}`);
		const modified = Array.from({ length: 90 }, (_, i) => `new ${i + 1}`);
		const collapsed = computeFileChangePreview({ path: 'docs.py', original: original.join('\n'), modified: modified.join('\n') });
		const expanded = computeFileChangePreview({
			path: 'docs.py',
			original: original.join('\n'),
			modified: modified.join('\n'),
		}, { maxLines: FILE_CHANGE_PREVIEW_EXPANDED_MAX });
		assert.ok(collapsed.lines.length <= FILE_CHANGE_PREVIEW_LARGE_MAX);
		assert.ok(expanded.lines.length > collapsed.lines.length);
		assert.ok(expanded.lines.length <= FILE_CHANGE_PREVIEW_EXPANDED_MAX);
		assert.strictEqual(expanded.additions, collapsed.additions);
		assert.strictEqual(expanded.deletions, collapsed.deletions);
	});

	test('parses StrReplace-style tool input', () => {
		const source = parseToolFileChange({
			name: 'Edit',
			title: 'Edited TariffPackageSelector.tsx',
			input: JSON.stringify({
				path: 'src/TariffPackageSelector.tsx',
				old_string: 'onToggle={togglePackage(roomPackageField)}',
				new_string: 'onToggle={togglePackage(\n  roomPackageField.field.onChange,\n  roomPackage,\n)}',
			}),
		});
		assert.ok(source);
		assert.strictEqual(source?.path, 'src/TariffPackageSelector.tsx');
		assert.strictEqual(source?.verb, 'Edited');
		assert.ok(source?.original?.includes('togglePackage(roomPackageField)'));
		assert.ok(source?.modified?.includes('roomPackageField.field.onChange'));
		const preview = computeFileChangePreview(source!);
		assert.ok(preview.additions >= 1);
		assert.ok(preview.deletions >= 1);
	});

	test('parses ACP diff content from a tool result', () => {
		const source = parseToolFileChange({
			name: 'edit',
			result: [{
				type: 'diff',
				path: 'src/app.ts',
				oldText: 'const a = 1;\n',
				newText: 'const a = 2;\n',
			}],
		});
		assert.strictEqual(source?.path, 'src/app.ts');
		assert.strictEqual(source?.original, 'const a = 1;\n');
		assert.strictEqual(source?.modified, 'const a = 2;\n');
	});

	test('fileChangeVerb maps create and delete', () => {
		assert.strictEqual(fileChangeVerb('write', 'Write', 'src/new.ts'), 'Created');
		assert.strictEqual(fileChangeVerb('delete', 'Deleted', 'src/old.ts'), 'Deleted');
		assert.strictEqual(fileChangeVerb('edit', 'Edited', 'src/app.ts'), 'Edited');
	});

	test('browser surface uses the detailed file-diff card', () => {
		assert.strictEqual(chooseFileChangeDiffStyle({ surface: 'browser' }), 'card');
		assert.strictEqual(chooseFileChangeDiffStyle({ surface: 'sidebar' }), 'accordion');
	});

	test('preferred style wins over the surface default', () => {
		assert.strictEqual(chooseFileChangeDiffStyle({ surface: 'browser', preferred: 'accordion' }), 'accordion');
		assert.strictEqual(chooseFileChangeDiffStyle({ surface: 'sidebar', preferred: 'card' }), 'card');
	});
});
