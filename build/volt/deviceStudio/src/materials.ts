/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Studio lighting and the materials devices are made of. Everything is physically based and lit
 * by one environment: a dark room with soft boxes, so metal and glass show the long, soft highlights
 * of a product photo.
 */
import {
	AdditiveBlending,
	BackSide,
	BoxGeometry,
	CanvasTexture,
	Color,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	PlaneGeometry,
	PMREMGenerator,
	RepeatWrapping,
	Scene,
	SRGBColorSpace,
	type Material,
	type Texture,
	type WebGLRenderer,
} from "three";
import type { IDeviceFinish } from "../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";

/**
 * The environment map: a soft gray studio with a large soft box overhead, tall strips left and
 * right, a broad fill in front and a bright floor bounce, the way product shots are lit.
 */
export function createStudioEnvironment(renderer: WebGLRenderer): Texture {
	const scene = new Scene();
	const room = new Mesh(new BoxGeometry(10, 10, 10), new MeshBasicMaterial({ color: new Color(0.16, 0.16, 0.17), side: BackSide }));
	scene.add(room);
	const light = (intensity: number, width: number, height: number, x: number, y: number, z: number, rx: number, ry: number, tint = [1, 1, 1]) => {
		const mesh = new Mesh(
			new PlaneGeometry(width, height),
			new MeshBasicMaterial({ color: new Color(intensity * tint[0], intensity * tint[1], intensity * tint[2]), side: DoubleSide }),
		);
		mesh.position.set(x, y, z);
		mesh.rotation.set(rx, ry, 0);
		scene.add(mesh);
	};
	// Key: a wide soft box above, slightly in front.
	light(7, 7, 3.4, 0, 4.9, 1.4, Math.PI / 2, 0);
	// Tall strips on both sides: the long highlights along metal frames.
	light(5.5, 1.3, 7, -4.9, 0.4, 1.2, 0, Math.PI / 2);
	light(4.2, 1.1, 7, 4.9, 0.2, 0.4, 0, -Math.PI / 2);
	// A broad front fill so dark and colored finishes keep their color face on.
	light(2.2, 8, 3.2, 0, 0.4, 4.9, 0, 0);
	// Rim lights behind for the back.
	light(3.2, 6, 1.4, 0, 2.6, -4.9, 0, Math.PI);
	light(2.4, 1.2, 6, -3.2, 0, -4.9, 0, Math.PI);
	// A warm bounce from the floor.
	const floor = new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial({ color: new Color(0.42, 0.4, 0.38) }));
	floor.rotation.x = -Math.PI / 2;
	floor.position.y = -4.95;
	scene.add(floor);
	const pmrem = new PMREMGenerator(renderer);
	const target = pmrem.fromScene(scene, 0.03);
	pmrem.dispose();
	scene.traverse((object) => {
		if (object instanceof Mesh) {
			object.geometry.dispose();
			(object.material as Material).dispose();
		}
	});
	return target.texture;
}

function srgb(hex: string): Color {
	return new Color().setStyle(hex, SRGBColorSpace);
}

/** A fine grain normal map: the bead-blasted texture of anodized aluminum and frosted glass. */
let grainTexture: CanvasTexture | undefined;
function grain(): CanvasTexture {
	if (grainTexture) {
		return grainTexture;
	}
	const size = 256;
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const image = ctx.createImageData(size, size);
	// Deterministic noise, so every render looks the same.
	let seed = 1337;
	const random = () => {
		seed = (seed * 16807) % 2147483647;
		return seed / 2147483647;
	};
	for (let i = 0; i < size * size; i++) {
		const nx = 128 + (random() - 0.5) * 34;
		const ny = 128 + (random() - 0.5) * 34;
		image.data[i * 4] = nx;
		image.data[i * 4 + 1] = ny;
		image.data[i * 4 + 2] = 255;
		image.data[i * 4 + 3] = 255;
	}
	ctx.putImageData(image, 0, 0);
	grainTexture = new CanvasTexture(canvas);
	grainTexture.wrapS = grainTexture.wrapT = RepeatWrapping;
	// UVs on shells run in mm: one tile per ~12 mm.
	grainTexture.repeat.set(0.08, 0.08);
	return grainTexture;
}

