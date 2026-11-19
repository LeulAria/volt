/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Looking into a request script's run: the detail of one test result (`HttpTestDetail`), the
 * breakpoints in the Scripts editor's gutter (`HttpScriptBreakpoints`) and the stops they
 * recorded (`HttpBreaksPanel`). A script runs in one go in a worker and cannot be paused, so a
 * breakpoint records what was in reach when its line was about to run, and the panel steps
 * through those recordings afterwards (see `common/httpScriptBreakpoints.ts`).
 */

import './media/voltHttpDebug.css';
import { $, addDisposableListener, append, clearNode, EventType, isHTMLButtonElement, isHTMLElement, isKeyboardEvent } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ICodeEditor, MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { httpScriptBreakableLines, snapHttpScriptBreakpoint } from '../common/httpScriptBreakpoints.js';
import { IHttpScriptAssertion, IHttpScriptBreak, IHttpScriptValue } from '../common/httpScriptRuntime.js';
import { createHttpChatIcon } from './voltHttpIcons.js';
import { IHttpExchangeLog, IHttpExchangeTest } from './voltHttpService.js';
import { createHttpIconButton, formatHttpDuration } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

const ROW_HEIGHT = 22;
/** At or above this width the stops and the variables sit side by side. */
const WIDE = 560;
/** The most lines the expected/actual diff compares (beyond, no highlight). */
const MAX_DIFF_LINES = 400;
const MAX_STOPS = 200;

function durationText(ms: number | undefined): string | undefined {
	if (ms === undefined || ms !== ms) {
		return undefined;
	}
	return ms < 1 ? localize('voltHttp.debugUnderMs', "<1 ms") : formatHttpDuration(ms);
}

function outcomeOf(test: IHttpExchangeTest): 'pass' | 'fail' | 'skip' {
	return test.skipped ? 'skip' : test.passed ? 'pass' : 'fail';
}

function outcomeLabel(outcome: 'pass' | 'fail' | 'skip'): string {
	switch (outcome) {
		case 'pass': return localize('voltHttp.debugPass', "PASS");
		case 'fail': return localize('voltHttp.debugFail', "FAIL");
		case 'skip': return localize('voltHttp.debugSkip', "SKIP");
	}
}

/**
 * Which lines of `a` and `b` are not in their longest common run of lines: those are marked in a
 * multi-line Expected / Actual pair. Undefined when either side is too long to compare.
 */
function lineDiff(a: readonly string[], b: readonly string[]): { a: boolean[]; b: boolean[] } | undefined {
	if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
		return undefined;
	}
	const rows = a.length + 1;
	const cols = b.length + 1;
	const table = new Uint16Array(rows * cols);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
		}
	}
	const changedA = a.map(() => true);
	const changedB = b.map(() => true);
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			changedA[i++] = false;
			changedB[j++] = false;
		} else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return { a: changedA, b: changedB };
}

// --- The detail of one test result -------------------------------------------------------------------

export interface IHttpTestDetailOptions {
	/** The 1-based line the test is declared on ("Go to Test"). */
	readonly line?: number;
	/** The run's console lines: the ones logged while this test ran are shown. */
	readonly logs?: readonly IHttpExchangeLog[];
	/** Shows a line of the script (Go to Test, the failure's "line N"). */
	readonly onReveal?: (line: number) => void;
	readonly onRun?: () => void;
	readonly onAddToChat?: (text: string) => void;
	readonly onClose: () => void;
}

interface IAssertionTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly message: HTMLElement;
}

interface ILogTemplate {
	readonly row: HTMLElement;
	readonly level: HTMLElement;
	readonly text: HTMLElement;
}

/**
 * What one test did, under its row in Test Results: outcome, duration, the failure with Expected
 * and Actual side by side (stacked when narrow), every assertion it made, and its console lines.
 * The panel scrolls inside itself; Escape closes it.
 */
export class HttpTestDetail extends Disposable {

