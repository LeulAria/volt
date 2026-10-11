/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * The device studio: a three.js scene behind the browser's page that draws a real device around
 * it. The page itself stays a live, interactive element: every frame it gets the CSS transform
 * that lays it exactly on the model's display, so turning the device turns the page with it. When
 * the page can't sit on the glass (turned away, half folded, mid-animation) it hides and the
 * display shows the last picture of it instead.
 */
import {
	Box3,
	DirectionalLight,
	Euler,
	Group,
	MathUtils,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	NeutralToneMapping,
	PerspectiveCamera,
	PlaneGeometry,
	Quaternion,
	Scene,
	ShadowMaterial,
	SRGBColorSpace,
	Vector3,
	VSMShadowMap,
	WebGLRenderer,
	type Texture,
} from "three";
import {
	postureScreen,
	screenViewport,
	type DevicePosture,
	type IDeviceCatalogEntry,
	type IDeviceScreen,
} from "../../../../src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/deviceModel.ts";
import { createStudioEnvironment, MaterialKit } from "./materials.ts";
import { buildModel } from "./models/index.ts";
import { displaySmoothing, pxPerMm } from "./models/parts.ts";
import type { BuiltModel, ModelScreen, ScreenId } from "./models/types.ts";
import { ScreenCanvas, type Snapshot } from "./screen.ts";
import { roundedRect, toSvgPath } from "./shapes.ts";

export interface DeviceStudioState {
	/** The page's viewport, CSS px: what the page lays out at. */
	readonly viewport: { readonly width: number; readonly height: number };
	/** Stage px per page px while the page faces the viewer square on. */
	readonly scale: number;
	/** The page faces the viewer square on, unscaled except by `scale`: overlays drawn over it line up. */
	readonly flat: boolean;
	/** The page is on the display (not hidden behind its picture). */
	readonly live: boolean;
	/** The page's box on the stage (exact when flat, its projected bounds otherwise). */
	readonly pageRect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
	readonly posture: DevicePosture;
	readonly landscape: boolean;
	/** The user turned the device away from its resting view. */
	readonly turned: boolean;
	readonly spinning: boolean;
}

export interface DeviceStudioHost {
	/** The stage: the studio's canvas goes in as its first child and fills it. */
	readonly stage: HTMLElement;
	/** The page element. The studio sizes and places it while a device is shown. */
	page(): HTMLElement | undefined;
	/** A picture of the page as it looks now, for the moments it can't be shown live. */
	capture(): Promise<Snapshot | undefined>;
	/** The page moved, resized or changed visibility. Called once per frame while animating. */
	onDidLayout(state: DeviceStudioState): void;
	/** Rendering failed (no WebGL, lost context); the caller falls back to flat frames. */
	onDidFail(error: unknown): void;
}

/** Where on the stage the device may go: a box `top` px from the top and `bottom` px from the bottom. */
export interface StudioArea {
	readonly width: number;
	readonly height: number;
	readonly top: number;
	readonly bottom: number;
	readonly side: number;
}

export type StudioView = "front" | "angle" | "side" | "back";

export interface ShowOptions {
	readonly finish?: string;
	readonly posture?: DevicePosture;
	readonly landscape?: boolean;
}

const FOV = 20;
const TURN_SPEED = 0.0072;
const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** The page shows on the display while it faces the viewer by more than this (cosine of ~80 degrees). */
const FACING_LIVE = 0.17;
const HINGE_FOR: Record<DevicePosture, "closed" | "half" | "open"> = { closed: "closed", half: "half", open: "open" };

interface Pose {
	readonly posture: DevicePosture;
	readonly landscape: boolean;
	readonly hinge: number | undefined;
	readonly rest: Quaternion;
	/** The model's center in this pose (root space). */
	readonly center: Vector3;
	/** The lowest point of the model (root space), where a floor goes. */
	readonly bottom: number;
	/** Box corners in pivot space at rest. */
	readonly corners: readonly Vector3[];
	/** The display the page lives on, if any. */
	readonly live: ScreenId | undefined;
	/** CSS px per mm of the display the scale is measured on. */
	readonly px: number;
	/** The live display's plane z at rest (pivot space). */
	readonly screenZ: number;
	readonly viewport: { width: number; height: number };
}

interface StudioScreen {
	readonly model: ModelScreen;
	readonly paint: ScreenCanvas;
	readonly material: MeshBasicMaterial;
}

