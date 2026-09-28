import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";

/**
 * Every section sits in the same centred column. The guide lines run down the column's content
 * edges, and section rules cross them with a registration mark, so all construction lines stay
 * registered at every breakpoint.
 */
export const COLUMN =
  "mx-auto w-full max-w-[1296px] px-4 sm:px-6 md:px-10 lg:px-12";

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
      <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-white/40" />
      <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-white/40" />
    </span>
  );
}

type GuideGap = { top: number; bottom: number };

function GuideSegment({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn("absolute inset-x-0 overflow-hidden", className)}
      style={style}
    >
      <div className={cn(COLUMN, "h-full")}>
        <div className="h-full border-x border-white/[0.06]" />
      </div>
    </div>
  );
}

/**
 * Vertical hairlines on the column's content edges, behind content in `main`.
 * Interrupted across `#features` (the bento) so the cards stay clear; resume from
 * the bento's bottom edge through the rest of the page.
 */
export function Guides() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [gap, setGap] = useState<GuideGap | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return;

    const update = () => {
      const features = document.getElementById("features");
      if (!features) {
        setGap(null);
        return;
      }
      const parentTop = parent.getBoundingClientRect().top;
      const rect = features.getBoundingClientRect();
      setGap({
        top: Math.max(0, rect.top - parentTop),
        bottom: Math.max(0, rect.bottom - parentTop),
      });
    };

    update();

    const ro = new ResizeObserver(update);
    ro.observe(parent);
    const features = document.getElementById("features");
    if (features) ro.observe(features);
    window.addEventListener("resize", update);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 hidden md:block"
    >
      <GuideSegment
        className="top-0"
        style={gap ? { height: gap.top } : { bottom: 0 }}
      />
      {gap ? <GuideSegment style={{ top: gap.bottom, bottom: 0 }} /> : null}
    </div>
  );
}

/** Full-width hairline between sections, marked where it crosses the guides. Draws in from the left. */
export function SectionRule({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        gsap.from(ref.current?.querySelector("[data-line]") ?? null, {
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
      className={cn("pointer-events-none relative h-px w-full", className)}
    >
      <span
        data-line
        className="absolute inset-0 origin-left bg-white/[0.08]"
      />
      <div className={cn(COLUMN, "relative hidden h-px md:block")}>
        <div className="relative h-px">
          <Cross className="top-0 left-0" />
          <Cross className="top-0 left-full" />
        </div>
      </div>
    </div>
  );
}

/** Small mono label that opens a section, e.g. "02 — Built-in browser". */
export function Eyebrow({
  index,
  children,
  className,
}: {
  index?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 font-mono text-[10.5px] tracking-[0.16em] text-white/45 uppercase",
        className,
      )}
    >
      {index ? (
        <>
          <span className="text-[#ff8a5a]">
            {String(index).padStart(2, "0")}
          </span>
          <span className="h-px w-6 bg-white/20" />
        </>
      ) : null}
      {children}
    </div>
  );
}
