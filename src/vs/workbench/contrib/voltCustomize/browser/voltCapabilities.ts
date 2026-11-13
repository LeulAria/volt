/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ITreeElement, ITreeNode, ITreeRenderer, ITreeDragAndDrop } from '../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { localize } from '../../../../nls.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry } from '../../../common/views.js';
import { EnablementState } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { providerFamily } from '../../../services/voltRuntime/browser/providers/providerFamily.js';
import { CODE_INTELLIGENCE_TOOLS } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { CAPTURE_TOOLS, DEVICE_TOOLS } from '../../../services/voltRuntime/common/deviceTools.js';
import { DESKTOP_TOOLS } from '../../../services/voltRuntime/common/desktopTools.js';
import { IVoltHostToolService, VOLT_HOST_TOOLS } from '../../../services/voltRuntime/common/hostTools.js';
import { IDE_TOOLS } from '../../../services/voltRuntime/common/ide/ideTools.js';
import { JOB_WATCH_TOOLS } from '../../../services/voltRuntime/common/jobs/jobWatch.js';
import { VOLT_MEMORY_TOOLS } from '../../../services/voltRuntime/common/memory/voltMemory.js';
import { AGENT_TASK_TOOLS } from '../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { ORCHESTRA_TOOLS } from '../../../services/voltRuntime/common/orchestration/orchestra.js';
import { THREAD_TOOLS } from '../../../services/voltRuntime/common/orchestration/agentThreadTools.js';
import { PLAYGROUND_TOOLS } from '../../../services/voltRuntime/common/playgroundTools.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { TERMINAL_TOOLS } from '../../../services/voltRuntime/common/terminalTools.js';
import { IExtension, IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { AgentCustomizationKind, IAgentCustomization } from '../../voltAgent/browser/customize/agentCustomize.js';
import { IAgentCustomizeService } from '../../voltAgent/browser/customize/agentCustomizeService.js';
import { encodeVoltContextDrag, IVoltContextDrag, VOLT_CONTEXT_MIME } from '../common/voltCustomizeContext.js';
import { IVoltFeature, IVoltFeatureService, VOLT_FEATURE_CATEGORIES, VOLT_FEATURES, voltFeatureSettingMatches } from '../common/voltFeatures.js';
import { VOLT_SLOT_ITEMS } from '../common/voltSlots.js';

/** Capability ids start with their top group; a chip naming one opens this tab. */
export function isVoltCapabilityId(id: string): boolean {
	return /^(volt|vscode|extensions)(\/|$)/.test(id);
}

/** What each agent tool does, from the tool lists Volt ships (features register the rest at runtime). */
const TOOL_DESCRIPTIONS = new Map<string, string>([
	...VOLT_HOST_TOOLS, ...THREAD_TOOLS, ...AGENT_TASK_TOOLS, ...VOLT_MEMORY_TOOLS, ...TERMINAL_TOOLS, ...PLAYGROUND_TOOLS,
	...CODE_INTELLIGENCE_TOOLS, ...DESKTOP_TOOLS, ...DEVICE_TOOLS, ...CAPTURE_TOOLS, ...ORCHESTRA_TOOLS, ...IDE_TOOLS, ...JOB_WATCH_TOOLS,
].map(tool => [tool.name, tool.description]));

const CUSTOMIZATION_KINDS: readonly { kind: AgentCustomizationKind; label: string; icon: ThemeIcon }[] = [
	{ kind: 'skill', label: localize('voltCapabilities.kind.skill', "Skills"), icon: Codicon.lightbulb },
	{ kind: 'subagent', label: localize('voltCapabilities.kind.subagent', "Subagents"), icon: Codicon.hubot },
	{ kind: 'rule', label: localize('voltCapabilities.kind.rule', "Rules"), icon: Codicon.law },
	{ kind: 'command', label: localize('voltCapabilities.kind.command', "Commands"), icon: Codicon.terminalCmd },
	{ kind: 'hook', label: localize('voltCapabilities.kind.hook', "Hooks"), icon: Codicon.zap },
	{ kind: 'mcp', label: localize('voltCapabilities.kind.mcp', "MCP servers"), icon: Codicon.server },
	{ kind: 'memory', label: localize('voltCapabilities.kind.memory', "Memory files"), icon: Codicon.database },
	{ kind: 'plugin', label: localize('voltCapabilities.kind.plugin', "Plugins"), icon: Codicon.extensions },
];

const PROVIDER_STATES: Readonly<Record<string, string>> = {
	authenticated: localize('voltCapabilities.signedIn', "Signed in"),
	available: localize('voltCapabilities.available', "Installed"),
	disabled: localize('voltCapabilities.providerOff', "Switched off"),
	missing: localize('voltCapabilities.missing', "Not installed"),
	checking: localize('voltCapabilities.checking', "Checking"),
};

/**
 * The Capabilities tab: everything this window can do, as one tree. Volt's features (each a
 * built-in extension that can be turned off, with the agent tools, commands, settings and buttons it
 * brings), then everything VS Code registers (views, editors, commands, settings, shortcuts,
 * languages, themes), then every extension and what it contributes. A filter narrows it;
 * any row drags into the chat (or Add to Chat) so the agent gets what it is and how to change it.
 */

type CapabilityKind = 'group' | 'feature' | 'extension' | 'entry';

interface ICapability {
	/** Unique in the tree: `volt/usage`, `vscode/commands/workbench.action.files.save`. */
	readonly id: string;
	readonly kind: CapabilityKind;
	readonly label: string;
	/** Dim text after the label: an id, a key, a count. */
	readonly detail?: string;
	/** What the inspector and the hover say about it. */
	readonly description?: string;
	readonly icon: ThemeIcon;
	/** Right-aligned state: "Off", "Core", a count. */
	readonly badge?: string;
	readonly off?: boolean;
	readonly feature?: IVoltFeature;
	readonly extension?: IExtension;
	/** The one thing a click on its button does: run the command, open the setting. */
	readonly action?: { readonly label: string; run(): unknown };
	readonly children?: readonly ICapability[];
	/** Shown open when there is no filter. */
	readonly open?: boolean;
}

function group(id: string, label: string, icon: ThemeIcon, children: readonly ICapability[], options?: { open?: boolean; description?: string; detail?: string; action?: ICapability['action'] }): ICapability {
	return { id, kind: 'group', label, icon, children, badge: String(countLeaves(children)), open: options?.open, description: options?.description, detail: options?.detail, action: options?.action };
}

/** A tool's first sentence: its one-line summary in a row. */
function firstSentence(text: string): string {
	const end = text.search(/\.(\s|$)/);
	return end > 0 ? text.slice(0, end + 1) : text;
}

function countLeaves(nodes: readonly ICapability[]): number {
	let count = 0;
	for (const node of nodes) {
		count += node.kind === 'group' ? countLeaves(node.children ?? []) : 1;
	}
	return count;
}

function labelOf(value: string | { value: string } | undefined): string {
	return typeof value === 'string' ? value : value?.value ?? '';
}

function matches(node: ICapability, query: string): boolean {
	return node.label.toLowerCase().includes(query) || !!node.detail?.toLowerCase().includes(query) || node.id.toLowerCase().includes(query);
}

/**
 * The tree for a filter: anything with a match inside opens to show it. A match keeps all its own
 * rows (closed unless they match too), so "usage" shows the Usage feature and what it brings.
 */
function toTreeElements(nodes: readonly ICapability[], query: string): ITreeElement<ICapability>[] {
	const all = (node: ICapability, collapsed = !node.open): ITreeElement<ICapability> => ({
		element: node,
		collapsible: !!node.children?.length,
		collapsed,
		children: node.children?.map(child => all(child)),
	});
	if (!query) {
		return nodes.map(node => all(node));
	}
	const visit = (node: ICapability): ITreeElement<ICapability> | undefined => {
		const inside = (node.children ?? []).map(visit).filter((child): child is ITreeElement<ICapability> => !!child);
		const self = matches(node, query);
		if (!inside.length) {
			return self ? all(node, true) : undefined;
		}
		if (!self) {
			return { element: node, collapsible: true, collapsed: false, children: inside };
		}
		const matched = new Map(inside.map(child => [child.element.id, child]));
		return { element: node, collapsible: true, collapsed: false, children: node.children!.map(child => matched.get(child.id) ?? all(child, true)) };
	};
	return nodes.map(visit).filter((node): node is ITreeElement<ICapability> => !!node);
}

class CapabilityDelegate implements IListVirtualDelegate<ICapability> {
	getHeight(): number { return 26; }
	getTemplateId(): string { return 'capability'; }
}

interface ICapabilityTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly badge: HTMLElement;
	readonly store: DisposableStore;
}

