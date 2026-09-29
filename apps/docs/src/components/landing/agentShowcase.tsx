import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsLeft,
  Code2,
  File,
  FileText,
  FolderPlus,
  GitBranch,
  Globe,
  LaptopMinimal,
  LayoutTemplate,
  ListFilter,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { BrandIcon } from "./brandIcons";
import {
  EASE_OUT,
  Spinner,
  span,
  TrafficLights,
  useElementWidth,
  useLoopClock,
  WINDOW_FRAME,
} from "./primitives";
import { SunsetScene } from "./sunsetScene";

/* ------------------------------------------------------------------ */
/* Script                                                              */
/* ------------------------------------------------------------------ */

const PROMPT =
  "Add rate limiting to /api/search: 60 req/min per IP, return 429 with Retry-After.";
const TITLE = "Rate limit search API";

const T = {
  typeStart: 400,
  typeEnd: 2300,
  send: 2600,
  firstStep: 3300,
  answer: 8400,
  answerEnd: 10600,
  done: 10900,
  push: 12600,
  pushed: 13300,
  fadeOut: 16400,
  length: 17000,
} as const;

type Step = {
  at: number;
  icon: typeof FileText;
  verb: string;
  target: string;
  meta?: ReactNode;
  busyFor?: number;
};

const STEPS: Step[] = [
  {
    at: 3300,
    icon: FileText,
    verb: "Read",
    target: "src/routes/api/search.ts",
  },
  {
    at: 3900,
    icon: Search,
    verb: "Search",
    target: '"rateLimit|Retry-After"',
    meta: <span className="text-white/40">3 results</span>,
  },
  {
    at: 4700,
    icon: Pencil,
    verb: "Create",
    target: "src/lib/rateLimit.ts",
    meta: <span className="text-[#3ecf8e]">+42</span>,
  },
  {
    at: 5600,
    icon: Pencil,
    verb: "Edit",
    target: "src/routes/api/search.ts",
    meta: (
      <>
        <span className="text-[#3ecf8e]">+6</span>{" "}
        <span className="text-[#f07178]">-1</span>
      </>
    ),
  },
  {
    at: 6500,
    icon: SquareTerminal,
    verb: "Run",
    target: "bun test api",
    busyFor: 1500,
    meta: (
      <span className="inline-flex items-center gap-1 text-[#3ecf8e]">
        <Check className="size-3" strokeWidth={2.5} />
        24 passed
      </span>
    ),
  },
];

type Seg = { text: string; code?: boolean; bold?: boolean };
const ANSWER: Seg[] = [
  { text: "Added a sliding-window limiter in " },
  { text: "src/lib/rateLimit.ts", code: true },
  {
    text: " and wired it into the search route. Requests over 60/min per IP now get a ",
  },
  { text: "429", bold: true },
  { text: " with a " },
  { text: "Retry-After", code: true },
  { text: " header. All 24 API tests pass." },
];
const ANSWER_LEN = ANSWER.reduce((n, s) => n + s.text.length, 0);

const DIFF_PREVIEW: [string, string][] = [
  ["kw", "export function "],
  ["fn", "rateLimit"],
  ["tx", "(limit = "],
  ["nm", "60"],
  ["tx", ", windowMs = "],
  ["nm", "60_000"],
  ["tx", ") {\n"],
  ["kw", "  const "],
  ["tx", "hits = "],
  ["kw", "new "],
  ["fn", "Map"],
  ["tx", "<string, number[]>();\n"],
  ["kw", "  return "],
  ["tx", "(ip: string) => {\n"],
  ["kw", "    const "],
  ["tx", "recent = (hits."],
  ["fn", "get"],
  ["tx", "(ip) ?? []).filter((t) => now - t < windowMs);\n"],
  ["kw", "    if "],
  ["tx", "(recent.length >= limit) "],
  ["kw", "return "],
  ["tx", "{ ok: "],
  ["nm", "false"],
  ["tx", ", retryAfter };"],
];

const TOKEN_TONE: Record<string, string> = {
  kw: "text-[#c792ea]",
  fn: "text-[#82aaff]",
  nm: "text-[#f78c6c]",
  tx: "text-white/75",
};

/* ------------------------------------------------------------------ */
/* Sidebar data                                                        */
/* ------------------------------------------------------------------ */

type Chat = { tag: "QP" | "AT" | "VO"; title: string; age: string };

const TAG_TONE: Record<Chat["tag"], string> = {
  QP: "text-[#7aa7ff]",
  AT: "text-[#ff9868]",
  VO: "text-white/40",
};

