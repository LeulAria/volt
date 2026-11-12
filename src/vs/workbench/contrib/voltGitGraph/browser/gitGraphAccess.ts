/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICapabilityRequest } from '../../../services/voltPlugins/common/capabilities.js';

/**
 * What the Git Graph does with git and with chats, checked against its manifest's capabilities
 * (`git.read`, `git.write`, `git.push`, `agents.send`) while its module is active. Until the git
 * broker exists (P3) the graph still goes through the SCM history provider and git's own commands;
 * these checks are where the broker's calls will go, and in report mode they record any use the
 * manifest doesn't declare.
 */

let active: ((request: ICapabilityRequest) => void) | undefined;

/** Set while the module is active (`voltGitGraph.module.ts`). */
export function setGitGraphCheck(check: (request: ICapabilityRequest) => void): IDisposable {
	active = check;
	return toDisposable(() => {
		if (active === check) {
			active = undefined;
		}
	});
}

export function checkGitGraph(api: string, capability: string, target?: string): void {
	active?.({ api: `gitGraph.${api}`, capability, ...(target !== undefined ? { target } : {}) });
}

/**
 * The capability a git command the graph runs needs: pushing (push, sync, publish) is `git.push`,
 * copying a commit's id or message `git.read`, any other git command `git.write`.
 */
export function gitCommandCapability(commandId: string): string | undefined {
	if (!commandId.startsWith('git.')) {
		return undefined;
	}
	return /^git\.(push|sync|publish)/i.test(commandId) ? 'git.push' : /^git\.copy/i.test(commandId) ? 'git.read' : 'git.write';
}
