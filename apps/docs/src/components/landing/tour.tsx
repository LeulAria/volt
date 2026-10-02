import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ComponentType, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { AgentStage, EditorStage } from "./agentShowcase";
import { BrowserStage } from "./browserComment";
import { COLUMN } from "./geometry";
import { EASE_OUT, HEADING_INSET, SectionHeading } from "./primitives";
import { SplitStage } from "./splitEditor";
import { SunsetScene } from "./sunsetScene";

const CHAPTERS: {
  id: string;
  tab: string;
  hint: string;
  title: string;
  body: string;
  Stage: ComponentType;
}[] = [
  {
    id: "agent",
    tab: "Agent",
    hint: "Chats first",
    title: "Agent + IDE.",
    body: "Volt integrates the agent and the IDE into one. Highly inspired by Cursor, Volt is an open-source agentic development environment.",
    Stage: AgentStage,
  },
  {
    id: "editor",
    tab: "Editor",
    hint: "Code first",
    title: "Or keep the code up front.",
    body: "Flip to the editor layout and the same chat docks beside your files, tabs, and terminal. Nothing about the conversation changes.",
    Stage: EditorStage,
  },
  {
    id: "edits",
    tab: "Edits",
    hint: "Streaming diffs",
    title: "Watch every edit land.",
    body: "Open any file next to the conversation. Edits stream into the editor as the agent writes them, marked in the gutter until you keep them.",
    Stage: SplitStage,
  },
  {
    id: "browser",
    tab: "Browser",
    hint: "Point and comment",
    title: "Say what should change.",
    body: "Click any element in your running app and leave a comment. The agent gets the element, its source location, and your note, then edits the code while the page updates.",
    Stage: BrowserStage,
  },
];

const N = CHAPTERS.length;
/** Scroll distance each chapter holds the screen for, in viewport heights. */
const HOLD_VH = 80;
/** The tallest window (the editor screenshot) sets the slot's shape. */
const SLOT_RATIO = 1.55;

const TITLE =
  "text-balance text-[32px] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:text-[44px] lg:text-[54px]";
const BODY =
  "text-pretty text-[15px] leading-[1.65] text-white/55 md:text-[16px]";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The product tour. On wide screens one window stays pinned while four chapters scroll past:
 * the copy slides through a mask, the window swaps to the next demo, and the dusk landscape
 * behind it turns to sunrise as you go. Smaller screens get the chapters stacked.
 */
export function Tour() {
  return (
    <>
      <PinnedTour />
      <StackedTour />
    </>
  );
}

