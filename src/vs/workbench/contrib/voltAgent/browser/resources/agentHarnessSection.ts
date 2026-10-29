/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../voltSettings/browser/media/voltSettings.css';
import '../media/agentHarness.css';
import { $, addDisposableListener, append, EventType } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { parse as parseJson } from '../../../../../base/common/json.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, isEqual } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationPropertySchema, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { AGENT_RESOURCE_ECOSYSTEM_LABELS, AGENT_RESOURCE_SCOPE_KIND_LABELS, AgentResourceEcosystem, agentResourceScopeKind } from '../../common/agentResources.js';
import { createVoltButton, voltButtonClasses } from '../chrome/voltButton.js';
import { createVoltDropdown, IVoltDropdownOption } from '../ui/dropdown/voltDropdown.js';
import { IAgentResourcesSectionContext } from './agentResourcesPage.js';
import { IAgentResource } from './agentResourcesService.js';

type SaveTarget = 'user' | 'workspace';

/** Survives page re-renders, so a change does not flip the target back to User. */
let saveTarget: SaveTarget = 'user';

/** Volt Settings page ids (voltSettingsEditor.ts SECTIONS). */
type VoltSettingsPage = 'general' | 'providers' | 'security' | 'usage';

interface ISettingEntry {
	readonly key: string;
	readonly title: string;
	readonly unit?: string;
	/** A model catalog ref: shown as text with Change, which opens where it is picked. */
	readonly modelRef?: { readonly page?: VoltSettingsPage; readonly empty: string };
}

interface ILinkEntry {
	readonly link: true;
	readonly title: string;
	readonly description: string;
	readonly run: () => void;
}

type HarnessEntry = ISettingEntry | ILinkEntry;

interface IHarnessGroup {
	readonly label: string;
	readonly entries: readonly HarnessEntry[];
}

const SETTINGS_FILE_NAMES = ['settings.json', 'settings.local.json', 'config.toml', 'cli.json', 'cli-config.json', 'requirements.toml', 'managed_config.toml', 'system-defaults.json', 'managed-settings.json'];

/** Settings files Volt owns or writes itself; they are not another harness's. */
const OWN_ECOSYSTEMS: ReadonlySet<AgentResourceEcosystem> = new Set(['volt', 'vscode']);

const MAX_READ_BYTES = 256 * 1024;

function isLink(entry: HarnessEntry): entry is ILinkEntry {
	return (entry as ILinkEntry).link === true;
}

function humanize(segment: string): string {
	const words = segment.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Schema text as plain prose: no backticks, links or `#setting#` refs, at most two sentences. */
function plainDescription(schema: IConfigurationPropertySchema): string | undefined {
	const raw = schema.markdownDescription ?? schema.description;
	if (!raw) {
		return undefined;
	}
	const text = raw
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/`#([^#`]+)#`/g, '$1')
		.replace(/#([\w.]+)#/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
	return sentences.slice(0, 2).join(' ');
}

function stepFor(key: string, schema: IConfigurationPropertySchema): number {
	if (/tokens/i.test(key)) {
		return 1000;
	}
	if (typeof schema.maximum === 'number' && schema.maximum <= 1 && schema.type !== 'integer') {
		return 0.05;
	}
	const magnitude = Math.max(Math.abs(Number(schema.default) || 0), Math.abs(schema.minimum ?? 0));
	return magnitude >= 1000 ? 100 : 1;
}

function schemaType(schema: IConfigurationPropertySchema): string | undefined {
	return Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type;
}

/** App-wide settings cannot be written per workspace. */
function userOnly(schema: IConfigurationPropertySchema): boolean {
	return schema.scope === ConfigurationScope.APPLICATION || schema.scope === ConfigurationScope.MACHINE || schema.scope === ConfigurationScope.APPLICATION_MACHINE;
}

function isOtherHarnessSettings(item: IAgentResource): boolean {
	if (OWN_ECOSYSTEMS.has(item.ecosystem)) {
		return false;
	}
	if (item.group === 'config') {
		return true;
	}
	const name = item.relativePath.split('/').pop() ?? '';
	return SETTINGS_FILE_NAMES.includes(name);
}

