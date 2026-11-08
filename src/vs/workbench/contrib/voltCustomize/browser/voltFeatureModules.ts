/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { CommandVisibility } from '../../../../platform/commands/common/commands.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { IVoltPluginContext } from '../../../services/voltPlugins/common/voltApi.js';

/**
 * A Volt feature's code, in its own folder (`contrib/volt<Feature>/`, named by its built-in
 * extension's `voltModule.entry`), loaded when the feature is first used and unloaded when its
 * extension is disabled (spec H.11, M3).
 *
 * A module registers nothing at import time. `activate` registers its commands, editors and views
 * into `host.subscriptions`; disposing them is what unloads it, so enabling and disabling the
 * extension needs no reload. Core reaches a loaded module only through the contract file in the
 * feature's `common/` folder (ids, types and the module's interface), which the import lint
 * (`build/volt/ci/featureImportLint.mjs`) enforces.
 */

/** What a module activates with. */
export interface IVoltFeatureModuleHost {
	/** The feature's `volt` API context, from its built-in extension's manifest (report mode). */
	readonly plugin: IVoltPluginContext;
	readonly instantiationService: IInstantiationService;
	/** Disposed when the module unloads. */
	readonly subscriptions: DisposableStore;
	/**
	 * Serves the editors of `typeId` (listed in its table entry's `editors`). Core keeps the
	 * registration with VS Code's editor registry, so a tab restored before the module loads waits
	 * for it instead of being dropped.
	 */
	registerEditorSerializer(typeId: string, serializer: IEditorSerializer): void;
	/**
	 * Draws a part core hosts (a Settings page, a button's hover card, a side toolbar section). Its
	 * id must be one the feature's manifest contributes (`voltSettingsPages`, `voltSlotItems`,
	 * `voltDock`); it goes away when the module unloads.
	 */
	registerPart<K extends VoltFeatureModulePartKind>(kind: K, id: string, part: IVoltFeatureModulePartTypes[K]): void;
}

/** A Volt Settings page a module draws, made on first visit and kept while the module is loaded. */
export interface IVoltFeatureSettingsPage extends IDisposable {
	readonly element: HTMLElement;
	setVisible(visible: boolean): void;
}

/** The settings editor's building blocks, so a page a module draws looks like every other one. */
export interface IVoltSettingsPageKit {
	/** Cleared when the page is drawn again or left. */
	readonly store: DisposableStore;
	pageHead(title: string, lead?: string): void;
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	toggle(parent: HTMLElement, on: boolean, label: string, onClick: () => void): void;
	stepper(parent: HTMLElement, valueText: string, unit: string, onCommit: (next: number) => number, step: number): void;
	/** Re-renders the page (after a setting changed). */
	rerender(): void;
	isCurrent(): boolean;
}

/** A side toolbar section a module draws. */
export interface IVoltFeatureDockSection extends IDisposable {
	readonly section: HTMLElement;
	/** Reads and draws only while shown. */
	setShown(shown: boolean): void;
}

export type VoltFeatureHoverPlacement = 'above' | 'start';

/** The parts core hosts for a module, by kind; core asks for one by the id its manifest gives it. */
export interface IVoltFeatureModulePartTypes {
	/** A Volt Settings page (`voltSettingsPages`). `container` is the element its dialogs center over. */
	readonly settingsPage: { create(instantiationService: IInstantiationService, container: () => HTMLElement): IVoltFeatureSettingsPage };
	/** A Volt Settings page drawn with the editor's own rows, afresh on every visit (`voltSettingsPages`). */
	readonly settingsKitPage: { render(instantiationService: IInstantiationService, kit: IVoltSettingsPageKit): void };
	/** What hovering a sidebar or footer button shows instead of its tooltip (`voltSlotItems`). */
	readonly itemHover: { attach(instantiationService: IInstantiationService, anchor: HTMLElement, placement: VoltFeatureHoverPlacement): IDisposable };
	/** A side toolbar section (`voltDock`). */
	readonly dockSection: { create(instantiationService: IInstantiationService, parent: HTMLElement): IVoltFeatureDockSection };
}

export type VoltFeatureModulePartKind = keyof IVoltFeatureModulePartTypes;

/** The manifest contribution point that lists each kind of part's ids. */
export const VOLT_FEATURE_MODULE_PART_POINTS = {
	settingsPage: 'voltSettingsPages',
	settingsKitPage: 'voltSettingsPages',
	itemHover: 'voltSlotItems',
	dockSection: 'voltDock',
} as const satisfies Record<VoltFeatureModulePartKind, string>;

export interface IVoltFeatureModule {
	activate(host: IVoltFeatureModuleHost): void | Promise<void>;
}

/** A command a module registers, as core shows it before the module is loaded. */
export interface IVoltFeatureModuleCommand {
	readonly id: string;
	/** With `f1`, the Command Palette lists it before the module loads. */
	readonly title?: ILocalizedString;
	readonly category?: ILocalizedString;
	readonly f1?: boolean;
	/** The real command's visibility (default `internal`). */
	readonly visibility?: Extract<CommandVisibility, 'internal' | 'public'>;
}

/** One module in core's table (`voltFeatureModuleTable.ts`). */
export interface IVoltFeatureModuleEntry {
	/** `voltModule.feature` of its built-in extension. */
	readonly feature: string;
	/** Imports the module's entry file. Only the table imports it. */
	readonly load: () => Promise<IVoltFeatureModule>;
	/** Commands that load the module when run (a stub stands in until it is loaded). */
	readonly commands?: readonly IVoltFeatureModuleCommand[];
	/** Editor input type ids the module serializes. */
	readonly editors?: readonly string[];
	/**
	 * `use` (default): on first use. `startup`: also once the window has restored (`onStartupFinished`,
	 * first party only, spec H.2), for a feature that serves agents rather than a view (its tools).
	 */
	readonly activation?: 'use' | 'startup';
}

export const IVoltFeatureModuleService = createDecorator<IVoltFeatureModuleService>('voltFeatureModuleService');

export interface IVoltFeatureModuleService {
	readonly _serviceBrand: undefined;
	/** A module was loaded or unloaded. */
	readonly onDidChange: Event<string>;
	isActive(feature: string): boolean;
	/**
	 * Loads and activates the feature's module (once) and returns it; undefined while the feature
	 * is off or has no module. The result is the module's own object, typed by its contract file.
	 */
	activate<T extends IVoltFeatureModule = IVoltFeatureModule>(feature: string): Promise<T | undefined>;
	/**
	 * The feature whose manifest contributes this part, if it has a module and is on. Lets core
	 * keep a place for the part (a rail button, a nav entry) without loading the module.
	 */
	partOwner(kind: VoltFeatureModulePartKind, id: string): string | undefined;
	/** The part, loading its feature's module first; undefined while the feature is off. */
	part<K extends VoltFeatureModulePartKind>(kind: K, id: string): Promise<IVoltFeatureModulePartTypes[K] | undefined>;
	/** The window has restored: `startup` modules whose feature is on load now, and again whenever it is turned back on. */
	startupFinished(): void;
}
