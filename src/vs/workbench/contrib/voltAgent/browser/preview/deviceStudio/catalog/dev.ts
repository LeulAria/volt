/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDeviceCatalogEntry } from '../deviceModel.js';

/** Placeholder while the researched catalog is written. */
export const DEV_DEVICES: readonly IDeviceCatalogEntry[] = [
	{
		id: 'iphone-17-pro', label: 'iPhone 17 Pro', group: 'iphone', year: 2025, agent: 'iphone',
		model: {
			family: 'slab',
			body: { width: 71.9, height: 150.0, depth: 8.75, cornerRadius: 11.5, smoothing: 0.7, edge: 'flat', edgeRadius: 1.1 },
			screen: { width: 402, height: 874, dpr: 3, ppi: 460, safeTop: 62, safeBottom: 34, cornerRadius: 62, cutout: { kind: 'island', width: 125, height: 37, top: 11 }, system: 'ios' },
			camera: {
				plateau: { x: 0, y: 0, width: 71.9, height: 40, radius: 11.5, raise: 2.2, material: 'frame' },
				lenses: [
					{ x: 15, y: 11.5, diameter: 10.5, ring: 1.4, raise: 1.2 },
					{ x: 15, y: 29, diameter: 10.5, ring: 1.4, raise: 1.2 },
					{ x: 30, y: 20.2, diameter: 10.5, ring: 1.4, raise: 1.2 },
				],
				marks: [
					{ x: 43.5, y: 11.5, diameter: 5.5, kind: 'flash' },
					{ x: 43.5, y: 29, diameter: 5, kind: 'lidar' },
					{ x: 36, y: 5.5, diameter: 1, kind: 'mic' },
				],
			},
			buttons: [
				{ side: 'left', at: 27, length: 6.5, kind: 'action' },
				{ side: 'left', at: 40, length: 11, kind: 'button' },
				{ side: 'left', at: 54.5, length: 11, kind: 'button' },
				{ side: 'right', at: 41, length: 17, kind: 'button' },
				{ side: 'right', at: 92, length: 17, kind: 'cameraControl' },
			],
			bottom: { port: 'usbc', grille: 'holes' },
			logo: { kind: 'apple', size: 15, y: 75 },
			finishes: [
				{ id: 'cosmic-orange', label: 'Cosmic Orange', frame: '#e0702e', back: '#e47a3a', backMaterial: 'aluminum', frameMaterial: 'aluminum', camera: '#e0702e' },
				{ id: 'deep-blue', label: 'Deep Blue', frame: '#2f3b52', back: '#34405a', backMaterial: 'aluminum', frameMaterial: 'aluminum' },
				{ id: 'silver', label: 'Silver', frame: '#d9dadc', back: '#e8e8ea', backMaterial: 'aluminum', frameMaterial: 'aluminum' },
			],
		},
	},
];
