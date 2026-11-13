/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltSecurity.css';
import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { ITrustHistoryEntry, ITrustState } from '../../../../platform/voltSandbox/common/trust.js';
import { IVoltTrustService } from '../../../services/voltTrust/common/voltTrust.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { ISandboxWorkloadsKit } from './sandboxWorkloadsSection.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "5 permissions held by 3 extensions and chats. Last 7 days: 2 denied, 40 allowed." */
export function permissionsSummaryText(state: ITrustState, history: readonly ITrustHistoryEntry[], now: number): string {
	const subjects = new Set(state.grants.map(grant => grant.subject)).size;
	const recent = history.filter(entry => now - entry.at < WEEK_MS);
	const denied = recent.filter(entry => entry.decision === 'deny').length;
	const allowed = recent.filter(entry => entry.decision === 'allow').length;
	const held = state.grants.length
		? localize('voltSecurity.permissionsHeld', "{0} permissions held by {1} extensions and chats.", state.grants.length, subjects)
		: localize('voltSecurity.permissionsNone', "No extension or chat holds a permission beyond its sandbox.");
	return `${held} ${localize('voltSecurity.permissionsWeek', "Last 7 days: {0} denied, {1} allowed.", denied, allowed)}`;
}

/**
 * The Security page's line about permissions (P4): how many are held and what was denied lately,
 * with a way to the Access page, which lists them. The Security page doesn't repeat that list.
 */
export class PermissionsSummarySection {

	constructor(
		private readonly kit: ISandboxWorkloadsKit,
		private readonly openAccess: () => void,
		@IVoltTrustService private readonly trust: IVoltTrustService,
	) { }

	render(): void {
		const { kit, trust } = this;
		kit.sectionLabel(localize('voltSecurity.permissions', "Permissions"));
		const group = kit.settingsGroup();
		const row = append(group, $('.volt-security-workload.volt-security-permissions'));
		append(row, $('.volt-security-workload-icon')).appendChild(renderIcon(trust.state.status === 'torn' ? Codicon.warning : Codicon.key));
		const copy = append(row, $('.volt-security-workload-copy'));
		const text = append(copy, $('.volt-security-workload-meta.volt-security-permissions-text'));
		const reset = append(copy, $('.volt-security-workload-meta'));
		const open = kit.store.add(createVoltButton(append(row, $('.volt-security-workload-actions')), 'secondary'));
		open.label = localize('voltSecurity.openAccess', "Open Access");
		kit.store.add(open.onDidClick(() => this.openAccess()));
		const draw = (history: readonly ITrustHistoryEntry[]) => {
			if (!kit.isCurrent()) {
				return;
			}
			text.textContent = permissionsSummaryText(trust.state, history, Date.now());
			reset.hidden = trust.state.status !== 'torn';
			reset.textContent = localize('voltSecurity.permissionsReset', "Permissions were reset: the permissions file could not be read.");
		};
		draw([]);
		void trust.refresh().then(() => trust.history(1000)).then(draw);
	}
}
