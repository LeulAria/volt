import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { AgentStage, type Mode, ModeSwitch } from "./agentShowcase";
import { BrowserStage } from "./browserComment";
import { COLUMN } from "./geometry";
import { EASE_OUT, HEADING_INSET } from "./primitives";
import { SplitStage } from "./splitEditor";

const SLIDE_MS = 10000;

const AGENT = {
  title: "Agent + IDE.",
  body: "Volt integrates the agent and the IDE into one. Highly inspired by Cursor, Volt is an open-source agentic development environment.",
} as const;

const SLIDES = [
  {
    id: "editor",
    title: "Watch every edit land.",
    body: "Open any file next to the conversation. Edits stream into the editor as the agent writes them, marked in the gutter until you keep them.",
  },
  {
    id: "browser",
    title: "Say what should change.",
    body: "Click any element in your running app and leave a comment. The agent gets the element, its source location, and your note, then edits the code while the page updates.",
  },
] as const;

type SlideId = (typeof SLIDES)[number]["id"];

const textVariants = {
  enter: (dir: number) => ({ opacity: 0, y: dir > 0 ? 18 : -18 }),
  center: { opacity: 1, y: 0 },
  exit: (dir: number) => ({ opacity: 0, y: dir > 0 ? -14 : 14 }),
};

const stageVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir > 0 ? 36 : -36 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir > 0 ? -36 : 36 }),
};

/** Agent showcase alone, then a two-slide carousel for editor + browser. */
export function Demos() {
  const [mode, setMode] = useState<Mode>("agent");

  return (
    <>
      <section
        id="demo"
        aria-label="Agent and IDE"
        className={cn(COLUMN, "relative pt-24 md:pt-32")}
      >
        <div className={cn("relative max-w-2xl", HEADING_INSET)}>
          <h2 className="text-balance text-[32px] font-semibold leading-[1.05] tracking-[-0.03em] text-white sm:text-[44px] md:text-[52px]">
            {AGENT.title}
          </h2>
          <p className="mt-6 max-w-xl text-pretty text-[15px] leading-[1.65] text-white/50 md:text-[17px]">
            {AGENT.body}
          </p>
          <div className="mt-7">
            <ModeSwitch mode={mode} onMode={setMode} />
          </div>
        </div>

        <div className="relative mx-auto mt-12 w-full max-w-[1080px] md:mt-14">
          <AgentStage mode={mode} plain />
        </div>
      </section>

      <DemoCarousel />
    </>
  );
}

function DemoCarousel() {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const slide = SLIDES[index];

  useEffect(() => {
    if (reduce) return;
    const id = window.setTimeout(() => {
      setDir(1);
      setIndex((index + 1) % SLIDES.length);
    }, SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [index, reduce]);

  function go(next: number) {
    if (next === index) return;
    setDir(next > index ? 1 : -1);
    setIndex(next);
  }

  const textEase = reduce
    ? { duration: 0 }
    : {
        y: { duration: 0.4, ease: EASE_OUT },
        opacity: { duration: 0.28, ease: EASE_OUT },
      };
  const stageEase = reduce
    ? { duration: 0 }
    : {
        x: { duration: 0.5, ease: EASE_OUT },
        opacity: { duration: 0.3, ease: EASE_OUT },
      };

  return (
    <section
      aria-label="Editor and browser demos"
      className={cn(COLUMN, "relative pt-24 md:pt-32")}
    >
      <div className={cn("relative max-w-2xl", HEADING_INSET)}>
        <AnimatePresence initial={false} custom={dir} mode="wait">
          <motion.div
            key={slide.id}
            custom={dir}
            variants={textVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={textEase}
          >
            <h2 className="text-balance text-[32px] font-semibold leading-[1.05] tracking-[-0.03em] text-white sm:text-[44px] md:text-[52px]">
              {slide.title}
            </h2>
            <p className="mt-6 max-w-xl text-pretty text-[15px] leading-[1.65] text-white/50 md:text-[17px]">
              {slide.body}
            </p>
          </motion.div>
        </AnimatePresence>

        <div
          role="tablist"
          aria-label="Choose a demo"
          className="mt-6 flex items-center gap-2"
        >
          {SLIDES.map((item, i) => {
            const active = i === index;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={item.title}
                onClick={() => go(i)}
                className={cn(
                  "relative h-[3px] overflow-hidden rounded-full bg-white/15 transition-[width] duration-500",
                  active ? "w-14" : "w-5 hover:bg-white/30",
                )}
              >
                {active && !reduce ? (
                  <span
                    className="demo-progress absolute inset-y-0 left-0 w-full bg-white"
                    style={{ animationDuration: `${SLIDE_MS}ms` }}
                  />
                ) : null}
                {active && reduce ? (
                  <span className="absolute inset-0 bg-white" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative mx-auto mt-10 w-full max-w-[1080px] md:mt-12">
        <AnimatePresence initial={false} custom={dir} mode="wait">
          <motion.div
            key={slide.id}
            custom={dir}
            variants={stageVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stageEase}
          >
            <CarouselStage id={slide.id} />
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

function CarouselStage({ id }: { id: SlideId }) {
  switch (id) {
    case "editor":
      return <SplitStage />;
    case "browser":
      return <BrowserStage />;
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}