interface Tween {
	readonly from: Pose;
	readonly to: Pose;
	readonly start: number;
	readonly duration: number;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class DeviceStudio {
	readonly canvas: HTMLCanvasElement;
	private readonly glare: HTMLElement;
	private readonly renderer: WebGLRenderer;
	private readonly scene = new Scene();
	private readonly camera = new PerspectiveCamera(FOV, 1, 1, 10000);
	private readonly environment: Texture;
	private readonly pivot = new Group();
	private readonly holder = new Group();
	private readonly key: DirectionalLight;
	private readonly backdrop: Mesh;
	private readonly floor: Mesh;

	private entry: IDeviceCatalogEntry | undefined;
	private finishId: string | undefined;
	private built: BuiltModel | undefined;
	private kit: MaterialKit | undefined;
	private screens = new Map<ScreenId, StudioScreen>();
	private pose: Pose | undefined;
	private tween: Tween | undefined;
	private hingeNow: number | undefined;
	private restNow = new Quaternion();
	private centerNow = new Vector3();

	private yaw = 0;
	private pitch = 0;
	private velocity = { yaw: 0, pitch: 0 };
	private orbitTween: { from: { yaw: number; pitch: number }; to: { yaw: number; pitch: number }; start: number; duration: number } | undefined;
	private spinning = false;
	private drag: { id: number; x: number; y: number; yaw: number; pitch: number; time: number } | undefined;
	private lastMove = 0;

	private area: StudioArea = { width: 1, height: 1, top: 0, bottom: 0, side: 0 };
	private fit: "fit" | number = "fit";
	private scaleNow = 1;
	private cameraZ = 1000;
	private size = { width: 0, height: 0, ratio: 1 };

	private colors = { top: "#ffffff", bottom: "#ffffff" };
	private snapshot: Snapshot | undefined;
	private snapshotAt = 0;
	private capturing: Promise<void> | undefined;
	private live = false;
	private pageKey = "";
	private lastState: DeviceStudioState | undefined;
	private frame: number | undefined;
	private lastFrameTime = 0;
	private disposed = false;
	private readonly reducedMotion: boolean;
	private readonly cleanup: (() => void)[] = [];

	constructor(private readonly host: DeviceStudioHost) {
		const doc = host.stage.ownerDocument;
		const win = doc.defaultView ?? window;
		this.reducedMotion = !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		this.canvas = doc.createElement("canvas");
		this.canvas.className = "volt-device-studio";
		host.stage.insertBefore(this.canvas, host.stage.firstChild);
		this.glare = doc.createElement("div");
		this.glare.className = "volt-device-glare";
		this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = NeutralToneMapping;
		this.renderer.toneMappingExposure = 1.05;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = VSMShadowMap;
		this.environment = createStudioEnvironment(this.renderer);
		this.scene.environment = this.environment;

		this.key = new DirectionalLight(0xffffff, 0.9);
		this.key.castShadow = true;
		this.key.shadow.mapSize.set(2048, 2048);
		this.key.shadow.radius = 16;
		this.key.shadow.blurSamples = 24;
		this.key.shadow.bias = -0.0004;
		this.scene.add(this.key, this.key.target);

		const shadowMaterial = new ShadowMaterial({ opacity: 0.3, transparent: true, depthWrite: false });
		this.backdrop = new Mesh(new PlaneGeometry(1, 1), shadowMaterial);
		this.backdrop.receiveShadow = true;
		this.scene.add(this.backdrop);
		this.floor = new Mesh(new PlaneGeometry(1, 1), shadowMaterial);
		this.floor.receiveShadow = true;
		this.floor.rotation.x = -Math.PI / 2;

		this.pivot.add(this.holder);
		this.scene.add(this.pivot);

		const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void) => {
			target.addEventListener(type, listener as EventListener);
			this.cleanup.push(() => target.removeEventListener(type, listener as EventListener));
		};
		on(this.canvas, "pointerdown", (e) => this.onPointerDown(e));
		on(this.canvas, "pointermove", (e) => this.onPointerMove(e));
		on(this.canvas, "pointerup", (e) => this.onPointerUp(e));
		on(this.canvas, "pointercancel", (e) => this.onPointerUp(e));
		on(this.canvas, "dblclick", () => this.setView("front"));
		const lost = (e: Event) => {
			e.preventDefault();
			host.onDidFail(new Error("WebGL context lost"));
		};
		this.canvas.addEventListener("webglcontextlost", lost);
		this.cleanup.push(() => this.canvas.removeEventListener("webglcontextlost", lost));
	}

	// #region Public API

	get state(): DeviceStudioState | undefined {
		return this.lastState;
	}

	get device(): IDeviceCatalogEntry | undefined {
		return this.entry;
	}

	get finish(): string | undefined {
		return this.finishId;
	}

