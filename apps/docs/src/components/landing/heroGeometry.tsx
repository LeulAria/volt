import { useRef } from "react";
import {
  BOLT_HOLE,
  BOLT_PATH,
  BOLT_TIP_BOTTOM,
  BOLT_TIP_TOP,
  BOLT_W,
} from "@/lib/boltGeometry";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";

/*
 * Construction drawing laid over the particle bolt. The particle field fits the bolt's ink box
 * into its square slot with 2.8% padding (see particleLogo FIT_PAD), so mapping the traced
 * geometry the same way keeps every line registered on the dots.
 */
const VIEW = 1000;
const FIT = 1 - 0.028 * 2;
const INK_TOP = BOLT_TIP_TOP.y;
const INK_BOTTOM = BOLT_TIP_BOTTOM.y;
const K = (VIEW * FIT) / (INK_BOTTOM - INK_TOP);
const OX = VIEW / 2 - (BOLT_W / 2) * K;
const OY = VIEW / 2 - ((INK_TOP + INK_BOTTOM) / 2) * K;
const map = (x: number, y: number) => ({ x: OX + x * K, y: OY + y * K });

const HOLE = { ...map(BOLT_HOLE.cx, BOLT_HOLE.cy), r: BOLT_HOLE.r * K };
const TOP = map(BOLT_TIP_TOP.x, BOLT_TIP_TOP.y);
const BOTTOM = map(BOLT_TIP_BOTTOM.x, BOLT_TIP_BOTTOM.y);
/** Circle through the upper tip, centred on the hole: the bolt's circumscribing construction. */
const R = Math.hypot(TOP.x - HOLE.x, TOP.y - HOLE.y);
const PHI = (1 + Math.sqrt(5)) / 2;
const AXIS_DEG =
  (Math.atan2(TOP.x - BOTTOM.x, BOTTOM.y - TOP.y) * 180) / Math.PI;
const BOX = { left: OX, right: OX + BOLT_W * K, top: TOP.y, bottom: BOTTOM.y };

const f = (n: number) => Math.round(n * 10) / 10;

/** Arc from straight up, turning clockwise by `deg`, at radius `r` around the hole. */
function arc(r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const x0 = HOLE.x;
  const y0 = HOLE.y - r;
  const x1 = HOLE.x + Math.sin(a) * r;
  const y1 = HOLE.y - Math.cos(a) * r;
  return `M${f(x0)} ${f(y0)} A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y1)}`;
}

const TICKS = Array.from({ length: 72 }, (_, i) => {
  const a = (i / 72) * Math.PI * 2;
  const long = i % 6 === 0;
  const r0 = R + 10;
  const r1 = R + (long ? 30 : 19);
  return {
    key: i,
    x1: f(HOLE.x + Math.cos(a) * r0),
    y1: f(HOLE.y + Math.sin(a) * r0),
    x2: f(HOLE.x + Math.cos(a) * r1),
    y2: f(HOLE.y + Math.sin(a) * r1),
    long,
  };
});

// extend the tip-to-tip axis a little past both tips
const AX = {
  dx: (TOP.x - BOTTOM.x) / Math.hypot(TOP.x - BOTTOM.x, TOP.y - BOTTOM.y),
  dy: (TOP.y - BOTTOM.y) / Math.hypot(TOP.x - BOTTOM.x, TOP.y - BOTTOM.y),
};
const AXIS = {
  x1: f(TOP.x + AX.dx * 70),
  y1: f(TOP.y + AX.dy * 70),
  x2: f(BOTTOM.x - AX.dx * 70),
  y2: f(BOTTOM.y - AX.dy * 70),
};

const LABEL = "fill-white/45 font-mono text-[15px] tracking-[0.06em]";