class CapabilityRenderer implements ITreeRenderer<ICapability, void, ICapabilityTemplate> {
	readonly templateId = 'capability';

	constructor(private readonly host: VoltCapabilitiesView) { }

	renderTemplate(container: HTMLElement): ICapabilityTemplate {
		const row = append(container, $('.volt-devtools-layer.volt-capability'));
		return {
			row,
			icon: append(row, $('span.icon')),
			label: append(row, $('span.label')),
			detail: append(row, $('span.detail')),
			badge: append(row, $('span.badge')),
			store: new DisposableStore(),
		};
	}

	renderElement(element: ITreeNode<ICapability, void>, _index: number, template: ICapabilityTemplate): void {
		const node = element.element;
		template.store.clear();
		clearNode(template.icon);
		template.icon.appendChild(renderIcon(node.icon));
		template.label.textContent = node.label;
		template.detail.textContent = node.detail ?? '';
		template.badge.textContent = node.badge ?? '';
		template.row.classList.toggle('group', node.kind === 'group');
		template.row.classList.toggle('off', !!node.off);
		template.store.add(this.host.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), template.row, () => ({ markdown: this.host.hover(node), markdownNotSupportedFallback: node.label })));
	}

	disposeTemplate(template: ICapabilityTemplate): void {
		template.store.dispose();
	}
}

class CapabilityDragAndDrop implements ITreeDragAndDrop<ICapability> {
	constructor(private readonly host: VoltCapabilitiesView) { }
	getDragURI(node: ICapability): string | null { return `volt-capability:${node.id}`; }
	getDragLabel(nodes: ICapability[]): string | undefined { return nodes.map(node => node.label).join(', '); }
	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const nodes = (data.getData() as ICapability[] | undefined) ?? [];
		if (nodes.length && originalEvent.dataTransfer) {
			originalEvent.dataTransfer.setData(VOLT_CONTEXT_MIME, encodeVoltContextDrag(this.host.contextFor(nodes[0])));
			originalEvent.dataTransfer.effectAllowed = 'copy';
		}
	}
	onDragOver(): boolean { return false; }
	drop(): void { }
	dispose(): void { }
}