/** The materials one device is built from, colored by its finish. Owned by the model; dispose with it. */
export class MaterialKit {
	private readonly owned: Material[] = [];

	/** The side frame: titanium, aluminum or polished steel in the finish's color. */
	readonly frame: MeshPhysicalMaterial;
	/** The back panel. */
	readonly back: MeshPhysicalMaterial;
	/** The camera plateau, when its color differs from the back. */
	readonly plateau: MeshPhysicalMaterial;
	/** The front glass around the display: black, glossy. */
	readonly frontGlass: MeshPhysicalMaterial;
	/** The black border under the glass around the lit display. */
	readonly bezel: MeshPhysicalMaterial;
	/** Lens glass: near-black with a faint purple-green coating. */
	readonly lens: MeshPhysicalMaterial;
	/** The dark inside of a lens barrel. */
	readonly lensInside: MeshStandardMaterial;
	/** Sapphire covers and polished rings. */
	readonly ring: MeshPhysicalMaterial;
	/** Flash diffuser. */
	readonly flash: MeshPhysicalMaterial;
	/** Black plastic: antenna lines, grilles, gaskets, hinge covers. */
	readonly plastic: MeshStandardMaterial;
	/** Holes and slots: plain dark. */
	readonly hole: MeshStandardMaterial;
	/** Keycaps (laptops). */
	readonly keys: MeshPhysicalMaterial;
	/** Logo on the back: polished on matte, or matte on glossy. */
	readonly logo: MeshPhysicalMaterial;
	/** Reflections of the cover glass over a lit display (adds light, never darkens). */
	readonly screenSheen: MeshPhysicalMaterial;
	/** Sapphire over a lens: clear, reflective. */
	readonly coverGlass: MeshPhysicalMaterial;
	/** A glossy glass camera plateau in the back's color. */
	readonly plateauGlass: MeshPhysicalMaterial;
	/** Dark glossy glass (camera visors, cover display surrounds). */
	readonly darkGlass: MeshPhysicalMaterial;
	private readonly textures: Texture[] = [];