export function HeroGeometry() {
  const ref = useRef<SVGSVGElement>(null);

  useGSAP(
    () => {
      const svg = ref.current;
      if (!svg) return;
      const strokes = svg.querySelectorAll("[data-draw]");
      const centred = svg.querySelectorAll("[data-draw-centre]");
      const labels = svg.querySelectorAll("[data-label]");
      const ring = svg.querySelector("[data-ring]");
      const outline = svg.querySelector("[data-outline]");

      const mm = gsap.matchMedia();
      mm.add(`not ${REDUCED}`, () => {
        const tl = gsap.timeline({
          delay: 1.5,
          defaults: { ease: "power3.inOut", duration: 1.8 },
        });
        tl.from(centred, { drawSVG: "50% 50%", stagger: 0.08 })
          .from(strokes, { drawSVG: 0, stagger: 0.07 }, 0.1)
          .from(
            outline,
            { drawSVG: 0, duration: 2.6, ease: "power2.inOut" },
            0.3,
          )
          .to(outline, { opacity: 0.35, duration: 1.4 }, ">-0.2")
          .from(
            ring,
            {
              autoAlpha: 0,
              scale: 0.94,
              svgOrigin: `${HOLE.x} ${HOLE.y}`,
              duration: 1.6,
              ease: "expo.out",
            },
            0.5,
          )
          .from(
            labels,
            {
              autoAlpha: 0,
              y: 8,
              stagger: 0.06,
              duration: 0.9,
              ease: "expo.out",
            },
            1.1,
          );

        gsap.to(ring, {
          rotation: 360,
          svgOrigin: `${HOLE.x} ${HOLE.y}`,
          duration: 240,
          repeat: -1,
          ease: "none",
        });

        // leaving the hero: the drawing turns a few degrees and dissolves, handing off to the spine
        gsap.to(svg, {
          rotation: -6,
          scale: 1.08,
          opacity: 0,
          ease: "none",
          scrollTrigger: {
            trigger: svg,
            start: "center 40%",
            end: "bottom top",
            scrub: true,
          },
        });
      });
    },
    { scope: ref },
  );

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full overflow-visible text-white"
      fill="none"
    >
      <g vectorEffect="non-scaling-stroke" strokeWidth={1}>
        {/* datum axes through the hole */}
        <line
          data-draw-centre
          x1={-420}
          y1={HOLE.y}
          x2={VIEW + 420}
          y2={HOLE.y}
          stroke="currentColor"
          strokeOpacity={0.09}
          vectorEffect="non-scaling-stroke"
        />
        <line
          data-draw-centre
          x1={HOLE.x}
          y1={-60}
          x2={HOLE.x}
          y2={VIEW + 60}
          stroke="currentColor"
          strokeOpacity={0.09}
          vectorEffect="non-scaling-stroke"
        />

        {/* circumscribing circle, its golden-ratio inner, and the hole */}
        <circle
          data-draw
          cx={HOLE.x}
          cy={HOLE.y}
          r={R}
          stroke="currentColor"
          strokeOpacity={0.12}
          vectorEffect="non-scaling-stroke"
          transform={`rotate(-90 ${HOLE.x} ${HOLE.y})`}
        />
        <circle
          data-draw
          cx={HOLE.x}
          cy={HOLE.y}
          r={R / PHI}
          stroke="currentColor"
          strokeOpacity={0.08}
          strokeDasharray="2 7"
          vectorEffect="non-scaling-stroke"
          transform={`rotate(-90 ${HOLE.x} ${HOLE.y})`}
        />
        <circle
          data-draw
          cx={HOLE.x}
          cy={HOLE.y}
          r={HOLE.r * PHI}
          stroke="currentColor"
          strokeOpacity={0.14}
          strokeDasharray="1 5"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          data-draw
          cx={HOLE.x}
          cy={HOLE.y}
          r={HOLE.r}
          stroke="#ff6228"
          strokeOpacity={0.75}
          vectorEffect="non-scaling-stroke"
          transform={`rotate(-90 ${HOLE.x} ${HOLE.y})`}
        />

        {/* protractor ring */}
        <g data-ring>
          {TICKS.map((t) => (
            <line
              key={t.key}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke="currentColor"
              strokeOpacity={t.long ? 0.3 : 0.13}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>

        {/* bolt axis and its angle to vertical */}
        <line
          data-draw
          x1={AXIS.x1}
          y1={AXIS.y1}
          x2={AXIS.x2}
          y2={AXIS.y2}
          stroke="#ff6228"
          strokeOpacity={0.5}
          strokeDasharray="5 6"
          vectorEffect="non-scaling-stroke"
        />
        <path
          data-draw
          d={arc(170, AXIS_DEG)}
          stroke="#ff6228"
          strokeOpacity={0.8}
          vectorEffect="non-scaling-stroke"
        />

        {/* brand silhouette outline */}
        <path
          data-outline
          d={BOLT_PATH}
          fillRule="evenodd"
          stroke="currentColor"
          strokeOpacity={0.6}
          vectorEffect="non-scaling-stroke"
          transform={`translate(${f(OX)} ${f(OY)}) scale(${K})`}
        />

        {/* dimensions */}
        <g className="max-md:hidden">
          <line
            data-draw
            x1={BOX.right + 70}
            y1={BOX.top}
            x2={BOX.right + 70}
            y2={BOX.bottom}
            stroke="currentColor"
            strokeOpacity={0.22}
            vectorEffect="non-scaling-stroke"
          />
          <line
            data-draw
            x1={BOX.right + 60}
            y1={BOX.top}
            x2={BOX.right + 80}
            y2={BOX.top}
            stroke="currentColor"
            strokeOpacity={0.35}
            vectorEffect="non-scaling-stroke"
          />
          <line
            data-draw
            x1={BOX.right + 60}
            y1={BOX.bottom}
            x2={BOX.right + 80}
            y2={BOX.bottom}
            stroke="currentColor"
            strokeOpacity={0.35}
            vectorEffect="non-scaling-stroke"
          />
          <line
            data-draw
            x1={BOX.left}
            y1={BOX.bottom + 44}
            x2={BOX.right}
            y2={BOX.bottom + 44}
            stroke="currentColor"
            strokeOpacity={0.22}
            vectorEffect="non-scaling-stroke"
          />
          <line
            data-draw
            x1={BOX.left}
            y1={BOX.bottom + 34}
            x2={BOX.left}
            y2={BOX.bottom + 54}
            stroke="currentColor"
            strokeOpacity={0.35}
            vectorEffect="non-scaling-stroke"
          />
          <line
            data-draw
            x1={BOX.right}
            y1={BOX.bottom + 34}
            x2={BOX.right}
            y2={BOX.bottom + 54}
            stroke="currentColor"
            strokeOpacity={0.35}
            vectorEffect="non-scaling-stroke"
          />
          {/* hole callout leader */}
          <path
            data-draw
            d={`M${f(HOLE.x - HOLE.r * 0.72)} ${f(HOLE.y + HOLE.r * 0.72)} L${f(HOLE.x - 190)} ${f(HOLE.y + 150)} L${f(HOLE.x - 300)} ${f(HOLE.y + 150)}`}
            stroke="currentColor"
            strokeOpacity={0.3}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </g>

      <g className="max-md:hidden">
        <text
          data-label
          x={BOX.right + 88}
          y={HOLE.y}
          className={LABEL}
          dominantBaseline="middle"
        >
          h 1341
        </text>
        <text
          data-label
          x={(BOX.left + BOX.right) / 2}
          y={BOX.bottom + 74}
          className={LABEL}
          textAnchor="middle"
        >
          w 696
        </text>
        <text data-label x={HOLE.x - 300} y={HOLE.y + 138} className={LABEL}>
          Ø {f(BOLT_HOLE.r * 2)}
        </text>
        <text
          data-label
          x={HOLE.x + 150}
          y={HOLE.y - 182}
          className="fill-[#ff8a5a] font-mono text-[15px] tracking-[0.06em]"
        >
          θ {AXIS_DEG.toFixed(2)}°
        </text>
        <text
          data-label
          x={HOLE.x + R * 0.72 + 14}
          y={HOLE.y - R * 0.72}
          className={LABEL}
        >
          r {f(R / K)}
        </text>
        <text
          data-label
          x={HOLE.x + (R / PHI) * 0.72 + 12}
          y={HOLE.y + (R / PHI) * 0.72 + 18}
          className={LABEL}
        >
          r / φ
        </text>
        <text data-label x={TOP.x + 16} y={TOP.y - 6} className={LABEL}>
          ({BOLT_TIP_TOP.x}, {BOLT_TIP_TOP.y})
        </text>
        <text
          data-label
          x={BOTTOM.x - 16}
          y={BOTTOM.y + 6}
          className={LABEL}
          textAnchor="end"
          dominantBaseline="hanging"
        >
          ({BOLT_TIP_BOTTOM.x}, {BOLT_TIP_BOTTOM.y})
        </text>
      </g>
      {/* centre mark */}
      <g stroke="#ff8a5a" strokeOpacity={0.9} vectorEffect="non-scaling-stroke">
        <line
          x1={HOLE.x - 9}
          y1={HOLE.y}
          x2={HOLE.x + 9}
          y2={HOLE.y}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={HOLE.x}
          y1={HOLE.y - 9}
          x2={HOLE.x}
          y2={HOLE.y + 9}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}
