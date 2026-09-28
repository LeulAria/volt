import { useInView, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, SplitText, useGSAP } from "@/lib/gsap";

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Pulls section titles off the column guides. */
export const HEADING_INSET = "pl-4 sm:pl-6 md:pl-8";

/** Rises content into place once it scrolls into view. */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 32,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        gsap.from(ref.current, {
          y,
          autoAlpha: 0,
          duration: 1.3,
          delay,
          scrollTrigger: { trigger: ref.current, start: "top 88%", once: true },
        });
      });
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/**
 * Section title: lines rise out of masks one after another, then the body follows.
 */
export function SectionHeading({
  title,
  body,
  eyebrow,
  align = "start",
  className,
}: {
  title: ReactNode;
  body?: ReactNode;
  eyebrow?: ReactNode;
  align?: "start" | "center";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const root = ref.current;
      const h2 = root?.querySelector("h2");
      const p = root?.querySelector("p");
      if (!root || !h2) return;
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        SplitText.create(h2, {
          type: "lines",
          mask: "lines",
          linesClass: "split-line",
          autoSplit: true,
          onSplit: (self) => {
            self.masks.forEach((m) => {
              m.classList.add("split-line-mask");
            });
            return gsap.from(self.lines, {
              yPercent: 115,
              duration: 1.35,
              stagger: 0.1,
              scrollTrigger: { trigger: root, start: "top 84%", once: true },
            });
          },
        });
        if (p) {
          gsap.from(p, {
            y: 18,
            autoAlpha: 0,
            duration: 1.3,
            delay: 0.3,
            scrollTrigger: { trigger: root, start: "top 84%", once: true },
          });
        }
      });
    },
    { scope: ref },
  );

  return (
    <div
      ref={ref}
      className={cn(
        "relative max-w-2xl",
        align === "center" ? "mx-auto text-center" : HEADING_INSET,
        className,
      )}
    >
      {eyebrow ? <div className="mb-5">{eyebrow}</div> : null}
      <h2 className="text-balance text-[32px] font-semibold leading-[1.05] tracking-[-0.03em] text-white sm:text-[44px] md:text-[52px]">
        {title}
      </h2>
      {body ? (
        <p
          className={cn(
            "mt-6 max-w-xl text-pretty text-[15px] leading-[1.65] text-white/50 md:text-[17px]",
            align === "center" && "mx-auto",
          )}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Milliseconds elapsed on a looping timeline, running only while the element is on screen.
 * With reduced motion it pins to `rest` so the finished state shows.
 */
export function useLoopClock(length: number, rest = length) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-10%" });
  const reduce = useReducedMotion();
  const [t, setT] = useState(reduce ? rest : 0);

  useEffect(() => {
    if (reduce) {
      setT(rest);
      return;
    }
    if (!inView) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      acc += dt;
      // ~30fps is plenty for UI choreography
      if (acc >= 33) {
        const step = acc;
        acc = 0;
        setT((prev) => (prev + step) % length);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, length, reduce, rest]);

  return { ref, t };
}

/** 0 → 1 progress of `t` inside the window [start, start + span]. */
export function span(t: number, start: number, length: number) {
  if (t <= start) return 0;
  if (t >= start + length) return 1;
  return (t - start) / length;
}

export function TrafficLights({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="size-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
      <span className="size-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
      <span className="size-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Live content-box width of an element, for scaling fixed-size illustrations. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Outer frame for the scaled demo windows: the window itself is the frame, no backdrop. */
export const WINDOW_FRAME =
  "relative w-full overflow-hidden rounded-[12px] border border-white/[0.12] bg-[#161616] shadow-[0_48px_96px_-32px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.06)] md:rounded-[16px]";
