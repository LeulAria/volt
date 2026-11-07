import rough from "roughjs";
import type { Drawable, Options } from "roughjs/bin/core";
import { cn } from "@/lib/cn";

/*
 * Chalk strokes for the agent flow drawing (agentFlow.tsx), as if it were drawn on a blackboard.
 * rough.js (MIT, Preet Shihn; the library Excalidraw draws with) goes over every outline twice
 * with a small wobble, the hand-drawn look of Volt's Scratch board. Each shape is seeded from its
 * own geometry, so the server and the browser draw the same wobble, and is worked out once.
 */

type Point = [number, number];

/** Parallel chalk strokes that shade a shape in, `gap` apart. */
export type Hatch = { gap: number; angle?: number };

type Shape = { outline: string; hatch?: string };

const generator = rough.generator();
const drawn = new Map<string, Shape>();

const STYLE: Options = {
  roughness: 0.9,
  bowing: 0.8,
  maxRandomnessOffset: 1.2,
  // line ends stay put, so strokes still meet the ports and corners they were drawn to
  preserveVertices: true,
};

/** FNV-1a of the shape's key, folded into rough.js's seed range (1 to 2^31 - 1). */
function seedFor(key: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  }
  return ((hash >>> 0) % 0x7ffffffe) + 1;
}

function chalk(
  key: string,
  hatch: Hatch | undefined,
  draw: (options: Options) => Drawable,
): Shape {
  const id = hatch ? `${key} hatch ${hatch.gap} ${hatch.angle ?? -41}` : key;
  const cached = drawn.get(id);
  if (cached) return cached;
  const drawable = draw({
    ...STYLE,
    seed: seedFor(key),
    ...(hatch && {
      fill: "currentColor",
      fillStyle: "hachure",
      fillWeight: 1,
      hachureGap: hatch.gap,
      hachureAngle: hatch.angle ?? -41,
    }),
  });
  const shape: Shape = { outline: "" };
  for (const set of drawable.sets) {
    const d = generator.opsToPath(set, 1);
    if (set.type === "path") shape.outline += d;
    else if (set.type === "fillSketch") shape.hatch = (shape.hatch ?? "") + d;
  }
  drawn.set(id, shape);
  return shape;
}

/** A rectangle with round corners as a path, the way `<rect rx>` draws it. */
function roundRect(x: number, y: number, w: number, h: number, rx: number) {
  const r = Math.max(0, Math.min(rx, w / 2, h / 2));
  // a quarter circle's control points sit this far from its corner
  const k = r * 0.4477;
  const right = x + w;
  const bottom = y + h;
  const side = (to: string, length: number) => (length > 0.01 ? to : "");
  return [
    `M${x + r} ${y}`,
    side(`H${right - r}`, w - 2 * r),
    r ? `C${right - k} ${y} ${right} ${y + k} ${right} ${y + r}` : "",
    side(`V${bottom - r}`, h - 2 * r),
    r
      ? `C${right} ${bottom - k} ${right - k} ${bottom} ${right - r} ${bottom}`
      : "",
    side(`H${x + r}`, w - 2 * r),
    r ? `C${x + k} ${bottom} ${x} ${bottom - k} ${x} ${bottom - r}` : "",
    side(`V${y + r}`, h - 2 * r),
    r ? `C${x} ${y + k} ${x + k} ${y} ${x + r} ${y}` : "",
    "Z",
  ].join("");
}

type Paint = {
  className?: string;
  hatch?: Hatch;
  hatchClassName?: string;
};

function Strokes({
  shape,
  className,
  hatchClassName,
}: {
  shape: Shape;
  className?: string;
  hatchClassName?: string;
}) {
  return (
    <>
      {shape.hatch ? (
        <path className={cn("chalk-hatch", hatchClassName)} d={shape.hatch} />
      ) : null}
      <path className={cn("chalk", className)} d={shape.outline} />
    </>
  );
}

export function ChalkRect({
  x = 0,
  y = 0,
  width,
  height,
  rx = 0,
  hatch,
  ...paint
}: Paint & {
  x?: number;
  y?: number;
  width: number;
  height: number;
  rx?: number;
}) {
  const shape = chalk(`rect ${x} ${y} ${width} ${height} ${rx}`, hatch, (o) =>
    generator.path(roundRect(x, y, width, height, rx), o),
  );
  return <Strokes shape={shape} {...paint} />;
}

export function ChalkLine({
  x1,
  y1,
  x2,
  y2,
  className,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  className?: string;
}) {
  const shape = chalk(`line ${x1} ${y1} ${x2} ${y2}`, undefined, (o) =>
    generator.line(x1, y1, x2, y2, o),
  );
  return <Strokes shape={shape} className={className} />;
}

export function ChalkCircle({
  cx,
  cy,
  r,
  hatch,
  ...paint
}: Paint & { cx: number; cy: number; r: number }) {
  const shape = chalk(`circle ${cx} ${cy} ${r}`, hatch, (o) =>
    generator.circle(cx, cy, r * 2, o),
  );
  return <Strokes shape={shape} {...paint} />;
}

/** Any path made of M, L, H, V, C and Q commands (rough.js reads the rest too). */
export function ChalkPath({ d, hatch, ...paint }: Paint & { d: string }) {
  const shape = chalk(`path ${d}`, hatch, (o) => generator.path(d, o));
  return <Strokes shape={shape} {...paint} />;
}

export function ChalkPolygon({
  points,
  hatch,
  ...paint
}: Paint & { points: Point[] }) {
  const shape = chalk(`polygon ${points.join(" ")}`, hatch, (o) =>
    generator.polygon(points, o),
  );
  return <Strokes shape={shape} {...paint} />;
}
