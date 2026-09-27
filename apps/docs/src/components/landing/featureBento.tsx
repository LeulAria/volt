import {
  Check,
  ChevronRight,
  Clock3,
  GitBranch,
  Search,
  Settings,
  Star,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type PointerEvent, type ReactNode, useRef } from "react";
import { cn } from "@/lib/cn";
import { type BrandId, BrandIcon, brandLabel } from "./brandIcons";
import { gsap, REDUCED, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";
import { SectionHeading, Spinner, span, useLoopClock } from "./primitives";

export function FeatureBento() {
  const ref = useRef<HTMLElement>(null);

  // cards rise in small batches as the grid scrolls up, like plates being laid down
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        const cards = gsap.utils.toArray<HTMLElement>(
          "[data-card]",
          ref.current,
        );
        gsap.set(cards, { autoAlpha: 0, y: 64 });
        ScrollTrigger.batch(cards, {
          start: "top 90%",
          once: true,
          onEnter: (batch) =>
            gsap.to(batch, {
              autoAlpha: 1,
              y: 0,
              stagger: 0.12,
              duration: 1.4,
              overwrite: true,
            }),
        });
      });
    },
    { scope: ref },
  );

  return (
    <section
      ref={ref}
      id="features"
      className={cn(COLUMN, "relative pt-24 md:pt-32")}
    >
      <SectionHeading
        chapter={{ index: 3, name: "Loop" }}
        title={
          <>
            The whole loop,
            <br />
            <span className="text-white/40">without the tab-switching.</span>
          </>
        }
        body="Models, Git, terminal, and background agents live in the same window as your chats, so every step from idea to pushed commit stays in one place."
      />

      <div className="mt-14 grid grid-cols-1 gap-4 md:mt-20 md:grid-cols-6">
        <Card
          className="md:col-span-4"
          fig="3.1"
          title="Every frontier model, one picker."
          body="Switch between Claude, GPT, Gemini, Grok, or a local model mid-conversation. Tune effort, context, and speed per chat."
        >
          <ModelPickerArt />
        </Card>
        <Card
          className="md:col-span-2"
          fig="3.2"
          title="Git, handled."
          body="Volt stages, writes the commit message, and pushes. You review."
        >
          <GitArt />
        </Card>
        <Card
          className="md:col-span-2"
          fig="3.3"
          title="A real terminal."
          body="Agents run your scripts in a shell you can watch and take over."
        >
          <TerminalArt />
        </Card>
        <Card
          className="md:col-span-2"
          fig="3.4"
          title="Agents in parallel."
          body="Each task gets its own worktree, so runs never step on each other."
        >
          <ParallelArt />
        </Card>
        <Card
          className="md:col-span-2"
          fig="3.5"
          title="Automations."
          body="Schedule agents to triage issues, bump deps, or write the changelog."
        >
          <AutomationsArt />
        </Card>
      </div>
    </section>
  );
}

