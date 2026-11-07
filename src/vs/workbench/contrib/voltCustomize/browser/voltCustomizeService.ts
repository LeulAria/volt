/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename, extname, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Extensions as JSONExtensions, IJSONContributionRegistry } from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { applyLayoutModeChrome, getLayoutMode, storeAgentLeftSidebarHidden } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { ExtensionsRegistry, IExtensionPointUser } from '../../../services/extensions/common/extensionsRegistry.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { toggleAgentSidebarRail } from '../../voltAgent/browser/sidebar/agentSidebarRail.js';
import { AgentFilesSidebar } from '../../voltAgent/browser/workspace/agentFilesSidebar.js';
import { agentSessionToolTabs, agentToolsSessionOnScreen, openAgentToolsPanel, toggleAgentToolsPanel } from '../../voltAgent/browser/workspace/agentSurfaceHost.js';
import {
	VOLT_CUSTOMIZE_CLAUDE_MD, VOLT_CUSTOMIZE_DIR, VOLT_LAYOUT_SCHEMA_URI, VOLT_LAYOUTS_DIR, VOLT_LAYOUTS_EXTENSION_POINT, VOLT_LOOK_SCHEMA_URI,
	VOLT_LOOKS_DIR, VOLT_LOOKS_EXTENSION_POINT, VOLT_PLAYGROUND_DIR, VOLT_REFERENCE_DIR, VOLT_UI_SDK_CSS, voltCustomizeAgentsMd,
} from '../common/voltCustomizeDocs.js';
import {
	IVoltCustomizeEntry, IVoltLayout, IVoltLayoutWindowState, IVoltLook, mergeVoltCustomize, parseVoltCustomizeJson, resolveVoltCustomize,
	VOLT_BUILTIN_LAYOUTS, VOLT_BUILTIN_LOOKS, VOLT_BUILTIN_SOURCE, VOLT_CUSTOMIZE_LAYOUT_SETTING, VOLT_CUSTOMIZE_LOOK_SETTING, VOLT_DEFAULT_LAYOUT_ID,
	VOLT_HOME_SOURCE, validateVoltLayout, validateVoltLook, voltCustomizeId, voltCustomizeOverrides, voltLayoutSchema, voltLayoutStateKey,
	voltLayoutWindowState, voltLookSchema, VoltSettingScopeLookup, voltTokensReference,
} from '../common/voltCustomizeModel.js';
import { IVoltSlotService, resolveVoltSlotPlacement, VoltSlotId } from '../common/voltSlots.js';
import { IVoltFeatureService } from '../common/voltFeatures.js';
import { voltLookTargetSetting } from '../common/voltLookTokens.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';

// --- Contribution points ---------------------------------------------------------------------

interface IVoltCustomizeContribution {
	readonly id: string;
	readonly label?: string;
	readonly description?: string;
	readonly path: string;
}

const contributionSchema = (what: string): IJSONSchema => ({
	description: localize('voltCustomize.contribution', "Contributes Volt {0}. Each is a JSON file in the extension, picked in Settings > Customize Volt as `<extension id>/<id>`.", what),
	type: 'array',
	items: {
		type: 'object',
		required: ['id', 'path'],
		defaultSnippets: [{ body: { id: '${1:id}', label: '${2:Label}', path: './${3:file}.json' } }],
		properties: {
			id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', description: localize('voltCustomize.contribution.id', "Unique within the extension.") },
			label: { type: 'string', description: localize('voltCustomize.contribution.label', "The name Settings shows; defaults to the file's own label.") },
			description: { type: 'string' },
			path: { type: 'string', description: localize('voltCustomize.contribution.path', "The JSON file, relative to the extension folder.") },
		},
	},
});

const looksExtensionPoint = ExtensionsRegistry.registerExtensionPoint<IVoltCustomizeContribution[]>({
	extensionPoint: VOLT_LOOKS_EXTENSION_POINT,
	jsonSchema: contributionSchema(localize('voltCustomize.looks', "looks (token values, theme colors, window settings)")),
});

const layoutsExtensionPoint = ExtensionsRegistry.registerExtensionPoint<IVoltCustomizeContribution[]>({
	extensionPoint: VOLT_LAYOUTS_EXTENSION_POINT,
	jsonSchema: contributionSchema(localize('voltCustomize.layouts', "layouts (how the agent window is arranged)")),
});

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
jsonRegistry.registerSchema(VOLT_LOOK_SCHEMA_URI, voltLookSchema() as IJSONSchema);
jsonRegistry.registerSchema(VOLT_LAYOUT_SCHEMA_URI, voltLayoutSchema() as IJSONSchema);

// --- Service -----------------------------------------------------------------------------------

