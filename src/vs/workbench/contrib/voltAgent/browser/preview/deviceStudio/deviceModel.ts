/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The physical description of a device the browser's responsive mode can draw: its body, displays,
 * cameras, buttons and colors, in real units. The 3D device studio (build/volt/deviceStudio) builds
 * its model from this, so this file has no imports and holds only data types.
 *
 * Units and axes, unless a field says otherwise:
 * - Lengths are millimetres. Display sizes and cutouts are CSS px of that display.
 * - Front view, portrait: x runs right, y runs down, from the body's top-left corner.
 * - The back is measured as seen from the back (turn the device over left to right): x runs right
 *   from the back's own top-left corner, which is the front's top-right corner.
 */

/** How the device is built, which picks the model builder. */
export type DeviceFamily =
	/** One rigid body: phones, tablets, phones with home buttons. */
	| 'slab'
	/** Two halves on a vertical hinge, a large inner display and a cover display (Galaxy Z Fold, Pixel Pro Fold, iPhone Duo, Surface Duo). */
	| 'foldBook'
	/** Two halves on a horizontal hinge, a tall inner display and a small cover display (Galaxy Z Flip). */
	| 'flip'
	/** A base with keyboard and trackpad and a hinged lid (MacBook). */
	| 'laptop'
	/** A screen on a stand or speaker base (Nest Hub). */
	| 'display';

/** The system drawn in the display's status bar. */
export type DeviceSystem = 'ios' | 'ipados' | 'android' | 'macos' | 'windows' | 'other';

/** What a cutout in the display looks like, in CSS px of that display. */
export type DeviceCutout =
	/** Dynamic Island: a pill `top` px from the display's top edge, centered. */
	| { readonly kind: 'island'; readonly width: number; readonly height: number; readonly top: number }
	/** A notch hanging from the top edge, centered, with rounded lower corners. */
	| { readonly kind: 'notch'; readonly width: number; readonly height: number; readonly radius?: number }
	/** A round camera hole; `x` is its center from the display's left edge (default: centered). */
	| { readonly kind: 'punch'; readonly diameter: number; readonly top: number; readonly x?: number }
	/** A camera under the display (a faint disc), or none at all. */
	| { readonly kind: 'none' };

export interface IDeviceScreen {
	/** The whole lit display in CSS px, portrait (for laptops and displays: as the system lays it out, landscape). */
	readonly width: number;
	readonly height: number;
	/** Device pixels per CSS px. */
	readonly dpr: number;
	/** Device pixels per inch. With `dpr` this sets the display's size in mm: width / (ppi / dpr) * 25.4. */
	readonly ppi: number;
	/**
	 * Rows the system keeps for itself, CSS px, portrait: the status bar (or the macOS menu bar) at the top
	 * and the home indicator or navigation bar at the bottom. The page gets the rest: width × (height - safeTop - safeBottom).
	 */
	readonly safeTop: number;
	readonly safeBottom: number;
	/** The display's own corner radius, CSS px. */
	readonly cornerRadius: number;
	readonly cutout?: DeviceCutout;
	/** The display's center relative to the center of the face it sits on, mm, x right and y down as you look at the display; 0 when centered. */
	readonly offsetX?: number;
	readonly offsetY?: number;
	readonly system: DeviceSystem;
}

/** A lens, flash or sensor on the back, center position in mm (back view). */
export interface IDeviceCameraLens {
	readonly x: number;
	readonly y: number;
	readonly diameter: number;
	/** Width of the metal ring around the glass, mm (0: flush). */
	readonly ring?: number;
	/** How far the ring stands above the surface under it, mm. */
	readonly raise?: number;
	/** A periscope telephoto looks through a square window. */
	readonly window?: 'round' | 'square';
}

export interface IDeviceCameraMark {
	readonly x: number;
	readonly y: number;
	readonly diameter: number;
	readonly kind: 'flash' | 'lidar' | 'mic' | 'sensor' | 'led';
}

