/**
 * Volt's entry into the device viewer bundle: T3 Code's serve-sim stream client and its iPhone
 * Duo viewer (MIT, see LICENSE.txt), plus a DOM port of T3's React `DeviceDuoViewport`.
 */
import { createDuoPinch, duoFoldState, duoHoldOrientation } from "./duoControl.ts";
import type { DuoCommand, DuoControlState } from "./duoControl.ts";
import { createDuoViewer } from "./duoViewer.ts";
import { createCanvasFrameSink } from "./frame.ts";
import { provideDeviceModel } from "./modelScene.ts";
import { resolveDeviceModelId } from "./model.ts";
import type { DeviceAccessorySource, DeviceModelId, DeviceModelSource } from "./model.ts";
import { createPhoneInteraction } from "./phoneInteraction.ts";
import { bindPhoneTrackpad } from "./phoneTrackpad.ts";
import { createPhoneViewer } from "./phoneViewer.ts";
import type { PhoneViewer } from "./phoneViewer.ts";
import { resolveDeviceShape } from "./shapeProfile.ts";
import type { DeviceShapeProfile } from "./shapeProfile.ts";
import type { DeviceScreenSize, DeviceStreamClient } from "./stream.ts";

export { createDeviceStreamClient } from "./stream.ts";
export type { DeviceHubAccess } from "./hubAccess.ts";
export type {
  DeviceScreenSize,
  DeviceStreamClient,
  DeviceStreamEvents,
  DeviceStreamStatus,
} from "./stream.ts";
export { createCanvasFrameSink, duoFoldState, duoHoldOrientation, resolveDeviceModelId };
export type { DuoCommand, DuoControlState, DeviceModelId };

/** Key for the model bytes the workbench provides; never fetched. */
const modelUrl = (id: DeviceAssetId) => `volt-device-model:${id}`;
const DUO_MODEL_URL = modelUrl("iphone-duo");

const KEYBOARD_ID = "ipad-pro-13-m5-magic-keyboard";
export type DeviceAssetId = DeviceModelId | typeof KEYBOARD_ID;

/**
 * The .glb files (by id, i.e. `~/.volt/device-models/<id>.glb`) the device's 3D view can use:
 * its model and, for the iPad Pro 13 (M5), the Magic Keyboard. Empty: the procedural body.
 * "iphone-duo" belongs to `mountDuoViewport`.
 */
export function deviceModelIdsFor(platform: "ios" | "android", name: string): DeviceAssetId[] {
  const id = resolveDeviceModelId(platform, name);
  if (!id) return [];
  return id === "ipad-pro-13-m5" ? [id, KEYBOARD_ID] : [id];
}

/** T3's hinge angle for an Android fold reading: the reported angle, else closed 0 / open 180. */
export function androidFoldAngle(fold: {
  readonly hingeAngle: number | null;
  readonly posture: string | null;
}): number {
  return fold.hingeAngle ?? (fold.posture === "closed" ? 0 : 180);
}

/** Width over height of the screen as shown, as T3's DeviceStreamView measures it. */
function screenAspect(
  platform: "ios" | "android",
  screen: DeviceScreenSize | null,
  source: HTMLCanvasElement,
): number {
  if (!screen) {
    // Screenshot-polled devices may have no screen report: the drawn image is the screen.
    if (source.width > 0 && source.height > 0) return source.width / source.height;
    return platform === "ios" ? 9 / 19.5 : 9 / 20;
  }
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  return landscape ? long / short : short / long;
}

export interface PhoneViewport {
  readonly setScreen: (screen: DeviceScreenSize | null) => void;
  /** Android foldables: the hinge angle (0 closed, 180 open), or null for a slab phone. */
  readonly setFoldAngle: (angle: number | null) => void;
  /** Attaches the Magic Keyboard; does nothing unless `hasKeyboard`. */
  readonly setKeyboardAttached: (attached: boolean) => void;
  /** The device has a keyboard accessory (iPad Pro 13 (M5) with both .glb files given). */
  readonly hasKeyboard: boolean;
  /** The source canvas drew a new frame (a stream frame or a polled screenshot). */
  readonly frame: () => void;
  readonly resetPose: () => void;
  readonly cancelInput: () => void;
  readonly dispose: () => void;
}

