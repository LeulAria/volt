/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { ExternalMcpScope } from '../../../../../platform/voltExternalMcp/common/voltExternalMcp.js';

/** How the consent screen and Connected agents name each scope. */
export function scopeCopy(scope: ExternalMcpScope): { readonly title: string; readonly detail: string } {
	switch (scope) {
		case 'read': return {
			title: localize('externalMcp.scope.read', "Read chats"),
			detail: localize('externalMcp.scope.readDetail', "List, search and read your chats, their queues and worktrees, and wait for replies."),
		};
		case 'send': return {
			title: localize('externalMcp.scope.send', "Message chats"),
			detail: localize('externalMcp.scope.sendDetail', "Send messages to your chats, stop running turns and edit queued messages."),
		};
		case 'launch': return {
			title: localize('externalMcp.scope.launch', "Start chats"),
			detail: localize('externalMcp.scope.launchDetail', "Start new chats and forks on your models. They use your plans and API keys."),
		};
		case 'admin': return {
			title: localize('externalMcp.scope.admin', "Manage chats"),
			detail: localize('externalMcp.scope.adminDetail', "Rename, pin and archive chats, and move them to another model."),
		};
	}
}

/** "Read · Message · Start" */
export function scopeSummary(scopes: readonly ExternalMcpScope[]): string {
	return scopes.map(scope => scopeCopy(scope).title.split(' ')[0]).join(' · ');
}
