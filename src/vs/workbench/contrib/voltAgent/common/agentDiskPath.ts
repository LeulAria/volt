/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';

/**
 * A folder as a `file:` URI on the computer Volt's host services (git, pull requests, stdio) run
 * on, or undefined when it is not on that computer. In the browser workbench the remote file
 * system serves projects as `vscode-remote:` URIs, while those services run on the same server
 * and take its disk paths. On the desktop a remote folder is on another computer, so only
 * `file:` URIs qualify there.
 *
 * Keep the original URI for the file service (Explorer, editors, reads): only git, pull requests,
 * stdio and terminals want the disk path, and comparisons with Source Control roots want both
 * sides in one form.
 */
export function agentDiskUri(uri: URI | undefined, remoteIsLocal = isWeb): URI | undefined {
	if (!uri) {
		return undefined;
	}
	if (uri.scheme === Schemas.file) {
		return uri;
	}
	return remoteIsLocal && uri.scheme === Schemas.vscodeRemote ? URI.from({ scheme: Schemas.file, path: uri.path }) : undefined;
}

/** {@link agentDiskUri} as a path for the host services, which take paths. */
export function agentDiskPath(uri: URI | undefined, remoteIsLocal = isWeb): string | undefined {
	return agentDiskUri(uri, remoteIsLocal)?.fsPath;
}

/**
 * `uri` in the form to compare folders in: a `vscode-remote:` URI as the `file:` path it names,
 * anything else as it is. A chat names its worktree as a `file:` path while the browser's Git and
 * projects name folders as `vscode-remote:` URIs; both sides of a comparison go through this.
 */
export function agentComparableUri(uri: URI): URI {
	return agentDiskUri(uri, true) ?? uri;
}