/**
 * The 3D phone or tablet over `host`, a DOM port of T3's `DevicePhoneViewport`: drag the screen
 * to touch it, drag outside it (or swipe two fingers) to turn it. iPhone 18 Pro / Pro Max and
 * iPad Pro 13 (M5) use their .glb model when its bytes are in `models`; every other device (or a
 * model that fails to load) gets T3's procedural body for its platform and size, and Android
 * foldables with a `foldAngle` get the folding body. `source` stays owned by the caller, which
 * must call `frame()` after each draw into it, whether a decoded stream frame or a screenshot.
 */
export function mountPhoneViewport(options: {
  host: HTMLElement;
  source: HTMLCanvasElement;
  platform: "ios" | "android";
  name: string;
  /** .glb bytes by model id (the workbench CSP blocks fetching blob: URLs). */
  models: Partial<Record<DeviceModelId, ArrayBuffer>>;
  /** ipad-pro-13-m5-magic-keyboard.glb. */
  keyboard?: ArrayBuffer;
  keyboardAttached?: boolean;
  /** Normalized 0..1 point in the displayed frame, as `DeviceStreamClient.sendTouch` takes. */
  touch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  screen: DeviceScreenSize | null;
  foldAngle: number | null;
  label: string;
  /** WebGL is unavailable or the context was lost: show the flat view. */
  onUnavailable: (cause?: unknown) => void;
}): PhoneViewport {
  const { host, source, platform, name } = options;
  const win = host.ownerDocument.defaultView ?? window;
  const doc = host.ownerDocument;
  const id = resolveDeviceModelId(platform, name);
  const modelId = id && id !== "iphone-duo" ? id : null;
  const modelData = modelId ? options.models[modelId] : undefined;
  let model: DeviceModelSource | null = null;
  if (modelId && modelData) {
    provideDeviceModel(modelUrl(modelId), modelData);
    model = { id: modelId, url: modelUrl(modelId) };
  }
  let keyboard: DeviceAccessorySource | null = null;
  if (model?.id === "ipad-pro-13-m5" && options.keyboard) {
    provideDeviceModel(modelUrl(KEYBOARD_ID), options.keyboard);
    keyboard = { id: KEYBOARD_ID, modelId: "ipad-pro-13-m5", url: modelUrl(KEYBOARD_ID) };
  }
  let screen = options.screen;
  let keyboardAttached = !!options.keyboardAttached;
  const shape = (): DeviceShapeProfile => {
    const aspect = screenAspect(platform, screen, source);
    return resolveDeviceShape({ platform, name, portraitAspect: Math.min(aspect, 1 / aspect) });
  };
  let profile = shape();
  const canvas = doc.createElement("canvas");
  canvas.className = "volt-phone-canvas";
  canvas.setAttribute("aria-label", options.label);
  host.appendChild(canvas);
  let viewer: PhoneViewer;
  try {
    viewer = createPhoneViewer({
      canvas,
      source,
      onUnavailable: () => options.onUnavailable(),
      // Like T3: a model that fails to load leaves the procedural body in place.
      onModelError: (cause) => console.warn("Device 3D asset could not load", cause),
      profile,
      model,
      accessory: keyboardAttached ? keyboard : null,
      foldAngle: options.foldAngle,
    });
  } catch (cause) {
    // No WebGL: report it once the caller holds the handle.
    canvas.remove();
    queueMicrotask(() => options.onUnavailable(cause));
    const noop = () => {};
    return {
      setScreen: noop,
      setFoldAngle: noop,
      setKeyboardAttached: noop,
      hasKeyboard: false,
      frame: noop,
      resetPose: noop,
      cancelInput: noop,
      dispose: noop,
    };
  }
  viewer.setScreen(screen, profile);
  const frame = () => {
    // Without a screen report the profile follows the drawn image's size.
    if (!screen) {
      const next = shape();
      if (next !== profile) {
        profile = next;
        viewer.setScreen(null, profile);
      }
    }
    viewer.frameUpdated();
  };
  const interaction = createPhoneInteraction({
    screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
    touch: (phase, point) => options.touch(phase, point.x, point.y),
    orbit: viewer.orbit,
    zoomBy: () => {},
    onInteractionActive: viewer.setInteractionActive,
  });
  const trackpad = bindPhoneTrackpad(canvas, interaction);
  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (!interaction.begin(event.pointerId, point(event), event.altKey)) return;
    event.preventDefault();
    event.stopPropagation();
    canvas.setPointerCapture(event.pointerId);
    (canvas.closest('[role="application"]') as HTMLElement | null)?.focus();
  };
  const move = (event: PointerEvent) => interaction.move(event.pointerId, point(event));
  const up = (event: PointerEvent) => {
    interaction.move(event.pointerId, point(event));
    interaction.end(event.pointerId);
  };
  const cancel = (event: PointerEvent) => interaction.end(event.pointerId);
  // Raw updates arrive as the pointer moves, not once per frame: touches follow the finger closer.
  const moveEvent = "onpointerrawupdate" in win ? "pointerrawupdate" : "pointermove";
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener(moveEvent, move as EventListener);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("lostpointercapture", cancel);
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    viewer.resize(width, height, win.devicePixelRatio);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const cancelInput = () => {
    interaction.end();
    trackpad.cancel();
  };
  win.addEventListener("blur", cancelInput);
  resize();
  frame();
  let disposed = false;
  return {
    setScreen(next) {
      if (disposed) return;
      screen = next;
      profile = shape();
      interaction.end();
      viewer.setScreen(next, profile);
    },
    setFoldAngle(angle) {
      if (!disposed) viewer.setFoldAngle(angle);
    },
    setKeyboardAttached(attached) {
      if (disposed || !keyboard || attached === keyboardAttached) return;
      keyboardAttached = attached;
      cancelInput();
      viewer.setAccessory(attached ? keyboard : null);
    },
    hasKeyboard: keyboard !== null,
    frame: () => {
      if (!disposed) frame();
    },
    resetPose: () => viewer.resetPose(),
    cancelInput,
    dispose() {
      if (disposed) return;
      disposed = true;
      trackpad.dispose();
      interaction.end();
      observer.disconnect();
      win.removeEventListener("blur", cancelInput);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener(moveEvent, move as EventListener);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", cancel);
      viewer.dispose();
      canvas.remove();
    },
  };
}

