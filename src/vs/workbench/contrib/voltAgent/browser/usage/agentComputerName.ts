/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';

/**
 * This computer's name as the OS shows it ("Leul's MacBook Pro"). The desktop reads it from the
 * main process at startup (electron-browser/agentComputerName.contribution.ts); the web has none.
 * Kept here so browser code can show it without depending on the native host service.
 */
let computerName: string | undefined;
const onDidChange = new Emitter<void>();

export const onDidChangeComputerName: Event<void> = onDidChange.event;

export function getComputerName(): string | undefined {
	return computerName;
}

export function setComputerName(name: string): void {
	if (name && name !== computerName) {
		computerName = name;
		onDidChange.fire();
	}
}
