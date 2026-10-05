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
  forestBack: forest(17, 70, hills, 70, 90),
  forestFront: forest(31, 22, shore, 90, 130),
  stars: stars(5, 60),
};

/** Stylised dusk landscape (sky, stars, ridges, pines) — a nod to the app's wallpaper. */
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
          <stop offset="0" stopColor="#0d0b14" />
          <stop offset="0.3" stopColor="#24122a" />
          <stop offset="0.5" stopColor="#5c1c36" />
          <stop offset="0.62" stopColor="#b8403a" />
          <stop offset="0.7" stopColor="#f08a52" />
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
        <linearGradient id="ss-dawn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a1a3c" />
          <stop offset="0.35" stopColor="#a33a4f" />
          <stop offset="0.62" stopColor="#ff9a5c" />
          <stop offset="0.75" stopColor="#ffc890" />
        </linearGradient>
        <linearGradient id="ss-haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff7a55" stopOpacity="0" />
          <stop offset="1" stopColor="#ff7a55" stopOpacity="0.28" />
        </linearGradient>
      </defs>

      <rect width={W} height={H} fill="url(#ss-sky)" />
      {/* `data-*` hooks let the demo tour scrub a sunrise: the dawn sky fades in, stars
          fade out, the sun climbs, and the ridges drift apart for depth. */}
      <rect data-dawn width={W} height={H} fill="url(#ss-dawn)" opacity={0} />
      <g data-stars>
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
      </g>
      <g data-sun>
        <circle cx="1390" cy="610" r="360" fill="url(#ss-glow)" />
        <circle cx="1390" cy="610" r="70" fill="url(#ss-sun)" />
      </g>

      <path data-depth="1" d={SCENE.far} fill="url(#ss-far)" />
      <rect y="560" width={W} height="160" fill="url(#ss-haze)" />
      <path data-depth="2" d={SCENE.mid} fill="url(#ss-mid)" />
      <path data-depth="3" d={SCENE.near} fill="#26102f" />
      <path data-depth="4" d={SCENE.forestBack} fill="#1d0c27" />
      <path data-depth="5" d={SCENE.forestFront} fill="#10061a" />
    </svg>
  );
});
