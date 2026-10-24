import { ChevronLeft, ChevronRight } from "lucide-react";
import { useInView, useReducedMotion } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { COLUMN } from "./geometry";
import { Reveal } from "./primitives";

type Shot = {
  src: string;
  alt: string;
  /** Which part of the screenshot stays in the square frame. */
  position: CSSProperties["objectPosition"];
};

const CARDS: {
  title: string;
  badge?: string;
  body: string;
  shot: Shot;
}[] = [
  {
    title: "Visible",
    body: "Each change, each turn, each subagent. Every file sits under the turn that changed it, with the lines it added and removed.",
    shot: {
      src: "/showcase/agent-turns.png",
      alt: "Volt's Agent turns tree: a turn that ran three subagents, each listing the files it changed with their line counts",
      position: "top",
    },
  },
  {
    title: "Orchestrator",
    badge: "Subagents",
    body: "The agent that orchestrates. It splits the work into tasks, hands them to subagents, and checks each one off as it lands.",
    shot: {
      src: "/showcase/orchestrator.png",
      alt: "Volt's Tasks card above the composer, with five tasks done, one in progress, and six subagents running",
      position: "left bottom",
    },
  },
  {
    title: "In parallel",
    body: "Agents run side by side. Each one keeps its model, status, and run time, and a click opens its chat beside yours.",
    shot: {
      src: "/showcase/previous-agents.png",
      alt: "Volt's Previous agents list with a subagent's hover card: its model, that it failed after 37 minutes, and a link to watch its chat",
      position: "center",
    },
  },
  {
    title: "Every model",
    body: "Claude, GPT, Gemini, Grok, or a local model in one picker. Tune context and effort per chat, and switch mid-conversation.",
    shot: {
      src: "/showcase/model-picker.png",
      alt: "Volt's model picker: provider tabs over a list of Claude models, with Sonnet 5.5 High checked, next to the context and effort menu",
      position: "center",
    },
  },
  {
    title: "Usage insights",
    body: "Track where your tokens and spend go. Tokens per day by kind, how much came from cache, and each model's share of the bill.",
    shot: {
      src: "/showcase/usage-insights.png",
      alt: "Volt's usage charts: tokens per day by kind with a tooltip for Oct 2, and each model's share of spend per day",
      position: "left top",
    },
  },
  {
    title: "Skills",
    badge: "skills.sh",
    body: "Find any skill from skills.sh, plus plugins and MCP servers, in one search. Add one in a click and every agent can use it.",
    shot: {
      src: "/showcase/skills.png",
      alt: "Volt's skills browser: a search for plugins, skills and MCPs, a Discover row, and the popular skills on skills.sh with Add buttons",
      position: "left top",
    },
  },
  {
    title: "Automations",
    body: "Automate workflows. Start an agent on a schedule, a webhook, or an event from GitHub, GitLab, Slack, Linear, Jira, or Sentry.",
    shot: {
      src: "/showcase/automations.png",
      alt: "Volt's automation trigger menu: Scheduled, GitHub, GitLab, Slack, Microsoft Teams, Sentry, Linear, Jira and more, with GitHub's pull request events open",
      position: "left top",
    },
  },
  {
    title: "Accounts",
    badge: "Auto switch",
    body: "Sign in to several Claude accounts and see each one's session and weekly usage. Near a limit, Volt switches to the one with the most left.",
    shot: {
      src: "/showcase/accounts.png",
      alt: "Volt's Claude accounts settings: two accounts with session and weekly usage bars, and Switch automatically turned on at 90% used",
      position: "left top",
    },
  },
];

/** Product screenshot in a square frame, cropped to the part that tells the story. */
function ShotFrame({ shot, className }: { shot: Shot; className?: string }) {
  return (
    <img
      src={shot.src}
      alt={shot.alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn(
        "aspect-square w-full rounded-[14px] object-cover ring-1 ring-white/[0.07]",
        className,
      )}
      style={{ objectPosition: shot.position }}
    />
  );
}

const CARD = "rounded-[30px] bg-[#161616] p-[5px]";
const PANEL = "rounded-[25px] bg-[#0c0e0d]";
const CARD_TITLE =
  "text-[21px] font-medium leading-[1.2] tracking-[-0.01em] text-[#f9fbfa] md:text-[25px]";
const CARD_BODY =
  "text-pretty text-[15px] leading-[1.7] text-[#8c8e8d] md:text-[16px] md:leading-[29px]";
const GAP = 21;
/** How long each card holds before the row moves on by itself. */
const ADVANCE_MS = 2000;

