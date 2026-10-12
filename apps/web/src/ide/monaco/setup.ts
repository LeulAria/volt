/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/register.all';
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { darkPalette, FONT_MONO_STACK, type IVoltPalette, lightPalette } from '@volt/client-core';

/**
 * Monaco (VS Code's editor) with the desktop's Volt Dark and Volt Light themes. Loaded on first
 * use: the chat-only parts of the app never download it. Tokens use the syntax colours of
 * extensions/theme-cursor (the same ones client-core/theme.ts carries), the editor chrome its
 * workbench colours.
 */

declare global {
	interface Window {
		MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
	}
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

function hex(color: string): string {
	return color.replace('#', '');
}

/** Monaco rules take `RRGGBB`; the palette's rgba() values become the colour over the canvas. */
function solid(color: string, canvas: string): string {
	const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(color);
	if (!m) {
		return hex(color);
	}
	const a = m[4] === undefined ? 1 : Number(m[4]);
	const bg = [1, 3, 5].map(i => parseInt(canvas.slice(i, i + 2), 16));
	return [Number(m[1]), Number(m[2]), Number(m[3])].map((c, i) => Math.round(c * a + bg[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
}

function rules(p: IVoltPalette): monaco.editor.ITokenThemeRule[] {
	const c = (color: string) => solid(color, p.canvas);
	const s = p.syntax;
	return [
		{ token: '', foreground: c(s.plain) },
		{ token: 'comment', foreground: c(s.comment), fontStyle: 'italic' },
		{ token: 'comment.doc', foreground: c(s.comment), fontStyle: 'italic' },
		{ token: 'string', foreground: c(s.string) },
		{ token: 'string.escape', foreground: c(s.constant) },
		{ token: 'string.key.json', foreground: c(s.property) },
		{ token: 'string.value.json', foreground: c(s.string) },
		{ token: 'keyword', foreground: c(s.keyword) },
		{ token: 'keyword.json', foreground: c(s.constant) },
		{ token: 'number', foreground: c(s.number) },
		{ token: 'number.hex', foreground: c(s.number) },
		{ token: 'regexp', foreground: c(s.regex) },
		{ token: 'type', foreground: c(s.type) },
		{ token: 'type.identifier', foreground: c(s.type) },
		{ token: 'identifier', foreground: c(s.variable) },
		{ token: 'variable', foreground: c(s.variable) },
		{ token: 'variable.predefined', foreground: c(s.constant) },
		{ token: 'constant', foreground: c(s.constant) },
		{ token: 'predefined', foreground: c(s.function) },
		{ token: 'function', foreground: c(s.function) },
		{ token: 'delimiter', foreground: c(s.punct) },
		{ token: 'delimiter.bracket', foreground: c(s.punct) },
		{ token: 'operator', foreground: c(s.operator) },
		{ token: 'tag', foreground: c(s.tag) },
		{ token: 'metatag', foreground: c(s.tag) },
		{ token: 'attribute.name', foreground: c(s.attr) },
		{ token: 'attribute.value', foreground: c(s.string) },
		{ token: 'attribute.value.number', foreground: c(s.number) },
		{ token: 'annotation', foreground: c(s.meta) },
		{ token: 'namespace', foreground: c(s.type) },
		{ token: 'key', foreground: c(s.property) },
		{ token: 'emphasis', fontStyle: 'italic' },
		{ token: 'strong', fontStyle: 'bold' },
		{ token: 'keyword.md', foreground: c(s.keyword) },
		{ token: 'variable.md', foreground: c(s.string) },
		{ token: 'string.link.md', foreground: c(s.tag) },
	];
}

const DARK_COLORS: Record<string, string> = {
	'editor.background': '#181818',
	'editor.foreground': '#F0F0F0',
	'editorLineNumber.foreground': '#F0F0F05C',
	'editorLineNumber.activeForeground': '#F0F0F0',
	'editorCursor.foreground': '#F0F0F0',
	'editor.lineHighlightBackground': '#262626',
	'editor.lineHighlightBorder': '#262626',
	'editor.selectionBackground': '#40404099',
	'editor.inactiveSelectionBackground': '#40404077',
	'editor.selectionHighlightBackground': '#404040CC',
	'editor.wordHighlightBackground': '#F0F0F01E',
	'editor.wordHighlightStrongBackground': '#F0F0F030',
	'editor.findMatchBackground': '#88C0D066',
	'editor.findMatchHighlightBackground': '#88C0D044',
	'editor.rangeHighlightBackground': '#40404052',
	'editor.hoverHighlightBackground': '#F0F0F01E',
	'editorIndentGuide.background1': '#F0F0F013',
	'editorIndentGuide.activeBackground1': '#F0F0F030',
	'editorGutter.background': '#181818',
	'editorGutter.addedBackground': '#3FA266',
	'editorGutter.deletedBackground': '#E34671',
	'editorGutter.modifiedBackground': '#D2943E',
	'editorWidget.background': '#141414',
	'editorWidget.border': '#F0F0F01F',
	'editorWidget.resizeBorder': '#F0F0F026',
	'editorSuggestWidget.background': '#141414',
	'editorSuggestWidget.border': '#F0F0F01F',
	'editorSuggestWidget.selectedBackground': '#F0F0F01E',
	'editorHoverWidget.background': '#141414',
	'editorHoverWidget.border': '#F0F0F01F',
	'editorBracketMatch.background': '#F0F0F01A',
	'editorBracketMatch.border': '#F0F0F040',
	'editorOverviewRuler.border': '#F0F0F013',
	'editorStickyScroll.background': '#181818',
	'editorStickyScrollHover.background': '#262626',
	'diffEditor.insertedTextBackground': '#3FA26622',
	'diffEditor.insertedLineBackground': '#3FA26633',
	'diffEditor.removedTextBackground': '#B8004922',
	'diffEditor.removedLineBackground': '#B8004933',
	'diffEditor.diagonalFill': '#F0F0F013',
	'diffEditor.border': '#F0F0F013',
	'scrollbarSlider.background': '#F0F0F011',
	'scrollbarSlider.hoverBackground': '#F0F0F01E',
	'scrollbarSlider.activeBackground': '#F0F0F02A',
	'scrollbar.shadow': '#00000000',
	'focusBorder': '#F0F0F026',
	'input.background': '#F0F0F00A',
	'input.border': '#F0F0F013',
	'input.foreground': '#F0F0F0',
	'inputOption.activeBorder': '#88C0D0',
	'list.activeSelectionBackground': '#F0F0F01E',
	'list.hoverBackground': '#F0F0F011',
	'list.highlightForeground': '#88C0D0',
	'quickInput.background': '#141414',
	'widget.shadow': '#00000066',
	'minimap.background': '#181818',
	'minimapSlider.background': '#F0F0F011',
	'minimapSlider.hoverBackground': '#F0F0F01E',
};

const LIGHT_COLORS: Record<string, string> = {
	'editor.background': '#FCFCFC',
	'editor.foreground': '#141414',
	'editorLineNumber.foreground': '#1414145C',
	'editorLineNumber.activeForeground': '#141414',
	'editorCursor.foreground': '#141414',
	'editor.lineHighlightBackground': '#F0F0F0',
	'editor.lineHighlightBorder': '#F0F0F0',
	'editor.selectionBackground': '#14141426',
	'editor.inactiveSelectionBackground': '#1414141A',
	'editor.selectionHighlightBackground': '#14141414',
	'editor.findMatchBackground': '#5E81AC55',
	'editor.findMatchHighlightBackground': '#5E81AC33',
	'editorIndentGuide.background1': '#14141413',
	'editorIndentGuide.activeBackground1': '#14141433',
	'editorGutter.background': '#FCFCFC',
	'editorGutter.addedBackground': '#1F8A4C',
	'editorGutter.deletedBackground': '#CF2D56',
	'editorGutter.modifiedBackground': '#C08532',
	'editorWidget.background': '#F3F3F3',
	'editorWidget.border': '#14141420',
	'editorSuggestWidget.background': '#F3F3F3',
	'editorSuggestWidget.selectedBackground': '#1414141A',
	'editorHoverWidget.background': '#F3F3F3',
	'editorHoverWidget.border': '#14141420',
	'editorStickyScroll.background': '#FCFCFC',
	'diffEditor.insertedTextBackground': '#1F8A4C22',
	'diffEditor.insertedLineBackground': '#1F8A4C1A',
	'diffEditor.removedTextBackground': '#CF2D5622',
	'diffEditor.removedLineBackground': '#CF2D561A',
	'diffEditor.diagonalFill': '#14141413',
	'scrollbarSlider.background': '#14141414',
	'scrollbarSlider.hoverBackground': '#14141422',
	'scrollbarSlider.activeBackground': '#14141433',
	'scrollbar.shadow': '#00000000',
	'focusBorder': '#14141426',
	'list.highlightForeground': '#3C7CAB',
	'widget.shadow': '#00000022',
	'minimap.background': '#FCFCFC',
};

monaco.editor.defineTheme('volt-dark', { base: 'vs-dark', inherit: true, rules: rules(darkPalette), colors: DARK_COLORS });
monaco.editor.defineTheme('volt-light', { base: 'vs', inherit: true, rules: rules(lightPalette), colors: LIGHT_COLORS });

function currentTheme(): string {
	return document.documentElement.dataset.theme === 'light' ? 'volt-light' : 'volt-dark';
}

monaco.editor.setTheme(currentTheme());
// The app switches `<html data-theme>`; the editors follow.
new MutationObserver(() => monaco.editor.setTheme(currentTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

export const EDITOR_FONT = {
	fontFamily: FONT_MONO_STACK,
	fontSize: 13,
	lineHeight: 20,
	fontLigatures: false,
} as const;

export { monaco };
