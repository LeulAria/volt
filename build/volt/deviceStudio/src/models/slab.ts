/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Rigid devices: phones and tablets, including the old faces with a forehead, a chin and a home
 * button. One shell (frame on the sides, back on the faces), the front glass, the display, keys on
 * the frame, the camera module and logo on the back, the port and grilles on the bottom edge.
 */
import { CylinderGeometry, Group, Mesh, TorusGeometry } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { IDeviceModel } from "../../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";
import type { MaterialKit } from "../materials.ts";
import {
	cameraModule,
	castShadows,
	displaySurface,
	disposeGeometries,
	flatPiece,
	logoMesh,
	placeKey,
	slabGeometry,
	type SlabOptions,
} from "./parts.ts";
import type { BuiltModel, ModelBuilder } from "./types.ts";

/** Builds the rigid part of a device (also used for each half of a foldable). */
export interface SlabParts {
	readonly group: Group;
	/** The back, as a group: x right and y up as seen from the back, +z out of the back. */
	readonly back: Group;
	/** The front face's z. */
	readonly front: number;
}

/** A body shell with front glass, frame and back, centered on the origin. */
export function buildShell(kit: MaterialKit, options: SlabOptions): SlabParts {
	const group = new Group();
	const { geometry, capShape } = slabGeometry(options);
	const shell = new Mesh(geometry, [kit.back, kit.frame]);
	shell.name = "shell";
	group.add(shell);
	const front = options.depth / 2;
	const glass = flatPiece(capShape, kit.bezel, front + 0.01);
	glass.name = "front-glass";
	group.add(glass);
	const back = new Group();
	back.name = "back";
	back.rotation.y = Math.PI;
	back.position.z = -options.depth / 2;
	group.add(back);
	return { group, back, front };
}

/** Thin plastic bands where the antennas break the metal frame. */
export function antennaLines(kit: MaterialKit, width: number, height: number, depth: number, positions: readonly { side: "left" | "right" | "top" | "bottom"; at: number }[]): Group {
	const group = new Group();
	const thickness = depth * 0.62;
	for (const { side, at } of positions) {
		const vertical = side === "left" || side === "right";
		const band = new Mesh(new RoundedBoxGeometry(vertical ? 0.5 : 0.9, vertical ? 0.9 : 0.5, thickness, 1, 0.2), kit.plastic);
		if (vertical) {
			band.position.set(side === "left" ? -width / 2 + 0.2 : width / 2 - 0.2, height / 2 - at, 0);
		} else {
			band.position.set(-width / 2 + at, side === "top" ? height / 2 - 0.2 : -height / 2 + 0.2, 0);
		}
		group.add(band);
	}
	return group;
}

/** The bottom edge: the port and a row of grille holes or slots either side. */
export function bottomEdge(kit: MaterialKit, model: IDeviceModel, width: number, height: number, depth: number): Group {
	const group = new Group();
	const bottom = model.bottom;
	const y = -height / 2 + 0.12;
	const port = bottom?.port;
	if (port) {
		const portWidth = port === "lightning" ? 7.7 : 8.6;
		const portHeight = port === "lightning" ? 1.6 : 2.6;
		const slot = new Mesh(new RoundedBoxGeometry(portWidth, 0.4, portHeight, 3, portHeight * 0.48), kit.hole);
		slot.position.set(0, y, 0);
		group.add(slot);
	}
	const grille = bottom?.grille ?? "holes";
	if (grille !== "none") {
		const start = port ? 7.2 : 4;
		const count = grille === "slots" ? 4 : 6;
		for (const sideSign of [-1, 1]) {
			for (let i = 0; i < count; i++) {
				const x = sideSign * (start + i * (grille === "slots" ? 2.4 : 1.55));
				if (Math.abs(x) > width / 2 - 6) {
					continue;
				}
				const hole =
					grille === "slots"
						? new Mesh(new RoundedBoxGeometry(1.6, 0.3, 0.7, 2, 0.3), kit.hole)
						: new Mesh(new CylinderGeometry(0.42, 0.42, 0.3, 14), kit.hole);
				hole.position.set(x, y, 0);
				group.add(hole);
			}
		}
	}
	void depth;
	return group;
}