/** What the agent window shows while agents work, as a row of framed cards that scrolls sideways. */
export function AgentShowcase() {
  const track = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // one card per step; snapping settles it on the card edge, and past the last card it wraps
  const step = useCallback((dir: 1 | -1) => {
    const el = track.current;
    const card = el?.querySelector("article");
    if (!el || !card) return;
    if (dir === 1 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1) {
      el.scrollTo({ left: 0, behavior: "smooth" });
      return;
    }
    el.scrollBy({ left: dir * (card.clientWidth + GAP), behavior: "smooth" });
  }, []);

  // advances on its own while on screen; a button press restarts the wait. Hover and focus are read on
  // each tick rather than tracked through enter/leave events, which miss a pointer that was already
  // resting there when the page scrolled the row under it.
  const carousel = useRef<HTMLDivElement>(null);
  const inView = useInView(track, { margin: "-20%" });
  const reduce = useReducedMotion();
  const [presses, setPresses] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: presses only restarts the interval
  useEffect(() => {
    if (!inView || reduce) return;
    const id = setInterval(() => {
      const root = carousel.current;
      // :focus-visible so keyboard focus holds it but a clicked arrow button doesn't
      if (
        !root ||
        root.matches(":hover") ||
        root.querySelector(":focus-visible")
      )
        return;
      step(1);
    }, ADVANCE_MS);
    return () => clearInterval(id);
  }, [inView, reduce, step, presses]);

  const press = (dir: 1 | -1) => {
    step(dir);
    setPresses((n) => n + 1);
  };

  return (
    <section
      aria-label="Agents, in the open"
      // opaque so the column guides stop at this section; the cards draw their own edges
      className={cn(COLUMN, "relative bg-[#0a0d0c] py-24 md:py-32")}
    >
      <div ref={carousel} className="mx-auto max-w-[960px]">
        <div className="flex items-end justify-between gap-6 pl-2 md:pl-[31px]">
          <div>
            <p className="text-[15px] leading-[1.2] text-[#949695] md:text-[18px]">
              Agents, in the open
            </p>
            <h2 className="mt-2.5 text-balance text-[22px] font-medium leading-[1.2] tracking-[-0.01em] text-[#f7f9f8] md:mt-[14px] md:text-[26px]">
              Watch every agent work, start to finish
            </h2>
          </div>
          <div className="flex shrink-0 gap-2">
            <CarouselButton
              label="Previous"
              disabled={edges.start}
              onClick={() => press(-1)}
            >
              <ChevronLeft className="size-[18px]" strokeWidth={1.75} />
            </CarouselButton>
            <CarouselButton
              label="Next"
              disabled={edges.end}
              onClick={() => press(1)}
            >
              <ChevronRight className="size-[18px]" strokeWidth={1.75} />
            </CarouselButton>
          </div>
        </div>

        <Reveal className="mt-8 md:mt-[43px]">
          <section
            ref={track}
            onScroll={measure}
            aria-label="Agent window screenshots"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets the arrow keys scroll it
            tabIndex={0}
            className="flex snap-x snap-mandatory gap-[21px] overflow-x-auto overscroll-x-contain rounded-[30px] outline-none [scrollbar-width:none] focus-visible:ring-1 focus-visible:ring-white/30 [&::-webkit-scrollbar]:hidden"
          >
            {CARDS.map((card) => (
              <article
                key={card.title}
                className={cn(
                  CARD,
                  // the last card snaps by its end, or the final step lands past the end of the track
                  "flex w-[85%] shrink-0 snap-start flex-col gap-[5px] last:snap-end md:w-[calc((100%-21px)/2)]",
                )}
              >
                <div
                  className={cn(
                    PANEL,
                    "flex-1 px-6 pt-6 pb-6 md:px-[32px] md:pt-[28px] md:pb-[28px]",
                  )}
                >
                  <h3
                    className={cn(
                      CARD_TITLE,
                      "flex min-h-7 items-center gap-[16px] md:min-h-[34px]",
                    )}
                  >
                    {card.title}
                    {card.badge ? (
                      <span className="inline-flex h-6 items-center rounded-full bg-[#0099ff] px-2.5 text-[12.5px] font-medium tracking-normal text-white md:h-[26px] md:px-3 md:text-[13.5px]">
                        {card.badge}
                      </span>
                    ) : null}
                  </h3>
                  <p className={cn(CARD_BODY, "mt-2.5 md:mt-[13px]")}>
                    {card.body}
                  </p>
                </div>

                <div className={cn(PANEL, "p-4 md:p-[27px]")}>
                  <ShotFrame shot={card.shot} />
                </div>
              </article>
            ))}
          </section>
        </Reveal>
      </div>
    </section>
  );
}

function CarouselButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-10 place-items-center rounded-full bg-[#161616] text-white/80 outline-none transition-[background-color,opacity] hover:bg-[#1f1f1f] focus-visible:ring-1 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}
