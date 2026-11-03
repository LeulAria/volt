/**
 * The display cover Apple's DeviceKit uses while a display changes geometry
 * (SnapshotBlurContainerView: blurWithSnapshot → blurOnly → lift). While the hinge
 * moves or the native display hands off, each panel shows a blurred snapshot of its
 * last frame instead of the simulator's blank and fading frames. Once the fold has
 * settled and live frames are back to full brightness the blur moves onto the live
 * content, then lifts. Only the region a cover names blurs (the folding half of the
 * inner display); the rest of the panel stays sharp.
 */

/** Blur radius at full strength, as a share of the panel width. */
const PEAK_RADIUS = 0.026;
const RISE_MS = 140;
const LIFT_MS = 460;
/** Settled time before the snapshot gives way to live frames. */
const HOLD_MS = 120;
/** iOS fades a relaid-out display up from black; past this, live frames are used anyway. */
const SWAP_TIMEOUT_MS = 900;
/** Live frames this much dimmer than the snapshot are still fading in. */
const LIVE_LUMA = 0.82;

export interface DuoFoldBlurPanel {
  /** The texture source the 3D panel samples. */
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  /** The latest sharp frame, drawn by the viewer. */
  readonly frame: HTMLCanvasElement;
  readonly presented: () => void;
}

/** The blurred span of a panel, as shares of its width; null keeps the panel sharp. */
export type DuoFoldBlurRegion = readonly [from: number, to: number] | null;

export interface DuoFoldBlur {
  /** Covers every panel with its snapshot and blurs each panel's region. */
  readonly cover: (regions: readonly DuoFoldBlurRegion[]) => void;
  readonly frameArrived: () => void;
  /** Shows a panel's new frame now, unless a cover owns the panel. */
  readonly present: (panel: DuoFoldBlurPanel) => void;
  /** Steps the cover; returns whether it needs another animation frame. */
  readonly advance: (now: number, blocked: boolean) => boolean;
}

type FoldBlurPhase = "idle" | "snapshot" | "live";

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function createDuoFoldBlur(panels: readonly DuoFoldBlurPanel[], enabled: boolean): DuoFoldBlur {
  const snapshots = panels.map((panel) => {
    const canvas = document.createElement("canvas");
    canvas.width = panel.canvas.width;
    canvas.height = panel.canvas.height;
    return { canvas, context: canvas.getContext("2d", { alpha: false })!, luma: 0 };
  });
  const scratch = document.createElement("canvas");
  scratch.width = Math.max(...panels.map((panel) => panel.canvas.width));
  scratch.height = Math.max(...panels.map((panel) => panel.canvas.height));
  const scratchContext = scratch.getContext("2d")!;
  const probe = document.createElement("canvas");
  probe.width = probe.height = 8;
  const probeContext = probe.getContext("2d", { willReadFrequently: true })!;
  const luma = (source: HTMLCanvasElement) => {
    probeContext.drawImage(source, 0, 0, 8, 8);
    const data = probeContext.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let index = 0; index < data.length; index += 4)
      sum += 0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!;
    return sum / 64;
  };

  let regions: readonly DuoFoldBlurRegion[] = panels.map(() => null);
  let phase = "idle" as FoldBlurPhase;
  let level = 0;
  let last = 0;
  let unblockedAt = 0;
  let fresh = false;
  let liveDirty = false;
  let drawn: { level: number; phase: FoldBlurPhase } = { level: -1, phase: "idle" };

  const compose = (panel: DuoFoldBlurPanel, index: number) => {
    const { canvas, context } = panel;
    const source = phase === "snapshot" ? snapshots[index]!.canvas : panel.frame;
    const strength = easeInOut(level);
    const radius = PEAK_RADIUS * canvas.width * strength;
    const region = regions[index] ?? null;
    if (radius < 0.5 || !region) {
      context.drawImage(source, 0, 0);
    } else {
      // Blurring a downscaled copy is far cheaper and indistinguishable at these radii.
      const scale = Math.min(4, Math.max(1, radius / 3));
      const width = Math.ceil(canvas.width / scale);
      const height = Math.ceil(canvas.height / scale);
      // Overscan so the blur does not pull transparent edges in.
      const margin = (radius / scale) * 2;
      scratchContext.clearRect(0, 0, width, height);
      scratchContext.filter = `blur(${radius / scale}px) saturate(${1 + 0.25 * strength}) brightness(${1 - 0.06 * strength})`;
      scratchContext.drawImage(source, -margin, -margin, width + margin * 2, height + margin * 2);
      scratchContext.filter = "none";
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      const [from, to] = region;
      if (from > 0 || to < 1) context.drawImage(source, 0, 0);
      context.drawImage(
        scratch,
        from * width,
        0,
        (to - from) * width,
        height,
        from * canvas.width,
        0,
        (to - from) * canvas.width,
        canvas.height,
      );
    }
    panel.presented();
  };

  return {
    cover(next) {
      if (!enabled) return;
      regions = next;
      drawn = { level: -1, phase: "idle" };
      if (phase === "idle") {
        panels.forEach((panel, index) => {
          const snapshot = snapshots[index]!;
          snapshot.context.drawImage(panel.frame, 0, 0);
          snapshot.luma = luma(snapshot.canvas);
        });
        phase = "snapshot";
        level = 0;
        last = performance.now();
      }
      unblockedAt = 0;
    },
    frameArrived() {
      fresh = liveDirty = true;
    },
    present(panel) {
      // Under a cover, the next advance composes the new frame.
      if (phase === "idle") compose(panel, panels.indexOf(panel));
    },
    advance(now, blocked) {
      if (phase === "idle") return false;
      const elapsed = Math.min(100, Math.max(0, now - last));
      last = now;
      if (blocked) {
        unblockedAt = 0;
        level = Math.min(1, level + elapsed / RISE_MS);
      } else {
        unblockedAt ||= now;
        if (phase === "snapshot") {
          const waited = now - unblockedAt;
          if (waited >= HOLD_MS && (fresh || waited >= SWAP_TIMEOUT_MS)) {
            fresh = false;
            // Hold the snapshot while the relaid-out display is still fading up from black.
            const lit = panels.every(
              (panel, index) => luma(panel.frame) >= snapshots[index]!.luma * LIVE_LUMA,
            );
            if (lit || waited >= SWAP_TIMEOUT_MS) phase = "live";
          }
          level = Math.min(1, level + elapsed / RISE_MS);
        } else {
          level = Math.max(0, level - elapsed / LIFT_MS);
        }
      }
      if (phase === "live" && level === 0 && !blocked) phase = "idle";
      if (level !== drawn.level || phase !== drawn.phase || (phase !== "snapshot" && liveDirty)) {
        drawn = { level, phase };
        panels.forEach(compose);
      }
      liveDirty = false;
      // A fully risen cover over a blocked display waits for the next viewer event.
      return phase !== "idle" && !(blocked && level === 1);
    },
  };
}
