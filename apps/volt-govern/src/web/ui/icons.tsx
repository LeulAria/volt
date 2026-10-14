/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { memo } from 'react';

/**
 * VS Code's product icons (codicons), from the same font the desktop ships
 * (src/vs/base/browser/ui/codicons/codicon/codicon.ttf); code points from codiconsLibrary.ts.
 */
const CODICONS = {
	'account': 'eb99', 'add': 'ea60', 'archive': 'ea98', 'cloud-upload': 'eac3', 'pin': 'eb2b', 'arrow-down': 'ea9a', 'arrow-left': 'ea9b', 'arrow-right': 'ea9c', 'arrow-up': 'eaa1', 'bell': 'eaa2', 'bell-dot': 'eb9a',
	'book': 'eaa4', 'briefcase': 'eaac', 'calendar': 'eab0', 'check': 'eab2', 'checklist': 'eab3', 'chevron-down': 'eab4', 'chevron-left': 'eab5',
	'chevron-right': 'eab6', 'chevron-up': 'eab7', 'circle-filled': 'ea71', 'circle-large-outline': 'ebb5', 'circle-slash': 'eabd', 'clear-all': 'eabf',
	'close': 'ea76', 'cloud': 'ebaa', 'cloud-download': 'eac2', 'collapse-all': 'eac5', 'comment-discussion': 'eac7', 'copilot': 'ec1e', 'copy': 'ebcc',
	'credit-card': 'eac9', 'dashboard': 'eacd', 'database': 'eace', 'debug-disconnect': 'ead0', 'device-desktop': 'ea7a', 'discard': 'eae2', 'edit': 'ea73',
	'ellipsis': 'ea7c', 'error': 'ea87', 'export': 'ebac', 'extensions': 'eae6', 'eye': 'ea70', 'eye-closed': 'eae7', 'feedback': 'eb96', 'file-code': 'eae9',
	'file-text': 'ea7b', 'filter': 'eaf1', 'gear': 'eaf8', 'globe': 'eb01', 'go-to-file': 'ea94', 'graph': 'eb03', 'graph-line': 'ebe2', 'history': 'ea82',
	'home': 'eb06', 'info': 'ea74', 'issues': 'eb0c', 'json': 'eb0f', 'kebab-vertical': 'eb10', 'key': 'eb11', 'law': 'eb12', 'layout-panel': 'ebf2',
	'layout-panel-off': 'ec01', 'layout-sidebar-left': 'ebf3', 'layout-sidebar-left-off': 'ec02', 'library': 'eb9c', 'link': 'eb15', 'link-external': 'eb14',
	'list-flat': 'eb84', 'list-tree': 'eb86', 'list-unordered': 'eb17', 'loading': 'eb19', 'lock': 'ea75', 'mail': 'eb1c', 'markdown': 'eb1d', 'mcp': 'ec47',
	'menu': 'eb94', 'new-file': 'ea7f', 'note': 'eb26', 'open-preview': 'eb28', 'organization': 'ea7e', 'output': 'eb9d', 'pass': 'eba4', 'pass-filled': 'ebb3',
	'person': 'ea67', 'person-add': 'ebcd', 'pie-chart': 'ebe4', 'play': 'eb2c', 'plug': 'eb2d', 'preview': 'eb2f', 'pulse': 'eb31', 'question': 'eb32',
	'refresh': 'eb37', 'report': 'eb42', 'robot': 'ec20', 'rocket': 'eb44', 'save': 'eb4b', 'search': 'ea6d', 'server': 'eb50', 'server-environment': 'eba3',
	'server-process': 'eba2', 'settings-gear': 'eb51', 'shield': 'eb53', 'sign-in': 'ea6f', 'sign-out': 'ea6e', 'sparkle': 'ec10', 'symbol-class': 'eb5b',
	'symbol-key': 'ea93', 'symbol-method': 'ea8c', 'sync': 'ea77', 'tag': 'ea66', 'terminal': 'ea85', 'tools': 'eb6d', 'trash': 'ea81', 'type-hierarchy': 'ebb9',
	'unlock': 'eb74', 'verified': 'eb77', 'warning': 'ea6c', 'watch': 'eb7c', 'workspace-trusted': 'ebc1', 'workspace-untrusted': 'ebc2', 'zap': 'ea86',
	'color-mode': 'eac6', 'unfold': 'eb73', 'arrow-small-up': 'eaa0', 'arrow-small-down': 'ea9d', 'vm': 'ea7a',
	'inbox': 'eb09', 'bell-slash': 'ec08',
	'beaker': 'ea79', 'quote': 'eb33', 'send': 'ec0f', 'stop-circle': 'eba5', 'code': 'eac4', 'chip': 'ec19', 'arrow-circle-up': 'ebff', 'dash': 'eacc',
} as const;

export type CodiconName = keyof typeof CODICONS;

export const Codicon = memo(function Codicon({ name, size, className, spin, title }: { readonly name: CodiconName; readonly size?: number; readonly className?: string; readonly spin?: boolean; readonly title?: string }) {
	return (
		<span className={`codicon${spin ? ' codicon-spin' : ''}${className ? ` ${className}` : ''}`} style={size ? { fontSize: size } : undefined} aria-hidden={title ? undefined : true} title={title} role={title ? 'img' : undefined} aria-label={title}>
			{String.fromCodePoint(parseInt(CODICONS[name], 16))}
		</span>
	);
});

/** The Volt bolt. */
export function Bolt({ size = 14 }: { readonly size?: number }) {
	return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" /></svg>;
}

/** Up and down chevrons: a selector that opens a list (the organization switcher). */
export function ChevronsUpDown({ size = 12 }: { readonly size?: number }) {
	return <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className="chevrons"><path d="M5 6.25 8 3.25l3 3M5 9.75l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
