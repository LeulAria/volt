/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, compactNumber, errorMessage, languageForPath, type VoltClient } from '@volt/client-core';
import { useEffect, useRef, useState } from 'react';
import { insertIntoComposer } from '../composerBridge';
import { Codicon } from '../icons';
import { relativeTo } from '../roots';
import {
	type EditorTab, getWorkbench, openQuick, saveActive, setCursor, subscribeWorkbench, toggleAgentPanel, useWorkbench
} from '../workbench';
import { acquireFile, agentModifiedModel, bindClient, type FileLoad, originalModel, refreshFiles } from './models';
import { EDITOR_FONT, monaco } from './setup';

/**
 * The editor area's Monaco views. One code editor instance serves every file tab (the model
 * swaps, each file keeps its scroll and selection), the way the desktop's editor group does.
 */

export { bindClient, refreshFiles };

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const diffViewStates = new Map<string, monaco.editor.IDiffEditorViewState | null>();

const BASE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
	...EDITOR_FONT,
	automaticLayout: true,
	minimap: { enabled: true, renderCharacters: false, maxColumn: 100, showSlider: 'mouseover' },
	scrollBeyondLastLine: true,
	smoothScrolling: true,
	cursorBlinking: 'smooth',
	cursorSmoothCaretAnimation: 'on',
	renderLineHighlight: 'all',
	renderWhitespace: 'selection',
	bracketPairColorization: { enabled: true },
	guides: { bracketPairs: 'active', indentation: true },
	stickyScroll: { enabled: true },
	padding: { top: 6, bottom: 6 },
	fixedOverflowWidgets: true,
	scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
	overviewRulerBorder: false,
	mouseWheelZoom: true,
	tabSize: 4,
	detectIndentation: true,
	linkedEditing: true,
	formatOnPaste: false,
	unicodeHighlight: { ambiguousCharacters: false },
};

function reportCursor(editor: monaco.editor.ICodeEditor): void {
	const model = editor.getModel();
	const position = editor.getPosition();
	if (!model || !position) {
		setCursor(undefined);
		return;
	}
	const selections = editor.getSelections() ?? [];
	const selected = selections.reduce((sum, s) => sum + model.getValueLengthInRange(s), 0);
	const options = model.getOptions();
	setCursor({
		line: position.lineNumber,
		column: position.column,
		selected,
		language: languageForPath(model.uri.path).label,
		tabSize: options.tabSize,
		insertSpaces: options.insertSpaces,
		eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
	});
}

/** Keys the workbench handles while the editor has focus (it would otherwise eat them). */
function addWorkbenchKeys(editor: monaco.editor.IStandaloneCodeEditor): void {
	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveActive());
	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openQuick('files'));
	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => openQuick('commands'));
	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => openQuick('line'));
	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => addSelectionToChat(editor));
	editor.addAction({
		id: 'volt.addToChat',
		label: 'Add Selection to Chat',
		contextMenuGroupId: '0_volt',
		contextMenuOrder: 0,
		run: () => addSelectionToChat(editor),
	});
}

/** ⌘L (as in the desktop): the file and selected lines go into the agent's composer. */
function addSelectionToChat(editor: monaco.editor.ICodeEditor): void {
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const selection = editor.getSelection();
	const rel = relativeTo(getWorkbench().resolvedRoot, model.uri.path);
	const range = selection && !selection.isEmpty()
		? `:${selection.startLineNumber}${selection.endLineNumber !== selection.startLineNumber ? `-${selection.endLineNumber}` : ''}`
		: '';
	toggleAgentPanel(true);
	setTimeout(() => insertIntoComposer(`@${rel}${range} `), 60);
}

function useEditorOptions(): { readonly wordWrap: boolean; readonly diffInline: boolean } {
	const wordWrap = useWorkbench(s => s.wordWrap);
	const diffInline = useWorkbench(s => s.diffInline);
	return { wordWrap, diffInline };
}

function Message({ icon, title, body }: { readonly icon: Parameters<typeof Codicon>[0]['name']; readonly title: string; readonly body?: string }) {
	return (
		<div className="editor-message">
			<Codicon name={icon} size={28} />
			<div className="editor-message-title">{title}</div>
			{body ? <div className="editor-message-body">{body}</div> : null}
		</div>
	);
}

function NonText({ load, path }: { readonly load: Exclude<FileLoad, { kind: 'text' }>; readonly path: string }) {
	if (load.kind === 'image') {
		return (
			<div className="image-view">
				<img src={`data:${load.mime};base64,${load.base64}`} alt={basename(path)} />
				<div className="image-meta">{basename(path)} · {compactNumber(load.size)}B</div>
			</div>
		);
	}
	return load.kind === 'binary'
		? <Message icon="file" title="This file is binary" body="It is not displayed because it is not text." />
		: <Message icon="warning" title="This file is too large to open here" body={`${compactNumber(load.size)}B. Open it in Volt on your computer.`} />;
}