function PinnedTour() {
  const root = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const [dir, setDir] = useState(1);
  const activeRef = useRef(0);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      // chapter index and the tab rules follow the scroll position
      mm.add("(min-width: 1024px)", () => {
        const fills = gsap.utils.toArray<HTMLElement>(
          "[data-fill]",
          root.current,
        );
        ScrollTrigger.create({
          trigger: root.current,
          start: "top top",
          end: "bottom bottom",
          onUpdate: (self) => {
            const p = self.progress * N;
            fills.forEach((el, i) => {
              el.style.transform = `scaleX(${clamp01(p - i)})`;
            });
            const next = Math.min(N - 1, Math.floor(p));
            if (next !== activeRef.current) {
              setDir(next > activeRef.current ? 1 : -1);
              activeRef.current = next;
              setActive(next);
            }
          },
        });
      });

      // sunrise across the whole section, and the window rising into place on the way in
      mm.add(`(min-width: 1024px) and (not ${REDUCED})`, () => {
        const scene = backdrop.current;
        if (!scene) return;
        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: root.current,
            start: "top bottom",
            end: "bottom bottom",
            scrub: 0.8,
          },
        });
        tl.fromTo(scene.querySelector("[data-sun]"), { y: 300 }, { y: -40 }, 0)
          .fromTo(
            scene.querySelector("[data-dawn]"),
            { opacity: 0 },
            { opacity: 0.62 },
            0,
          )
          .fromTo(
            scene.querySelector("[data-stars]"),
            { opacity: 1 },
            { opacity: 0 },
            0,
          );
        for (const layer of gsap.utils.toArray<SVGElement>(
          "[data-depth]",
          scene,
        )) {
          const depth = Number(layer.dataset.depth);
          tl.fromTo(layer, { y: depth * 14 }, { y: -depth * 6 }, 0);
        }

        gsap.fromTo(
          "[data-rise]",
          { y: 140, scale: 0.9, rotateX: 16, transformOrigin: "50% 0%" },
          {
            y: 0,
            scale: 1,
            rotateX: 0,
            ease: "none",
            scrollTrigger: {
              trigger: root.current,
              start: "top bottom",
              end: "top top",
              scrub: 0.6,
            },
          },
        );
      });
    },
    { scope: root },
  );

  /** Scroll to the start of a chapter; the scroll position is what picks the chapter. */
  function go(i: number) {
    const el = root.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const travel = el.offsetHeight - window.innerHeight;
    window.scrollTo({ top: top + travel * ((i + 0.08) / N) });
  }

  const chapter = CHAPTERS[active];
  const copyEase = reduce
    ? { duration: 0 }
    : { duration: 0.75, ease: EASE_OUT };
  const stageEase = reduce
    ? { duration: 0 }
    : { duration: 0.7, ease: EASE_OUT };

  return (
    <section
      ref={root}
      id="demo"
      aria-label="Product tour"
      className="relative hidden lg:block"
      style={{ height: `${100 + N * HOLD_VH}vh` }}
    >
      <div className="sticky top-0 flex h-svh flex-col overflow-hidden">
        <div
          ref={backdrop}
          aria-hidden
          className="tour-backdrop pointer-events-none absolute inset-0"
        >
          <SunsetScene className="absolute inset-0 size-full" />
        </div>

        <div
          className={cn(
            COLUMN,
            "relative z-10 flex min-h-0 flex-1 flex-col pt-[max(4.5rem,10vh)] pb-7",
          )}
        >
          <div
            className={cn(
              "grid grid-cols-12 items-end gap-10 pr-8",
              HEADING_INSET,
            )}
          >
            <div className="col-span-7 grid overflow-hidden pb-[0.1em]">
              {CHAPTERS.map((c) => (
                <div
                  key={c.id}
                  aria-hidden
                  className={cn(TITLE, "invisible [grid-area:1/1]")}
                >
                  {c.title}
                </div>
              ))}
              <AnimatePresence initial={false} custom={dir}>
                <motion.h2
                  key={chapter.id}
                  custom={dir}
                  initial={{ y: dir > 0 ? "110%" : "-110%" }}
                  animate={{ y: "0%" }}
                  exit={{ y: dir > 0 ? "-110%" : "110%" }}
                  transition={copyEase}
                  className={cn(
                    TITLE,
                    "flex flex-col justify-end [grid-area:1/1]",
                  )}
                >
                  {chapter.title}
                </motion.h2>
              </AnimatePresence>
            </div>
            <div className="col-span-5 grid pb-1.5">
              {CHAPTERS.map((c) => (
                <p
                  key={c.id}
                  aria-hidden
                  className={cn(BODY, "invisible [grid-area:1/1]")}
                >
                  {c.body}
                </p>
              ))}
              <AnimatePresence initial={false}>
                <motion.p
                  key={chapter.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: { ...copyEase, delay: reduce ? 0 : 0.12 },
                  }}
                  exit={{ opacity: 0, y: -8, transition: { duration: 0.25 } }}
                  className={cn(BODY, "self-end [grid-area:1/1]")}
                >
                  {chapter.body}
                </motion.p>
              </AnimatePresence>
            </div>
          </div>

          <div className="relative mt-8 flex min-h-0 flex-1 flex-col items-center justify-center [perspective:1800px]">
            <div
              data-rise
              className="w-full"
              style={{
                maxWidth: `min(1120px, calc((100svh - 320px) * ${SLOT_RATIO}))`,
              }}
            >
              <div
                className="relative"
                style={{ aspectRatio: `${SLOT_RATIO}` }}
              >
                <AnimatePresence initial={false} custom={dir}>
                  <motion.div
                    key={chapter.id}
                    className="absolute inset-0 flex items-center"
                    initial={{
                      opacity: 0,
                      y: 48 * dir,
                      scale: 0.97,
                      filter: "blur(8px)",
                    }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      scale: 1,
                      filter: "blur(0px)",
                    }}
                    exit={{
                      opacity: 0,
                      y: -32 * dir,
                      scale: 0.98,
                      filter: "blur(6px)",
                    }}
                    transition={stageEase}
                  >
                    <div className="w-full">
                      <chapter.Stage />
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>

              <div
                role="tablist"
                aria-label="Tour chapters"
                className="mt-6 grid grid-cols-4 gap-5"
              >
                {CHAPTERS.map((c, i) => {
                  const on = i === active;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => go(i)}
                      className="group rounded-[3px] text-left outline-none focus-visible:ring-1 focus-visible:ring-white/50 focus-visible:ring-offset-4 focus-visible:ring-offset-black"
                    >
                      <span className="relative block h-px overflow-hidden bg-white/15">
                        <span
                          data-fill
                          className="absolute inset-0 origin-left bg-white"
                          style={{ transform: "scaleX(0)" }}
                        />
                      </span>
                      <span className="mt-3 flex items-baseline justify-between gap-3">
                        <span
                          className={cn(
                            "text-[13.5px] font-medium transition-colors duration-300",
                            on
                              ? "text-white"
                              : "text-white/45 group-hover:text-white/80",
                          )}
                        >
                          {c.tab}
                        </span>
                        <span
                          className={cn(
                            "truncate font-mono text-[10.5px] tracking-[0.12em] uppercase transition-colors duration-300",
                            on ? "text-white/55" : "text-white/25",
                          )}
                        >
                          {c.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Below `lg` there's no room to pin, so each chapter is a heading and its window. */
function StackedTour() {
  return (
    <section aria-label="Product tour" className="lg:hidden">
      {CHAPTERS.map(({ id, title, body, Stage }) => (
        <div key={id} className={cn(COLUMN, "pt-24")}>
          <SectionHeading title={title} body={body} />
          <div className="mt-10">
            <Stage />
          </div>
        </div>
      ))}
    </section>
  );
}