function Card({
  title,
  body,
  children,
  className,
  fig,
}: {
  title: string;
  body: string;
  children: ReactNode;
  className?: string;
  fig: string;
}) {
  function onMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty(
      "--mx",
      `${event.clientX - rect.left}px`,
    );
    event.currentTarget.style.setProperty(
      "--my",
      `${event.clientY - rect.top}px`,
    );
  }

  return (
    <div data-card className={className}>
      <div
        onPointerMove={onMove}
        className="bento-card group relative flex h-full min-h-[420px] flex-col overflow-hidden rounded-[22px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-colors duration-300 hover:border-white/[0.14]"
      >
        <span className="absolute top-7 right-7 z-10 font-mono text-[10px] tracking-[0.14em] text-white/25 uppercase">
          fig. {fig}
        </span>
        <div className="relative z-10 p-7 pb-0">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-white">
            {title}
          </h3>
          <p className="mt-1.5 max-w-md text-pretty text-[14px] leading-relaxed text-white/45">
            {body}
          </p>
        </div>
        <div className="relative mt-6 flex min-h-0 flex-1 items-end">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Model picker                                                        */
/* ------------------------------------------------------------------ */

type PickerTab = {
  id: BrandId;
  models: string[];
  /** Model the check sits on while this tab is showing. */
  picked: number;
};

const PICKER_TABS: PickerTab[] = [
  {
    id: "claude",
    picked: 0,
    models: [
      "Opus 5.5 Medium Fast",
      "Sonnet 5 High",
      "Fable 5.1 High",
      "Haiku 4.5",
      "Opus 5 High",
      "Fable 5 High",
      "Opus 4.8 High",
      "Sonnet 4.6 High",
    ],
  },
  {
    id: "codex",
    picked: 1,
    models: [
      "GPT 5.6 Sol High",
      "GPT 5.6 Sol Medium",
      "GPT 5.5 Codex High",
      "GPT 5.5 Medium",
      "GPT 5.5 Mini",
    ],
  },
  {
    id: "antigravity",
    picked: 0,
    models: [
      "Gemini 3 Pro High",
      "Gemini 3 Pro Medium",
      "Gemini 3 Flash",
      "Gemini 3 Flash Lite",
    ],
  },
  {
    id: "cursor",
    picked: 0,
    models: ["Composer 2.5 Fast", "Composer 2.5", "Auto"],
  },
  {
    id: "grok",
    picked: 0,
    models: [
      "Grok 4.6 Extra High Fast",
      "Grok 4.6 High",
      "Grok 4.5 High Fast",
      "Grok Code Fast 2",
    ],
  },
];
const TAB_MS = 2600;
const EFFORT = ["Low", "Medium", "High", "Extra High", "Max"];

function ModelPickerArt() {
  const { ref, t } = useLoopClock(TAB_MS * PICKER_TABS.length, TAB_MS - 1);
  const tabIndex = Math.floor(t / TAB_MS) % PICKER_TABS.length;
  const tab = PICKER_TABS[tabIndex];
  const local = t % TAB_MS;
  // the pointer drifts down the list, then settles back on the picked model
  const hover =
    local < 700
      ? tab.picked
      : local < 1900
        ? Math.min(
            tab.models.length - 1,
            Math.floor((local - 700) / 400) + tab.picked + 1,
          )
        : tab.picked;
  const effort = [1, 2, 3, 1, 3][tabIndex];
  const fast = tabIndex !== 1;

  return (
    <div
      ref={ref}
      className="relative flex w-full justify-end gap-2.5 overflow-hidden pr-0 pl-7 [mask-image:linear-gradient(180deg,#000_78%,transparent)] sm:pl-10"
    >
      <div className="mt-16 hidden w-[200px] shrink-0 self-start rounded-[12px] border border-white/10 bg-[#232323] py-1.5 text-[13px] shadow-[0_20px_50px_rgba(0,0,0,0.5)] sm:block">
        <MenuLabel>Options</MenuLabel>
        <div className="flex h-8 items-center px-3 text-white/90">
          Fast
          <span
            className={cn(
              "relative ml-auto h-[18px] w-[32px] rounded-full transition-colors duration-300",
              fast ? "bg-[#3ecf8e]" : "bg-white/20",
            )}
          >
            <span
              className={cn(
                "absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-[left] duration-300",
                fast ? "left-[16px]" : "left-[2px]",
              )}
            />
          </span>
        </div>
        <Divider />
        <MenuLabel>Context</MenuLabel>
        <MenuItem checked>200K</MenuItem>
        <MenuItem>1M</MenuItem>
        <Divider />
        <MenuLabel>Effort</MenuLabel>
        {EFFORT.map((e, i) => (
          <MenuItem key={e} checked={i === effort}>
            {e}
          </MenuItem>
        ))}
      </div>

      <div className="h-[372px] w-[330px] shrink-0 rounded-tl-[12px] border-t border-l border-white/10 bg-[#232323] text-[13px] shadow-[0_20px_50px_rgba(0,0,0,0.5)] sm:w-[360px]">
        <div className="flex h-11 items-center gap-2 border-b border-white/[0.07] px-3.5 text-white/35">
          <Search className="size-3.5" />
          Search models...
        </div>
        <div className="flex h-11 items-center gap-1 border-b border-white/[0.07] px-2 text-white/45">
          <span className="grid size-8 place-items-center">
            <Star className="size-4" />
          </span>
          {PICKER_TABS.map((p) => (
            <span
              key={p.id}
              title={brandLabel(p.id)}
              className={cn(
                "relative grid size-8 place-items-center transition-opacity duration-300",
                p.id === tab.id
                  ? "text-white opacity-100"
                  : "text-white/80 opacity-55",
              )}
            >
              <BrandIcon id={p.id} size={16} />
              {p.id === tab.id ? (
                <motion.span
                  layoutId="picker-tab"
                  className="absolute -bottom-[7px] left-1/2 h-[2px] w-5 -translate-x-1/2 rounded-full bg-white/70"
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              ) : null}
            </span>
          ))}
          <Settings className="mr-1.5 ml-auto size-4" />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab.id}
            className="py-1"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {tab.models.map((m, i) => (
              <div
                key={m}
                className={cn(
                  "mx-1 flex h-[34px] items-center rounded-md px-2.5 text-white/85 transition-colors duration-200",
                  i === hover && "bg-white/[0.07]",
                )}
              >
                {m}
                <span className="ml-auto flex items-center gap-3">
                  {i === tab.picked ? (
                    <Check className="size-4 text-white" />
                  ) : null}
                  <Star className="size-3.5 text-white/25" />
                </span>
              </div>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-1.5 pb-1 text-[12px] text-white/45">{children}</div>
  );
}

function MenuItem({
  children,
  checked,
}: {
  children: ReactNode;
  checked?: boolean;
}) {
  return (
    <div className="flex h-8 items-center px-3 text-white/90">
      {children}
      {checked ? <Check className="ml-auto size-3.5 text-white/80" /> : null}
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-white/[0.07]" />;
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

const COMMIT_MSG = "feat(api): rate limit /api/search to 60 req/min per IP";
const GIT_FILES: [string, string, string][] = [
  ["src/lib/rateLimit.ts", "+42", "A"],
  ["src/routes/api/search.ts", "+6 -1", "M"],
  ["test/api/search.test.ts", "+18", "M"],
];

function GitArt() {
  const { ref, t } = useLoopClock(8000, 6000);
  const typed = COMMIT_MSG.slice(
    0,
    Math.round(COMMIT_MSG.length * span(t, 900, 2400)),
  );
  const pushing = t > 3900 && t < 4900;
  const pushed = t >= 4900;

  return (
    <div ref={ref} className="w-full px-5 pb-5">
      <CommitGraph pushed={pushed} />
      <div className="rounded-[14px] border border-white/10 bg-[#161616] p-3 text-[12.5px] shadow-[0_20px_40px_rgba(0,0,0,0.4)]">
        <div className="mb-2.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/40">
          <GitBranch className="size-3.5" />
          feat/rate-limit
          <span className="ml-auto rounded-full bg-white/[0.07] px-1.5 font-mono text-[10px] tracking-normal text-white/60">
            3
          </span>
        </div>
        {GIT_FILES.map(([name, delta, badge]) => (
          <div key={name} className="flex h-7 items-center gap-2 px-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-white/75">
              {name}
            </span>
            <span className="font-mono text-[11px] text-[#3ecf8e]">
              {delta}
            </span>
            <span
              className={cn(
                "w-3 text-center font-mono text-[10.5px] font-semibold",
                badge === "A" ? "text-[#3ecf8e]" : "text-[#e2c08d]",
              )}
            >
              {badge}
            </span>
          </div>
        ))}
        <div className="mt-2.5 min-h-[58px] rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-white/85">
          {typed || (
            <span className="text-white/30">Message (⌘⏎ to commit)</span>
          )}
          {typed && typed.length < COMMIT_MSG.length ? (
            <span className="ml-px inline-block h-3 w-[1.5px] translate-y-[2px] bg-white/80" />
          ) : null}
        </div>
        <div className="mt-2.5 flex gap-2">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-white/60">
            <Star className="size-3" />
            Generate
          </span>
          <span
            className={cn(
              "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors duration-300",
              pushed ? "bg-[#3ecf8e]/15 text-[#3ecf8e]" : "bg-white text-black",
            )}
          >
            {pushed ? (
              <>
                <Check className="size-3.5" strokeWidth={2.5} /> Pushed
              </>
            ) : pushing ? (
              <>
                <Spinner className="size-3.5" /> Pushing
              </>
            ) : (
              "Commit & Push"
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

const HISTORY = [
  { msg: "fix(ui): titlebar drag region", sha: "a41c9e2" },
  { msg: "chore: bump electron to 38", sha: "7be03d1" },
];

/** Branch history above the commit box; the new commit slots in on push. */
function CommitGraph({ pushed }: { pushed: boolean }) {
  const rows = pushed
    ? [{ msg: COMMIT_MSG, sha: "e5610eb", fresh: true }, ...HISTORY]
    : HISTORY;
  return (
    <div className="mb-3 px-3">
      {rows.map((row, i) => {
        const fresh = "fresh" in row;
        const last = i === rows.length - 1;
        return (
          <div
            key={row.sha}
            className={cn(
              "flex h-8 items-center gap-3 text-[12px]",
              fresh && "animate-[fadeIn_.4s_ease-out]",
            )}
          >
            {/* rail: each dot draws the segment down to the next dot's centre */}
            <span className="relative grid w-2.5 shrink-0 place-items-center self-stretch">
              <span
                className={cn(
                  "absolute top-1/2 left-1/2 w-px -translate-x-1/2",
                  last
                    ? "h-4 bg-gradient-to-b from-white/20 to-transparent"
                    : "h-8 bg-white/20",
                )}
              />
              <span
                className={cn(
                  "relative size-2.5 rounded-full border-[1.5px]",
                  fresh
                    ? "border-[#3ecf8e] bg-[#3ecf8e] shadow-[0_0_0_3px_rgba(62,207,142,0.18)]"
                    : "border-white/40 bg-[#0d1110]",
                )}
              />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                fresh ? "text-white/90" : "text-white/45",
              )}
            >
              {row.msg}
            </span>
            <span className="font-mono text-[10.5px] text-white/30">
              {row.sha}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Terminal                                                            */
/* ------------------------------------------------------------------ */

const TERM: { at: number; node: ReactNode }[] = [
  {
    at: 300,
    node: (
      <>
        <span className="text-[#3ecf8e]">~/volt-web</span>{" "}
        <span className="text-white/40">$</span> bun test api
      </>
    ),
  },
  { at: 1100, node: <span className="text-white/40">bun test v1.3.2</span> },
  {
    at: 1500,
    node: (
      <>
        <Pass /> search › returns results <Dim>4ms</Dim>
      </>
    ),
  },
  {
    at: 1800,
    node: (
      <>
        <Pass /> search › paginates <Dim>2ms</Dim>
      </>
    ),
  },
  {
    at: 2100,
    node: (
      <>
        <Pass /> rateLimit › allows 60/min <Dim>1ms</Dim>
      </>
    ),
  },
  {
    at: 2400,
    node: (
      <>
        <Pass /> rateLimit › 429 + Retry-After <Dim>1ms</Dim>
      </>
    ),
  },
  {
    at: 2700,
    node: (
      <>
        <Pass /> rateLimit › window slides <Dim>3ms</Dim>
      </>
    ),
  },
  {
    at: 3300,
    node: (
      <>
        <span className="text-[#3ecf8e]">24 pass</span>{" "}
        <span className="text-white/40">0 fail · 312ms</span>
      </>
    ),
  },
];

function Pass() {
  return <span className="text-[#3ecf8e]">✓</span>;
}
function Dim({ children }: { children: ReactNode }) {
  return <span className="text-white/30">{children}</span>;
}

function TerminalArt() {
  const { ref, t } = useLoopClock(7000, 5000);
  const lines = TERM.filter((l) => t >= l.at);
  return (
    <div ref={ref} className="w-full px-5 pb-5">
      <div className="overflow-hidden rounded-[14px] border border-white/10 bg-[#0c0c0c] shadow-[0_20px_40px_rgba(0,0,0,0.4)]">
        <div className="flex h-8 items-center gap-2 border-b border-white/[0.07] px-3 text-[11px] text-white/45">
          <span className="rounded-md bg-white/[0.07] px-2 py-0.5 text-white/75">
            zsh
          </span>
          <span>agent · bun</span>
          <span className="ml-auto size-1.5 rounded-full bg-[#3ecf8e] shadow-[0_0_8px_#3ecf8e]" />
        </div>
        <div className="h-[210px] px-3 py-2.5 font-mono text-[11.5px] leading-[1.75] text-white/85">
          {lines.map((l) => (
            <div key={l.at} className="animate-[fadeIn_.25s_ease-out] truncate">
              {l.node}
            </div>
          ))}
          <span className="inline-block h-3.5 w-[7px] translate-y-[2px] animate-pulse bg-white/70" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Parallel agents                                                     */
/* ------------------------------------------------------------------ */

const LANES = [
  {
    title: "Rate limit search API",
    branch: "feat/rate-limit",
    start: 0,
    dur: 3800,
    tone: "#ff6228",
  },
  {
    title: "Migrate settings to zod",
    branch: "chore/zod",
    start: 600,
    dur: 5200,
    tone: "#7aa7ff",
  },
  {
    title: "Fix flaky e2e on CI",
    branch: "fix/e2e-retry",
    start: 1200,
    dur: 4300,
    tone: "#c792ea",
  },
  {
    title: "Write v0.0.5 changelog",
    branch: "docs/changelog",
    start: 300,
    dur: 2600,
    tone: "#3ecf8e",
  },
];

function ParallelArt() {
  const { ref, t } = useLoopClock(8000, 7000);
  return (
    <div ref={ref} className="flex w-full flex-col gap-2 px-5 pb-5">
      {LANES.map((lane) => {
        const p = span(t, lane.start, lane.dur);
        const finished = p >= 1;
        return (
          <div
            key={lane.branch}
            className="rounded-xl border border-white/10 bg-[#161616] px-3 py-2.5"
          >
            <div className="flex items-center gap-2 text-[12.5px]">
              {finished ? (
                <Check className="size-3.5 text-[#3ecf8e]" strokeWidth={2.5} />
              ) : (
                <Spinner className="size-3.5" />
              )}
              <span className="min-w-0 flex-1 truncate text-white/85">
                {lane.title}
              </span>
              <span className="font-mono text-[10.5px] text-white/35">
                {lane.branch}
              </span>
            </div>
            <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/[0.07]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(4, p * 100)}%`,
                  background: finished ? "#3ecf8e" : lane.tone,
                  boxShadow: finished ? "none" : `0 0 10px ${lane.tone}`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */

const JOBS = [
  { name: "Triage new issues", when: "Weekdays · 9:00", on: true },
  { name: "Bump patch dependencies", when: "Mondays · 7:30", on: true },
  { name: "Draft release notes", when: "On tag v*", on: true },
  { name: "Nightly perf audit", when: "Daily · 2:00", on: false },
];

function AutomationsArt() {
  const { ref, t } = useLoopClock(6000, 5000);
  const firing = t > 1600 && t < 3600;
  return (
    <div ref={ref} className="w-full px-5 pb-5">
      <div className="overflow-hidden rounded-[14px] border border-white/10 bg-[#161616]">
        {JOBS.map((job, i) => (
          <div
            key={job.name}
            className={cn(
              "flex h-[52px] items-center gap-3 px-3.5",
              i > 0 && "border-t border-white/[0.06]",
            )}
          >
            <span className="grid size-7 place-items-center rounded-lg bg-white/[0.06] text-white/55">
              {i === 0 && firing ? (
                <Spinner className="size-3.5 text-[#ff8a5a]" />
              ) : (
                <Clock3 className="size-3.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] text-white/85">
                {job.name}
              </div>
              <div className="text-[11px] text-white/35">
                {i === 0 && firing ? "Running now…" : job.when}
              </div>
            </div>
            <span
              className={cn(
                "relative h-[18px] w-[32px] rounded-full",
                job.on ? "bg-[#3ecf8e]" : "bg-white/15",
              )}
            >
              <span
                className={cn(
                  "absolute top-[2px] size-[14px] rounded-full bg-white",
                  job.on ? "left-[16px]" : "left-[2px]",
                )}
              />
            </span>
          </div>
        ))}
        <div className="flex h-10 items-center gap-1 border-t border-white/[0.06] px-3.5 text-[12px] text-white/40">
          New automation
          <ChevronRight className="size-3.5" />
        </div>
      </div>
    </div>
  );
}
