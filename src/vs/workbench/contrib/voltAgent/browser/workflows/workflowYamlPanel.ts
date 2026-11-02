/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IEditorConstructionOptions } from '../../../../../editor/browser/config/editorConfiguration.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { overviewRulerError, overviewRulerInfo, overviewRulerWarning } from '../../../../../editor/common/core/editorColorRegistry.js';
import { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, ITextModel, OverviewRulerLane, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { themeColorFromId } from '../../../../../platform/theme/common/themeService.js';
import { IUndoRedoService } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { validateWorkflow } from '../../../../services/voltRuntime/common/workflows/workflowGraph.js';
import { serializeWorkflow } from '../../../../services/voltRuntime/common/workflows/workflowSchema.js';
import { IWorkflowDefinition, IWorkflowIssue, IWorkflowSaveResult } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { WorkflowEditorModel } from '../../common/workflows/workflowEditorModel.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

/**
 * The YAML tab: the workflow's canonical YAML in a Monaco editor, kept in step with the model both
 * ways. Canvas and inspector edits rewrite the text (only the lines that changed, so the cursor and
 * scroll stay; never while the user is typing in it). Typing parses after a pause and swaps the
 * definition in when the document is usable; syntax or shape errors show as markers and in the
 * builder's validity pill, and the canvas keeps the last good version.
 */

export interface IWorkflowYamlPanelOptions {
	/** The stored text of a saved workflow (comments kept); the canonical YAML otherwise. */
	readonly initialText?: string;
	readonly parse: (text: string) => IWorkflowSaveResult;
	/** The saved workflow's id: YAML edits keep it, since another id would be another file. */
	readonly lockedId: () => string | undefined;
	/** "Paste a workflow": the page's import dialog. */
	readonly onPaste: () => void;
}

const PARSE_DELAY_MS = 300;
/** Model changes that arrive this soon after a keystroke wait until the user pauses or leaves. */
const TYPING_GRACE_MS = 1500;

export class WorkflowYamlPanel extends Disposable {

	readonly element: HTMLElement;
	private readonly status: HTMLElement;
	private readonly editorHost: HTMLElement;
	private readonly editor: CodeEditorWidget;
	private readonly textModel: ITextModel;
	private readonly decorations: IEditorDecorationsCollection;
	private readonly parse = this._register(new RunOnceScheduler(() => this.parseNow(), PARSE_DELAY_MS));
	private readonly catchUp = this._register(new RunOnceScheduler(() => this.syncFromModel(), TYPING_GRACE_MS));
	private readonly _onDidChangeIssues = this._register(new Emitter<readonly IWorkflowIssue[]>());
	/** Problems in the text that keep it from reaching the canvas (empty when in step). */
	readonly onDidChangeIssues: Event<readonly IWorkflowIssue[]> = this._onDidChangeIssues.event;
	private pending: readonly IWorkflowIssue[] = [];
	private graphIssues: readonly IWorkflowIssue[] = [];
	private visible = false;
	private stale = true;
	private syncing = false;
	private lastTyped = 0;
	/** The definition the text was last parsed into (or loaded as). */
	private applied: IWorkflowDefinition | undefined;
	private width = 0;
	private height = 0;

	constructor(
		container: HTMLElement,
		private readonly model: WorkflowEditorModel,
		private readonly options: IWorkflowYamlPanelOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModelService modelService: IModelService,
		@ILanguageService languageService: ILanguageService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IUndoRedoService private readonly undoRedo: IUndoRedoService,
	) {
		super();
		this.element = append(container, $('.volt-wfb-yaml'));
		const bar = append(this.element, $('.volt-wfb-yaml-bar'));
		this.status = append(bar, $('.volt-wfb-yaml-status'));
		append(bar, $('span.volt-wfb-spacer'));
		this.barButton(bar, Codicon.listFlat, localize('voltWorkflows.formatYaml', "Format"), localize('voltWorkflows.formatYamlTip', "Rewrite as canonical YAML"), () => this.format());
		this.barButton(bar, Codicon.copy, localize('voltWorkflows.copyYaml', "Copy"), localize('voltWorkflows.copyYamlTip', "Copy the YAML"), button => {
			void this.clipboard.writeText(this.textModel.getValue());
			const label = button.querySelector('.label');
			if (label) {
				label.textContent = localize('voltWorkflows.copied', "Copied");
				getWindow(button).setTimeout(() => label.textContent = localize('voltWorkflows.copyYaml', "Copy"), 1200);
			}
		});
		this.barButton(bar, Codicon.clippy, localize('voltWorkflows.pasteWorkflow', "Paste a workflow"), localize('voltWorkflows.pasteWorkflowTip', "Import YAML from the clipboard or typed in"), () => this.options.onPaste());

		this.editorHost = append(this.element, $('.volt-wfb-yaml-editor'));
		this.editor = this._register(instantiationService.createInstance(CodeEditorWidget, this.editorHost, this.editorOptions(), {
			isSimpleWidget: false,
			contributions: EditorExtensionsRegistry.getEditorContributions(),
		}));
		const uri = URI.from({ scheme: 'volt-workflow-yaml', path: `/${generateUuid()}/${model.definition.id || 'workflow'}.yaml` });
		languageService.requestRichLanguageFeatures('yaml');
		this.textModel = this._register(modelService.createModel(options.initialText ?? serializeWorkflow(model.definition), languageService.createById('yaml'), uri, false));
		this.textModel.updateOptions({ tabSize: 2, indentSize: 2, insertSpaces: true });
		this.editor.setModel(this.textModel);
		this.decorations = this.editor.createDecorationsCollection();
		this.applied = model.definition;
		this.stale = false;

		this._register(this.textModel.onDidChangeContent(() => {
			if (this.syncing) {
				return;
			}
			this.lastTyped = Date.now();
			this.parse.schedule();
		}));
		this._register(this.editor.onDidBlurEditorText(() => {
			// Parse what was typed now, then take whatever changed elsewhere meanwhile.
			if (this.parse.isScheduled()) {
				this.parse.cancel();
				this.parseNow();
			}
			if (this.catchUp.isScheduled()) {
				this.catchUp.cancel();
				this.syncFromModel();
			}
		}));
		this._register(model.onDidChange(change => {
			if (change.source === 'yaml') {
				return;
			}
			if (!this.visible) {
				this.stale = true;
				return;
			}
			if (this.editor.hasTextFocus() && Date.now() - this.lastTyped < TYPING_GRACE_MS) {
				this.catchUp.schedule();
				return;
			}
			this.syncFromModel();
		}));
		this._register(this.configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor')) {
				this.editor.updateOptions(this.editorOptions());
			}
		}));
		this.renderStatus();
	}

	/** Problems keeping the text off the canvas. */
	get pendingIssues(): readonly IWorkflowIssue[] {
		return this.pending;
	}

	/**
	 * The text, when it is exactly what the model holds (the last change came from it, nothing is
	 * pending): saving it instead of re-serializing keeps the user's comments and layout.
	 */
	get syncedText(): string | undefined {
		if (this.pending.length || this.parse.isScheduled() || this.applied !== this.model.definition) {
			return undefined;
		}
		return this.textModel.getValue();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.element.classList.toggle('hidden', !visible);
		if (visible) {
			if (this.stale) {
				this.syncFromModel();
			}
			this.editor.layout({ width: this.width, height: this.height });
		}
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = Math.max(0, height - 36);
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
		// Narrow: the bar's buttons go icon-only (tooltips say what they do), so the status reads.
		this.element.classList.toggle('compact', width < 520);
		if (this.visible) {
			this.editor.layout({ width: this.width, height: this.height });
		}
	}

	focus(): void {
		this.editor.focus();
	}

	/** The graph's issues (validation of the model), drawn as markers while the text is in step. */
	setIssues(issues: readonly IWorkflowIssue[]): void {
		this.graphIssues = issues;
		if (!this.pending.length) {
			this.applyMarkers(issues);
		}
	}

	/** Puts the cursor on an issue's line (or the node's `id:` line). */
	reveal(issue: Pick<IWorkflowIssue, 'line' | 'column' | 'nodeId'>): void {
		const line = issue.line ?? (issue.nodeId ? this.nodeLine(issue.nodeId) : undefined);
		if (!line) {
			return;
		}
		this.editor.revealLineInCenter(line);
		this.editor.setPosition({ lineNumber: line, column: issue.column ?? 1 });
		this.editor.focus();
	}

	private editorOptions(): IEditorConstructionOptions {
		const configured = this.configuration.getValue<IEditorConstructionOptions>('editor', { overrideIdentifier: 'yaml' }) ?? {};
		return {
			...configured,
			ariaLabel: localize('voltWorkflows.yamlAria', "Workflow YAML"),
			wordWrap: 'off',
			minimap: { enabled: false },
			lineNumbers: 'on',
			lineNumbersMinChars: 3,
			glyphMargin: false,
			folding: true,
			scrollBeyondLastLine: false,
			automaticLayout: false,
			fixedOverflowWidgets: true,
			renderLineHighlight: 'line',
			padding: { top: 8, bottom: 8 },
			overviewRulerBorder: false,
			lineDecorationsWidth: 8,
			stickyScroll: { enabled: false },
			fontSize: Math.min(configured.fontSize ?? 12, 13),
			scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: true },
		};
	}

	private barButton(parent: HTMLElement, icon: typeof Codicon.copy, label: string, tooltip: string, run: (button: HTMLButtonElement) => void): void {
		const button = append(parent, $('button.volt-wfb-ghost-button')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(renderIcon(icon));
		append(button, $('span.label')).textContent = label;
		button.setAttribute('aria-label', tooltip);
		setAgentTooltip(button, tooltip);
		this._register(addDisposableListener(button, 'click', () => run(button)));
	}

	private renderStatus(): void {
		clearNode(this.status);
		const errors = this.pending.filter(issue => issue.severity === 'error').length;
		if (errors) {
			this.status.className = 'volt-wfb-yaml-status error';
			this.status.appendChild(renderIcon(Codicon.error));
			append(this.status, $('span')).textContent = errors === 1
				? localize('voltWorkflows.yamlOneError', "1 error: the canvas keeps the last valid version")
				: localize('voltWorkflows.yamlErrors', "{0} errors: the canvas keeps the last valid version", errors);
		} else {
			this.status.className = 'volt-wfb-yaml-status ok';
			this.status.appendChild(renderIcon(Codicon.check));
			append(this.status, $('span')).textContent = localize('voltWorkflows.yamlInSync', "In sync with the canvas");
		}
	}

	/** After a save: the stored text (new revision, comments kept) stands for the saved model. */
	resetText(text: string): void {
		this.replaceText(text);
		this.applied = this.model.definition;
		this.stale = false;
	}

	/** The model's YAML into the editor, as one minimal edit so the cursor and scroll stay put. */
	private syncFromModel(): void {
		this.stale = false;
		this.replaceText(serializeWorkflow(this.model.definition));
		this.applied = this.model.definition;
	}

	private replaceText(next: string): void {
		const current = this.textModel.getValue();
		if (next !== current) {
			let start = 0;
			const max = Math.min(next.length, current.length);
			while (start < max && next.charCodeAt(start) === current.charCodeAt(start)) {
				start++;
			}
			let end = 0;
			while (end < max - start && next.charCodeAt(next.length - 1 - end) === current.charCodeAt(current.length - 1 - end)) {
				end++;
			}
			const from = this.textModel.getPositionAt(start);
			const to = this.textModel.getPositionAt(current.length - end);
			this.syncing = true;
			try {
				this.textModel.applyEdits([{ range: Range.fromPositions(from, to), text: next.slice(start, next.length - end) }]);
			} finally {
				this.syncing = false;
			}
			// The text now follows the model's own undo; Monaco's history of the old text would undo into nonsense.
			this.undoRedo.removeElements(this.textModel.uri);
		}
		this.parse.cancel();
		if (this.pending.length) {
			this.pending = [];
			this._onDidChangeIssues.fire(this.pending);
			this.renderStatus();
		}
		this.applyMarkers(this.graphIssues);
	}

	private parseNow(): void {
		const text = this.textModel.getValue();
		const result = this.options.parse(text);
		// The parse lists syntax and shape issues, then the graph's. Only the first kind keeps the
		// text off the canvas: a node missing a prompt is fine to draw.
		const graph = result.definition ? validateWorkflow(result.definition) : [];
		const key = (issue: IWorkflowIssue) => `${issue.code}|${issue.message}|${issue.nodeId ?? ''}|${issue.field ?? ''}`;
		const graphKeys = new Set(graph.map(key));
		const blocking = result.issues.filter(issue => issue.severity === 'error' && !graphKeys.has(key(issue)));
		this.applyMarkers(result.issues);
		if (!result.definition || blocking.length) {
			this.pending = blocking.length ? blocking : [{ severity: 'error', code: 'yaml-unusable', message: localize('voltWorkflows.yamlUnusable', "This YAML is not a workflow yet."), line: 1 }];
			this._onDidChangeIssues.fire(this.pending);
			this.renderStatus();
			return;
		}
		const hadPending = this.pending.length > 0;
		this.pending = [];
		if (hadPending) {
			this._onDidChangeIssues.fire(this.pending);
		}
		this.renderStatus();
		const current = this.model.definition;
		const lockedId = this.options.lockedId();
		const next: IWorkflowDefinition = {
			...result.definition,
			id: lockedId ?? result.definition.id,
			...(current.revision !== undefined ? { revision: current.revision } : {}),
			...(current.source && !result.definition.source ? { source: current.source } : {}),
		};
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			// One undo step per typing burst, like any other field.
			this.model.apply(localize('voltWorkflows.editYaml', "Edit YAML"), () => next, 'yaml', 'yaml');
		}
		this.applied = this.model.definition;
	}

	/** Canonical YAML of what the canvas holds (drops comments; errors first need fixing). */
	private format(): void {
		if (this.parse.isScheduled()) {
			this.parse.cancel();
			this.parseNow();
		}
		if (!this.pending.length) {
			this.syncFromModel();
		}
	}

	private nodeLine(nodeId: string): number | undefined {
		const pattern = new RegExp(`^\\s*-?\\s*id:\\s*['"]?${nodeId.replace(/[-]/g, '\\-')}['"]?\\s*$`);
		const count = this.textModel.getLineCount();
		for (let line = 1; line <= count; line++) {
			if (pattern.test(this.textModel.getLineContent(line))) {
				return line;
			}
		}
		return undefined;
	}

	/**
	 * Squiggles with the message on hover, and a mark in the overview ruler. Decorations, not
	 * markers: markers would list this scratch text in the window's Problems panel.
	 */
	private applyMarkers(issues: readonly IWorkflowIssue[]): void {
		const count = this.textModel.getLineCount();
		const decorations: IModelDeltaDecoration[] = [];
		for (const issue of issues) {
			const line = issue.line ?? (issue.nodeId ? this.nodeLine(issue.nodeId) : undefined);
			if (!line || line > count) {
				continue;
			}
			const maxColumn = this.textModel.getLineMaxColumn(line);
			const first = this.textModel.getLineFirstNonWhitespaceColumn(line) || 1;
			const startColumn = Math.max(1, Math.min(issue.column ?? first, maxColumn));
			const endColumn = Math.max(startColumn + 1, maxColumn);
			const severity = issue.severity;
			decorations.push({
				range: new Range(line, startColumn, line, endColumn),
				options: {
					description: 'volt-workflow-issue',
					className: severity === 'error' ? 'squiggly-error' : severity === 'warning' ? 'squiggly-warning' : 'squiggly-info',
					hoverMessage: { value: issue.message },
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					overviewRuler: { color: themeColorFromId(severity === 'error' ? overviewRulerError : severity === 'warning' ? overviewRulerWarning : overviewRulerInfo), position: OverviewRulerLane.Right },
				},
			});
		}
		this.decorations.set(decorations);
	}
}
