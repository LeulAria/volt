import { useEffect, useRef } from "react";
import { REDUCED, ScrollTrigger } from "@/lib/gsap";

const STEP = 8;
const MAJOR = 10;
const ACCENT = "#ff8a5a";

/**
 * A surveyor's ruler down the right edge of the page, wide screens only. Its scale slides past a
 * fixed reading mark as you scroll, and its numbers count the page in screens.
 */
export function ScrollRuler() {
  const strip = useRef<HTMLDivElement>(null);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const reduce = window.matchMedia(REDUCED).matches;
    const span = STEP * MAJOR;
    const apply = (y: number) => {
      if (strip.current && !reduce) {
        strip.current.style.transform = `translateY(${-(y % span)}px)`;
      }
      const base = Math.floor(y / span);
      labels.current.forEach((el, i) => {
        if (el) el.textContent = String((base + i) * MAJOR).padStart(3, "0");
      });
    };
    apply(window.scrollY);
    const trigger = ScrollTrigger.create({
      start: 0,
      end: "max",
      onUpdate: (self) => apply(self.scroll()),
      onRefresh: (self) => apply(self.scroll()),
    });
    return () => trigger.kill();
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed top-0 right-0 bottom-0 z-20 hidden w-11 lg:block"
    >
      {/* ruler */}
      <div className="absolute inset-y-0 right-0 w-11 overflow-hidden [mask-image:linear-gradient(180deg,transparent,#000_12%,#000_86%,transparent)]">
        <div
          ref={strip}
          className="absolute inset-x-0 top-0 will-change-transform"
          style={{ height: "calc(100vh + 160px)" }}
        >
          <div
            className="absolute inset-y-0 right-0 w-5 border-l border-white/[0.1]"
            style={{
              backgroundImage: [
                `repeating-linear-gradient(180deg, rgba(255,255,255,0.28) 0 1px, transparent 1px ${STEP * MAJOR}px)`,
                `repeating-linear-gradient(180deg, rgba(255,255,255,0.14) 0 1px, transparent 1px ${(STEP * MAJOR) / 2}px)`,
                `repeating-linear-gradient(180deg, rgba(255,255,255,0.1) 0 1px, transparent 1px ${STEP}px)`,
              ].join(", "),
              backgroundSize: "100% 100%, 55% 100%, 30% 100%",
              backgroundPosition: "right top",
              backgroundRepeat: "no-repeat",
            }}
          />
          {Array.from({ length: 14 }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed label slots
              key={i}
              ref={(el) => {
                labels.current[i] = el;
              }}
              className="absolute right-6 w-7 text-right font-mono text-[7.5px] tracking-[0.08em] text-white/35"
              style={{ top: i * STEP * MAJOR - 4 }}
            />
          ))}
        </div>
      </div>

      {/* the reading mark, fixed at mid-screen */}
      <div className="absolute top-1/2 right-0 flex -translate-y-1/2 items-center">
        <span
          className="h-0 w-0 border-y-[4px] border-l-0 border-r-[6px] border-y-transparent"
          style={{ borderRightColor: ACCENT }}
        />
        <span className="h-px w-5" style={{ backgroundColor: ACCENT }} />
      </div>
    </div>
  );
}
