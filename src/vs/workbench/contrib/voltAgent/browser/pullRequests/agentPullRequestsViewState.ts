/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';

export const AGENT_PULL_REQUESTS_CONTAINER_ID = 'workbench.view.voltPullRequests';
export const AGENT_PULL_REQUESTS_VIEW_ID = 'workbench.view.voltPullRequests.list';

let viewSession: string | undefined;
const viewSessionEmitter = new Emitter<void>();

/** The chat whose pull requests the list shows; the files sidebar sets it for the chat it serves. */
export function setPullRequestsViewSession(sessionId: string | undefined): void {
	if (viewSession !== sessionId) {
		viewSession = sessionId;
		viewSessionEmitter.fire();
	}
}

export function pullRequestsViewSession(): string | undefined {
	return viewSession;
}

export const onDidChangePullRequestsViewSession: Event<void> = viewSessionEmitter.event;