/** The camera module on the back. */
export interface IDeviceCamera {
	/**
	 * The raised plateau the lenses sit on (back view, its top-left corner in mm). Absent when each lens
	 * rises on its own (Galaxy S Ultra). A visor across the whole back starts at x 0 and spans the width.
	 */
	readonly plateau?: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
		readonly radius: number;
		/** Height above the back, mm. */
		readonly raise: number;
		/** What it is made of: the back's glass, the frame's metal, or a dark glass panel. */
		readonly material?: 'back' | 'frame' | 'glass' | 'dark';
	};
	readonly lenses: readonly IDeviceCameraLens[];
	readonly marks?: readonly IDeviceCameraMark[];
}

/** A key on the frame. Sides are as seen from the front; `at` is mm from the top (side keys) or from the left (top/bottom keys). */
export interface IDeviceButton {
	readonly side: 'left' | 'right' | 'top' | 'bottom';
	readonly at: number;
	readonly length: number;
	/** `cameraControl` sits flush in a sapphire well; `switch` is a ring/silent switch; `touchId` a flat power key with a sensor. */
	readonly kind?: 'button' | 'action' | 'cameraControl' | 'switch' | 'touchId';
}

/** A color the device comes in. Hex colors. */
export interface IDeviceFinish {
	readonly id: string;
	readonly label: string;
	/** The side frame (the band around the device). */
	readonly frame: string;
	/** The back panel. */
	readonly back: string;
	readonly backMaterial?: 'matteGlass' | 'glossyGlass' | 'aluminum' | 'leather' | 'ceramic' | 'fabric';
	readonly frameMaterial?: 'aluminum' | 'titanium' | 'polishedSteel' | 'matteAluminum' | 'plastic';
	/** The camera plateau, when it differs from the back. */
	readonly camera?: string;
	/** The border inside the front glass around the display (white on old white-front devices). */
	readonly bezel?: string;
	/** Laptops: the keycaps. */
	readonly keys?: string;
}

/**
 * A book-style foldable (`foldBook`): `body` and `screen` describe it unfolded; it folds along its vertical center
 * line, the right half closing over the left. `camera` is placed on the unfolded back (back view), which is the
 * closed device's back.
 */
export interface IDeviceFoldBook {
	/** The cover display, on the outer face of the right half (seen from the front when closed). */
	readonly cover: IDeviceScreen;
	/** Thickness when folded shut, mm (more than twice `body.depth` when the halves don't close flat). */
	readonly closedDepth: number;
	/** Width of the hinge spine seen from the side when closed, mm. */
	readonly spine?: number;
	/** Two separate displays with a gap between them instead of one folding display (Surface Duo), mm. */
	readonly gap?: number;
	/** A faint crease down the middle of the inner display, 0..1. */
	readonly crease?: number;
}

/**
 * A clamshell foldable (`flip`): `body` and `screen` describe it unfolded; it folds along a horizontal line `foldAt`
 * mm from the top, the top half closing onto the bottom. `camera` sits on the unfolded back (back view), beside the cover display.
 */
export interface IDeviceFlip {
	/** The cover display on the outer face of the top half (back view). */
	readonly cover: IDeviceScreen & {
		/** Its top-left corner on the top half's back, mm (back view). */
		readonly x: number;
		readonly y: number;
	};
	readonly foldAt: number;
	readonly closedDepth: number;
	readonly crease?: number;
}

/**
 * A laptop: `body` is the base, with `body.height` its depth from front to back and `body.depth` its thickness;
 * `screen` is the lid's display (landscape, `safeTop` the menu bar). Keyboard and trackpad are measured on the
 * base's top face from its back-left corner (`top` from the hinge edge, `bottom` from the front edge).
 */
export interface IDeviceLaptop {
	/** The lid's thickness, mm. Its width matches the base; its height is `lidHeight`. */
	readonly lidThickness: number;
	readonly lidHeight: number;
	/** The camera notch at the top of the display, CSS px. */
	readonly notch?: { readonly width: number; readonly height: number };
	/** Keyboard well and trackpad, mm. */
	readonly keyboard: { readonly width: number; readonly depth: number; readonly top: number; readonly key: number; readonly gap: number };
	readonly trackpad: { readonly width: number; readonly depth: number; readonly bottom: number };
	/** Speaker grilles on either side of the keyboard. */
	readonly speakers?: { readonly width: number; readonly depth: number };
	/** Ports on the left and right sides, from back to front. */
	readonly ports?: { readonly left: readonly LaptopPort[]; readonly right: readonly LaptopPort[] };
	/** The name printed under the display, if any. */
	readonly bezelLabel?: string;
	/** Lid angle the device opens to, degrees from closed. */
	readonly openAngle?: number;
}

