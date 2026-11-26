/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Scans a QR code with the system's own scanner: VisionKit's DataScannerViewController on iOS,
 * Google's code scanner (Play services, no camera permission) on Android. Neither ships a
 * barcode engine in the app.
 */
interface IVoltScannerModule {
	isAvailable(): Promise<boolean>;
	scan(): Promise<string | null>;
}

const native = requireOptionalNativeModule<IVoltScannerModule>('VoltScanner');

/** False on simulators, devices without the scanner, and Android without Play services. */
export function isAvailable(): Promise<boolean> {
	return native ? native.isAvailable().catch(() => false) : Promise.resolve(false);
}

/** The first QR code's text, or null when the user cancelled. */
export function scan(): Promise<string | null> {
	return native ? native.scan() : Promise.reject(new Error('This build has no code scanner.'));
}
