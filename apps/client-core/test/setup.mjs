/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// client-core imports its files without an extension (the apps' bundlers resolve them); Node
// needs the `.ts`, which this adds for relative imports when the plain name doesn't exist.
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
			try {
				return nextResolve(`${specifier}.ts`, context);
			} catch {
				// not a .ts file: resolve it as written
			}
		}
		return nextResolve(specifier, context);
	},
});
