import { memo } from "react";

const W = 1600;
const H = 1000;

/** Deterministic PRNG so the scene renders identically on server and client. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => Math.round(n * 10) / 10;

/** A mountain ridge: layered sines plus jitter, closed to the bottom edge. */
function ridge(seed: number, base: number, amp: number, jag: number) {
  const r = rng(seed);
  const phase = r() * 10;
  let d = `M0 ${H}`;
  for (let x = 0; x <= W; x += 16) {
    const y =
      base -
      amp *
        (0.55 * Math.sin(x / 260 + phase) +
          0.3 * Math.sin(x / 110 + phase * 2) +
          0.15 * Math.sin(x / 47)) -
      r() * jag;
    d += ` L${x} ${f(y)}`;
  }
  return `${d} L${W} ${H} Z`;
}

/** A pine silhouette standing at (x, base) with height h. */
function pine(x: number, base: number, h: number, lean: number) {
  const tiers = 6;
  const trunk = h * 0.07;
  const body = h - trunk;
  const right: string[] = [`${f(x + h * 0.018)} ${f(base)}`];
  const left: string[] = [`${f(x - h * 0.018)} ${f(base)}`];
  for (let i = 0; i < tiers; i++) {
    const k = i / tiers;
    const y0 = base - trunk - body * k;
    const w = h * 0.22 * (1 - k * 0.82);
    const y1 = y0 - (body / tiers) * 0.6;
    const drift = lean * k * h * 0.05;
    right.push(
      `${f(x + w + drift)} ${f(y0)}`,
      `${f(x + w * 0.3 + drift)} ${f(y1)}`,
    );
    left.push(
      `${f(x - w + drift)} ${f(y0)}`,
      `${f(x - w * 0.3 + drift)} ${f(y1)}`,
    );
  }
  const tip = `${f(x + lean * h * 0.05)} ${f(base - h)}`;
  return `M${right.join(" L")} L${tip} L${left.reverse().join(" L")} Z`;
}

function forest(
  seed: number,
  count: number,
  baseY: (x: number) => number,
  hMin: number,
  hSpan: number,
) {
  const r = rng(seed);
  const trees: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = r() * (W + 80) - 40;
    trees.push(pine(x, baseY(x) + 6, hMin + r() * hSpan, r() - 0.5));
  }
  return trees.join(" ");
}

function clouds(seed: number, count: number, yMin: number, ySpan: number) {
  const r = rng(seed);
  return Array.from({ length: count }, () => {
    const x = r() * W;
    const y = yMin + r() * ySpan;
    const w = 120 + r() * 380;
    const h = 6 + r() * 16;
    // lens-shaped wisp, heavier on the underside like a lit stratus band
    return `M${f(x - w / 2)} ${f(y)} Q${f(x - w / 6)} ${f(y - h)} ${f(x + w / 2)} ${f(y - h * 0.2)} Q${f(x)} ${f(y + h * 0.9)} ${f(x - w / 2)} ${f(y)} Z`;
  }).join(" ");
}

function stars(seed: number, count: number) {
  const r = rng(seed);
  return Array.from({ length: count }, () => ({
    x: f(r() * W),
    y: f(r() * 260),
    r: f(0.6 + r() * 1.1),
    o: f(0.25 + r() * 0.6),
  }));
}

const hills = (x: number) =>
  860 - 40 * Math.sin(x / 300 + 1.3) - 18 * Math.sin(x / 90);
const shore = (x: number) => 950 - 26 * Math.sin(x / 240 + 0.4);

const SCENE = {
  far: ridge(4, 640, 90, 10),
  mid: ridge(9, 720, 70, 14),
  near: ridge(21, 820, 40, 6),
  cloudsHigh: clouds(3, 18, 60, 220),
  cloudsLow: clouds(8, 14, 330, 180),
  forestBack: forest(17, 70, hills, 70, 90),
  forestFront: forest(31, 26, shore, 160, 220),
  stars: stars(5, 60),
};

/** Stylised dusk landscape (sky, clouds, ridges, pines) — a nod to the app's wallpaper. */
export const SunsetScene = memo(function SunsetScene({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <linearGradient id="ss-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b0f2e" />
          <stop offset="0.28" stopColor="#4a1638" />
          <stop offset="0.5" stopColor="#9b2542" />
          <stop offset="0.64" stopColor="#e2553d" />
          <stop offset="0.72" stopColor="#f59a5b" />
        </linearGradient>
        <radialGradient id="ss-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff1c9" />
          <stop offset="0.5" stopColor="#ffc07a" />
          <stop offset="1" stopColor="#ff8a4a" />
        </radialGradient>
        <radialGradient id="ss-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffb070" stopOpacity="0.75" />
          <stop offset="0.4" stopColor="#ff6a45" stopOpacity="0.25" />
          <stop offset="1" stopColor="#ff6a45" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ss-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a33a5a" />
          <stop offset="1" stopColor="#5b1f47" />
        </linearGradient>
        <linearGradient id="ss-mid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5e2150" />
          <stop offset="1" stopColor="#32133c" />
        </linearGradient>
        <linearGradient id="ss-haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff7a55" stopOpacity="0" />
          <stop offset="1" stopColor="#ff7a55" stopOpacity="0.28" />
        </linearGradient>
      </defs>

      <rect width={W} height={H} fill="url(#ss-sky)" />
      {SCENE.stars.map((s) => (
        <circle
          key={`${s.x}-${s.y}`}
          cx={s.x}
          cy={s.y}
          r={s.r}
          fill="#ffe9e0"
          opacity={s.o}
        />
      ))}
      <path d={SCENE.cloudsHigh} fill="#2a1030" opacity="0.55" />
      <path
        d={SCENE.cloudsHigh}
        fill="#ff6a5a"
        opacity="0.28"
        transform="translate(0 6)"
      />
      <circle cx="1120" cy="610" r="340" fill="url(#ss-glow)" />
      <circle cx="1120" cy="610" r="78" fill="url(#ss-sun)" />
      <path d={SCENE.cloudsLow} fill="#ff8a6a" opacity="0.4" />
      <path
        d={SCENE.cloudsLow}
        fill="#4b1737"
        opacity="0.5"
        transform="translate(40 10)"
      />

      <path d={SCENE.far} fill="url(#ss-far)" />
      <rect y="560" width={W} height="160" fill="url(#ss-haze)" />
      <path d={SCENE.mid} fill="url(#ss-mid)" />
      <path d={SCENE.near} fill="#26102f" />
      <path d={SCENE.forestBack} fill="#1d0c27" />
      <path d={SCENE.forestFront} fill="#10061a" />
    </svg>
  );
});