	constructor(readonly finish: IDeviceFinish) {
		const frameColor = srgb(finish.frame);
		const backColor = srgb(finish.back);
		const frameKind = finish.frameMaterial ?? "aluminum";
		this.frame = this.track(
			new MeshPhysicalMaterial({
				color: frameColor,
				metalness: frameKind === "plastic" ? 0 : 1,
				roughness: frameKind === "polishedSteel" ? 0.12 : frameKind === "titanium" ? 0.34 : frameKind === "matteAluminum" ? 0.48 : frameKind === "plastic" ? 0.5 : 0.3,
				clearcoat: frameKind === "plastic" ? 0.2 : 0,
				normalMap: frameKind === "titanium" || frameKind === "matteAluminum" ? grain() : null,
				envMapIntensity: 1,
			}),
		);
		if (this.frame.normalMap) {
			this.frame.normalScale.set(0.08, 0.08);
		}
		this.back = this.track(this.backMaterial(backColor, finish.backMaterial ?? "matteGlass"));
		this.plateau = finish.camera ? this.track(this.backMaterial(srgb(finish.camera), finish.backMaterial ?? "matteGlass")) : this.back;
		this.frontGlass = this.track(
			new MeshPhysicalMaterial({ color: srgb("#050506"), metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, reflectivity: 0.6 }),
		);
		this.bezel = finish.bezel
			? this.track(new MeshPhysicalMaterial({ color: srgb(finish.bezel), metalness: 0, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03 }))
			: this.frontGlass;
		this.lens = this.track(
			new MeshPhysicalMaterial({
				color: srgb("#07080b"),
				metalness: 0,
				roughness: 0.02,
				clearcoat: 1,
				clearcoatRoughness: 0,
				iridescence: 1,
				iridescenceIOR: 1.6,
				iridescenceThicknessRange: [180, 420],
				envMapIntensity: 1.4,
			}),
		);
		this.lensInside = this.track(new MeshStandardMaterial({ color: srgb("#020203"), metalness: 0.2, roughness: 0.6 }));
		this.ring = this.track(new MeshPhysicalMaterial({ color: frameColor.clone().lerp(new Color(0.5, 0.5, 0.52), 0.25), metalness: 1, roughness: 0.16 }));
		this.flash = this.track(new MeshPhysicalMaterial({ color: srgb("#d9cfa8"), metalness: 0, roughness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05, transmission: 0 }));
		this.plastic = this.track(new MeshStandardMaterial({ color: frameColor.clone().multiplyScalar(0.55), metalness: 0, roughness: 0.6 }));
		this.hole = this.track(new MeshStandardMaterial({ color: srgb("#030303"), metalness: 0, roughness: 0.9 }));
		this.keys = this.track(new MeshPhysicalMaterial({ color: srgb(finish.keys ?? "#0d0d0e"), metalness: 0, roughness: 0.62, clearcoat: 0.1 }));
		const glossyBack = finish.backMaterial === "glossyGlass" || finish.backMaterial === "ceramic";
		this.logo = this.track(
			new MeshPhysicalMaterial({
				color: glossyBack ? backColor.clone().multiplyScalar(0.92) : backColor.clone().lerp(frameColor, 0.5),
				metalness: glossyBack ? 0 : 0.85,
				roughness: glossyBack ? 0.45 : 0.12,
				clearcoat: glossyBack ? 0 : 1,
			}),
		);
		this.screenSheen = this.track(
			new MeshPhysicalMaterial({
				color: 0x000000,
				metalness: 0,
				roughness: 0.03,
				clearcoat: 1,
				clearcoatRoughness: 0.02,
				transparent: true,
				blending: AdditiveBlending,
				depthWrite: false,
				envMapIntensity: 0.55,
			}),
		);
		this.coverGlass = this.track(
			new MeshPhysicalMaterial({
				color: 0x000000,
				metalness: 0,
				roughness: 0.02,
				clearcoat: 1,
				transparent: true,
				blending: AdditiveBlending,
				depthWrite: false,
				envMapIntensity: 1.2,
			}),
		);
		this.plateauGlass = this.track(new MeshPhysicalMaterial({ color: srgb(finish.camera ?? finish.back), metalness: 0, roughness: 0.07, clearcoat: 1, clearcoatRoughness: 0.03 }));
		this.darkGlass = this.track(new MeshPhysicalMaterial({ color: srgb("#0b0b0d"), metalness: 0, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 }));
	}

	/** A texture this kit owns (disposed with it). */
	ownTexture(texture: Texture): void {
		this.textures.push(texture);
	}

	private backMaterial(color: Color, kind: NonNullable<IDeviceFinish["backMaterial"]>): MeshPhysicalMaterial {
		switch (kind) {
			case "glossyGlass":
			case "ceramic":
				return new MeshPhysicalMaterial({ color, metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.04 });
			case "aluminum": {
				const material = new MeshPhysicalMaterial({ color, metalness: 1, roughness: 0.42, normalMap: grain() });
				material.normalScale.set(0.05, 0.05);
				return material;
			}
			case "leather":
				return new MeshPhysicalMaterial({ color, metalness: 0, roughness: 0.78, sheen: 0.4, sheenRoughness: 0.6, normalMap: grain() });
			case "fabric":
				return new MeshPhysicalMaterial({ color, metalness: 0, roughness: 0.95, sheen: 1, sheenRoughness: 0.8, sheenColor: color.clone().multiplyScalar(1.2) });
			case "matteGlass":
			default: {
				// Frosted glass: a soft diffuse layer under a lightly frosted clear coat.
				const material = new MeshPhysicalMaterial({ color, metalness: 0, roughness: 0.55, clearcoat: 0.55, clearcoatRoughness: 0.32, normalMap: grain() });
				material.normalScale.set(0.03, 0.03);
				return material;
			}
		}
	}

	/** A material this kit owns (disposed with it). */
	track<T extends Material>(material: T): T {
		this.owned.push(material);
		return material;
	}

	dispose(): void {
		for (const material of this.owned) {
			material.dispose();
		}
		this.owned.length = 0;
		for (const texture of this.textures) {
			texture.dispose();
		}
		this.textures.length = 0;
	}
}