export interface DuoViewport {
  readonly setScreen: (screen: DeviceScreenSize | null) => void;
  /** The angle a pending hinge command asked for, shown before the device confirms it. */
  readonly setHingePreview: (angle: number | null) => void;
  /** The control queue failed: drop gestures and return to the confirmed view. */
  readonly controlFailed: () => void;
  /** The flat feed's canvas drew a new frame. */
  readonly frame: () => void;
  readonly resetPose: () => void;
  readonly cancelInput: () => void;
  readonly dispose: () => void;
}

/**
 * The 3D iPhone Duo over `host`: both displays live on the model, drag the screen to touch it,
 * drag outside it (or swipe two fingers) to turn it, pinch over it to open or close the hinge.
 * `decoded` is the flat feed's canvas; the client stays owned by the caller.
 */
export function mountDuoViewport(options: {
  host: HTMLElement;
  decoded: HTMLCanvasElement;
  client: DeviceStreamClient;
  /** The .glb file's bytes (the workbench CSP blocks fetching blob: URLs). */
  modelData: ArrayBuffer;
  screen: DeviceScreenSize | null;
  label: string;
  onUnavailable: (cause?: unknown) => void;
}): DuoViewport {
  const { host, decoded, client } = options;
  provideDeviceModel(DUO_MODEL_URL, options.modelData);
  const win = host.ownerDocument.defaultView ?? window;
  const doc = host.ownerDocument;
  const canvas = doc.createElement("canvas");
  canvas.className = "volt-duo-canvas";
  canvas.setAttribute("aria-label", options.label);
  host.appendChild(canvas);
  let screen = options.screen;
  let preview: number | null = null;
  const sources = { 1: doc.createElement("canvas"), 3: doc.createElement("canvas") };
  const viewer = createDuoViewer({
    canvas,
    sources,
    model: { id: "iphone-duo", url: DUO_MODEL_URL },
    onUnavailable: () => options.onUnavailable(),
    onModelError: (cause) => options.onUnavailable(cause),
    onPanelRequested: (panel) =>
      client.controlDuo({ control: "physical", value: panel === 1 ? "facedown" : "faceup" }),
    onOrientationRequested: (value) => client.controlDuo({ control: "orientation", value }),
  });
  viewer.setScreen(screen);
  const frame = () => {
    const panel = screen?.screenId;
    if (panel === 1 || panel === 3) viewer.frameUpdated(panel, decoded);
  };
  frame();
  client.setDuoPanels({
    onScreen(next) {
      screen = next;
      interaction.end();
      viewer.setScreen(next);
    },
    cover: createCanvasFrameSink(sources[1], () => viewer.frameUpdated(1)),
    inner: createCanvasFrameSink(sources[3], () => viewer.frameUpdated(3)),
  });
  const interaction = createPhoneInteraction({
    screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
    touch: (phase, point) => client.sendRawTouch(phase, point.x, point.y),
    orbit: viewer.orbit,
    zoomBy: () => {},
    onInteractionActive: viewer.setInteractionActive,
  });
  const pinch = createDuoPinch({
    angle: () => preview ?? screen?.hingeAngle ?? (screen?.screenId === 1 ? 0 : 180),
    contains: (x, y) => !!screen && viewer.beginHinge(x, y),
    change: (angle) => {
      viewer.setHingePreview(angle ?? preview, true);
      if (angle !== null) client.controlDuo({ control: "angle", value: angle });
    },
  });
  const trackpad = bindPhoneTrackpad(canvas, interaction, {
    begin(x, y) {
      interaction.end();
      return pinch.begin(x, y);
    },
    move: pinch.move,
    end: pinch.end,
  });
  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (!interaction.begin(event.pointerId, point(event), event.altKey)) return;
    event.preventDefault();
    event.stopPropagation();
    canvas.setPointerCapture(event.pointerId);
    (canvas.closest('[role="application"]') as HTMLElement | null)?.focus();
  };
  const move = (event: PointerEvent) => interaction.move(event.pointerId, point(event));
  const up = (event: PointerEvent) => {
    interaction.move(event.pointerId, point(event));
    interaction.end(event.pointerId);
  };
  const cancel = (event: PointerEvent) => interaction.end(event.pointerId);
  // Raw updates arrive as the pointer moves, not once per frame: touches follow the finger closer.
  const moveEvent = "onpointerrawupdate" in win ? "pointerrawupdate" : "pointermove";
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener(moveEvent, move as EventListener);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("lostpointercapture", cancel);
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    viewer.resize(width, height, win.devicePixelRatio);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const cancelInput = () => {
    interaction.end();
    trackpad.cancel();
    viewer.cancelInput();
  };
  win.addEventListener("blur", cancelInput);
  resize();
  let disposed = false;
  return {
    setScreen(next) {
      screen = next;
      interaction.end();
      viewer.setScreen(next);
    },
    setHingePreview(angle) {
      preview = angle;
      if (!pinch.active) viewer.setHingePreview(angle);
    },
    controlFailed() {
      trackpad.cancel();
      viewer.rejectOrientation();
    },
    frame,
    resetPose: () => viewer.resetPose(),
    cancelInput,
    dispose() {
      if (disposed) return;
      disposed = true;
      trackpad.dispose();
      interaction.end();
      client.setDuoPanels(null);
      observer.disconnect();
      win.removeEventListener("blur", cancelInput);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener(moveEvent, move as EventListener);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", cancel);
      viewer.dispose();
      canvas.remove();
    },
  };
}