export interface IVoltCustomizeProblem {
	readonly file: URI;
	readonly errors: readonly string[];
}

export interface IVoltPlaygroundInfo {
	/** The draft folder this window is open on. */
	readonly folder: URI;
	readonly label: string;
	readonly errors: readonly string[];
	/** `develop`: the Playground window (devtools beside the chat); `preview`: a popped-out preview window. */
	readonly role: 'develop' | 'preview';
}

export type VoltPlaygroundMode = 'develop' | 'preview';

/** The workspace file a popped-out preview window opens: a second window on the same draft. */
export const VOLT_PREVIEW_WORKSPACE = '.volt-preview.code-workspace';

export const IVoltCustomizeService = createDecorator<IVoltCustomizeService>('voltCustomizeService');

export interface IVoltCustomizeService {
	readonly _serviceBrand: undefined;
	/** Looks, layouts, problems or the playground changed. */
	readonly onDidChange: Event<void>;
	/** `~/.volt/customize` on the machine the files live on; undefined until resolved. */
	readonly home: URI | undefined;
	readonly layouts: readonly IVoltCustomizeEntry<IVoltLayout>[];
	readonly looks: readonly IVoltCustomizeEntry<IVoltLook>[];
	readonly activeLayoutId: string;
	readonly activeLookId: string;
	readonly problems: readonly IVoltCustomizeProblem[];
	/** Set when this window is a Playground window. */
	readonly playground: IVoltPlaygroundInfo | undefined;
	whenReady(): Promise<void>;
	setLayout(id: string): Promise<void>;
	setLook(id: string): Promise<void>;
	/** Back to Volt's default layout and no look. Files stay. */
	reset(): Promise<void>;
	/** Re-applies the active layout's window state (sidebar, files sidebar, right panel). */
	applyLayoutWindowState(): void;
	resolveLayout(id: string): IVoltLayout | undefined;
	resolveLook(id: string): IVoltLook | undefined;
	/** In the Playground window: devtools beside the chat (`develop`) or Volt alone (`preview`). */
	readonly mode: VoltPlaygroundMode;
	setMode(mode: VoltPlaygroundMode): void;
	/** The preview is open in its own window; this one is the devtools platform until it closes. */
	readonly previewElsewhere: boolean;
	openPreviewWindow(): Promise<void>;
	/**
	 * Sets a token or theme color: in the draft's look.json in a Playground, else in settings.json.
	 * `undefined` removes it.
	 */
	setLookValue(kind: 'token' | 'color', id: string, value: number | string | undefined): Promise<void>;
	/** The value a token or color has here now (draft included). */
	lookValue(kind: 'token' | 'color', id: string): unknown;
	/** Moves one of Volt's buttons to the end of a slot: in the Playground draft's layout.json. */
	moveSlotItem(itemId: string, slot: VoltSlotId): Promise<void>;
}

const LAST_OVERRIDES_KEY = 'volt.customize.lastOverrides';
const APPLIED_STATE_KEY = 'volt.customize.appliedLayoutState';
const MODE_KEY = 'volt.playground.mode';
/** Application storage, per draft: the preview window's heartbeat (ms since the epoch). */
const PREVIEW_KEY_PREFIX = 'volt.playground.preview:';
const PREVIEW_BEAT_MS = 4000;
const PREVIEW_STALE_MS = 12000;
const DEFAULTS_SOURCE = { id: 'volt.customize', displayName: localize('voltCustomize.source', "Volt Customize") };

interface IReadResult<T extends IVoltLook> {
	readonly value: T | undefined;
	readonly label?: string;
	readonly errors: string[];
}

