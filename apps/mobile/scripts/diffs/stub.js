/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stands in for Shiki and the bundled theme catalogs: the phone's page highlights with
// Highlights (WebAssembly lexers) and its own Volt theme, so none of them ship.
function missing() {
	throw new Error('Not in the phone\'s diff bundle');
}

export const createHighlighterCore = missing;
export const createCssVariablesTheme = missing;
export const normalizeTheme = missing;
export const createJavaScriptRegexEngine = missing;
export const createOnigurumaEngine = missing;
export const bundledLanguages = {};
export const themes = {};
export const EncodedTokenMetadata = { getForeground: missing, getFontStyle: missing };
export const INITIAL = {};
export default {};
