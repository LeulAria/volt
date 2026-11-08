/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { VOLT_EXTENSION_SANDBOX_STATE, VOLT_EXTENSION_SANDBOXED } from '../common/voltExtensionSandboxKeys.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltExtensionSandboxService, VoltExtensionSandboxState } from '../../../services/extensions/common/voltExtensionSandbox.js';
import { ExtensionWidget } from './extensionsWidgets.js';

/**
 * The Extensions view's side of per-extension sandboxing (P2; N.1 #22, opt-in per extension):
 * "Run in Sandbox" / "Stop Running in Sandbox" in an extension's menu, "Run Without Sandbox" after
 * a refusal (P8), and the state on its row.
 */

const notBuiltIn = ContextKeyExpr.and(ContextKeyExpr.not('isBuiltinExtension'), ContextKeyExpr.equals('extensionStatus', 'installed'), ContextKeyExpr.not('inExtensionEditor'));

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.extensions.runInSandbox',
			// Only the user, from Volt's UI: an extension must not change where it (or another) runs (B-09).
			visibility: 'internal',
			title: localize2('voltSandbox.runIn', "Run in Sandbox"),
			menu: { id: MenuId.ExtensionContext, group: '2_configure', order: 10, when: ContextKeyExpr.and(notBuiltIn, VOLT_EXTENSION_SANDBOXED.negate()) },
		});
	}
	run(accessor: ServicesAccessor, extensionId: string): Promise<void> {
		return accessor.get(IVoltExtensionSandboxService).setOptedIn(extensionId, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.extensions.stopRunningInSandbox',
			visibility: 'internal',
			title: localize2('voltSandbox.stop', "Stop Running in Sandbox"),
			menu: { id: MenuId.ExtensionContext, group: '2_configure', order: 10, when: ContextKeyExpr.and(notBuiltIn, VOLT_EXTENSION_SANDBOXED) },
		});
	}
	run(accessor: ServicesAccessor, extensionId: string): Promise<void> {
		return accessor.get(IVoltExtensionSandboxService).setOptedIn(extensionId, false);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.extensions.runWithoutSandbox',
			visibility: 'internal',
			title: localize2('voltSandbox.runWithout', "Run Without Sandbox"),
			menu: { id: MenuId.ExtensionContext, group: '2_configure', order: 11, when: ContextKeyExpr.and(notBuiltIn, VOLT_EXTENSION_SANDBOX_STATE.isEqualTo('refused')) },
		});
	}
	async run(accessor: ServicesAccessor, extensionId: string): Promise<void> {
		await accessor.get(IVoltExtensionSandboxService).runWithoutSandbox(extensionId);
	}
});

/** Its row's label: shown only for an opted-in extension. */
export function voltSandboxLabel(state: VoltExtensionSandboxState): { readonly text: string; readonly hover: string; readonly icon: ThemeIcon } | undefined {
	switch (state.kind) {
		case 'shared':
			return undefined;
		case 'sandboxed':
			return { text: localize('voltSandbox.label.on', "Sandboxed"), icon: Codicon.lock, hover: localize('voltSandbox.hover.on', "Runs alone in a sandbox: it reads its own folder, its storage, your toolchains and a trusted workspace, writes only its storage, and reaches no network you did not allow.") };
		case 'starting':
			return { text: localize('voltSandbox.label.starting', "Sandboxed"), icon: Codicon.lock, hover: localize('voltSandbox.hover.starting', "Runs in a sandbox once its host starts (after a reload if you just turned it on).") };
		case 'not-needed':
			return { text: localize('voltSandbox.label.notNeeded', "Sandboxed"), icon: Codicon.lock, hover: localize('voltSandbox.hover.notNeeded', "It has no code to run, so there is nothing to sandbox.") };
		case 'refused':
			return { text: localize('voltSandbox.label.refused', "Off: can't sandbox"), icon: Codicon.warning, hover: localize('voltSandbox.hover.refused', "Stays off: {0} Choose Run Without Sandbox in its menu to run it anyway.", state.reason) };
		case 'unsandboxed':
			return { text: localize('voltSandbox.label.unsandboxed', "Not sandboxed"), icon: Codicon.unlock, hover: localize('voltSandbox.hover.unsandboxed', "You chose to run it without the sandbox. Stop Running in Sandbox in its menu clears that choice.") };
	}
}

export class VoltSandboxStatusWidget extends ExtensionWidget {

	private readonly rendered = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		@IVoltExtensionSandboxService private readonly sandbox: IVoltExtensionSandboxService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this._register(this.sandbox.onDidChange(id => {
			if (!id || (this.extension && id.toLowerCase() === this.extension.identifier.id.toLowerCase())) {
				this.render();
			}
		}));
		this._register(toDisposable(() => this.rendered.clear()));
	}

	render(): void {
		this.rendered.clear();
		const extension = this.extension;
		const label = extension && !extension.isBuiltin ? voltSandboxLabel(this.sandbox.state(extension.identifier.id)) : undefined;
		if (!label) {
			return;
		}
		const element = append(this.container, $('span.extension-kind-indicator.volt-sandbox-status'));
		append(element, $('span' + ThemeIcon.asCSSSelector(label.icon)));
		append(element, $('span', undefined, label.text));
		this.rendered.add(toDisposable(() => element.remove()));
		this.rendered.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), element, label.hover));
	}
}