	get posture(): DevicePosture {
		return this.pose?.posture ?? "open";
	}

	get landscape(): boolean {
		return this.pose?.landscape ?? false;
	}

	/** Shows `entry`, replacing any device. */
	show(entry: IDeviceCatalogEntry, options: ShowOptions = {}): void {
		const sameDevice = this.entry?.id === entry.id;
		this.entry = entry;
		this.finishId = entry.model.finishes.find((f) => f.id === options.finish)?.id ?? entry.model.finishes[0]?.id;
		const posture = options.posture ?? (sameDevice ? this.pose?.posture : undefined) ?? entry.posture ?? "open";
		const landscape = this.canTurn(entry) ? (options.landscape ?? false) : false;
		if (!sameDevice) {
			this.yaw = 0;
			this.pitch = 0;
			this.velocity = { yaw: 0, pitch: 0 };
			this.orbitTween = undefined;
			this.snapshot = undefined;
		}
		this.rebuild();
		this.tween = undefined;
		this.pose = this.computePose(posture, landscape);
		this.applyPose(this.pose);
		this.pageKey = "";
		this.layoutCamera();
		this.requestFrame();
	}

	setFinish(id: string): void {
		if (!this.entry || id === this.finishId || !this.entry.model.finishes.some((f) => f.id === id)) {
			return;
		}
		this.finishId = id;
		const pose = this.pose;
		this.rebuild();
		if (pose) {
			this.pose = this.computePose(pose.posture, pose.landscape);
			this.applyPose(this.pose);
		}
		this.requestFrame();
	}

	/** Folds, unfolds or opens the device, animating the hinge. */
	setPosture(posture: DevicePosture): void {
		if (!this.pose || !this.built?.hinge || posture === this.pose.posture) {
			return;
		}
		this.transition(this.computePose(posture, this.pose.landscape));
	}

	/** Turns the device a quarter (portrait ↔ landscape), animating it. */
	setLandscape(landscape: boolean): void {
		if (!this.pose || !this.entry || landscape === this.pose.landscape || !this.canTurn(this.entry)) {
			return;
		}
		this.transition(this.computePose(this.pose.posture, landscape));
	}

	/** Turns the view to a preset angle. */
	setView(view: StudioView): void {
		this.spinning = false;
		this.velocity = { yaw: 0, pitch: 0 };
		const target = view === "angle" ? { yaw: -0.52, pitch: 0.2 } : view === "side" ? { yaw: -Math.PI / 2, pitch: 0.06 } : view === "back" ? { yaw: Math.PI, pitch: 0 } : { yaw: 0, pitch: 0 };
		// Take the short way round from wherever the user left it.
		const turns = Math.round((this.yaw - target.yaw) / (2 * Math.PI));
		const to = { yaw: target.yaw + turns * 2 * Math.PI, pitch: target.pitch };
		if (view !== "front") {
			void this.refreshSnapshot();
		}
		this.orbitTween = { from: { yaw: this.yaw, pitch: this.pitch }, to, start: performance.now(), duration: this.reducedMotion ? 0 : 900 };
		this.requestFrame();
	}

	/** Turntable: the device turns slowly until stopped or dragged. */
	setSpin(on: boolean): void {
		if (on === this.spinning) {
			return;
		}
		this.spinning = on;
		this.orbitTween = undefined;
		if (on) {
			void this.refreshSnapshot();
		}
		this.requestFrame();
	}

	get isSpinning(): boolean {
		return this.spinning;
	}

	/** Sets where the device may go and how big it is ('fit' fills the area, up to 1:1). */
	layout(area: StudioArea, fit: "fit" | number): void {
		this.area = area;
		this.fit = fit;
		this.resize();
		this.layoutCamera();
		this.requestFrame();
	}

	/** The page's top and bottom colors: status bar and home bar take them. */
	setScreenColors(top: string | undefined, bottom: string | undefined): void {
		const next = { top: top || "#ffffff", bottom: bottom || top || "#ffffff" };
		if (next.top === this.colors.top && next.bottom === this.colors.bottom) {
			return;
		}
		this.colors = next;
		this.paintScreens();
		this.requestFrame();
	}

