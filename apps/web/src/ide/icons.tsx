/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { languageForPath } from '@volt/client-core';
import { memo } from 'react';
import { SETI_DEFAULT, SETI_EXTENSIONS, SETI_FILE_NAMES, SETI_LANGUAGES, type SetiGlyph } from './setiIcons';

/**
 * The desktop app's icon fonts: codicons (VS Code's product icons, public/fonts/codicon.ttf) for
 * the workbench chrome and Seti (public/fonts/seti.woff) for files, so the web IDE reads exactly
 * like Volt on the computer.
 */
const CODICONS = {
	'files': 'eaf0', 'search': 'ea6d', 'source-control': 'ea68', 'comment-discussion': 'eac7', 'settings-gear': 'eb51', 'account': 'eb99',
	'add': 'ea60', 'close': 'ea76', 'chevron-right': 'eab6', 'chevron-down': 'eab4', 'refresh': 'eb37', 'collapse-all': 'eac5',
	'new-file': 'ea7f', 'new-folder': 'ea80', 'go-to-file': 'ea94', 'git-compare': 'eafd', 'diff': 'eae1', 'file': 'ea7b', 'folder': 'ea83',
	'folder-opened': 'eaf7', 'sparkle': 'ec10', 'robot': 'ec20', 'circle-filled': 'ea71', 'ellipsis': 'ea7c', 'layout-sidebar-left': 'ebf3',
	'layout-sidebar-left-off': 'ec02', 'layout-sidebar-right': 'ebf4', 'layout-sidebar-right-off': 'ec00', 'terminal': 'ea85', 'check': 'eab2',
	'error': 'ea87', 'warning': 'ea6c', 'info': 'ea74', 'bell': 'eaa2', 'sync': 'ea77', 'cloud': 'ebaa', 'debug-disconnect': 'ead0', 'play': 'eb2c',
	'debug-stop': 'ead7', 'history': 'ea82', 'discard': 'eae2', 'edit': 'ea73', 'copy': 'ebcc', 'trash': 'ea81', 'pin': 'eb2b', 'archive': 'ea98',
	'arrow-up': 'eaa1', 'arrow-down': 'ea9a', 'list-tree': 'eb86', 'list-flat': 'eb84', 'case-sensitive': 'eab1', 'whole-word': 'eb7e', 'regex': 'eb38',
	'replace': 'eb3d', 'filter': 'eaf1', 'eye': 'ea70', 'open-preview': 'eb28', 'link-external': 'eb14', 'screen-full': 'eb4c', 'menu': 'eb94',
	'home': 'eb06', 'comment': 'ea6b', 'git-branch': 'ea68', 'device-mobile': 'eadb', 'color-mode': 'eac6', 'key': 'eb11', 'word-wrap': 'eb80',
	'save': 'eb4b', 'preview': 'eb2f', 'clear-all': 'eabf', 'kebab-vertical': 'eb10', 'arrow-left': 'ea9b', 'arrow-right': 'ea9c',
	'split-horizontal': 'eb56', 'split-vertical': 'eb57', 'close-all': 'eac1', 'circle-large-outline': 'ebb5', 'loading': 'eb19', 'compass': 'ebd5',
	'layers': 'ebd2', 'zap': 'ea86', 'shield': 'eb53', 'mention': 'eb1f', 'attach': 'ec34', 'file-media': 'eaea', 'symbol-method': 'ea8c',
	'go-to-search': 'ec32', 'remote': 'eb3a', 'broadcast': 'eaad', 'plug': 'eb2d', 'inbox': 'eb09', 'lock': 'ea75', 'unlock': 'eb74', 'pass': 'eba4',
	'pass-filled': 'ebb3', 'circle-slash': 'eabd', 'debug-pause': 'ead1', 'star-full': 'eb59', 'star-empty': 'ea6a', 'server-process': 'eba2',
	'window': 'eb7f', 'chat-sparkle': 'ec4f', 'copilot': 'ec1e',
} as const;

export type CodiconName = keyof typeof CODICONS;

export const Codicon = memo(function Codicon({ name, size, className, spin, title }: { readonly name: CodiconName; readonly size?: number; readonly className?: string; readonly spin?: boolean; readonly title?: string }) {
	return (
		<span className={`codicon${spin ? ' codicon-spin' : ''}${className ? ` ${className}` : ''}`} style={size ? { fontSize: size } : undefined} aria-hidden={title ? undefined : true} title={title}>
			{String.fromCodePoint(parseInt(CODICONS[name], 16))}
		</span>
	);
});

function setiGlyph(path: string): SetiGlyph {
	const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
	const byName = SETI_FILE_NAMES[name];
	if (byName) {
		return byName;
	}
	// The longest known extension wins (`d.ts`, `spec.ts`, then `ts`).
	const parts = name.split('.');
	for (let i = 1; i < parts.length; i++) {
		const hit = SETI_EXTENSIONS[parts.slice(i).join('.')];
		if (hit) {
			return hit;
		}
	}
	return SETI_LANGUAGES[languageForPath(name).id] ?? SETI_DEFAULT;
}

const glyphs = new Map<string, SetiGlyph>();

/** A file's Seti icon, coloured as in the desktop's file icon theme. */
export const FileIcon = memo(function FileIcon({ path, size = 16, className }: { readonly path: string; readonly size?: number; readonly className?: string }) {
	const key = path.split(/[\\/]/).pop() ?? path;
	let glyph = glyphs.get(key);
	if (!glyph) {
		glyph = setiGlyph(key);
		glyphs.set(key, glyph);
	}
	return (
		<span className={`seti-icon${className ? ` ${className}` : ''}`} style={{ color: glyph[1], fontSize: size * 1.5 }} aria-hidden="true">
			{String.fromCodePoint(parseInt(glyph[0], 16))}
		</span>
	);
});

/** A folder's chevron and icon, as the explorer draws them. */
export function FolderIcon({ open }: { readonly open: boolean }) {
	return <Codicon name={open ? 'folder-opened' : 'folder'} className="folder-icon" />;
}
