import { Link } from "@tanstack/react-router";
import {
  DownloadButtons,
  GithubMarkIcon,
  InstallCommand,
  RELEASES_URL,
  REPO_URL,
} from "./install";
import { useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";

/* ------------------------------------------------------------------ */
/* Closing construction                                                */
/* ------------------------------------------------------------------ */

const PHI = (1 + Math.sqrt(5)) / 2;
const R0 = 84;
const R1 = R0 * PHI;
const R2 = R1 * PHI;
const GOLDEN_ANGLE = 360 / PHI ** 2; // 137.5°
const g = (n: number) => Math.round(n * 10) / 10;

/** Golden spiral r = a·φ^(2θ/π), sampled as a polyline from inside the icon out to the outer circle. */
const SPIRAL = (() => {
  const turns = 4.5 * Math.PI;
  const a = R2 / PHI ** ((2 * turns) / Math.PI);
  const pts: string[] = [];
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * turns;
    const r = a * PHI ** ((2 * t) / Math.PI);
    pts.push(
      `${g(Math.cos(t - Math.PI / 2) * r)} ${g(Math.sin(t - Math.PI / 2) * r)}`,
    );
  }
  return `M${pts.join(" L")}`;
})();

const RING = Array.from({ length: 120 }, (_, i) => {
  const a = (i / 120) * Math.PI * 2;
  const long = i % 10 === 0;
  const r0 = R2 + 8;
  const r1 = R2 + (long ? 22 : 14);
  return {
    i,
    long,
    x1: g(Math.cos(a) * r0),
    y1: g(Math.sin(a) * r0),
    x2: g(Math.cos(a) * r1),
    y2: g(Math.sin(a) * r1),
  };
});