	readonly element: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly test: IHttpExchangeTest,
		private readonly options: IHttpTestDetailOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		const outcome = outcomeOf(test);
		const root = this.element = append(parent, $(`.volt-http-debug-detail.${outcome}`));
		root.tabIndex = -1;
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', localize('voltHttp.debugDetailAria', "Test {0}: {1}", test.name, outcomeLabel(outcome)));
		this._register({ dispose: () => root.remove() });
		this._register(addDisposableListener(root, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				options.onClose();
			}
		}));

		// Head: outcome, name, duration, actions.
		const head = append(root, $('.volt-http-debug-detail-head'));
		append(head, $(`span.volt-http-test-badge.${outcome}`)).textContent = outcomeLabel(outcome);
		const name = append(head, $('span.volt-http-debug-detail-name'));
		name.textContent = test.name;
		setAgentTooltip(name, test.name);
		const duration = durationText(test.durationMs);
		if (duration) {
			const time = append(head, $('span.volt-http-debug-muted'));
			time.textContent = duration;
			setAgentTooltip(time, localize('voltHttp.debugDurationTitle', "How long the test's body ran"));
		}
		append(head, $('span.volt-http-debug-spacer'));
		const actions = append(head, $('.volt-http-debug-actions'));
		if (options.onRun) {
			const run = options.onRun;
			createHttpIconButton(actions, Codicon.play, localize('voltHttp.debugRunTest', "Run Test"), () => run());
		}
		if (options.onReveal && options.line !== undefined) {
			const reveal = options.onReveal;
			const line = options.line;
			createHttpIconButton(actions, Codicon.goToFile, localize('voltHttp.debugGoToTest', "Go to Test"), () => reveal(line));
		}
		createHttpIconButton(actions, Codicon.copy, localize('voltHttp.debugCopyText', "Copy as Text"), () => void this.clipboardService.writeText(this.asText()));
		if (options.onAddToChat) {
			const add = options.onAddToChat;
			createHttpIconButton(actions, () => createHttpChatIcon(14), localize('voltHttp.debugAddToChat', "Add to Chat"), () => add(this.asText()));
		}
		createHttpIconButton(actions, Codicon.close, localize('voltHttp.debugClose', "Close"), () => options.onClose());

		const body = append(root, $('.volt-http-debug-detail-body'));
		const failed = outcome === 'fail';
		const errorLine = test.errorLine;
		if (failed && test.error) {
			const message = append(body, $('.volt-http-debug-message'));
			message.appendChild(renderIcon(Codicon.error));
			append(message, $('span.volt-http-debug-message-text')).textContent = test.error;
		}
		if (failed && (test.expected !== undefined || test.actual !== undefined)) {
			this.renderCompare(body, test.expected, test.actual);
		}
		if (errorLine !== undefined && options.onReveal) {
			const reveal = options.onReveal;
			const link = append(body, $('button.volt-http-link.volt-http-debug-line-link')) as HTMLButtonElement;
			link.type = 'button';
			link.textContent = localize('voltHttp.debugLineN', "line {0}", errorLine);
			setAgentTooltip(link, localize('voltHttp.debugLineTitle', "Show line {0} of the script, where the test failed", errorLine));
			link.addEventListener('click', () => reveal(errorLine));
		}

		const assertions = test.assertions ?? [];
		if (assertions.length) {
			const label = append(body, $('.volt-http-sublabel.volt-http-debug-section'));
			label.textContent = test.assertionCount && test.assertionCount > assertions.length
				? localize('voltHttp.debugAssertionsSome', "Assertions (first {0} of {1})", assertions.length, test.assertionCount)
				: localize('voltHttp.debugAssertions', "Assertions ({0})", assertions.length);
			this.renderAssertions(body, assertions);
		}
		const logs = (options.logs ?? []).filter(log => log.test === test.name);
		if (logs.length) {
			append(body, $('.volt-http-sublabel.volt-http-debug-section')).textContent = localize('voltHttp.debugConsole', "Console ({0})", logs.length);
			this.renderLogs(body, logs);
		}
		if (!(failed && test.error) && !assertions.length && !logs.length && test.expected === undefined && test.actual === undefined) {
			append(body, $('.volt-http-debug-empty')).textContent = outcome === 'skip'
				? localize('voltHttp.debugSkipped', "This test was skipped.")
				: localize('voltHttp.debugNoAssertions', "This test made no assertions.");
		}
	}

	focus(): void {
		this.element.focus();
	}

	private renderCompare(parent: HTMLElement, expected: string | undefined, actual: string | undefined): void {
		const compare = append(parent, $('.volt-http-debug-compare'));
		const multi = expected !== undefined && actual !== undefined && (expected.includes('\n') || actual.includes('\n'));
		const expectedLines = (expected ?? '').split('\n');
		const actualLines = (actual ?? '').split('\n');
		const diff = multi ? lineDiff(expectedLines, actualLines) : undefined;
		const side = (label: string, lines: readonly string[] | undefined, changed: boolean[] | undefined, kind: 'expected' | 'actual') => {
			const column = append(compare, $(`.volt-http-debug-side.${kind}`));
			append(column, $('.volt-http-debug-side-label')).textContent = label;
			const block = append(column, $('pre.volt-http-debug-code'));
			if (!lines) {
				append(block, $('span.volt-http-debug-muted')).textContent = localize('voltHttp.debugNotKnown', "(not known)");
				return;
			}
			lines.forEach((line, index) => {
				const row = append(block, $('span.volt-http-debug-code-line'));
				row.textContent = line || ' ';
				if (changed?.[index]) {
					row.classList.add(kind === 'expected' ? 'removed' : 'added');
				}
			});
		};
		side(localize('voltHttp.debugExpected', "Expected"), expected === undefined ? undefined : expectedLines, diff?.a, 'expected');
		side(localize('voltHttp.debugActual', "Actual"), actual === undefined ? undefined : actualLines, diff?.b, 'actual');
	}

	private renderAssertions(parent: HTMLElement, assertions: readonly IHttpScriptAssertion[]): void {
		const host = append(parent, $('.volt-http-debug-rows'));
		const renderer: IListRenderer<IHttpScriptAssertion, IAssertionTemplate> = {
			templateId: 'assertion',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-debug-row'));
				return { row, icon: append(row, $('span.volt-http-debug-tick')), message: append(row, $('span.volt-http-debug-row-text')) };
			},
			renderElement: (assertion, _index, template) => {
				clearNode(template.icon);
				template.icon.appendChild(renderIcon(assertion.passed ? Codicon.check : Codicon.close));
				template.icon.className = `volt-http-debug-tick ${assertion.passed ? 'pass' : 'fail'}`;
				template.message.textContent = assertion.message;
				const values = [assertion.operator, assertion.expected !== undefined ? `expected ${assertion.expected}` : undefined, assertion.actual !== undefined ? `actual ${assertion.actual}` : undefined].filter(item => !!item);
				setAgentTooltip(template.row, values.length ? `${assertion.message}\n${values.join('\n')}` : assertion.message);
			},
			disposeTemplate: () => { },
		};
		const list = this._register(this.instantiationService.createInstance(WorkbenchList<IHttpScriptAssertion>, 'VoltHttpTestAssertions', host, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'assertion' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: assertion => `${assertion.passed ? localize('voltHttp.debugAssertPassed', "passed") : localize('voltHttp.debugAssertFailed', "failed")}: ${assertion.message}`,
				getWidgetAriaLabel: () => localize('voltHttp.debugAssertionsAria', "Assertions"),
			},
			multipleSelectionSupport: false,
		}));
		this._register(list.onDidOpen(event => event.element && void this.clipboardService.writeText(event.element.message)));
		this.sizeList(host, list, assertions);
	}

	private renderLogs(parent: HTMLElement, logs: readonly IHttpExchangeLog[]): void {
		const host = append(parent, $('.volt-http-debug-rows'));
		const renderer: IListRenderer<IHttpExchangeLog, ILogTemplate> = {
			templateId: 'log',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-debug-row.log'));
				return { row, level: append(row, $('span.volt-http-debug-tick')), text: append(row, $('span.volt-http-debug-row-text.code')) };
			},
			renderElement: (log, _index, template) => {
				clearNode(template.level);
				const icon = log.level === 'error' ? Codicon.error : log.level === 'warn' ? Codicon.warning : log.level === 'info' ? Codicon.info : Codicon.chevronRight;
				template.level.appendChild(renderIcon(icon));
				template.level.className = `volt-http-debug-tick ${log.level}`;
				template.text.textContent = log.text.replace(/\s*\n\s*/g, ' ');
				setAgentTooltip(template.row, log.text);
			},
			disposeTemplate: () => { },
		};
		const list = this._register(this.instantiationService.createInstance(WorkbenchList<IHttpExchangeLog>, 'VoltHttpTestLogs', host, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'log' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: log => `${log.level}: ${log.text}`,
				getWidgetAriaLabel: () => localize('voltHttp.debugConsoleAria', "Console lines of this test"),
			},
			multipleSelectionSupport: false,
		}));
		this._register(list.onDidOpen(event => event.element && void this.clipboardService.writeText(event.element.text)));
		this.sizeList(host, list, logs);
	}

	/** Every row shown: the panel scrolls, not the list. */
	private sizeList<T>(host: HTMLElement, list: WorkbenchList<T>, items: readonly T[]): void {
		const height = items.length * ROW_HEIGHT;
		host.style.height = `${height}px`;
		list.layout(height);
		list.splice(0, 0, [...items]);
	}

	/** The result as plain text, for the clipboard or a chat. */
	private asText(): string {
		const test = this.test;
		const outcome = outcomeOf(test);
		const lines = [`${outcomeLabel(outcome)} ${test.name}${test.durationMs !== undefined ? ` (${durationText(test.durationMs)})` : ''}`];
		if (this.options.line !== undefined) {
			lines.push(`Declared on line ${this.options.line} of the script`);
		}
		if (test.error && outcome === 'fail') {
			lines.push(`Error: ${test.error}${test.errorLine !== undefined ? ` (line ${test.errorLine})` : ''}`);
		}
		if (test.expected !== undefined) {
			lines.push('Expected:', test.expected);
		}
		if (test.actual !== undefined) {
			lines.push('Actual:', test.actual);
		}
		if (test.assertions?.length) {
			lines.push('Assertions:', ...test.assertions.map(item => `  [${item.passed ? 'pass' : 'fail'}] ${item.message}`));
			if (test.assertionCount && test.assertionCount > test.assertions.length) {
				lines.push(`  (${test.assertionCount - test.assertions.length} more)`);
			}
		}
		const logs = (this.options.logs ?? []).filter(log => log.test === test.name);
		if (logs.length) {
			lines.push('Console:', ...logs.map(log => `  [${log.level}] ${log.text}`));
		}
		return lines.join('\n');
	}
}

