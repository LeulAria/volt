/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The phone's diff and file viewer: @pierre/diffs' CodeView (virtualized, Shadow DOM) with the
// Highlights backend and a Volt theme. The line diff is client-core's patience diff, which
// stays fast on rewrites where the library's own (jsdiff) takes seconds on a 3k-line file.
import { canUseWASM, CodeView, preloadHighlighter, processFile, registerCustomTheme } from '@pierre/diffs';
import { diffText } from '../../../client-core/src/diff.ts';

const THEME = 'volt';

/** The hunks of `before` → `after` as a unified patch with each side's line marks only (processFile reads the text from the files). */
function patchOf(name, before, after) {
	const diff = diffText(before, after, 3);
	const oldCount = countLines(before);
	const newCount = countLines(after);
	const oldOpen = before !== '' && !before.endsWith('\n');
	const newOpen = after !== '' && !after.endsWith('\n');
	const out = [`--- a/${name}\n+++ b/${name}\n`];
	for (const hunk of diff.hunks) {
		out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`);
		for (const line of hunk.lines) {
			out.push(line.kind === 'add' ? '+\n' : line.kind === 'del' ? '-\n' : ' \n');
			const lastOld = line.kind !== 'add' && line.oldLine === oldCount && oldOpen;
			const lastNew = line.kind !== 'del' && line.newLine === newCount && newOpen;
			if (line.kind === 'context' ? lastOld && lastNew : lastOld || lastNew) {
				out.push('\\ No newline at end of file\n');
			}
		}
	}
	return { patch: out.join(''), additions: diff.additions, deletions: diff.deletions, hunks: diff.hunks.length };
}

function countLines(text) {
	if (!text) {
		return 0;
	}
	let n = 0;
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
		n++;
	}
	return text.endsWith('\n') ? n : n + 1;
}

/** `before` → `after` as the library's diff model, without running its jsdiff. */
export function fileDiff(name, before, after) {
	const { patch, additions, deletions, hunks } = patchOf(name, before, after);
	const metadata = processFile(patch, { oldFile: { name, contents: before }, newFile: { name, contents: after }, throwOnError: true });
	if (!metadata) {
		throw new Error('Couldn\'t read the diff');
	}
	metadata.name = name;
	return { metadata, additions, deletions, hunks };
}

/** Registers the page's theme (a Zed theme for Highlights) once. */
export function setTheme(theme) {
	registerCustomTheme(THEME, () => Promise.resolve(theme), 'zed');
	return THEME;
}

/** Starts Highlights and the theme while the page waits for its text. */
export function warm() {
	return preloadHighlighter({ themes: [THEME], langs: [], preferredHighlighter: 'highlights' });
}

export { canUseWASM, CodeView };
