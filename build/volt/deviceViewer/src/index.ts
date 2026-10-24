/**
 * Volt's entry into the device viewer bundle: T3 Code's serve-sim stream client and its iPhone
 * Duo viewer (MIT, see LICENSE.txt), plus a DOM port of T3's React `DeviceDuoViewport`.
 */
import { createDuoPinch, duoFoldState, duoHoldOrientation } from "./duoControl.ts";
import type { DuoCommand, DuoControlState } from "./duoControl.ts";
import { createDuoViewer } from "./duoViewer.ts";
import { createCanvasFrameSink } from "./frame.ts";
import { provideDeviceModel } from "./modelScene.ts";
import { createPhoneInteraction } from "./phoneInteraction.ts";
import { bindPhoneTrackpad } from "./phoneTrackpad.ts";
import type { DeviceScreenSize, DeviceStreamClient } from "./stream.ts";

export { createDeviceStreamClient } from "./stream.ts";
export type { DeviceHubAccess } from "./hubAccess.ts";
export type {
  DeviceScreenSize,
  DeviceStreamClient,
  DeviceStreamEvents,
  DeviceStreamStatus,
} from "./stream.ts";
export { createCanvasFrameSink, duoFoldState, duoHoldOrientation };
export type { DuoCommand, DuoControlState };

/** Key for the model bytes the workbench provides; never fetched. */
const DUO_MODEL_URL = "volt-device-model:iphone-duo";

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
