/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Parts device builders share: body shells with real edge profiles, the lit display and its
 * anchor, keys, camera lenses, ports and logos. Millimetres, +z out of the face a part sits on.
 */
import {
	AdditiveBlending,
	BufferAttribute,
	CanvasTexture,
	CylinderGeometry,
	ExtrudeGeometry,
	Group,
	LatheGeometry,
	Mesh,
	MeshPhysicalMaterial,
	Object3D,
	Shape,
	ShapeGeometry,
	SRGBColorSpace,
	TorusGeometry,
	Vector2,
	type BufferGeometry,
	type Material,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type {
	IDeviceButton,
	IDeviceCamera,
	IDeviceModel,
	IDeviceScreen,
} from "../../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";
import type { MaterialKit } from "../materials.ts";
import { APPLE_LOGO_PATH } from "../screen.ts";
import { roundedRect, toShape, type PathCommand } from "../shapes.ts";

/** px per mm of a display (CSS px). */
export function pxPerMm(screen: IDeviceScreen): number {
	return screen.ppi / screen.dpr / 25.4;
}

/** The display's physical size, mm. */
export function screenSizeMm(screen: IDeviceScreen): { width: number; height: number } {
	const px = pxPerMm(screen);
	return { width: screen.width / px, height: screen.height / px };
}

/** Apple draws continuous corners; most others draw circular ones. */
export function displaySmoothing(screen: IDeviceScreen): number {
	return screen.system === "ios" || screen.system === "ipados" || screen.system === "macos" ? 0.6 : 0.1;
}

/** A centered rounded outline, y-down commands. */
export function outline(width: number, height: number, radius: number, smoothing = 0): PathCommand[] {
	return roundedRect(-width / 2, -height / 2, width, height, Math.max(0, Math.min(radius, width / 2, height / 2)), smoothing);
}

export function shapeOf(commands: readonly PathCommand[]): Shape {
	return toShape(new Shape(), commands, true);
}

export interface SlabOptions {
	readonly width: number;
	readonly height: number;
	readonly depth: number;
	readonly radius: number;
	readonly smoothing?: number;
	readonly edge: IDeviceModel["body"]["edge"];
	readonly edgeRadius?: number;
}

/** The edge rounding a profile uses: horizontal inset and vertical extent of the curve, mm. */
export function edgeRounding(options: SlabOptions): { inset: number; extent: number } {
	const { depth, edge } = options;
	if (edge === "round") {
		return { inset: Math.min(options.edgeRadius ?? 1.4, options.width * 0.03), extent: depth * 0.44 };
	}
	const radius = options.edgeRadius ?? (edge === "soft" ? Math.min(1.6, depth * 0.24) : Math.min(0.9, depth * 0.12));
	const r = Math.min(radius, depth * 0.48);
	return { inset: r, extent: r };
}

/**
 * A rigid body shell centered on the origin, front at +z. Group 0 is the front and back faces, group 1
 * the sides and their rounded edges (the frame).
 */
export function slabGeometry(options: SlabOptions): { geometry: ExtrudeGeometry; capShape: Shape; capInset: number } {
	const { width, height, depth, radius } = options;
	const smoothing = options.smoothing ?? 0;
	const { inset, extent } = edgeRounding(options);
	const cap = outline(width - inset * 2, height - inset * 2, Math.max(0.2, radius - inset), smoothing);
	const capShape = shapeOf(cap);
	const geometry = new ExtrudeGeometry(capShape, {
		depth: Math.max(0.01, depth - extent * 2),
		bevelEnabled: true,
		bevelThickness: extent,
		bevelSize: inset,
		bevelSegments: options.edge === "round" ? 12 : 7,
		curveSegments: 14,
	});
	geometry.translate(0, 0, -(depth / 2 - extent));
	geometry.computeVertexNormals();
	return { geometry, capShape, capInset: inset };
}

/** A flat face piece (glass, panel) from a shape, at z. */
export function flatPiece(shape: Shape, material: Material, z: number, segments = 18): Mesh {
	const mesh = new Mesh(new ShapeGeometry(shape, segments), material);
	mesh.position.z = z;
	return mesh;
}

/** UVs spanning the geometry's bounds (u left to right, v bottom to top). */
export function planarUv(geometry: BufferGeometry, minX: number, minY: number, width: number, height: number): void {
	const position = geometry.getAttribute("position");
	const uv = new Float32Array(position.count * 2);
	for (let i = 0; i < position.count; i++) {
		uv[i * 2] = (position.getX(i) - minX) / width;
		uv[i * 2 + 1] = (position.getY(i) - minY) / height;
	}
	geometry.setAttribute("uv", new BufferAttribute(uv, 2));
}

export interface DisplaySurface {
	/** Top-left of the display, scaled to CSS px (see ModelScreen.anchor). */
	readonly anchor: Group;
	readonly mesh: Mesh;
	readonly width: number;
	readonly height: number;
}

/**
 * The lit display: a rounded surface in the anchor's CSS px space, with a sheen layer over it that
 * reflects the room like the cover glass. Place the anchor at the display's top-left corner.
 */
export function displaySurface(spec: IDeviceScreen, kit: MaterialKit, part?: { x: number; width: number }): DisplaySurface {
	const px = pxPerMm(spec);
	const anchor = new Group();
	anchor.name = "display-anchor";
	anchor.scale.setScalar(1 / px);
	const smoothing = displaySmoothing(spec);
	const radius = spec.cornerRadius;
	let commands: PathCommand[];
	if (part) {
		// One half of a folding display: rounded only on its outer corners.
		const left = part.x <= 0.5;
		commands = roundedRect(part.x, 0, part.width, spec.height, left ? [radius, 0, 0, radius] : [0, radius, radius, 0], smoothing);
	} else {
		commands = roundedRect(0, 0, spec.width, spec.height, radius, smoothing);
	}
	const geometry = new ShapeGeometry(toShape(new Shape(), commands, true), 24);
	planarUv(geometry, 0, -spec.height, spec.width, spec.height);
	const mesh = new Mesh(geometry);
	mesh.name = "display";
	anchor.add(mesh);
	const sheen = new Mesh(geometry, kit.screenSheen);
	sheen.position.z = 0.6;
	sheen.renderOrder = 2;
	sheen.name = "display-sheen";
	anchor.add(sheen);
	return { anchor, mesh, width: spec.width / px, height: spec.height / px };
}

/** A key on the frame, as a rounded bar. `length` along the edge, `protrude` out of it, `thickness` across the side. */
export function keyMesh(kit: MaterialKit, button: IDeviceButton, length: number, protrude: number, thickness: number): Object3D {
	const group = new Group();
	const vertical = button.side === "left" || button.side === "right";
	const sx = vertical ? protrude * 2 : length;
	const sy = vertical ? length : protrude * 2;
	if (button.kind === "cameraControl") {
		// Sapphire crystal flush in the frame with a thin polished surround.
		const rim = new Mesh(new RoundedBoxGeometry(sx * 0.6, sy, thickness * 1.02, 3, Math.min(thickness, protrude) * 0.45), kit.ring);
		const crystal = new Mesh(new RoundedBoxGeometry(sx * 0.62, sy - 0.5, thickness * 0.8, 3, 0.3), kit.lens);
		group.add(rim, crystal);
		return group;
	}
	if (button.kind === "switch") {
		const slot = new Mesh(new RoundedBoxGeometry(sx * 0.7, sy, thickness * 0.9, 2, 0.35), kit.hole);
		const nub = new Mesh(new RoundedBoxGeometry(sx * 1.1, sy * 0.45, thickness * 0.6, 2, 0.3), kit.frame);
		nub.position.y = vertical ? sy * 0.18 : 0;
		group.add(slot, nub);
		return group;
	}
	const radius = Math.min(sx, sy, thickness) * 0.48;
	const key = new Mesh(new RoundedBoxGeometry(sx, sy, thickness, 4, radius), button.kind === "action" ? kit.frame : kit.frame);
	group.add(key);
	if (button.kind === "touchId") {
		const ring = new Mesh(new RoundedBoxGeometry(sx * 1.04, sy * 1.02, thickness * 0.5, 3, radius * 0.5), kit.ring);
		group.add(ring);
	}
	return group;
}

/** Places `button` on a body `width` × `height` × `depth` centered at the origin. */
export function placeKey(kit: MaterialKit, button: IDeviceButton, width: number, height: number, depth: number, z = 0, inset = 0.25): Object3D {
	const protrude = button.kind === "cameraControl" ? 0.12 : button.kind === "switch" ? 0.3 : 0.55;
	const thickness = Math.min(depth * 0.4, 3.1);
	const key = keyMesh(kit, button, button.length, protrude, thickness);
	const along = button.at + button.length / 2;
	switch (button.side) {
		case "left":
			key.position.set(-width / 2 + inset - protrude * 0, height / 2 - along, z);
			break;
		case "right":
			key.position.set(width / 2 - inset, height / 2 - along, z);
			break;
		case "top":
			key.position.set(-width / 2 + along, height / 2 - inset, z);
			break;
		case "bottom":
			key.position.set(-width / 2 + along, -height / 2 + inset, z);
			break;
	}
	return key;
}

/** A lens with its ring, standing on z = 0 and looking along +z. */
export function lensMesh(kit: MaterialKit, diameter: number, ring = 0.8, raise = 0.6, window: "round" | "square" = "round"): Object3D {
	const group = new Group();
	const r = diameter / 2;
	const outer = r + Math.max(0.15, ring);
	const height = Math.max(0.05, raise);
	if (window === "square") {
		const side = diameter;
		const rim = new Mesh(new RoundedBoxGeometry(side + ring * 2, side + ring * 2, height * 2, 4, Math.min(1.2, side * 0.2)), kit.ring);
		rim.position.z = 0;
		const glass = new Mesh(new RoundedBoxGeometry(side, side, height * 2 + 0.02, 4, Math.min(0.9, side * 0.15)), kit.lens);
		group.add(rim, glass);
		return group;
	}
	// The ring: a lathe profile with a softly rounded lip.
	const lip = Math.min(0.25, height * 0.4);
	const profile = [
		new Vector2(r - 0.05, 0),
		new Vector2(r - 0.05, height - lip),
		new Vector2(r + lip * 0.4, height),
		new Vector2(outer - lip, height),
		new Vector2(outer - lip * 0.25, height - lip * 0.25),
		new Vector2(outer, height - lip),
		new Vector2(outer, 0),
	];
	const ringMesh = new Mesh(new LatheGeometry(profile, 64), kit.ring);
	ringMesh.rotation.x = Math.PI / 2;
	group.add(ringMesh);
	// Cover glass, a dark barrel, and the front element with its coating.
	const barrel = new Mesh(new CylinderGeometry(r - 0.05, r - 0.05, 0.2, 48), kit.lensInside);
	barrel.rotation.x = Math.PI / 2;
	barrel.position.z = height - 0.45;
	group.add(barrel);
	const element = new Mesh(new CylinderGeometry(r * 0.62, r * 0.62, 0.1, 48), kit.lens);
	element.rotation.x = Math.PI / 2;
	element.position.z = height - 0.3;
	group.add(element);
	const ringInner = new Mesh(new TorusGeometry(r * 0.78, r * 0.045, 8, 48), kit.lensInside);
	ringInner.position.z = height - 0.28;
	group.add(ringInner);
	const cover = new Mesh(new CylinderGeometry(r - 0.05, r - 0.05, 0.08, 48), kit.coverGlass);
	cover.rotation.x = Math.PI / 2;
	cover.position.z = height - 0.12;
	cover.renderOrder = 2;
	group.add(cover);
	return group;
}

/** A flash, LiDAR window, microphone hole or sensor, flat on z = 0. */
export function markMesh(kit: MaterialKit, kind: NonNullable<IDeviceCamera["marks"]>[number]["kind"], diameter: number): Object3D {
	const r = diameter / 2;
	switch (kind) {
		case "flash": {
			const group = new Group();
			const disc = new Mesh(new CylinderGeometry(r, r, 0.12, 40), kit.flash);
			disc.rotation.x = Math.PI / 2;
			disc.position.z = 0.06;
			const ring = new Mesh(new TorusGeometry(r, 0.12, 8, 40), kit.ring);
			ring.position.z = 0.08;
			group.add(disc, ring);
			return group;
		}
		case "lidar":
		case "sensor":
		case "led": {
			const disc = new Mesh(new CylinderGeometry(r, r, 0.1, 32), kind === "led" ? kit.flash : kit.lens);
			disc.rotation.x = Math.PI / 2;
			disc.position.z = 0.05;
			return disc;
		}
		case "mic":
		default: {
			const hole = new Mesh(new CylinderGeometry(r, r, 0.06, 20), kit.hole);
			hole.rotation.x = Math.PI / 2;
			hole.position.z = 0.03;
			return hole;
		}
	}
}

/**
 * The camera module on a back group (x right and y up as seen from the back, origin at the
 * back's center, +z out of the back). `width`/`height` is the back's size.
 */
export function cameraModule(kit: MaterialKit, camera: IDeviceCamera, width: number, height: number): Group {
	const group = new Group();
	group.name = "camera";
	const at = (x: number, y: number) => ({ x: x - width / 2, y: height / 2 - y });
	const plateau = camera.plateau;
	let base = 0;
	if (plateau) {
		const material =
			plateau.material === "frame" ? kit.frame : plateau.material === "glass" ? kit.plateauGlass : plateau.material === "dark" ? kit.darkGlass : kit.plateau;
		const raise = Math.max(0.1, plateau.raise);
		const bevel = Math.min(raise * 0.45, 0.7, plateau.radius * 0.5);
		const shape = shapeOf(outline(plateau.width - bevel * 2, plateau.height - bevel * 2, Math.max(0.2, plateau.radius - bevel), 0.5));
		const geometry = new ExtrudeGeometry(shape, { depth: Math.max(0.01, raise - bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 6, curveSegments: 16 });
		geometry.translate(0, 0, 0);
		const mesh = new Mesh(geometry, material);
		const c = at(plateau.x + plateau.width / 2, plateau.y + plateau.height / 2);
		mesh.position.set(c.x, c.y, -bevel + 0.001);
		group.add(mesh);
		base = raise;
	}
	const inside = (x: number, y: number) =>
		!!plateau && x >= plateau.x && x <= plateau.x + plateau.width && y >= plateau.y && y <= plateau.y + plateau.height;
	for (const lens of camera.lenses) {
		const mesh = lensMesh(kit, lens.diameter, lens.ring ?? 0.8, lens.raise ?? 0.6, lens.window ?? "round");
		const c = at(lens.x, lens.y);
		mesh.position.set(c.x, c.y, inside(lens.x, lens.y) ? base : 0);
		group.add(mesh);
	}
	for (const mark of camera.marks ?? []) {
		const mesh = markMesh(kit, mark.kind, mark.diameter);
		const c = at(mark.x, mark.y);
		mesh.position.set(c.x, c.y, inside(mark.x, mark.y) ? base : 0);
		group.add(mesh);
	}
	return group;
}

let appleShapes: Shape[] | undefined;

/** The mark on the back, facing +z, centered on the origin. */
export function logoMesh(kit: MaterialKit, logo: NonNullable<IDeviceModel["logo"]>): Object3D | undefined {
	if (logo.kind === "apple") {
		appleShapes ??= SVGLoader.createShapes(new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${APPLE_LOGO_PATH}"/></svg>`).paths[0]);
		const geometry = new ShapeGeometry(appleShapes, 12);
		geometry.computeBoundingBox();
		const box = geometry.boundingBox!;
		const scale = logo.size / Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
		geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, 0);
		geometry.scale(scale, -scale, 1);
		const mesh = new Mesh(geometry, kit.logo);
		mesh.position.z = 0.02;
		return mesh;
	}
	const text = logo.kind === "google" ? "G" : logo.kind === "samsung" ? "SAMSUNG" : logo.kind === "microsoft" ? "\u25A0" : (logo.text ?? "");
	if (!text) {
		return undefined;
	}
	// Text marks as a crisp decal.
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d")!;
	const font = logo.kind === "samsung" ? '700 96px "Helvetica Neue", Arial, sans-serif' : '500 160px "Google Sans", "Product Sans", "Helvetica Neue", sans-serif';
	ctx.font = font;
	const metrics = ctx.measureText(text);
	canvas.width = Math.ceil(metrics.width + 24);
	canvas.height = logo.kind === "samsung" ? 120 : 200;
	ctx.font = font;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = "#fff";
	if (logo.kind === "samsung") {
		ctx.letterSpacing = "6px";
	}
	ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	texture.anisotropy = 8;
	const material = kit.track(
		new MeshPhysicalMaterial({ color: kit.logo.color, alphaMap: texture, transparent: true, metalness: kit.logo.metalness, roughness: kit.logo.roughness, depthWrite: false }),
	);
	kit.ownTexture(texture);
	const aspect = canvas.width / canvas.height;
	const height = logo.kind === "samsung" ? logo.size / aspect : logo.size;
	const width = logo.kind === "samsung" ? logo.size : logo.size * aspect;
	const geometry = new ShapeGeometry(shapeOf(outline(width, height, 0)), 1);
	planarUv(geometry, -width / 2, -height / 2, width, height);
	const mesh = new Mesh(geometry, material);
	mesh.position.z = 0.02;
	return mesh;
}

/** Disposes every geometry under `root` (materials belong to the kit). */
export function disposeGeometries(root: Object3D): void {
	const seen = new Set<BufferGeometry>();
	root.traverse((object) => {
		if (object instanceof Mesh && !seen.has(object.geometry)) {
			seen.add(object.geometry);
			object.geometry.dispose();
		}
	});
}

/** Every mesh under `root` casts shadows, except see-through layers. */
export function castShadows(root: Object3D): void {
	root.traverse((object) => {
		if (object instanceof Mesh) {
			const material = object.material as Material;
			object.castShadow = !material.transparent && material.blending !== AdditiveBlending;
		}
	});
}
