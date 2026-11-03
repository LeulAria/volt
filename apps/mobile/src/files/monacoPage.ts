/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GEIST_MONO_TTF_BASE64, MONACO_CSS, MONACO_JS } from './monacoBundle';

/** JSON that is safe inside a <script> element. */
function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Monaco ids the phone's bundle has no tokenizer for, drawn with a close one instead. */
const LANGUAGE_FALLBACK: Readonly<Record<string, string>> = { json: 'javascript', jsonc: 'javascript', typescriptreact: 'typescript', javascriptreact: 'javascript', shellscript: 'shell', makefile: 'shell', toml: 'ini', dotenv: 'ini', ignore: 'ini' };

export function monacoLanguage(id: string): string {
	return LANGUAGE_FALLBACK[id] ?? id;
}

let payload: string | undefined;

/**
 * The phone's own Monaco build (scripts/monaco) with its styles and Geist Mono, as one script the
 * app injects once the small editor page has loaded. Built once. Injecting it (a WebView command)
 * instead of inlining it in the page skips handing 4 MB through React Native's props, which held
 * the page back by more than half a second.
 */
export function monacoPayload(): string {
	payload ??= `(function () {
	const style = document.createElement('style');
	style.textContent = ${JSON.stringify(`${MONACO_CSS}
@font-face { font-family: 'Geist Mono'; src: url(data:font/ttf;base64,${GEIST_MONO_TTF_BASE64}) format('truetype'); font-weight: 100 900; font-display: block; }`)};
	document.head.appendChild(style);
})();
${MONACO_JS}
;window.__voltStart && window.__voltStart();
true;`;
	return payload;
}

/**
 * The editor page: the file's text and the boot script, waiting for {@link monacoPayload}.
 * `boot.original` set makes it a diff editor (inline, unchanged stretches folded). It talks to the
 * app through ReactNativeWebView.postMessage.
 */
export function monacoPage(boot: object, background: string): string {
	return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
html, body, #e { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ${background}; -webkit-text-size-adjust: 100%; }
.volt-line { background: var(--volt-line); }
</style>
</head><body><div id="e"></div>
<script>
const BOOT = ${scriptJson(boot)};
function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
window.onerror = function (message) { post({ type: 'error', message: String(message) }); };
window.__voltStart = function () { start().catch(function (err) { post({ type: 'error', message: String((err && err.message) || err) }); }); };
async function start() {
	// Monaco measures its font once: wait for Geist Mono so columns line up.
	await document.fonts.load('12.5px "Geist Mono"').catch(function () {});
	monaco.editor.defineTheme('volt-dark', BOOT.themes['volt-dark']);
	monaco.editor.defineTheme('volt-light', BOOT.themes['volt-light']);
	document.documentElement.style.setProperty('--volt-line', BOOT.lineColor);
	const common = {
		theme: BOOT.theme,
		readOnly: true,
		domReadOnly: true,
		automaticLayout: true,
		fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
		fontSize: 12.5,
		lineHeight: 19,
		fontLigatures: false,
		minimap: { enabled: false },
		lineNumbersMinChars: 3,
		lineDecorationsWidth: 6,
		glyphMargin: false,
		folding: false,
		scrollBeyondLastLine: false,
		padding: { top: 8, bottom: 40 },
		wordWrap: BOOT.wrap ? 'on' : 'off',
		renderLineHighlight: BOOT.original === undefined ? 'line' : 'none',
		stickyScroll: { enabled: true },
		contextmenu: false,
		quickSuggestions: false,
		occurrencesHighlight: 'off',
		overviewRulerLanes: 0,
		hideCursorInOverviewRuler: true,
		smoothScrolling: true,
		scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, useShadows: false, alwaysConsumeMouseWheel: false },
	};
	const host = document.getElementById('e');
	let editor;
	let model;
	if (BOOT.original !== undefined) {
		const diff = monaco.editor.createDiffEditor(host, Object.assign({}, common, {
			renderSideBySide: false,
			useInlineViewWhenSpaceIsLow: true,
			renderIndicators: true,
			renderOverviewRuler: false,
			renderMarginRevertIcon: false,
			diffWordWrap: BOOT.wrap ? 'on' : 'off',
			hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
			originalEditable: false,
		}));
		model = monaco.editor.createModel(BOOT.text, BOOT.language);
		diff.setModel({ original: monaco.editor.createModel(BOOT.original, BOOT.language), modified: model });
		editor = diff.getModifiedEditor();
		diff.onDidUpdateDiff(function () { post({ type: 'ready' }); });
	} else {
		model = monaco.editor.createModel(BOOT.text, BOOT.language);
		editor = monaco.editor.create(host, Object.assign({ model: model }, common));
		if (BOOT.line && BOOT.line <= model.getLineCount()) {
			editor.revealLineInCenter(BOOT.line);
			editor.setPosition({ lineNumber: BOOT.line, column: 1 });
			editor.createDecorationsCollection([{ range: new monaco.Range(BOOT.line, 1, BOOT.line, 1), options: { isWholeLine: true, className: 'volt-line' } }]);
		}
		post({ type: 'ready' });
	}
	let saved = model.getAlternativeVersionId();
	let dirty = false;
	model.onDidChangeContent(function () {
		const next = model.getAlternativeVersionId() !== saved;
		if (next !== dirty) {
			dirty = next;
			post({ type: 'dirty', dirty: dirty });
		}
	});
	window.volt = {
		readOnly: function (on) {
			editor.updateOptions({ readOnly: on, domReadOnly: on });
			if (!on) { editor.focus(); }
		},
		wrap: function (on) { editor.updateOptions({ wordWrap: on ? 'on' : 'off' }); },
		text: function () { post({ type: 'text', text: model.getValue(), version: model.getAlternativeVersionId() }); },
		saved: function (version) {
			saved = version;
			dirty = model.getAlternativeVersionId() !== saved;
			post({ type: 'dirty', dirty: dirty });
		},
	};
}
</script></body></html>`;
}