export type LaptopPort = 'magsafe' | 'thunderbolt' | 'usbc' | 'hdmi' | 'sdxc' | 'headphone';

/** A display (`display`): `body` is the screen's frame; `stand` sits under it. */
export interface IDeviceDisplayStand {
	readonly kind: 'speakerBase' | 'foot';
	readonly width: number;
	readonly depth: number;
	readonly height: number;
	readonly color: string;
}

/** Everything the studio needs to build one device. */
export interface IDeviceModel {
	readonly family: DeviceFamily;
	readonly body: {
		readonly width: number;
		readonly height: number;
		/** Thickness without the camera bump, mm. */
		readonly depth: number;
		/** Corner radius of the outline seen from the front, mm. */
		readonly cornerRadius: number;
		/** 0 draws circular corners, 1 Apple's continuous (squircle) corners. */
		readonly smoothing?: number;
		/**
		 * The side profile: `flat` straight sides with small rounded edges (iPhone 12 and later, Galaxy S),
		 * `round` sides rounded into the front and back (Pixel, iPhone 6-11), `soft` flat sides with large edge radii (iPad).
		 */
		readonly edge: 'flat' | 'round' | 'soft';
		/** Radius where the sides meet the front and back glass, mm. */
		readonly edgeRadius?: number;
	};
	readonly screen: IDeviceScreen;
	/** Old-style faces: a forehead with earpiece and camera, a chin with a home button. Bezel sizes come from the screen's offset. */
	readonly homeButton?: { readonly diameter: number; readonly touchId?: boolean };
	readonly camera?: IDeviceCamera;
	readonly buttons?: readonly IDeviceButton[];
	/** Ports and grilles on the bottom edge. */
	readonly bottom?: { readonly port?: 'usbc' | 'lightning'; readonly grille?: 'holes' | 'slots' | 'none' };
	/** The mark on the back, centered unless placed (mm, back view, center). */
	readonly logo?: { readonly kind: 'apple' | 'google' | 'samsung' | 'microsoft' | 'text'; readonly text?: string; readonly x?: number; readonly y?: number; readonly size: number };
	readonly finishes: readonly IDeviceFinish[];
	readonly foldBook?: IDeviceFoldBook;
	readonly flip?: IDeviceFlip;
	readonly laptop?: IDeviceLaptop;
	readonly stand?: IDeviceDisplayStand;
}

/** One entry of the device menu. */
export interface IDeviceCatalogEntry {
	readonly id: string;
	readonly label: string;
	readonly group: 'iphone' | 'pixel' | 'galaxy' | 'ipad' | 'mac' | 'standard';
	/** Release year, newest first within a group. */
	readonly year: number;
	/** The browser the device's user agent claims. */
	readonly agent: 'iphone' | 'ipad' | 'androidPhone' | 'androidTablet' | 'mac' | 'windows' | 'other';
	/** The posture the device starts in (foldables and laptops), default `open`. */
	readonly posture?: DevicePosture;
	readonly model: IDeviceModel;
}

/** How a foldable or laptop is opened. */
export type DevicePosture =
	/** Folded shut: foldables show their cover display; a laptop's lid is down. */
	| 'closed'
	/** Partly open: a foldable at 90 degrees (Flex mode), a laptop's lid at 45 degrees. */
	| 'half'
	/** Fully open: foldables flat, a laptop at its working angle. */
	| 'open';

/** The display a posture uses: foldables browse on the cover display when closed. */
export function postureScreen(model: IDeviceModel, posture: DevicePosture): IDeviceScreen {
	if (posture === 'closed') {
		if (model.foldBook) {
			return model.foldBook.cover;
		}
		if (model.flip) {
			return model.flip.cover;
		}
	}
	return model.screen;
}

/** CSS px of `screen` per mm of glass. */
export function screenPxPerMm(screen: IDeviceScreen): number {
	return screen.ppi / screen.dpr / 25.4;
}

/** The page's viewport on `screen`, portrait: the display less the system's rows. */
export function screenViewport(screen: IDeviceScreen): { width: number; height: number } {
	return { width: screen.width, height: screen.height - screen.safeTop - screen.safeBottom };
}
