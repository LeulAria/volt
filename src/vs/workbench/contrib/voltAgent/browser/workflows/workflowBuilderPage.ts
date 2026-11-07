/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentWorkflowBuilder.css';
import { $, addDisposableListener, append, clearNode, getWindow, isHTMLElement, isHTMLInputElement, isHTMLTextAreaElement } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService, IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAutomation, IAutomationService } from '../../../../services/voltRuntime/common/automations/automations.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { validateWorkflow } from '../../../../services/voltRuntime/common/workflows/workflowGraph.js';
import { defaultNodeConfig, getWorkflowNodeType, nodeDisplayName, workflowNodeTypes } from '../../../../services/voltRuntime/common/workflows/workflowNodes.js';
import { blankWorkflow, serializeWorkflow } from '../../../../services/voltRuntime/common/workflows/workflowSchema.js';
import { BUILT_IN_WORKFLOW_TEMPLATES } from '../../../../services/voltRuntime/common/workflows/workflowTemplates.js';
import { IWorkflowDefinition, IWorkflowExecution, IWorkflowIssue, IWorkflowNode, IWorkflowRun, IWorkflowService, IWorkflowStartOptions, IWorkflowSummary, WORKFLOW_SCHEMA_VERSION, WorkflowApprovalDecision, WorkflowValue } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { WorkflowEditorModel } from '../../common/workflows/workflowEditorModel.js';
import { AutomationsRoute, IAutomationsHost, IAutomationsPage } from '../automations/automationRoutes.js';
import { showAutomationDialog, toggleSwitch } from '../automations/automationUi.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { IAgentCustomizeService } from '../customize/agentCustomizeService.js';
import { IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { WorkflowCanvas } from './canvas/workflowCanvas.js';
import { addWorkflowBlock, describeWorkflowTrigger, IWorkflowAddRequest, IWorkflowBlock, pointAnchor, showWorkflowNodeMenu, showWorkflowTriggerMenu, WorkflowBlockPicker } from './workflowBlockPicker.js';
import { formatAgo, IWorkflowFieldSources, shortcut, workflowTextarea } from './workflowFieldEditors.js';
import { WorkflowCodeEditor } from './workflowCodeEditor.js';
import { WorkflowInspector } from './workflowInspector.js';
import { linkedAutomation, setWorkflowActive } from './workflowAutomationBridge.js';
import { placeTabIndicator, WorkflowRunPanel } from './workflowRunPanel.js';
import { workflowSlug } from './workflowService.js';
import { WorkflowYamlPanel } from './workflowYamlPanel.js';

/**
 * The workflow builder (Automations > Workflows > one workflow), drawn into the editor's stage: a
 * top bar (back, switcher, name, validity, save state, editing and run actions), the canvas with
 * the "Add a node" panel over its left side, the right panel (Inspector or YAML, resizable), and
 * the executions dock under the canvas (resizable, opens on a run). One WorkflowEditorModel holds
 * the definition; every part edits through it and redraws from its events. A new workflow (no
 * id) is built from a blank, a pasted YAML or a template and saved only on Save.
 */

const BAR_HEIGHT = 44;
const SIDE_HEAD = 40;
const SIDE_DEFAULT = 360;
const SIDE_MIN = 288;
const SIDE_MAX = 640;
const PICKER_WIDTH = 340;
const PICKER_DOCK_WIDTH = 304;
const PICKER_MAX_HEIGHT = 480;
const RUN_DEFAULT = 300;
const RUN_MIN = 160;
const DOCK_STRIP = 28;
/** The canvas keeps at least this much room when the docks grow. */
const CANVAS_MIN = 240;
const LAYOUT_KEY = 'volt.workflows.builder.layout';

type SideTab = 'inspector' | 'yaml';

interface ILayoutState {
	side: number;
	run: number;
	sideOpen: boolean;
	tab: SideTab;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'new';

function isTextTarget(target: EventTarget | null): boolean {
	return isHTMLElement(target) && (isHTMLInputElement(target) || isHTMLTextAreaElement(target) || target.isContentEditable || !!target.closest('.monaco-editor'));
}

function isLive(run: IWorkflowRun | undefined): boolean {
	return !!run && (run.status === 'queued' || run.status === 'running' || run.status === 'paused' || run.status === 'waiting');
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/** The ```yaml block of an agent's answer (the last one, if it wrote several), or the answer when it is bare YAML. */
export function extractYamlBlock(text: string): string | undefined {
	const blocks = [...text.matchAll(/```(?:ya?ml)?[^\n]*\n([\s\S]*?)```/g)].map(match => match[1]);
	const block = blocks.filter(candidate => /^\s*(version|id|name|nodes)\s*:/m.test(candidate)).at(-1) ?? blocks.at(-1);
	if (block) {
		return block.trim();
	}
	return /^\s*(version|id|name)\s*:/m.test(text) ? text.trim() : undefined;
}

/** The Describe agent's guide: the YAML format by example, then every node type with its config and ports. */
export function workflowAuthoringGuide(): string {
	const example: IWorkflowDefinition = {
		version: WORKFLOW_SCHEMA_VERSION,
		id: 'review-pull-request',
		name: 'Review a pull request',
		description: 'Reviews the change and reports back.',
		trigger: { type: 'manual' },
		inputs: [{ name: 'task', type: 'string', description: 'What to review' }],
		nodes: [
			{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
			{ id: 'review', type: 'agent', name: 'Review', position: { x: 320, y: 0 }, config: { prompt: 'Review this change: {{ inputs.task }}', verdicts: ['approve', 'changes'] } },
			{ id: 'done', type: 'end', position: { x: 640, y: -80 }, config: { status: 'success', output: '{{ nodes.review.summary }}' } },
			{ id: 'failed', type: 'end', position: { x: 640, y: 80 }, config: { status: 'failure' } },
		],
		edges: [
			{ id: 'start.next->review', from: 'start', port: 'next', to: 'review' },
			{ id: 'review.approve->done', from: 'review', port: 'approve', to: 'done' },
			{ id: 'review.changes->failed', from: 'review', port: 'changes', to: 'failed' },
			{ id: 'review.failed->failed', from: 'review', port: 'failed', to: 'failed' },
		],
	};
	const types = workflowNodeTypes().filter(type => !type.hidden).map(type => {
		const fields = type.fields.map(field => `${field.key} (${field.kind}${field.required ? ', required' : ''}${field.options?.length ? `: ${field.options.map(option => option.value).join(' | ')}` : ''})`).join('; ');
		let ports = '';
		try {
			ports = type.outputs(defaultNodeConfig(type)).map(port => port.id).join(', ');
		} catch {
			// A type whose ports need config the defaults lack.
		}
		const outputs = type.outputDocs.map(doc => doc.key).join(', ');
		return `- ${type.type} [${type.category}]: ${type.description}${fields ? ` Config: ${fields}.` : ''} Ports: ${ports || 'none'}.${outputs ? ` Outputs: ${outputs}.` : ''}`;
	});
	return [
		'Rules:',
		'- Reply with exactly one ```yaml block holding the complete workflow file, and nothing else.',
		'- Use only the node types below and their config keys. Exactly one start node, id "start".',
		'- Node ids: lower-case letters, digits, _ and -, starting with a letter. Edges go from "node.port" to a node id.',
		'- Wire every port that should continue; an unwired port ends the run there. Agent nodes also have a "failed" port.',
		'- Values in config can use templates: {{ inputs.name }}, {{ trigger.payload.path }}, {{ nodes.<id>.<output> }}, {{ vars.name }}.',
		'- If and Switch conditions are plain expressions without braces, e.g. nodes.check.exitCode == 0 && vars.tries < 3.',
		'- Lay nodes out left to right about 320 px apart; stack branches about 160 px apart.',
		'- Keep the trigger manual unless the description says when it should run (schedule: cron; event: provider and event).',
		'',
		'Format, by example:',
		'```yaml',
		serializeWorkflow(example).trim(),
		'```',
		'',
		'Node types (type [category]: what it does. Config. Ports. Outputs):',
		...types,
	].join('\n');
}

export class WorkflowBuilderPage extends Disposable implements IAutomationsPage {

	readonly usesStage = true;

	private readonly root: HTMLElement;
	private readonly barStore = this._register(new DisposableStore());
	private readonly pageStore = this._register(new DisposableStore());
	private readonly activeStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly runControlsStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly sideTabButtons = new Map<SideTab, HTMLButtonElement>();
	private sideTabIndicator!: HTMLElement;
	private activeKey = '';
	private runControlsKey = '';
	private model: WorkflowEditorModel | undefined;
	private canvas: WorkflowCanvas | undefined;
	private picker: WorkflowBlockPicker | undefined;
	/** Where the "Add a node" dropdown hangs (client px): its top at `y`, or its bottom at `above` when short of room. */
	private pickerAnchor: { readonly x: number; readonly y: number; readonly above: number } | undefined;
	/** Opened from the Add node button (or Tab): the panel over the canvas's left edge, not a dropdown. */
	private pickerDocked = false;
	private addButton: HTMLButtonElement | undefined;
	private inspector: WorkflowInspector | undefined;
	private yaml: WorkflowYamlPanel | undefined;
	private runPanel: WorkflowRunPanel | undefined;

	private savedId: string | undefined;
	/** Started from pasted YAML, a template or a description: worth asking before it is thrown away. */
	private seeded = false;
	/** The automation that made this workflow from its Workflow menu (set to run it after the first save). */
	private ownerAutomationId: string | undefined;
	private issues: readonly IWorkflowIssue[] = [];
	private graphIssues: readonly IWorkflowIssue[] = [];
	private execution: IWorkflowExecution | undefined;
	private readonly executionListener = this._register(new MutableDisposable());
	private shownRun: IWorkflowRun | undefined;
	private readonly shownApprovals = new Set<string>();
	private failNodes = new Set<string>();
	private layoutState: ILayoutState;
	private runOpen = false;
	private saveState: SaveState = 'saved';
	private saveFlash: ReturnType<typeof setTimeout> | undefined;
	private describing: IWorkflowExecution | undefined;
	private paintPending = false;
	private layoutPending = false;

	// Laid-out parts (set by build()).
	private body!: HTMLElement;
	private center!: HTMLElement;
	private canvasHost!: HTMLElement;
	private pickerHost!: HTMLElement;
	private dock!: HTMLElement;
	private dockStrip!: HTMLButtonElement;
	private runHost!: HTMLElement;
	private side!: HTMLElement;
	private inspectorHost!: HTMLElement;
	private yamlHost!: HTMLElement;
	private sideTabs!: HTMLElement;

	// Bar pieces that change.
	private nameInput: HTMLInputElement | undefined;
	private pill: HTMLButtonElement | undefined;
	private saveStateEl: HTMLElement | undefined;
	private undoButton: HTMLButtonElement | undefined;
	private redoButton: HTMLButtonElement | undefined;
	private simulateGroup: HTMLElement | undefined;
	private runControls: HTMLElement | undefined;
	private activeHost: HTMLElement | undefined;
	private saveButton: HTMLButtonElement | undefined;
	private backToAutomation: HTMLButtonElement | undefined;
	private yamlToggle: HTMLButtonElement | undefined;
	private sideToggle: HTMLButtonElement | undefined;
	private runToggle: HTMLButtonElement | undefined;

	private readonly validate = this._register(new RunOnceScheduler(() => this.runValidation(), 120));

	constructor(
		private readonly host: IAutomationsHost,
		private readonly route: Extract<AutomationsRoute, { page: 'workflow' }>,
		@IWorkflowService private readonly workflows: IWorkflowService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IDialogService private readonly dialogs: IDialogService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService private readonly storage: IStorageService,
		@IAutomationService private readonly automations: IAutomationService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
	) {
		super();
		clearNode(host.bar);
		this.layoutState = this.readLayout();
		this.root = append(host.stage, $('.volt-wfb-builder'));
		this.root.tabIndex = -1;
		const loading = append(this.root, $('.volt-wfb-loading'));
		loading.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
		append(loading, $('span')).textContent = localize('voltWorkflows.loading', "Opening workflow");
		this._register(toDisposable(() => {
			if (this.saveFlash) {
				clearTimeout(this.saveFlash);
			}
		}));
		void this.load();
	}

	//#region Page

	async canLeave(): Promise<boolean> {
		if (!this.model || !this.needsSave()) {
			return true;
		}
		const { confirmed } = await this.dialogs.confirm({
			message: localize('voltWorkflows.discardChanges', "Discard unsaved changes to \"{0}\"?", this.model.definition.name || localize('voltWorkflows.untitled', "Untitled workflow")),
			detail: this.savedId ? undefined : localize('voltWorkflows.discardNew', "This workflow has not been saved yet."),
			primaryButton: localize('voltWorkflows.discard', "Discard"),
		});
		return confirmed;
	}

	focus(): void {
		this.canvas?.focus();
	}

	private needsSave(): boolean {
		return !!this.model && (this.model.dirty || (!this.savedId && this.seeded));
	}

	private async load(): Promise<void> {
		await this.workflows.whenReady;
		if (this._store.isDisposed) {
			return;
		}
		clearNode(this.root);
		let initial: IWorkflowDefinition;
		let seed: IWorkflowDefinition | undefined;
		let initialText: string | undefined;
		if (this.route.id) {
			const stored = this.workflows.get(this.route.id);
			if (!stored) {
				this.renderMissing();
				return;
			}
			initial = stored;
			this.savedId = stored.id;
			initialText = this.workflows.getYaml(stored.id);
		} else {
			initial = blankWorkflow(this.freeId('untitled-workflow'), localize('voltWorkflows.untitled', "Untitled workflow"));
			seed = this.seedDefinition();
			this.ownerAutomationId = this.route.seed?.automationId;
		}
		this.model = this._register(new WorkflowEditorModel(initial));
		if (seed) {
			this.seeded = true;
			this.model.replace(seed, 'external', { undoable: false });
			initialText = undefined;
		}
		this.build(initialText);
		if (this.route.seed?.describe) {
			void this.describe(this.route.seed.describe);
		}
		const run = this.route.run ? this.workflows.getRun(this.route.run) : undefined;
		const active = this.savedId ? this.workflows.activeExecution(this.savedId) : undefined;
		if (active) {
			this.attach(active);
		} else if (run) {
			this.showRun(run);
			this.setRunOpen(true);
		}
	}

	/** A new workflow from the route's seed: pasted YAML or a built-in template (else the blank). */
	private seedDefinition(): IWorkflowDefinition | undefined {
		const seed = this.route.seed;
		const fromYaml = (yaml: string, source: IWorkflowDefinition['source']): IWorkflowDefinition | undefined => {
			const parsed = this.workflows.parse(yaml);
			if (!parsed.definition) {
				const first = parsed.issues.find(issue => issue.severity === 'error');
				this.notifications.error(localize('voltWorkflows.seedInvalid', "That YAML is not a workflow: {0}", first?.message ?? ''));
				return undefined;
			}
			return { ...parsed.definition, id: this.freeId(parsed.definition.id || workflowSlug(parsed.definition.name)), revision: undefined, source: parsed.definition.source ?? source };
		};
		if (seed?.yaml) {
			return fromYaml(seed.yaml, { kind: seed.templateSource ? 'community' : seed.templateId ? 'template' : 'import', ...(seed.templateId ? { templateId: seed.templateId } : {}), ...(seed.templateSource ? { url: seed.templateSource } : {}) });
		}
		if (seed?.templateId) {
			const template = BUILT_IN_WORKFLOW_TEMPLATES.find(entry => entry.id === seed.templateId);
			if (template) {
				return fromYaml(template.yaml, { kind: 'template', templateId: template.id });
			}
			this.notifications.warn(localize('voltWorkflows.noTemplate', "The template \"{0}\" is not available. Starting from a blank workflow.", seed.templateId));
		}
		return undefined;
	}

	private freeId(base: string): string {
		const taken = new Set(this.workflows.list().map(summary => summary.id));
		const stem = workflowSlug(base);
		if (!taken.has(stem)) {
			return stem;
		}
		for (let n = 2; ; n++) {
			if (!taken.has(`${stem}-${n}`)) {
				return `${stem}-${n}`;
			}
		}
	}

	private renderMissing(): void {
		this.host.setCrumbs([{ label: localize('voltWorkflows.workflowsCrumb', "Workflows"), run: () => this.host.navigate({ page: 'workflows' }) }, { label: localize('voltWorkflows.notFound', "Not found") }]);
		const box = append(this.root, $('.volt-wfb-missing'));
		box.appendChild(renderIcon(Codicon.typeHierarchySub));
		append(box, $('h2')).textContent = localize('voltWorkflows.missingTitle', "This workflow was deleted");
		append(box, $('p')).textContent = localize('voltWorkflows.missingBody', "It is no longer in your workflows. Its runs stay in Automations > Runs.");
		const button = this.pageStore.add(createVoltButton(box, 'primary'));
		button.label = localize('voltWorkflows.allWorkflows', "All workflows");
		this.pageStore.add(button.onDidClick(() => this.host.navigate({ page: 'workflows' })));
	}

	private readLayout(): ILayoutState {
		const fallback: ILayoutState = { side: SIDE_DEFAULT, run: RUN_DEFAULT, sideOpen: true, tab: 'inspector' };
		try {
			const raw = JSON.parse(this.storage.get(LAYOUT_KEY, StorageScope.PROFILE, '{}')) as Partial<ILayoutState>;
			return {
				side: typeof raw.side === 'number' ? raw.side : fallback.side,
				run: typeof raw.run === 'number' ? raw.run : fallback.run,
				sideOpen: raw.sideOpen !== false,
				tab: raw.tab === 'yaml' ? 'yaml' : 'inspector',
			};
		} catch {
			return fallback;
		}
	}

	private storeLayout(): void {
		this.storage.store(LAYOUT_KEY, JSON.stringify(this.layoutState), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	//#endregion

	//#region Build

	private get fieldSources(): IWorkflowFieldSources {
		return {
			skills: async () => (await this.customize.getSlashItems()).filter(item => item.type === 'skill').map(item => ({ name: item.name, summary: item.summary, ...(item.location ? { location: item.location } : {}) })),
			mcpServers: () => {
				const repository = this.model?.definition.settings?.repository;
				return this.runtime.listMcpServers(repository ? uriFromStoredRoot(repository) : this.sessionContext.activeProject?.root);
			},
			workflows: () => this.workflows.list(),
			repositories: () => this.sessionContext.projects.map(project => ({ root: project.root.toString(), label: project.displayName, detail: project.root.fsPath })),
			pickFolder: async () => {
				const picked = await this.fileDialogs.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: localize('voltWorkflows.chooseFolder', "Choose Folder") });
				return picked?.[0]?.toString();
			},
		};
	}

	private build(initialText: string | undefined): void {
		const model = this.model!;
		this.renderBar();
		this.body = append(this.root, $('.volt-wfb-body'));
		this.center = append(this.body, $('.volt-wfb-center'));
		this.canvasHost = append(this.center, $('.volt-wfb-canvas-host'));
		this.pickerHost = append(this.center, $('.volt-wfb-picker-host'));
		this.dock = append(this.center, $('.volt-wfb-dock'));
		const runSash = append(this.dock, $('.volt-wfb-sash.horizontal'));
		this.dockStrip = append(this.dock, $('button.volt-wfb-dock-strip')) as HTMLButtonElement;
		this.dockStrip.type = 'button';
		this.runHost = append(this.dock, $('.volt-wfb-run-host'));
		this.side = append(this.body, $('.volt-wfb-side'));
		const sideSash = append(this.side, $('.volt-wfb-sash.vertical'));
		const sideHead = append(this.side, $('.volt-wfb-side-head'));
		// Underlined tabs like the run panel's (Material-style bar that slides between them).
		this.sideTabs = append(sideHead, $('.volt-wf-seg.volt-wfb-side-tabs'));
		this.sideTabs.setAttribute('role', 'tablist');
		for (const tab of ['inspector', 'yaml'] as const) {
			const button = append(this.sideTabs, $('button.volt-wf-seg-item')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'tab');
			this.pageStore.add(addDisposableListener(button, 'click', () => this.setSideOpen(true, tab)));
			this.sideTabButtons.set(tab, button);
		}
		this.sideTabIndicator = append(this.sideTabs, $('.volt-wf-seg-indicator'));
		append(sideHead, $('span.volt-wfb-spacer'));
		this.barIcon(sideHead, Codicon.close, localize('voltWorkflows.closePanel', "Close panel"), () => this.setSideOpen(false), this.pageStore);
		this.inspectorHost = append(this.side, $('.volt-wfb-side-pane'));
		this.yamlHost = append(this.side, $('.volt-wfb-side-pane'));

		const sources = this.fieldSources;
		this.canvas = this.pageStore.add(this.instantiationService.createInstance(WorkflowCanvas, this.canvasHost, model, { minimap: true, emptyState: true }));
		this.picker = this.pageStore.add(this.instantiationService.createInstance(WorkflowBlockPicker, this.pickerHost, model, {
			sources,
			workflowId: () => this.savedId,
			onDidAdd: nodeId => this.afterAdd(nodeId),
			onDidClose: () => {
				this.pickerHost.classList.remove('open', 'docked');
				this.pickerAnchor = undefined;
				this.pickerDocked = false;
				this.canvas?.clearPendingConnection();
			},
			onDidChangeHeight: () => this.placePicker(),
		}));
		// The dropdown (not the docked panel): a press anywhere else (the Add button toggles it itself;
		// flyouts live in the context view) or panning the canvas under it closes it.
		const doc = getWindow(this.root).document;
		this.pageStore.add(addDisposableListener(doc, 'pointerdown', (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (this.picker?.isOpen && !this.pickerDocked && target && !this.pickerHost.contains(target) && !this.addButton?.contains(target) && !target.closest('.context-view')) {
				this.picker.close();
			}
		}, true));
		this.pageStore.add(addDisposableListener(this.canvasHost, 'wheel', () => {
			if (!this.pickerDocked) {
				this.picker?.close();
			}
		}, { passive: true }));
		this.inspector = this.pageStore.add(this.instantiationService.createInstance(WorkflowInspector, this.inspectorHost, model, {
			sources,
			workflowId: () => this.savedId,
			onRevealNode: nodeId => this.canvas?.revealNode(nodeId, true),
			onRevealIssue: issue => this.revealIssue(issue),
			onRunNode: nodeId => void this.executeStep(nodeId),
			onApprove: (nodeId, decision) => this.approve(nodeId, decision),
			onDescribe: text => void this.describe(text),
			onBrowseTemplates: () => this.host.navigate({ page: 'workflows', tab: 'templates' }),
			onAutoLayoutSelection: () => this.canvas?.autoLayout(true),
		}));
		this.yaml = this.pageStore.add(this.instantiationService.createInstance(WorkflowYamlPanel, this.yamlHost, model, {
			...(initialText ? { initialText } : {}),
			parse: text => this.workflows.parse(text),
			lockedId: () => this.savedId,
			onPaste: () => void this.openPasteDialog(),
		}));
		this.runPanel = this.pageStore.add(this.instantiationService.createInstance(WorkflowRunPanel, this.runHost, {
			workflowId: () => this.savedId ?? this.model?.definition.id,
			// Unsaved renames and new nodes show in the steps too.
			definition: () => this.model?.definition,
			onSelectNode: nodeId => {
				this.canvas?.revealNode(nodeId, true);
				this.setSideOpen(true, 'inspector');
			},
			onShowRun: run => this.showRun(run, true),
			onRetryStep: (run, nodeId) => void this.retryStep(run, nodeId),
			onRunNode: nodeId => void this.executeStep(nodeId),
			onClose: () => this.setRunOpen(false),
		}));

		this.wireCanvas();
		this.wireSashes(sideSash, runSash);
		this.renderSideTabs();
		this.renderDockStrip();
		this.pageStore.add(addDisposableListener(this.dockStrip, 'click', () => this.setRunOpen(true)));
		this.pageStore.add(this.yaml.onDidChangeIssues(() => this.runValidation()));
		this.pageStore.add(model.onDidChange(change => {
			this.validate.schedule();
			this.syncBar(change.source);
			if (change.source === 'undo' || change.source === 'redo') {
				// Undoing a delete brings the node back; show where.
				const added = change.definition.nodes.find(node => !change.previous.nodes.some(previous => previous.id === node.id));
				if (added) {
					this.canvas?.revealNode(added.id);
				}
			}
		}));
		this.pageStore.add(model.onDidChangeDirty(() => this.syncSaveState()));
		this.pageStore.add(model.onDidChangeSelection(selection => {
			// A pick opens the closed panel on the node; an open YAML tab stays (the user chose it).
			if (selection.length && !this.layoutState.sideOpen) {
				this.setSideOpen(true, 'inspector', false);
			}
			if (selection.length === 1 && this.runOpen) {
				this.runPanel?.focusNode(selection[0]);
			}
			this.renderSideTabs();
			this.inspector?.setRun(this.currentRun());
		}));
		this.pageStore.add(this.workflows.onDidChange(() => this.onStoreChange()));
		this.pageStore.add(this.automations.onDidChange(() => this.renderActive()));
		this.pageStore.add(this.host.onDidLayout(() => this.layout()));
		// The stage also changes size without the editor laying out (it was hidden, the window moved panels).
		const win = getWindow(this.root);
		const observer = new win.ResizeObserver(() => this.scheduleLayout());
		observer.observe(this.host.stage);
		this.pageStore.add(toDisposable(() => observer.disconnect()));
		this.pageStore.add(addDisposableListener(this.root, 'keydown', e => this.onKeyDown(e)));
		// Esc closes an open "Add a node" first, before the canvas (which clears its selection) or a
		// field takes it; the picker's own search handles Esc itself (clears, then closes).
		this.pageStore.add(addDisposableListener(this.root, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.picker?.isOpen && !this.pickerHost.contains(e.target as Node)) {
				e.preventDefault();
				e.stopPropagation();
				this.picker.close();
			}
		}, true));

		this.runValidation();
		this.syncBar('external');
		this.applySide();
		this.layout();
		this.syncCrumbs();
	}

	private wireCanvas(): void {
		const canvas = this.canvas!;
		const model = this.model!;
		this.pageStore.add(canvas.onDidRequestAddNode(request => {
			const add: IWorkflowAddRequest = { at: request.at, ...(request.from ? { from: request.from } : {}), ...(request.splitEdgeId ? { splitEdgeId: request.splitEdgeId } : {}) };
			if (request.via === 'menu') {
				const anchor = pointAnchor(this.root, request.client.x, request.client.y);
				showWorkflowNodeMenu(this.contextView, anchor.element, {
					definition: () => model.definition,
					sources: this.fieldSources,
					...(this.savedId ? { workflowId: this.savedId } : {}),
					onPick: block => this.addBlock(block, add),
					onHide: () => anchor.dispose(),
				});
				return;
			}
			// Beside the port "+" (or the drop point), its header level with it.
			this.openPicker(add, { x: request.client.x + 14, y: request.client.y - 18, above: request.client.y + 18 });
		}));
		this.pageStore.add(canvas.onDidRequestOpenNode(nodeId => {
			model.setSelection([nodeId]);
			this.setSideOpen(true, 'inspector');
			getWindow(this.root).requestAnimationFrame(() => this.inspector?.focus());
		}));
		this.pageStore.add(canvas.onDidRequestNodeAction(({ nodeId, action }) => {
			switch (action) {
				case 'run':
					void this.executeStep(nodeId);
					break;
				case 'ai':
					this.openDescribeDialog(nodeId);
					break;
				case 'input':
				case 'output':
					this.setRunOpen(true);
					this.runPanel?.focusNode(nodeId);
					break;
			}
		}));
		this.pageStore.add(canvas.onDidRequestEmptyAction(action => action === 'describe' ? this.openDescribeDialog() : this.host.navigate({ page: 'workflows', tab: 'templates' })));
		this.pageStore.add(canvas.onDidRequestChangeTrigger(anchor => showWorkflowTriggerMenu(this.contextView, anchor, model)));
	}

	/** Drag handles: the right panel's left edge and the executions dock's top edge. Double-click resets. */
	private wireSashes(sideSash: HTMLElement, runSash: HTMLElement): void {
		const drag = (sash: HTMLElement, kind: 'side' | 'run') => {
			this.pageStore.add(addDisposableListener(sash, 'pointerdown', (e: PointerEvent) => {
				if (e.button !== 0) {
					return;
				}
				e.preventDefault();
				sash.setPointerCapture(e.pointerId);
				sash.classList.add('active');
				this.root.classList.add('resizing');
				const start = kind === 'side' ? e.clientX : e.clientY;
				const origin = kind === 'side' ? this.side.offsetWidth : (this.runOpen ? this.dock.offsetHeight : 0);
				const move = addDisposableListener(sash, 'pointermove', (event: PointerEvent) => {
					const delta = (kind === 'side' ? event.clientX : event.clientY) - start;
					if (kind === 'side') {
						this.layoutState.side = origin - delta;
					} else {
						// Like VS Code's panel: dragged under half its minimum it closes, and opens again
						// past it; closing keeps the last height for the next open.
						const height = origin - delta;
						const open = height > RUN_MIN / 2;
						if (open !== this.runOpen) {
							this.runOpen = open;
							this.renderDockStrip();
						}
						if (open) {
							this.layoutState.run = Math.max(RUN_MIN, height);
						}
					}
					this.layout();
				});
				const up = addDisposableListener(sash, 'pointerup', () => {
					move.dispose();
					up.dispose();
					sash.classList.remove('active');
					this.root.classList.remove('resizing');
					this.storeLayout();
				});
			}));
			this.pageStore.add(addDisposableListener(sash, 'dblclick', () => {
				if (kind === 'side') {
					this.layoutState.side = SIDE_DEFAULT;
					this.storeLayout();
					this.layout();
				} else {
					this.setRunOpen(!this.runOpen);
				}
			}));
		};
		drag(sideSash, 'side');
		drag(runSash, 'run');
	}

	private scheduleLayout(): void {
		if (this.layoutPending) {
			return;
		}
		this.layoutPending = true;
		getWindow(this.root).requestAnimationFrame(() => {
			this.layoutPending = false;
			if (!this._store.isDisposed) {
				this.layout();
			}
		});
	}

	private layout(): void {
		if (!this.canvas) {
			return;
		}
		// The stage's own box: the editor can measure it while it is still hidden (and report it short).
		const reported = this.host.stageSize();
		const width = this.host.stage.clientWidth || reported.width;
		const height = this.host.stage.clientHeight || reported.height;
		const bodyHeight = Math.max(0, height - BAR_HEIGHT);
		const sideOpen = this.layoutState.sideOpen;
		const sideWidth = sideOpen ? clamp(this.layoutState.side, SIDE_MIN, Math.max(SIDE_MIN, Math.min(SIDE_MAX, width - CANVAS_MIN))) : 0;
		const centerWidth = Math.max(0, width - sideWidth);
		const dockHeight = this.runOpen ? clamp(this.layoutState.run, RUN_MIN, Math.max(RUN_MIN, bodyHeight - CANVAS_MIN)) : DOCK_STRIP;
		const canvasHeight = Math.max(0, bodyHeight - dockHeight);
		this.body.style.height = `${bodyHeight}px`;
		this.center.style.width = `${centerWidth}px`;
		this.side.style.width = `${sideWidth}px`;
		this.canvasHost.style.height = `${canvasHeight}px`;
		this.dock.style.height = `${dockHeight}px`;
		this.canvas.layout(centerWidth, canvasHeight);
		this.placePicker();
		if (this.runOpen) {
			this.runPanel?.layout(centerWidth, dockHeight);
		}
		if (sideOpen) {
			const paneHeight = Math.max(0, bodyHeight - SIDE_HEAD);
			this.inspector?.layout(sideWidth, paneHeight);
			this.yaml?.layout(sideWidth, paneHeight);
			placeTabIndicator(this.sideTabIndicator, this.sideTabButtons.get(this.layoutState.tab));
		}
		this.root.classList.toggle('narrow', width < 900);
	}

	//#endregion

	//#region Bar

	private barIcon(parent: HTMLElement, icon: ThemeIcon, label: string, run: (button: HTMLButtonElement) => void, store: DisposableStore, keybinding?: string, className = ''): HTMLButtonElement {
		const element = append(parent, $(`button.volt-wfb-icon-button${className ? `.${className}` : ''}`)) as HTMLButtonElement;
		element.type = 'button';
		element.appendChild(renderIcon(icon));
		element.setAttribute('aria-label', keybinding ? `${label} (${keybinding})` : label);
		setAgentTooltip(element, label, keybinding);
		store.add(addDisposableListener(element, 'click', e => {
			e.stopPropagation();
			if (!element.disabled) {
				run(element);
			}
		}));
		return element;
	}

	private barButton(parent: HTMLElement, icon: ThemeIcon | undefined, label: string, tooltip: string, run: (button: HTMLButtonElement) => void, store: DisposableStore, keybinding?: string, className = ''): HTMLButtonElement {
		const element = append(parent, $(`button.volt-wfb-bar-button${className ? `.${className}` : ''}`)) as HTMLButtonElement;
		element.type = 'button';
		if (icon) {
			element.appendChild(renderIcon(icon));
		}
		append(element, $('span.label')).textContent = label;
		element.setAttribute('aria-label', keybinding ? `${tooltip} (${keybinding})` : tooltip);
		setAgentTooltip(element, tooltip, keybinding);
		store.add(addDisposableListener(element, 'click', e => {
			e.stopPropagation();
			if (!element.disabled) {
				run(element);
			}
		}));
		return element;
	}

	/** A main action and a chevron that opens its variants. */
	private splitButton(parent: HTMLElement, icon: ThemeIcon, label: string, tooltip: string, keybinding: string | undefined, onMain: () => void, onMenu: (anchor: HTMLElement) => void, className: string, store: DisposableStore = this.barStore): HTMLElement {
		const group = append(parent, $(`.volt-wfb-split.${className}`));
		this.barButton(group, icon, label, tooltip, onMain, store, keybinding, 'main');
		const more = append(group, $('button.volt-wfb-bar-button.chevron')) as HTMLButtonElement;
		more.type = 'button';
		more.appendChild(renderIcon(Codicon.chevronDown));
		more.setAttribute('aria-label', localize('voltWorkflows.moreOptions', "{0} options", label));
		more.setAttribute('aria-haspopup', 'menu');
		setAgentTooltip(more, localize('voltWorkflows.moreOptions', "{0} options", label));
		store.add(addDisposableListener(more, 'click', e => {
			e.stopPropagation();
			onMenu(group);
		}));
		return group;
	}

	private renderBar(): void {
		this.barStore.clear();
		const bar = append(this.root, $('.volt-wfb-bar'));
		const left = append(bar, $('.volt-wfb-bar-left'));
		this.barIcon(left, Codicon.arrowLeft, localize('voltWorkflows.backToAutomations', "Back to Automations"), () => this.host.navigate({ page: 'list' }), this.barStore, undefined, 'volt-wfb-back');

		const title = append(left, $('.volt-wfb-title'));
		this.nameInput = append(title, $('input.volt-wfb-name')) as HTMLInputElement;
		this.nameInput.type = 'text';
		this.nameInput.spellcheck = false;
		this.nameInput.placeholder = localize('voltWorkflows.namePlaceholder', "Name this workflow");
		this.nameInput.setAttribute('aria-label', localize('voltWorkflows.workflowName', "Workflow name"));
		this.barStore.add(addDisposableListener(this.nameInput, 'input', () => this.rename(this.nameInput!.value)));
		this.barStore.add(addDisposableListener(this.nameInput, 'keydown', e => {
			if (e.key === 'Enter' || e.key === 'Escape') {
				e.preventDefault();
				this.canvas?.focus();
			}
		}));
		const switcher = this.barIcon(title, Codicon.chevronDown, localize('voltWorkflows.switchWorkflow', "Switch workflow"), anchor => this.showSwitcher(anchor), this.barStore, undefined, 'volt-wfb-switcher');
		switcher.setAttribute('aria-haspopup', 'menu');

		this.pill = append(left, $('button.volt-wfb-pill')) as HTMLButtonElement;
		this.pill.type = 'button';
		this.pill.setAttribute('aria-haspopup', 'menu');
		this.barStore.add(addDisposableListener(this.pill, 'click', () => this.showIssuesMenu()));
		this.saveStateEl = append(left, $('span.volt-wfb-save-state'));
		this.saveStateEl.setAttribute('aria-live', 'polite');
		this.backToAutomation = this.barButton(left, Codicon.zap, localize('voltWorkflows.backToAutomation', "Back to automation"), localize('voltWorkflows.backToAutomationTip', "Open the automation that runs this workflow"), () => {
			if (this.ownerAutomationId) {
				this.host.navigate({ page: 'detail', id: this.ownerAutomationId, tab: 'settings' });
			}
		}, this.barStore, undefined, 'ghost.hidden');

		const right = append(bar, $('.volt-wfb-bar-right'));
		const edit = append(right, $('.volt-wfb-bar-group'));
		this.addButton = this.barButton(edit, Codicon.add, localize('voltWorkflows.addNodeShort', "Add node"), localize('voltWorkflows.addNode', "Add a node"), () => this.togglePicker(), this.barStore, 'Tab', 'ghost.add');
		this.barIcon(edit, Codicon.typeHierarchySub, localize('voltWorkflows.autoLayout', "Auto-layout"), () => this.canvas?.autoLayout((this.model?.selection.length ?? 0) > 1), this.barStore, shortcut('L', { shift: true, alt: true, mod: false }));
		this.undoButton = this.barIcon(edit, Codicon.discard, localize('voltWorkflows.undo', "Undo"), () => this.model?.undo(), this.barStore, shortcut('Z'));
		this.redoButton = this.barIcon(edit, Codicon.redo, localize('voltWorkflows.redo', "Redo"), () => this.model?.redo(), this.barStore, shortcut('Z', { shift: true }));

		const run = append(right, $('.volt-wfb-bar-group'));
		this.simulateGroup = this.splitButton(run, Codicon.beaker, localize('voltWorkflows.simulate', "Simulate"), localize('voltWorkflows.simulateTip', "Simulate: run the graph with sample data, no side effects"), shortcut('Enter'), () => void this.simulate(), anchor => this.showSimulateMenu(anchor), 'simulate');
		this.runControls = append(run, $('.volt-wfb-run-controls'));

		const view = append(right, $('.volt-wfb-bar-group'));
		this.yamlToggle = this.barButton(view, Codicon.code, localize('voltWorkflows.yaml', "YAML"), localize('voltWorkflows.yamlTip', "Show the workflow as YAML"), () => this.toggleYaml(), this.barStore, undefined, 'ghost.toggle');
		this.runToggle = this.barIcon(view, Codicon.layoutPanel, localize('voltWorkflows.executionsPanel', "Executions panel"), () => this.setRunOpen(!this.runOpen), this.barStore, undefined, 'toggle');
		this.sideToggle = this.barIcon(view, Codicon.layoutSidebarRight, localize('voltWorkflows.inspectorPanel', "Inspector panel"), () => this.setSideOpen(!this.layoutState.sideOpen), this.barStore, undefined, 'toggle');
		const more = this.barIcon(view, Codicon.ellipsis, localize('voltWorkflows.more', "More actions"), anchor => this.showMoreMenu(anchor), this.barStore);
		more.setAttribute('aria-haspopup', 'menu');

		this.activeHost = append(right, $('.volt-wfb-active'));
		this.saveButton = this.barButton(right, undefined, localize('voltWorkflows.save', "Save"), localize('voltWorkflows.saveTip', "Save the workflow"), () => void this.save(), this.barStore, shortcut('S'), 'primary.save');
	}

	private syncBar(source: string): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const definition = model.definition;
		if (this.nameInput && source !== 'bar' && this.nameInput.value !== definition.name) {
			this.nameInput.value = definition.name;
		}
		if (this.undoButton) {
			this.undoButton.disabled = !model.canUndo;
			setAgentTooltip(this.undoButton, model.undoLabel ? localize('voltWorkflows.undoLabel', "Undo {0}", model.undoLabel) : localize('voltWorkflows.undo', "Undo"), shortcut('Z'));
		}
		if (this.redoButton) {
			this.redoButton.disabled = !model.canRedo;
			setAgentTooltip(this.redoButton, model.redoLabel ? localize('voltWorkflows.redoLabel', "Redo {0}", model.redoLabel) : localize('voltWorkflows.redo', "Redo"), shortcut('Z', { shift: true }));
		}
		this.syncSaveState();
		this.renderActive();
		this.renderRunControls();
		this.syncCrumbs();
	}

	private syncCrumbs(): void {
		const name = this.model?.definition.name.trim() || localize('voltWorkflows.untitled', "Untitled workflow");
		this.host.setCrumbs([{ label: localize('voltWorkflows.workflowsCrumb', "Workflows"), run: () => this.host.navigate({ page: 'workflows' }) }, { label: name }]);
	}

	private rename(name: string): void {
		this.model?.apply(localize('voltWorkflows.renameWorkflow', "Rename workflow"), definition => ({
			...definition,
			name,
			// Until the first save the id (the file name) follows the name.
			...(!this.savedId && name.trim() ? { id: this.freeId(name) } : {}),
		}), 'inspector', 'wf:name');
	}

	private syncSaveState(): void {
		if (!this.model || !this.saveStateEl) {
			return;
		}
		const state: SaveState = this.saveState === 'saving' ? 'saving' : !this.savedId ? 'new' : this.model.dirty ? 'dirty' : 'saved';
		const element = this.saveStateEl;
		clearNode(element);
		element.className = `volt-wfb-save-state ${state}${this.saveFlash ? ' flash' : ''}`;
		switch (state) {
			case 'saving':
				element.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
				append(element, $('span')).textContent = localize('voltWorkflows.saving', "Saving");
				break;
			case 'new':
				append(element, $('span.dot'));
				append(element, $('span')).textContent = localize('voltWorkflows.notSaved', "Not saved yet");
				break;
			case 'dirty':
				append(element, $('span.dot'));
				append(element, $('span')).textContent = localize('voltWorkflows.unsaved', "Unsaved changes");
				break;
			case 'saved':
				element.appendChild(renderIcon(Codicon.check));
				append(element, $('span')).textContent = localize('voltWorkflows.saved', "Saved");
				break;
		}
		if (this.saveButton) {
			this.saveButton.classList.toggle('dirty', state === 'dirty' || state === 'new');
			this.saveButton.disabled = state === 'saving';
		}
	}

	private renderValidity(): void {
		const pill = this.pill;
		if (!pill) {
			return;
		}
		clearNode(pill);
		const errors = this.issues.filter(issue => issue.severity === 'error').length;
		const warnings = this.issues.filter(issue => issue.severity === 'warning').length;
		pill.className = `volt-wfb-pill ${errors ? 'error' : warnings ? 'warning' : 'valid'}`;
		if (errors) {
			pill.appendChild(renderIcon(Codicon.error));
			append(pill, $('span')).textContent = errors === 1 ? localize('voltWorkflows.oneError', "1 error") : localize('voltWorkflows.errors', "{0} errors", errors);
		} else if (warnings) {
			pill.appendChild(renderIcon(Codicon.warning));
			append(pill, $('span')).textContent = warnings === 1 ? localize('voltWorkflows.oneWarning', "1 warning") : localize('voltWorkflows.warningsCount', "{0} warnings", warnings);
		} else {
			append(pill, $('span.dot'));
			append(pill, $('span')).textContent = localize('voltWorkflows.valid', "Valid");
		}
		pill.disabled = !errors && !warnings;
		setAgentTooltip(pill, errors || warnings ? localize('voltWorkflows.showIssues', "Show problems") : localize('voltWorkflows.validTip', "No problems found"));
	}

	/** `force`: the switch flipped itself on click but the change did not happen; draw it as it is. */
	private renderActive(force = false): void {
		const host = this.activeHost;
		const model = this.model;
		if (!host || !model) {
			return;
		}
		const trigger = model.definition.trigger;
		const automation = this.linkedAutomation();
		// Model changes come per drag frame; redraw only when what the switch shows changed.
		const key = `${trigger.type}:${this.savedId}:${automation?.id}:${automation?.enabled}:${describeWorkflowTrigger(trigger)}`;
		if (key === this.activeKey && !force) {
			return;
		}
		this.activeKey = key;
		clearNode(host);
		if (trigger.type === 'manual') {
			host.classList.add('hidden');
			this.activeStore.clear();
			return;
		}
		host.classList.remove('hidden');
		const label = append(host, $('span.volt-wfb-active-label'));
		label.textContent = localize('voltWorkflows.active', "Active");
		const store = this.activeStore.value = new DisposableStore();
		const toggle = toggleSwitch(host, !!automation?.enabled, localize('voltWorkflows.activeAria', "Run on its trigger"), store, on => void this.setActive(on));
		setAgentTooltip(toggle, automation
			? (automation.enabled ? localize('voltWorkflows.activeOn', "Runs on its trigger: {0}", describeWorkflowTrigger(trigger)) : localize('voltWorkflows.activeOff', "Paused: turn on to run on its trigger"))
			: localize('voltWorkflows.activeUnlinked', "Off: turn on to run on its trigger (saves first)"));
	}

	/** The automation that carries out this workflow's schedule or event (one scheduler for both). */
	private linkedAutomation(): IAutomation | undefined {
		return this.savedId ? linkedAutomation(this.automations, this.savedId) : undefined;
	}

	/** On: saved first (the schedule runs the saved workflow), then its linked automation is made or switched on. */
	private async setActive(on: boolean): Promise<void> {
		if ((this.needsSave() || !this.savedId) && !await this.save()) {
			this.renderActive(true);
			return;
		}
		try {
			const automation = await setWorkflowActive(this.automations, this.workflows, this.savedId!, on);
			if (on && !automation) {
				this.notifications.warn(localize('voltWorkflows.noTriggerYet', "Finish the trigger first: a schedule needs a cron or an interval, an event needs a service and an event."));
			}
		} catch (err) {
			this.notifications.error(err instanceof Error ? err.message : String(err));
		}
		this.renderActive(true);
	}

	private renderRunControls(): void {
		const host = this.runControls;
		if (!host) {
			return;
		}
		const run = this.execution?.run;
		const live = isLive(run);
		const paused = live && (!!this.execution?.paused || run?.status === 'paused');
		const key = `${live}:${paused}`;
		if (key === this.runControlsKey) {
			return;
		}
		this.runControlsKey = key;
		clearNode(host);
		const store = this.runControlsStore.value = new DisposableStore();
		this.simulateGroup?.classList.toggle('disabled', live);
		for (const button of this.simulateGroup?.querySelectorAll('button') ?? []) {
			(button as HTMLButtonElement).disabled = live;
		}
		if (!live) {
			this.splitButton(host, Codicon.play, localize('voltWorkflows.run', "Run"), localize('voltWorkflows.runTip', "Run for real (saves first)"), shortcut('Enter', { shift: true }), () => void this.runForReal(), anchor => this.showRunMenu(anchor), 'run', store);
			return;
		}
		if (paused) {
			this.barButton(host, Codicon.debugStepOver, localize('voltWorkflows.step', "Step"), localize('voltWorkflows.stepTip', "Run the next node, then pause"), () => this.execution?.step(), store, 'F10');
			this.barButton(host, Codicon.debugContinue, localize('voltWorkflows.resume', "Resume"), localize('voltWorkflows.resumeTip', "Run on to the end"), () => this.execution?.resume(), store, 'F5');
		} else {
			this.barIcon(host, Codicon.debugPause, localize('voltWorkflows.pause', "Pause"), () => this.execution?.pause(), store, 'F6');
		}
		this.barButton(host, Codicon.debugStop, localize('voltWorkflows.stop', "Stop"), localize('voltWorkflows.stopTip', "Cancel this run"), () => this.execution?.cancel(), store, shortcut('.'), 'danger');
	}

	/** The tabs' labels ("Node" with a selection) and the active one, its bar under it. */
	private renderSideTabs(): void {
		const selection = this.model?.selection.length ?? 0;
		const labels: Record<SideTab, string> = {
			inspector: selection ? localize('voltWorkflows.tabNode', "Node") : localize('voltWorkflows.tabWorkflow', "Workflow"),
			yaml: localize('voltWorkflows.yaml', "YAML"),
		};
		for (const [tab, button] of this.sideTabButtons) {
			button.textContent = labels[tab];
			button.classList.toggle('active', tab === this.layoutState.tab);
			button.setAttribute('aria-selected', String(tab === this.layoutState.tab));
		}
		placeTabIndicator(this.sideTabIndicator, this.sideTabButtons.get(this.layoutState.tab));
	}

	private renderDockStrip(): void {
		const strip = this.dockStrip;
		clearNode(strip);
		strip.classList.toggle('hidden', this.runOpen);
		this.runHost.classList.toggle('hidden', !this.runOpen);
		this.dock.classList.toggle('open', this.runOpen);
		this.runToggle?.classList.toggle('on', this.runOpen);
		strip.appendChild(renderIcon(Codicon.chevronUp));
		append(strip, $('span.title')).textContent = localize('voltWorkflows.executions', "Executions");
		const run = this.currentRun();
		if (run) {
			const status = append(strip, $(`span.volt-wfb-strip-status.${run.status}`));
			status.appendChild(renderIcon(isLive(run) ? ThemeIcon.modify(Codicon.loading, 'spin') : run.status === 'succeeded' ? Codicon.passFilled : run.status === 'failed' ? Codicon.error : Codicon.circleSlash));
			append(status, $('span')).textContent = `${run.mode === 'simulate' ? localize('voltWorkflows.simulationLabel', "Simulation") : localize('voltWorkflows.runLabel', "Run")} · ${run.status} · ${formatAgo(run.startedAt)}`;
		} else {
			append(strip, $('span.muted')).textContent = localize('voltWorkflows.noRunsYet', "Simulate to see each step's input and output");
		}
		setAgentTooltip(strip, localize('voltWorkflows.openExecutions', "Open the executions panel"));
	}

	//#endregion

	//#region Panels

	private setSideOpen(open: boolean, tab?: SideTab, focus = true): void {
		const changed = open !== this.layoutState.sideOpen || (tab !== undefined && tab !== this.layoutState.tab);
		this.layoutState.sideOpen = open;
		if (tab) {
			this.layoutState.tab = tab;
		}
		if (!changed) {
			this.renderSideTabs();
			return;
		}
		this.storeLayout();
		this.applySide();
		this.layout();
		if (open && focus && tab === 'yaml') {
			this.yaml?.focus();
		}
	}

	private applySide(): void {
		const open = this.layoutState.sideOpen;
		const yaml = this.layoutState.tab === 'yaml';
		this.side.classList.toggle('hidden', !open);
		this.inspectorHost.classList.toggle('hidden', yaml);
		this.yamlHost.classList.toggle('hidden', !yaml);
		this.yaml?.setVisible(open && yaml);
		this.yamlToggle?.classList.toggle('on', open && yaml);
		this.sideToggle?.classList.toggle('on', open);
		this.renderSideTabs();
	}

	private toggleYaml(): void {
		if (this.layoutState.sideOpen && this.layoutState.tab === 'yaml') {
			this.setSideOpen(true, 'inspector');
		} else {
			this.setSideOpen(true, 'yaml');
		}
	}

	private setRunOpen(open: boolean): void {
		if (open === this.runOpen) {
			return;
		}
		this.runOpen = open;
		this.renderDockStrip();
		this.layout();
	}

	/** The Add button / Tab: closes the docked panel, or docks it (an open dropdown moves there). */
	private togglePicker(): void {
		if (this.picker?.isOpen && this.pickerDocked) {
			this.picker.close();
		} else {
			this.openPicker();
		}
	}

	/**
	 * Opens "Add a node": a dropdown at `anchor` for a canvas request (beside the port or drop), or the
	 * panel docked over the canvas's left edge from the Add button / Tab (after the selected node, or
	 * in the middle of the view). A docked panel stays docked when a port re-targets it.
	 */
	private openPicker(request?: IWorkflowAddRequest, anchor?: { readonly x: number; readonly y: number; readonly above: number }): void {
		const model = this.model;
		const canvas = this.canvas;
		if (!model || !canvas || !this.picker) {
			return;
		}
		let target = request;
		if (!target) {
			const definition = model.definition;
			const ports = (node: IWorkflowNode) => getWorkflowNodeType(node.type)?.outputs(node.config) ?? [];
			const free = (node: IWorkflowNode) => ports(node).find(entry => !definition.edges.some(edge => edge.from === node.id && edge.port === entry.id));
			// After the selected node; with none selected, the chain goes on from its rightmost loose end.
			const selected = model.selection.length === 1 ? model.node(model.selection[0]) : undefined;
			const after = selected ?? [...definition.nodes].sort((a, b) => b.position.x - a.position.x).find(node => !!free(node));
			const port = after ? free(after) ?? ports(after)[0] : undefined;
			if (after && port) {
				const below = definition.nodes.filter(node => Math.abs(node.position.x - (after.position.x + 320)) < 200 && Math.abs(node.position.y - after.position.y) < 120).length;
				target = { at: { x: after.position.x + 320, y: after.position.y + below * 140 }, from: { nodeId: after.id, port: port.id } };
			} else {
				const rect = this.canvasHost.getBoundingClientRect();
				const at = canvas.clientToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
				target = { at: { x: Math.round(at.x - 120), y: Math.round(at.y - 26) } };
			}
		}
		this.pickerDocked = !anchor || (this.picker.isOpen && this.pickerDocked);
		this.pickerAnchor = this.pickerDocked ? undefined : anchor;
		this.pickerHost.classList.toggle('docked', this.pickerDocked);
		this.pickerHost.classList.add('open');
		if (this.picker.isOpen) {
			this.picker.retarget(target);
			this.picker.focus();
			this.placePicker();
		} else {
			this.picker.open(target);
		}
	}

	/**
	 * Docked: the canvas's full height at its left edge. A dropdown: under its anchor (over it when
	 * short of room below), kept inside the canvas.
	 */
	private placePicker(): void {
		if (!this.picker?.isOpen) {
			return;
		}
		if (this.pickerDocked) {
			const height = this.canvasHost.offsetHeight;
			this.pickerHost.style.left = '0px';
			this.pickerHost.style.top = '0px';
			this.pickerHost.style.width = `${PICKER_DOCK_WIDTH}px`;
			this.pickerHost.style.height = `${height}px`;
			this.picker.layout(height, true);
			return;
		}
		const anchor = this.pickerAnchor;
		if (!anchor) {
			return;
		}
		const margin = 8;
		const bounds = this.canvasHost.getBoundingClientRect();
		const origin = this.center.getBoundingClientRect();
		const width = Math.max(0, Math.min(PICKER_WIDTH, bounds.width - margin * 2));
		this.pickerHost.style.width = `${width}px`;
		this.pickerHost.style.height = '';
		const height = this.picker.layout(Math.min(PICKER_MAX_HEIGHT, Math.max(0, bounds.height - margin * 2)));
		const below = bounds.bottom - margin - anchor.y;
		const over = anchor.above - (bounds.top + margin);
		const top = clamp(height <= below || below >= over ? anchor.y : anchor.above - height, bounds.top + margin, Math.max(bounds.top + margin, bounds.bottom - margin - height));
		const left = clamp(anchor.x, bounds.left + margin, Math.max(bounds.left + margin, bounds.right - margin - width));
		this.pickerHost.style.left = `${Math.round(left - origin.left)}px`;
		this.pickerHost.style.top = `${Math.round(top - origin.top)}px`;
	}

	private addBlock(block: IWorkflowBlock, request: IWorkflowAddRequest): void {
		if (!this.model) {
			return;
		}
		this.afterAdd(addWorkflowBlock(this.model, block, request));
	}

	private afterAdd(nodeId: string | undefined): void {
		this.canvas?.clearPendingConnection();
		if (!nodeId) {
			return;
		}
		this.canvas?.revealNode(nodeId, true);
		this.setSideOpen(true, 'inspector', false);
		this.canvas?.focus();
	}

	private revealIssue(issue: IWorkflowIssue): void {
		if (issue.nodeId && this.model?.node(issue.nodeId)) {
			this.canvas?.revealNode(issue.nodeId, true);
			this.setSideOpen(true, 'inspector', false);
			if (issue.field) {
				getWindow(this.root).requestAnimationFrame(() => this.inspector?.focusField(issue.field!));
			}
			return;
		}
		if (issue.line !== undefined) {
			this.setSideOpen(true, 'yaml');
			this.yaml?.reveal(issue);
			return;
		}
		this.model?.setSelection([]);
		this.setSideOpen(true, 'inspector', false);
	}

	//#endregion

	//#region Menus

	private showSwitcher(anchor: HTMLElement): void {
		type Pick = { readonly kind: 'open'; readonly id: string } | { readonly kind: 'new' } | { readonly kind: 'library' };
		const current = this.savedId;
		const item = (summary: IWorkflowSummary): IVoltMenuItem<Pick> => {
			const last = summary.lastRun ? `${summary.lastRun.status} ${formatAgo(summary.lastRun.at)}` : localize('voltWorkflows.neverRun', "never run");
			return {
				id: summary.id,
				label: summary.name,
				subtitle: `${describeWorkflowTrigger(summary.trigger)} · ${last}`,
				icon: Codicon.typeHierarchySub,
				checked: summary.id === current,
				keywords: `${summary.id} ${summary.description ?? ''}`,
				...(summary.issues ? { badge: String(summary.issues) } : {}),
				data: { kind: 'open', id: summary.id },
			};
		};
		showVoltMenu<Pick>(this.contextView, {
			anchor,
			gap: 6,
			width: 340,
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: localize('voltWorkflows.switchWorkflow', "Switch workflow"),
			search: { placeholder: localize('voltWorkflows.searchWorkflows', "Search workflows"), icon: true },
			sections: [{
				id: 'workflows',
				title: localize('voltWorkflows.yourWorkflowsTitle', "Your workflows"),
				emptyMessage: localize('voltWorkflows.noWorkflows', "No saved workflows yet."),
				items: [...this.workflows.list()].sort((a, b) => b.updatedAt - a.updatedAt).map(item),
			}],
			footer: [
				{ id: 'new', label: localize('voltWorkflows.newWorkflow', "New workflow"), icon: Codicon.add, data: { kind: 'new' } },
				{ id: 'library', label: localize('voltWorkflows.allWorkflows', "All workflows"), icon: Codicon.library, className: 'volt-auto-footer-end', data: { kind: 'library' } },
			],
			onPick: picked => {
				const data = picked.data;
				if (data.kind === 'open' && data.id !== current) {
					this.host.navigate({ page: 'workflow', id: data.id });
				} else if (data.kind === 'new') {
					this.host.navigate({ page: 'workflow' });
				} else if (data.kind === 'library') {
					this.host.navigate({ page: 'workflows' });
				}
			},
		});
	}

	private showIssuesMenu(): void {
		const pill = this.pill;
		if (!pill || !this.issues.length) {
			return;
		}
		const nodes = this.model?.definition.nodes ?? [];
		const item = (issue: IWorkflowIssue, index: number): IVoltMenuItem<IWorkflowIssue> => {
			const node = issue.nodeId ? nodes.find(entry => entry.id === issue.nodeId) : undefined;
			const where = [node ? nodeDisplayName(node) : issue.nodeId, issue.field, issue.line ? localize('voltWorkflows.line', "line {0}", issue.line) : undefined].filter(Boolean).join(' · ');
			return {
				id: `${index}`,
				label: issue.message,
				...(where ? { subtitle: where } : {}),
				icon: issue.severity === 'error' ? Codicon.error : issue.severity === 'warning' ? Codicon.warning : Codicon.info,
				className: `volt-wfb-issue-item ${issue.severity}`,
				tooltip: issue.message,
				data: issue,
			};
		};
		const errors = this.issues.filter(issue => issue.severity === 'error');
		const warnings = this.issues.filter(issue => issue.severity !== 'error');
		const sections: IVoltMenuSection<IWorkflowIssue>[] = [
			...(errors.length ? [{ id: 'errors', title: localize('voltWorkflows.errorsTitle', "Errors"), items: errors.map(item) }] : []),
			...(warnings.length ? [{ id: 'warnings', title: localize('voltWorkflows.warningsTitle', "Warnings"), items: warnings.map((issue, i) => item(issue, errors.length + i)) }] : []),
		];
		showVoltMenu<IWorkflowIssue>(this.contextView, {
			anchor: pill,
			gap: 6,
			width: 380,
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: localize('voltWorkflows.problems', "Problems"),
			search: this.issues.length > 8 ? { placeholder: localize('voltWorkflows.searchProblems', "Search problems"), icon: true } : undefined,
			sections,
			onPick: picked => this.revealIssue(picked.data),
		});
	}

	private showSimulateMenu(anchor: HTMLElement): void {
		type Pick = 'simulate' | 'step' | 'failures' | 'payload';
		showVoltMenu<Pick>(this.contextView, {
			anchor,
			gap: 6,
			width: 280,
			align: 'right',
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: localize('voltWorkflows.simulateOptions', "Simulate options"),
			sections: [{
				id: 'simulate',
				items: [
					{ id: 'simulate', label: localize('voltWorkflows.simulate', "Simulate"), subtitle: localize('voltWorkflows.simulateDesc', "Sample data, no side effects"), icon: Codicon.beaker, keybinding: shortcut('Enter'), data: 'simulate' },
					{ id: 'step', label: localize('voltWorkflows.stepThrough', "Step through"), subtitle: localize('voltWorkflows.stepThroughDesc', "Pause before every node"), icon: Codicon.debugStepOver, data: 'step' },
					{ id: 'failures', label: localize('voltWorkflows.simulateFailures', "Simulate with failures"), subtitle: this.failNodes.size ? localize('voltWorkflows.failingCount', "{0} nodes fail", this.failNodes.size) : localize('voltWorkflows.simulateFailuresDesc', "Pick nodes that fail, to test error paths"), icon: Codicon.bug, data: 'failures' },
				],
			}, {
				id: 'data',
				items: [{ id: 'payload', label: localize('voltWorkflows.editPayload', "Edit mock payload"), subtitle: localize('voltWorkflows.editPayloadDesc', "What the trigger sends in simulations"), icon: Codicon.json, data: 'payload' }],
			}],
			onPick: picked => {
				switch (picked.data) {
					case 'simulate':
						void this.simulate();
						break;
					case 'step':
						void this.simulate({ stepping: true });
						break;
					case 'failures':
						this.showFailureMenu(anchor);
						break;
					case 'payload':
						this.openPayloadDialog();
						break;
				}
			},
		});
	}

	/** Pick the nodes that fail (checks stay as the menu stays open), then simulate. */
	private showFailureMenu(anchor: HTMLElement): void {
		const model = this.model;
		if (!model) {
			return;
		}
		type Pick = { readonly kind: 'node'; readonly id: string } | { readonly kind: 'run' } | { readonly kind: 'clear' };
		const handle = showVoltMenu<Pick>(this.contextView, {
			anchor,
			gap: 6,
			width: 300,
			align: 'right',
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: localize('voltWorkflows.failingNodes', "Nodes that fail"),
			heading: { title: () => localize('voltWorkflows.failingHeading', "Nodes that fail ({0})", this.failNodes.size) },
			search: { placeholder: localize('voltWorkflows.searchNodes', "Search nodes"), icon: true },
			sections: () => [{
				id: 'nodes',
				items: model.definition.nodes.filter(node => getWorkflowNodeType(node.type)?.control !== 'start' && getWorkflowNodeType(node.type)?.control !== 'end').map(node => ({
					id: node.id,
					label: nodeDisplayName(node),
					description: node.id,
					checked: this.failNodes.has(node.id),
					keepOpen: true,
					data: { kind: 'node' as const, id: node.id },
				})),
			}],
			footer: [
				{ id: 'run', label: localize('voltWorkflows.simulateNow', "Simulate"), icon: Codicon.beaker, data: { kind: 'run' } },
				{ id: 'clear', label: localize('voltWorkflows.clearFailures', "Clear"), keepOpen: true, className: 'volt-auto-footer-end', data: { kind: 'clear' } },
			],
			onPick: picked => {
				const data = picked.data;
				if (data.kind === 'node') {
					if (this.failNodes.has(data.id)) {
						this.failNodes.delete(data.id);
					} else {
						this.failNodes.add(data.id);
					}
					handle.refresh();
				} else if (data.kind === 'clear') {
					this.failNodes.clear();
					handle.refresh();
				} else {
					void this.simulate({ failNodes: [...this.failNodes] });
				}
			},
		});
	}

	private showRunMenu(anchor: HTMLElement): void {
		showVoltMenu<'run' | 'step'>(this.contextView, {
			anchor,
			gap: 6,
			width: 280,
			align: 'right',
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: localize('voltWorkflows.runOptions', "Run options"),
			sections: [{
				id: 'run',
				items: [
					{ id: 'run', label: localize('voltWorkflows.run', "Run"), subtitle: localize('voltWorkflows.runDesc', "For real: agents, shell, git, messages"), icon: Codicon.play, keybinding: shortcut('Enter', { shift: true }), data: 'run' },
					{ id: 'step', label: localize('voltWorkflows.runStepByStep', "Run step by step"), subtitle: localize('voltWorkflows.runStepByStepDesc', "For real, pausing before every node"), icon: Codicon.debugStepOver, data: 'step' },
				],
			}],
			onPick: picked => void this.runForReal(picked.data === 'step'),
		});
	}

	private showMoreMenu(anchor: HTMLElement): void {
		type Pick =
			| { readonly kind: 'import' | 'paste' | 'copy' | 'export' | 'duplicate' | 'delete' | 'trust' | 'describe' | 'templates' }
			| { readonly kind: 'rev-open' | 'rev-restore'; readonly revision: number };
		const saved = !!this.savedId;
		const id = this.savedId;
		const definition = this.model?.definition;
		const untrusted = !!definition && !this.workflows.isTrusted(definition);
		showVoltMenu<Pick>(this.contextView, {
			anchor,
			gap: 6,
			width: 280,
			align: 'right',
			className: 'volt-auto-menu volt-wfb-menu',
			ariaLabel: localize('voltWorkflows.more', "More actions"),
			sections: [
				{
					id: 'build',
					items: [
						{ id: 'describe', label: localize('voltWorkflows.describe', "Build from a description"), icon: Codicon.comment, data: { kind: 'describe' } },
						{ id: 'templates', label: localize('voltWorkflows.browseTemplates', "Browse templates"), icon: Codicon.library, data: { kind: 'templates' } },
					],
				},
				{
					id: 'yaml',
					items: [
						{ id: 'import', label: localize('voltWorkflows.importFile', "Import YAML file"), icon: Codicon.folderOpened, data: { kind: 'import' } },
						{ id: 'paste', label: localize('voltWorkflows.pasteYaml', "Paste YAML"), icon: Codicon.clippy, data: { kind: 'paste' } },
						{ id: 'copy', label: localize('voltWorkflows.copyYamlMenu', "Copy YAML"), icon: Codicon.copy, data: { kind: 'copy' } },
						{ id: 'export', label: localize('voltWorkflows.exportYaml', "Export YAML"), icon: Codicon.desktopDownload, data: { kind: 'export' } },
					],
				},
				{
					id: 'manage',
					items: [
						{ id: 'duplicate', label: localize('voltWorkflows.duplicate', "Duplicate"), icon: Codicon.copy, disabled: !saved, data: { kind: 'duplicate' } },
						{
							id: 'revisions', label: localize('voltWorkflows.revisions', "Revision history"), icon: Codicon.history, disabled: !saved, data: { kind: 'copy' },
							...(id ? {
								submenu: {
									width: 260,
									className: 'volt-auto-menu volt-wfb-menu',
									emptyMessage: localize('voltWorkflows.noRevisions', "No earlier revisions yet."),
									sections: async (): Promise<IVoltMenuSection<Pick>[]> => {
										const revisions = await this.workflows.revisions(id).catch(() => []);
										const current = this.model?.definition.revision;
										return [{
											id: 'revisions',
											items: [...revisions].sort((a, b) => b.revision - a.revision).map(revision => ({
												id: `rev-${revision.revision}`,
												label: localize('voltWorkflows.revisionLabel', "Revision {0}", revision.revision),
												subtitle: [formatAgo(revision.at), revision.message].filter(Boolean).join(' · '),
												...(revision.revision === current ? { detail: localize('voltWorkflows.currentRevision', "current") } : {}),
												data: { kind: 'rev-open' as const, revision: revision.revision },
												submenu: {
													width: 200,
													className: 'volt-auto-menu volt-wfb-menu',
													sections: [{
														id: 'actions',
														items: [
															{ id: 'open', label: localize('voltWorkflows.openReadOnly', "Open read-only"), icon: Codicon.eye, data: { kind: 'rev-open' as const, revision: revision.revision } },
															{ id: 'restore', label: localize('voltWorkflows.restore', "Restore"), icon: Codicon.discard, disabled: revision.revision === current, data: { kind: 'rev-restore' as const, revision: revision.revision } },
														],
													}],
												},
											})),
										}];
									},
								},
							} : {}),
						},
						...(untrusted ? [{ id: 'trust', label: localize('voltWorkflows.trustMenu', "Trust this workflow"), icon: Codicon.shield, data: { kind: 'trust' as const } }] : []),
					],
				},
				{
					id: 'danger',
					items: [{ id: 'delete', label: localize('voltWorkflows.deleteWorkflow', "Delete workflow"), icon: Codicon.trash, disabled: !saved, className: 'volt-wfb-danger-item', data: { kind: 'delete' } }],
				},
			],
			onPick: picked => {
				const data = picked.data;
				switch (data.kind) {
					case 'describe': this.openDescribeDialog(); break;
					case 'templates': this.host.navigate({ page: 'workflows', tab: 'templates' }); break;
					case 'import': void this.importFile(); break;
					case 'paste': void this.openPasteDialog(); break;
					case 'copy': void this.clipboard.writeText(this.currentYaml()); break;
					case 'export': void this.exportFile(); break;
					case 'duplicate': void this.duplicate(); break;
					case 'delete': void this.deleteWorkflow(); break;
					case 'trust': if (definition) { void this.workflows.trust(definition); } break;
					case 'rev-open': void this.openRevision(data.revision); break;
					case 'rev-restore': void this.restoreRevision(data.revision); break;
				}
			},
		});
	}

	//#endregion

	//#region Save and files

	private currentYaml(): string {
		return this.yaml?.syncedText ?? serializeWorkflow(this.model!.definition);
	}

	/** Saves (the YAML text when it is in step, so comments stay). True when saved. */
	private async save(): Promise<boolean> {
		const model = this.model;
		if (!model || this.saveState === 'saving') {
			return false;
		}
		const sent = model.definition;
		const text = this.yaml?.syncedText;
		this.saveState = 'saving';
		this.syncSaveState();
		try {
			const result = text && this.savedId ? await this.workflows.saveYaml(text, this.savedId) : await this.workflows.save(sent);
			const saved = result.definition;
			if (!saved) {
				const first = result.issues.find(issue => issue.severity === 'error');
				this.notifications.error(localize('voltWorkflows.saveFailed', "Could not save the workflow: {0}", first?.message ?? localize('voltWorkflows.unknownError', "unknown error")));
				return false;
			}
			const first = !this.savedId;
			this.savedId = saved.id;
			this.seeded = false;
			const latest = model.definition;
			model.markSaved(saved);
			if (latest !== sent) {
				// Edits made while the save ran stay, on top of the saved revision.
				model.replace({ ...latest, id: saved.id, revision: saved.revision }, 'external', { undoable: false });
			} else {
				const stored = this.workflows.getYaml(saved.id);
				if (stored) {
					this.yaml?.resetText(stored);
				}
			}
			if (first) {
				this.host.setRoute({ page: 'workflow', id: saved.id });
				if (this.ownerAutomationId) {
					await this.automations.update(this.ownerAutomationId, { workflowId: saved.id }).catch(err => this.notifications.error(err));
					this.backToAutomation?.classList.remove('hidden');
				}
			}
			this.flashSaved();
			return true;
		} catch (err) {
			this.notifications.error(localize('voltWorkflows.saveFailed', "Could not save the workflow: {0}", err instanceof Error ? err.message : String(err)));
			return false;
		} finally {
			this.saveState = 'saved';
			this.syncSaveState();
			this.renderActive();
		}
	}

	private flashSaved(): void {
		if (this.saveFlash) {
			clearTimeout(this.saveFlash);
		}
		this.saveFlash = setTimeout(() => {
			this.saveFlash = undefined;
			this.syncSaveState();
		}, 1600);
		this.syncSaveState();
	}

	/** Another window (or the agent tools) changed the stored workflow: take it when nothing here is unsaved. */
	private onStoreChange(): void {
		const model = this.model;
		const id = this.savedId;
		if (!model || !id || model.dirty || this.saveState === 'saving') {
			return;
		}
		const stored = this.workflows.get(id);
		if (stored && stored.revision !== model.definition.revision) {
			model.replace(stored, 'external', { undoable: false });
			model.markSaved(stored);
			const text = this.workflows.getYaml(id);
			if (text) {
				this.yaml?.resetText(text);
			}
		}
	}

	private async importFile(): Promise<void> {
		const picked = await this.fileDialogs.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: localize('voltWorkflows.importTitle', "Import a workflow"),
			filters: [{ name: localize('voltWorkflows.yamlFiles', "Workflow YAML"), extensions: ['yaml', 'yml'] }],
		});
		const uri = picked?.[0];
		if (!uri) {
			return;
		}
		try {
			const text = (await this.fileService.readFile(uri)).value.toString();
			await this.openPasteDialog(text, localize('voltWorkflows.importFrom', "From {0}", uri.path.split('/').pop() ?? ''));
		} catch (err) {
			this.notifications.error(localize('voltWorkflows.importFailed', "Could not read the file: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	private async exportFile(): Promise<void> {
		const definition = this.model?.definition;
		if (!definition) {
			return;
		}
		const base = await this.fileDialogs.defaultFilePath();
		const target = await this.fileDialogs.showSaveDialog({
			title: localize('voltWorkflows.exportTitle', "Export workflow"),
			defaultUri: joinPath(base, `${definition.id || 'workflow'}.yaml`),
			filters: [{ name: localize('voltWorkflows.yamlFiles', "Workflow YAML"), extensions: ['yaml', 'yml'] }],
		});
		if (target) {
			await this.fileService.writeFile(target, VSBuffer.fromString(this.currentYaml()));
		}
	}

	private async duplicate(): Promise<void> {
		if (!this.savedId) {
			return;
		}
		if (this.model?.dirty && !await this.save()) {
			return;
		}
		const copy = await this.workflows.duplicate(this.savedId);
		if (copy) {
			this.host.navigate({ page: 'workflow', id: copy.id });
		}
	}

	private async deleteWorkflow(): Promise<void> {
		const id = this.savedId;
		const model = this.model;
		if (!id || !model) {
			return;
		}
		const automation = this.linkedAutomation();
		const { confirmed } = await this.dialogs.confirm({
			type: 'warning',
			message: localize('voltWorkflows.deleteConfirm', "Delete \"{0}\"?", model.definition.name),
			detail: automation
				? localize('voltWorkflows.deleteLinked', "Its schedule (the automation \"{0}\") stops too. Its runs stay in history.", automation.name)
				: localize('voltWorkflows.deleteDetail', "Its file and revision history are removed. Its runs stay in history."),
			primaryButton: localize('voltWorkflows.deleteButton', "Delete"),
		});
		if (!confirmed) {
			return;
		}
		await this.workflows.delete(id);
		// Nothing left to lose: leave without asking.
		model.markSaved();
		this.seeded = false;
		this.host.navigate({ page: 'workflows' });
	}

	private async openRevision(revision: number): Promise<void> {
		const id = this.savedId;
		if (!id) {
			return;
		}
		const text = await this.workflows.readRevision(id, revision);
		if (text === undefined) {
			this.notifications.warn(localize('voltWorkflows.revisionMissing', "Revision {0} is no longer kept.", revision));
			return;
		}
		const dialog = showAutomationDialog(this.host.stage, localize('voltWorkflows.revisionTitle', "Revision {0}", revision), localize('voltWorkflows.revisionSubtitle', "Read-only. Restore it to edit it again."), 'volt-wfb-dialog wide');
		dialog.store.add(this.instantiationService.createInstance(WorkflowCodeEditor, dialog.body, { value: text, language: 'yaml', readOnly: true, ariaLabel: localize('voltWorkflows.revisionTitle', "Revision {0}", revision), height: 420 }));
		const close = dialog.store.add(createVoltButton(dialog.footer, 'secondary'));
		close.label = localize('voltWorkflows.close', "Close");
		dialog.store.add(close.onDidClick(() => dialog.close()));
		const copy = dialog.store.add(createVoltButton(dialog.footer, 'secondary'));
		copy.label = localize('voltWorkflows.copyYamlMenu', "Copy YAML");
		dialog.store.add(copy.onDidClick(() => void this.clipboard.writeText(text)));
		const restore = dialog.store.add(createVoltButton(dialog.footer, 'primary'));
		restore.label = localize('voltWorkflows.restoreRevision', "Restore this revision");
		restore.enabled = revision !== this.model?.definition.revision;
		dialog.store.add(restore.onDidClick(() => {
			dialog.close();
			void this.restoreRevision(revision, text);
		}));
	}

	/** Puts an old revision on the canvas as one undoable step; Save makes it the newest revision. */
	private async restoreRevision(revision: number, known?: string): Promise<void> {
		const id = this.savedId;
		const model = this.model;
		if (!id || !model) {
			return;
		}
		const text = known ?? await this.workflows.readRevision(id, revision);
		const parsed = text !== undefined ? this.workflows.parse(text) : undefined;
		if (!parsed?.definition) {
			this.notifications.error(localize('voltWorkflows.revisionUnreadable', "Revision {0} could not be read.", revision));
			return;
		}
		model.replace({ ...parsed.definition, id, revision: model.definition.revision }, 'external', { label: localize('voltWorkflows.restoreLabel', "Restore revision {0}", revision) });
		this.notifications.info(localize('voltWorkflows.restored', "Revision {0} is on the canvas. Save to keep it, or undo.", revision));
	}

	/**
	 * Paste a workflow: a YAML box with a live check. A new page takes it as its workflow; a saved
	 * one asks to replace (undoable) or saves it as a new workflow. Pasted workflows are marked
	 * imported, so they are reviewed before their first real run.
	 */
	private async openPasteDialog(prefill?: string, subtitle?: string): Promise<void> {
		const model = this.model;
		if (!model) {
			return;
		}
		let text = prefill;
		if (text === undefined) {
			const clip = await this.clipboard.readText().catch(() => '');
			text = this.workflows.parse(clip).definition ? clip : '';
		}
		const dialog = showAutomationDialog(this.host.stage, localize('voltWorkflows.pasteTitle', "Paste a workflow"), subtitle ?? localize('voltWorkflows.pasteSubtitle', "Paste workflow YAML: from a file, a teammate or a template repository."), 'volt-wfb-dialog wide');
		const area = dialog.store.add(this.instantiationService.createInstance(WorkflowCodeEditor, dialog.body, { value: text, language: 'yaml', ariaLabel: localize('voltWorkflows.pasteTitle', "Paste a workflow"), height: 340 }));
		const status = append(dialog.body, $('.volt-wfb-paste-status'));
		const buttons: { readonly enabled: boolean; set(enabled: boolean): void }[] = [];
		let parsed: IWorkflowDefinition | undefined;
		const check = () => {
			clearNode(status);
			const value = area.value.trim();
			parsed = undefined;
			if (!value) {
				status.className = 'volt-wfb-paste-status muted';
				append(status, $('span')).textContent = localize('voltWorkflows.pasteEmpty', "Waiting for YAML");
			} else {
				const result = this.workflows.parse(value);
				parsed = result.definition;
				const errors = result.issues.filter(issue => issue.severity === 'error');
				status.className = `volt-wfb-paste-status ${parsed ? (errors.length ? 'warning' : 'ok') : 'error'}`;
				status.appendChild(renderIcon(parsed ? (errors.length ? Codicon.warning : Codicon.check) : Codicon.error));
				append(status, $('span')).textContent = parsed
					? localize('voltWorkflows.pasteSummary', "\"{0}\": {1} nodes{2}", parsed.name, parsed.nodes.length, result.issues.length ? localize('voltWorkflows.pasteIssues', ", {0} problems (fix them after importing)", result.issues.length) : '')
					: (errors[0]?.line ? localize('voltWorkflows.pasteErrorAt', "Line {0}: {1}", errors[0].line, errors[0].message) : errors[0]?.message ?? localize('voltWorkflows.pasteInvalid', "Not a workflow"));
			}
			buttons.forEach(button => button.set(!!parsed));
		};
		dialog.store.add(area.onDidChange(check));
		const cancel = dialog.store.add(createVoltButton(dialog.footer, 'secondary'));
		cancel.label = localize('voltWorkflows.cancel', "Cancel");
		dialog.store.add(cancel.onDidClick(() => dialog.close()));
		const addButton = (label: string, kind: 'primary' | 'secondary', run: (definition: IWorkflowDefinition, yaml: string) => void | Promise<void>) => {
			const button = dialog.store.add(createVoltButton(dialog.footer, kind));
			button.label = label;
			buttons.push({ get enabled() { return button.enabled; }, set: enabled => button.enabled = enabled });
			dialog.store.add(button.onDidClick(async () => {
				if (parsed) {
					const definition = parsed;
					dialog.close();
					await run(definition, area.value);
				}
			}));
		};
		const imported = (definition: IWorkflowDefinition): IWorkflowDefinition['source'] => definition.source?.kind === 'community' ? definition.source : { ...definition.source, kind: 'import' };
		if (this.savedId) {
			addButton(localize('voltWorkflows.saveAsNew', "Save as new workflow"), 'secondary', async (_definition, yaml) => {
				const result = await this.workflows.saveYaml(yaml);
				if (result.definition) {
					this.host.navigate({ page: 'workflow', id: result.definition.id });
				} else {
					this.notifications.error(localize('voltWorkflows.saveFailed', "Could not save the workflow: {0}", result.issues[0]?.message ?? ''));
				}
			});
			addButton(localize('voltWorkflows.replaceWorkflow', "Replace this workflow"), 'primary', definition => {
				model.replace({ ...definition, id: this.savedId!, revision: model.definition.revision, source: imported(definition) }, 'external', { label: localize('voltWorkflows.pasteLabel', "Paste workflow") });
				this.canvas?.fitView(true);
			});
		} else {
			addButton(localize('voltWorkflows.import', "Import"), 'primary', definition => {
				model.replace({ ...definition, id: this.freeId(definition.id || workflowSlug(definition.name)), revision: undefined, source: imported(definition) }, 'external', { label: localize('voltWorkflows.pasteLabel', "Paste workflow") });
				this.seeded = true;
				this.canvas?.fitView(true);
			});
		}
		check();
		area.focus();
	}

	private openPayloadDialog(): void {
		const model = this.model;
		if (!model) {
			return;
		}
		const dialog = showAutomationDialog(this.host.stage, localize('voltWorkflows.payloadTitle', "Mock payload"), localize('voltWorkflows.payloadSubtitle', "What the trigger sends when you simulate: read it as {{ trigger.payload }}. Saved with the workflow as its sample payload."), 'volt-wfb-dialog wide');
		const current = model.definition.trigger.samplePayload;
		const area = dialog.store.add(this.instantiationService.createInstance(WorkflowCodeEditor, dialog.body, { value: current === undefined ? '{\n  \n}' : JSON.stringify(current, null, 2), language: 'json', ariaLabel: localize('voltWorkflows.payloadTitle', "Mock payload"), height: 300 }));
		const status = append(dialog.body, $('.volt-wfb-paste-status'));
		let value: WorkflowValue | undefined = current;
		const check = () => {
			clearNode(status);
			const text = area.value.trim();
			try {
				value = text ? JSON.parse(text) as WorkflowValue : undefined;
				status.className = 'volt-wfb-paste-status ok';
				status.appendChild(renderIcon(Codicon.check));
				append(status, $('span')).textContent = text ? localize('voltWorkflows.validJson', "Valid JSON") : localize('voltWorkflows.noPayload', "No payload: simulations send an empty one");
				save.enabled = true;
			} catch (err) {
				status.className = 'volt-wfb-paste-status error';
				status.appendChild(renderIcon(Codicon.error));
				append(status, $('span')).textContent = err instanceof Error ? err.message : String(err);
				save.enabled = false;
			}
		};
		const cancel = dialog.store.add(createVoltButton(dialog.footer, 'secondary'));
		cancel.label = localize('voltWorkflows.cancel', "Cancel");
		dialog.store.add(cancel.onDidClick(() => dialog.close()));
		const save = dialog.store.add(createVoltButton(dialog.footer, 'primary'));
		save.label = localize('voltWorkflows.savePayload', "Use this payload");
		dialog.store.add(save.onDidClick(() => {
			dialog.close();
			model.apply(localize('voltWorkflows.editPayloadLabel', "Edit mock payload"), definition => {
				const trigger = { ...definition.trigger };
				if (value === undefined) {
					delete (trigger as { samplePayload?: WorkflowValue }).samplePayload;
				} else {
					(trigger as { samplePayload?: WorkflowValue }).samplePayload = value;
				}
				return { ...definition, trigger };
			}, 'inspector');
		}));
		dialog.store.add(area.onDidChange(check));
		check();
		area.focus();
	}

	//#endregion

	//#region Runs

	private currentRun(): IWorkflowRun | undefined {
		return this.execution?.run ?? this.shownRun;
	}

	private async simulate(options: { readonly stepping?: boolean; readonly failNodes?: readonly string[] } = {}): Promise<void> {
		const model = this.model;
		if (!model || isLive(this.execution?.run)) {
			return;
		}
		const definition = model.definition;
		const failNodes = options.failNodes ?? [];
		await this.startRun(definition, {
			mode: 'simulate',
			...(options.stepping ? { stepping: true } : {}),
			simulation: {
				...(failNodes.length ? { failNodes } : {}),
				...(definition.trigger.samplePayload !== undefined ? { payload: definition.trigger.samplePayload } : {}),
			},
		});
	}

	/** A real run of the saved workflow (saved first when there are changes). */
	private async runForReal(stepping = false): Promise<void> {
		if (!this.model || isLive(this.execution?.run)) {
			return;
		}
		if (this.needsSave() && !await this.save()) {
			return;
		}
		if (this.savedId) {
			await this.startRun(this.savedId, { mode: 'execute', ...(stepping ? { stepping: true } : {}) });
		}
	}

	/** One node, with its input from the shown run (simulated unless that run was real). */
	private async executeStep(nodeId: string): Promise<void> {
		const model = this.model;
		if (!model || isLive(this.execution?.run)) {
			return;
		}
		const previous = this.currentRun();
		const mode = previous?.mode ?? 'simulate';
		if (mode === 'execute' && this.needsSave() && !await this.save()) {
			return;
		}
		await this.startRun(mode === 'execute' && this.savedId ? this.savedId : model.definition, {
			mode,
			onlyNode: nodeId,
			...(previous ? { previousRunId: previous.id } : {}),
			...(mode === 'simulate' && model.definition.trigger.samplePayload !== undefined ? { simulation: { payload: model.definition.trigger.samplePayload } } : {}),
		});
	}

	private async retryStep(run: IWorkflowRun, nodeId: string): Promise<void> {
		const model = this.model;
		if (!model || isLive(this.execution?.run)) {
			return;
		}
		if (run.mode === 'execute' && this.needsSave() && !await this.save()) {
			return;
		}
		await this.startRun(run.mode === 'execute' && this.savedId ? this.savedId : model.definition, { mode: run.mode, retryFrom: nodeId, previousRunId: run.id });
	}

	private async startRun(workflow: string | IWorkflowDefinition, options: IWorkflowStartOptions): Promise<void> {
		try {
			const execution = await this.workflows.start(workflow, options);
			if (this._store.isDisposed) {
				return;
			}
			this.attach(execution);
		} catch (err) {
			if (!isCancellationError(err)) {
				this.notifications.error(err instanceof Error ? err.message : String(err));
			}
		}
	}

	private attach(execution: IWorkflowExecution): void {
		this.execution = execution;
		this.shownRun = execution.run;
		const store = new DisposableStore();
		store.add(execution.onDidChange(() => this.schedulePaint()));
		this.executionListener.value = store;
		void execution.done.then(run => this.detach(execution, run), () => this.detach(execution, execution.run));
		this.setRunOpen(true);
		this.runPanel?.showRun(execution.run);
		this.schedulePaint();
	}

	private detach(execution: IWorkflowExecution, run: IWorkflowRun): void {
		if (this.execution !== execution || this._store.isDisposed) {
			return;
		}
		this.execution = undefined;
		this.executionListener.clear();
		this.shownRun = run;
		this.schedulePaint();
	}

	/** Shows a run on the canvas and in the panels (`fromPanel`: the run panel picked it and already shows it). */
	private showRun(run: IWorkflowRun | undefined, fromPanel = false): void {
		// Picking an older run while one goes: the canvas shows the picked one until the live one is picked again.
		this.shownRun = run;
		this.canvas?.setRunState(run ?? this.execution?.run);
		if (!fromPanel) {
			this.runPanel?.showRun(run);
		}
		this.inspector?.setRun(run);
		this.renderDockStrip();
	}

	/** Run events come in bursts (a step, its edge, its logs): one repaint per frame. */
	private schedulePaint(): void {
		if (this.paintPending) {
			return;
		}
		this.paintPending = true;
		getWindow(this.root).requestAnimationFrame(() => {
			this.paintPending = false;
			if (this._store.isDisposed) {
				return;
			}
			const live = this.execution?.run;
			const run = live && (!this.shownRun || this.shownRun.id === live.id) ? live : this.shownRun;
			if (live && run === live) {
				this.shownRun = live;
			}
			this.canvas?.setRunState(run);
			this.runPanel?.showRun(run);
			this.inspector?.setRun(run);
			this.renderRunControls();
			this.renderDockStrip();
			this.syncApprovals(live);
		});
	}

	/**
	 * An approval the live run starts waiting on: the canvas shows the node and the inspector its
	 * Approve / Reject (once per step). The service raises the toast itself, so there is no second one.
	 */
	private syncApprovals(run: IWorkflowRun | undefined): void {
		for (const step of run?.steps ?? []) {
			const node = this.model?.node(step.nodeId);
			if (step.state !== 'waiting' || !node || getWorkflowNodeType(node.type)?.control !== 'approval' || this.shownApprovals.has(`${run!.id}:${step.id}`)) {
				continue;
			}
			this.shownApprovals.add(`${run!.id}:${step.id}`);
			this.canvas?.revealNode(node.id, this.model?.selection.length === 0);
			if (this.model?.selection.length === 0) {
				this.setSideOpen(true, 'inspector', false);
			}
		}
	}

	private approve(nodeId: string, decision: WorkflowApprovalDecision): void {
		this.execution?.resolveApproval(nodeId, decision);
	}

	//#endregion

	//#region Describe

	/** "Describe": a box for the description, then the agent builds it (`nodeId`: change that node). */
	private openDescribeDialog(nodeId?: string): void {
		const node = nodeId ? this.model?.node(nodeId) : undefined;
		const dialog = showAutomationDialog(this.host.stage,
			node ? localize('voltWorkflows.editWithAi', "Edit \"{0}\" with AI", nodeDisplayName(node)) : localize('voltWorkflows.describeTitle', "Build from a description"),
			node ? localize('voltWorkflows.editWithAiSubtitle', "Say what should change. The agent rewrites the workflow; undo brings back the old one.") : localize('voltWorkflows.describeSubtitle', "Say what should happen and when. An agent drafts the nodes; you review them before anything runs."),
			'volt-wfb-dialog');
		const area = workflowTextarea(dialog.body, '', {
			placeholder: node ? localize('voltWorkflows.editWithAiPlaceholder', "Also post the summary to #releases, and retry twice on failure") : localize('voltWorkflows.describePlaceholder', "When a pull request opens, review it with an agent, run the tests, and post a summary to Slack if anything fails."),
			ariaLabel: localize('voltWorkflows.describeTitle', "Build from a description"),
			min: 120,
			max: 320,
		}, dialog.store);
		const hint = append(dialog.body, $('.volt-wfb-hint'));
		hint.textContent = localize('voltWorkflows.describeHint', "{0} to build", shortcut('Enter'));
		const cancel = dialog.store.add(createVoltButton(dialog.footer, 'secondary'));
		cancel.label = localize('voltWorkflows.cancel', "Cancel");
		dialog.store.add(cancel.onDidClick(() => dialog.close()));
		const build = dialog.store.add(createVoltButton(dialog.footer, 'primary'));
		build.label = localize('voltWorkflows.build', "Build");
		const submit = () => {
			const text = area.value.trim();
			if (text) {
				dialog.close();
				void this.describe(text, nodeId);
			}
		};
		dialog.store.add(build.onDidClick(submit));
		dialog.store.add(addDisposableListener(area, 'keydown', e => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				submit();
			}
		}));
	}

	/**
	 * Builds (or changes) the workflow from words: a one-agent internal workflow gets the format
	 * guide, the current YAML and the description, answers with a ```yaml block, and that block
	 * replaces the canvas as one undoable step (marked as an agent draft until it is trusted).
	 */
	private async describe(text: string, nodeId?: string): Promise<void> {
		const model = this.model;
		if (!model || this.describing) {
			return;
		}
		const current = model.definition;
		const focus = nodeId ? model.node(nodeId) : undefined;
		const hasContent = current.nodes.length > 1;
		const brief = [
			'You write Volt workflow files (YAML) from a description.',
			'',
			workflowAuthoringGuide(),
			'',
			...(hasContent ? ['The current workflow (change it as asked; keep what still fits):', '```yaml', serializeWorkflow(current).trim(), '```', ''] : []),
			...(focus ? [`Change the node "${focus.id}" (${nodeDisplayName(focus)}) as described; leave the rest as it is unless the change needs it.`, ''] : []),
			'Description:',
			text,
		].join('\n');
		const definition: IWorkflowDefinition = {
			version: WORKFLOW_SCHEMA_VERSION,
			id: 'volt-describe',
			name: localize('voltWorkflows.describeRunName', "Draft a workflow"),
			trigger: { type: 'manual' },
			inputs: [{ name: 'brief', type: 'string' }],
			nodes: [
				{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
				// The brief arrives as an input: a template resolves once, so the guide's own {{ }} stay text.
				{ id: 'draft', type: 'agent', position: { x: 320, y: 0 }, config: { prompt: '{{ inputs.brief }}', mode: 'Ask', ...(current.settings?.modelRef ? { model: current.settings.modelRef } : {}) } },
				{ id: 'end', type: 'end', position: { x: 640, y: 0 }, config: { status: 'success', output: '{{ nodes.draft.summary }}' } },
			],
			edges: [
				{ id: 'start.next->draft', from: 'start', port: 'next', to: 'draft' },
				{ id: 'draft.done->end', from: 'draft', port: 'done', to: 'end' },
			],
		};
		let progress: INotificationHandle | undefined;
		this.inspector?.setDescribing(true);
		try {
			const execution = await this.workflows.start(definition, { mode: 'execute', inputs: { brief }, trigger: { kind: 'agent', label: localize('voltWorkflows.describeTrigger', "Describe") } });
			this.describing = execution;
			progress = this.notifications.prompt(Severity.Info, localize('voltWorkflows.describing', "Building the workflow from your description"), [
				{ label: localize('voltWorkflows.cancel', "Cancel"), run: () => execution.cancel() },
			], { sticky: true });
			progress.progress.infinite();
			const run = await execution.done;
			if (run.status === 'cancelled' || this._store.isDisposed) {
				return;
			}
			const step = [...run.steps].reverse().find(entry => entry.nodeId === 'draft');
			const output = step?.output;
			const summary = typeof output === 'object' && output && !Array.isArray(output) && typeof (output as { summary?: unknown }).summary === 'string' ? (output as { summary: string }).summary : typeof output === 'string' ? output : '';
			const yaml = extractYamlBlock(summary);
			if (run.status !== 'succeeded' || !yaml) {
				this.notifications.error(run.error ?? step?.error ?? localize('voltWorkflows.describeNoYaml', "The agent did not answer with a workflow. Try describing it again in other words."));
				return;
			}
			const parsed = this.workflows.parse(yaml);
			if (!parsed.definition) {
				const first = parsed.issues.find(issue => issue.severity === 'error');
				this.notifications.error(localize('voltWorkflows.describeInvalid', "The draft was not a valid workflow: {0}", first?.message ?? ''));
				return;
			}
			const draft = parsed.definition;
			const next: IWorkflowDefinition = {
				...draft,
				id: this.savedId ?? this.freeId(draft.id || workflowSlug(draft.name)),
				name: this.savedId || focus ? current.name : draft.name || current.name,
				revision: current.revision,
				source: { kind: 'describe' },
			};
			model.replace(next, 'external', { label: focus ? localize('voltWorkflows.editWithAiLabel', "Edit with AI") : localize('voltWorkflows.describeLabel', "Build from description") });
			if (!this.savedId) {
				this.seeded = true;
			}
			model.setSelection(focus && next.nodes.some(entry => entry.id === focus.id) ? [focus.id] : []);
			this.canvas?.fitView(true);
			const issues = validateWorkflow(next);
			const errors = issues.filter(issue => issue.severity === 'error').length;
			this.notifications.prompt(errors ? Severity.Warning : Severity.Info, errors
				? localize('voltWorkflows.describedWithErrors', "Drafted {0} nodes with {1} problems to fix. Review before running.", next.nodes.length, errors)
				: localize('voltWorkflows.described', "Drafted {0} nodes. Review them, simulate, then save.", next.nodes.length), [
				{ label: localize('voltWorkflows.undo', "Undo"), run: () => this.model?.undo() },
				{ label: localize('voltWorkflows.simulate', "Simulate"), run: () => void this.simulate() },
			]);
		} catch (err) {
			if (!isCancellationError(err)) {
				this.notifications.error(localize('voltWorkflows.describeFailed', "Could not build the workflow: {0}", err instanceof Error ? err.message : String(err)));
			}
		} finally {
			this.describing = undefined;
			progress?.close();
			this.inspector?.setDescribing(false);
		}
	}

	//#endregion

	//#region Keys and validation

	private onKeyDown(e: KeyboardEvent): void {
		// A field that used the key (Cmd+Enter in the Describe box) keeps it.
		if (e.defaultPrevented) {
			return;
		}
		const mod = isMacintosh ? e.metaKey : e.ctrlKey;
		const key = e.key.toLowerCase();
		const consume = (run: () => void) => {
			e.preventDefault();
			e.stopPropagation();
			run();
		};
		if (mod && !e.altKey && !e.shiftKey && key === 's') {
			consume(() => void this.save());
			return;
		}
		if (mod && !e.altKey && e.key === 'Enter') {
			consume(() => e.shiftKey ? void this.runForReal() : void this.simulate());
			return;
		}
		if (mod && !e.altKey && !e.shiftKey && e.key === '.' && isLive(this.execution?.run)) {
			consume(() => this.execution?.cancel());
			return;
		}
		if (this.execution?.paused && !mod && !e.altKey && !isTextTarget(e.target)) {
			if (e.key === 'F10') {
				consume(() => this.execution?.step());
				return;
			}
			if (e.key === 'F5') {
				consume(() => this.execution?.resume());
				return;
			}
		}
		if (e.key === 'F6' && isLive(this.execution?.run) && !this.execution?.paused) {
			consume(() => this.execution?.pause());
			return;
		}
		// The canvas handles its own keys (Tab, undo, delete); these are for the rest of the page.
		if (isTextTarget(e.target) || this.canvasHost.contains(e.target as Node)) {
			return;
		}
		if (mod && !e.altKey && key === 'z') {
			consume(() => e.shiftKey ? this.model?.redo() : this.model?.undo());
			return;
		}
		if (mod && !e.altKey && !e.shiftKey && key === 'y' && !isMacintosh) {
			consume(() => this.model?.redo());
			return;
		}
		if (e.key === 'Escape' && this.picker?.isOpen) {
			consume(() => this.picker?.close());
		}
	}

	private runValidation(): void {
		const model = this.model;
		if (!model) {
			return;
		}
		this.graphIssues = validateWorkflow(model.definition);
		this.issues = [...(this.yaml?.pendingIssues ?? []), ...this.graphIssues];
		this.canvas?.setIssues(this.graphIssues);
		this.inspector?.setIssues(this.issues);
		this.yaml?.setIssues(this.graphIssues);
		this.renderValidity();
	}

	//#endregion
}
