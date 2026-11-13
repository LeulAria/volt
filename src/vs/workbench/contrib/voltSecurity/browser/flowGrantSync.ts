/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { FLOW_CAPABILITY, IGrant } from '../../../../platform/voltSandbox/common/grants.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IVoltTrustService } from '../../../services/voltTrust/common/voltTrust.js';

/**
 * "Allow for This Chat" on a flow card (G.6) is a session grant of the chat in the grant store
 * (P4): it holds across restarts for that chat until it is revoked on the Access page. The host
 * tool gate keeps its in-memory copy in step with the store.
 */
export class FlowGrantSync extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltFlowGrantSync';

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltTrustService trust: IVoltTrustService,
	) {
		super();
		if (!hostTools.setFlowGrantStore || !hostTools.setStoredFlowGrants) {
			return;
		}
		hostTools.setFlowGrantStore({
			persist: async grant => {
				const { epoch: _epoch, ...draft } = grant;
				// The user's answer on Volt's own flow card (a trusted click, agentBlockRenderers.ts).
				await trust.record({ add: [draft] }, 'approval-card');
			},
			revoke: async ids => { await trust.narrow({ revoke: ids }); },
		});
		const sync = () => {
			hostTools.setStoredFlowGrants?.(storedFlows(trust.state.grants));
			// The "Allow host" grants the network broker applies to extensions: the gate judges their tool flows by them too.
			hostTools.setStoredHostGrants?.(trust.state.grants);
		};
		this._register(trust.onDidChange(sync));
		void trust.whenReady.then(sync);
		this._register({ dispose: () => hostTools.setFlowGrantStore?.(undefined) });
	}
}

export function storedFlows(grants: readonly IGrant[]): IGrant[] {
	return grants.filter(grant => grant.capability === FLOW_CAPABILITY && grant.kind === 'session' && grant.subject.startsWith('chat:'));
}
