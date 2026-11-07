import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { COLUMN } from "./geometry";
import { Reveal, SectionHeading } from "./primitives";

/** The same window three ways, from a lone prompt to everything at once. */
const STAGES = [
  {
    id: "prompt",
    label: "Just a prompt",
    body: "A project, a branch, a model and the prompt. Nothing else on screen.",
    src: "/scale/simple.webp",
    width: 1600,
    height: 1004,
    alt: "Volt with only a new agent's prompt: the project, branch, This Mac and Full access pickers, the model, and Plan New Idea and Multitask",
  },
  {
    id: "tools",
    label: "Tools beside it",
    body: "Files, a terminal, a browser, a device and more open beside the chat, each one shortcut away.",
    src: "/scale/tools.webp",
    width: 1600,
    height: 1004,
    alt: "A new agent's prompt beside the panel that opens a file, terminal, browser, device, changes, Git Graph, scratch, canvas, automations or a side chat, each with its shortcut",
  },
  {
    id: "everything",
    label: "Everything at once",
    body: "Every agent in the sidebar, subagents at work, a queue, a pull request and source control in one window.",
    src: "/scale/everything.webp",
    width: 1600,
    height: 1004,
    alt: "Volt with everything open: the agents sidebar, a running chat with its code changes, task list and a queued message, and source control with the changes, agent turns and commit graph",
  },
] as const;

/** How long each stage holds the window before the next tab takes over. */
const ADVANCE_MS = 6000;

/**
 * Simple to complex: one large window at three stages, picked from the tabs above it. As in the
 * feature index, the active tab's rule fills over its turn and hands off to the next, until a tab
 * is picked; pointer or focus on the tabs holds the current stage.
 */
export function WorkspaceScale() {
  const block = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const inView = useInView(block, { margin: "-15%" });
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);
  // a picked tab hands the window to the reader, so it stops moving on by itself
  const [picked, setPicked] = useState(false);
  const running = inView && !held;

  // pointer over, or focus inside, the tabs holds the current stage; the window is too big to
  // count, or a pointer resting on it while the page scrolls would stop the turns
  useEffect(() => {
    const el = tabs.current;
    if (!el) return;
    const hold = () => setHeld(true);
    const release = () => setHeld(false);
    const blur = (event: FocusEvent) => {
      if (!el.contains(event.relatedTarget as Node | null)) release();
    };
    el.addEventListener("pointerenter", hold);
    el.addEventListener("pointerleave", release);
    el.addEventListener("focusin", hold);
    el.addEventListener("focusout", blur);
    return () => {
      el.removeEventListener("pointerenter", hold);
      el.removeEventListener("pointerleave", release);
      el.removeEventListener("focusin", hold);
      el.removeEventListener("focusout", blur);
    };
  }, []);

  return (
    <section
      aria-label="As simple or as complex as you need"
      // opaque so the column guides stop at this section
      className={cn(
        COLUMN,
        "relative bg-[#0a0d0c] pt-24 pb-10 md:pt-32 md:pb-12",
      )}
    >
      <SectionHeading
        title={
          <>
            As simple as it gets.
            <br />
            <span className="text-white/40">As complex as you need.</span>
          </>
        }
        body="Start with a prompt and nothing else. Open tools beside it when the work calls for them, or keep every agent, subagent and change in view at once."
      />
      <Reveal className="mt-14 md:mt-20">
        <div ref={block}>
          <div
            ref={tabs}
            role="tablist"
            aria-label="Volt, from simple to complex"
            className="grid gap-x-6 md:grid-cols-3"
          >
            {STAGES.map((stage, index) => {
              const on = index === active;
              return (
                <div
                  key={stage.id}
                  className="relative border-t border-white/[0.08]"
                >
                  {on ? (
                    <span
                      key={`fill-${active}`}
                      aria-hidden
                      onAnimationEnd={() =>
                        setActive((index + 1) % STAGES.length)
                      }
                      // once a tab is picked, its rule just stays full
                      className={cn(
                        "absolute -top-px left-0 h-px w-full bg-[#ff8a5a]",
                        !picked && "demo-progress",
                      )}
                      style={
                        picked
                          ? undefined
                          : {
                              animationDuration: `${ADVANCE_MS}ms`,
                              animationPlayState: running
                                ? "running"
                                : "paused",
                            }
                      }
                    />
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    id={`scale-tab-${stage.id}`}
                    aria-selected={on}
                    aria-controls="scale-stage"
                    // named by its title, with the sentence under it as the description
                    aria-labelledby={`scale-label-${stage.id}`}
                    aria-describedby={`scale-body-${stage.id}`}
                    onClick={() => {
                      setActive(index);
                      setPicked(true);
                    }}
                    className="group w-full cursor-pointer rounded-[3px] pt-5 pb-6 text-left outline-none focus-visible:ring-1 focus-visible:ring-white/40 md:pb-8"
                  >
                    <span
                      id={`scale-label-${stage.id}`}
                      className={cn(
                        "flex items-center gap-3 text-[17px] font-medium tracking-[-0.01em] transition-colors duration-500",
                        on
                          ? "text-white"
                          : "text-white/55 group-hover:text-white/80",
                      )}
                    >
                      <span className="text-[13px] tabular-nums text-[#ff8a5a]">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      {stage.label}
                    </span>
                    <span
                      id={`scale-body-${stage.id}`}
                      className={cn(
                        "mt-2 block max-w-md text-pretty text-[14px] leading-[1.6] transition-colors duration-500",
                        on ? "text-white/65" : "text-white/50",
                      )}
                    >
                      {stage.body}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* the window on the hero's photo, as on a desktop, so the dark UI stands off the page */}
          <div
            id="scale-stage"
            role="tabpanel"
            aria-labelledby={`scale-label-${STAGES[active].id}`}
            className="relative overflow-hidden rounded-[20px] px-[8%] pt-[6%] ring-1 ring-white/[0.08]"
          >
            <img
              src="/hero-backdrop.webp"
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              className="absolute inset-0 size-full select-none object-cover object-[50%_60%]"
            />
            {/* the three windows share one cell and cross-fade, so a switch never waits on a load */}
            <div className="relative grid overflow-hidden rounded-t-[12px] shadow-[0_24px_48px_rgba(0,0,0,0.6)] ring-1 ring-white/[0.14]">
              {STAGES.map((stage, index) => (
                <img
                  key={stage.id}
                  src={stage.src}
                  alt={stage.alt}
                  aria-hidden={index !== active}
                  width={stage.width}
                  height={stage.height}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className={cn(
                    "col-start-1 row-start-1 aspect-[16/10] w-full object-cover object-top transition-opacity duration-700 ease-out motion-reduce:transition-none",
                    index === active ? "opacity-100" : "opacity-0",
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
