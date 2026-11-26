/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as SplashScreen from 'expo-splash-screen';

// The splash stays up while the workbench loads behind it.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ fade: true, duration: 200 });

let hidden = false;

/** Once the workbench says it is ready, a native screen shows, or the wait is too long. */
export function hideSplash(): void {
	if (!hidden) {
		hidden = true;
		void SplashScreen.hideAsync().catch(() => undefined);
	}
}