export const buildSlab: ModelBuilder = (model: IDeviceModel, kit: MaterialKit): BuiltModel => {
	const { body, screen } = model;
	const root = new Group();
	root.name = "device";
	const options: SlabOptions = {
		width: body.width,
		height: body.height,
		depth: body.depth,
		radius: body.cornerRadius,
		smoothing: body.smoothing,
		edge: body.edge,
		edgeRadius: body.edgeRadius,
	};
	const shell = buildShell(kit, options);
	root.add(shell.group);

	// The display, centered on the face unless offset (old faces with a forehead and chin).
	const surface = displaySurface(screen, kit);
	surface.anchor.position.set(-surface.width / 2 + (screen.offsetX ?? 0), surface.height / 2 - (screen.offsetY ?? 0), shell.front + 0.03);
	root.add(surface.anchor);

	const phone = screen.system === "ios" || screen.system === "android";
	const topBezel = (body.height - surface.height) / 2 - (screen.offsetY ?? 0);
	if (model.homeButton) {
		// Forehead: earpiece slot and front camera; chin: the home button with its ring.
		const chin = (body.height - surface.height) / 2 + (screen.offsetY ?? 0);
		const buttonY = -body.height / 2 + chin / 2;
		const ring = new Mesh(new TorusGeometry(model.homeButton.diameter / 2, 0.22, 12, 64), model.homeButton.touchId ? kit.ring : kit.bezel);
		ring.position.set(0, buttonY, shell.front + 0.05);
		const disc = new Mesh(new CylinderGeometry(model.homeButton.diameter / 2 - 0.1, model.homeButton.diameter / 2 - 0.1, 0.08, 64), kit.darkGlass);
		disc.rotation.x = Math.PI / 2;
		disc.position.set(0, buttonY, shell.front + 0.02);
		root.add(ring, disc);
	}
	if (phone && topBezel > 0) {
		// The earpiece: a slit in the glass at the top (wider on old faces).
		const wide = topBezel > 6;
		const slit = new Mesh(new RoundedBoxGeometry(wide ? 10 : 9, wide ? 1.2 : 0.45, 0.1, 2, wide ? 0.55 : 0.2), kit.hole);
		slit.position.set(0, body.height / 2 - Math.min(topBezel / 2, wide ? topBezel * 0.45 : 1.15), shell.front + 0.04);
		root.add(slit);
		if (wide) {
			const camera = new Mesh(new CylinderGeometry(1.2, 1.2, 0.08, 32), kit.lens);
			camera.rotation.x = Math.PI / 2;
			// With a home button the camera sits centered above the earpiece; otherwise beside it.
			camera.position.set(model.homeButton ? 0 : -14, body.height / 2 - topBezel * (model.homeButton ? 0.25 : 0.45), shell.front + 0.04);
			root.add(camera);
		}
	} else if (!phone && screen.cutout?.kind !== "punch" && screen.cutout?.kind !== "island") {
		// Tablets and displays: the front camera in the bezel.
		const camera = new Mesh(new CylinderGeometry(1, 1, 0.08, 32), kit.lens);
		camera.rotation.x = Math.PI / 2;
		camera.position.set(0, body.height / 2 - Math.max(1.2, topBezel / 2), shell.front + 0.04);
		root.add(camera);
	}

	for (const button of model.buttons ?? []) {
		root.add(placeKey(kit, button, body.width, body.height, body.depth));
	}

	if (model.camera) {
		shell.back.add(cameraModule(kit, model.camera, body.width, body.height));
	}
	if (model.logo) {
		const logo = logoMesh(kit, model.logo);
		if (logo) {
			logo.position.x = (model.logo.x ?? body.width / 2) - body.width / 2;
			logo.position.y = body.height / 2 - (model.logo.y ?? body.height / 2);
			shell.back.add(logo);
		}
	}
	root.add(bottomEdge(kit, model, body.width, body.height, body.depth));

	const metal = kit.finish.frameMaterial !== "plastic";
	if (metal && body.edge === "flat" && phone) {
		const inset = 12;
		root.add(
			antennaLines(kit, body.width, body.height, body.depth, [
				{ side: "left", at: inset },
				{ side: "right", at: inset },
				{ side: "left", at: body.height - inset },
				{ side: "right", at: body.height - inset },
				{ side: "top", at: body.width * 0.72 },
				{ side: "bottom", at: body.width * 0.28 },
			]),
		);
	}
	castShadows(root);
	return {
		root,
		screens: [{ id: "main", spec: screen, anchor: surface.anchor, meshes: [surface.mesh] }],
		ground: "backdrop",
		dispose: () => disposeGeometries(root),
	};
};