function arcPath(r: number, from: number, to: number) {
  const p = (d: number) => [
    g(Math.cos(((d - 90) * Math.PI) / 180) * r),
    g(Math.sin(((d - 90) * Math.PI) / 180) * r),
  ];
  const [x0, y0] = p(from);
  const [x1, y1] = p(to);
  return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`;
}

const GA = (() => {
  const rad = ((GOLDEN_ANGLE - 90) * Math.PI) / 180;
  return { x: g(Math.cos(rad) * R2), y: g(Math.sin(rad) * R2) };
})();

const LABEL = "fill-white/40 font-mono text-[10px] tracking-[0.08em]";

export function ClosingCta() {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const root = ref.current;
      if (!root) return;
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        const trigger = {
          trigger: root.querySelector("[data-construct]"),
          start: "top 85%",
          once: true,
        };
        gsap
          .timeline({
            scrollTrigger: trigger,
            defaults: { ease: "power3.inOut", duration: 1.6 },
          })
          .from(root.querySelectorAll("[data-c-centre]"), {
            drawSVG: "50% 50%",
            stagger: 0.06,
          })
          .from(
            root.querySelectorAll("[data-c-draw]"),
            { drawSVG: 0, stagger: 0.1 },
            0.15,
          )
          .from(
            root.querySelector("[data-c-icon]"),
            {
              autoAlpha: 0,
              scale: 0.7,
              rotation: -12,
              duration: 1.6,
              ease: "expo.out",
            },
            0.3,
          )
          .from(
            root.querySelectorAll("[data-c-label]"),
            {
              autoAlpha: 0,
              y: 6,
              stagger: 0.08,
              duration: 0.8,
              ease: "expo.out",
            },
            0.9,
          )
          .from(
            root.querySelectorAll("[data-c-rest]"),
            {
              autoAlpha: 0,
              y: 20,
              stagger: 0.1,
              duration: 1.2,
              ease: "expo.out",
            },
            0.8,
          );

        // the spiral unwinds and the ring turns with the scroll
        gsap.from(root.querySelector("[data-spiral]"), {
          drawSVG: 0,
          ease: "none",
          scrollTrigger: {
            trigger: root,
            start: "top 75%",
            end: "center 45%",
            scrub: 1,
          },
        });
        gsap.to(root.querySelector("[data-c-ring]"), {
          rotation: 60,
          svgOrigin: "0 0",
          ease: "none",
          scrollTrigger: {
            trigger: root,
            start: "top bottom",
            end: "bottom top",
            scrub: 1,
          },
        });
      });
    },
    { scope: ref },
  );

  return (
    <section ref={ref} className={cn(COLUMN, "relative py-20 md:py-28")}>
      <div className="relative flex flex-col items-center text-center">
        <div
          data-construct
          className="relative aspect-square w-[min(88vw,520px)]"
        >
          <svg
            viewBox="-300 -300 600 600"
            aria-hidden
            fill="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            <g stroke="currentColor" className="text-white">
              <line
                data-c-centre
                x1={-300}
                y1={0}
                x2={300}
                y2={0}
                strokeOpacity={0.09}
                vectorEffect="non-scaling-stroke"
              />
              <line
                data-c-centre
                x1={0}
                y1={-300}
                x2={0}
                y2={300}
                strokeOpacity={0.09}
                vectorEffect="non-scaling-stroke"
              />
              <line
                data-c-centre
                x1={-R2 * Math.SQRT1_2}
                y1={-R2 * Math.SQRT1_2}
                x2={R2 * Math.SQRT1_2}
                y2={R2 * Math.SQRT1_2}
                strokeOpacity={0.05}
                vectorEffect="non-scaling-stroke"
              />
              <line
                data-c-centre
                x1={-R2 * Math.SQRT1_2}
                y1={R2 * Math.SQRT1_2}
                x2={R2 * Math.SQRT1_2}
                y2={-R2 * Math.SQRT1_2}
                strokeOpacity={0.05}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                data-c-draw
                r={R0}
                strokeOpacity={0.14}
                strokeDasharray="2 6"
                vectorEffect="non-scaling-stroke"
                transform="rotate(-90)"
              />
              <circle
                data-c-draw
                r={R1}
                strokeOpacity={0.1}
                vectorEffect="non-scaling-stroke"
                transform="rotate(-90)"
              />
              <circle
                data-c-draw
                r={R2}
                strokeOpacity={0.14}
                vectorEffect="non-scaling-stroke"
                transform="rotate(-90)"
              />
              <g data-c-ring>
                {RING.map((t) => (
                  <line
                    key={t.i}
                    x1={t.x1}
                    y1={t.y1}
                    x2={t.x2}
                    y2={t.y2}
                    strokeOpacity={t.long ? 0.3 : 0.12}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
              {/* golden angle */}
              <line
                data-c-draw
                x1={0}
                y1={0}
                x2={0}
                y2={-R2}
                stroke="#ff6228"
                strokeOpacity={0.35}
                vectorEffect="non-scaling-stroke"
              />
              <line
                data-c-draw
                x1={0}
                y1={0}
                x2={GA.x}
                y2={GA.y}
                stroke="#ff6228"
                strokeOpacity={0.35}
                vectorEffect="non-scaling-stroke"
              />
              <path
                data-c-draw
                d={arcPath(R0 * 1.3, 0, GOLDEN_ANGLE)}
                stroke="#ff6228"
                strokeOpacity={0.8}
                vectorEffect="non-scaling-stroke"
              />
            </g>
            <path
              data-spiral
              d={SPIRAL}
              stroke="#ff6228"
              strokeOpacity={0.55}
              vectorEffect="non-scaling-stroke"
            />
            <g className="max-md:hidden">
              <text data-c-label x={R1 + 8} y={-8} className={LABEL}>
                φ = 1.6180
              </text>
              <text data-c-label x={R2 + 30} y={4} className={LABEL}>
                r₂ {g(R2)}
              </text>
              <text
                data-c-label
                x={R0 * 1.3 * 0.75 + 6}
                y={R0 * 0.2}
                className="fill-[#ff8a5a] font-mono text-[10px] tracking-[0.08em]"
              >
                {GOLDEN_ANGLE.toFixed(1)}°
              </text>
              <text
                data-c-label
                x={-R0 - 6}
                y={-6}
                textAnchor="end"
                className={LABEL}
              >
                r₀ {R0}
              </text>
            </g>
          </svg>
          <img
            data-c-icon
            src="/volt-icon-256.png"
            alt=""
            width={256}
            height={256}
            className="absolute top-1/2 left-1/2 size-[26%] -translate-x-1/2 -translate-y-1/2"
          />
        </div>
        <h2
          data-c-rest
          className="mt-8 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-white sm:text-[48px] md:mt-10 md:text-[60px]"
        >
          Get started with Volt.
        </h2>
        <p
          data-c-rest
          className="mt-4 max-w-xl text-balance text-[16px] leading-relaxed text-white/50 md:text-[18px]"
        >
          Free while in public beta. macOS, Windows, and Linux.
        </p>
        <div
          data-c-rest
          className="mt-8 flex w-full max-w-[560px] flex-col items-stretch gap-3 md:flex-row md:items-center"
        >
          <InstallCommand className="md:flex-1" />
          <DownloadButtons className="md:w-max" />
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className={cn(COLUMN, "py-10")}>
      <div className="flex flex-col gap-6 text-[13px] text-white/40 md:flex-row md:items-center">
        <span className="font-mono text-[15px] font-semibold tracking-wide text-white/80">
          volt
        </span>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 md:ml-8">
          <Link
            to="/docs/$"
            params={{ _splat: "" }}
            className="transition-colors hover:text-white"
          >
            Docs
          </Link>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-white"
          >
            Releases
          </a>
          <a href="/llms.txt" className="transition-colors hover:text-white">
            llms.txt
          </a>
        </nav>
        <div className="flex items-center gap-4 md:ml-auto">
          <span>© {new Date().getFullYear()} Volt</span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Volt on GitHub"
            className="transition-colors hover:text-white"
          >
            <GithubMarkIcon className="size-4" />
          </a>
        </div>
      </div>
    </footer>
  );
}
