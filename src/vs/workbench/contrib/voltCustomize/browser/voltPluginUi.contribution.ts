/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IVoltAgentWindowService, IVoltComposerTray, IVoltComposerTrayHost } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IVoltIconService, VoltIconService } from './voltIconService.js';
import { IVoltPluginUiService } from './voltPluginUi.js';
import { VoltPluginUiService } from './voltPluginUiService.js';
import { VOLT_PLUGIN_VIEW_EDITOR_ID, VoltPluginViewEditor, VoltPluginViewInput, VoltPluginViewInputSerializer } from './voltPluginViews.js';

registerSingleton(IVoltIconService, VoltIconService, InstantiationType.Delayed);
registerSingleton(IVoltPluginUiService, VoltPluginUiService, InstantiationType.Delayed);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VoltPluginViewEditor, VOLT_PLUGIN_VIEW_EDITOR_ID, localize('voltPluginView.editor', "Plugin View")),
	[new SyncDescriptor(VoltPluginViewInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(VoltPluginViewInput.TypeID, VoltPluginViewInputSerializer);

/** The composer tray that holds plugin views placed above the composer. */
export const VOLT_PLUGIN_VIEWS_TRAY_ID = 'volt.pluginViews';

/**
 * Plugin views placed "above the composer": one card each, over the composer of every chat, with
 * the view's title, and a button that puts it away (its slot button brings it back).
 */
class VoltPluginViewsTray extends Disposable implements IVoltComposerTray {

	readonly element: HTMLElement;
	private readonly cards = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		private readonly host: IVoltComposerTrayHost,
		private readonly pluginUi: IVoltPluginUiService,
		private readonly icons: IVoltIconService,
	) {
		super();
		this.element = $('.volt-plugin-tray');
		this._register(pluginUi.onDidChangeShownViews(() => this.render()));
		this.render();
	}

	private render(): void {
		const shown = this.pluginUi.shownViews('aboveComposer');
		for (const id of [...this.cards.keys()]) {
			if (!shown.includes(id)) {
				this.cards.deleteAndDispose(id);
			}
		}
		for (const id of shown) {
			if (this.cards.has(id)) {
				continue;
			}
			const view = this.pluginUi.view(id);
			if (!view) {
				continue;
			}
			const store = new DisposableStore();
			const card = append(this.element, $('.volt-plugin-tray-card'));
			card.dataset.voltView = id;
			const head = append(card, $('.volt-plugin-tray-head'));
			head.appendChild(this.icons.render(this.pluginUi.iconFor(id), view.extensionLocation));
			append(head, $('span.volt-plugin-tray-title')).textContent = view.title;
			const close = append(head, $('button.volt-plugin-tray-close')) as HTMLButtonElement;
			close.type = 'button';
			close.setAttribute('aria-label', localize('voltPluginTray.hide', "Hide {0}", view.title));
			close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
			store.add(addDisposableListener(close, 'click', e => {
				EventHelper.stop(e, true);
				void this.pluginUi.toggleView(id);
			}));
			store.add(this.pluginUi.mountView(id, append(card, $('.volt-plugin-tray-body')), 'aboveComposer'));
			store.add({ dispose: () => card.remove() });
			this.cards.set(id, store);
		}
		this.element.classList.toggle('empty', shown.length === 0);
		this.host.layout();
	}

	setSession(): void {
		// The views follow the chat in front themselves (vscode.volt.chats.current).
	}
}

class VoltPluginUiContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltPluginUi';

	constructor(
		@IVoltPluginUiService pluginUi: IVoltPluginUiService,
		@IVoltAgentWindowService agentWindow: IVoltAgentWindowService,
		@IVoltIconService icons: IVoltIconService,
	) {
		super();
		this._register(agentWindow.registerComposerTray(VOLT_PLUGIN_VIEWS_TRAY_ID, host => new VoltPluginViewsTray(host, pluginUi, icons)));
	}
}

registerWorkbenchContribution2(VoltPluginUiContribution.ID, VoltPluginUiContribution, WorkbenchPhase.BlockRestore);
