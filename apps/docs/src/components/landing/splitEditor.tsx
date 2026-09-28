import {
  ArrowUp,
  ChevronDown,
  Columns2,
  FileDiff,
  FileText,
  GitBranch,
  LaptopMinimal,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { BrandIcon } from "./brandIcons";
import {
  Spinner,
  span,
  TrafficLights,
  useElementWidth,
  useLoopClock,
  WINDOW_FRAME,
} from "./primitives";

/** Timeline in ms. */
const S = {
  read: 600,
  edit: 1300,
  insert: 1600,
  step: 230,
  stream: 5000,
  streamEnd: 8600,
  chips: 8800,
  length: 11600,
} as const;

const FULL = { w: 1072, h: 680 };
const COMPACT = { w: 600, h: 680 };

/* ------------------------------------------------------------------ */
/* Code                                                                */
/* ------------------------------------------------------------------ */

type Kind = "p" | "t" | "a" | "s" | "x" | "k" | "pr" | "n" | "fn" | "sw";
type Line = { tk: [Kind, string][]; add?: boolean };

const TONE: Record<Kind, string> = {
  p: "text-[#808080]",
  t: "text-[#569cd6]",
  a: "text-[#9cdcfe]",
  s: "text-[#ce9178]",
  x: "text-[#d4d4d4]",
  k: "text-[#d7ba7d]",
  pr: "text-[#9cdcfe]",
  n: "text-[#b5cea8]",
  fn: "text-[#dcdcaa]",
  sw: "text-[#d4d4d4]",
};

const i2 = "  ";
const i4 = "    ";
const i6 = "      ";
const prop = (name: string, value: [Kind, string][], add = false): Line => ({
  add,
  tk: [["x", i6], ["pr", name], ["x", ": "], ...value, ["x", ";"]],
});
const swatch = (name: string, hex: string) => prop(name, [["sw", hex]], true);

const CODE: Line[] = [
  {
    tk: [
      ["p", "<!"],
      ["t", "DOCTYPE"],
      ["x", " "],
      ["a", "html"],
      ["p", ">"],
    ],
  },
  {
    tk: [
      ["p", "<"],
      ["t", "html"],
      ["x", " "],
      ["a", "lang"],
      ["p", "="],
      ["s", '"en"'],
      ["p", ">"],
    ],
  },
  {
    tk: [
      ["p", "<"],
      ["t", "head"],
      ["p", ">"],
    ],
  },
  {
    tk: [
      ["x", i2],
      ["p", "<"],
      ["t", "meta"],
      ["x", " "],
      ["a", "charset"],
      ["p", "="],
      ["s", '"UTF-8"'],
      ["p", ">"],
    ],
  },
  {
    tk: [
      ["x", i2],
      ["p", "<"],
      ["t", "title"],
      ["p", ">"],
      ["x", "Volt Harness"],
      ["p", "</"],
      ["t", "title"],
      ["p", ">"],
    ],
  },
  {
    tk: [
      ["x", i2],
      ["p", "<"],
      ["t", "style"],
      ["p", ">"],
    ],
  },
  {
    add: true,
    tk: [
      ["x", i4],
      ["k", ":root"],
      ["x", " {"],
    ],
  },
  swatch("--bg", "#07080c"),
  swatch("--panel", "#10131b"),
  prop(
    "--line",
    [
      ["fn", "rgba"],
      ["x", "("],
      ["n", "255"],
      ["x", ", "],
      ["n", "255"],
      ["x", ", "],
      ["n", "255"],
      ["x", ", "],
      ["n", "0.08"],
      ["x", ")"],
    ],
    true,
  ),
  swatch("--text", "#edf2ff"),
  swatch("--muted", "#93a0bb"),
  swatch("--accent", "#4f8cff"),
  swatch("--good", "#3dd68c"),
  swatch("--bad", "#ff6b7a"),
  { add: true, tk: [["x", `${i4}}`]] },
  { add: true, tk: [] },
  {
    tk: [
      ["x", i4],
      ["k", "html"],
      ["x", ", "],
      ["k", "body"],
      ["x", " {"],
    ],
  },
  prop("margin", [["n", "0"]]),
  prop("height", [["n", "100%"]]),
  prop("background", [
    ["fn", "var"],
    ["x", "("],
    ["pr", "--bg"],
    ["x", ")"],
  ]),
  prop("color", [
    ["fn", "var"],
    ["x", "("],
    ["pr", "--text"],
    ["x", ")"],
  ]),
  prop("font-family", [
    ["s", "ui-sans-serif"],
    ["x", ", "],
    ["s", "system-ui"],
  ]),
  { tk: [["x", `${i4}}`]] },
  { tk: [] },
  {
    tk: [
      ["x", i4],
      ["k", ".chrome"],
      ["x", " {"],
    ],
  },
  prop("display", [["s", "flex"]]),
  prop("align-items", [["s", "center"]]),
  prop("gap", [["n", "8px"]]),
  prop("padding", [
    ["n", "10px"],
    ["x", " "],
    ["n", "14px"],
  ]),
  prop("border-bottom", [
    ["n", "1px"],
    ["x", " "],
    ["s", "solid"],
    ["x", " "],
    ["fn", "var"],
    ["x", "("],
    ["pr", "--line"],
    ["x", ")"],
  ]),
  { tk: [["x", `${i4}}`]] },
  { tk: [] },
  {
    tk: [
      ["x", i4],
      ["k", ".pill"],
      ["x", " {"],
    ],
  },
  prop("border-radius", [["n", "999px"]]),
  prop("padding", [
    ["n", "4px"],
    ["x", " "],
    ["n", "10px"],
  ]),
];

/** When each added line lands in the file. */
const ADD_AT = (() => {
  const at = new Map<number, number>();
  let n = 0;
  CODE.forEach((line, i) => {
    if (line.add) at.set(i, S.insert + n++ * S.step);
  });
  return at;
})();

/* ------------------------------------------------------------------ */
/* Reply                                                               */
/* ------------------------------------------------------------------ */

type Seg = { text: string; code?: boolean };
const REPLY: { bullet?: boolean; segs: Seg[] }[] = [
  {
    segs: [
      { text: "Added a dark/light toggle to " },
      { text: "harness.html", code: true },
      { text: " that remembers the choice." },
    ],
  },
  {
    bullet: true,
    segs: [
      {
        text: "Colors: hard-coded values now come from shared variables, and a light set overrides them.",
      },
    ],
  },
  {
    bullet: true,
    segs: [
      {
        text: "Loading: a small inline script applies the saved theme before first paint, so nothing flashes.",
      },
    ],
  },
  {
    bullet: true,
    segs: [
      { text: "Toggle: a pill in the header switches themes and saves to " },
      { text: "localStorage", code: true },
      { text: "." },
    ],
  },
];
const REPLY_CHARS = REPLY.reduce(
  (n, b) => n + b.segs.reduce((m, s) => m + s.text.length, 0),
  0,
);

/* ------------------------------------------------------------------ */
/* Stage                                                               */
/* ------------------------------------------------------------------ */

export function SplitStage() {
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
        <SplitWindow compact={compact} />
      </div>
    </div>
  );
}

