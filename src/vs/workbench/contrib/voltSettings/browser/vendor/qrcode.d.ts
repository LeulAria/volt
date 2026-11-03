/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types for qrcode.js: qrcode-generator 2.0.4 (MIT, Kazuhiko Arase), vendored as is.

export interface QRCode {
	addData(data: string, mode?: 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'): void;
	make(): void;
	getModuleCount(): number;
	isDark(row: number, col: number): boolean;
}

export declare function qrcode(typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): QRCode;
export default qrcode;
