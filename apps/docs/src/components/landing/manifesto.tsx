import { useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, SplitText, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";

/** One large statement that lights up word by word as it scrolls through the viewport. */
export function Manifesto() {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const text = ref.current?.querySelector("[data-manifesto]");
      if (!text) return;
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        const split = SplitText.create(text, { type: "words" });
        gsap.fromTo(
          split.words,
          { opacity: 0.16 },
          {
            opacity: 1,
            ease: "none",
            stagger: 0.12,
            scrollTrigger: {
              trigger: text,
              start: "top 78%",
              end: "bottom 42%",
              scrub: true,
            },
          },
        );
        return () => split.revert();
      });
    },
    { scope: ref },
  );

  return (
    <section
      ref={ref}
      aria-label="What Volt is"
      className={cn(COLUMN, "relative py-28 md:py-44")}
    >
      <p
        data-manifesto
        className={cn(
          "mx-auto max-w-[1080px] text-balance text-center relative text-[22px] font-semibold leading-[1.2] tracking-[-0.03em] text-white sm:text-[30px] md:text-[40px]",
        )}
      >
        Volt is an open-source workspace where agents do the typing and you keep
        the judgment.{" "}
        <span className="text-[#ff8a5a]">
          Chats, code, Git, a browser, and a terminal
        </span>{" "}
        share one window, so nothing you need is a tab away.
      </p>
    </section>
  );
}