export class VoltCustomizeService extends Disposable implements IVoltCustomizeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	private registeredDefaults: IConfigurationDefaults | undefined;

	private _home: URI | undefined;
	private homeLooks: IVoltCustomizeEntry<IVoltLook>[] = [];
	private homeLayouts: IVoltCustomizeEntry<IVoltLayout>[] = [];
	private extensionLooks: IVoltCustomizeEntry<IVoltLook>[] = [];
	private extensionLayouts: IVoltCustomizeEntry<IVoltLayout>[] = [];
	private lookContributions: readonly IExtensionPointUser<IVoltCustomizeContribution[]>[] = [];
	private layoutContributions: readonly IExtensionPointUser<IVoltCustomizeContribution[]>[] = [];
	/** The last value read without errors, per file: a broken save keeps it. */
	private readonly lastGood = new Map<string, IVoltLook>();
	private _problems: IVoltCustomizeProblem[] = [];
	private _playground: IVoltPlaygroundInfo | undefined;
	/** The `slots` of the layout on screen (the draft's in a Playground). */
	private shownSlots: Readonly<Record<string, readonly string[]>> | undefined;
	/** Settings the playground holds at memory level in this window. */
	private playgroundKeys = new Set<string>();
	private playgroundPreview: { layout?: IVoltLayout; look?: IVoltLook } = {};
	private readonly watchers = this._register(new DisposableStore());
	private readonly reloadScheduler = this._register(new RunOnceScheduler(() => void this.reload(), 150));
	private readonly ready: Promise<void>;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IVoltSlotService private readonly slotService: IVoltSlotService,
		@IVoltFeatureService private readonly features: IVoltFeatureService,
		@IHostService private readonly hostService: IHostService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();
		// What the last window applied, at once: a look from a file must not flash the default first.
		this.registerDefaults(this.readStoredOverrides());
		this._register(this.features.onDidChange(() => this.applySlots()));

		looksExtensionPoint.setHandler(extensions => {
			this.lookContributions = extensions;
			this.reloadScheduler.schedule();
		});
		layoutsExtensionPoint.setHandler(extensions => {
			this.layoutContributions = extensions;
			this.reloadScheduler.schedule();
		});
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_CUSTOMIZE_LAYOUT_SETTING) || e.affectsConfiguration(VOLT_CUSTOMIZE_LOOK_SETTING)) {
				this.apply(true);
			}
		}));
		this._register(this.fileService.onDidFilesChange(e => {
			const home = this._home;
			if (!home) {
				return;
			}
			if (e.affects(joinPath(home, VOLT_LOOKS_DIR)) || e.affects(joinPath(home, VOLT_LAYOUTS_DIR)) || (this._playground && e.affects(this._playground.folder))) {
				this.reloadScheduler.schedule();
			}
		}));
		this.ready = this.start();
	}

	get home(): URI | undefined { return this._home; }
	get layouts(): readonly IVoltCustomizeEntry<IVoltLayout>[] { return [...builtinLayouts(), ...this.homeLayouts, ...this.extensionLayouts]; }
	get looks(): readonly IVoltCustomizeEntry<IVoltLook>[] { return [...builtinLooks(), ...this.homeLooks, ...this.extensionLooks]; }
	get problems(): readonly IVoltCustomizeProblem[] { return this._problems; }
	get playground(): IVoltPlaygroundInfo | undefined { return this._playground; }

	get activeLayoutId(): string {
		const id = this.configurationService.getValue<string>(VOLT_CUSTOMIZE_LAYOUT_SETTING);
		return typeof id === 'string' && id ? id : VOLT_DEFAULT_LAYOUT_ID;
	}

	get activeLookId(): string {
		const id = this.configurationService.getValue<string>(VOLT_CUSTOMIZE_LOOK_SETTING);
		return typeof id === 'string' ? id : '';
	}

	whenReady(): Promise<void> {
		return this.ready;
	}

	async setLayout(id: string): Promise<void> {
		await this.configurationService.updateValue(VOLT_CUSTOMIZE_LAYOUT_SETTING, id === VOLT_DEFAULT_LAYOUT_ID ? undefined : id);
	}

	async setLook(id: string): Promise<void> {
		await this.configurationService.updateValue(VOLT_CUSTOMIZE_LOOK_SETTING, id || undefined);
	}

	async reset(): Promise<void> {
		await this.configurationService.updateValue(VOLT_CUSTOMIZE_LAYOUT_SETTING, undefined);
		await this.configurationService.updateValue(VOLT_CUSTOMIZE_LOOK_SETTING, undefined);
		// A project's own choice would keep it on; reset means Volt as it ships in this window.
		for (const key of [VOLT_CUSTOMIZE_LAYOUT_SETTING, VOLT_CUSTOMIZE_LOOK_SETTING]) {
			if (this.configurationService.inspect(key).workspaceValue !== undefined) {
				await this.configurationService.updateValue(key, undefined, ConfigurationTarget.WORKSPACE);
			}
		}
	}

	resolveLayout(id: string): IVoltLayout | undefined {
		return resolveVoltCustomize(id, candidate => this.layouts.find(entry => entry.id === candidate)?.value).value;
	}

	resolveLook(id: string): IVoltLook | undefined {
		// A look may extend a layout's look fields too.
		return resolveVoltCustomize<IVoltLook>(id, candidate => this.looks.find(entry => entry.id === candidate)?.value ?? this.layouts.find(entry => entry.id === candidate)?.value).value;
	}

	// --- Startup and reading ---

	private async start(): Promise<void> {
		try {
			const userHome = await this.pathService.userHome();
			this._home = joinPath(userHome, ...VOLT_CUSTOMIZE_DIR);
			this._playground = this.detectPlayground(this._home);
			this.startPreviewTracking();
			await this.writeHome(this._home);
			this.watchers.add(this.fileService.watch(this._home, { recursive: true, excludes: [] }));
			await this.reload();
		} catch (error) {
			this.logService.error('[volt customize] could not read the customize folder', error);
		}
	}

	/**
	 * A window open on exactly one folder inside `playground/` is that draft's Playground window; one
	 * open on the draft's preview workspace file is its popped-out preview.
	 */
	private detectPlayground(home: URI): IVoltPlaygroundInfo | undefined {
		const state = this.workspaceContextService.getWorkbenchState();
		const workspace = this.workspaceContextService.getWorkspace();
		const folder = workspace.folders.length === 1 ? workspace.folders[0].uri : undefined;
		const root = joinPath(home, VOLT_PLAYGROUND_DIR);
		if (!folder || !isEqualOrParent(folder, root) || folder.path === root.path) {
			return undefined;
		}
		if (state === WorkbenchState.FOLDER) {
			return { folder, label: basename(folder), errors: [], role: 'develop' };
		}
		if (state === WorkbenchState.WORKSPACE && workspace.configuration && basename(workspace.configuration) === VOLT_PREVIEW_WORKSPACE) {
			return { folder, label: basename(folder), errors: [], role: 'preview' };
		}
		return undefined;
	}

	// --- Preview window and mode ---

	private _previewElsewhere = false;

	get previewElsewhere(): boolean {
		return this._previewElsewhere;
	}

	get mode(): VoltPlaygroundMode {
		if (this._playground?.role === 'preview') {
			return 'preview';
		}
		if (this._previewElsewhere) {
			return 'develop';
		}
		return this.storageService.get(MODE_KEY, StorageScope.WORKSPACE) === 'preview' ? 'preview' : 'develop';
	}

	setMode(mode: VoltPlaygroundMode): void {
		this.storageService.store(MODE_KEY, mode, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	async openPreviewWindow(): Promise<void> {
		const playground = this._playground;
		if (!playground) {
			return;
		}
		const file = joinPath(playground.folder, VOLT_PREVIEW_WORKSPACE);
		await this.writeIfChanged(file, JSON.stringify({ folders: [{ path: '.' }], settings: {} }, undefined, '\t') + '\n');
		await this.hostService.openWindow([{ workspaceUri: file }], { forceNewWindow: true });
	}

	private previewKey(): string | undefined {
		return this._playground ? PREVIEW_KEY_PREFIX + this._playground.folder.toString() : undefined;
	}

	/**
	 * The preview window beats every few seconds and clears its mark when it closes; the Playground
	 * window treats a missing or stale beat as closed, so a crash never hides the toggle for good.
	 */
	private startPreviewTracking(): void {
		const key = this.previewKey();
		if (!key || !this._playground) {
			return;
		}
		if (this._playground.role === 'preview') {
			const beat = () => this.storageService.store(key, Date.now(), StorageScope.APPLICATION, StorageTarget.MACHINE);
			beat();
			this._register(new IntervalTimer()).cancelAndSet(beat, PREVIEW_BEAT_MS);
			this._register(this.lifecycleService.onWillShutdown(() => this.storageService.remove(key, StorageScope.APPLICATION)));
			return;
		}
		const check = () => {
			const at = this.storageService.getNumber(key, StorageScope.APPLICATION, 0);
			const elsewhere = at > 0 && Date.now() - at < PREVIEW_STALE_MS;
			if (elsewhere !== this._previewElsewhere) {
				this._previewElsewhere = elsewhere;
				this.apply(false);
			}
		};
		check();
		this._register(new IntervalTimer()).cancelAndSet(check, PREVIEW_BEAT_MS);
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, key, this._store)(() => check()));
	}

	async moveSlotItem(itemId: string, slot: VoltSlotId): Promise<void> {
		const playground = this._playground;
		if (!playground) {
			return;
		}
		const placement = this.slotService.placement;
		const next: Record<string, string[]> = {};
		for (const [id, items] of Object.entries(placement)) {
			next[id] = items.filter(item => item !== itemId);
		}
		next[slot] = [...next[slot], itemId];
		const file = joinPath(playground.folder, 'layout.json');
		let text = '{}\n';
		try {
			text = (await this.fileService.readFile(file)).value.toString();
		} catch {
			// A new file.
		}
		// The full lists of the slots it left and joined, so the result does not depend on Volt's order.
		for (const id of Object.keys(next)) {
			if (next[id].join('\n') !== placement[id as VoltSlotId].join('\n')) {
				text = applyEdits(text, setProperty(text, ['slots', id], next[id], { tabSize: 1, insertSpaces: false, eol: '\n' }));
			}
		}
		await this.fileService.writeFile(file, VSBuffer.fromString(text));
	}

	// --- Editing values ---

	lookValue(kind: 'token' | 'color', id: string): unknown {
		// In a Playground the draft's own value, even while this window shows plain Volt (preview popped out).
		const draft = this._playground ? this.playgroundPreview.look : undefined;
		const own = kind === 'color' ? draft?.colors?.[id] : draft?.tokens?.[id];
		if (own !== undefined && own !== null) {
			return own;
		}
		if (kind === 'color') {
			const colors = this.configurationService.getValue<Record<string, unknown>>('workbench.colorCustomizations');
			return colors && typeof colors === 'object' ? colors[id] : undefined;
		}
		const setting = voltLookTargetSetting(id);
		return setting ? this.configurationService.getValue(setting) : undefined;
	}

	async setLookValue(kind: 'token' | 'color', id: string, value: number | string | undefined): Promise<void> {
		const playground = this._playground;
		if (playground) {
			// The draft's look.json, edited in place so its comments and order survive.
			const file = joinPath(playground.folder, 'look.json');
			let text = '{}\n';
			try {
				text = (await this.fileService.readFile(file)).value.toString();
			} catch {
				// A new file.
			}
			const edits = setProperty(text, [kind === 'token' ? 'tokens' : 'colors', id], value, { tabSize: 1, insertSpaces: false, eol: '\n' });
			await this.fileService.writeFile(file, VSBuffer.fromString(applyEdits(text, edits)));
			return;
		}
		if (kind === 'token') {
			const setting = voltLookTargetSetting(id);
			if (setting) {
				await this.configurationService.updateValue(setting, value);
			}
			return;
		}
		const current = this.configurationService.inspect<Record<string, unknown>>('workbench.colorCustomizations').userValue ?? {};
		const next = { ...current };
		if (value === undefined) {
			delete next[id];
		} else {
			next[id] = value;
		}
		await this.configurationService.updateValue('workbench.colorCustomizations', next);
	}

	/** AGENTS.md, CLAUDE.md and reference/: Volt's, rewritten when they differ. */
	private async writeHome(home: URI): Promise<void> {
		const profile = this.userDataProfileService.currentProfile;
		const json = (value: unknown) => JSON.stringify(value, undefined, '\t') + '\n';
		const reference = joinPath(home, VOLT_REFERENCE_DIR);
		const files: [URI, string][] = [
			[joinPath(home, 'AGENTS.md'), voltCustomizeAgentsMd({ home: home.fsPath, settings: profile.settingsResource.fsPath, keybindings: profile.keybindingsResource.fsPath })],
			[joinPath(home, 'CLAUDE.md'), VOLT_CUSTOMIZE_CLAUDE_MD],
			[joinPath(reference, 'tokens.json'), json(voltTokensReference())],
			[joinPath(reference, 'look.schema.json'), json(voltLookSchema())],
			[joinPath(reference, 'layout.schema.json'), json(voltLayoutSchema())],
			[joinPath(reference, 'sdk', 'volt-ui.css'), VOLT_UI_SDK_CSS],
			...VOLT_BUILTIN_LAYOUTS.map(entry => [joinPath(reference, 'layouts', `${entry.name}.json`), json({ $schema: VOLT_LAYOUT_SCHEMA_URI, ...entry.value })] as [URI, string]),
			...VOLT_BUILTIN_LOOKS.map(entry => [joinPath(reference, 'looks', `${entry.name}.json`), json({ $schema: VOLT_LOOK_SCHEMA_URI, ...entry.value })] as [URI, string]),
		];
		await Promise.all([
			this.fileService.createFolder(joinPath(home, VOLT_LOOKS_DIR)).catch(() => undefined),
			this.fileService.createFolder(joinPath(home, VOLT_LAYOUTS_DIR)).catch(() => undefined),
			this.fileService.createFolder(joinPath(home, VOLT_PLAYGROUND_DIR)).catch(() => undefined),
		]);
		await Promise.all(files.map(([file, text]) => this.writeIfChanged(file, text)));
	}

	private async writeIfChanged(file: URI, text: string): Promise<void> {
		try {
			const current = await this.fileService.readFile(file);
			if (current.value.toString() === text) {
				return;
			}
		} catch {
			// Not there yet.
		}
		await this.fileService.writeFile(file, VSBuffer.fromString(text));
	}

	private readonly scopeOf: VoltSettingScopeLookup = id => {
		const property = this.registry.getConfigurationProperties()[id];
		if (!property) {
			return 'unknown';
		}
		const scope = property.scope ?? ConfigurationScope.WINDOW;
		return scope === ConfigurationScope.WINDOW || scope === ConfigurationScope.RESOURCE || scope === ConfigurationScope.LANGUAGE_OVERRIDABLE || scope === ConfigurationScope.MACHINE_OVERRIDABLE
			? 'window'
			: 'other';
	};

	private async readFile<T extends IVoltLook>(file: URI, kind: 'look' | 'layout', writeErrors: boolean): Promise<IReadResult<T>> {
		let text: string;
		try {
			text = (await this.fileService.readFile(file)).value.toString();
		} catch (error) {
			return { value: undefined, errors: [localize('voltCustomize.unreadable', "Could not read the file: {0}", String(error))] };
		}
		const parsed = parseVoltCustomizeJson(text);
		const errors = [...parsed.errors];
		let value: T | undefined;
		if (parsed.value) {
			const validated = kind === 'look' ? validateVoltLook(parsed.value, this.scopeOf) : validateVoltLayout(parsed.value, this.scopeOf);
			errors.push(...validated.errors);
			value = validated.value as T;
		}
		const key = file.toString();
		if (!errors.length && value) {
			this.lastGood.set(key, value);
		} else if (parsed.errors.length) {
			// Unparsable: keep running the last good version.
			value = this.lastGood.get(key) as T | undefined;
		}
		if (writeErrors) {
			await this.writeErrorFile(file, errors);
		}
		return { value, label: value?.label, errors };
	}

	private async writeErrorFile(file: URI, errors: readonly string[]): Promise<void> {
		const errorFile = file.with({ path: `${file.path}.error` });
		if (errors.length) {
			await this.writeIfChanged(errorFile, `${errors.join('\n')}\n`).catch(() => undefined);
		} else if (await this.fileService.exists(errorFile)) {
			await this.fileService.del(errorFile).catch(() => undefined);
		}
	}

	private async readHomeFolder<T extends IVoltLook>(folder: URI, kind: 'look' | 'layout'): Promise<{ entries: IVoltCustomizeEntry<T>[]; problems: IVoltCustomizeProblem[] }> {
		const entries: IVoltCustomizeEntry<T>[] = [];
		const problems: IVoltCustomizeProblem[] = [];
		let children: URI[] = [];
		try {
			const stat = await this.fileService.resolve(folder);
			children = (stat.children ?? []).filter(child => child.isFile && extname(child.resource) === '.json').map(child => child.resource);
		} catch {
			return { entries, problems };
		}
		await Promise.all(children.map(async file => {
			const name = basename(file).slice(0, -'.json'.length);
			const read = await this.readFile<T>(file, kind, true);
			if (read.errors.length) {
				problems.push({ file, errors: read.errors });
			}
			if (read.value) {
				entries.push({ id: voltCustomizeId(VOLT_HOME_SOURCE, name), source: VOLT_HOME_SOURCE, name, label: read.label ?? name, description: read.value.description, file: file.toString(), value: read.value, errors: read.errors });
			}
		}));
		entries.sort((a, b) => a.label.localeCompare(b.label));
		return { entries, problems };
	}

	private async readContributions<T extends IVoltLook>(users: readonly IExtensionPointUser<IVoltCustomizeContribution[]>[], kind: 'look' | 'layout'): Promise<IVoltCustomizeEntry<T>[]> {
		const entries: IVoltCustomizeEntry<T>[] = [];
		await Promise.all(users.flatMap(user => (Array.isArray(user.value) ? user.value : []).map(async contribution => {
			if (typeof contribution?.id !== 'string' || typeof contribution.path !== 'string') {
				user.collector.error(localize('voltCustomize.badContribution', "Each entry needs an `id` and a `path`."));
				return;
			}
			const location = user.description.extensionLocation;
			const file = joinPath(location, contribution.path);
			if (!isEqualOrParent(file, location)) {
				user.collector.error(localize('voltCustomize.outside', "`{0}` must be inside the extension folder.", contribution.path));
				return;
			}
			const read = await this.readFile<T>(file, kind, false);
			for (const error of read.errors) {
				user.collector.warn(`${contribution.path}: ${error}`);
			}
			if (read.value) {
				const source = user.description.identifier.value;
				entries.push({ id: voltCustomizeId(source, contribution.id), source, name: contribution.id, label: contribution.label ?? read.label ?? contribution.id, description: contribution.description ?? read.value.description, file: file.toString(), value: read.value, errors: read.errors });
			}
		})));
		entries.sort((a, b) => a.label.localeCompare(b.label));
		return entries;
	}

	private async reload(): Promise<void> {
		const home = this._home;
		const problems: IVoltCustomizeProblem[] = [];
		if (home) {
			const [looks, layouts] = await Promise.all([
				this.readHomeFolder<IVoltLook>(joinPath(home, VOLT_LOOKS_DIR), 'look'),
				this.readHomeFolder<IVoltLayout>(joinPath(home, VOLT_LAYOUTS_DIR), 'layout'),
			]);
			this.homeLooks = looks.entries;
			this.homeLayouts = layouts.entries;
			problems.push(...looks.problems, ...layouts.problems);
		}
		const [extensionLooks, extensionLayouts] = await Promise.all([
			this.readContributions<IVoltLook>(this.lookContributions, 'look'),
			this.readContributions<IVoltLayout>(this.layoutContributions, 'layout'),
		]);
		this.extensionLooks = extensionLooks;
		this.extensionLayouts = extensionLayouts;
		if (this._playground) {
			const [look, layout] = await Promise.all([
				this.readFile<IVoltLook>(joinPath(this._playground.folder, 'look.json'), 'look', true),
				this.readFile<IVoltLayout>(joinPath(this._playground.folder, 'layout.json'), 'layout', true),
			]);
			this.playgroundPreview = { look: look.value, layout: layout.value };
			const errors = [...look.errors.map(error => `look.json: ${error}`), ...layout.errors.map(error => `layout.json: ${error}`)];
			this._playground = { ...this._playground, label: layout.label ?? look.label ?? this._playground.label, errors };
		}
		this._problems = problems;
		this.apply(false);
	}

	// --- Applying ---

	/** The active layout merged with the look it names, then the picked look over it. */
	private effective(): { layoutId: string; layout: IVoltLayout | undefined; look: IVoltLook | undefined } {
		const layoutId = this.activeLayoutId;
		let layout = this.resolveLayout(layoutId) ?? this.resolveLayout(VOLT_DEFAULT_LAYOUT_ID);
		if (layout?.look) {
			const named = this.resolveLook(layout.look);
			if (named) {
				layout = mergeVoltCustomize<IVoltLayout>({ tokens: named.tokens, colors: named.colors, settings: named.settings }, layout);
			}
		}
		const lookId = this.activeLookId;
		return { layoutId, layout, look: lookId ? this.resolveLook(lookId) : undefined };
	}

	private apply(selectionChanged: boolean): void {
		const { layoutId, layout, look } = this.effective();
		const overrides = voltCustomizeOverrides(layout, look);
		this.storageService.store(LAST_OVERRIDES_KEY, JSON.stringify(overrides), StorageScope.PROFILE, StorageTarget.MACHINE);
		this.registerDefaults(overrides);
		void this.applyPlayground(layout);
		// With the preview in its own window, this one is the devtools platform: plain Volt, no draft.
		const showsDraft = !!this._playground && !this._previewElsewhere;
		const shown = showsDraft ? this.playgroundLayout(layout) : layout;
		this.shownSlots = shown?.slots;
		this.applySlots();
		// The devtools window leaves its panels alone while the preview is elsewhere, so the draft's
		// commands (a terminal tab) don't run again when it switches between plain Volt and the draft.
		if (!(this._playground && this._previewElsewhere)) {
			this.applyWindowState(layoutId, shown, selectionChanged);
		}
		this._onDidChange.fire();
	}

	/** The shown layout's slots, less the buttons of features that are turned off. */
	private applySlots(): void {
		this.slotService.setPlacement(resolveVoltSlotPlacement(this.shownSlots, itemId => this.features.isOn('item', itemId)));
	}

	private readStoredOverrides(): Record<string, unknown> {
		try {
			const value = JSON.parse(this.storageService.get(LAST_OVERRIDES_KEY, StorageScope.PROFILE, '{}'));
			return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		} catch {
			return {};
		}
	}

	/** One registration, swapped whole: a layout or look is a set of configuration defaults. */
	private registerDefaults(overrides: Record<string, unknown>): void {
		if (this.registeredDefaults && JSON.stringify(this.registeredDefaults.overrides) === JSON.stringify(overrides)) {
			return;
		}
		const previous = this.registeredDefaults;
		const next = Object.keys(overrides).length ? { overrides, source: DEFAULTS_SOURCE } : undefined;
		this.registeredDefaults = next;
		if (previous || next) {
			this.registry.deltaConfiguration({ removedDefaults: previous ? [previous] : undefined, addedDefaults: next ? [next] : undefined });
		}
	}

	/** The draft's layout over the base the window would show. */
	private playgroundLayout(base: IVoltLayout | undefined): IVoltLayout | undefined {
		const draft = this.playgroundPreview.layout;
		if (!draft) {
			return base;
		}
		const resolved = draft.extends ? mergeVoltCustomize<IVoltLayout>(this.resolveLayout(draft.extends) ?? {}, { ...draft, extends: undefined }) : draft;
		return resolved;
	}

	/**
	 * A Playground window shows its draft over everything, settings.json included: the values go in
	 * at memory level, which only this window has and nothing saves.
	 */
	private async applyPlayground(base: IVoltLayout | undefined): Promise<void> {
		if (!this._playground) {
			return;
		}
		const draftLook = this.playgroundPreview.look;
		const look = draftLook?.extends ? mergeVoltCustomize<IVoltLook>(this.resolveLook(draftLook.extends) ?? {}, { ...draftLook, extends: undefined }) : draftLook;
		const values = this._previewElsewhere ? {} : voltCustomizeOverrides(this.playgroundLayout(base), look);
		const keys = new Set(Object.keys(values));
		const writes: Promise<void>[] = [];
		for (const key of this.playgroundKeys) {
			if (!keys.has(key)) {
				writes.push(this.configurationService.updateValue(key, undefined, ConfigurationTarget.MEMORY));
			}
		}
		for (const [key, value] of Object.entries(values)) {
			if (JSON.stringify(this.configurationService.inspect(key).memoryValue) !== JSON.stringify(value)) {
				writes.push(this.configurationService.updateValue(key, value, ConfigurationTarget.MEMORY));
			}
		}
		this.playgroundKeys = keys;
		await Promise.all(writes);
	}

	applyLayoutWindowState(): void {
		const { layoutId, layout } = this.effective();
		this.applyWindowState(layoutId, this._playground ? this.playgroundLayout(layout) : layout, true);
	}

	/**
	 * Sidebar, files sidebar and right panel: applied when a layout is picked or its file changes,
	 * never just because the window started, so the user's clicks in between are kept.
	 */
	private applyWindowState(layoutId: string, layout: IVoltLayout | undefined, force: boolean): void {
		if (getLayoutMode(this.layoutService) !== 'agent') {
			return;
		}
		const state = voltLayoutWindowState(layout);
		const key = voltLayoutStateKey(layoutId, state);
		if (!force && this.storageService.get(APPLIED_STATE_KEY, StorageScope.WORKSPACE) === key) {
			return;
		}
		this.storageService.store(APPLIED_STATE_KEY, key, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.doApplyWindowState(state);
	}

	private doApplyWindowState(state: IVoltLayoutWindowState): void {
		if (state.sidebarVisible !== undefined) {
			storeAgentLeftSidebarHidden(this.storageService, !state.sidebarVisible);
			applyLayoutModeChrome(this.layoutService, this.configurationService, this.storageService);
		}
		if (state.sidebarRail !== undefined) {
			toggleAgentSidebarRail(state.sidebarRail);
		}
		if (state.sidebarWidth !== undefined && this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			const size = this.layoutService.getSize(Parts.AUXILIARYBAR_PART);
			this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: state.sidebarWidth, height: size.height });
		}
		if (state.filesSidebarOpen === true) {
			AgentFilesSidebar.show(this.storageService, state.filesSidebarView ?? 'explorer');
		} else if (state.filesSidebarOpen === false) {
			AgentFilesSidebar.setOpen(this.storageService, false);
		}
		if (state.rightPanelOpen !== undefined) {
			const session = agentToolsSessionOnScreen();
			const open = session ? agentSessionToolTabs(session)?.open ?? false : false;
			if (state.rightPanelOpen && !open) {
				openAgentToolsPanel();
			} else if (!state.rightPanelOpen && open) {
				toggleAgentToolsPanel();
			}
		}
		for (const command of state.rightPanelCommands ?? []) {
			this.commandService.executeCommand(command).catch(error => this.logService.warn(`[volt customize] layout command ${command} failed`, error));
		}
	}

	override dispose(): void {
		if (this.registeredDefaults) {
			this.registry.deregisterDefaultConfigurations([this.registeredDefaults]);
		}
		super.dispose();
	}
}

function builtinLayouts(): IVoltCustomizeEntry<IVoltLayout>[] {
	return VOLT_BUILTIN_LAYOUTS.map(entry => ({ id: voltCustomizeId(VOLT_BUILTIN_SOURCE, entry.name), source: VOLT_BUILTIN_SOURCE, name: entry.name, label: entry.value.label ?? entry.name, description: entry.value.description, value: entry.value, errors: [] }));
}

function builtinLooks(): IVoltCustomizeEntry<IVoltLook>[] {
	return VOLT_BUILTIN_LOOKS.map(entry => ({ id: voltCustomizeId(VOLT_BUILTIN_SOURCE, entry.name), source: VOLT_BUILTIN_SOURCE, name: entry.name, label: entry.value.label ?? entry.name, description: entry.value.description, value: entry.value, errors: [] }));
}
