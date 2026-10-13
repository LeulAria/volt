/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService, OpenExternalOptions, OpenInternalOptions } from '../../../../../platform/opener/common/opener.js';
import { parseChangeRequestUrl, providerForKnownHost, readHostSettings, VOLT_SOURCE_CONTROL_HOSTS_SETTING } from '../../../../../platform/voltPullRequests/common/voltPrHosts.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { AGENT_PR_LINK_DESTINATION_SETTING, readLinkDestination } from '../../common/agentGitSettings.js';
import { OPEN_PULL_REQUEST_COMMAND_ID } from './agentPullRequestCommands.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';

/** Pages the pull request view opens on the host: the opener below lets them through. */
const toHost = new Set<string>();

/** Opens a pull request's page on its host (its number, a comment, its files), not Volt's view of it. */
export async function openOnHost(openerService: IOpenerService, url: string): Promise<boolean> {
	toHost.add(url);
	try {
		return await openerService.open(url);
	} finally {
		toHost.delete(url);
	}
}

/**
 * Pull request links from chats, terminals and editors open where Settings > Git & PRs says: in
 * Volt's pull request view, or in the default browser. Registered last, so it runs before the
 * agent layout's in-app browser takes every http link.
 */
class AgentPullRequestLinkOpener extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentPullRequestLinks';

	constructor(
		@IOpenerService openerService: IOpenerService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IAgentPullRequestService pullRequests: IAgentPullRequestService,
	) {
		super();
		this._register(openerService.registerOpener({
			open: async (resource: URI | string, options?: OpenInternalOptions | OpenExternalOptions) => {
				if ((options as OpenExternalOptions | undefined)?.openExternal) {
					return false;
				}
				const url = typeof resource === 'string' ? resource : resource.toString(true);
				if (toHost.has(url)) {
					return false;
				}
				const parsed = parseChangeRequestUrl(url);
				if (!parsed) {
					return false;
				}
				// `/pull/N` is GitHub's shape (Enterprise hosts too); other shapes only on a host Volt knows.
				const host = parsed.repo.host;
				const known = parsed.provider === 'github'
					|| providerForKnownHost(host) !== 'unknown'
					|| readHostSettings(configurationService.getValue(VOLT_SOURCE_CONTROL_HOSTS_SETTING)).has(host)
					|| pullRequests.signedInHosts().some(credential => credential.host === host);
				if (!known) {
					return false;
				}
				if (readLinkDestination(configurationService.getValue(AGENT_PR_LINK_DESTINATION_SETTING)) === 'browser') {
					return openerService.open(url, { openExternal: true });
				}
				await commandService.executeCommand(OPEN_PULL_REQUEST_COMMAND_ID, url);
				return true;
			},
		}));
	}
}

registerWorkbenchContribution2(AgentPullRequestLinkOpener.ID, AgentPullRequestLinkOpener, WorkbenchPhase.Eventually);
