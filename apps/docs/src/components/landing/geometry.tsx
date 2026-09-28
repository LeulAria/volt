import { type ReactNode, useRef } from "react";
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

/** Vertical hairlines on the column's content edges, behind everything in `main`. */
export function Guides() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 hidden md:block"
    >
      <div className={cn(COLUMN, "h-full")}>
        <div className="h-full border-x border-white/[0.06]" />
      </div>
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