// --- Breakpoints in the Scripts editor -----------------------------------------------------------------

const BREAKPOINT_DECORATION = ModelDecorationOptions.register({
	description: 'volt-http-breakpoint',
	glyphMarginClassName: `${ThemeIcon.asClassName(Codicon.debugBreakpoint)} volt-http-debug-breakpoint`,
	glyphMarginHoverMessage: { value: localize('voltHttp.debugBreakpointHover', "Breakpoint: records the variables each time this line is about to run. Click to remove.") },
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	zIndex: 5,
});
const HINT_DECORATION = ModelDecorationOptions.register({
	description: 'volt-http-breakpoint-hint',
	glyphMarginClassName: `${ThemeIcon.asClassName(Codicon.debugBreakpoint)} volt-http-debug-breakpoint-hint`,
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	zIndex: 1,
});
const STOP_DECORATION = ModelDecorationOptions.register({
	description: 'volt-http-breakpoint-stop',
	glyphMarginClassName: `${ThemeIcon.asClassName(Codicon.debugStackframe)} volt-http-debug-stop-glyph`,
	className: 'volt-http-debug-stop-line',
	isWholeLine: true,
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	zIndex: 10,
});

function at(line: number): IModelDeltaDecoration['range'] {
	return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
}

/**
 * Breakpoints in a script editor's glyph margin: a click toggles one (it lands on the nearest line
 * a statement begins on, as the run will), a faint dot shows where a click would put one, and the
 * dots stay with their text while it is edited. `showStop` marks the line of a recorded stop the
 * way VS Code's debugger marks the current frame.
 */