const PINNED: Chat[] = [
  { tag: "VO", title: "Release checklist v0.0.5", age: "2h" },
];
const ATTENTION: Chat[] = [
  { tag: "QP", title: "Review auth migration", age: "3h" },
  { tag: "AT", title: "Flaky e2e on CI", age: "1w" },
];
const DONE: Chat[] = [
  { tag: "VO", title: "Bump Electron to 38", age: "3h" },
  { tag: "QP", title: "Dark mode for settings", age: "4h" },
  { tag: "VO", title: "Explain the cache layer", age: "4h" },
  { tag: "QP", title: "Fix titlebar drag region", age: "5h" },
  { tag: "AT", title: "Keybindings search", age: "1d" },
  { tag: "VO", title: "Split editor groups", age: "1d" },
  { tag: "QP", title: "Onboarding copy pass", age: "2d" },
];

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export type Mode = "agent" | "editor";

export function ModeSwitch({
  mode,
  onMode,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Workspace mode"
      className="relative inline-flex rounded-full border border-white/10 bg-white/[0.04] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
    >
      {(["agent", "editor"] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          onClick={() => onMode(id)}
          className={cn(
            "relative z-10 h-8 rounded-full px-4 text-[13px] font-medium capitalize transition-colors duration-200",
            mode === id ? "text-black" : "text-white/55 hover:text-white/85",
          )}
        >
          {mode === id ? (
            <motion.span
              layoutId="mode-pill"
              className="absolute inset-0 -z-10 rounded-full bg-white"
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          ) : null}
          {id}
        </button>
      ))}
    </div>
  );
}

/** The window is laid out at a fixed design size and scaled, so it reads like a screenshot. */
const FULL = { w: 1056, h: 716 };
/** Phones get a chat-only frame at a narrower design width so text stays legible. */
const COMPACT = { w: 584, h: 820 };