const SPLIT = 0.55;
const MIN_PANE = 160;

export class VoltCapabilitiesView extends Disposable {

	readonly element: HTMLElement;
	private readonly filterBox: InputBox;
	private readonly body: HTMLElement;
	private readonly treeHost: HTMLElement;
	private readonly inspector: HTMLElement;
	private readonly tree: WorkbenchObjectTree<ICapability, void>;
	private readonly inspectorStore = this._register(new DisposableStore());
	private readonly rebuild = this._register(new RunOnceScheduler(() => this.render(), 120));
	private roots: ICapability[] = [];
	private byId = new Map<string, ICapability>();
	private selected: ICapability | undefined;
	private shown = false;
	private stale = true;
	/** Theme lists come back async; kept between rebuilds. */
	private themes: { color: ICapability[]; file: ICapability[]; product: ICapability[] } = { color: [], file: [], product: [] };
	/** The skills, subagents, rules and MCP servers the agents load here (Skills & Plugins reads them). */
	private loaded: readonly IAgentCustomization[] = [];
	private pendingReveal: string | undefined;

	constructor(
		parent: HTMLElement,
		private readonly addToChat: (label: string, value: string) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IHoverService public readonly hoverService: IHoverService,
		@IContextViewService contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IExtensionsWorkbenchService private readonly extensionsService: IExtensionsWorkbenchService,
		@IVoltFeatureService private readonly features: IVoltFeatureService,
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IAgentCustomizeService private readonly customizations: IAgentCustomizeService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.element = append(parent, $('.volt-capabilities.hidden'));
		const filter = append(this.element, $('.volt-capabilities-filter'));
		this.filterBox = this._register(new InputBox(filter, contextViewService, {
			placeholder: localize('voltCapabilities.filter', "Filter capabilities: tools, commands, settings, views, extensions"),
			ariaLabel: localize('voltCapabilities.filterLabel', "Filter capabilities"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this.filterBox.onDidChange(() => this.rebuild.schedule()));
		this.body = append(this.element, $('.volt-capabilities-body'));
		this.treeHost = append(this.body, $('.volt-devtools-tree'));
		this.inspector = append(this.body, $('.volt-devtools-inspector'));
		this.tree = this._register(instantiationService.createInstance(WorkbenchObjectTree<ICapability, void>, 'VoltDevtoolsCapabilities', this.treeHost, new CapabilityDelegate(), [new CapabilityRenderer(this)], {
			identityProvider: { getId: node => node.id },
			accessibilityProvider: { getAriaLabel: node => node.detail ? `${node.label}, ${node.detail}` : node.label, getWidgetAriaLabel: () => localize('voltCapabilities.tree', "Capabilities") },
			dnd: new CapabilityDragAndDrop(this),
			multipleSelectionSupport: false,
			horizontalScrolling: false,
		}));
		this._register(this.tree.onDidChangeSelection(e => {
			this.selected = e.elements[0] ?? undefined;
			this.renderInspector();
		}));
		this._register(this.tree.onDidOpen(e => {
			if (e.element?.action && e.browserEvent?.type === 'dblclick') {
				void e.element.action.run();
			}
		}));

		const invalidate = () => {
			this.stale = true;
			if (this.shown) {
				this.rebuild.schedule();
			}
		};
		this._register(this.features.onDidChange(invalidate));
		this._register(this.extensionsService.onChange(invalidate));
		this._register(MenuRegistry.onDidChangeMenu(invalidate));
		this._register(this.keybindingService.onDidUpdateKeybindings(invalidate));
		this._register(this.hostTools.onDidChangeTools(invalidate));
		this._register(this.runtime.onDidChangeProviderStatus(invalidate));
		this._register(this.customizations.onDidChange(() => {
			if (this.shown) {
				void this.loadCustomizations();
			}
		}));
	}

	/** The tab came to the front: build what changed while it was hidden. */
	show(): void {
		if (!this.shown) {
			this.shown = true;
			void this.loadThemes();
			void this.loadCustomizations();
			void this.extensionsService.queryLocal().then(() => this.rebuild.schedule());
		}
		if (this.stale) {
			this.render();
		}
	}

	/** Selects a capability by id (a chip in the chat names it), once the tree has it. */
	reveal(id: string): boolean {
		this.show();
		const node = this.byId.get(id);
		if (!node) {
			this.pendingReveal = id;
			return false;
		}
		this.tree.expandTo(node);
		this.tree.setSelection([node]);
		this.tree.setFocus([node]);
		this.tree.reveal(node);
		this.tree.domFocus();
		return true;
	}

	layout(height: number, width: number): void {
		const filterHeight = 36;
		const bodyHeight = Math.max(0, height - filterHeight);
		this.element.style.height = `${height}px`;
		const side = width >= 560;
		this.body.classList.toggle('side', side);
		const first = Math.max(Math.min(MIN_PANE, (side ? width : bodyHeight) / 2), Math.round((side ? width : bodyHeight) * SPLIT));
		if (side) {
			this.treeHost.style.width = `${first}px`;
			this.treeHost.style.height = `${bodyHeight}px`;
			this.inspector.style.height = `${bodyHeight}px`;
			this.tree.layout(bodyHeight, first);
		} else {
			this.treeHost.style.width = '';
			this.treeHost.style.height = `${first}px`;
			this.inspector.style.height = `${bodyHeight - first}px`;
			this.tree.layout(first, width);
		}
	}

	private render(): void {
		this.stale = false;
		this.roots = [this.voltGroup(), this.vscodeGroup(), this.extensionsGroup()];
		this.byId.clear();
		const index = (nodes: readonly ICapability[]) => {
			for (const node of nodes) {
				this.byId.set(node.id, node);
				index(node.children ?? []);
			}
		};
		index(this.roots);
		const selectedId = this.selected?.id;
		this.tree.setChildren(null, toTreeElements(this.roots, this.filterBox.value.trim().toLowerCase()));
		const keep = selectedId ? this.byId.get(selectedId) : undefined;
		if (keep && this.tree.hasElement(keep)) {
			this.selected = keep;
			this.tree.setSelection([keep]);
		} else {
			this.selected = undefined;
		}
		if (this.pendingReveal && this.byId.has(this.pendingReveal)) {
			const id = this.pendingReveal;
			this.pendingReveal = undefined;
			this.reveal(id);
		}
		this.renderInspector();
	}

	// --- Volt ---

	private voltGroup(): ICapability {
		const categories = VOLT_FEATURE_CATEGORIES.map(category => group(`volt/${category.id}`, category.label, ThemeIcon.fromId(category.icon), VOLT_FEATURES.filter(feature => feature.category === category.id).map(feature => this.featureNode(feature)), { open: true }));
		const yours = this.extensionsService.local.filter(extension => extension.identifier.id.toLowerCase().startsWith('local.'));
		return group('volt', localize('voltCapabilities.volt', "Volt"), Codicon.zap, [
			...categories,
			group('volt/yours', localize('voltCapabilities.yours', "Yours"), Codicon.home, yours.map(extension => this.extensionNode(extension, 'volt/yours')), {
				open: true,
				description: localize('voltCapabilities.yoursDesc', "Extensions you made in the Playground. Add a capability by making a new one."),
				action: { label: localize('voltCapabilities.newExtension', "New Customization"), run: () => this.commandService.executeCommand('volt.customize.openPlayground') },
			}),
		], {
			open: true,
			description: localize('voltCapabilities.voltDesc', "Volt's features. Each optional one is a built-in extension: turn it off here or in Extensions, and its buttons, pages, providers and agent tools go with it."),
			action: { label: localize('voltCapabilities.showFeatures', "Show in Extensions"), run: () => this.extensionsService.openSearch('@builtin volt') },
		});
	}

	private featureNode(feature: IVoltFeature): ICapability {
		const id = `volt/${feature.id}`;
		const enabled = this.features.isEnabled(feature.id);
		const children: ICapability[] = [];
		// Live: what this machine has for it (installed skills, a provider's sign-in).
		if (feature.id === 'skills') {
			children.push(...this.customizationGroups(id));
		}
		const statuses = feature.providers?.length ? this.runtime.listProviderStatuses().filter(status => feature.providers!.includes(providerFamily(status.providerId))) : [];
		children.push(...statuses.map(status => ({
			id: `${id}/status/${status.profileId}`, kind: 'entry' as const, label: status.label, detail: [PROVIDER_STATES[status.state] ?? status.state, status.account, status.version].filter(Boolean).join(', '), description: status.detail, icon: Codicon.hubot,
		})));
		if (feature.tools?.length) {
			const registered = new Map(this.hostTools.listTools().map(tool => [tool.name, tool.description]));
			children.push(group(`${id}/tools`, localize('voltCapabilities.tools', "Agent tools"), Codicon.tools, feature.tools.map(name => {
				const description = registered.get(name) ?? TOOL_DESCRIPTIONS.get(name);
				return { id: `${id}/tools/${name}`, kind: 'entry' as const, label: name, detail: description ? firstSentence(description) : undefined, description, icon: Codicon.symbolMethod };
			})));
		}
		const commands = (feature.commands ?? []).map(commandId => this.commandNode(commandId, `${id}/commands`));
		if (commands.length) {
			children.push(group(`${id}/commands`, localize('voltCapabilities.commands', "Commands"), Codicon.terminalCmd, commands));
		}
		const settings = this.settingNodes(key => voltFeatureSettingMatches(feature, key), `${id}/settings`);
		if (settings.length) {
			children.push(group(`${id}/settings`, localize('voltCapabilities.settings', "Settings"), Codicon.settingsGear, settings));
		}
		const items = (feature.items ?? []).map(itemId => VOLT_SLOT_ITEMS.find(item => item.id === itemId)).filter(item => !!item).map(item => ({
			id: `${id}/items/${item.id}`, kind: 'entry' as const, label: item.label, detail: item.id, description: item.description, icon: Codicon.symbolEvent,
		}));
		if (items.length) {
			children.push(group(`${id}/items`, localize('voltCapabilities.buttons', "Buttons"), Codicon.symbolEvent, items));
		}
		const signedIn = statuses.find(status => status.state === 'authenticated') ?? statuses.find(status => status.state === 'available');
		return {
			id,
			kind: 'feature',
			label: feature.label,
			detail: feature.extensionId ?? localize('voltCapabilities.core', "core"),
			description: feature.description,
			icon: ThemeIcon.fromId(feature.icon),
			badge: !enabled ? localize('voltCapabilities.off', "Off") : !feature.extensionId ? localize('voltCapabilities.coreBadge', "Core") : signedIn ? PROVIDER_STATES[signedIn.state] : undefined,
			off: !enabled,
			feature,
			children,
			action: feature.id === 'skills' ? { label: localize('voltCapabilities.browseSkills', "Add Skills and Plugins"), run: () => this.commandService.executeCommand('workbench.action.voltAgent.customize.marketplace') } : undefined,
		};
	}

	/** The skills, subagents, rules and MCP servers Volt's agents load in this window, by kind. */
	private customizationGroups(parent: string): ICapability[] {
		return CUSTOMIZATION_KINDS.map(entry => group(`${parent}/${entry.kind}`, entry.label, entry.icon, this.loaded.filter(item => item.kind === entry.kind).map(item => ({
			id: `${parent}/${entry.kind}/${item.resource.toString()}#${item.name}`,
			kind: 'entry' as const,
			label: item.name,
			detail: item.source,
			description: item.description,
			icon: entry.icon,
			action: { label: localize('voltCapabilities.openFile', "Open File"), run: () => this.editorService.openEditor({ resource: item.resource }) },
		})))).filter(node => node.children?.length);
	}

	private async loadCustomizations(): Promise<void> {
		this.loaded = await this.customizations.getItems().catch(() => []);
		this.stale = true;
		this.rebuild.schedule();
	}


	// --- VS Code ---

	private vscodeGroup(): ICapability {
		const children: ICapability[] = [
			this.viewsGroup(),
			this.editorsGroup(),
			this.commandsGroup(),
			group('vscode/settings', localize('voltCapabilities.allSettings', "Settings"), Codicon.settingsGear, this.settingSections()),
			this.keybindingsGroup(),
			this.languagesGroup(),
			group('vscode/colorThemes', localize('voltCapabilities.colorThemes', "Color themes"), Codicon.symbolColor, this.themes.color),
			group('vscode/fileIconThemes', localize('voltCapabilities.fileIconThemes', "File icon themes"), Codicon.fileMedia, this.themes.file),
			group('vscode/productIconThemes', localize('voltCapabilities.productIconThemes', "Product icon themes"), Codicon.symbolMisc, this.themes.product),
		];
		return group('vscode', localize('voltCapabilities.vscode', "VS Code"), Codicon.vscode, children, { open: true, description: localize('voltCapabilities.vscodeDesc', "Everything the workbench registers. Volt runs all of it; the agent window shows a part of it.") });
	}

	private viewsGroup(): ICapability {
		const containers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).all;
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		return group('vscode/views', localize('voltCapabilities.views', "Views"), Codicon.window, containers.map(container => group(`vscode/views/${container.id}`, labelOf(container.title) || container.id, Codicon.layoutSidebarLeft, views.getViews(container).map(view => ({
			id: `vscode/views/${container.id}/${view.id}`, kind: 'entry' as const, label: labelOf(view.name) || view.id, detail: view.id, icon: Codicon.symbolInterface,
		})), { detail: container.id })));
	}

	private editorsGroup(): ICapability {
		// The registry lists its panes, but its interface only exposes lookups by input.
		const registry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane) as IEditorPaneRegistry & { getEditorPanes?(): readonly { typeId: string; name: string }[] };
		const panes = registry.getEditorPanes?.() ?? [];
		return group('vscode/editors', localize('voltCapabilities.editors', "Editors"), Codicon.file, panes.map(pane => ({
			id: `vscode/editors/${pane.typeId}`, kind: 'entry' as const, label: pane.name, detail: pane.typeId, icon: Codicon.file,
		})));
	}

	private commandsGroup(): ICapability {
		const byCategory = new Map<string, ICapability[]>();
		for (const [commandId] of MenuRegistry.getCommands()) {
			const node = this.commandNode(commandId, 'vscode/commands');
			const category = labelOf(MenuRegistry.getCommand(commandId)?.category) || localize('voltCapabilities.noCategory', "Other");
			let list = byCategory.get(category);
			if (!list) {
				byCategory.set(category, list = []);
			}
			list.push(node);
		}
		const categories = [...byCategory].sort(([a], [b]) => a.localeCompare(b)).map(([category, nodes]) => group(`vscode/commands/${category}`, category, Codicon.symbolNamespace, nodes.sort((a, b) => a.label.localeCompare(b.label))));
		return group('vscode/commands', localize('voltCapabilities.allCommands', "Commands"), Codicon.terminalCmd, categories);
	}

	private commandNode(commandId: string, parent: string): ICapability {
		const command = MenuRegistry.getCommand(commandId);
		const keybinding = this.keybindingService.lookupKeybinding(commandId)?.getLabel();
		return {
			id: `${parent}/${commandId}`,
			kind: 'entry',
			label: labelOf(command?.title) || commandId,
			detail: keybinding ? `${commandId}, ${keybinding}` : commandId,
			description: labelOf(command?.tooltip) || undefined,
			icon: Codicon.symbolEvent,
			action: { label: localize('voltCapabilities.run', "Run"), run: () => this.commandService.executeCommand(commandId) },
		};
	}

	private settingSections(): ICapability[] {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const sections = new Map<string, Set<string>>();
		const walk = (node: { title?: string; id?: string; properties?: Record<string, unknown>; allOf?: unknown[] }, title: string) => {
			const name = node.title || title;
			if (node.properties) {
				let keys = sections.get(name);
				if (!keys) {
					sections.set(name, keys = new Set());
				}
				for (const key of Object.keys(node.properties)) {
					keys.add(key);
				}
			}
			for (const child of (node.allOf ?? []) as typeof node[]) {
				walk(child, name);
			}
		};
		for (const node of registry.getConfigurations()) {
			walk(node, node.id ?? localize('voltCapabilities.noCategory', "Other"));
		}
		const properties = registry.getConfigurationProperties();
		return [...sections].filter(([, keys]) => keys.size).sort(([a], [b]) => a.localeCompare(b)).map(([name, keys]) => group(`vscode/settings/${name}`, name, Codicon.symbolNamespace, [...keys].filter(key => properties[key]).sort().map(key => this.settingNode(key, `vscode/settings/${name}`))));
	}

	private settingNodes(filter: (key: string) => boolean, parent: string): ICapability[] {
		const properties = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
		return Object.keys(properties).filter(filter).sort().map(key => this.settingNode(key, parent));
	}

	private settingNode(key: string, parent: string): ICapability {
		const schema = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties()[key];
		const description = schema?.markdownDescription ?? schema?.description;
		return {
			id: `${parent}/${key}`,
			kind: 'entry',
			label: key,
			detail: typeof description === 'string' ? description.split('\n')[0] : undefined,
			description: typeof description === 'string' ? description : undefined,
			icon: Codicon.settingsGear,
			action: { label: localize('voltCapabilities.openSetting', "Open Setting"), run: () => this.commandService.executeCommand('workbench.action.openSettings', `@id:${key}`) },
		};
	}

	private keybindingsGroup(): ICapability {
		const nodes: ICapability[] = [];
		const seen = new Set<string>();
		for (const item of this.keybindingService.getKeybindings()) {
			const label = item.resolvedKeybinding?.getLabel();
			if (!item.command || !label || item.command.startsWith('-')) {
				continue;
			}
			const id = `vscode/keybindings/${item.command}/${label}/${item.when?.serialize() ?? ''}`;
			if (seen.has(id)) {
				continue;
			}
			seen.add(id);
			nodes.push({ id, kind: 'entry', label, detail: labelOf(MenuRegistry.getCommand(item.command)?.title) || item.command, description: item.when ? `when ${item.when.serialize()}` : undefined, icon: Codicon.keyboard });
		}
		return group('vscode/keybindings', localize('voltCapabilities.keybindings', "Keyboard shortcuts"), Codicon.keyboard, nodes);
	}

	private languagesGroup(): ICapability {
		return group('vscode/languages', localize('voltCapabilities.languages', "Languages"), Codicon.symbolKey, this.languageService.getSortedRegisteredLanguageNames().map(language => ({
			id: `vscode/languages/${language.languageId}`, kind: 'entry' as const, label: language.languageName, detail: language.languageId, icon: Codicon.symbolKey,
		})));
	}

	private async loadThemes(): Promise<void> {
		const [color, file, product] = await Promise.all([this.themeService.getColorThemes(), this.themeService.getFileIconThemes(), this.themeService.getProductIconThemes()]);
		const node = (kind: string, icon: ThemeIcon, apply: (id: string) => unknown) => (theme: { id: string; label: string; settingsId: string | null; description?: string }): ICapability => ({
			id: `vscode/${kind}/${theme.id}`, kind: 'entry', label: theme.label, detail: theme.settingsId ?? theme.id, description: theme.description, icon,
			action: { label: localize('voltCapabilities.apply', "Apply"), run: () => apply(theme.id) },
		});
		this.themes = {
			color: color.map(node('colorThemes', Codicon.symbolColor, id => this.themeService.setColorTheme(color.find(theme => theme.id === id), undefined))),
			file: file.map(node('fileIconThemes', Codicon.fileMedia, id => this.themeService.setFileIconTheme(file.find(theme => theme.id === id), undefined))),
			product: product.map(node('productIconThemes', Codicon.symbolMisc, id => this.themeService.setProductIconTheme(product.find(theme => theme.id === id), undefined))),
		};
		this.rebuild.schedule();
	}

	// --- Extensions ---

	private extensionsGroup(): ICapability {
		const featureExtensions = new Set(VOLT_FEATURES.map(feature => feature.extensionId?.toLowerCase()).filter(id => !!id));
		const local = this.extensionsService.local.filter(extension => !featureExtensions.has(extension.identifier.id.toLowerCase()));
		const sort = (list: IExtension[]) => list.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
		const installed = sort(local.filter(extension => !extension.isBuiltin));
		const builtin = sort(local.filter(extension => extension.isBuiltin));
		return group('extensions', localize('voltCapabilities.extensions', "Extensions"), Codicon.extensions, [
			group('extensions/installed', localize('voltCapabilities.installed', "Installed"), Codicon.cloudDownload, installed.map(extension => this.extensionNode(extension, 'extensions/installed')), { open: true }),
			group('extensions/builtin', localize('voltCapabilities.builtin', "Built-in"), Codicon.package, builtin.map(extension => this.extensionNode(extension, 'extensions/builtin'))),
		], {
			open: true,
			description: localize('voltCapabilities.extensionsDesc', "Every extension and what it contributes. Add more from the marketplace, or make your own in the Playground."),
			action: { label: localize('voltCapabilities.browseExtensions', "Browse Extensions"), run: () => this.extensionsService.openSearch('') },
		});
	}

	private extensionNode(extension: IExtension, parent: string): ICapability {
		const id = `${parent}/${extension.identifier.id}`;
		const enabled = isEnabled(extension);
		const contributes = (extension.local?.manifest.contributes ?? {}) as Record<string, unknown>;
		const children = Object.keys(contributes).sort().map(point => {
			const entries = contributionEntries(contributes[point]);
			return group(`${id}/${point}`, point, Codicon.symbolProperty, entries.map((entry, index) => ({
				id: `${id}/${point}/${index}:${entry.label}`, kind: 'entry' as const, label: entry.label, detail: entry.detail, icon: Codicon.symbolField,
			})));
		}).filter(node => node.children?.length);
		return {
			id,
			kind: 'extension',
			label: extension.displayName || extension.name,
			detail: `${extension.identifier.id} ${extension.version}`,
			description: extension.description,
			icon: Codicon.extensions,
			badge: enabled ? undefined : localize('voltCapabilities.off', "Off"),
			off: !enabled,
			extension,
			children,
		};
	}

	// --- Inspector, hover, chat ---

	hover(node: ICapability): MarkdownString {
		const md = new MarkdownString(undefined, { supportThemeIcons: true });
		md.appendMarkdown(`**${escapeMd(node.label)}**`);
		if (node.detail) {
			md.appendMarkdown(` \`${node.detail.replace(/`/g, '\'')}\``);
		}
		if (node.description) {
			md.appendMarkdown(`\n\n${escapeMd(node.description)}`);
		}
		md.appendMarkdown(`\n\n_${localize('voltCapabilities.dragHint', "Drag into the chat to ask the agent about it.")}_`);
		return md;
	}

	/** The chip a capability becomes in the composer: what it is, its parts, and how to change it. */
	contextFor(node: ICapability): IVoltContextDrag {
		const lines = [`<volt_capability id="${node.id}" label="${node.label}" kind="${node.kind}">`];
		if (node.detail) {
			lines.push(node.detail);
		}
		if (node.description) {
			lines.push(node.description);
		}
		if (node.feature) {
			const feature = node.feature;
			lines.push(feature.extensionId
				? `A Volt feature carried by the built-in extension ${feature.extensionId} (${this.features.isEnabled(feature.id) ? 'on' : 'turned off'}); the user turns it on or off in Extensions.`
				: 'Part of Volt\'s core: always on.');
			if (feature.tools?.length) {
				lines.push(`Agent tools: ${feature.tools.join(', ')}`);
			}
			if (feature.commands?.length) {
				lines.push(`Commands: ${feature.commands.join(', ')}`);
			}
			if (feature.items?.length) {
				lines.push(`Buttons (layout.json "slots" items): ${feature.items.join(', ')}`);
			}
			if (feature.settings?.length) {
				lines.push(`Settings: ${feature.settings.join(', ')}`);
			}
		} else if (node.extension) {
			lines.push(`Extension ${node.extension.identifier.id} ${node.extension.version}${node.extension.isBuiltin ? ' (built in)' : ''}, ${isEnabled(node.extension) ? 'enabled' : 'disabled'}. Contributes: ${Object.keys(node.extension.local?.manifest.contributes ?? {}).join(', ') || 'nothing'}.`);
		} else if (node.children?.length) {
			lines.push(`${countLeaves(node.children)} entries, among them: ${node.children.slice(0, 12).map(child => child.label).join(', ')}`);
		}
		lines.push('To change or add to it, make a Volt extension in the Customize Playground (see AGENTS.md); do not edit Volt\'s source.', '</volt_capability>');
		return { label: node.label, value: lines.join('\n') };
	}

	private renderInspector(): void {
		this.inspectorStore.clear();
		clearNode(this.inspector);
		const node = this.selected;
		if (!node) {
			append(this.inspector, $('.volt-devtools-empty')).textContent = localize('voltCapabilities.pick', "Pick a capability to see what it brings. Turn Volt's features on or off here or in Extensions; drag any row into the chat to ask the agent about it.");
			return;
		}
		const head = append(this.inspector, $('.volt-devtools-inspector-head'));
		append(head, $('.title')).textContent = node.label;
		append(head, $('.detail')).textContent = node.detail ?? '';
		const add = this.inspectorStore.add(createVoltButton(head, 'secondary'));
		add.label = localize('voltCapabilities.addToChat', "Add to Chat");
		this.inspectorStore.add(add.onDidClick(() => {
			const drag = this.contextFor(node);
			this.addToChat(drag.label, drag.value);
		}));
		if (node.description) {
			append(this.inspector, $('.volt-devtools-desc')).textContent = node.description;
		}
		// Whether it is on, above the buttons that change it.
		const status = append(this.inspector, $('.volt-devtools-desc'));
		const actions = append(this.inspector, $('.volt-capabilities-actions'));
		if (node.feature?.extensionId) {
			const feature = node.feature;
			const enabled = this.features.isEnabled(feature.id);
			status.textContent = enabled
				? localize('voltCapabilities.onDesc', "On. It comes with Volt as the built-in extension {0}. Turning it off takes away everything below: its buttons, pages, providers and agent tools.", feature.extensionId)
				: localize('voltCapabilities.offDesc', "Off. Turn it on here, or enable its extension ({0}) in Extensions.", feature.extensionId);
			const toggle = this.inspectorStore.add(createVoltButton(actions, enabled ? 'secondary' : 'primary'));
			toggle.label = enabled ? localize('voltCapabilities.turnOff', "Turn Off") : localize('voltCapabilities.turnOn', "Turn On");
			this.inspectorStore.add(toggle.onDidClick(() => void this.features.setEnabled(feature.id, !enabled)));
			const show = this.inspectorStore.add(createVoltButton(actions, 'ghost'));
			show.label = localize('voltCapabilities.showExtension', "Show in Extensions");
			this.inspectorStore.add(show.onDidClick(() => void this.extensionsService.open(feature.extensionId!)));
		} else if (node.feature) {
			status.textContent = localize('voltCapabilities.coreDesc', "Part of Volt's core, so it is always on.");
		}
		if (node.extension) {
			const extension = node.extension;
			const enabled = isEnabled(extension);
			const toggle = this.inspectorStore.add(createVoltButton(actions, 'secondary'));
			toggle.label = enabled ? localize('voltCapabilities.disable', "Disable") : localize('voltCapabilities.enable', "Enable");
			this.inspectorStore.add(toggle.onDidClick(() => void this.extensionsService.setEnablement(extension, enabled ? EnablementState.DisabledGlobally : EnablementState.EnabledGlobally)));
			const show = this.inspectorStore.add(createVoltButton(actions, 'ghost'));
			show.label = localize('voltCapabilities.showExtension', "Show in Extensions");
			this.inspectorStore.add(show.onDidClick(() => void this.extensionsService.open(extension)));
		}
		if (node.action) {
			const action = node.action;
			const button = this.inspectorStore.add(createVoltButton(actions, 'secondary'));
			button.label = action.label;
			this.inspectorStore.add(button.onDidClick(() => void action.run()));
		}
		if (!actions.childElementCount) {
			actions.remove();
		}
		if (!status.textContent) {
			status.remove();
		}
		// What it holds, a line per part (the rows themselves are in the tree).
		const children = node.children ?? [];
		const parts = children.some(child => child.children?.length) ? children.filter(child => child.children?.length) : [];
		for (const part of parts) {
			append(this.inspector, $('.volt-devtools-section')).textContent = `${part.label} (${countLeaves(part.children ?? [])})`;
			append(this.inspector, $('.volt-devtools-desc')).textContent = summarize(part.children ?? []);
		}
		const leaves = children.filter(child => !child.children?.length);
		if (leaves.length) {
			if (parts.length) {
				append(this.inspector, $('.volt-devtools-section')).textContent = localize('voltCapabilities.status', "Status");
			}
			append(this.inspector, $('.volt-devtools-desc')).textContent = summarize(leaves);
		}
	}
}

