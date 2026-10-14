/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The web app's stand-in for vs/amdX: node modules the agent window loads from its install
// (KaTeX) are served by the agent server under /node_modules/.

import { mainWindow } from '../../../../../base/browser/window.js';

export const canASAR = false;

const loading = new Map<string, Promise<unknown>>();

/** Loads a UMD bundle with a script tag and returns the global it defines (`katex` → window.katex). */
export function importAMDNodeModule<T>(nodeModuleName: string, pathInsideNodeModule: string): Promise<T> {
	const url = resolveAmdNodeModulePath(nodeModuleName, pathInsideNodeModule);
	let promise = loading.get(url);
	if (!promise) {
		promise = new Promise<unknown>((resolve, reject) => {
			const script = mainWindow.document.createElement('script');
			script.src = url;
			script.onload = () => resolve((globalThis as Record<string, unknown>)[nodeModuleName]);
			script.onerror = () => reject(new Error(`Could not load ${url}`));
			mainWindow.document.head.appendChild(script);
		});
		loading.set(url, promise);
	}
	return promise as Promise<T>;
}

export function resolveAmdNodeModulePath(nodeModuleName: string, pathInsideNodeModule: string): string {
	return `/node_modules/${nodeModuleName}/${pathInsideNodeModule}`;
}