/** The file editor: one Monaco editor, the active file's model. */
export function CodeEditorPane({ client, path }: { readonly client: VoltClient; readonly path: string }) {
	const host = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
	const [load, setLoad] = useState<FileLoad | { kind: 'loading' } | { kind: 'error'; message: string }>({ kind: 'loading' });
	const { wordWrap } = useEditorOptions();

	useEffect(() => bindClient(client), [client]);

	useEffect(() => {
		let cancelled = false;
		setLoad(current => current.kind === 'text' ? current : { kind: 'loading' });
		acquireFile(path).then(result => !cancelled && setLoad(result), err => !cancelled && setLoad({ kind: 'error', message: errorMessage(err) }));
		return () => {
			cancelled = true;
		};
	}, [path]);

	const isText = load.kind === 'text';
	useEffect(() => {
		if (!isText || !host.current) {
			return;
		}
		const editor = monaco.editor.create(host.current, { ...BASE_OPTIONS, model: null, wordWrap: getWorkbench().wordWrap ? 'on' : 'off' });
		editorRef.current = editor;
		addWorkbenchKeys(editor);
		const listeners = [
			editor.onDidChangeCursorSelection(() => reportCursor(editor)),
			editor.onDidChangeModel(() => reportCursor(editor)),
			editor.onDidChangeModelOptions(() => reportCursor(editor)),
		];
		return () => {
			const model = editor.getModel();
			if (model) {
				viewStates.set(model.uri.path, editor.saveViewState());
			}
			listeners.forEach(l => l.dispose());
			editor.dispose();
			editorRef.current = undefined;
			setCursor(undefined);
		};
	}, [isText]);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || load.kind !== 'text') {
			return;
		}
		const previous = editor.getModel();
		if (previous !== load.model) {
			if (previous) {
				viewStates.set(previous.uri.path, editor.saveViewState());
			}
			editor.setModel(load.model);
			const state = viewStates.get(load.model.uri.path);
			if (state) {
				editor.restoreViewState(state);
			}
			reportCursor(editor);
		}
		editor.focus();
	}, [load]);

	useEffect(() => {
		editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' });
	}, [wordWrap]);

	// Search results and `path:line` links put the cursor where they point.
	useEffect(() => {
		const apply = () => {
			const reveal = getWorkbench().reveal;
			const editor = editorRef.current;
			const model = editor?.getModel();
			if (!reveal || !editor || !model || model.uri.path !== monaco.Uri.file(reveal.path).path || appliedReveal === reveal.seq) {
				return;
			}
			appliedReveal = reveal.seq;
			const line = Math.min(reveal.line, model.getLineCount());
			const start = reveal.column ?? 1;
			const end = reveal.endColumn ?? start;
			editor.setSelection(new monaco.Range(line, start, line, end));
			editor.revealLineInCenter(line, monaco.editor.ScrollType.Smooth);
			editor.focus();
		};
		apply();
		return subscribeWorkbench(apply);
	}, [load]);

	if (load.kind === 'loading') {
		return <div className="editor-loading"><span className="spinner" style={{ width: 14, height: 14 }} /></div>;
	}
	if (load.kind === 'error') {
		return <Message icon="error" title={`Couldn't open ${basename(path)}`} body={load.message} />;
	}
	if (load.kind !== 'text') {
		return <NonText load={load} path={path} />;
	}
	return <div className="monaco-host" ref={host} />;
}

let appliedReveal = 0;