/** "a, b, c and 12 more": a line naming what a part holds. */
function summarize(nodes: readonly ICapability[]): string {
	const shown = nodes.slice(0, 16).map(node => node.badge && node.kind !== 'group' ? `${node.label} (${node.badge})` : node.detail && node.kind === 'entry' && node.label !== node.detail && node.detail.length < 40 ? `${node.label} (${node.detail})` : node.label);
	return nodes.length > shown.length ? localize('voltCapabilities.andMore', "{0} and {1} more", shown.join(', '), nodes.length - shown.length) : shown.join(', ');
}

function isEnabled(extension: IExtension): boolean {
	return extension.enablementState === EnablementState.EnabledGlobally || extension.enablementState === EnablementState.EnabledWorkspace || extension.enablementState === EnablementState.EnabledByEnvironment;
}

function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]<>#|]/g, match => `\\${match}`);
}

/**
 * One row per entry of a `contributes` point, labeled by whichever name-like field it has. Points
 * are arrays (`commands`), maps of arrays (`views`, `menus`) or a configuration (its properties).
 */
function contributionEntries(value: unknown): { label: string; detail?: string }[] {
	const describe = (entry: unknown): { label: string; detail?: string } => {
		if (typeof entry === 'string') {
			return { label: entry };
		}
		const record = (entry ?? {}) as Record<string, unknown>;
		const text = (key: string) => typeof record[key] === 'string' ? record[key] as string : typeof (record[key] as { value?: unknown })?.value === 'string' ? (record[key] as { value: string }).value : undefined;
		const label = text('title') ?? text('label') ?? text('name') ?? text('displayName') ?? text('id') ?? text('command') ?? text('language') ?? text('key') ?? text('path') ?? text('viewType') ?? '?';
		const detail = text('command') ?? text('id') ?? text('key') ?? text('when');
		return { label, detail: detail !== label ? detail : undefined };
	};
	if (Array.isArray(value)) {
		const entries: { label: string; detail?: string }[] = [];
		for (const entry of value) {
			// A configuration contribution can be an array of sections with properties.
			const properties = (entry as { properties?: Record<string, unknown> })?.properties;
			if (properties && typeof properties === 'object') {
				entries.push(...Object.keys(properties).map(key => ({ label: key })));
			} else {
				entries.push(describe(entry));
			}
		}
		return entries;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (record.properties && typeof record.properties === 'object') {
			return Object.keys(record.properties as object).map(key => ({ label: key }));
		}
		return Object.entries(record).flatMap(([key, inner]) => Array.isArray(inner) ? inner.map(entry => ({ ...describe(entry), detail: key })) : [{ label: key }]);
	}
	return [];
}
