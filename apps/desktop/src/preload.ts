/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the Volt web app sees of the Volt Agents window (`window.voltShell`, see webShell.ts).
// It only learns that it is in the app and which menu commands to run; the server does the rest.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('voltShell', {
	platform: process.platform,
	onCommand(listener: (command: string) => void): void {
		ipcRenderer.on('volt-shell:command', (_event, command: unknown) => {
			if (typeof command === 'string') {
				listener(command);
			}
		});
	},
});
