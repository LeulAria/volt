import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Globe,
  Mic,
  MoreHorizontal,
  PanelLeft,
  PenTool,
  Plus,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { BrandIcon } from "./brandIcons";
import {
  EASE_OUT,
  Spinner,
  WINDOW_FRAME,
  span,
  TrafficLights,
  useElementWidth,
  useLoopClock,
} from "./primitives";

const NOTE = "Make this the primary action and add a plus icon";

/** Timeline in ms. */
const B = {
  move: 300,
  hover: 1400,
  pin: 1900,
  typeStart: 2300,
  typeEnd: 4300,
  send: 4600,
  edit: 5600,
  applied: 7200,
  fadeOut: 11200,
  length: 11800,
} as const;

const FULL = { w: 1072, h: 664 };
const COMPACT = { w: 672, h: 724 };

export function BrowserStage() {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const compact = width > 0 && width < 640;
  const design = compact ? COMPACT : FULL;
  const scale = width / design.w;

  return (
    <div
      ref={ref}
      className={WINDOW_FRAME}
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
        <Window compact={compact} />
      </div>
    </div>
  );
}

function Window({ compact }: { compact: boolean }) {
  const { ref, t } = useLoopClock(B.length, B.applied + 1800);
  const fade = 1 - span(t, B.fadeOut, B.length - B.fadeOut);

  return (
    <div
      ref={ref}
      className="flex size-full overflow-hidden bg-[#161616] text-white"
    >
      {compact ? null : <ChatPane t={t} fade={fade} />}
      <BrowserPane t={t} fade={fade} compact={compact} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Left: agent chat                                                    */
/* ------------------------------------------------------------------ */

function ChatPane({ t, fade }: { t: number; fade: number }) {
  const sent = t >= B.send;
  const editing = t >= B.edit && t < B.applied;
  const applied = t >= B.applied;

  return (
    <div className="flex w-[340px] shrink-0 flex-col border-r border-white/10 bg-[#161616]">
      <div className="flex h-[46px] shrink-0 items-center gap-3 px-4 text-white/45">
        <TrafficLights />
        <PanelLeft className="ml-2 size-4" />
        <Search className="size-4" />
        <Plus className="size-4" />
        <span className="truncate text-[13px] text-white/70">Todos</span>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-4 pb-3"
        style={{ opacity: fade }}
      >
        <div className="rounded-xl border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-[13.5px] text-white/85">
          Quiet the completed rows
        </div>
        <div className="px-1 text-[13px] leading-relaxed text-white/45">
          Worked for 6s
          <p className="mt-1.5 text-white/80">
            Struck through finished tasks and lifted the open count.
          </p>
        </div>

        <AnimatePresence>
          {sent ? (
            <motion.div
              key="comment"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE_OUT }}
              className="flex flex-col gap-3"
            >
              <div className="rounded-xl border border-white/10 bg-white/[0.045] px-3.5 py-2.5 text-[13.5px] text-white/85">
                <div className="mb-2 flex items-center gap-2">
                  <span className="grid size-5 place-items-center rounded-full bg-[#4c8dff] text-[11px] font-semibold text-white">
                    1
                  </span>
                  <code className="rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[11px] text-[#9cdcfe]">
                    button.add-task
                  </code>
                  <span className="font-mono text-[11px] text-white/35">
                    TodoList.tsx:28
                  </span>
                </div>
                {NOTE}
              </div>
              <div className="px-1 text-[13px]">
                {applied ? (
                  <span className="text-white/45">Worked for 9s</span>
                ) : (
                  <span className="shimmer-text">Working</span>
                )}
              </div>
              {t >= B.edit ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 px-1 text-[12.5px]"
                >
                  <span className="grid size-4 place-items-center text-white/45">
                    {editing ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Check
                        className="size-3.5 text-[#3ecf8e]"
                        strokeWidth={2.5}
                      />
                    )}
                  </span>
                  <span className="text-white/50">Edit</span>
                  <span className="font-mono text-[11.5px] text-white/80">
                    src/components/TodoList.tsx
                  </span>
                  <span className="ml-auto font-mono text-[11.5px] text-[#3ecf8e]">
                    +4 <span className="text-[#f07178]">-2</span>
                  </span>
                </motion.div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="px-3 pb-3">
        <div className="flex h-[46px] items-center gap-2 rounded-full border border-white/12 bg-[#202020] pr-1.5 pl-1.5">
          <span className="grid size-7 place-items-center rounded-full bg-white/[0.07] text-white/55">
            <Plus className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-white/40">
            Send fo...
          </span>
          <span className="inline-flex items-center gap-1 text-[13px] text-white/65">
            <BrandIcon id="claude" size={13} />
            Opus 5.5 Medium
          </span>
          <span className="grid size-8 place-items-center rounded-full bg-white text-black">
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Right: browser                                                      */
/* ------------------------------------------------------------------ */

const TASKS = [
  { title: "Rewrite the landing hero", when: "Today", done: false },
  { title: "Ship the rate limiter", when: "Done", done: true },
  { title: "Pin the browser comment", when: "Today", done: false },
  { title: "Review the settings copy", when: "Later", done: false },
] as const;

function BrowserPane({
  t,
  fade,
  compact,
}: {
  t: number;
  fade: number;
  compact: boolean;
}) {
  const hover = t >= B.hover && t < B.send;
  const pinned = t >= B.pin;
  const typed = NOTE.slice(
    0,
    Math.round(NOTE.length * span(t, B.typeStart, B.typeEnd - B.typeStart)),
  );
  const inputOpen = t >= B.pin && t < B.send + 300;
  const applied = t >= B.applied;
  const reloading = t >= B.applied - 350 && t < B.applied;

  // cursor path: enters from bottom-right, glides onto the button
  const c = span(t, B.move, B.hover - B.move);
  const ease = 1 - (1 - c) ** 3;
  const cursor = { x: 96 + (1 - ease) * 280, y: 24 + (1 - ease) * 190 };

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-[#0e0e0e]">
      {compact ? (
        <div className="flex h-[40px] items-center px-4">
          <TrafficLights />
        </div>
      ) : null}
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-white/[0.07] bg-[#161616] px-3">
        <span className="inline-flex h-8 items-center gap-2 rounded-t-lg px-3 text-[13px] text-white/85">
          <Globe className="size-3.5 text-white/55" />
          Todos
          <X className="size-3 text-white/40" />
        </span>
        <div className="ml-auto flex items-center gap-4 pr-1 text-white/45">
          <Plus className="size-4" />
          <MoreHorizontal className="size-4" />
        </div>
      </div>
      <div className="flex h-[44px] shrink-0 items-center gap-3.5 border-b border-white/[0.07] bg-[#161616] px-4 text-white/50">
        <ArrowLeft className="size-4" />
        <ArrowRight className="size-4 opacity-40" />
        <RotateCw className={cn("size-3.5", reloading && "animate-spin")} />
        <span className="font-mono text-[12.5px] text-white/80">
          localhost:5173/
        </span>
        <span className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-full bg-[#4c8dff]/15 px-3 text-[12.5px] text-[#8fb6ff]">
          <PenTool className="size-3.5" />
          Design
        </span>
      </div>

      {/* the page under test */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ opacity: fade }}
      >
        <div className="relative flex h-full flex-col items-center justify-center px-8 pb-8">
          <div className="w-full max-w-[460px]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/40">
              Inbox
            </p>
            <div className="mt-1.5 flex items-end justify-between">
              <h3 className="text-[32px] font-semibold tracking-[-0.03em] text-white">
                Today
              </h3>
              <span className="mb-1.5 text-[13px] text-white/40">3 open</span>
            </div>
            <ul className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]">
              {TASKS.map((task) => (
                <li
                  key={task.title}
                  className="flex h-12 items-center gap-3 border-b border-white/[0.06] px-4 last:border-b-0"
                >
                  <span
                    className={cn(
                      "grid size-[18px] shrink-0 place-items-center rounded-full border",
                      task.done
                        ? "border-[#3ecf8e] bg-[#3ecf8e] text-[#0e0e0e]"
                        : "border-white/25",
                    )}
                  >
                    {task.done ? (
                      <Check className="size-3" strokeWidth={3} />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[14px]",
                      task.done
                        ? "text-white/35 line-through"
                        : "text-white/90",
                    )}
                  >
                    {task.title}
                  </span>
                  <span className="shrink-0 text-[12px] text-white/35">
                    {task.when}
                  </span>
                </li>
              ))}
            </ul>
            <div className="relative mt-8 flex items-center gap-3">
              <div className="relative">
                <motion.span
                  layout
                  transition={{ duration: 0.45, ease: EASE_OUT }}
                  className={cn(
                    "inline-flex h-11 items-center gap-2 rounded-full px-6 text-[15px] font-medium",
                    applied
                      ? "bg-[#4c8dff] text-white shadow-[0_8px_24px_rgba(76,141,255,0.35)]"
                      : "border border-white/20 text-white/85",
                  )}
                >
                  {applied ? (
                    <Plus className="size-4" strokeWidth={2.4} />
                  ) : null}
                  Add task
                </motion.span>

                {/* element picker outline + pin */}
                <AnimatePresence>
                  {hover || (pinned && !applied) ? (
                    <motion.span
                      key="outline"
                      initial={{ opacity: 0, scale: 1.08 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.25, ease: EASE_OUT }}
                      className="pointer-events-none absolute -inset-1.5 rounded-[6px] border-2 border-[#4c8dff] bg-[#4c8dff]/[0.07]"
                    >
                      {hover && !pinned ? (
                        <span className="absolute -top-6 left-0 rounded-[4px] bg-[#4c8dff] px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-white">
                          button.add-task · 132×44
                        </span>
                      ) : null}
                    </motion.span>
                  ) : null}
                </AnimatePresence>
                {/* pointer, anchored to the target so it always lands on it */}
                {t < B.send ? (
                  <svg
                    className="pointer-events-none absolute z-20 size-5 drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]"
                    style={{
                      left: cursor.x,
                      top: cursor.y,
                      transform: `scale(${t >= B.pin - 150 && t < B.pin ? 0.85 : 1})`,
                    }}
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path
                      d="M4 2.5 19.5 11l-6.8 1.8L9.6 19.6z"
                      fill="#fff"
                      stroke="#000"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
                <AnimatePresence>
                  {pinned ? (
                    <motion.span
                      key="pin"
                      initial={{ opacity: 0, y: -10, scale: 0.6, rotate: -45 }}
                      animate={{ opacity: 1, y: 0, scale: 1, rotate: -45 }}
                      exit={{ opacity: 0, rotate: -45 }}
                      transition={{
                        type: "spring",
                        stiffness: 520,
                        damping: 22,
                      }}
                      className={cn(
                        "absolute -top-5 -left-5 grid size-8 place-items-center rounded-full rounded-bl-[4px] border-2 border-white text-[13px] font-semibold text-white shadow-[0_6px_16px_rgba(0,0,0,0.5)]",
                        applied ? "bg-[#3ecf8e]" : "bg-[#1b1b1b]",
                      )}
                    >
                      <span className="grid rotate-45 place-items-center">
                        {applied ? (
                          <Check className="size-4" strokeWidth={3} />
                        ) : (
                          "1"
                        )}
                      </span>
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </div>
              <span className="inline-flex h-11 items-center rounded-full bg-white px-6 text-[15px] font-medium text-black">
                Clear done
              </span>
            </div>
          </div>
        </div>

        {/* comment composer anchored under the page */}
        <AnimatePresence>
          {inputOpen ? (
            <motion.div
              key="note"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.35, ease: EASE_OUT }}
              className="absolute bottom-10 left-1/2 flex h-12 w-[min(520px,85%)] -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-[#1c1c1c] pr-1.5 pl-5 shadow-[0_16px_40px_rgba(0,0,0,0.6)]"
            >
              <span className="min-w-0 flex-1 truncate text-[14px]">
                {typed ? (
                  <span className="text-white/90">
                    {typed}
                    <span className="ml-px inline-block h-4 w-[1.5px] translate-y-[3px] bg-white/80" />
                  </span>
                ) : (
                  <span className="text-white/40">Describe the change</span>
                )}
              </span>
              <span
                className={cn(
                  "grid size-9 place-items-center rounded-full bg-white text-black transition-transform",
                  t >= B.typeEnd && "scale-90",
                )}
              >
                {typed ? (
                  <ArrowUp className="size-4" strokeWidth={2.25} />
                ) : (
                  <Mic className="size-4" />
                )}
              </span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
