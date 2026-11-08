/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { CommandVisibility } from '../../../../platform/commands/common/commands.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorsOrder, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
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
}

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
}

/**
 * Closes the module's tabs (editors of `typeIds`) when it unloads because its feature was turned
 * off: with its editor pane unregistered they couldn't show. Not when the window shuts down, so
 * they still come back after a reload.
 */
export function closeModuleEditorsOnUnload(host: IVoltFeatureModuleHost, typeIds: readonly string[]): void {
	host.subscriptions.add(toDisposable(() => host.instantiationService.invokeFunction(accessor => {
		if (accessor.get(ILifecycleService).willShutdown) {
			return;
		}
		const editorService = accessor.get(IEditorService);
		const open = editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => typeIds.includes(editor.typeId));
		if (open.length) {
			void editorService.closeEditors(open);
		}
	})));
}

/** A module's editor drawn inside another editor (a page Volt Settings hosts). */
export interface IVoltEmbeddedEditorPage extends IDisposable {
	setVisible(visible: boolean): void;
	layout(width: number, height: number): void;
}

/**
 * Shows `input` in `pane` inside `parent`. The page belongs to the module: unloading it disposes
 * the page (the host's own `dispose` is then a no-op).
 */
export function embedModuleEditor(host: IVoltFeatureModuleHost, pane: EditorPane, input: EditorInput, parent: HTMLElement): IVoltEmbeddedEditorPage {
	const store = new DisposableStore();
	store.add(pane);
	store.add(input);
	let size: Dimension | undefined;
	pane.create(parent);
	pane.setVisible(true);
	void pane.setInput(input, undefined, {}, CancellationToken.None).then(() => {
		if (size && !store.isDisposed) {
			pane.layout(size);
		}
	});
	const registration = host.subscriptions.add(store);
	return {
		setVisible: visible => pane.setVisible(visible),
		layout: (width, height) => {
			size = new Dimension(width, height);
			pane.layout(size);
		},
		dispose: () => host.subscriptions.delete(registration),
	};
}