export class HttpScriptBreakpoints extends Disposable {

	private readonly breakpoints: IEditorDecorationsCollection;
	private readonly hint: IEditorDecorationsCollection;
	private readonly stop: IEditorDecorationsCollection;
	private breakable: number[] | undefined;
	private reported: number[];
	private stopLine: number | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		initial: readonly number[],
		private readonly onChange: (lines: number[]) => void,
	) {
		super();
		this.breakpoints = editor.createDecorationsCollection();
		this.hint = editor.createDecorationsCollection();
		this.stop = editor.createDecorationsCollection();
		this._register({ dispose: () => { this.breakpoints.clear(); this.hint.clear(); this.stop.clear(); } });
		editor.updateOptions({ glyphMargin: true });
		this.reported = [...new Set(initial.map(Number).filter(line => line >= 1))].sort((a, b) => a - b);
		this.apply(this.reported);

		this._register(editor.onDidChangeModelContent(() => {
			this.breakable = undefined;
			this.hint.clear();
			this.report();
		}));
		this._register(editor.onDidChangeModel(() => {
			this.breakable = undefined;
			this.apply(this.reported);
			this.showStop(this.stopLine);
		}));
		this._register(editor.onMouseDown(event => {
			if (event.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN || !event.event.leftButton || !event.target.position) {
				return;
			}
			event.event.preventDefault();
			this.toggle(event.target.position.lineNumber);
		}));
		this._register(editor.onMouseMove(event => {
			const line = event.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN ? event.target.position?.lineNumber : undefined;
			const target = line === undefined ? undefined : this.lines.includes(line) ? undefined : snapHttpScriptBreakpoint(this.breakableLines(), line);
			if (target === undefined || this.lines.includes(target)) {
				this.hint.clear();
			} else {
				this.hint.set([{ range: at(target), options: HINT_DECORATION }]);
			}
		}));
		this._register(editor.onMouseLeave(() => this.hint.clear()));
	}

	/** The breakpoints' lines now, ascending. */
	get lines(): number[] {
		const lines = new Set<number>();
		for (const range of this.breakpoints.getRanges()) {
			lines.add(range.startLineNumber);
		}
		return [...lines].sort((a, b) => a - b);
	}

	/** Replaces the breakpoints (no `onChange`). */
	setLines(lines: readonly number[]): void {
		this.apply(lines);
		this.reported = this.lines;
	}

	/** Marks `line` as the stop being looked at and scrolls to it; undefined clears the mark. */
	showStop(line: number | undefined): void {
		this.stopLine = line;
		const model = this.editor.getModel();
		if (line === undefined || !model || line < 1 || line > model.getLineCount()) {
			this.stop.clear();
			return;
		}
		this.stop.set([{ range: at(line), options: STOP_DECORATION }]);
		this.editor.revealLineInCenterIfOutsideViewport(line);
	}

	private apply(lines: readonly number[]): void {
		const model = this.editor.getModel();
		const count = model ? model.getLineCount() : 0;
		const kept = [...new Set(lines.map(Number))].filter(line => line >= 1 && line <= count).sort((a, b) => a - b);
		this.breakpoints.set(kept.map(line => ({ range: at(line), options: BREAKPOINT_DECORATION })));
	}

	private breakableLines(): number[] {
		if (!this.breakable) {
			this.breakable = httpScriptBreakableLines(this.editor.getModel()?.getValue() ?? '');
		}
		return this.breakable;
	}

	private toggle(line: number): void {
		const current = this.lines;
		let next: number[];
		if (current.includes(line)) {
			next = current.filter(item => item !== line);
		} else {
			const target = snapHttpScriptBreakpoint(this.breakableLines(), line);
			if (target === undefined) {
				return;
			}
			next = current.includes(target) ? current.filter(item => item !== target) : [...current, target];
		}
		this.hint.clear();
		this.apply(next);
		this.report();
	}

	/** Tells `onChange` when the lines moved (an edit) or changed (a click). */
	private report(): void {
		const lines = this.lines;
		if (lines.length !== this.reported.length || lines.some((line, index) => line !== this.reported[index])) {
			this.reported = lines;
			this.onChange([...lines]);
		}
	}
}