function SplitWindow({ compact }: { compact: boolean }) {
  const { ref, t } = useLoopClock(S.length, S.length - 1);
  return (
    <div ref={ref} className="flex size-full text-white">
      {compact ? null : <ChatPane t={t} />}
      <EditorPane t={t} compact={compact} />
    </div>
  );
}

function ChatPane({ t }: { t: number }) {
  const editing = t >= S.edit && t < S.stream - 400;
  const worked = t >= S.stream - 400;
  const shown = Math.round(
    REPLY_CHARS * span(t, S.stream, S.streamEnd - S.stream),
  );
  const streaming = t >= S.stream && t < S.streamEnd;

  return (
    <div className="flex w-[468px] shrink-0 flex-col border-r border-white/[0.08] bg-[#181818]">
      <div className="flex h-[46px] shrink-0 items-center gap-3 px-4 text-white/45">
        <TrafficLights />
        <PanelLeft className="ml-2 size-4" />
        <Search className="size-4" />
        <Plus className="size-4" />
        <span className="ml-1 truncate text-[13px] text-white/85">
          Theme toggle
        </span>
        <LaptopMinimal className="size-3.5" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 pt-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-[13.5px] leading-relaxed text-white/90">
          Add a dark/light theme toggle to harness.html that remembers the
          choice.
        </div>
        <div className="px-0.5 text-[12.5px] text-white/40">
          {worked
            ? "Worked for 14s"
            : `Working · ${Math.max(1, Math.floor(t / 1000))}s`}
        </div>
        <div className="flex flex-col gap-1.5 px-0.5 text-[12.5px]">
          {t >= S.read ? (
            <ToolRow icon={<FileText className="size-3.5" />} verb="Read">
              harness.html
            </ToolRow>
          ) : null}
          {t >= S.edit ? (
            <ToolRow
              icon={
                editing ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Pencil className="size-3.5" />
                )
              }
              verb="Edit"
              meta={
                editing ? null : (
                  <>
                    <span className="text-[#3ecf8e]">+80</span>{" "}
                    <span className="text-[#f47067]">-12</span>
                  </>
                )
              }
            >
              harness.html
            </ToolRow>
          ) : null}
        </div>

        <Reply shown={shown} streaming={streaming} />
      </div>

      <div className="shrink-0 px-4 pb-3">
        <div
          className={cn(
            "mb-2.5 flex gap-2 transition-opacity duration-500",
            t >= S.chips ? "opacity-100" : "opacity-0",
          )}
        >
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[12px] text-white/75">
            Changes <span className="text-[#3ecf8e]">+80</span>
          </span>
          <span className="inline-flex h-7 items-center gap-1 rounded-full border border-white/10 px-3 text-[12px] text-white/75">
            Commit &amp; Push <ChevronDown className="size-3" />
          </span>
        </div>
        <div className="flex h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] pr-1.5 pl-1.5">
          <span className="grid size-8 place-items-center rounded-full bg-white/[0.06] text-white/50">
            <Plus className="size-3.5" />
          </span>
          <span className="flex-1 text-[13px] text-white/35">
            Send follow-up
          </span>
          <span className="flex items-center gap-1.5 text-[12px] text-white/70">
            <BrandIcon id="claude" size={12} />
            Opus 5.5 Medium
            <ChevronDown className="size-3 text-white/40" />
          </span>
          <span className="grid size-8 place-items-center rounded-full bg-white text-black">
            <ArrowUp className="size-4" />
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between px-2 text-[11.5px] text-white/40">
          <span className="flex items-center gap-1.5">
            <GitBranch className="size-3" /> theme-toggle
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded-full border-2 border-white/15 border-t-white/60" />
            19%
          </span>
        </div>
      </div>
    </div>
  );
}

