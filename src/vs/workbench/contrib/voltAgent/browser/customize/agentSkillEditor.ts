/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSkillEditor.css';
import { $, addDisposableListener, append, clearNode, Dimension, EventType, getActiveElement, getWindow, isHTMLElement, isHTMLInputElement } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { Action, IAction, Separator } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorExtensionsRegistry } from '../../../../../editor/browser/editorExtensions.js';
import { IEditorOptions as ICodeEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { DEFAULT_EDITOR_ASSOCIATION, IEditorControl, IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { enabledProfileIds, isPickerModelVisible } from '../../../../services/voltRuntime/common/models/modelVisibility.js';
import { createModeIcon, createStrokeIcon } from '../chrome/agentModeIcons.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { AgentCustomizationKind, AgentRuleMode, ruleModeOf } from './agentCustomize.js';
import { frontmatterEntry, frontmatterValue, IFrontmatterDocument, IFrontmatterEntry, isTruthy, parseFrontmatterDocument, serializeFrontmatterDocument, withFrontmatterValue } from './agentFrontmatter.js';
import { activeFormats, applyFormat, IRenderedMarkdown, MarkdownFormat, rebaseEditableMarkdown, renderEditableMarkdown, serializeEditableMarkdown } from './agentMarkdownWysiwyg.js';
import { AGENT_SKILL_EDITOR_ID, AgentSkillEditorInput } from './agentSkillEditorInput.js';

type EditorMode = 'preview' | 'source';

const MODE_STORAGE_PREFIX = 'volt.skillEditor.mode.';
const BODY_WRITE_DELAY_MS = 150;
const RENDER_DELAY_MS = 60;
const ADD_SELECTION_TO_CHAT_COMMAND_ID = 'workbench.action.voltAgent.addSelectionToChat';

/** Front matter keys the subagent form shows as fields instead of rows. */
const SUBAGENT_FIELDS = new Set(['name', 'model', 'description', 'readonly', 'is_background']);

interface IRuleModeOption {
	readonly mode: AgentRuleMode;
	readonly label: string;
	readonly description: string;
}

const RULE_MODES: readonly IRuleModeOption[] = [
	{ mode: 'always', label: localize('voltSkillEditor.rule.always', "Always Apply"), description: localize('voltSkillEditor.rule.alwaysDesc', "Apply to every chat and cmd-k session") },
	{ mode: 'intelligent', label: localize('voltSkillEditor.rule.intelligent', "Apply Intelligently"), description: localize('voltSkillEditor.rule.intelligentDesc', "When Agent decides it's relevant based on description") },
	{ mode: 'files', label: localize('voltSkillEditor.rule.files', "Apply to Specific Files"), description: localize('voltSkillEditor.rule.filesDesc', "When file matches a specified pattern") },
	{ mode: 'manual', label: localize('voltSkillEditor.rule.manual', "Apply Manually"), description: localize('voltSkillEditor.rule.manualDesc', "When @-mentioned") },
];

interface IModelChoice {
	readonly id: string;
	readonly label: string;
}

const FALLBACK_MODELS: readonly IModelChoice[] = [
	{ id: 'fast', label: 'Fast' },
	{ id: 'sonnet', label: 'Claude Sonnet' },
	{ id: 'opus', label: 'Claude Opus' },
	{ id: 'haiku', label: 'Claude Haiku' },
];

interface IToolbarButton {
	readonly format: MarkdownFormat | 'chat';
	readonly label: string;
	readonly icon: () => HTMLElement;
}

const TOOLBAR_GROUPS: readonly (readonly IToolbarButton[])[] = [
	[{ format: 'chat', label: localize('voltSkillEditor.addToChat', "Add to Chat"), icon: () => createModeIcon('agent') }],
	[
		{ format: 'bold', label: localize('voltSkillEditor.bold', "Bold"), icon: () => createStrokeIcon('fmt-bold', ['M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8']) },
		{ format: 'italic', label: localize('voltSkillEditor.italic', "Italic"), icon: () => createStrokeIcon('fmt-italic', ['M19 4h-9', 'M14 20H5', 'M15 4 9 20']) },
		{ format: 'underline', label: localize('voltSkillEditor.underline', "Underline"), icon: () => createStrokeIcon('fmt-underline', ['M6 4v6a6 6 0 0 0 12 0V4', 'M4 20h16']) },
		{ format: 'strike', label: localize('voltSkillEditor.strike', "Strikethrough"), icon: () => createStrokeIcon('fmt-strike', ['M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', 'M4 12h16']) },
	],
	[
		{ format: 'link', label: localize('voltSkillEditor.link', "Link"), icon: () => createStrokeIcon('fmt-link', ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71']) },
		{ format: 'orderedList', label: localize('voltSkillEditor.orderedList', "Numbered List"), icon: () => createStrokeIcon('fmt-ol', ['M10 12h11', 'M10 18h11', 'M10 6h11', 'M4 10h2', 'M4 6h1v4', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1']) },
		{ format: 'bulletList', label: localize('voltSkillEditor.bulletList', "Bulleted List"), icon: () => createStrokeIcon('fmt-ul', ['M3 12h.01', 'M3 18h.01', 'M3 6h.01', 'M8 12h13', 'M8 18h13', 'M8 6h13']) },
	],
	[
		{ format: 'quote', label: localize('voltSkillEditor.quote', "Quote"), icon: () => createStrokeIcon('fmt-quote', ['M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z', 'M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z']) },
		{ format: 'code', label: localize('voltSkillEditor.code', "Inline Code"), icon: () => createStrokeIcon('fmt-code', ['M17.5 7.2A7 7 0 1 0 17.5 16.8']) },
		{ format: 'codeBlock', label: localize('voltSkillEditor.codeBlock', "Code Block"), icon: () => createStrokeIcon('fmt-codeblock', ['m18 16 4-4-4-4', 'm6 8-4 4 4 4', 'm14.5 4-5 16']) },
	],
];

function createPropertyTypeIcon(): HTMLElement {
	return createStrokeIcon('volt-skill-prop-type-icon', ['M4 6h16', 'M4 10h11', 'M4 14h16', 'M4 18h9'], '1.5');
}

/**
 * The Preview / Source editor for skills, subagents, rules and commands. Preview shows the front
 * matter as editable properties (a form for subagents) above the body rendered as editable rich
 * text; Source is a regular code editor on the same text model. Rules show their apply mode above
 * the source instead.
 */
export class AgentSkillEditor extends EditorPane {

	static readonly ID = AGENT_SKILL_EDITOR_ID;

	private root!: HTMLElement;
	private bar!: HTMLElement;
	private barStart!: HTMLElement;
	private segmented!: HTMLElement;
	private previewButton!: HTMLButtonElement;
	private sourceButton!: HTMLButtonElement;
	private moreButton!: HTMLButtonElement;
	private content!: HTMLElement;
	private preview!: HTMLElement;
	private previewInner!: HTMLElement;
	private headerHost!: HTMLElement;
	private bodyEl!: HTMLElement;
	private toolbar!: HTMLElement;
	private sourceHost!: HTMLElement;
	private sourceEditor!: CodeEditorWidget;

	private model: ITextModel | undefined;
	private kind: AgentCustomizationKind = 'skill';
	private mode: EditorMode = 'preview';
	private doc: IFrontmatterDocument = { hasFrontmatter: false, entries: [], body: '', eol: '\n' };
	private rendered: IRenderedMarkdown = { lead: '' };
	/** Blank lines between the front matter and the first block, kept as written. */
	private bodyLead = '';
	private writing = false;
	private bodyDirty = false;
	private stalePreview = false;
	private dimension: Dimension | undefined;
	private ruleInput: HTMLInputElement | undefined;
	private ruleButton: HTMLButtonElement | undefined;
	private readonly toolbarButtons = new Map<MarkdownFormat | 'chat', HTMLButtonElement>();
	private readonly inputStore = this._register(new DisposableStore());
	private readonly headerStore = this._register(new DisposableStore());
	private readonly barStore = this._register(new DisposableStore());
	private readonly renderScheduler = this._register(new RunOnceScheduler(() => this.renderFromModel(), RENDER_DELAY_MS));
	private readonly bodyWriteScheduler = this._register(new RunOnceScheduler(() => this.writeBody(), BODY_WRITE_DELAY_MS));
	/** A property or form field being typed in, written after a pause so undo steps by word, not key. */
	private pendingHeaderWrite: (() => void) | undefined;
	private readonly headerWriteScheduler = this._register(new RunOnceScheduler(() => this.flushHeader(), BODY_WRITE_DELAY_MS));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IEditorService private readonly editorService: IEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super(AgentSkillEditor.ID, group, telemetryService, themeService, storage);
	}

	//#region Layout

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-skill-editor'));

		this.bar = append(this.root, $('.volt-skill-editor-bar'));
		this.barStart = append(this.bar, $('.volt-skill-editor-bar-start'));
		const end = append(this.bar, $('.volt-skill-editor-bar-end'));
		this.segmented = append(end, $('.volt-skill-editor-segmented'));
		this.previewButton = append(this.segmented, $('button.volt-skill-editor-segment', { type: 'button' })) as HTMLButtonElement;
		this.previewButton.textContent = localize('voltSkillEditor.preview', "Preview");
		this.sourceButton = append(this.segmented, $('button.volt-skill-editor-segment', { type: 'button' })) as HTMLButtonElement;
		this.sourceButton.textContent = localize('voltSkillEditor.source', "Source");
		this._register(addDisposableListener(this.previewButton, EventType.CLICK, () => this.setMode('preview', true)));
		this._register(addDisposableListener(this.sourceButton, EventType.CLICK, () => this.setMode('source', true)));
		this.moreButton = append(end, $('button.volt-skill-editor-icon-button', { type: 'button' })) as HTMLButtonElement;
		this.moreButton.appendChild(renderIcon(Codicon.ellipsis));
		this.moreButton.setAttribute('aria-label', localize('voltSkillEditor.more', "More Actions"));
		setAgentTooltip(this.moreButton, localize('voltSkillEditor.more', "More Actions"));
		this._register(addDisposableListener(this.moreButton, EventType.CLICK, () => this.showMoreMenu()));

		this.content = append(this.root, $('.volt-skill-editor-content'));
		this.preview = append(this.content, $('.volt-skill-editor-preview'));
		this.preview.tabIndex = -1;
		this.previewInner = append(this.preview, $('.volt-skill-editor-preview-inner'));
		this.headerHost = append(this.previewInner, $('.volt-skill-editor-header'));
		this.bodyEl = append(this.previewInner, $('.volt-skill-editor-body.volt-skill-markdown'));
		this.bodyEl.contentEditable = 'true';
		this.bodyEl.spellcheck = true;
		this.bodyEl.setAttribute('role', 'textbox');
		this.bodyEl.setAttribute('aria-multiline', 'true');
		this.bodyEl.setAttribute('aria-label', localize('voltSkillEditor.bodyLabel', "Content"));
		this.toolbar = append(this.previewInner, $('.volt-skill-editor-toolbar.hidden'));
		this.createToolbar();
		this.registerBodyListeners();

		this.sourceHost = append(this.content, $('.volt-skill-editor-source'));
		this.sourceEditor = this._register(this.instantiationService.createInstance(CodeEditorWidget, this.sourceHost, this.sourceEditorOptions(), {
			isSimpleWidget: false,
			contributions: EditorExtensionsRegistry.getEditorContributions(),
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor')) {
				this.sourceEditor.updateOptions(this.sourceEditorOptions());
			}
		}));
		this.applyMode();
	}

	private sourceEditorOptions(): ICodeEditorOptions {
		const resource = this.model?.uri;
		const configured = this.configurationService.getValue<ICodeEditorOptions>('editor', { overrideIdentifier: 'markdown', resource }) ?? {};
		return {
			...configured,
			minimap: { enabled: false },
			lineNumbers: 'on',
			glyphMargin: false,
			folding: true,
			scrollBeyondLastLine: false,
			automaticLayout: false,
			fixedOverflowWidgets: true,
			renderLineHighlight: 'line',
			padding: { top: 10, bottom: 10 },
			overviewRulerLanes: 0,
			lineDecorationsWidth: 16,
			stickyScroll: { enabled: false },
			wordWrap: configured.wordWrap ?? 'off',
		};
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		const barHeight = this.bar.offsetHeight || 36;
		const height = Math.max(0, dimension.height - barHeight);
		this.sourceEditor.layout({ width: dimension.width, height });
		// A rule's apply mode lines up with the text column of the source below it.
		this.bar.style.paddingLeft = this.isRule() && this.model ? `${Math.max(16, this.sourceEditor.getLayoutInfo().contentLeft)}px` : '';
		this.resizeValueAreas();
		this.positionToolbar();
	}

	/** The panel can be narrow: let the tab bar shrink instead of overflowing. */
	override get minimumWidth(): number {
		return 160;
	}

	override getControl(): IEditorControl | undefined {
		return this.mode === 'source' ? this.sourceEditor : undefined;
	}

	override focus(): void {
		super.focus();
		if (this.mode === 'source') {
			this.sourceEditor.focus();
		} else {
			this.preview.focus();
		}
	}

	//#endregion

	//#region Input

	override async setInput(input: AgentSkillEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		const model = await input.resolveModel();
		if (token.isCancellationRequested || this.input !== input) {
			return;
		}
		this.model = model;
		this.kind = input.kind;
		// `.mdc` rules open as plain text unless something maps them; they are markdown.
		if (model.getLanguageId() === 'plaintext') {
			model.setLanguage(this.languageService.createById('markdown'));
		}
		this.sourceEditor.setModel(model);
		this.sourceEditor.updateOptions(this.sourceEditorOptions());
		this.root.dataset.kind = this.kind;
		this.inputStore.add(model.onDidChangeContent(() => {
			if (this.writing) {
				return;
			}
			if (this.mode === 'preview') {
				this.renderScheduler.schedule();
			} else {
				this.stalePreview = true;
				this.syncRuleBar();
			}
		}));
		this.inputStore.add(toDisposable(() => {
			this.renderScheduler.cancel();
			this.flushHeader();
			this.flushBody();
		}));
		this.mode = this.isRule() ? 'source' : this.storedMode();
		this.renderFromModel();
		this.applyMode();
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	override clearInput(): void {
		this.flushHeader();
		this.flushBody();
		this.inputStore.clear();
		this.headerStore.clear();
		this.sourceEditor.setModel(null);
		this.model = undefined;
		this.hideToolbar();
		super.clearInput();
	}

	override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible) {
			this.flushHeader();
			this.flushBody();
			this.hideToolbar();
		}
	}

	private isRule(): boolean {
		return this.kind === 'rule';
	}

	private storedMode(): EditorMode {
		const stored = this.storage.get(`${MODE_STORAGE_PREFIX}${this.kind}`, StorageScope.PROFILE);
		return stored === 'source' ? 'source' : 'preview';
	}

	private setMode(mode: EditorMode, remember: boolean): void {
		if (this.mode === mode) {
			return;
		}
		this.flushHeader();
		this.flushBody();
		this.mode = mode;
		if (remember) {
			this.storage.store(`${MODE_STORAGE_PREFIX}${this.kind}`, mode, StorageScope.PROFILE, StorageTarget.USER);
		}
		if (mode === 'preview' && this.stalePreview) {
			this.renderFromModel();
		}
		this.applyMode();
		if (this.dimension) {
			this.layout(this.dimension);
		}
		this.focus();
	}

	private applyMode(): void {
		const source = this.mode === 'source';
		this.root.classList.toggle('mode-source', source);
		this.root.classList.toggle('mode-preview', !source);
		this.root.classList.toggle('is-rule', this.isRule());
		this.segmented.classList.toggle('hidden', this.isRule());
		this.previewButton.classList.toggle('active', !source);
		this.sourceButton.classList.toggle('active', source);
		this.previewButton.setAttribute('aria-pressed', String(!source));
		this.sourceButton.setAttribute('aria-pressed', String(source));
		this.hideToolbar();
		this.renderBarStart();
	}

	//#endregion

	//#region Rendering

	private renderFromModel(): void {
		const model = this.model;
		if (!model || model.isDisposed()) {
			return;
		}
		this.bodyWriteScheduler.cancel();
		this.bodyDirty = false;
		this.stalePreview = false;
		this.doc = parseFrontmatterDocument(model.getValue());
		this.syncRuleBar();
		if (this.isRule() && this.mode === 'source') {
			return;
		}
		// A re-render must not pull focus out of a property the user is typing in.
		const active = getActiveElement();
		const editingHeader = isHTMLElement(active) && this.headerHost.contains(active);
		if (!editingHeader) {
			this.renderHeader();
		}
		this.renderBody();
	}

	private renderBody(): void {
		const raw = this.doc.hasFrontmatter ? this.doc.body : this.model?.getValue() ?? '';
		const normalized = raw.replace(/\r\n/g, '\n');
		this.bodyLead = /^\n*/.exec(normalized)![0];
		const folder = this.input instanceof AgentSkillEditorInput ? dirname(this.input.resource) : undefined;
		this.rendered = renderEditableMarkdown(this.bodyEl, normalized.slice(this.bodyLead.length), src => {
			if (!folder) {
				return undefined;
			}
			try {
				return FileAccess.uriToBrowserUri(joinPath(folder, decodeURIComponent(src))).toString(true);
			} catch {
				return undefined;
			}
		});
		this.bodyEl.classList.toggle('empty', !this.bodyEl.textContent?.trim());
		this.bodyEl.dataset.placeholder = this.kind === 'subagent'
			? localize('voltSkillEditor.subagentPlaceholder', "Describe the subagent's role and how it should respond.")
			: localize('voltSkillEditor.bodyPlaceholder', "Write instructions here.");
	}

	private renderHeader(): void {
		this.headerStore.clear();
		clearNode(this.headerHost);
		const showProperties = this.kind === 'skill' || this.kind === 'subagent' || this.doc.hasFrontmatter;
		this.headerHost.classList.toggle('hidden', !showProperties);
		if (!showProperties) {
			return;
		}
		if (this.kind === 'subagent') {
			this.renderSubagentForm(append(this.headerHost, $('.volt-skill-agent-form')));
			this.renderProperties(append(this.headerHost, $('.volt-skill-props.extra')), entry => !SUBAGENT_FIELDS.has(entry.key.toLowerCase()), false);
		} else {
			this.renderProperties(append(this.headerHost, $('.volt-skill-props')), () => true, true);
		}
		this.resizeValueAreas();
	}

	//#endregion

	//#region Properties

	private renderProperties(host: HTMLElement, include: (entry: IFrontmatterEntry) => boolean, withLabel: boolean): void {
		if (withLabel) {
			append(host, $('.volt-skill-props-label')).textContent = localize('voltSkillEditor.properties', "Properties");
		}
		const rows = append(host, $('.volt-skill-props-rows'));
		let dragIndex: number | undefined;
		this.doc.entries.forEach((entry, index) => {
			if (!entry.key || !include(entry)) {
				return;
			}
			const row = append(rows, $('.volt-skill-prop-row'));
			row.dataset.index = String(index);
			const type = append(row, $('span.volt-skill-prop-type'));
			type.appendChild(createPropertyTypeIcon());
			const grip = append(row, $('span.volt-skill-prop-grip'));
			grip.appendChild(renderIcon(Codicon.gripper));
			grip.draggable = true;
			setAgentTooltip(grip, localize('voltSkillEditor.dragProperty', "Drag to reorder"));
			const key = append(row, $('input.volt-skill-prop-key', { type: 'text', spellcheck: 'false' })) as HTMLInputElement;
			key.value = entry.key;
			key.setAttribute('aria-label', localize('voltSkillEditor.propertyName', "Property name"));
			const value = append(row, $('textarea.volt-skill-prop-value', { rows: '1', spellcheck: 'false' })) as HTMLTextAreaElement;
			value.value = entry.value;
			value.placeholder = localize('voltSkillEditor.empty', "Empty");
			value.setAttribute('aria-label', entry.key);

			this.headerStore.add(addDisposableListener(key, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter') {
					e.preventDefault();
					value.focus();
				} else if (e.key === 'Escape') {
					key.value = entry.key;
					key.blur();
				}
			}));
			this.headerStore.add(addDisposableListener(key, EventType.BLUR, () => this.renameProperty(index, key.value, value.value)));
			this.headerStore.add(addDisposableListener(value, EventType.INPUT, () => {
				this.autoGrow(value);
				this.scheduleHeaderWrite(() => this.setPropertyValue(index, value.value));
			}));
			this.headerStore.add(addDisposableListener(value, EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					value.blur();
				}
			}));
			this.headerStore.add(addDisposableListener(value, EventType.BLUR, () => {
				this.flushHeader();
				this.commitHeader();
			}));
			this.headerStore.add(addDisposableListener(row, EventType.CONTEXT_MENU, e => {
				e.preventDefault();
				this.contextMenuService.showContextMenu({
					getAnchor: () => ({ x: e.clientX, y: e.clientY }),
					getActions: () => [new Action('volt.skillEditor.deleteProperty', localize('voltSkillEditor.deleteProperty', "Delete Property"), undefined, true, async () => this.deleteProperty(index))],
				});
			}));

			// Drag the grip to reorder; the row under the pointer shows where it lands.
			this.headerStore.add(addDisposableListener(grip, EventType.DRAG_START, e => {
				dragIndex = index;
				row.classList.add('dragging');
				e.dataTransfer?.setData('text/plain', entry.key);
				if (e.dataTransfer) {
					e.dataTransfer.effectAllowed = 'move';
					e.dataTransfer.setDragImage(row, 16, 14);
				}
			}));
			this.headerStore.add(addDisposableListener(grip, EventType.DRAG_END, () => {
				dragIndex = undefined;
				row.classList.remove('dragging');
				for (const other of rows.children) {
					other.classList.remove('drop-before', 'drop-after');
				}
			}));
			this.headerStore.add(addDisposableListener(row, EventType.DRAG_OVER, e => {
				if (dragIndex === undefined) {
					return;
				}
				e.preventDefault();
				const box = row.getBoundingClientRect();
				const after = e.clientY > box.top + box.height / 2;
				row.classList.toggle('drop-after', after);
				row.classList.toggle('drop-before', !after);
			}));
			this.headerStore.add(addDisposableListener(row, EventType.DRAG_LEAVE, () => row.classList.remove('drop-before', 'drop-after')));
			this.headerStore.add(addDisposableListener(row, EventType.DROP, e => {
				e.preventDefault();
				const from = dragIndex;
				const after = row.classList.contains('drop-after');
				row.classList.remove('drop-before', 'drop-after');
				if (from === undefined || from === index) {
					return;
				}
				this.moveProperty(from, after ? index + 1 : index);
			}));
		});

		const add = append(host, $('button.volt-skill-add-prop', { type: 'button' })) as HTMLButtonElement;
		add.appendChild(renderIcon(Codicon.add));
		append(add, $('span')).textContent = localize('voltSkillEditor.addProperty', "Add property");
		this.headerStore.add(addDisposableListener(add, EventType.CLICK, () => this.addPendingProperty(rows)));
	}

	/** A new row: a filled key box and an "Empty" value. A key left empty removes it. */
	private addPendingProperty(rows: HTMLElement): void {
		const row = append(rows, $('.volt-skill-prop-row.pending'));
		append(row, $('span.volt-skill-prop-type')).appendChild(createPropertyTypeIcon());
		append(row, $('span.volt-skill-prop-grip'));
		const key = append(row, $('input.volt-skill-prop-key.editing', { type: 'text', spellcheck: 'false' })) as HTMLInputElement;
		key.setAttribute('aria-label', localize('voltSkillEditor.propertyName', "Property name"));
		const value = append(row, $('textarea.volt-skill-prop-value', { rows: '1', spellcheck: 'false' })) as HTMLTextAreaElement;
		value.placeholder = localize('voltSkillEditor.empty', "Empty");
		const store = new DisposableStore();
		this.headerStore.add(store);
		let done = false;
		const commit = () => {
			if (done) {
				return;
			}
			const name = key.value.trim().replace(/\s+/g, '_').replace(/:/g, '');
			if (!name) {
				if (!value.value.trim() && getActiveElement() !== value) {
					done = true;
					store.dispose();
					row.remove();
				}
				return;
			}
			done = true;
			store.dispose();
			this.applyDoc(withFrontmatterValue(this.doc, name, value.value.trim()), true);
		};
		store.add(addDisposableListener(key, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				value.focus();
			} else if (e.key === 'Escape') {
				key.value = '';
				value.value = '';
				done = true;
				store.dispose();
				row.remove();
			}
		}));
		store.add(addDisposableListener(key, EventType.BLUR, () => setTimeout(() => {
			if (getActiveElement() !== value) {
				commit();
			}
		}, 0)));
		store.add(addDisposableListener(value, EventType.INPUT, () => this.autoGrow(value)));
		store.add(addDisposableListener(value, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				value.blur();
			}
		}));
		store.add(addDisposableListener(value, EventType.BLUR, () => setTimeout(() => {
			if (getActiveElement() !== key) {
				commit();
			}
		}, 0)));
		key.focus();
	}

	private renameProperty(index: number, rawKey: string, value: string): void {
		const entry = this.doc.entries[index];
		if (!entry) {
			return;
		}
		const key = rawKey.trim().replace(/\s+/g, '_').replace(/:/g, '');
		if (key === entry.key) {
			this.commitHeader();
			return;
		}
		const entries = [...this.doc.entries];
		if (!key) {
			if (!value.trim()) {
				entries.splice(index, 1);
			} else {
				return;
			}
		} else {
			entries[index] = frontmatterEntry(key, value, entry.style === 'list');
		}
		this.applyDoc({ ...this.doc, entries }, true);
	}

	/** Value edits are written as typed (debounced by the caller's rhythm), without re-rendering the rows. */
	private setPropertyValue(index: number, value: string): void {
		const entry = this.doc.entries[index];
		if (!entry) {
			return;
		}
		const entries = [...this.doc.entries];
		entries[index] = frontmatterEntry(entry.key, value.replace(/\r?\n/g, ' '), entry.style === 'list');
		this.applyDoc({ ...this.doc, entries }, false);
	}

	private deleteProperty(index: number): void {
		const entries = [...this.doc.entries];
		entries.splice(index, 1);
		this.applyDoc({ ...this.doc, entries }, true);
	}

	private moveProperty(from: number, to: number): void {
		const entries = [...this.doc.entries];
		const [moved] = entries.splice(from, 1);
		entries.splice(to > from ? to - 1 : to, 0, moved);
		this.applyDoc({ ...this.doc, entries }, true);
	}

	/** After an edit that did not re-render (typing a value), redraw so rows reflect the file. */
	private commitHeader(): void {
		setTimeout(() => {
			const active = getActiveElement();
			if (!(isHTMLElement(active) && this.headerHost.contains(active))) {
				this.renderHeader();
			}
		}, 0);
	}

	private autoGrow(area: HTMLTextAreaElement): void {
		area.style.height = 'auto';
		area.style.height = `${area.scrollHeight}px`;
	}

	private resizeValueAreas(): void {
		if (this.mode !== 'preview') {
			return;
		}
		for (const area of this.headerHost.querySelectorAll<HTMLTextAreaElement>('textarea.volt-skill-prop-value')) {
			this.autoGrow(area);
		}
	}

	//#endregion

	//#region Subagent form

	private renderSubagentForm(host: HTMLElement): void {
		const top = append(host, $('.volt-skill-form-row'));
		const nameField = append(top, $('.volt-skill-field.name'));
		append(nameField, $('label.volt-skill-field-label')).textContent = localize('voltSkillEditor.name', "Name");
		const name = append(nameField, $('input.volt-skill-input', { type: 'text', spellcheck: 'false' })) as HTMLInputElement;
		name.value = frontmatterValue(this.doc, 'name') ?? '';
		this.headerStore.add(addDisposableListener(name, EventType.INPUT, () => this.scheduleHeaderWrite(() => this.applyDoc(withFrontmatterValue(this.doc, 'name', name.value.trim() || undefined), false))));
		this.headerStore.add(addDisposableListener(name, EventType.BLUR, () => this.flushHeader()));

		const modelField = append(top, $('.volt-skill-field.model'));
		append(modelField, $('label.volt-skill-field-label')).textContent = localize('voltSkillEditor.model', "Model");
		const modelButton = append(modelField, $('button.volt-skill-select', { type: 'button' })) as HTMLButtonElement;
		const current = frontmatterValue(this.doc, 'model')?.trim() || 'inherit';
		append(modelButton, $('span.volt-skill-select-label')).textContent = this.modelLabel(current);
		modelButton.appendChild(renderIcon(Codicon.chevronDown));
		this.headerStore.add(addDisposableListener(modelButton, EventType.CLICK, () => this.showModelMenu(modelButton, current)));

		const descriptionField = append(host, $('.volt-skill-field.description'));
		append(descriptionField, $('label.volt-skill-field-label')).textContent = localize('voltSkillEditor.description', "Description");
		const description = append(descriptionField, $('input.volt-skill-input', { type: 'text', spellcheck: 'false' })) as HTMLInputElement;
		description.value = frontmatterValue(this.doc, 'description') ?? '';
		description.placeholder = localize('voltSkillEditor.descriptionPlaceholder', "Describe when Agent should delegate to this subagent.");
		this.headerStore.add(addDisposableListener(description, EventType.INPUT, () => this.scheduleHeaderWrite(() => this.applyDoc(withFrontmatterValue(this.doc, 'description', description.value.trim() || undefined), false))));
		this.headerStore.add(addDisposableListener(description, EventType.BLUR, () => this.flushHeader()));

		const toggles = append(host, $('.volt-skill-toggles'));
		this.renderToggle(toggles, 'readonly', localize('voltSkillEditor.readonly', "Read-only"), localize('voltSkillEditor.readonlyHelp', "The subagent can read files and run read-only tools, but cannot edit files or run commands that change anything."));
		this.renderToggle(toggles, 'is_background', localize('voltSkillEditor.background', "Background"), localize('voltSkillEditor.backgroundHelp', "The subagent runs in the background while the main chat keeps going, and reports back when it finishes."));
	}

	private renderToggle(host: HTMLElement, key: string, label: string, help: string): void {
		const item = append(host, $('.volt-skill-toggle-item'));
		const toggle = append(item, $('button.volt-skill-switch', { type: 'button', role: 'switch' })) as HTMLButtonElement;
		const on = isTruthy(frontmatterValue(this.doc, key));
		toggle.classList.toggle('on', on);
		toggle.setAttribute('aria-checked', String(on));
		toggle.setAttribute('aria-label', label);
		append(toggle, $('span.volt-skill-switch-knob'));
		const text = append(item, $('span.volt-skill-toggle-label'));
		text.textContent = label;
		const helpIcon = append(item, $('span.volt-skill-help'));
		helpIcon.appendChild(renderIcon(Codicon.question));
		setAgentTooltip(helpIcon, help);
		const flip = () => {
			const next = !toggle.classList.contains('on');
			toggle.classList.toggle('on', next);
			toggle.setAttribute('aria-checked', String(next));
			this.applyDoc(withFrontmatterValue(this.doc, key, next ? 'true' : undefined), false);
		};
		this.headerStore.add(addDisposableListener(toggle, EventType.CLICK, flip));
		this.headerStore.add(addDisposableListener(text, EventType.CLICK, flip));
	}

	private modelChoices(): IModelChoice[] {
		let choices: IModelChoice[] = [];
		try {
			const profiles = enabledProfileIds(this.runtime.listProfiles());
			const seen = new Set<string>();
			for (const item of this.runtime.listCatalog()) {
				if (item.kind !== 'model' || !isPickerModelVisible(item, profiles) || seen.has(item.id) || item.label.trim().toLowerCase() === 'auto') {
					continue;
				}
				seen.add(item.id);
				choices.push({ id: item.id, label: item.qualifier ? `${item.label} ${item.qualifier}` : item.label });
			}
		} catch {
			choices = [];
		}
		return choices.length ? choices : [...FALLBACK_MODELS];
	}

	private modelLabel(id: string): string {
		if (!id || id === 'inherit') {
			return localize('voltSkillEditor.inherit', "Inherit from parent");
		}
		return this.modelChoices().find(choice => choice.id === id)?.label ?? id;
	}

	private showModelMenu(anchor: HTMLElement, current: string): void {
		const choices = this.modelChoices();
		if (current !== 'inherit' && !choices.some(choice => choice.id === current)) {
			choices.unshift({ id: current, label: current });
		}
		const pick = (id: string) => {
			this.applyDoc(withFrontmatterValue(this.doc, 'model', id === 'inherit' ? undefined : id), true);
		};
		const actions: IAction[] = [
			this.checkedAction('inherit', localize('voltSkillEditor.inherit', "Inherit from parent"), current === 'inherit', () => pick('inherit')),
			new Separator(),
			...choices.map(choice => this.checkedAction(choice.id, choice.label, choice.id === current, () => pick(choice.id))),
		];
		this.contextMenuService.showContextMenu({ getAnchor: () => anchor, getActions: () => actions, anchorAlignment: AnchorAlignment.LEFT });
	}

	private checkedAction(id: string, label: string, checked: boolean, run: () => void): IAction {
		const action = new Action(`volt.skillEditor.model.${id}`, label, undefined, true, async () => run());
		action.checked = checked;
		return action;
	}

	//#endregion

	//#region Rule bar

	private renderBarStart(): void {
		this.barStore.clear();
		clearNode(this.barStart);
		this.ruleButton = undefined;
		this.ruleInput = undefined;
		if (!this.isRule()) {
			return;
		}
		const button = this.ruleButton = append(this.barStart, $('button.volt-skill-rule-mode', { type: 'button' })) as HTMLButtonElement;
		append(button, $('span.volt-skill-rule-mode-label'));
		button.appendChild(renderIcon(Codicon.chevronDown));
		this.barStore.add(addDisposableListener(button, EventType.CLICK, () => this.showRuleMenu(button)));
		const input = this.ruleInput = append(this.barStart, $('input.volt-skill-rule-input', { type: 'text', spellcheck: 'false' })) as HTMLInputElement;
		this.barStore.add(addDisposableListener(input, EventType.INPUT, () => this.scheduleHeaderWrite(() => this.onRuleInput(input.value))));
		this.barStore.add(addDisposableListener(input, EventType.BLUR, () => this.flushHeader()));
		this.barStore.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter') {
				input.blur();
				this.sourceEditor.focus();
			}
		}));
		this.syncRuleBar();
	}

	private currentRuleMode(): { mode: AgentRuleMode; globs: string[] } {
		return ruleModeOf(this.model?.getValue() ?? '');
	}

	private syncRuleBar(): void {
		const button = this.ruleButton;
		const input = this.ruleInput;
		if (!button || !input || !this.model) {
			return;
		}
		const doc = parseFrontmatterDocument(this.model.getValue());
		const { mode, globs } = this.currentRuleMode();
		const option = RULE_MODES.find(candidate => candidate.mode === mode) ?? RULE_MODES[0];
		const label = button.querySelector('.volt-skill-rule-mode-label');
		if (label) {
			label.textContent = option.label;
		}
		button.dataset.mode = mode;
		const focused = getActiveElement() === input;
		input.readOnly = mode === 'always' || mode === 'manual';
		input.classList.toggle('hint', input.readOnly);
		switch (mode) {
			case 'always':
				input.value = localize('voltSkillEditor.rule.alwaysHint', "This rule attached to every chat and command+k request");
				break;
			case 'manual':
				input.value = localize('voltSkillEditor.rule.manualHint', "This rule is attached only when you @-mention it");
				break;
			case 'intelligent':
				input.placeholder = localize('voltSkillEditor.rule.descriptionPlaceholder', "Describe when the agent should apply this rule");
				if (!focused) {
					input.value = frontmatterValue(doc, 'description') ?? '';
				}
				break;
			case 'files':
				input.placeholder = localize('voltSkillEditor.rule.globsPlaceholder', "File patterns, e.g. src/**/*.ts, *.md");
				if (!focused) {
					input.value = globs.join(', ');
				}
				break;
		}
	}

	private showRuleMenu(anchor: HTMLElement): void {
		const current = this.currentRuleMode().mode;
		anchor.classList.add('open');
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorAlignment: AnchorAlignment.LEFT,
			render: container => {
				const store = new DisposableStore();
				const menu = append(container, $('.volt-skill-rule-menu'));
				menu.style.minWidth = `${Math.max(anchor.offsetWidth, 220)}px`;
				const rows: HTMLElement[] = [];
				let focusIndex = Math.max(0, RULE_MODES.findIndex(option => option.mode === current));
				const paintFocus = () => rows.forEach((row, index) => row.classList.toggle('focused', index === focusIndex));
				RULE_MODES.forEach((option, index) => {
					const row = append(menu, $('.volt-skill-rule-menu-row'));
					row.setAttribute('role', 'menuitemradio');
					row.setAttribute('aria-checked', String(option.mode === current));
					append(row, $('.volt-skill-rule-menu-title')).textContent = option.label;
					append(row, $('.volt-skill-rule-menu-description')).textContent = option.description;
					rows.push(row);
					store.add(addDisposableListener(row, EventType.MOUSE_ENTER, () => {
						focusIndex = index;
						paintFocus();
					}));
					store.add(addDisposableListener(row, EventType.CLICK, () => {
						this.contextViewService.hideContextView();
						this.setRuleMode(option.mode);
					}));
				});
				paintFocus();
				menu.tabIndex = 0;
				store.add(addDisposableListener(menu, EventType.KEY_DOWN, e => {
					const event = new StandardKeyboardEvent(e);
					if (event.keyCode === KeyCode.DownArrow || event.keyCode === KeyCode.UpArrow) {
						event.preventDefault();
						focusIndex = (focusIndex + (event.keyCode === KeyCode.DownArrow ? 1 : -1) + rows.length) % rows.length;
						paintFocus();
					} else if (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space) {
						event.preventDefault();
						this.contextViewService.hideContextView();
						this.setRuleMode(RULE_MODES[focusIndex].mode);
					} else if (event.keyCode === KeyCode.Escape) {
						this.contextViewService.hideContextView();
					}
				}));
				setTimeout(() => menu.focus(), 0);
				return store;
			},
			onHide: () => anchor.classList.remove('open'),
		});
	}

	private setRuleMode(mode: AgentRuleMode): void {
		const model = this.model;
		if (!model) {
			return;
		}
		let doc = parseFrontmatterDocument(model.getValue());
		const description = frontmatterValue(doc, 'description');
		const globs = frontmatterValue(doc, 'globs');
		switch (mode) {
			case 'always':
				doc = withFrontmatterValue(doc, 'alwaysApply', 'true');
				break;
			case 'intelligent':
				doc = withFrontmatterValue(doc, 'alwaysApply', 'false');
				doc = withFrontmatterValue(doc, 'globs', '', true);
				if (!description?.trim()) {
					doc = withFrontmatterValue(doc, 'description', localize('voltSkillEditor.rule.defaultDescription', "Describe when this rule applies"));
				}
				break;
			case 'files':
				doc = withFrontmatterValue(doc, 'alwaysApply', 'false');
				if (!globs?.trim()) {
					doc = withFrontmatterValue(doc, 'globs', '**/*', true);
				}
				break;
			case 'manual':
				doc = withFrontmatterValue(doc, 'alwaysApply', 'false');
				doc = withFrontmatterValue(doc, 'globs', '', true);
				doc = withFrontmatterValue(doc, 'description', '');
				break;
		}
		this.applyText(serializeFrontmatterDocument(doc, true));
		this.syncRuleBar();
		if (mode === 'intelligent' || mode === 'files') {
			this.ruleInput?.focus();
			this.ruleInput?.select();
		}
	}

	private onRuleInput(value: string): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const { mode } = this.currentRuleMode();
		let doc = parseFrontmatterDocument(model.getValue());
		if (mode === 'intelligent') {
			doc = withFrontmatterValue(doc, 'description', value);
		} else if (mode === 'files') {
			const globs = value.split(',').map(glob => glob.trim()).filter(Boolean).join(',');
			doc = withFrontmatterValue(doc, 'globs', globs, true);
		} else {
			return;
		}
		this.applyText(serializeFrontmatterDocument(doc, true));
	}

	//#endregion

	//#region Body editing

	private registerBodyListeners(): void {
		this._register(addDisposableListener(this.bodyEl, EventType.INPUT, () => {
			this.bodyDirty = true;
			this.bodyEl.classList.toggle('empty', !this.bodyEl.textContent?.trim() && !this.bodyEl.querySelector('img, hr, table'));
			this.bodyWriteScheduler.schedule();
			this.updateToolbar();
		}));
		this._register(addDisposableListener(this.bodyEl, EventType.BLUR, () => this.flushBody()));
		this._register(addDisposableListener(this.bodyEl, EventType.FOCUS, () => {
			// New lines become paragraphs, which read back as markdown paragraphs.
			try {
				getWindow(this.bodyEl).document.execCommand('defaultParagraphSeparator', false, 'p');
			} catch {
				// Not supported: divs read back as paragraphs too.
			}
		}));
		this._register(addDisposableListener(this.bodyEl, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			const mod = isMacintosh ? e.metaKey : e.ctrlKey;
			if (mod && !e.altKey && !e.shiftKey) {
				const format = event.keyCode === KeyCode.KeyB ? 'bold' : event.keyCode === KeyCode.KeyI ? 'italic' : event.keyCode === KeyCode.KeyU ? 'underline' : undefined;
				if (format) {
					e.preventDefault();
					e.stopPropagation();
					this.runFormat(format);
					return;
				}
			}
			if (event.keyCode === KeyCode.Tab && !e.altKey && !mod) {
				const selection = getWindow(this.bodyEl).document.getSelection();
				const inList = !!selection?.anchorNode && !!this.closestInBody(selection.anchorNode, 'LI');
				if (inList) {
					e.preventDefault();
					e.stopPropagation();
					getWindow(this.bodyEl).document.execCommand(e.shiftKey ? 'outdent' : 'indent');
				}
			}
		}));
		// Pasted content arrives as text: rich HTML from elsewhere would not survive the round trip to markdown.
		this._register(addDisposableListener(this.bodyEl, EventType.PASTE, (e: ClipboardEvent) => {
			const text = e.clipboardData?.getData('text/plain');
			if (text === undefined) {
				return;
			}
			e.preventDefault();
			getWindow(this.bodyEl).document.execCommand('insertText', false, text);
		}));
		this._register(addDisposableListener(this.bodyEl, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			const link = isHTMLElement(e.target) ? e.target.closest('a') : null;
			if (link && (isMacintosh ? e.metaKey : e.ctrlKey)) {
				e.preventDefault();
				const href = link.getAttribute('href');
				if (href) {
					void this.openerService.open(href);
				}
			}
		}));
		this._register(addDisposableListener(this.bodyEl, EventType.CLICK, (e: MouseEvent) => {
			// Task list checkboxes toggle in place and write back.
			if (isHTMLInputElement(e.target) && e.target.type === 'checkbox') {
				e.target.toggleAttribute('checked', e.target.checked);
				this.bodyDirty = true;
				this.bodyWriteScheduler.schedule();
			}
		}));
		const doc = getWindow(this.bodyEl).document;
		this._register(addDisposableListener(doc, 'selectionchange', () => this.updateToolbar()));
		this._register(addDisposableListener(this.preview, EventType.SCROLL, () => this.positionToolbar()));
	}

	private closestInBody(node: Node, tag: string): HTMLElement | undefined {
		let current: Node | null = node;
		while (current && current !== this.bodyEl) {
			if (isHTMLElement(current) && current.tagName === tag) {
				return current;
			}
			current = current.parentNode;
		}
		return undefined;
	}

	private flushBody(): void {
		if (this.bodyWriteScheduler.isScheduled()) {
			this.bodyWriteScheduler.cancel();
			this.writeBody();
		} else if (this.bodyDirty) {
			this.writeBody();
		}
	}

	private writeBody(): void {
		if (!this.bodyDirty || !this.model || this.model.isDisposed()) {
			return;
		}
		this.bodyDirty = false;
		const markdown = serializeEditableMarkdown(this.bodyEl, this.rendered);
		const current = parseFrontmatterDocument(this.model.getValue());
		const eol = current.eol;
		const body = `${this.bodyLead}${markdown}`.replace(/\n/g, eol);
		const text = current.hasFrontmatter ? serializeFrontmatterDocument({ ...current, body }) : body;
		this.applyText(text);
		rebaseEditableMarkdown(this.bodyEl);
		this.doc = parseFrontmatterDocument(this.model.getValue());
	}

	//#endregion

	//#region Writing

	private scheduleHeaderWrite(write: () => void): void {
		this.pendingHeaderWrite = write;
		this.headerWriteScheduler.schedule();
	}

	private flushHeader(): void {
		this.headerWriteScheduler.cancel();
		const write = this.pendingHeaderWrite;
		this.pendingHeaderWrite = undefined;
		write?.();
	}

	/** Writes a changed header. `rerender` redraws the rows (structure changed); typing does not. */
	private applyDoc(doc: IFrontmatterDocument, rerender: boolean): void {
		const model = this.model;
		if (!model) {
			return;
		}
		this.flushBody();
		// The body stays as the file has it: only the header changed.
		const current = parseFrontmatterDocument(model.getValue());
		const text = serializeFrontmatterDocument({ ...doc, body: current.hasFrontmatter ? current.body : `${current.eol}${model.getValue()}` }, true);
		this.applyText(text);
		this.doc = parseFrontmatterDocument(model.getValue());
		if (rerender) {
			this.renderHeader();
		}
	}

	/** Replaces only the part of the file that differs, as one undoable edit. */
	private applyText(text: string): void {
		const model = this.model;
		if (!model || model.isDisposed()) {
			return;
		}
		const current = model.getValue();
		if (current === text) {
			return;
		}
		let start = 0;
		const max = Math.min(current.length, text.length);
		while (start < max && current.charCodeAt(start) === text.charCodeAt(start)) {
			start++;
		}
		let endCurrent = current.length;
		let endText = text.length;
		while (endCurrent > start && endText > start && current.charCodeAt(endCurrent - 1) === text.charCodeAt(endText - 1)) {
			endCurrent--;
			endText--;
		}
		const from = model.getPositionAt(start);
		const to = model.getPositionAt(endCurrent);
		this.writing = true;
		try {
			model.pushStackElement();
			model.pushEditOperations([], [{ range: Range.fromPositions(from, to), text: text.slice(start, endText) }], () => null);
			model.pushStackElement();
		} finally {
			this.writing = false;
		}
	}

	//#endregion

	//#region Toolbar

	private createToolbar(): void {
		this.toolbar.setAttribute('role', 'toolbar');
		this.toolbar.setAttribute('aria-label', localize('voltSkillEditor.formatting', "Formatting"));
		TOOLBAR_GROUPS.forEach((group, groupIndex) => {
			if (groupIndex > 0) {
				append(this.toolbar, $('span.volt-skill-toolbar-separator'));
			}
			for (const item of group) {
				const button = append(this.toolbar, $('button.volt-skill-toolbar-button', { type: 'button' })) as HTMLButtonElement;
				button.appendChild(item.icon());
				button.setAttribute('aria-label', item.label);
				setAgentTooltip(button, item.label);
				this.toolbarButtons.set(item.format, button);
				// Keep the selection: a press on the toolbar must not move focus out of the text.
				this._register(addDisposableListener(button, EventType.MOUSE_DOWN, e => e.preventDefault()));
				this._register(addDisposableListener(button, EventType.CLICK, () => {
					if (item.format === 'chat') {
						void this.addSelectionToChat();
					} else {
						this.runFormat(item.format);
					}
				}));
			}
		});
	}

	private runFormat(format: MarkdownFormat): void {
		if (format === 'link') {
			void this.promptLink();
			return;
		}
		if (applyFormat(this.bodyEl, format)) {
			this.bodyDirty = true;
			this.bodyWriteScheduler.schedule();
		}
		this.updateToolbar();
	}

	private async promptLink(): Promise<void> {
		const doc = getWindow(this.bodyEl).document;
		const selection = doc.getSelection();
		const range = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
		if (!range) {
			return;
		}
		if (activeFormats(this.bodyEl).has('link')) {
			if (applyFormat(this.bodyEl, 'link')) {
				this.bodyDirty = true;
				this.bodyWriteScheduler.schedule();
			}
			return;
		}
		const url = await this.quickInputService.input({
			prompt: localize('voltSkillEditor.linkPrompt', "Link address"),
			placeHolder: 'https://',
			validateInput: async value => value.trim() ? undefined : localize('voltSkillEditor.linkRequired', "Enter an address."),
		});
		this.bodyEl.focus();
		selection?.removeAllRanges();
		selection?.addRange(range);
		if (url?.trim() && applyFormat(this.bodyEl, 'link', url.trim())) {
			this.bodyDirty = true;
			this.bodyWriteScheduler.schedule();
		}
	}

	/** Sends the selected lines to the chat: the source editor's selection is set to them first. */
	private async addSelectionToChat(): Promise<void> {
		const doc = getWindow(this.bodyEl).document;
		const text = doc.getSelection()?.toString().trim() ?? '';
		const model = this.model;
		if (!text || !model) {
			return;
		}
		this.flushBody();
		const value = model.getValue();
		const bodyStart = value.length - (this.doc.hasFrontmatter ? this.doc.body.length : value.length);
		const firstLine = text.split('\n')[0].trim();
		const lastLine = text.split('\n').filter(line => line.trim()).pop()?.trim() ?? firstLine;
		const startOffset = value.indexOf(firstLine, bodyStart);
		if (startOffset >= 0 && CommandsRegistry.getCommand(ADD_SELECTION_TO_CHAT_COMMAND_ID)) {
			const endOffset = Math.max(startOffset + firstLine.length, value.indexOf(lastLine, startOffset) + lastLine.length);
			const start = model.getPositionAt(startOffset);
			const end = model.getPositionAt(endOffset);
			this.sourceEditor.setSelection(new Selection(start.lineNumber, start.column, end.lineNumber, end.column));
			await this.commandService.executeCommand(ADD_SELECTION_TO_CHAT_COMMAND_ID, this.sourceEditor);
			return;
		}
		await this.clipboardService.writeText(text);
	}

	private updateToolbar(): void {
		if (this.mode !== 'preview') {
			this.hideToolbar();
			return;
		}
		const selection = getWindow(this.bodyEl).document.getSelection();
		if (!selection || !selection.rangeCount || selection.isCollapsed || !this.bodyEl.contains(selection.getRangeAt(0).commonAncestorContainer) || !selection.toString().trim()) {
			this.hideToolbar();
			return;
		}
		const active = activeFormats(this.bodyEl);
		for (const [format, button] of this.toolbarButtons) {
			button.classList.toggle('active', format !== 'chat' && active.has(format));
		}
		this.toolbar.classList.remove('hidden');
		this.positionToolbar();
	}

	private positionToolbar(): void {
		if (this.toolbar.classList.contains('hidden')) {
			return;
		}
		const selection = getWindow(this.bodyEl).document.getSelection();
		if (!selection || !selection.rangeCount) {
			return;
		}
		const rect = selection.getRangeAt(0).getBoundingClientRect();
		const host = this.previewInner.getBoundingClientRect();
		const width = this.toolbar.offsetWidth;
		const height = this.toolbar.offsetHeight;
		const left = Math.max(0, Math.min(rect.left - host.left - 70, host.width - width));
		let top = rect.top - host.top - height - 8;
		if (rect.top - this.preview.getBoundingClientRect().top < height + 12) {
			// No room above inside the view: show it under the selection.
			top = rect.bottom - host.top + 8;
		}
		this.toolbar.style.left = `${left}px`;
		this.toolbar.style.top = `${top}px`;
	}

	private hideToolbar(): void {
		this.toolbar?.classList.add('hidden');
	}

	//#endregion

	//#region More menu

	private showMoreMenu(): void {
		const input = this.input;
		if (!(input instanceof AgentSkillEditorInput)) {
			return;
		}
		const resource = input.resource;
		const revealLabel = isMacintosh
			? localize('voltSkillEditor.revealMac', "Reveal in Finder")
			: isWindows ? localize('voltSkillEditor.revealWindows', "Reveal in File Explorer") : localize('voltSkillEditor.revealLinux', "Open Containing Folder");
		const actions: IAction[] = [
			new Action('volt.skillEditor.openText', localize('voltSkillEditor.openText', "Open as Text"), undefined, true, async () => {
				await this.editorService.openEditor({ resource, options: { override: DEFAULT_EDITOR_ASSOCIATION.id, pinned: true } }, this.group);
			}),
			new Separator(),
			new Action('volt.skillEditor.reveal', revealLabel, undefined, resource.scheme === Schemas.file, async () => {
				await this.commandService.executeCommand('revealFileInOS', resource);
			}),
			new Action('volt.skillEditor.copyPath', localize('voltSkillEditor.copyPath', "Copy Path"), undefined, true, async () => {
				await this.clipboardService.writeText(resource.scheme === Schemas.file ? resource.fsPath : resource.toString());
			}),
		];
		this.contextMenuService.showContextMenu({ getAnchor: () => this.moreButton, getActions: () => actions, anchorAlignment: AnchorAlignment.RIGHT });
	}

	//#endregion
}