// --- Other harnesses' file summaries

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function count(value: unknown): number {
	return Array.isArray(value) ? value.length : asObject(value) ? Object.keys(value as Json).length : 0;
}

function permissionCounts(parts: string[], permissions: Json | undefined): void {
	const allowed = count(permissions?.allow);
	const denied = count(permissions?.deny);
	if (allowed || denied) {
		parts.push(localize('agentHarness.summary.permissions', "{0} allowed, {1} denied", allowed, denied));
	}
}

/** Top-level `key = value` pairs, before the first table. Enough for a one-line summary. */
function parseTomlTop(content: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of content.split(/\r?\n/)) {
		if (/^\s*\[/.test(line)) {
			break;
		}
		const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*("([^"]*)"|'([^']*)'|[^#\s]+)/.exec(line);
		if (match) {
			values.set(match[1], match[3] ?? match[4] ?? match[2]);
		}
	}
	return values;
}

function summarize(item: IAgentResource, content: string): string | undefined {
	const parts: string[] = [];
	if (item.relativePath.endsWith('.toml')) {
		const toml = parseTomlTop(content);
		const model = toml.get('model');
		if (model) {
			parts.push(localize('agentHarness.summary.model', "model {0}", model));
		}
		const approvals = toml.get('approval_policy');
		if (approvals) {
			parts.push(localize('agentHarness.summary.approvals', "approvals {0}", approvals));
		}
		const sandbox = toml.get('sandbox_mode');
		if (sandbox) {
			parts.push(localize('agentHarness.summary.sandbox', "sandbox {0}", sandbox));
		}
		const effort = toml.get('model_reasoning_effort');
		if (effort) {
			parts.push(localize('agentHarness.summary.effort', "effort {0}", effort));
		}
		return parts.join(' · ') || undefined;
	}
	if (!item.relativePath.endsWith('.json')) {
		return undefined;
	}
	const json = asObject(parseJson(content, [], { allowTrailingComma: true, disallowComments: false }));
	if (!json) {
		return undefined;
	}
	const model = asString(json.model) ?? asString(asObject(json.model)?.name);
	if (model) {
		parts.push(localize('agentHarness.summary.model', "model {0}", model));
	}
	const permissions = asObject(json.permissions);
	switch (item.ecosystem) {
		case 'claude': {
			const mode = asString(permissions?.defaultMode);
			if (mode) {
				parts.push(localize('agentHarness.summary.defaultMode', "default mode {0}", mode));
			}
			permissionCounts(parts, permissions);
			const hooks = count(json.hooks);
			if (hooks) {
				parts.push(hooks === 1 ? localize('agentHarness.summary.hookEvent', "1 hook event") : localize('agentHarness.summary.hookEvents', "{0} hook events", hooks));
			}
			const plugins = Object.values(asObject(json.enabledPlugins) ?? {}).filter(Boolean).length;
			if (plugins) {
				parts.push(plugins === 1 ? localize('agentHarness.summary.plugin', "1 plugin") : localize('agentHarness.summary.plugins', "{0} plugins", plugins));
			}
			break;
		}
		case 'gemini': {
			const editor = asString(asObject(json.general)?.preferredEditor);
			if (editor) {
				parts.push(localize('agentHarness.summary.editor', "editor {0}", editor));
			}
			break;
		}
		default:
			permissionCounts(parts, permissions);
			break;
	}
	const servers = count(json.mcpServers);
	if (servers) {
		parts.push(servers === 1 ? localize('agentHarness.summary.server', "1 MCP server") : localize('agentHarness.summary.servers', "{0} MCP servers", servers));
	}
	return parts.join(' · ') || undefined;
}

/**
 * The Harness page: Volt's own agent settings, written to the user or workspace settings the
 * user picks, and the settings files of other harnesses, which Volt only reads.
 */
export class AgentHarnessSection extends Disposable {

	private readonly registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

