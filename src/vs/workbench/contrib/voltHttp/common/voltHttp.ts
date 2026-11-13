/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The HTTP client feature's contract: the ids core knows it by. Its parts (the request editor, the
 * Requests and History views, the CodeLens in .http files, its commands) live in
 * `contrib/voltHttp/browser/`; the `volt.http-client` built-in extension turns them on and off.
 */

export const HTTP_CLIENT_FEATURE_ID = 'httpClient';
/** Its entry in the right panel's "+" menu (the manifest's `voltSurfaces` id). */
export const HTTP_CLIENT_SURFACE_ID = 'http';
