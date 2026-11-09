/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../media/agentIdeCard.css';
import { isEqualOrParent } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ICodeEditor, isCodeEditor } from '../../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { IEditorDecorationsCollection } from '../../../../../../editor/common/editorCommon.js';
import { OverviewRulerLane } from '../../../../../../editor/common/model.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { display, fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, resolvePath, str } from './capability.js';

const MAX_SELECTION = 2_000;

interface IHighlight {
	readonly uri: URI;
	readonly collection: IEditorDecorationsCollection;
}

/**
 * The editor as the user has it, scoped to the chat's folder: the active file, cursor and
 * selection, what is open with unsaved changes; and the agent pointing at code (open at a line,
 * highlight a range with a note) so it can show the user what it means instead of describing it.
 */
export class EditorCapability implements IIdeCapability {

	readonly id = 'editor';

	private readonly highlights = new Map<string, IHighlight[]>();

	constructor(
		private readonly editorService: IEditorService,
		private readonly codeEditorService: ICodeEditorService,
		private readonly textFileService: ITextFileService,
	) { }

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		switch (op) {
			case 'state': return ok(this.state(ctx));
			case 'open':
			case 'highlight': {
				const uri = resolvePath(ctx.root, str(args, 'path'));
				if (!uri) {
					return fail(`${op} needs path.`);
				}
				const line = num(args, 'line') ?? 1;
				const end = Math.max(line, num(args, 'end_line') ?? line);
				const pane = await this.editorService.openEditor({ resource: uri, options: { pinned: true, preserveFocus: op === 'highlight', selection: { startLineNumber: line, startColumn: 1, endLineNumber: op === 'open' ? end : line, endColumn: 1 }, revealIfOpened: true } });
				if (op === 'open') {
					return ok(`Opened ${display(ctx.root, uri)}:${line}${end > line ? `-${end}` : ''} for the user.`);
				}
				const control = pane?.getControl();
				const editor = isCodeEditor(control) ? control : this.editorFor(uri);
				if (!editor) {
					return fail(`Could not show ${display(ctx.root, uri)} in an editor.`);
				}
				const note = str(args, 'note');
				const collection = editor.createDecorationsCollection([{
					range: { startLineNumber: line, startColumn: 1, endLineNumber: end, endColumn: 1 },
					options: {
						description: 'volt-agent-highlight',
						isWholeLine: true,
						className: 'volt-agent-highlight',
						linesDecorationsClassName: 'volt-agent-highlight-gutter',
						...(note ? { hoverMessage: { value: `**Agent:** ${note}` } } : {}),
						overviewRuler: { color: 'rgba(79, 140, 255, 0.8)', position: OverviewRulerLane.Center },
					},
				}]);
				const key = ctx.chatId ?? 'external';
				this.highlights.set(key, [...(this.highlights.get(key) ?? []), { uri, collection }]);
				editor.revealLinesInCenterIfOutsideViewport(line, end);
				return ok(`Highlighted ${display(ctx.root, uri)}:${line}${end > line ? `-${end}` : ''}${note ? ` ("${note}")` : ''}. Clear with op clear.`);
			}
			case 'clear': {
				const key = ctx.chatId ?? 'external';
				const own = this.highlights.get(key) ?? [];
				own.forEach(item => item.collection.clear());
				this.highlights.delete(key);
				return ok(`Cleared ${own.length} highlight${own.length === 1 ? '' : 's'}.`);
			}
		}
		return fail(`editor has no op ${op}.`);
	}

	/** Clears what a chat highlighted (its run ended). */
	clearChat(chatId: string): void {
		this.highlights.get(chatId)?.forEach(item => item.collection.clear());
		this.highlights.delete(chatId);
	}

	private editorFor(uri: URI): ICodeEditor | undefined {
		return this.codeEditorService.listCodeEditors().find(editor => editor.getModel()?.uri.toString() === uri.toString());
	}

	private state(ctx: IIdeCapabilityContext): string {
		const inScope = (uri: URI | undefined) => !!uri && (!ctx.root || isEqualOrParent(uri, ctx.root));
		const lines: string[] = [];
		const active = this.editorService.activeTextEditorControl;
		const editor = isCodeEditor(active) ? active : undefined;
		const model = editor?.getModel();
		if (editor && model && inScope(model.uri)) {
			const selection = editor.getSelection();
			const where = selection ? `line ${selection.positionLineNumber}, column ${selection.positionColumn}` : '';
			lines.push(`Active: ${display(ctx.root, model.uri)} (${model.getLanguageId()}, ${model.getLineCount()} lines) at ${where}${this.textFileService.isDirty(model.uri) ? ', unsaved changes' : ''}.`);
			if (selection && !selection.isEmpty()) {
				const text = model.getValueInRange(selection);
				lines.push(`Selection ${selection.startLineNumber}:${selection.startColumn}-${selection.endLineNumber}:${selection.endColumn}:\n${text.length > MAX_SELECTION ? `${text.slice(0, MAX_SELECTION)}\u2026` : text}`);
			}
			const visible = editor.getVisibleRanges()[0];
			if (visible) {
				lines.push(`Visible lines ${visible.startLineNumber}-${visible.endLineNumber}.`);
			}
		} else {
			lines.push('No file of this chat is active in the editor.');
		}
		const others = this.editorService.visibleTextEditorControls.filter(isCodeEditor).map(item => item.getModel()?.uri).filter(uri => inScope(uri) && uri!.toString() !== model?.uri.toString());
		if (others.length) {
			lines.push(`Also visible: ${others.map(uri => display(ctx.root, uri!)).join(', ')}.`);
		}
		const open = this.editorService.editors.map(input => input.resource).filter((uri): uri is URI => inScope(uri));
		const dirty = this.textFileService.files.models.filter(item => item.isDirty() && inScope(item.resource)).map(item => display(ctx.root, item.resource));
		if (open.length) {
			lines.push(`Open tabs: ${[...new Set(open.map(uri => display(ctx.root, uri)))].slice(0, 30).join(', ')}.`);
		}
		lines.push(dirty.length ? `Unsaved changes (read_file sees them): ${dirty.join(', ')}.` : 'No unsaved changes.');
		return lines.join('\n');
	}
}
