/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISavedEnvironment } from '@volt/client-core/src/environments';

/**
 * Live Activities are iOS only (`liveClient.ios.ts`). Everywhere else nothing starts, and the
 * bundler leaves the agent server client and the activity planner out of the bundle.
 */
export function startLiveClient(_environment: ISavedEnvironment, _baseUrl: () => string | undefined): () => void {
	return () => undefined;
}