	/** Set once the page renders again, so late writes and file reads do not touch a gone page. */
	private stale = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly ctx: IAgentResourcesSectionContext,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		ctx.store.add(toDisposable(() => this.stale = true));
	}

	render(): void {
		const root = append(this.container, $('.volt-harness'));
		const groups = this.groups();
		const keys = groups.flatMap(group => group.entries.filter((entry): entry is ISettingEntry => !isLink(entry)).map(entry => entry.key));
		this.ctx.store.add(this.configurationService.onDidChangeConfiguration(e => {
			if (keys.some(key => e.affectsConfiguration(key))) {
				this.ctx.rerender();
			}
		}));

		this.renderTarget(root);
		const properties = this.registry.getConfigurationProperties();
		for (const group of groups) {
			const entries = group.entries.filter(entry => isLink(entry) || !!properties[entry.key]);
			if (!entries.length) {
				continue;
			}
			this.sectionLabel(root, group.label);
			const card = append(root, $('.volt-settings-group'));
			for (const entry of entries) {
				if (isLink(entry)) {
					this.linkRow(card, entry);
				} else {
					this.settingRow(card, entry, properties[entry.key]);
				}
			}
		}
		this.renderOtherHarnesses(root);
	}

	private groups(): readonly IHarnessGroup[] {
		const openSettings = (page: VoltSettingsPage) => () => void this.openVoltSettings(page);
		return [
			{
				label: localize('agentHarness.group.models', "Models & Routing"),
				entries: [
					{ key: 'volt.agent.defaultModel', title: localize('agentHarness.defaultModel', "Default model"), modelRef: { page: 'general', empty: localize('agentHarness.lastUsed', "Last used") } },
					{ key: 'volt.pullRequests.reviewModel', title: localize('agentHarness.reviewModel', "Pull request review model"), modelRef: { empty: localize('agentHarness.chatModel', "The chat's model") } },
					{ key: 'volt.agent.multitask.roleModels', title: localize('agentHarness.roleModels', "Models per task role") },
					{ link: true, title: localize('agentHarness.providers', "Providers & Models"), description: localize('agentHarness.providersDesc', "Sign in to providers, add API keys and choose which models show in the picker."), run: openSettings('providers') },
				],
			},
			{
				label: localize('agentHarness.group.tools', "Tool Execution"),
				entries: [
					{ key: 'volt.browser.allowAgents', title: localize('agentHarness.allowBrowser', "Agents can use the browser") },
					{ key: 'volt.agent.hooks.enabled', title: localize('agentHarness.hooks', "Run hooks") },
					{ key: 'volt.agent.hooks.thirdParty', title: localize('agentHarness.hooksThirdParty', "Run other harnesses' hooks") },
					{ link: true, title: localize('agentHarness.access', "Default access & approvals"), description: localize('agentHarness.accessDesc', "What new chats may run without asking: Full access, Auto, Accept edits or Supervised."), run: openSettings('general') },
				],
			},
			{
				label: localize('agentHarness.group.orchestration', "Orchestration"),
				entries: [
					{ key: 'volt.agent.multitask.maxParallel', title: localize('agentHarness.maxParallel', "Parallel tasks per chat") },
					{ key: 'volt.agent.multitask.maxParallelTotal', title: localize('agentHarness.maxParallelTotal', "Parallel tasks in total") },
					{ key: 'volt.agent.multitask.maxPerCall', title: localize('agentHarness.maxPerCall', "Tasks per delegation") },
					{ key: 'volt.agent.keepWorking', title: localize('agentHarness.keepWorking', "Keep working until done") },
					{ key: 'volt.agent.resumeAfterRestart', title: localize('agentHarness.resumeAfterRestart', "Resume after restart") },
					{ key: 'volt.agent.autoResumeAfterLimit', title: localize('agentHarness.autoResumeAfterLimit', "Resume after a usage limit") },
					{ key: 'volt.agent.stopAtClaudeLimit', title: localize('agentHarness.stopAtClaudeLimit', "Stop at Claude's usage limit") },
				],
			},
			{
				label: localize('agentHarness.group.context', "Context & Efficiency"),
				entries: [
					{ key: 'volt.agent.compactOldThreads', title: localize('agentHarness.compactOldThreads', "Compact old chats") },
					{ key: 'volt.agent.compactChipThreshold', title: localize('agentHarness.compactChipThreshold', "Suggest compacting at"), unit: '%' },
					{ key: 'volt.agent.handoff.budgetPercent', title: localize('agentHarness.handoffPercent', "Handoff context budget"), unit: '%' },
					{ key: 'volt.agent.handoff.maxTokens', title: localize('agentHarness.handoffMaxTokens', "Handoff token cap") },
					{ key: 'volt.agent.learnFromRuns', title: localize('agentHarness.learnFromRuns', "Learn from finished work") },
					{ key: 'volt.agent.multitask.budgetUsd', title: localize('agentHarness.budgetUsd', "Delegation budget"), unit: 'USD' },
					{ key: 'volt.agent.multitask.budgetTokens', title: localize('agentHarness.budgetTokens', "Delegation token budget") },
				],
			},
			{
				label: localize('agentHarness.group.security', "Security & Permissions"),
				entries: [
					{ link: true, title: localize('agentHarness.security', "Project rules, saved approvals and receipts"), description: localize('agentHarness.securityDesc', "Deny rules that hold under Full access, the approvals you saved, and where keys are stored."), run: openSettings('security') },
					{ key: 'volt.claude.accountSwitching', title: localize('agentHarness.accountSwitching', "Claude account switching") },
					{ key: 'volt.claude.autoSwitchThreshold', title: localize('agentHarness.autoSwitchThreshold', "Switch Claude accounts at"), unit: '%' },
				],
			},
			{
				label: localize('agentHarness.group.observability', "Observability & Evals"),
				entries: [
					{ link: true, title: localize('agentHarness.usage', "Usage"), description: localize('agentHarness.usageDesc', "Tokens, cost and limits by provider, model and project."), run: openSettings('usage') },
					{ link: true, title: localize('agentHarness.hookLog', "Hook execution log"), description: localize('agentHarness.hookLogDesc', "Every hook that ran, what it returned and how long it took."), run: () => void this.commandService.executeCommand('workbench.action.voltAgent.customize') },
					{ key: 'volt.tracing.enabled', title: localize('agentHarness.tracing', "Send OpenTelemetry traces") },
				],
			},
		];
	}

	private async openVoltSettings(page: VoltSettingsPage): Promise<void> {
		await this.commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID);
		(this.editorService.activeEditorPane as { showSection?(id: string): void } | undefined)?.showSection?.(page);
	}

	private get hasWorkspace(): boolean {
		return this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY;
	}

	private targetFor(schema: IConfigurationPropertySchema): ConfigurationTarget {
		return saveTarget === 'workspace' && this.hasWorkspace && !userOnly(schema) ? ConfigurationTarget.WORKSPACE : ConfigurationTarget.USER;
	}

	private renderTarget(root: HTMLElement): void {
		if (!this.hasWorkspace) {
			saveTarget = 'user';
		}
		const card = append(root, $('.volt-settings-group.volt-harness-target'));
		const row = append(card, $('.volt-settings-row'));
		const copy = append(row, $('.volt-settings-row-copy'));
		append(copy, $('label')).textContent = localize('agentHarness.saveTo', "Save changes to");
		append(copy, $('.desc')).textContent = localize('agentHarness.saveToDesc', "Where the Volt settings below are written. App-wide settings always go to your user settings.");
		const control = append(row, $('.volt-settings-row-control'));
		const options: IVoltDropdownOption<SaveTarget>[] = [
			{ id: 'user', label: localize('agentHarness.targetUser', "User · all projects"), description: localize('agentHarness.targetUserDesc', "Your settings, in every window"), icon: Codicon.account },
		];
		if (this.hasWorkspace) {
			const folder = this.workspaceContextService.getWorkspace().folders[0];
			const name = folder?.name ?? (this.ctx.folder ? basename(this.ctx.folder) : localize('agentHarness.thisWorkspace', "this workspace"));
			options.push({ id: 'workspace', label: localize('agentHarness.targetWorkspace', "Workspace · {0}", name), description: localize('agentHarness.targetWorkspaceDesc', "This project only; stored in .vscode/settings.json"), icon: Codicon.folder });
		}
		createVoltDropdown(control, this.contextViewService, {
			options,
			value: saveTarget,
			ariaLabel: localize('agentHarness.saveTo', "Save changes to"),
			width: 300,
			onChange: value => {
				saveTarget = value;
				this.ctx.rerender();
			},
		}, this.ctx.store);
	}

	private sectionLabel(root: HTMLElement, label: string): void {
		append(append(root, $('.volt-settings-section-label')), $('span')).textContent = label;
	}

	private linkRow(card: HTMLElement, entry: ILinkEntry): void {
		const row = append(card, $('.volt-settings-row'));
		const copy = append(row, $('.volt-settings-row-copy'));
		append(copy, $('label')).textContent = entry.title;
		append(copy, $('.desc')).textContent = entry.description;
		const control = append(row, $('.volt-settings-row-control'));
		const button = this.ctx.store.add(createVoltButton(control, 'secondary'));
		button.label = localize('agentHarness.open', "Open");
		this.ctx.store.add(button.onDidClick(() => entry.run()));
	}

	private write(key: string, value: unknown, target: ConfigurationTarget): void {
		void this.configurationService.updateValue(key, value, target).then(() => {
			if (!this.stale) {
				this.ctx.rerender();
			}
		});
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, label: string, run: () => void): void {
		const button = append(parent, $('button.volt-harness-icon-button')) as HTMLButtonElement;
		button.classList.add(...voltButtonClasses('ghost'));
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		this.ctx.store.add(addDisposableListener(button, EventType.CLICK, run));
	}

	private settingRow(card: HTMLElement, entry: ISettingEntry, schema: IConfigurationPropertySchema): void {
		const { key } = entry;
		const target = this.targetFor(schema);
		const inspect = this.configurationService.inspect<unknown>(key);
		const value = this.configurationService.getValue<unknown>(key);

		const row = append(card, $('.volt-settings-row'));
		const copy = append(row, $('.volt-settings-row-copy'));
		const title = append(copy, $('label'));
		title.textContent = entry.title;
		if (inspect.workspaceValue !== undefined) {
			append(title, $('span.volt-harness-badge')).textContent = localize('agentHarness.badgeWorkspace', "Workspace");
		}
		if (inspect.userValue !== undefined) {
			append(title, $('span.volt-harness-badge')).textContent = localize('agentHarness.badgeUser', "User");
		}
		const desc = plainDescription(schema);
		if (desc) {
			append(copy, $('.desc')).textContent = desc;
		}
		if (target === ConfigurationTarget.USER && inspect.workspaceValue !== undefined) {
			append(copy, $('.volt-harness-hint')).textContent = localize('agentHarness.overridden', "Overridden in this workspace");
		}

		const control = append(row, $('.volt-settings-row-control'));
		const targetValue = target === ConfigurationTarget.WORKSPACE ? inspect.workspaceValue : inspect.userValue;
		if (targetValue !== undefined) {
			this.iconButton(control, Codicon.discard, target === ConfigurationTarget.WORKSPACE
				? localize('agentHarness.resetWorkspace', "Reset in workspace settings")
				: localize('agentHarness.resetUser', "Reset in user settings"), () => this.write(key, undefined, target));
		}
		this.renderControl(control, entry, schema, value, target);
		this.iconButton(control, Codicon.settingsGear, localize('agentHarness.openInSettings', "Open in Settings"), () => {
			void this.commandService.executeCommand('workbench.action.openSettings', '@id:' + key);
		});
	}

	private renderControl(control: HTMLElement, entry: ISettingEntry, schema: IConfigurationPropertySchema, value: unknown, target: ConfigurationTarget): void {
		const { key } = entry;
		const store = this.ctx.store;
		if (entry.modelRef) {
			const ref = typeof value === 'string' ? value : '';
			const text = append(control, $('span.volt-harness-value'));
			// Refs read provider:model; the model part is what people recognize.
			text.textContent = ref ? ref.split(':').pop() || ref : entry.modelRef.empty;
			text.title = ref || entry.modelRef.empty;
			const change = store.add(createVoltButton(control, 'secondary'));
			change.label = localize('agentHarness.change', "Change");
			const page = entry.modelRef.page;
			store.add(change.onDidClick(() => page
				? void this.openVoltSettings(page)
				: void this.commandService.executeCommand('workbench.action.openSettings', '@id:' + key)));
			return;
		}

		if (Array.isArray(schema.enum) && schema.enum.length) {
			const descriptions = schema.enumDescriptions ?? schema.markdownEnumDescriptions;
			const options = schema.enum.map((option, index): IVoltDropdownOption<string> => ({
				id: String(option),
				label: schema.enumItemLabels?.[index] ?? humanize(String(option)),
				description: descriptions?.[index] ? plainDescription({ description: descriptions[index] }) : undefined,
			}));
			createVoltDropdown(control, this.contextViewService, {
				options,
				value: String(value ?? schema.default ?? options[0].id),
				ariaLabel: entry.title,
				width: descriptions ? 320 : undefined,
				onChange: next => this.write(key, schema.enum!.find(option => String(option) === next) ?? next, target),
			}, store);
			return;
		}

		switch (schemaType(schema)) {
			case 'boolean': {
				const on = value === true;
				const toggle = append(control, $('button.volt-settings-toggle')) as HTMLButtonElement;
				toggle.type = 'button';
				toggle.classList.toggle('on', on);
				toggle.setAttribute('role', 'switch');
				toggle.setAttribute('aria-checked', String(on));
				toggle.setAttribute('aria-label', entry.title);
				store.add(addDisposableListener(toggle, EventType.CLICK, () => this.write(key, !on, target)));
				return;
			}
			case 'number':
			case 'integer':
				this.stepper(control, entry, schema, typeof value === 'number' ? value : Number(schema.default) || 0, target);
				return;
			case 'string': {
				const input = append(control, $('input.volt-harness-text')) as HTMLInputElement;
				input.type = 'text';
				input.value = typeof value === 'string' ? value : '';
				input.setAttribute('aria-label', entry.title);
				const commit = () => {
					if (input.value !== value) {
						this.write(key, input.value, target);
					}
				};
				store.add(addDisposableListener(input, EventType.CHANGE, commit));
				store.add(addDisposableListener(input, EventType.KEY_DOWN, e => {
					if (new StandardKeyboardEvent(e).equals(KeyCode.Enter)) {
						commit();
					}
				}));
				return;
			}
			default: {
				const edit = store.add(createVoltButton(control, 'secondary'));
				edit.label = localize('agentHarness.editJson', "Edit in settings.json");
				store.add(edit.onDidClick(() => void this.commandService.executeCommand(target === ConfigurationTarget.WORKSPACE ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson')));
				return;
			}
		}
	}

	private stepper(control: HTMLElement, entry: ISettingEntry, schema: IConfigurationPropertySchema, current: number, target: ConfigurationTarget): void {
		const step = stepFor(entry.key, schema);
		const integer = schema.type === 'integer' || step >= 1 && Number.isInteger(current);
		const clamp = (next: number) => {
			let result = Number.isFinite(next) ? next : current;
			if (typeof schema.minimum === 'number') {
				result = Math.max(schema.minimum, result);
			}
			if (typeof schema.maximum === 'number') {
				result = Math.min(schema.maximum, result);
			}
			return integer ? Math.round(result) : Math.round(result * 100) / 100;
		};
		const stepper = append(control, $('.volt-settings-stepper'));
		const minus = append(stepper, $('button.step')) as HTMLButtonElement;
		minus.type = 'button';
		minus.textContent = String.fromCharCode(0x2212);
		minus.setAttribute('aria-label', localize('agentHarness.decrease', "Decrease {0}", entry.title));
		const input = append(stepper, $('input.value')) as HTMLInputElement;
		input.type = 'text';
		input.inputMode = integer ? 'numeric' : 'decimal';
		input.value = String(current);
		input.setAttribute('aria-label', entry.title);
		const plus = append(stepper, $('button.step')) as HTMLButtonElement;
		plus.type = 'button';
		plus.textContent = '+';
		plus.setAttribute('aria-label', localize('agentHarness.increase', "Increase {0}", entry.title));
		if (entry.unit) {
			append(control, $('.volt-settings-stepper-unit')).textContent = entry.unit;
		}
		const commit = (next: number) => {
			const value = clamp(next);
			input.value = String(value);
			if (value !== current) {
				this.write(entry.key, value, target);
			}
		};
		const store = this.ctx.store;
		store.add(addDisposableListener(minus, EventType.CLICK, () => commit(Number(input.value) - step)));
		store.add(addDisposableListener(plus, EventType.CLICK, () => commit(Number(input.value) + step)));
		store.add(addDisposableListener(input, EventType.CHANGE, () => commit(Number(input.value))));
	}

	// --- Other harnesses

	private renderOtherHarnesses(root: HTMLElement): void {
		this.sectionLabel(root, localize('agentHarness.otherHarnesses', "Other harnesses"));
		append(root, $('.volt-settings-section-hint')).textContent = localize('agentHarness.otherIntro', "Volt reads these files but never changes them. Open one to edit it in place.");

		const items = this.ctx.allItems.filter(isOtherHarnessSettings);
		if (!items.length) {
			append(root, $('.volt-settings-empty')).textContent = localize('agentHarness.noOther', "No settings files from other harnesses in this project or your home folder.");
			return;
		}
		const byEcosystem = new Map<AgentResourceEcosystem, IAgentResource[]>();
		for (const item of items) {
			let list = byEcosystem.get(item.ecosystem);
			if (!list) {
				byEcosystem.set(item.ecosystem, list = []);
			}
			list.push(item);
		}
		const ecosystems = [...byEcosystem.keys()].sort((a, b) => AGENT_RESOURCE_ECOSYSTEM_LABELS[a].localeCompare(AGENT_RESOURCE_ECOSYSTEM_LABELS[b]));
		for (const ecosystem of ecosystems) {
			append(root, $('.volt-harness-ecosystem')).textContent = AGENT_RESOURCE_ECOSYSTEM_LABELS[ecosystem];
			const card = append(root, $('.volt-settings-group'));
			const list = byEcosystem.get(ecosystem)!.sort((a, b) => this.pathLabel(a).localeCompare(this.pathLabel(b)));
			for (const item of list) {
				this.fileRow(card, item);
			}
		}
	}

	private pathLabel(item: IAgentResource): string {
		return this.ctx.home && isEqual(item.root, this.ctx.home) ? `~/${item.relativePath}` : item.relativePath;
	}

	private fileRow(card: HTMLElement, item: IAgentResource): void {
		const store = this.ctx.store;
		const row = append(card, $('.volt-settings-row.volt-harness-file'));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		const path = this.pathLabel(item);
		row.setAttribute('aria-label', localize('agentHarness.openFile', "Open {0}", path));

		const copy = append(row, $('.volt-settings-row-copy'));
		const title = append(copy, $('label'));
		append(title, $('span.volt-harness-path')).textContent = path;
		append(title, $('span.volt-harness-badge')).textContent = AGENT_RESOURCE_SCOPE_KIND_LABELS[agentResourceScopeKind(item.scope)];
		const desc = append(copy, $('.desc'));
		append(desc, $('span')).textContent = item.kind;
		if (item.status.kind !== 'ok' && item.status.message) {
			const status = append(copy, $(`.volt-harness-status.${item.status.kind}`));
			status.appendChild(renderIcon(item.status.kind === 'error' ? Codicon.error : Codicon.warning));
			append(status, $('span')).textContent = item.status.message;
		}

		const control = append(row, $('.volt-settings-row-control'));
		if (item.readOnly) {
			const lock = append(control, $('span.volt-harness-lock'));
			lock.appendChild(renderIcon(Codicon.lock));
			lock.title = item.readOnly;
			lock.setAttribute('aria-label', item.readOnly);
		}
		append(control, $('span.volt-harness-chevron')).appendChild(renderIcon(Codicon.chevronRight));

		store.add(addDisposableListener(row, EventType.CLICK, () => this.ctx.openResource(item.resource)));
		store.add(addDisposableListener(row, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				this.ctx.openResource(item.resource);
			}
		}));

		void this.summary(item).then(summary => {
			if (summary && !this.stale) {
				append(desc, $('span')).textContent = ` · ${summary}`;
			}
		});
	}

	/** The file's summary, read once until the page sees the files change. */
	private summary(item: IAgentResource): Promise<string | undefined> {
		const key = item.resource.toString();
		let summary = this.ctx.harnessSummaries.get(key);
		if (!summary) {
			summary = this.fileService.readFile(item.resource, { limits: { size: MAX_READ_BYTES } }).then(
				file => summarize(item, file.value.toString()),
				() => undefined, // unreadable or too big: the row still opens it
			);
			this.ctx.harnessSummaries.set(key, summary);
		}
		return summary;
	}
}
