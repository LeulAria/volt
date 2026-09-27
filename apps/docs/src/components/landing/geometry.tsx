import { type ReactNode, useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, ScrollTrigger, useGSAP } from "@/lib/gsap";

/**
 * Blueprint layer: every section sits in the same column, and the rails sit a fixed 24px
 * outside that column on md+. Nodes, rules, and crosses all key off those two numbers,
 * so the construction lines stay aligned at every breakpoint.
 */
export const COLUMN =
  "mx-auto w-full max-w-[1296px] px-4 sm:px-6 md:px-10 lg:px-12";
const RAIL_OFFSET = "md:-mx-6";

const TICKS_MINOR =
  "repeating-linear-gradient(to bottom, rgba(255,255,255,0.14) 0 1px, transparent 1px 16px)";
const TICKS_MAJOR =
  "repeating-linear-gradient(to bottom, rgba(255,255,255,0.22) 0 1px, transparent 1px 80px)";

/** A 9px registration cross, centred on its anchor point. */
export function Cross({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute size-[9px] -translate-x-1/2 -translate-y-1/2",
        className,
      )}
    >
      <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-white/35" />
      <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-white/35" />
    </span>
  );
}

/**
 * Full-height guide rails with ruler ticks. The left rail is the journey spine: an orange line
 * fills to wherever the viewport centre is, with a glowing head riding its tip.
 */
export function Rails() {
  const root = useRef<HTMLDivElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const hudChapter = useRef<HTMLSpanElement>(null);
  const hudPct = useRef<HTMLSpanElement>(null);
  const hudY = useRef<HTMLSpanElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      const main = el?.parentElement;
      if (!el || !main) return;
      const fill = el.querySelector<HTMLElement>("[data-spine]");
      const head = el.querySelector<HTMLElement>("[data-spine-head]");
      if (!fill || !head) return;
      const setHead = gsap.quickSetter(head, "y", "px");
      const chapters = gsap.utils.toArray<HTMLElement>("[data-chapter]", main);

      ScrollTrigger.create({
        trigger: main,
        start: "top center",
        end: "bottom center",
        onToggle: (self) =>
          gsap.to([head, hud.current], {
            autoAlpha: self.isActive ? 1 : 0,
            duration: 0.4,
          }),
        onUpdate: (self) => {
          const p = self.progress;
          gsap.set(fill, { scaleY: p });
          setHead(p * el.offsetHeight);
          if (hudPct.current)
            hudPct.current.textContent = `${(p * 100).toFixed(1)}%`;
          if (hudY.current)
            hudY.current.textContent = Math.round(
              window.scrollY,
            ).toLocaleString("en-US");
          const mid = window.innerHeight / 2;
          let current = chapters[0];
          for (const c of chapters)
            if (c.getBoundingClientRect().top < mid) current = c;
          if (current && hudChapter.current) {
            hudChapter.current.textContent = `${current.dataset.index} / ${String(chapters.length).padStart(2, "0")} — ${current.dataset.chapter}`;
          }
        },
      });
    },
    { scope: root },
  );

  return (
    <>
      <div
        ref={root}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 hidden md:block"
      >
        <div className={cn(COLUMN, "h-full")}>
          <div className={cn("relative h-full", RAIL_OFFSET)}>
            {/* left rail + ruler */}
            <span className="absolute inset-y-0 left-0 w-px bg-white/[0.07]" />
            <span
              className="absolute inset-y-0 left-0 w-[5px] opacity-60"
              style={{ backgroundImage: TICKS_MINOR }}
            />
            <span
              className="absolute inset-y-0 left-0 w-[11px] opacity-60"
              style={{ backgroundImage: TICKS_MAJOR }}
            />
            {/* spine progress */}
            <span
              data-spine
              style={{ transform: "scaleY(0)" }}
              className="absolute inset-y-0 left-0 w-px origin-top bg-gradient-to-b from-[#ff6228]/10 via-[#ff6228]/70 to-[#ff8a4a]"
            />
            <span
              data-spine-head
              className="invisible absolute top-0 left-0 size-[7px] -translate-x-[3px] -translate-y-1/2 rounded-full bg-[#ffb07a] opacity-0 shadow-[0_0_0_4px_rgba(255,98,40,0.18),0_0_18px_4px_rgba(255,98,40,0.55)]"
            />
            {/* right rail + ruler */}
            <span className="absolute inset-y-0 right-0 w-px bg-white/[0.07]" />
            <span
              className="absolute inset-y-0 right-0 w-[5px] opacity-60"
              style={{ backgroundImage: TICKS_MINOR }}
            />
            <span
              className="absolute inset-y-0 right-0 w-[11px] opacity-60"
              style={{ backgroundImage: TICKS_MAJOR }}
            />
          </div>
        </div>
      </div>

      {/* instrument readout */}
      <div
        ref={hud}
        aria-hidden
        className="pointer-events-none invisible fixed top-1/2 right-5 z-40 hidden -translate-y-1/2 rotate-180 items-center gap-3 font-mono text-[10px] tracking-[0.14em] text-white/40 uppercase opacity-0 [writing-mode:vertical-rl] min-[1440px]:flex"
      >
        <span className="size-1.5 rounded-full bg-[#ff6228] shadow-[0_0_8px_#ff6228]" />
        <span ref={hudChapter} className="text-white/70">
          01 / 05
        </span>
        <span className="h-px w-3 bg-white/15" />
        <span>
          y <span ref={hudY}>0</span>
        </span>
        <span className="h-px w-3 bg-white/15" />
        <span ref={hudPct} className="h-[46px] text-right tabular-nums">
          0.0%
        </span>
      </div>
    </>
  );
}

