/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * What a model builder hands the studio. Builders work in millimetres with the device lying in
 * its natural "open" pose facing +z (screen toward the viewer), +y up, +x right.
 */
import type { Group, Mesh, Object3D, Quaternion } from "three";
import type {
	DevicePosture,
	IDeviceModel,
	IDeviceScreen,
} from "../../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";
import type { MaterialKit } from "../materials.ts";
import type { ScreenExtras } from "../screen.ts";

export type ScreenId = "main" | "cover";

/** A display on the model. */
export interface ModelScreen {
	readonly id: ScreenId;
	readonly spec: IDeviceScreen;
	/**
	 * The display's own frame: origin at its top-left corner as you look at it (portrait), +x right,
	 * +y up (so CSS y is -y), +z out of the glass toward the viewer. 1 local unit is 1 CSS px of the
	 * display (the anchor is scaled by mm per px). The live page is laid on this plane.
	 */
	readonly anchor: Object3D;
	/**
	 * The lit surface, as meshes in the anchor's space (CSS px, y up). Their UVs span the whole display:
	 * u 0..1 left to right, v 0..1 bottom to top. The studio gives them the screen texture.
	 */
	readonly meshes: readonly Mesh[];
	/** The display folds with the hinge: only flat (the hinge at `open`) can the live page sit on it. */
	readonly bends?: boolean;
	readonly extras?: ScreenExtras;
}

export interface ModelHinge {
	/** Hinge angles, degrees: 0 shut, 180 flat; laptops 0 shut, ~110 open. */
	readonly closed: number;
	readonly half: number;
	readonly open: number;
	/** Poses the model at `degrees`. */
	set(degrees: number): void;
}

export interface BuiltModel {
	/** The device in mm. The studio re-centers it on its bounding box. */
	readonly root: Group;
	readonly screens: readonly ModelScreen[];
	readonly hinge?: ModelHinge;
	/**
	 * How the device rests facing the viewer in a posture, as a rotation of `root`. Undefined lets the
	 * studio turn the posture's live display square to the viewer (always right for rigid devices).
	 */
	restView?(posture: DevicePosture): Quaternion | undefined;
	/** Where the shadow falls: a backdrop behind the device (phones) or a floor under it (laptops, displays). */
	readonly ground?: "backdrop" | "floor";
	dispose(): void;
}

export type ModelBuilder = (model: IDeviceModel, kit: MaterialKit) => BuiltModel;
