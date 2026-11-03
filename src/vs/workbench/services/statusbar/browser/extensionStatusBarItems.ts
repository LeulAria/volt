/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IManagedHoverTooltipMarkdownString } from '../../../../base/browser/ui/hover/hover.js';
import { Event } from '../../../../base/common/event.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { ThemeColor } from '../../../../base/common/themables.js';
import { Command } from '../../../../editor/common/languages.js';
import { IAccessibilityInformation } from '../../../../platform/accessibility/common/accessibility.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStatusbarEntry, StatusbarAlignment } from './statusbar.js';

// The extension status bar items service, declared here (implemented in api/browser/statusBarExtensionPoint.ts)
// so workbench contributions can read the items: Volt mirrors them in the agent window's side toolbar.

export const IExtensionStatusBarItemService = createDecorator<IExtensionStatusBarItemService>('IExtensionStatusBarItemService');

export interface IExtensionStatusBarItemChangeEvent {
	readonly added?: ExtensionStatusBarEntry;
	readonly removed?: string;
	/** An existing item's text, tooltip or command changed (Volt mirrors items outside the status bar). */
	readonly updated?: ExtensionStatusBarEntry;
}

export type ExtensionStatusBarEntry = [string, {
	entry: IStatusbarEntry;
	alignment: StatusbarAlignment;
	priority: number;
}];

export const enum StatusBarUpdateKind {
	DidDefine,
	DidUpdate
}

export interface IExtensionStatusBarItemService {
	readonly _serviceBrand: undefined;

	onDidChange: Event<IExtensionStatusBarItemChangeEvent>;

	setOrUpdateEntry(id: string, statusId: string, extensionId: string | undefined, name: string, text: string, tooltip: IMarkdownString | string | undefined | IManagedHoverTooltipMarkdownString, command: Command | undefined, color: string | ThemeColor | undefined, backgroundColor: ThemeColor | undefined, alignLeft: boolean, priority: number | undefined, accessibilityInformation: IAccessibilityInformation | undefined): StatusBarUpdateKind;

	unsetEntry(id: string): void;

	getEntries(): Iterable<ExtensionStatusBarEntry>;
}