// --- The recorded stops --------------------------------------------------------------------------------

export interface IHttpBreaksPanelOptions {
	/** The stop shown first (0 when not given). */
	readonly selected?: number;
	/** A stop was chosen (also called for the first one shown). */
	readonly onSelect: (stop: IHttpScriptBreak, index: number) => void;
	readonly onClose: () => void;
}

type VariableNode =
	| { readonly kind: 'scope'; readonly id: string; readonly name: string; readonly count: number }
	| { readonly kind: 'value'; readonly id: string; readonly value: IHttpScriptValue };

interface IStopTemplate {
	readonly order: HTMLElement;
	readonly line: HTMLElement;
	readonly test: HTMLElement;
	readonly hit: HTMLElement;
}

interface IVariableTemplate {
	readonly row: HTMLElement;
	readonly name: HTMLElement;
	readonly separator: HTMLElement;
	readonly value: HTMLElement;
	readonly copy: HTMLButtonElement;
	node?: VariableNode;
}

function valueClass(value: IHttpScriptValue): string {
	switch (value.type) {
		case 'string': return 'string';
		case 'number':
		case 'bigint': return 'number';
		case 'boolean': return 'boolean';
		case 'uninitialised': return 'unset';
		case 'null':
		case 'undefined':
		case 'more': return 'plain';
		default: return 'value';
	}
}

/** A value as text to paste: JSON-like for what has children, the preview for the rest. */
function valueText(value: IHttpScriptValue, indent = ''): string {
	const children = (value.children ?? []).filter(child => child.type !== 'more');
	if (!children.length) {
		return value.preview;
	}
	const inner = `${indent}  `;
	if (value.type === 'array' || value.type === 'Set') {
		return `[\n${children.map(child => `${inner}${valueText(child, inner)}`).join(',\n')}\n${indent}]`;
	}
	return `{\n${children.map(child => `${inner}${JSON.stringify(child.name)}: ${valueText(child, inner)}`).join(',\n')}\n${indent}}`;
}