	/** Takes a new picture of the page for the display (call after the page changes). */
	async refreshSnapshot(): Promise<void> {
		if (this.capturing) {
			return this.capturing;
		}
		this.capturing = (async () => {
			try {
				const image = await this.host.capture();
				if (image && !this.disposed) {
					this.snapshot = image;
					this.snapshotAt = performance.now();
					this.paintScreens();
					this.requestFrame();
				}
			} catch {
				// Keep the old picture.
			} finally {
				this.capturing = undefined;
			}
		})();
		return this.capturing;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.frame !== undefined) {
			(this.canvas.ownerDocument.defaultView ?? window).cancelAnimationFrame(this.frame);
		}
		for (const fn of this.cleanup) {
			fn();
		}
		this.teardownModel();
		this.environment.dispose();
		(this.backdrop.material as ShadowMaterial).dispose();
		this.backdrop.geometry.dispose();
		this.floor.geometry.dispose();
		this.renderer.dispose();
		this.canvas.remove();
		this.glare.remove();
		const page = this.host.page();
		if (page) {
			for (const property of ["width", "height", "left", "top", "transform", "clip-path", "opacity", "pointer-events"]) {
				page.style.removeProperty(property);
			}
		}
	}

	// #endregion

	private canTurn(entry: IDeviceCatalogEntry): boolean {
		return entry.model.family !== "laptop" && entry.model.family !== "display";
	}

	// #region Model

	private rebuild(): void {
		const entry = this.entry;
		if (!entry) {
			return;
		}
		this.teardownModel();
		const finish = entry.model.finishes.find((f) => f.id === this.finishId) ?? entry.model.finishes[0] ?? { id: "default", label: "Default", frame: "#3a3a3c", back: "#2c2c2e" };
		this.kit = new MaterialKit(finish);
		this.built = buildModel(entry.model, this.kit);
		this.holder.add(this.built.root);
		for (const screen of this.built.screens) {
			const paint = new ScreenCanvas(screen.spec, screen.extras);
			const material = new MeshBasicMaterial({ map: paint.texture, toneMapped: false });
			for (const mesh of screen.meshes) {
				mesh.material = material;
				mesh.castShadow = false;
			}
			this.screens.set(screen.id, { model: screen, paint, material });
		}
		const ground = this.built.ground ?? "backdrop";
		this.backdrop.visible = ground === "backdrop";
		if (ground === "floor") {
			this.holder.add(this.floor);
		} else {
			this.floor.removeFromParent();
		}
		this.paintScreens();
	}

	private teardownModel(): void {
		if (this.built) {
			this.built.root.removeFromParent();
			this.built.dispose();
			this.built = undefined;
		}
		for (const screen of this.screens.values()) {
			screen.paint.dispose();
			screen.material.dispose();
		}
		this.screens.clear();
		this.kit?.dispose();
		this.kit = undefined;
	}

	/** The display a posture browses on. */
	private liveScreenFor(posture: DevicePosture): ModelScreen | undefined {
		if (!this.entry || !this.built) {
			return undefined;
		}
		const spec = postureScreen(this.entry.model, posture);
		const screen = this.built.screens.find((s) => s.spec === spec) ?? this.built.screens.find((s) => s.id === (posture === "closed" ? "cover" : "main"));
		if (!screen) {
			return undefined;
		}
		if (screen.bends && posture !== "open") {
			return undefined;
		}
		// A laptop's display is hidden when the lid is shut.
		if (this.entry.model.family === "laptop" && posture === "closed") {
			return undefined;
		}
		return screen;
	}

	private hingeAngle(posture: DevicePosture): number | undefined {
		const hinge = this.built?.hinge;
		return hinge ? hinge[HINGE_FOR[posture]] : undefined;
	}

	/** Measures a pose: sets the hinge, reads the display's orientation and the model's box, and puts the hinge back. */
	private computePose(posture: DevicePosture, landscape: boolean): Pose {
		const built = this.built!;
		const hinge = this.hingeAngle(posture);
		const saved = this.hingeNow;
		if (hinge !== undefined) {
			built.hinge!.set(hinge);
		}
		built.root.updateMatrixWorld(true);
		const rootInverse = built.root.matrixWorld.clone().invert();
		const live = this.liveScreenFor(posture);
		let rest = built.restView?.(posture)?.clone();
		if (!rest) {
			const reference = live ?? this.liveScreenFor("open") ?? built.screens[0];
			rest = new Quaternion();
			if (reference) {
				const relative = rootInverse.clone().multiply(reference.anchor.matrixWorld);
				relative.decompose(new Vector3(), rest, new Vector3());
				rest.invert();
			}
		}
		if (landscape) {
			// A quarter turn to the left: the top of the display goes to the viewer's left.
			rest.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
		}
		const box = new Box3();
		const meshBox = new Box3();
		const matrix = new Matrix4();
		built.root.traverse((object) => {
			if (object instanceof Mesh && object.visible) {
				object.geometry.computeBoundingBox();
				matrix.multiplyMatrices(rootInverse, object.matrixWorld);
				meshBox.copy(object.geometry.boundingBox!).applyMatrix4(matrix);
				box.union(meshBox);
			}
		});
		const center = box.getCenter(new Vector3());
		const corners: Vector3[] = [];
		for (const x of [box.min.x, box.max.x]) {
			for (const y of [box.min.y, box.max.y]) {
				for (const z of [box.min.z, box.max.z]) {
					corners.push(new Vector3(x, y, z).sub(center).applyQuaternion(rest));
				}
			}
		}
		const reference = live ?? this.liveScreenFor("open") ?? built.screens[0];
		let screenZ = Math.max(...corners.map((c) => c.z));
		if (live) {
			const anchor = new Vector3().setFromMatrixPosition(rootInverse.clone().multiply(live.anchor.matrixWorld));
			screenZ = anchor.sub(center).applyQuaternion(rest).z;
		}
		const spec = (live ?? reference)?.spec ?? this.entry!.model.screen;
		const portrait = screenViewport(spec);
		const viewport = landscape ? { width: portrait.height, height: portrait.width } : portrait;
		if (hinge !== undefined && saved !== undefined) {
			built.hinge!.set(saved);
		}
		return { posture, landscape, hinge, rest, center, bottom: box.min.y, corners, live: live?.id, px: pxPerMm(spec), screenZ, viewport };
	}

	private applyPose(pose: Pose): void {
		if (pose.hinge !== undefined) {
			this.built?.hinge?.set(pose.hinge);
		}
		this.hingeNow = pose.hinge;
		this.restNow.copy(pose.rest);
		this.centerNow.copy(pose.center);
		this.holder.position.copy(pose.center).negate();
		this.floor.position.set(pose.center.x, pose.bottom - 0.05, pose.center.z);
	}

	/** Animates from the current pose to `to`; the page hides until it lands. */
	private transition(to: Pose): void {
		const from = this.currentPose();
		void this.refreshSnapshot();
		this.tween = { from, to, start: performance.now(), duration: this.reducedMotion ? 0 : to.hinge !== from.hinge ? 1100 : 650 };
		this.pose = to;
		this.layoutCamera();
		this.requestFrame();
	}

	/** The pose as it is drawn right now (mid-animation too). */
	private currentPose(): Pose {
		const pose = this.pose!;
		return { ...pose, hinge: this.hingeNow, rest: this.restNow.clone(), center: this.centerNow.clone() };
	}

	// #endregion

	// #region Camera

	private resize(): void {
		const width = Math.max(1, Math.round(this.area.width));
		const height = Math.max(1, Math.round(this.area.height));
		const ratio = Math.min(2, (this.canvas.ownerDocument.defaultView ?? window).devicePixelRatio || 1);
		if (width === this.size.width && height === this.size.height && ratio === this.size.ratio) {
			return;
		}
		this.size = { width, height, ratio };
		this.renderer.setPixelRatio(ratio);
		this.renderer.setSize(width, height, false);
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		this.camera.aspect = width / height;
	}

	/** Focal length in stage px. */
	private focal(): number {
		return this.size.height / 2 / Math.tan(MathUtils.degToRad(FOV / 2));
	}

	/** Camera distance and scale for the target pose (fit uses its resting outline, perspective included). */
	private layoutCamera(): void {
		const pose = this.pose;
		if (!pose) {
			return;
		}
		const f = this.focal();
		const area = this.area;
		const halfWidth = Math.max(40, (area.width - area.side * 2) / 2) * 0.94;
		const halfHeight = Math.max(40, (area.height - area.top - area.bottom) / 2) * 0.94;
		let z = 0;
		for (const c of pose.corners) {
			z = Math.max(z, c.z + (Math.abs(c.x) * f) / halfWidth, c.z + (Math.abs(c.y) * f) / halfHeight);
		}
		const minZ = pose.screenZ + f / pose.px;
		const scale = this.fit === "fit" ? Math.min(1, f / ((z - pose.screenZ) * pose.px)) : this.fit;
		this.cameraZ = this.fit === "fit" ? Math.max(z, minZ) : pose.screenZ + f / (scale * pose.px);
		this.scaleNow = scale;
		this.updateProjection();
		// Shadows: the key light and the catchers follow the device's size.
		const radius = Math.max(...pose.corners.map((c) => c.length()));
		this.key.position.set(radius * 0.35, radius * 2.2, radius * 2.0);
		this.key.target.position.set(0, 0, 0);
		const cam = this.key.shadow.camera;
		cam.left = cam.bottom = -radius * 1.6;
		cam.right = cam.top = radius * 1.6;
		cam.near = 1;
		cam.far = radius * 6;
		cam.updateProjectionMatrix();
		this.backdrop.scale.setScalar(radius * 8);
		this.backdrop.position.set(0, 0, -radius - 6);
		this.floor.scale.setScalar(radius * 6);
	}

	private updateProjection(): void {
		const camera = this.camera;
		camera.near = Math.max(1, this.cameraZ * 0.05);
		camera.far = this.cameraZ * 20;
		camera.position.set(0, 0, this.cameraZ);
		camera.lookAt(0, 0, 0);
		camera.updateProjectionMatrix();
		// Shift the picture so the device centers on the free area, not the canvas.
		const centerX = this.area.width / 2;
		const centerY = this.area.top + (this.area.height - this.area.top - this.area.bottom) / 2;
		camera.projectionMatrix.elements[8] = 1 - (2 * centerX) / this.size.width;
		camera.projectionMatrix.elements[9] = (2 * centerY) / this.size.height - 1;
		camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
		camera.updateMatrixWorld(true);
	}

	// #endregion

	// #region Frame loop

	private requestFrame(): void {
		if (this.disposed || this.frame !== undefined) {
			return;
		}
		const win = this.canvas.ownerDocument.defaultView ?? window;
		this.frame = win.requestAnimationFrame((time) => {
			this.frame = undefined;
			this.renderFrame(time);
		});
	}

	private renderFrame(time: number): void {
		if (this.disposed || !this.pose || !this.built) {
			return;
		}
		const dt = this.lastFrameTime ? Math.min(0.05, (time - this.lastFrameTime) / 1000) : 1 / 60;
		this.lastFrameTime = time;
		let animating = false;

		// Pose (hinge, resting angle, center) tween.
		if (this.tween) {
			const { from, to, start, duration } = this.tween;
			const t = duration <= 0 ? 1 : Math.min(1, (performance.now() - start) / duration);
			const k = ease(t);
			if (to.hinge !== undefined) {
				const hinge = from.hinge === undefined ? to.hinge : from.hinge + (to.hinge - from.hinge) * k;
				this.built.hinge?.set(hinge);
				this.hingeNow = hinge;
			}
			this.restNow.slerpQuaternions(from.rest, to.rest, k);
			this.centerNow.lerpVectors(from.center, to.center, k);
			this.holder.position.copy(this.centerNow).negate();
			if (t >= 1) {
				this.tween = undefined;
				this.applyPose(to);
				this.pageKey = "";
			} else {
				animating = true;
			}
		}

		// Orbit: preset tween, spin, or inertia after a drag.
		if (this.orbitTween) {
			const { from, to, start, duration } = this.orbitTween;
			const t = duration <= 0 ? 1 : Math.min(1, (performance.now() - start) / duration);
			const k = ease(t);
			this.yaw = from.yaw + (to.yaw - from.yaw) * k;
			this.pitch = from.pitch + (to.pitch - from.pitch) * k;
			if (t >= 1) {
				this.orbitTween = undefined;
				if (Math.abs(to.yaw % (2 * Math.PI)) < 1e-6 && to.pitch === 0) {
					this.yaw = 0;
				}
			} else {
				animating = true;
			}
		} else if (this.spinning && !this.drag) {
			this.yaw += dt * 0.55;
			animating = true;
		} else if (!this.drag && (Math.abs(this.velocity.yaw) > 0.0004 || Math.abs(this.velocity.pitch) > 0.0004)) {
			this.yaw += this.velocity.yaw * dt * 60;
			this.pitch = MathUtils.clamp(this.pitch + this.velocity.pitch * dt * 60, -PITCH_LIMIT, PITCH_LIMIT);
			const friction = Math.pow(0.9, dt * 60);
			this.velocity.yaw *= friction;
			this.velocity.pitch *= friction;
			animating = true;
		}

		const orbit = new Quaternion().setFromEuler(new Euler(this.pitch, this.yaw, 0, "XYZ"));
		this.pivot.quaternion.copy(orbit).multiply(this.restNow);
		this.scene.updateMatrixWorld(true);

		this.placePage();
		this.renderer.render(this.scene, this.camera);

		// While the page is hidden on a visible display, keep its picture fresh.
		if (!this.live && !this.tween && performance.now() - this.snapshotAt > 1500) {
			void this.refreshSnapshot();
		}
		if (animating) {
			this.requestFrame();
		}
	}

	// #endregion

	// #region Page

	/** Lays the page on its display with one CSS matrix: stage ← clip ← camera ← world ← display ← page. */
	private placePage(): void {
		const page = this.host.page();
		const pose = this.pose!;
		const screen = pose.live ? this.screens.get(pose.live) : undefined;
		const viewport = pose.viewport;
		if (page && (page.style.width !== `${viewport.width}px` || page.style.height !== `${viewport.height}px`)) {
			page.style.width = `${viewport.width}px`;
			page.style.height = `${viewport.height}px`;
			page.style.left = "0px";
			page.style.top = "0px";
		}
		let live = !!screen && !this.tween;
		let transform = "";
		let rect = { left: 0, top: 0, width: 0, height: 0 };
		let flat = false;
		let scaleSeen = this.scaleNow;
		if (screen) {
			const spec = screen.model.spec;
			const pageToAnchor = pose.landscape
				? new Matrix4().set(0, -1, 0, spec.width, -1, 0, 0, -spec.safeTop, 0, 0, 1, 0, 0, 0, 0, 1)
				: new Matrix4().set(1, 0, 0, 0, 0, -1, 0, -spec.safeTop, 0, 0, 1, 0, 0, 0, 0, 1);
			const w = this.size.width;
			const h = this.size.height;
			const toStage = new Matrix4().set(w / 2, 0, 0, w / 2, 0, -h / 2, 0, h / 2, 0, 0, 1, 0, 0, 0, 0, 1);
			const m = toStage
				.multiply(this.camera.projectionMatrix)
				.multiply(this.camera.matrixWorldInverse)
				.multiply(screen.model.anchor.matrixWorld)
				.multiply(pageToAnchor);
			// Facing: the display's normal against the line to the camera.
			const anchorWorld = screen.model.anchor.matrixWorld;
			const normal = new Vector3(0, 0, 1).transformDirection(anchorWorld);
			const origin = new Vector3().setFromMatrixPosition(anchorWorld);
			const toCamera = this.camera.position.clone().sub(origin).normalize();
			const facing = normal.dot(toCamera);
			live = live && facing > FACING_LIVE;
			const e = m.elements;
			const affine = Math.abs(e[3]) < 1e-9 && Math.abs(e[7]) < 1e-9;
			const corners = [
				[0, 0],
				[viewport.width, 0],
				[0, viewport.height],
				[viewport.width, viewport.height],
			].map(([x, y]) => {
				const v = new Vector3(x, y, 0).applyMatrix4(m);
				return v;
			});
			const xs = corners.map((c) => c.x);
			const ys = corners.map((c) => c.y);
			rect = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
			const rotated = Math.abs(e[1]) > 1e-6 || Math.abs(e[4]) > 1e-6;
			if (affine && !rotated) {
				// Square on: a plain 2D scale on whole device pixels keeps the page's text crisp.
				const ratio = this.size.ratio;
				const scale = e[0] / e[15];
				const x = Math.round((e[12] / e[15]) * ratio) / ratio;
				const y = Math.round((e[13] / e[15]) * ratio) / ratio;
				transform = `translate(${x}px, ${y}px) scale(${scale})`;
				flat = true;
				scaleSeen = scale;
				rect = { left: x, top: y, width: viewport.width * scale, height: viewport.height * scale };
			} else {
				transform = `matrix3d(${Array.from(e, (n) => (Math.abs(n) < 1e-12 ? 0 : n)).join(",")})`;
			}
			this.updateGlare(transform, viewport, facing, live);
		} else {
			this.updateGlare("", viewport, 0, false);
		}
		if (page) {
			if (live) {
				page.style.transform = transform;
				page.style.removeProperty("opacity");
				page.style.removeProperty("pointer-events");
				this.clipPage(page, screen!.model.spec, pose.landscape);
			} else {
				page.style.opacity = "0";
				page.style.pointerEvents = "none";
				if (transform) {
					page.style.transform = transform;
				}
			}
		}
		if (live !== this.live) {
			this.live = live;
			this.paintScreens();
			if (!live) {
				void this.refreshSnapshot();
			}
		}
		const state: DeviceStudioState = {
			viewport,
			scale: scaleSeen,
			flat: live && flat && !this.drag && !this.tween,
			live,
			pageRect: rect,
			posture: pose.posture,
			landscape: pose.landscape,
			turned: Math.abs(this.yaw) > 1e-4 || Math.abs(this.pitch) > 1e-4,
			spinning: this.spinning,
		};
		const last = this.lastState;
		this.lastState = state;
		if (
			!last ||
			last.live !== state.live ||
			last.flat !== state.flat ||
			last.viewport.width !== viewport.width ||
			last.viewport.height !== viewport.height ||
			last.posture !== state.posture ||
			last.landscape !== state.landscape ||
			last.turned !== state.turned ||
			last.spinning !== state.spinning ||
			Math.abs(last.pageRect.left - rect.left) > 0.25 ||
			Math.abs(last.pageRect.top - rect.top) > 0.25 ||
			Math.abs(last.pageRect.width - rect.width) > 0.25
		) {
			this.host.onDidLayout(state);
		}
	}

	/** Rounds the page's corners where it meets the display's corners. */
	private clipPage(page: HTMLElement, spec: IDeviceScreen, landscape: boolean): void {
		const key = `${spec.width}x${spec.height}:${landscape}`;
		if (key === this.pageKey) {
			return;
		}
		this.pageKey = key;
		const radius = spec.cornerRadius;
		const needed = radius > Math.min(spec.safeTop, spec.safeBottom) + 0.5;
		if (!needed) {
			page.style.removeProperty("clip-path");
			return;
		}
		const commands = landscape
			? roundedRect(-spec.safeTop, 0, spec.height, spec.width, radius, displaySmoothing(spec))
			: roundedRect(0, -spec.safeTop, spec.width, spec.height, radius, displaySmoothing(spec));
		page.style.clipPath = `path('${toSvgPath(commands)}')`;
	}

	private updateGlare(transform: string, viewport: { width: number; height: number }, facing: number, live: boolean): void {
		const page = this.host.page();
		const turnedAway = 1 - Math.max(0, Math.min(1, facing));
		const strength = live ? Math.min(0.22, turnedAway * 0.5) : 0;
		if (strength < 0.01 || !page) {
			this.glare.style.display = "none";
			return;
		}
		if (this.glare.previousElementSibling !== page) {
			page.after(this.glare);
		}
		const angle = 115 + this.yaw * 40 + this.pitch * 30;
		this.glare.style.display = "";
		this.glare.style.width = `${viewport.width}px`;
		this.glare.style.height = `${viewport.height}px`;
		this.glare.style.transform = transform;
		this.glare.style.clipPath = page.style.clipPath;
		this.glare.style.background = `linear-gradient(${angle.toFixed(1)}deg, rgba(255,255,255,0) 20%, rgba(255,255,255,${strength.toFixed(3)}) 48%, rgba(255,255,255,${(strength * 0.25).toFixed(3)}) 62%, rgba(255,255,255,0) 80%)`;
	}

	/** Redraws every display's texture. */
	private paintScreens(): void {
		const pose = this.pose;
		for (const [id, screen] of this.screens) {
			const isLive = pose?.live === id;
			const landscape = !!pose?.landscape && (isLive || !pose?.live);
			const resolution = Math.min(3, Math.max(1, this.scaleNow * this.size.ratio * 1.25));
			screen.paint.draw({
				top: this.colors.top,
				bottom: this.colors.bottom,
				// The picture belongs to the display the page was on; the other display shows its own colors.
				snapshot: isLive || (!pose?.live && id === "main") || this.tween ? this.snapshot : undefined,
				landscape,
				resolution,
				off: this.entry?.model.family === "laptop" && pose?.posture === "closed",
			});
		}
	}

	// #endregion

	// #region Pointer

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		this.canvas.setPointerCapture(event.pointerId);
		this.canvas.classList.add("dragging");
		this.spinning = false;
		this.orbitTween = undefined;
		this.velocity = { yaw: 0, pitch: 0 };
		this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch, time: performance.now() };
		void this.refreshSnapshot();
	}

	private onPointerMove(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || drag.id !== event.pointerId) {
			return;
		}
		const yaw = drag.yaw + (event.clientX - drag.x) * TURN_SPEED;
		const pitch = MathUtils.clamp(drag.pitch + (event.clientY - drag.y) * TURN_SPEED, -PITCH_LIMIT, PITCH_LIMIT);
		const now = performance.now();
		const dt = Math.max(1, now - drag.time) / (1000 / 60);
		this.velocity = { yaw: (yaw - this.yaw) / dt, pitch: (pitch - this.pitch) / dt };
		drag.time = now;
		this.lastMove = now;
		this.yaw = yaw;
		this.pitch = pitch;
		this.requestFrame();
	}

	private onPointerUp(event: PointerEvent): void {
		if (!this.drag || this.drag.id !== event.pointerId) {
			return;
		}
		this.drag = undefined;
		this.canvas.classList.remove("dragging");
		// A pointer that rested before letting go throws nothing.
		if (performance.now() - this.lastMove > 70) {
			this.velocity = { yaw: 0, pitch: 0 };
		}
		this.requestFrame();
	}

	// #endregion
}

export function createDeviceStudio(host: DeviceStudioHost): DeviceStudio {
	return new DeviceStudio(host);
}
