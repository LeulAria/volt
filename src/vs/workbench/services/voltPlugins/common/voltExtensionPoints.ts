/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionsRegistry, IExtensionPoint } from '../../extensions/common/extensionsRegistry.js';
import { IVoltContributes, VOLT_CONTRIBUTION_POINTS, VOLT_CONTRIBUTION_SCHEMAS, VOLT_TOOLS_EXTENSION_POINT, VOLT_VIEWS_EXTENSION_POINT } from './voltContributions.js';

/**
 * Volt's contribution points in the extension point registry: their schemas join the
 * `package.json` schema, and `voltPluginService.ts` reads (and validates) what enabled extensions
 * contribute. A tool's extension activates on its first call (`onTool:<name>`, H.2).
 */
export const VOLT_EXTENSION_POINTS: { readonly [K in keyof IVoltContributes]-?: IExtensionPoint<NonNullable<IVoltContributes[K]>> } = Object.fromEntries(VOLT_CONTRIBUTION_POINTS.map(point => [point, ExtensionsRegistry.registerExtensionPoint<unknown>({
	extensionPoint: point,
	jsonSchema: VOLT_CONTRIBUTION_SCHEMAS[point],
	...(point === VOLT_TOOLS_EXTENSION_POINT ? {
		activationEventsGenerator: (tools: readonly unknown[]) => tools.flatMap(tool => tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string' ? [`onTool:${(tool as { name: string }).name}`] : []),
	} : {}),
	// A view's extension activates when Volt first shows it, as VS Code's own webview views do.
	...(point === VOLT_VIEWS_EXTENSION_POINT ? {
		activationEventsGenerator: (views: readonly unknown[]) => views.flatMap(view => view && typeof view === 'object' && typeof (view as { id?: unknown }).id === 'string' ? [`onView:${(view as { id: string }).id}`] : []),
	} : {}),
})])) as never;