export function AgentStage({
  mode,
  plain = false,
}: {
  mode: Mode;
  /** Drop border and drop shadow — used when this stage is a full-width section, not a framed card. */
  plain?: boolean;
}) {
  const { ref: boxRef, width } = useElementWidth<HTMLDivElement>();
  const compact = width > 0 && width < 640;
  const design = compact ? COMPACT : FULL;
  const scale = width / design.w;

  return (
    <div className="relative">
      <div
        ref={boxRef}
        className={cn(WINDOW_FRAME, plain && "border-0 shadow-none")}
        style={{ aspectRatio: `${design.w} / ${design.h}` }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left transition-opacity duration-500"
          style={{
            width: design.w,
            height: design.h,
            transform: `scale(${scale || 1})`,
            opacity: scale ? 1 : 0,
          }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {mode === "agent" ? (
              <motion.div
                key="agent"
                className="absolute inset-0"
                initial={{ opacity: 0, scale: 1.02 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.99 }}
                transition={{ duration: 0.5, ease: EASE_OUT }}
              >
                <SunsetScene className="absolute inset-x-0 top-[-22%] h-[138%] w-full" />
                <div
                  className={cn(
                    "absolute overflow-hidden rounded-[14px] shadow-[0_28px_70px_-24px_rgba(0,0,0,0.65)]",
                    compact
                      ? "top-[9%] right-[5%] bottom-[7%] left-[5%]"
                      : // same margins as the window in the editor-mode screenshot
                        "top-[5.7%] right-[4%] bottom-[6.5%] left-[4%]",
                  )}
                >
                  <AgentWindow compact={compact} />
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="editor"
                className="absolute inset-0 bg-[#1b2a3a]"
                initial={{ opacity: 0, scale: 1.02 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.99 }}
                transition={{ duration: 0.5, ease: EASE_OUT }}
              >
                <img
                  src="/volt-ide.jpg"
                  alt="Volt editor mode with file explorer, welcome shortcuts, and the agent chat docked on the right"
                  width={2000}
                  height={1348}
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function AgentWindow({ compact }: { compact: boolean }) {
  const { ref, t } = useLoopClock(T.length, T.pushed + 1500);

  const sent = t >= T.send;
  const running = sent && t < T.done;
  const done = t >= T.done;
  const typed = sent
    ? ""
    : PROMPT.slice(
        0,
        Math.round(
          PROMPT.length * span(t, T.typeStart, T.typeEnd - T.typeStart),
        ),
      );
  const fade = 1 - span(t, T.fadeOut, T.length - T.fadeOut);

  return (
    <div ref={ref} className="flex size-full overflow-hidden text-white">
      {compact ? null : <Sidebar running={running} done={done} fade={fade} />}
      <div className="relative flex min-w-0 flex-1 flex-col bg-[#191919]">
        <header className="flex h-[48px] shrink-0 items-center gap-2 px-5 text-[14px]">
          {compact ? <TrafficLights className="mr-3" /> : null}
          <span className="text-white/85">{sent ? TITLE : "New chat"}</span>
          <LaptopMinimal className="size-3.5 text-white/35" />
          <div className="ml-auto flex items-center gap-3.5 text-white/45">
            <Code2 className="size-4" />
            <SlidersHorizontal className="size-4" />
            <MoreHorizontal className="size-4" />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "relative flex min-w-0 flex-1 flex-col",
              compact ? "px-5" : "px-9",
            )}
          >
            <div
              className="min-h-0 flex-1 overflow-hidden pt-3 [mask-image:linear-gradient(180deg,transparent,#000_28px)]"
              style={{ opacity: fade }}
            >
              {sent ? (
                <FollowBottom>
                  <Thread t={t} />
                </FollowBottom>
              ) : (
                <EmptyState />
              )}
            </div>
            <Composer
              typed={typed}
              sending={t >= T.typeEnd && !sent}
              running={running}
              usage={done ? 12.4 : 6.3 + 6.1 * span(t, T.send, T.done - T.send)}
            />
          </div>
          <div
            className={cn(
              "w-[52px] shrink-0 flex-col items-center gap-4 pt-3 text-white/40",
              compact ? "hidden" : "flex",
            )}
          >
            <ChevronsLeft className="size-4" />
            <Plus className="size-4" />
            <Globe className="size-4" />
            <SquareTerminal className="size-4" />
            <File className="size-4" />
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center pb-16 text-center">
      <div className="mb-3 font-mono text-[40px] font-semibold tracking-wide text-white/90">
        volt
      </div>
      <p className="text-[14px] text-white/40">
        What should we build in volt-web?
      </p>
    </div>
  );
}

function Sidebar({
  running,
  done,
  fade,
}: {
  running: boolean;
  done: boolean;
  fade: number;
}) {
  return (
    <aside className="flex w-[296px] shrink-0 flex-col overflow-hidden border-r border-white/10 bg-[rgba(20,18,22,0.86)] backdrop-blur-[40px] backdrop-saturate-[1.4] px-3 text-[14px] [&>*]:shrink-0">
      <div className="flex h-[48px] items-center gap-4 px-1.5">
        <TrafficLights />
        <PanelLeft className="size-4 text-white/50" />
      </div>
      <nav className="mt-1 flex flex-col gap-0.5 text-white/85">
        <NavRow icon={Send} label="New Chat" />
        <NavRow icon={Search} label="Search" />
        <NavRow icon={Settings} label="Automations" />
        <NavRow icon={LayoutTemplate} label="Customize" />
        <NavRow icon={FolderPlus} label="New project" />
      </nav>

      <Group label="Pinned" filter>
        {PINNED.map((c) => (
          <ChatRow key={c.title} chat={c} />
        ))}
      </Group>
      <Group label="Needs attention">
        {ATTENTION.map((c) => (
          <ChatRow key={c.title} chat={c} />
        ))}
      </Group>
      <AnimatePresence initial={false}>
        {running ? (
          <motion.div
            key="running"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <Group label="Running">
              <ChatRow
                chat={{ tag: "VO", title: TITLE, age: "" }}
                active
                busy
              />
            </Group>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <Group label="Done">
        <AnimatePresence initial={false}>
          {done && fade > 0.05 ? (
            <motion.div
              key="new-done"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <ChatRow chat={{ tag: "VO", title: TITLE, age: "now" }} active />
            </motion.div>
          ) : null}
        </AnimatePresence>
        {DONE.map((c) => (
          <ChatRow key={c.title} chat={c} />
        ))}
      </Group>
    </aside>
  );
}

function NavRow({ icon: Icon, label }: { icon: typeof Send; label: string }) {
  return (
    <div className="flex h-[34px] items-center gap-3 rounded-lg px-2">
      <Icon className="size-[17px] text-white/70" strokeWidth={1.6} />
      {label}
    </div>
  );
}

function Group({
  label,
  filter,
  children,
}: {
  label: string;
  filter?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="flex h-7 items-center gap-2 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/45">
        <ChevronDown className="size-3" />
        {label}
        <span className="ml-auto flex items-center gap-2.5">
          {filter ? <ListFilter className="size-3.5" /> : null}
          <Plus className="size-3.5" />
        </span>
      </div>
      {children}
    </div>
  );
}

function ChatRow({
  chat,
  active,
  busy,
}: {
  chat: Chat;
  active?: boolean;
  busy?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-[32px] items-center gap-2.5 rounded-lg px-2 text-[13.5px]",
        active ? "bg-white/[0.09] text-white" : "text-white/80",
      )}
    >
      <span
        className={cn(
          "w-5 font-mono text-[10px] font-semibold",
          TAG_TONE[chat.tag],
        )}
      >
        {chat.tag}
      </span>
      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      {busy ? (
        <Spinner className="size-3.5 text-[#ff8a5a]" />
      ) : (
        <span className="text-[12px] text-white/35">{chat.age}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Thread                                                              */
/* ------------------------------------------------------------------ */

const rise = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, ease: EASE_OUT },
};

/** Keeps the newest content in view, like a chat that auto-scrolls as the agent works. */
function FollowBottom({ children }: { children: ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const measure = () =>
      setOffset(Math.min(0, outer.clientHeight - inner.offsetHeight - 12));
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    measure();
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={outerRef} className="h-full">
      <div
        ref={innerRef}
        className="transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ transform: `translateY(${offset}px)` }}
      >
        {children}
      </div>
    </div>
  );
}

function Thread({ t }: { t: number }) {
  const done = t >= T.done;
  const seconds = Math.max(1, Math.round((Math.min(t, T.done) - T.send) / 450));
  const shown = STEPS.filter((s) => t >= s.at);
  const answerChars = Math.round(
    ANSWER_LEN * span(t, T.answer, T.answerEnd - T.answer),
  );

  return (
    <div className="mx-auto flex max-w-[760px] flex-col">
      <motion.div
        {...rise}
        className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-[14.5px] leading-relaxed text-white/90"
      >
        {PROMPT}
      </motion.div>

      <div className="mt-4 flex h-6 items-center gap-2 px-1 text-[13.5px]">
        {done ? (
          <span className="text-white/45">Worked for {seconds}s</span>
        ) : (
          <span className="shimmer-text">Working · {seconds}s</span>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-0.5 px-1">
        {shown.map((step, i) => {
          const busy =
            i === shown.length - 1 &&
            !!step.busyFor &&
            t < step.at + step.busyFor;
          const pending =
            i === shown.length - 1 &&
            t < T.answer &&
            !step.busyFor &&
            t < step.at + 500;
          return (
            <StepRow
              key={step.target + step.verb}
              step={step}
              busy={busy || pending}
            />
          );
        })}
      </div>

      {t >= T.answer ? <Answer chars={answerChars} /> : null}
      {done ? <DiffCard t={t} /> : null}
    </div>
  );
}

function StepRow({ step, busy }: { step: Step; busy: boolean }) {
  const Icon = step.icon;
  return (
    <motion.div
      {...rise}
      className="flex h-[28px] items-center gap-2.5 text-[13px]"
    >
      <span className="grid size-4 place-items-center text-white/40">
        {busy ? (
          <Spinner className="size-3.5 text-white/60" />
        ) : (
          <Icon className="size-3.5" strokeWidth={1.8} />
        )}
      </span>
      <span className="text-white/50">{step.verb}</span>
      <span className="font-mono text-[12px] text-white/80">{step.target}</span>
      <span className="ml-auto font-mono text-[12px]">
        {busy ? null : step.meta}
      </span>
    </motion.div>
  );
}

function Answer({ chars }: { chars: number }) {
  let left = chars;
  return (
    <p className="mt-4 px-1 text-[14.5px] leading-[1.65] text-white/90">
      {ANSWER.map((seg) => {
        if (left <= 0) return null;
        const text = seg.text.slice(0, left);
        left -= seg.text.length;
        if (seg.code)
          return (
            <code
              key={seg.text}
              className="rounded-[5px] bg-white/[0.08] px-1.5 py-0.5 font-mono text-[12.5px] text-[#9cdcfe]"
            >
              {text}
            </code>
          );
        if (seg.bold)
          return (
            <strong key={seg.text} className="font-semibold text-white">
              {text}
            </strong>
          );
        return <span key={seg.text}>{text}</span>;
      })}
      {chars < ANSWER_LEN ? (
        <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-pulse bg-white/70" />
      ) : null}
    </p>
  );
}

function DiffCard({ t }: { t: number }) {
  const pressing = t >= T.push && t < T.pushed;
  const pushed = t >= T.pushed;
  return (
    <motion.div
      {...rise}
      className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-[#141414]"
    >
      <div className="flex h-10 items-center gap-2 border-b border-white/[0.07] px-3.5 text-[13px]">
        <span className="text-white/85">2 files changed</span>
        <span className="font-mono text-[12px] text-[#3ecf8e]">+48</span>
        <span className="font-mono text-[12px] text-[#f07178]">-1</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex h-7 items-center rounded-full border border-white/12 px-3 text-[12px] text-white/70">
            Review
          </span>
          <span
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-all duration-200",
              pushed ? "bg-[#3ecf8e]/15 text-[#3ecf8e]" : "bg-white text-black",
              pressing && "scale-95 opacity-80",
            )}
          >
            {pushed ? (
              <>
                <Check className="size-3.5" strokeWidth={2.5} />
                Pushed to feat/rate-limit
              </>
            ) : pressing ? (
              <>
                <Spinner className="size-3.5" />
                Pushing
              </>
            ) : (
              <>
                Commit &amp; Push
                <ChevronDown className="size-3.5 opacity-50" />
              </>
            )}
          </span>
        </div>
      </div>
      <FileLine name="src/lib/rateLimit.ts" badge="A" add={42} />
      <pre className="border-y border-white/[0.06] bg-[#3ecf8e]/[0.045] px-3.5 py-2.5 font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap">
        {DIFF_PREVIEW.map(([tone, text], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static token list
          <span key={i} className={TOKEN_TONE[tone]}>
            {text}
          </span>
        ))}
      </pre>
      <FileLine name="src/routes/api/search.ts" badge="M" add={6} del={1} />
    </motion.div>
  );
}

function FileLine({
  name,
  badge,
  add,
  del,
}: {
  name: string;
  badge: "A" | "M";
  add: number;
  del?: number;
}) {
  return (
    <div className="flex h-9 items-center gap-2.5 px-3.5 text-[12.5px]">
      <ChevronDown className="size-3 text-white/35" />
      <span className="font-mono text-white/80">{name}</span>
      <span className="ml-auto font-mono text-[12px] text-[#3ecf8e]">
        +{add}
      </span>
      {del ? (
        <span className="font-mono text-[12px] text-[#f07178]">-{del}</span>
      ) : null}
      <span
        className={cn(
          "w-3 text-center font-mono text-[11px] font-semibold",
          badge === "A" ? "text-[#3ecf8e]" : "text-[#e2c08d]",
        )}
      >
        {badge}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

function Composer({
  typed,
  sending,
  running,
  usage,
}: {
  typed: string;
  sending: boolean;
  running: boolean;
  usage: number;
}) {
  const send = (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full bg-white text-black transition-transform duration-200",
        sending && "scale-90",
      )}
    >
      {running ? (
        <span className="size-[11px] rounded-[2.5px] bg-black" />
      ) : (
        <ArrowUp className="size-[18px]" strokeWidth={2.25} />
      )}
    </span>
  );
  const model = (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[14px] text-white/65">
      <BrandIcon id="claude" size={15} />
      Opus 5.5 Medium
      <ChevronDown className="size-3.5 text-white/35" />
    </span>
  );
  const plus = (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.07] text-white/55">
      <Plus className="size-4" strokeWidth={1.75} />
    </span>
  );

  return (
    <div className="mx-auto w-full max-w-[780px] shrink-0 pt-3 pb-4">
      {typed ? (
        // Drafting: the field grows into a card with controls underneath.
        <div className="rounded-[22px] border border-white/12 bg-[#202020]">
          <div className="min-h-[52px] px-5 pt-4 text-[15px] leading-[1.55] text-white/90">
            {typed}
            <span className="ml-px inline-block h-[17px] w-[1.5px] translate-y-[3px] bg-white/80" />
          </div>
          <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-2.5">
            {plus}
            {model}
            <span className="ml-auto">{send}</span>
          </div>
        </div>
      ) : (
        <div className="flex h-[52px] items-center gap-3 rounded-full border border-white/12 bg-[#202020] pr-2 pl-2">
          {plus}
          <span className="min-w-0 flex-1 truncate text-[15px] text-white/40">
            {running ? "Queue a follow-up" : "Send follow-up"}
          </span>
          {model}
          {send}
        </div>
      )}
      <div className="mt-2.5 flex items-center px-3 text-[13px] text-white/40">
        <GitBranch className="mr-2 size-3.5" />
        {running || usage > 7 ? "feat/rate-limit" : "No branch"}
        <ChevronDown className="ml-1.5 size-3" />
        <span className="ml-auto inline-flex items-center gap-2">
          <svg className="size-3.5 -rotate-90" viewBox="0 0 16 16" aria-hidden>
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeWidth="2"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="37.7"
              strokeDashoffset={37.7 * (1 - usage / 100)}
            />
          </svg>
          <span className="font-medium text-white/70">{usage.toFixed(1)}%</span>
          {typed ? (
            <span className="text-white/35">
              {(usage * 2).toFixed(1)}K/200K
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
