/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { languageForPath } from '@volt/client-core';
import { memo } from 'react';
import { SvgXml } from 'react-native-svg';
import { MATERIAL_EXTENSIONS, MATERIAL_FILE_NAMES, MATERIAL_LANGUAGES, MATERIAL_SVGS } from './materialIcons';

/** The desktop's icon for a file name: exact names first, then the longest extension (`test.ts` before `ts`), then its language. */
function iconFor(path: string): string {
	const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
	const byName = MATERIAL_FILE_NAMES[name];
	if (byName) {
		return byName;
	}
	for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
		const icon = MATERIAL_EXTENSIONS[name.slice(dot + 1)];
		if (icon) {
			return icon;
		}
	}
	return MATERIAL_LANGUAGES[languageForPath(path).id] ?? 'file';
}

/** A file or folder's icon from the Material Icon Theme, the same one the desktop's explorer and change lists show. */
export const FileIcon = memo(function FileIcon({ path, kind = 'file', open, size = 18 }: { readonly path: string; readonly kind?: 'file' | 'dir'; readonly open?: boolean; readonly size?: number }) {
	const icon = kind === 'dir' ? (open ? 'folder-open' : 'folder') : iconFor(path);
	return <SvgXml xml={MATERIAL_SVGS[icon] ?? MATERIAL_SVGS.file} width={size} height={size} />;
});