/**
 * Journey stop on the spine. Sits on the left rail (24px left of the column) at its parent's
 * top edge, and lights up once the viewport centre passes it.
 */
export function ChapterNode({
  index,
  name,
  className,
}: {
  index: number;
  name: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useGSAP(
    () => {
      if (!ref.current) return;
      ScrollTrigger.create({
        trigger: ref.current,
        start: "top center",
        toggleClass: { targets: ref.current, className: "is-on" },
      });
    },
    { scope: ref },
  );
  return (
    <span
      ref={ref}
      data-chapter={name}
      data-index={String(index).padStart(2, "0")}
      aria-hidden
      className={cn(
        "chapter-node pointer-events-none absolute -left-6 hidden md:block",
        className,
      )}
    >
      <span className="chapter-node__dot" />
      <span className="chapter-node__lead" />
      <span className="chapter-node__label">
        {String(index).padStart(2, "0")}
      </span>
    </span>
  );
}

/** Hairline between sections, capped with crosses where it meets the rails. Draws in from the left. */
export function SectionRule({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const line = ref.current?.querySelector("[data-line]");
      if (!line) return;
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        gsap.from(line, {
          scaleX: 0,
          duration: 1.6,
          ease: "expo.inOut",
          scrollTrigger: { trigger: ref.current, start: "top 90%", once: true },
        });
      });
    },
    { scope: ref },
  );
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(COLUMN, "pointer-events-none", className)}
    >
      <div className={cn("relative h-px", RAIL_OFFSET)}>
        <span
          data-line
          className="absolute inset-0 origin-left bg-white/[0.08]"
        />
        <Cross className="top-0 left-0 hidden md:block" />
        <Cross className="top-0 left-full hidden md:block" />
      </div>
    </div>
  );
}

/** Engineering dimension line with end ticks and a centred label, e.g. "1200 × 780". */
export function Dimension({
  label,
  className,
}: {
  label: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-dim
      aria-hidden
      className={cn("relative hidden h-4 origin-center md:block", className)}
    >
      <span className="absolute top-1/2 right-0 left-0 h-px bg-white/15" />
      <span className="absolute top-0 left-0 h-full w-px bg-white/30" />
      <span className="absolute top-0 right-0 h-full w-px bg-white/30" />
      <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#0a0d0c] px-2.5 font-mono text-[10px] tracking-[0.14em] text-white/40 uppercase">
        {label}
      </span>
    </div>
  );
}

/** L-shaped registration marks just outside each corner of the parent box. */
export function CornerMarks({ className }: { className?: string }) {
  const mark = "absolute size-3 border-white/25";
  return (
    <div
      data-corners
      aria-hidden
      className={cn(
        "pointer-events-none absolute -inset-3 hidden md:block",
        className,
      )}
    >
      <span className={cn(mark, "top-0 left-0 border-t border-l")} />
      <span className={cn(mark, "top-0 right-0 border-t border-r")} />
      <span className={cn(mark, "bottom-0 left-0 border-b border-l")} />
      <span className={cn(mark, "right-0 bottom-0 border-r border-b")} />
    </div>
  );
}

/**
 * A demo stage in its drafting frame: dimension line on top, corner marks around it, and a
 * scroll-scrubbed clip that opens the stage from an inset window to full bleed.
 */
export function FramedStage({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const clip = el.querySelector("[data-clip]");
      const dim = el.querySelector("[data-dim]");
      const corners = el.querySelector("[data-corners]");
      const mm = gsap.matchMedia();
      mm.add(
        { wide: "(min-width: 768px)", motion: `not ${REDUCED}` },
        (context) => {
          const { wide, motion } = context.conditions as {
            wide: boolean;
            motion: boolean;
          };
          if (!motion) return;
          const round = wide ? 28 : 18;
          gsap.fromTo(
            clip,
            {
              clipPath: `inset(${wide ? "9% 7% 0% 7%" : "4% 3% 0% 3%"} round ${round}px)`,
              y: 40,
            },
            {
              clipPath: `inset(0% 0% 0% 0% round ${round}px)`,
              y: 0,
              ease: "none",
              scrollTrigger: {
                trigger: el,
                start: "top 95%",
                end: "top 35%",
                scrub: 0.9,
              },
            },
          );
          if (dim) {
            gsap.from(dim, {
              scaleX: 0,
              duration: 1.4,
              ease: "expo.inOut",
              scrollTrigger: { trigger: el, start: "top 80%", once: true },
            });
          }
          if (corners) {
            gsap.from(corners, {
              autoAlpha: 0,
              scale: 1.04,
              duration: 1.2,
              delay: 0.3,
              scrollTrigger: { trigger: el, start: "top 80%", once: true },
            });
          }
        },
      );
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className="relative">
      <Dimension label={label} className="mb-5" />
      <div className="relative">
        <CornerMarks />
        <div data-clip>{children}</div>
      </div>
    </div>
  );
}
