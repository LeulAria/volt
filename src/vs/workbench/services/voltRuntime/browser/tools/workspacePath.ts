/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../../../base/common/path.js';
import { isEqualOrParent, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';

export function resolveWorkspaceUri(root: URI | undefined, raw: string | undefined): URI | undefined {
	const path = raw?.trim();
	if (!path || !root) {
		return undefined;
	}
	const uri = path.includes('://') ? URI.parse(path) : isAbsolute(path) ? URI.file(path) : joinPath(root, path);
	return isEqualOrParent(uri, root) ? uri : undefined;
}

export function displayPath(root: URI | undefined, uri: URI): string {
	if (!root) {
		return uri.fsPath;
	}
	const base = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
	const full = uri.fsPath.replace(/\\/g, '/');
	return full === base ? '.' : full.startsWith(base + '/') ? full.slice(base.length + 1) : uri.fsPath;
}
