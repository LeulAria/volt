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
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import Severity from '../../../../base/common/severity.js';
import { t3BrokenExports, VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING } from '../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
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
	async run(accessor: ServicesAccessor, extensionId: string): Promise<void> {
		const sandbox = accessor.get(IVoltExtensionSandboxService);
		// H.5: alone in its host it can't share `exports` with the extensions it depends on or that depend on it. Say so first.
		const links = t3BrokenExports([extensionId], accessor.get(IExtensionService).extensions.map(extension => ({
			id: extension.identifier.value, builtin: extension.isBuiltin, code: !!(extension.main || extension.browser), extensionDependencies: extension.extensionDependencies,
		})));
		if (links.length) {
			const { confirmed } = await accessor.get(IDialogService).confirm({
				type: Severity.Warning,
				message: localize('voltSandbox.exports', "Run {0} in a sandbox without the extensions it works with?", extensionId),
				detail: localize('voltSandbox.exportsDetail', "In a sandbox it runs alone, so these extensions can't call each other's API (exports) and parts of them may not work:\n{0}", links.map(link => localize('voltSandbox.exportsLink', "{0} uses {1}", link.from, link.to)).join('\n')),
				primaryButton: localize({ key: 'voltSandbox.exportsButton', comment: ['&& denotes a mnemonic'] }, "&&Run in Sandbox"),
			});
			if (!confirmed) {
				return;
			}
		}
		return sandbox.setOptedIn(extensionId, true);
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

const killSwitchOn = ContextKeyExpr.equals(`config.${VOLT_EXTENSION_SANDBOX_KILL_SWITCH_SETTING}`, true);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.extensions.sandboxKillSwitch',
			// The user's choice only (B-09): no extension may switch the sandbox off.
			visibility: 'internal',
			title: localize2('voltSandbox.killSwitch', "Switch Off the Extension Sandbox"),
			category: localize2('voltSandbox.category', "Volt"),
			f1: true,
			precondition: killSwitchOn.negate(),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVoltExtensionSandboxService).setKillSwitch(true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.extensions.sandboxKillSwitchOff',
			visibility: 'internal',
			title: localize2('voltSandbox.killSwitchOff', "Switch the Extension Sandbox Back On"),
			category: localize2('voltSandbox.category', "Volt"),
			f1: true,
			precondition: killSwitchOn,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVoltExtensionSandboxService).setKillSwitch(false);
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
			if (state.code === 'kill-switch') {
				return { text: localize('voltSandbox.label.held', "Off: sandbox switched off"), icon: Codicon.warning, hover: localize('voltSandbox.hover.held', "The extension sandbox is switched off, so it stays off until you choose. Run Without Sandbox in its menu runs it anyway; switching the sandbox back on runs it sandboxed after a reload.") };
			}
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