/**
 * The stops a script's breakpoints recorded: which one is shown (Previous / Next / First / Last,
 * F10 and Shift+F10, arrow keys), the list of stops, and the variables of the shown one as a tree
 * (scopes at the top, "Local" open). Side by side from 560px, stacked below.
 */
export class HttpBreaksPanel extends Disposable {

	readonly element: HTMLElement;
	private readonly title: HTMLElement;
	private readonly where: HTMLElement;
	private readonly testName: HTMLElement;
	private readonly buttons: { first?: HTMLButtonElement; previous?: HTMLButtonElement; next?: HTMLButtonElement; last?: HTMLButtonElement } = {};
	private readonly body: HTMLElement;
	private readonly listHost: HTMLElement | undefined;
	private readonly treeHost: HTMLElement | undefined;
	private readonly list: WorkbenchList<IHttpScriptBreak> | undefined;
	private readonly tree: WorkbenchObjectTree<VariableNode> | undefined;
	/** Nodes opened by the user, kept open from one stop to the next. */
	private readonly expanded = new Set<string>(['scope:Local']);
	private selected = -1;

	constructor(
		parent: HTMLElement,
		private readonly breaks: readonly IHttpScriptBreak[],
		private readonly options: IHttpBreaksPanelOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super();
		const root = this.element = append(parent, $('.volt-http-debug-breaks'));
		root.tabIndex = 0;
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', localize('voltHttp.debugBreaksAria', "Recorded breakpoint stops"));
		this._register({ dispose: () => root.remove() });

		const head = append(root, $('.volt-http-debug-breaks-head'));
		const icon = append(head, $('span.volt-http-debug-head-icon'));
		icon.appendChild(renderIcon(Codicon.debugStackframe));
		this.title = append(head, $('span.volt-http-debug-breaks-title'));
		this.where = append(head, $('span.volt-http-debug-muted'));
		this.testName = append(head, $('span.volt-http-debug-breaks-test'));
		append(head, $('span.volt-http-debug-spacer'));
		const actions = append(head, $('.volt-http-debug-actions'));
		if (breaks.length) {
			this.buttons.first = createHttpIconButton(actions, Codicon.debugReverseContinue, localize('voltHttp.debugFirst', "First Stop"), () => this.select(0));
			this.buttons.previous = createHttpIconButton(actions, Codicon.debugStepBack, localize('voltHttp.debugPrevious', "Previous Stop (Shift+F10)"), () => this.select(this.selected - 1));
			this.buttons.next = createHttpIconButton(actions, Codicon.debugStepOver, localize('voltHttp.debugNext', "Next Stop (F10)"), () => this.select(this.selected + 1));
			this.buttons.last = createHttpIconButton(actions, Codicon.debugContinue, localize('voltHttp.debugLast', "Last Stop"), () => this.select(this.breaks.length - 1));
		}
		createHttpIconButton(actions, Codicon.close, localize('voltHttp.debugCloseStops', "Close"), () => options.onClose());

		const note = append(root, $('.volt-http-debug-note'));
		note.textContent = breaks.length >= MAX_STOPS
			? localize('voltHttp.debugNoteCapped', "Recorded while the script ran. The script does not pause. Only the first {0} stops were kept.", MAX_STOPS)
			: localize('voltHttp.debugNote', "Recorded while the script ran. The script does not pause.");

		this.body = append(root, $('.volt-http-debug-breaks-body'));
		this._register(addDisposableListener(root, EventType.KEY_DOWN, (event: KeyboardEvent) => this.onKey(event)));

		if (!breaks.length) {
			this.title.textContent = localize('voltHttp.debugNoStops', "No stops");
			const empty = append(this.body, $('.volt-http-debug-empty.centered'));
			empty.textContent = localize('voltHttp.debugNoneReached', "No breakpoint was reached: the lines with breakpoints did not run. Set one on a line that runs and send again.");
			return;
		}

		// The stops.
		const listHost = this.listHost = append(this.body, $('.volt-http-debug-stops'));
		const stopRenderer: IListRenderer<IHttpScriptBreak, IStopTemplate> = {
			templateId: 'stop',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-debug-stop-row'));
				return {
					order: append(row, $('span.volt-http-debug-stop-order')),
					line: append(row, $('span.volt-http-debug-stop-line-label')),
					test: append(row, $('span.volt-http-debug-stop-test')),
					hit: append(row, $('span.volt-http-debug-muted.volt-http-debug-stop-hit')),
				};
			},
			renderElement: (stop, _index, template) => {
				template.order.textContent = String(stop.order);
				template.line.textContent = localize('voltHttp.debugLine', "line {0}", stop.line);
				template.test.textContent = stop.test ?? '';
				setAgentTooltip(template.test, stop.test ?? '');
				template.hit.textContent = stop.hit > 1 ? localize('voltHttp.debugHit', "hit {0}", stop.hit) : '';
			},
			disposeTemplate: () => { },
		};
		const list = this.list = this._register(this.instantiationService.createInstance(WorkbenchList<IHttpScriptBreak>, 'VoltHttpScriptStops', listHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'stop' }, [stopRenderer], {
			accessibilityProvider: {
				getAriaLabel: stop => stop.test
					? localize('voltHttp.debugStopAriaTest', "Stop {0}, line {1}, hit {2}, in test {3}", stop.order, stop.line, stop.hit, stop.test)
					: localize('voltHttp.debugStopAria', "Stop {0}, line {1}, hit {2}", stop.order, stop.line, stop.hit),
				getWidgetAriaLabel: () => localize('voltHttp.debugStopsAria', "Stops"),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: stop => String(stop.order) },
		}));
		this._register(list.onDidOpen(event => {
			if (event.element) {
				this.select(this.breaks.indexOf(event.element));
			}
		}));
		this._register(list.onDidChangeFocus(event => {
			// Arrow keys in the list move to that stop as well.
			if (isKeyboardEvent(event.browserEvent) && event.indexes.length) {
				this.select(event.indexes[0]);
			}
		}));

		// The variables of the shown stop.
		const treeHost = this.treeHost = append(this.body, $('.volt-http-debug-variables'));
		const delegate = { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'variable' };
		const renderer: ITreeRenderer<VariableNode, void, IVariableTemplate> = {
			templateId: 'variable',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-debug-var-row'));
				const template: IVariableTemplate = {
					row,
					name: append(row, $('span.volt-http-debug-var-name')),
					separator: append(row, $('span.volt-http-debug-var-sep')),
					value: append(row, $('span.volt-http-debug-var-value')),
					copy: createHttpIconButton(row, Codicon.copy, localize('voltHttp.debugCopyValue', "Copy Value"), () => {
						if (template.node) {
							this.copy(template.node);
						}
					}),
				};
				template.copy.classList.add('volt-http-debug-var-copy');
				return template;
			},
			renderElement: (node: ITreeNode<VariableNode, void>, _index, template) => {
				const element = node.element;
				template.node = element;
				if (element.kind === 'scope') {
					template.row.classList.add('scope');
					template.name.textContent = element.name;
					template.separator.textContent = '';
					template.value.className = 'volt-http-debug-var-value plain';
					template.value.textContent = element.count ? '' : localize('voltHttp.debugScopeEmpty', "empty");
					setAgentTooltip(template.row, element.name);
					template.copy.style.display = 'none';
				} else {
					const value = element.value;
					template.row.classList.remove('scope');
					template.name.textContent = value.name;
					template.separator.textContent = value.type === 'more' ? '' : ': ';
					template.value.className = `volt-http-debug-var-value ${valueClass(value)}`;
					template.value.textContent = value.preview;
					setAgentTooltip(template.row, value.type === 'more' ? value.preview : `${value.name}: ${value.type}`);
					template.copy.style.display = value.type === 'more' ? 'none' : '';
				}
			},
			disposeTemplate: () => { },
		};
		const tree = this.tree = this._register(this.instantiationService.createInstance(WorkbenchObjectTree<VariableNode>, 'VoltHttpScriptVariables', treeHost, delegate, [renderer], {
			accessibilityProvider: {
				getAriaLabel: node => node.kind === 'scope' ? node.name : `${node.value.name}: ${node.value.preview}, ${node.value.type}`,
				getWidgetAriaLabel: () => localize('voltHttp.debugVariablesAria', "Variables at this stop"),
			},
			identityProvider: { getId: node => node.id },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			indent: 10,
		}));
		this._register(tree.onMouseDblClick(event => {
			if (event.element) {
				this.copy(event.element);
			}
		}));
		this._register(tree.onDidChangeCollapseState(event => {
			const node = event.node.element;
			if (node) {
				if (event.node.collapsed) {
					this.expanded.delete(node.id);
				} else {
					this.expanded.add(node.id);
				}
			}
		}));

		list.splice(0, 0, [...breaks]);
		this.select(Math.max(0, Math.min(breaks.length - 1, options.selected ?? 0)));
	}

	/** Sizes the stops and the variables: side by side from 560px wide, the stops above the variables below. */
	layout(width: number, height: number): void {
		const wide = width >= WIDE;
		this.element.classList.toggle('wide', wide);
		this.element.style.height = `${Math.max(0, height)}px`;
		if (!this.list || !this.tree || !this.listHost || !this.treeHost) {
			return;
		}
		const bodyHeight = Math.max(ROW_HEIGHT * 2, height - this.body.offsetTop);
		if (wide) {
			const listWidth = Math.round(Math.max(180, Math.min(300, width * 0.32)));
			this.listHost.style.width = `${listWidth}px`;
			this.listHost.style.height = `${bodyHeight}px`;
			this.treeHost.style.height = `${bodyHeight}px`;
			this.list.layout(bodyHeight, listWidth);
			this.tree.layout(bodyHeight, Math.max(0, width - listWidth - 1));
		} else {
			const listHeight = Math.min(this.breaks.length, 4) * ROW_HEIGHT;
			const treeHeight = Math.max(ROW_HEIGHT * 2, bodyHeight - listHeight - 1);
			this.listHost.style.width = '';
			this.listHost.style.height = `${listHeight}px`;
			this.treeHost.style.height = `${treeHeight}px`;
			this.list.layout(listHeight, width);
			this.tree.layout(treeHeight, width);
		}
		if (this.selected >= 0) {
			this.list.reveal(this.selected);
		}
	}

	focus(): void {
		this.element.focus();
	}

	private select(index: number): void {
		if (!this.breaks.length || !this.list || !this.tree) {
			return;
		}
		const next = Math.max(0, Math.min(this.breaks.length - 1, index));
		if (next === this.selected) {
			return;
		}
		this.selected = next;
		const stop = this.breaks[next];
		this.title.textContent = localize('voltHttp.debugStopOf', "Stop {0} of {1}", next + 1, this.breaks.length);
		this.where.textContent = localize('voltHttp.debugLine', "line {0}", stop.line);
		this.testName.textContent = stop.test ?? '';
		setAgentTooltip(this.testName, stop.test ? localize('voltHttp.debugInTest', "In test \"{0}\"", stop.test) : '');
		const atStart = next === 0;
		const atEnd = next === this.breaks.length - 1;
		for (const [button, disabled] of [[this.buttons.first, atStart], [this.buttons.previous, atStart], [this.buttons.next, atEnd], [this.buttons.last, atEnd]] as const) {
			if (button) {
				button.disabled = disabled;
			}
		}
		this.list.setSelection([next]);
		this.list.setFocus([next]);
		this.list.reveal(next);
		this.tree.setChildren(null, stop.scopes.map((scope): IObjectTreeElement<VariableNode> => {
			const id = `scope:${scope.name}`;
			return {
				element: { kind: 'scope', id, name: scope.name, count: scope.variables.length },
				collapsible: scope.variables.length > 0,
				collapsed: !this.expanded.has(id),
				children: this.valueElements(scope.variables, id),
			};
		}));
		this.options.onSelect(stop, next);
	}

	private valueElements(values: readonly IHttpScriptValue[], parentId: string): IObjectTreeElement<VariableNode>[] {
		return values.map((value, index) => {
			const id = `${parentId}/${value.type === 'more' ? `more${index}` : value.name}`;
			const children = value.children ?? [];
			return {
				element: { kind: 'value', id, value },
				collapsible: children.length > 0,
				collapsed: !this.expanded.has(id),
				children: children.length ? this.valueElements(children, id) : undefined,
			};
		});
	}

	private copy(node: VariableNode): void {
		if (node.kind === 'scope') {
			return;
		}
		void this.clipboardService.writeText(valueText(node.value));
	}

	private onKey(event: KeyboardEvent): void {
		if (!this.breaks.length) {
			if (event.key === 'Escape') {
				event.preventDefault();
				this.options.onClose();
			}
			return;
		}
		const inWidget = isHTMLElement(event.target) && !!event.target.closest('.monaco-list');
		let to: number | undefined;
		if (event.key === 'F10') {
			to = event.shiftKey ? this.selected - 1 : this.selected + 1;
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			this.options.onClose();
			return;
		} else if (!inWidget && !(isHTMLButtonElement(event.target) && (event.key === 'Enter' || event.key === ' '))) {
			switch (event.key) {
				case 'ArrowDown':
				case 'ArrowRight': to = this.selected + 1; break;
				case 'ArrowUp':
				case 'ArrowLeft': to = this.selected - 1; break;
				case 'Home': to = 0; break;
				case 'End': to = this.breaks.length - 1; break;
			}
		}
		if (to !== undefined) {
			event.preventDefault();
			event.stopPropagation();
			this.select(to);
		}
	}
}