function ToolRow({
  icon,
  verb,
  meta,
  children,
}: {
  icon: ReactNode;
  verb: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-6 animate-[fadeIn_.25s_ease-out] items-center gap-2.5 text-white/45">
      {icon}
      <span>{verb}</span>
      <span className="font-mono text-[12px] text-white/80">{children}</span>
      {meta ? (
        <span className="ml-auto font-mono text-[11.5px]">{meta}</span>
      ) : null}
    </div>
  );
}

function Reply({ shown, streaming }: { shown: number; streaming: boolean }) {
  let left = shown;
  return (
    <div className="flex flex-col gap-2 px-0.5 text-[13.5px] leading-[1.65] text-white/85">
      {REPLY.map((block, b) => {
        if (left <= 0) return null;
        const parts = block.segs.map((seg) => {
          const take = Math.max(0, Math.min(seg.text.length, left));
          left -= take;
          return { ...seg, text: seg.text.slice(0, take) };
        });
        const last = left <= 0;
        return (
          <p
            // biome-ignore lint/suspicious/noArrayIndexKey: static script
            key={b}
            className={cn(block.bullet && "relative pl-4")}
          >
            {block.bullet ? (
              <span className="absolute top-[0.7em] left-1 size-1 rounded-full bg-white/50" />
            ) : null}
            {parts.map((seg, i) =>
              seg.code ? (
                <code
                  // biome-ignore lint/suspicious/noArrayIndexKey: static script
                  key={i}
                  className="rounded-[5px] bg-white/[0.07] px-1.5 py-px font-mono text-[12px] text-[#9cc3ff]"
                >
                  {seg.text}
                </code>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: static script
                <span key={i}>{seg.text}</span>
              ),
            )}
            {last && streaming ? (
              <span className="ml-px inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-white/80" />
            ) : null}
          </p>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function EditorPane({ t, compact }: { t: number; compact: boolean }) {
  const visible = CODE.map((line, i) => ({ line, i })).filter(
    ({ i }) => !ADD_AT.has(i) || t >= (ADD_AT.get(i) ?? 0),
  );
  const inserting = [...ADD_AT.values()].some(
    (at) => t >= at && t < at + S.step,
  );
  const lastAdded = [...ADD_AT.entries()]
    .filter(([, at]) => t >= at)
    .map(([i]) => i)
    .pop();
  const cursorLine = lastAdded ?? 7;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[#1c1c1c]">
      <div className="flex h-[46px] shrink-0 items-stretch border-b border-white/[0.06] bg-[#181818] text-[12.5px]">
        {compact ? (
          <span className="flex items-center pl-4">
            <TrafficLights />
          </span>
        ) : null}
        <span className="flex items-center gap-2 border-r border-white/[0.06] px-4 text-white/45">
          <FileDiff className="size-3.5" />
          Pending Changes
        </span>
        <span className="flex items-center gap-2 border-r border-white/[0.06] bg-[#1c1c1c] px-4 text-white/90">
          <HtmlMark />
          harness.html
          <X className="ml-1 size-3.5 text-white/50" />
        </span>
        <span className="ml-auto flex items-center gap-3.5 pr-4 text-white/45">
          <Plus className="size-4" />
          <Columns2 className="size-4" />
          <MoreHorizontal className="size-4" />
        </span>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 px-4 text-[12px] text-white/60">
        <HtmlMark />
        harness.html
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden font-mono text-[12.5px] leading-[20px]">
        <div className="min-w-0 flex-1 pt-1">
          {visible.map(({ line, i }, n) => {
            const added = ADD_AT.has(i);
            const current = i === cursorLine;
            return (
              <div
                key={i}
                className={cn(
                  "relative flex h-5",
                  current && "bg-white/[0.04]",
                  added && "bg-[#3ecf8e]/[0.05]",
                  added &&
                    t < (ADD_AT.get(i) ?? 0) + 400 &&
                    "animate-[fadeIn_.3s_ease-out]",
                )}
              >
                {/* pending-change marker in the gutter */}
                <span
                  className={cn(
                    "w-[3px] shrink-0",
                    added ? "bg-[#3ecf8e]/70" : "bg-transparent",
                  )}
                />
                <span
                  className={cn(
                    "w-11 shrink-0 pr-4 text-right tabular-nums",
                    current ? "text-white/80" : "text-white/25",
                  )}
                >
                  {n + 1}
                </span>
                <span className="min-w-0 truncate whitespace-pre">
                  {line.tk.map(([kind, text], k) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static tokens
                    <Token key={k} kind={kind} text={text} />
                  ))}
                  {current && (inserting || t % 1000 < 500) ? (
                    <span className="ml-px inline-block h-4 w-[2px] translate-y-[3px] bg-white/80" />
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
        {compact ? null : <Minimap count={visible.length} />}
      </div>
    </div>
  );
}

function Token({ kind, text }: { kind: Kind; text: string }) {
  if (kind === "sw") {
    return (
      <span className={TONE.sw}>
        <span
          className="mr-1 inline-block size-[9px] translate-y-[1px] border border-white/60"
          style={{ background: text }}
        />
        {text}
      </span>
    );
  }
  return <span className={TONE[kind]}>{text}</span>;
}

/** Overview ruler: one faint bar per line, sized to the line's length. */
function Minimap({ count }: { count: number }) {
  return (
    <div className="w-[72px] shrink-0 border-l border-white/[0.04] px-2 pt-2 opacity-70">
      {CODE.slice(0, count).map((line, i) => {
        const len = line.tk.reduce((n, [, text]) => n + text.length, 0);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines
            key={i}
            className="mb-[2px] h-[2px] rounded-full bg-[#9cdcfe]/35"
            style={{ width: `${Math.min(100, len * 2.2)}%` }}
          />
        );
      })}
      <div className="mt-1 h-10 w-full rounded-sm bg-white/[0.06]" />
    </div>
  );
}

function HtmlMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden>
      <path fill="#e44d26" d="M3 2h18l-1.6 18L12 22l-7.4-2z" />
      <path
        fill="#fff"
        d="M12 7h4.8l-.2 2H12v2h4.4l-.4 5-4 1.2V15l2.1-.6.1-1.4H12z"
      />
    </svg>
  );
}