/** A diff: git's HEAD (or the file before the agent changed it) against the file now, editable. */
export function DiffEditorPane({ client, tab }: { readonly client: VoltClient; readonly tab: Extract<EditorTab, { kind: 'diff' }> }) {
	const host = useRef<HTMLDivElement>(null);
	const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
	const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | { kind: 'error'; message: string } | { kind: 'other'; load: Exclude<FileLoad, { kind: 'text' }> }>({ kind: 'loading' });
	const [stats, setStats] = useState<{ readonly changes: number; readonly index: number } | undefined>();
	const { wordWrap, diffInline } = useEditorOptions();

	useEffect(() => bindClient(client), [client]);

	useEffect(() => {
		let cancelled = false;
		setState({ kind: 'loading' });
		(async () => {
			const original = await originalModel(tab);
			let modified: monaco.editor.ITextModel;
			try {
				const load = await acquireFile(tab.path);
				if (load.kind !== 'text') {
					if (!cancelled) {
						setState({ kind: 'other', load });
					}
					return;
				}
				modified = load.model;
			} catch {
				// The file is gone (the agent deleted it): show what it had.
				modified = tab.base.kind === 'agent' ? await agentModifiedModel(tab) : monaco.editor.createModel('', languageForPath(tab.path).monaco);
			}
			if (!cancelled) {
				setState({ kind: 'ready', original, modified });
			}
		})().catch(err => !cancelled && setState({ kind: 'error', message: errorMessage(err) }));
		return () => {
			cancelled = true;
		};
	}, [tab]);

	const ready = state.kind === 'ready';
	useEffect(() => {
		if (!ready || !host.current) {
			return;
		}
		const diff = monaco.editor.createDiffEditor(host.current, {
			...BASE_OPTIONS,
			minimap: { enabled: false },
			renderSideBySide: !getWorkbench().diffInline,
			useInlineViewWhenSpaceIsLimited: true,
			originalEditable: false,
			ignoreTrimWhitespace: false,
			renderOverviewRuler: true,
			hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
			experimental: { showMoves: true },
			wordWrap: getWorkbench().wordWrap ? 'on' : 'off',
		});
		diffRef.current = diff;
		addWorkbenchKeys(diff.getModifiedEditor());
		const modifiedEditor = diff.getModifiedEditor();
		const listeners = [
			modifiedEditor.onDidChangeCursorSelection(() => reportCursor(modifiedEditor)),
			diff.onDidUpdateDiff(() => {
				const changes = diff.getLineChanges() ?? [];
				setStats({ changes: changes.length, index: 0 });
			}),
		];
		return () => {
			diffViewStates.set(tab.id, diff.saveViewState());
			listeners.forEach(l => l.dispose());
			diff.setModel(null);
			diff.dispose();
			diffRef.current = undefined;
			setCursor(undefined);
		};
	}, [ready, tab.id]);

	useEffect(() => {
		const diff = diffRef.current;
		if (!diff || state.kind !== 'ready') {
			return;
		}
		diff.setModel({ original: state.original, modified: state.modified });
		const saved = diffViewStates.get(tab.id);
		if (saved) {
			diff.restoreViewState(saved);
		}
		reportCursor(diff.getModifiedEditor());
	}, [state, tab.id]);

	useEffect(() => {
		diffRef.current?.updateOptions({ renderSideBySide: !diffInline, wordWrap: wordWrap ? 'on' : 'off' });
	}, [diffInline, wordWrap]);

	const go = (delta: 1 | -1) => {
		const diff = diffRef.current;
		const changes = diff?.getLineChanges() ?? [];
		if (!diff || !changes.length) {
			return;
		}
		const editor = diff.getModifiedEditor();
		const line = editor.getPosition()?.lineNumber ?? 0;
		const starts = changes.map(c => Math.max(1, c.modifiedStartLineNumber));
		let index = delta > 0 ? starts.findIndex(s => s > line) : starts.map((s, i) => [s, i] as const).reverse().find(([s]) => s < line)?.[1] ?? -1;
		if (index < 0) {
			index = delta > 0 ? 0 : starts.length - 1;
		}
		editor.setPosition({ lineNumber: starts[index], column: 1 });
		editor.revealLineInCenter(starts[index], monaco.editor.ScrollType.Smooth);
		editor.focus();
		setStats({ changes: changes.length, index: index + 1 });
	};

	if (state.kind === 'loading') {
		return <div className="editor-loading"><span className="spinner" style={{ width: 14, height: 14 }} /></div>;
	}
	if (state.kind === 'error') {
		return <Message icon="error" title="Couldn't open the diff" body={state.message} />;
	}
	if (state.kind === 'other') {
		return <NonText load={state.load} path={tab.path} />;
	}
	return (
		<div className="diff-pane">
			<div className="diff-toolbar">
				<span className="diff-label"><span className="diff-side">{tab.base.kind === 'head' ? 'HEAD' : 'Before the agent'}</span><Codicon name="arrow-right" size={12} /><span className="diff-side">Working tree</span></span>
				<span className="diff-spacer" />
				{stats ? <span className="diff-count">{stats.changes ? `${stats.index || '–'} of ${stats.changes} ${stats.changes === 1 ? 'change' : 'changes'}` : 'No changes'}</span> : null}
				<button type="button" className="ide-icon-btn" title="Previous change (⇧⌥F5)" onClick={() => go(-1)}><Codicon name="arrow-up" /></button>
				<button type="button" className="ide-icon-btn" title="Next change (⌥F5)" onClick={() => go(1)}><Codicon name="arrow-down" /></button>
			</div>
			<div className="monaco-host" ref={host} />
		</div>
	);
}
