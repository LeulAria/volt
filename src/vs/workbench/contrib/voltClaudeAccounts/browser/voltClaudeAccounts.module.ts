/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltAccountsService } from '../../../../platform/voltAccounts/common/voltAccounts.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { IClaudeAccountsSection, IClaudeAccountsSectionHost, IVoltClaudeAccountsModule } from '../common/voltClaudeAccounts.js';
import { ClaudeAccountsSection } from './claudeAccountsSection.js';

/**
 * The Claude accounts section of Providers & Models, as a module of the `volt.claude-accounts`
 * built-in extension. It registers nothing: the page asks it for the section. The broker that
 * switches logins is core and follows the extension on its own (`setClaudeAccountsEnabled`).
 */
class VoltClaudeAccountsModule implements IVoltFeatureModule, IVoltClaudeAccountsModule {

	private host: IVoltFeatureModuleHost | undefined;

	activate(host: IVoltFeatureModuleHost): void {
		this.host = host;
		host.subscriptions.add(toDisposable(() => this.host = undefined));
	}

	createProvidersSection(instantiationService: IInstantiationService, sectionHost: IClaudeAccountsSectionHost): IClaudeAccountsSection | undefined {
		const host = this.host;
		if (!host) {
			throw new Error('The Claude accounts module is not loaded.');
		}
		const services = instantiationService.invokeFunction(accessor => ({
			accounts: accessor.getIfExists(IVoltAccountsService),
			configuration: accessor.get(IConfigurationService),
		}));
		if (!services.accounts) {
			return undefined;
		}
		const section = new ClaudeAccountsSection(sectionHost, services.accounts, services.configuration);
		// Unloading the module takes the section with it; the page's own dispose is then a no-op.
		const registration = host.subscriptions.add(section);
		return {
			render: parent => section.render(parent),
			dispose: () => host.subscriptions.delete(registration),
		};
	}
}

export const voltClaudeAccountsModule: IVoltFeatureModule & IVoltClaudeAccountsModule = new VoltClaudeAccountsModule();
