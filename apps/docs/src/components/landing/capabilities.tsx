import { type ReactNode, type RefObject, useId, useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";
import { SectionHeading, useLoopClock } from "./primitives";

const ITEMS: { title: string; body: string; art: ReactNode }[] = [
  {
    title: "Five modes, one composer",
    body: "Agent, Plan, Ask, Debug, and Multitask. Each mode sets what the agent may touch and how hard it thinks.",
    art: <ModesArt />,
  },
  {
    title: "You set the leash",
    body: "Supervised, auto-accept edits, auto, or full access. Risky commands are flagged before they run.",
    art: <AccessArt />,
  },
  {
    title: "MCP tools",
    body: "Connect MCP servers and agents call them like built-in tools, gated by the same permissions.",
    art: <McpArt />,
  },
  {
    title: "@-mention anything",
    body: "Pull files into the conversation with @, with a code preview before you send.",
    art: <MentionArt />,
  },
  {
    title: "Queue the next step",
    body: "Type your follow-up while the agent works. It runs as soon as the current turn ends.",
    art: <QueueArt />,
  },
  {
    title: "See the context",
    body: "A live meter shows how much of the model's context each chat is using, before it runs out.",
    art: <ContextArt />,
  },
];

export function Capabilities() {
  const ref = useRef<HTMLElement>(null);

  // each drawing inks itself in as its cell scrolls up, then the copy follows
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        for (const cell of gsap.utils.toArray<HTMLElement>(
          "[data-cap]",
          ref.current,
        )) {
          const tl = gsap.timeline({
            scrollTrigger: { trigger: cell, start: "top 85%", once: true },
          });
          tl.from(cell.querySelectorAll("[data-ink]"), {
            drawSVG: 0,
            duration: 1.4,
            stagger: 0.05,
            ease: "power2.inOut",
          })
            .from(
              cell.querySelectorAll("[data-pop]"),
              {
                scale: 0,
                transformOrigin: "50% 50%",
                duration: 0.8,
                stagger: 0.04,
                ease: "back.out(2)",
              },
              0.5,
            )
            .from(
              cell.querySelectorAll("[data-fade]"),
              { autoAlpha: 0, duration: 1.2, stagger: 0.05 },
              0,
            )
            .from(
              cell.querySelectorAll("[data-copy]"),
              { y: 14, autoAlpha: 0, stagger: 0.08, duration: 1 },
              0.4,
            );
        }
      });
    },
    { scope: ref },
  );

  return (
    <section ref={ref} className={cn(COLUMN, "relative pt-24 md:pt-32")}>
      <SectionHeading
        title={
          <>
            Everything an agent needs.
            <br />
            <span className="text-white/40">Nothing it shouldn't do.</span>
          </>
        }
        body="Modes, permissions, tools, and context are first-class in Volt, so you decide how much rope each chat gets."
      />
      <ul className="mt-14 grid grid-cols-1 gap-px border border-white/[0.08] bg-white/[0.08] sm:grid-cols-2 md:mt-20 lg:grid-cols-3">
        {ITEMS.map((item) => (
          <li
            key={item.title}
            data-cap
            className="group flex flex-col bg-[#0a0d0c] px-7 pt-10 pb-9 md:px-9"
          >
            <div className="flex h-[180px] items-center justify-center text-white/75 transition-colors duration-500 group-hover:text-white sm:h-[190px]">
              {item.art}
            </div>
            <h3
              data-copy
              className="mt-8 text-[15.5px] font-medium tracking-[-0.01em] text-white"
            >
              {item.title}
            </h3>
            <p
              data-copy
              className="mt-2 max-w-sm text-pretty text-[13.5px] leading-relaxed text-white/45"
            >
              {item.body}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Drawings                                                            */
/*                                                                     */
/* Each one is 240×180 on the same construction: a faded dot grid,     */
/* guide rings, hairline strokes in currentColor, and one orange       */
/* accent with a soft glow. Motion runs off a loop clock while the     */
/* cell is on screen, so every drawing tells its feature as a story.   */
/* ------------------------------------------------------------------ */

const ACCENT = "#ff8a5a";
const GOOD = "#3ecf8e";
const CX = 120;
const CY = 90;

const ease = (x: number) => x * x * (3 - 2 * x);
const f1 = (n: number) => Math.round(n * 10) / 10;
const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [f1(cx + Math.cos(a) * r), f1(cy + Math.sin(a) * r)] as const;
};

/** Per-drawing ids for gradients, masks, and filters. */
function useIds() {
  const base = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (name: string) => `${base}-${name}`;
}
type Ids = ReturnType<typeof useIds>;

function Art({
  clockRef,
  ids,
  rings = [44, 78],
  children,
}: {
  clockRef: RefObject<HTMLDivElement | null>;
  ids: Ids;
  rings?: number[];
  children: ReactNode;
}) {
  return (
    <div ref={clockRef} className="h-full w-full">
      <svg
        viewBox="0 0 240 180"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="mx-auto h-full w-auto max-w-full overflow-visible"
      >
        <defs>
          <pattern
            id={ids("dots")}
            width={8}
            height={8}
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx={1}
              cy={1}
              r={0.6}
              fill="currentColor"
              fillOpacity={0.28}
              stroke="none"
            />
          </pattern>
          <radialGradient id={ids("fade")}>
            <stop offset={0} stopColor="#fff" />
            <stop offset={1} stopColor="#fff" stopOpacity={0} />
          </radialGradient>
          <mask id={ids("vignette")}>
            <rect width={240} height={180} fill={`url(#${ids("fade")})`} />
          </mask>
          <radialGradient id={ids("glow")}>
            <stop offset={0} stopColor={ACCENT} stopOpacity={0.45} />
            <stop offset={1} stopColor={ACCENT} stopOpacity={0} />
          </radialGradient>
          <radialGradient id={ids("light")}>
            <stop offset={0} stopColor="#fff" stopOpacity={0.09} />
            <stop offset={1} stopColor="#fff" stopOpacity={0} />
          </radialGradient>
          <linearGradient id={ids("node")} x1={0} y1={0} x2={0} y2={1}>
            <stop offset={0} stopColor="#1b201e" />
            <stop offset={1} stopColor="#0c0f0e" />
          </linearGradient>
          <linearGradient id={ids("heat")} x1={0} y1={0} x2={1} y2={0}>
            <stop offset={0} stopColor="#fff" stopOpacity={0.55} />
            <stop offset={1} stopColor={ACCENT} />
          </linearGradient>
          <filter
            id={ids("blur")}
            x="-100%"
            y="-100%"
            width="300%"
            height="300%"
          >
            <feGaussianBlur stdDeviation={3} />
          </filter>
        </defs>

        {/* construction: dot grid, soft centre light, guide rings, crosshair */}
        <rect
          width={240}
          height={180}
          fill={`url(#${ids("dots")})`}
          stroke="none"
          mask={`url(#${ids("vignette")})`}
        />
        <circle
          cx={CX}
          cy={CY}
          r={70}
          fill={`url(#${ids("light")})`}
          stroke="none"
        />
        {rings.map((r) => (
          <circle key={r} data-ink cx={CX} cy={CY} r={r} strokeOpacity={0.08} />
        ))}
        <path data-ink d={`M${CX} 4V176M22 ${CY}H218`} strokeOpacity={0.06} />
        {children}
      </svg>
    </div>
  );
}

/** Rounded node with the shared gradient fill; lit nodes get an accent ring and glow. */
function Node({
  ids,
  x,
  y,
  w = 26,
  h = 26,
  r = 8,
  lit,
  children,
}: {
  ids: Ids;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  lit?: boolean;
  children?: ReactNode;
}) {
  return (
    <g data-pop>
      <circle
        cx={x}
        cy={y}
        r={Math.max(w, h) * 0.95}
        fill={`url(#${ids("glow")})`}
        stroke="none"
        className="transition-opacity duration-500"
        opacity={lit ? 1 : 0}
      />
      <rect
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        rx={r}
        fill={`url(#${ids("node")})`}
        stroke={lit ? ACCENT : "currentColor"}
        strokeOpacity={lit ? 1 : 0.3}
        className="transition-[stroke,stroke-opacity] duration-500"
      />
      <g
        transform={`translate(${x - 6} ${y - 6})`}
        stroke={lit ? ACCENT : "currentColor"}
        strokeOpacity={lit ? 1 : 0.85}
        strokeWidth={1.15}
        className="transition-[stroke] duration-500"
      >
        {children}
      </g>
    </g>
  );
}

function Text({
  x,
  y,
  children,
  tone = 0.45,
  color,
  size = 6.5,
  anchor = "middle",
}: {
  x: number;
  y: number;
  children: ReactNode;
  tone?: number;
  color?: string;
  size?: number;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      stroke="none"
      fill={color ?? "currentColor"}
      fillOpacity={color ? 1 : tone}
      className="font-mono uppercase transition-[fill,fill-opacity] duration-500"
      style={{ fontSize: size, letterSpacing: "0.12em" }}
    >
      {children}
    </text>
  );
}

/* 12×12 glyphs, drawn in the node's local box */
const GLYPH = {
  agent: (
    <path d="M6 0.5 7.3 4.7 11.5 6 7.3 7.3 6 11.5 4.7 7.3 0.5 6 4.7 4.7Z" />
  ),
  plan: (
    <path d="M1 2.5h1.5M4.5 2.5H11M1 6h1.5M4.5 6H11M1 9.5h1.5M4.5 9.5h4.5" />
  ),
  ask: (
    <path d="M3.8 4.2a2.3 2.3 0 1 1 3.4 2c-.7.4-1.2.9-1.2 1.7v.4M6 10.6v.1" />
  ),
  debug: (
    <>
      <rect x={3.2} y={3.2} width={5.6} height={7.6} rx={2.8} />
      <path d="M6 5.5v4M3.2 6.5H1M11 6.5H8.8M3.4 9.2 1.6 10.6M8.6 9.2l1.8 1.4M4.3 3.4 3.2 1.4M7.7 3.4l1.1-2" />
    </>
  ),
  multi: (
    <>
      <rect x={0.8} y={3.6} width={7.6} height={7.6} rx={1.8} />
      <path d="M3.6 3.6V2.6A1.8 1.8 0 0 1 5.4.8h4A1.8 1.8 0 0 1 11.2 2.6v4a1.8 1.8 0 0 1-1.8 1.8H8.4" />
    </>
  ),
  plug: <path d="M4 .8v3M8 .8v3M2 3.8h8v2.4a4 4 0 0 1-8 0zM6 10.2v1.2" />,
  db: (
    <>
      <ellipse cx={6} cy={2.6} rx={4.4} ry={1.8} />
      <path d="M1.6 2.6v6.8c0 1 2 1.8 4.4 1.8s4.4-.8 4.4-1.8V2.6M1.6 6c0 1 2 1.8 4.4 1.8s4.4-.8 4.4-1.8" />
    </>
  ),
  web: (
    <>
      <circle cx={6} cy={6} r={5} />
      <path d="M1 6h10M6 1c-2.6 2.8-2.6 7.2 0 10M6 1c2.6 2.8 2.6 7.2 0 10" />
    </>
  ),
  shell: (
    <>
      <rect x={0.6} y={1.4} width={10.8} height={9.2} rx={2} />
      <path d="m3 4.6 1.8 1.6L3 7.8M6.2 8h2.8" />
    </>
  ),
  doc: (
    <path d="M2.4.8h4.8L9.8 3.4v7.8H2.4zM7 .8v2.8h2.8M4.2 6.4h3.8M4.2 8.6h2.6" />
  ),
};

/* 1 · Modes ---------------------------------------------------------- */

const MODES: { name: string; glyph: ReactNode }[] = [
  { name: "Agent", glyph: GLYPH.agent },
  { name: "Plan", glyph: GLYPH.plan },
  { name: "Ask", glyph: GLYPH.ask },
  { name: "Debug", glyph: GLYPH.debug },
  { name: "Multitask", glyph: GLYPH.multi },
];

function ModesArt() {
  const ids = useIds();
  const { ref, t } = useLoopClock(MODES.length * 1800, 0);
  const active = Math.floor(t / 1800) % MODES.length;
  const R = 62;
  return (
    <Art clockRef={ref} ids={ids} rings={[40, 84]}>
      <circle
        data-fade
        cx={CX}
        cy={CY}
        r={R}
        strokeOpacity={0.35}
        strokeDasharray="1 5"
        className="cap-orbit"
      />
      {MODES.map((m, i) => {
        const deg = -90 + i * 72;
        const [x, y] = polar(CX, CY, R, deg);
        const [x1, y1] = polar(CX, CY, 24, deg);
        const [x2, y2] = polar(CX, CY, R - 16, deg);
        const lit = i === active;
        return (
          <g key={m.name}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={lit ? ACCENT : "currentColor"}
              strokeOpacity={lit ? 0.9 : 0.18}
              className="transition-[stroke,stroke-opacity] duration-500"
            />
            <Node ids={ids} x={x} y={y} r={13} lit={lit}>
              {m.glyph}
            </Node>
          </g>
        );
      })}
      {/* the composer at the centre, wearing the active mode */}
      <g data-pop>
        <rect
          x={CX - 22}
          y={CY - 11}
          width={44}
          height={22}
          rx={11}
          fill={`url(#${ids("node")})`}
          strokeOpacity={0.4}
        />
        <path d={`M${CX - 13} ${CY}h14`} strokeOpacity={0.35} />
        <circle
          cx={CX + 11}
          cy={CY}
          r={5.5}
          fill="currentColor"
          stroke="none"
          fillOpacity={0.9}
        />
        <path
          d={`M${CX + 11} ${CY + 2.4}v-4.6M${CX + 9} ${CY - 0.2} ${CX + 11} ${CY - 2.2} ${CX + 13} ${CY - 0.2}`}
          stroke="#0c0f0e"
          strokeWidth={1.3}
        />
      </g>
      <Text x={CX} y={CY + 23} color={ACCENT}>
        {MODES[active].name}
      </Text>
    </Art>
  );
}

/* 2 · Access --------------------------------------------------------- */

const LEVELS = ["Supervised", "Edits", "Auto", "Full"];
const LEVEL_DEG = [210, 250, 290, 330];

function AccessArt() {
  const ids = useIds();
  const { ref, t } = useLoopClock(LEVELS.length * 2000, 2 * 2000);
  const level = Math.floor(t / 2000) % LEVELS.length;
  const from = LEVEL_DEG[(level + LEVELS.length - 1) % LEVELS.length];
  const to = LEVEL_DEG[level];
  const deg = from + (to - from) * ease(Math.min(1, (t % 2000) / 650));
  const px = CX;
  const py = 126;
  const R = 74;
  const [nx, ny] = polar(px, py, R - 14, deg);
  const [ax, ay] = polar(px, py, R, 195);
  const [bx, by] = polar(px, py, R, deg);
  const [ex, ey] = polar(px, py, R, 345);
  const full = level === LEVELS.length - 1;
  return (
    <Art clockRef={ref} ids={ids} rings={[84]}>
      {/* track and the lit part of it */}
      <path
        data-ink
        d={`M${ax} ${ay}A${R} ${R} 0 0 1 ${ex} ${ey}`}
        strokeOpacity={0.16}
      />
      <path
        d={`M${ax} ${ay}A${R} ${R} 0 0 1 ${bx} ${by}`}
        stroke={`url(#${ids("heat")})`}
        strokeWidth={1.6}
      />
      {LEVELS.map((name, i) => {
        const [dx, dy] = polar(px, py, R, LEVEL_DEG[i]);
        const [lx, ly] = polar(px, py, R + 12, LEVEL_DEG[i]);
        const on = i <= level;
        return (
          <g key={name}>
            <circle
              data-pop
              cx={dx}
              cy={dy}
              r={2.6}
              fill={on ? (i === 3 ? ACCENT : "currentColor") : "#0c0f0e"}
              strokeOpacity={0.5}
            />
            <Text
              x={lx}
              y={ly + 2}
              anchor={i === 0 ? "end" : i === 3 ? "start" : "middle"}
              tone={i === level ? 0.95 : 0.35}
              color={i === level && i === 3 ? ACCENT : undefined}
              size={5.8}
            >
              {name}
            </Text>
          </g>
        );
      })}
      {/* needle and the shield it pivots on */}
      <line
        x1={px}
        y1={py}
        x2={nx}
        y2={ny}
        stroke={full ? ACCENT : "currentColor"}
        strokeOpacity={0.9}
      />
      <circle
        cx={nx}
        cy={ny}
        r={2.4}
        fill={full ? ACCENT : "currentColor"}
        stroke="none"
      />
      <g data-pop>
        <circle
          cx={px}
          cy={py}
          r={16}
          fill={`url(#${ids("node")})`}
          strokeOpacity={0.35}
        />
        <path
          d={`M${px} ${py - 8}l6 2.4v4c0 3.8-2.5 6.3-6 7.6-3.5-1.3-6-3.8-6-7.6v-4z`}
          strokeOpacity={0.9}
        />
        <path
          d={`m${px - 2.6} ${py - 0.6} 1.9 1.9 3.5-3.7`}
          stroke={full ? ACCENT : GOOD}
        />
      </g>
      {/* at full access, the risky command gets flagged */}
      <g
        className="transition-[opacity,transform] duration-500"
        opacity={full ? 1 : 0}
        style={{ transform: `translateY(${full ? 0 : 4}px)` }}
      >
        <rect
          x={CX - 40}
          y={150}
          width={80}
          height={17}
          rx={8.5}
          fill="#0c0f0e"
          stroke={ACCENT}
          className="cap-pulse"
        />
        <path
          d={`M${CX - 30} 162l3.6-6.4 3.6 6.4z M${CX - 26.4} 158.2v1.4`}
          stroke={ACCENT}
        />
        <text
          x={CX - 19}
          y={161}
          stroke="none"
          fill={ACCENT}
          className="font-mono"
          style={{ fontSize: 7 }}
        >
          rm -rf dist
        </text>
      </g>
    </Art>
  );
}

/* 3 · MCP ------------------------------------------------------------ */

const TOOLS: {
  x: number;
  y: number;
  name: string;
  glyph: ReactNode;
  d: string;
}[] = [
  {
    x: 42,
    y: 40,
    name: "db",
    glyph: GLYPH.db,
    d: "M55 40H106Q112 40 112 46V70",
  },
  {
    x: 198,
    y: 40,
    name: "web",
    glyph: GLYPH.web,
    d: "M185 40H134Q128 40 128 46V70",
  },
  {
    x: 42,
    y: 140,
    name: "shell",
    glyph: GLYPH.shell,
    d: "M55 140H106Q112 140 112 134V110",
  },
  {
    x: 198,
    y: 140,
    name: "docs",
    glyph: GLYPH.doc,
    d: "M185 140H134Q128 140 128 134V110",
  },
];

function McpArt() {
  const ids = useIds();
  const { ref, t } = useLoopClock(4 * 1500, 0);
  const busy = Math.floor(t / 1500) % TOOLS.length;
  return (
    <Art clockRef={ref} ids={ids} rings={[58]}>
      {TOOLS.map((tool, i) => (
        <g key={tool.name}>
          <path
            data-ink
            d={tool.d}
            stroke={i === busy ? ACCENT : "currentColor"}
            strokeOpacity={i === busy ? 0.7 : 0.22}
            className="transition-[stroke,stroke-opacity] duration-500"
          />
          {/* packets: requests out to the tool, results back to the hub */}
          {[0, 1].map((k) => (
            <circle key={k} r={1.9} fill={ACCENT} stroke="none" opacity={0}>
              <animateMotion
                dur="2.4s"
                begin={`${i * 0.6 + k * 1.2}s`}
                repeatCount="indefinite"
                path={tool.d}
                keyPoints={k ? "0;1" : "1;0"}
                keyTimes="0;1"
                calcMode="linear"
              />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.15;0.85;1"
                dur="2.4s"
                begin={`${i * 0.6 + k * 1.2}s`}
                repeatCount="indefinite"
              />
            </circle>
          ))}
          <Node ids={ids} x={tool.x} y={tool.y} lit={i === busy}>
            {tool.glyph}
          </Node>
          <Text x={tool.x} y={tool.y + 24} tone={i === busy ? 0.9 : 0.4}>
            {tool.name}
          </Text>
        </g>
      ))}
      {/* the hub: a soft ping each time it hands off a call */}
      <rect
        x={CX - 20}
        y={CY - 20}
        width={40}
        height={40}
        rx={12}
        stroke={ACCENT}
        className="cap-ping"
      />
      <Node ids={ids} x={CX} y={CY} w={40} h={40} r={12} lit>
        {GLYPH.plug}
      </Node>
    </Art>
  );
}

/* 4 · @-mention ------------------------------------------------------ */

const FILES = [
  { name: "auth.ts", dir: "src/lib" },
  { name: "db.ts", dir: "src/lib" },
  { name: "README.md", dir: "." },
];
/** Rough line lengths for each file's preview. */
const PREVIEW = [
  [0.7, 0.45, 0.85, 0.6, 0.3, 0.75, 0.5],
  [0.55, 0.9, 0.4, 0.7, 0.65, 0.35, 0.8],
  [0.9, 0.8, 0.95, 0.4, 0.85, 0.7, 0.6],
];

function MentionArt() {
  const ids = useIds();
  const { ref, t } = useLoopClock(7200, 4600);
  const typed = t >= 500;
  const open = t >= 900 && t < 3500;
  const row = t < 1900 ? 0 : 1;
  const picked = t >= 3100;
  const chip = t >= 3500;
  const popY = open ? 0 : 6;
  return (
    <Art clockRef={ref} ids={ids} rings={[]}>
      {/* popover with the file list, and the preview of the highlighted file */}
      <g
        className="transition-[opacity,transform] duration-300"
        opacity={open ? 1 : 0}
        style={{ transform: `translateY(${popY}px)` }}
      >
        <rect
          x={28}
          y={26}
          width={114}
          height={88}
          rx={10}
          fill="#0e1110"
          strokeOpacity={0.3}
        />
        <rect
          x={33}
          y={33 + row * 26}
          width={104}
          height={22}
          rx={6}
          fill={picked ? ACCENT : "currentColor"}
          fillOpacity={picked ? 0.18 : 0.07}
          stroke="none"
          className="transition-all duration-300"
        />
        {FILES.map((file, i) => (
          <g key={file.name} transform={`translate(0 ${i * 26})`}>
            <g transform="translate(40 38)" strokeOpacity={0.8} strokeWidth={1}>
              {GLYPH.doc}
            </g>
            <text
              x={58}
              y={46}
              stroke="none"
              fill={i === row && picked ? ACCENT : "currentColor"}
              fillOpacity={i === row ? 1 : 0.7}
              className="font-mono"
              style={{ fontSize: 7.5 }}
            >
              {file.name}
            </text>
            <text
              x={132}
              y={46}
              textAnchor="end"
              stroke="none"
              fill="currentColor"
              fillOpacity={0.3}
              className="font-mono"
              style={{ fontSize: 6 }}
            >
              {file.dir}
            </text>
          </g>
        ))}
        <rect
          x={148}
          y={26}
          width={66}
          height={88}
          rx={10}
          fill="#0e1110"
          strokeOpacity={0.3}
        />
        {PREVIEW[row].map((w, i) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: static preview lines
            key={i}
            x={156 + (i % 3 === 2 ? 6 : 0)}
            y={36 + i * 10.5}
            width={f1(46 * w)}
            height={3}
            rx={1.5}
            fill={i === 2 ? ACCENT : "currentColor"}
            fillOpacity={i === 2 ? 0.7 : 0.28}
            stroke="none"
            className="transition-[width] duration-300"
          />
        ))}
      </g>

      {/* the composer */}
      <g data-pop>
        <rect
          x={28}
          y={126}
          width={186}
          height={30}
          rx={15}
          fill={`url(#${ids("node")})`}
          strokeOpacity={0.35}
        />
        {chip ? (
          <g className="animate-[fadeIn_.3s_ease-out]">
            <rect
              x={38}
              y={133}
              width={50}
              height={16}
              rx={5}
              fill={ACCENT}
              fillOpacity={0.14}
              stroke={ACCENT}
              strokeOpacity={0.6}
            />
            <text
              x={44}
              y={144}
              stroke="none"
              fill={ACCENT}
              className="font-mono"
              style={{ fontSize: 7.5 }}
            >
              @db.ts
            </text>
            <text
              x={94}
              y={144}
              stroke="none"
              fill="currentColor"
              fillOpacity={0.5}
              className="font-mono"
              style={{ fontSize: 7.5 }}
            >
              add an index
            </text>
          </g>
        ) : (
          <>
            {typed ? (
              <text
                x={40}
                y={144}
                stroke="none"
                fill={ACCENT}
                className="font-mono"
                style={{ fontSize: 8 }}
              >
                @
              </text>
            ) : null}
            <rect
              x={typed ? 47 : 40}
              y={135}
              width={1.3}
              height={12}
              fill="currentColor"
              stroke="none"
              opacity={t % 1000 < 550 ? 0.9 : 0}
            />
          </>
        )}
        <circle
          cx={201}
          cy={141}
          r={9}
          fill="currentColor"
          fillOpacity={0.9}
          stroke="none"
        />
        <path
          d="M201 145v-8M197.6 140.4 201 137l3.4 3.4"
          stroke="#0c0f0e"
          strokeWidth={1.4}
        />
      </g>
    </Art>
  );
}

/* 5 · Queue ---------------------------------------------------------- */

const FOLLOW_UPS = [
  "add tests for the limiter",
  "update the README",
  "open a pull request",
  "write the changelog",
  "bump the version",
];
const CYCLE = 2800;
const SLOT_Y = [106, 76, 46, 16];

function QueueArt() {
  const ids = useIds();
  const { ref, t } = useLoopClock(CYCLE * FOLLOW_UPS.length, 0);
  const k = Math.floor(t / CYCLE);
  const p = (t % CYCLE) / CYCLE;
  const shift = ease(Math.min(1, Math.max(0, (p - 0.55) / 0.3)));
  const done = p > 0.38 && p < 0.62;
  return (
    <Art clockRef={ref} ids={ids} rings={[]}>
      <line data-ink x1={CX} y1={8} x2={CX} y2={172} strokeOpacity={0.1} />
      {[0, 1, 2, 3].map((j) => {
        const text = FOLLOW_UPS[(k + j) % FOLLOW_UPS.length];
        // slot 0 slides into the runner and fades; slot 3 arrives from above
        const y =
          j === 0
            ? SLOT_Y[0] + (146 - SLOT_Y[0]) * shift
            : SLOT_Y[j] + (SLOT_Y[j - 1] - SLOT_Y[j]) * shift;
        const opacity = j === 0 ? 1 - shift : j === 3 ? shift : 1;
        const scale = j === 0 ? 1 - 0.4 * shift : 1;
        return (
          <g
            key={`${k}-${j}`}
            opacity={opacity}
            transform={`translate(${CX} ${f1(y)}) scale(${f1(scale * 100) / 100})`}
          >
            <rect
              x={-72}
              y={-10}
              width={144}
              height={20}
              rx={10}
              fill={`url(#${ids("node")})`}
              stroke={j === 0 ? ACCENT : "currentColor"}
              strokeOpacity={j === 0 ? 0.8 : 0.3 - j * 0.05}
            />
            <circle
              cx={-62}
              cy={0}
              r={1.8}
              fill={j === 0 ? ACCENT : "currentColor"}
              fillOpacity={j === 0 ? 1 : 0.4}
              stroke="none"
            />
            <text
              x={-55}
              y={2.6}
              stroke="none"
              fill="currentColor"
              fillOpacity={j === 0 ? 0.95 : 0.55 - j * 0.1}
              className="font-mono"
              style={{ fontSize: 7 }}
            >
              {text}
            </text>
          </g>
        );
      })}
      {/* the running turn: a spinner, then a check as it finishes */}
      <g data-pop>
        <circle
          cx={CX}
          cy={148}
          r={16}
          fill={`url(#${ids("node")})`}
          strokeOpacity={0.35}
        />
        {done ? (
          <path
            d={`m${CX - 5} 148 3.4 3.4 6.8-7`}
            stroke={GOOD}
            strokeWidth={1.5}
          />
        ) : (
          <>
            <circle cx={CX} cy={148} r={7} strokeOpacity={0.15} />
            <path
              d={`M${CX} 141a7 7 0 0 1 7 7`}
              stroke={ACCENT}
              strokeWidth={1.5}
              className="cap-spin"
            />
          </>
        )}
      </g>
      <Text x={CX + 26} y={150} anchor="start" tone={0.4}>
        {done ? "done" : "running"}
      </Text>
      <Text x={CX + 80} y={SLOT_Y[1] + 2} anchor="start" tone={0.3}>
        queued
      </Text>
    </Art>
  );
}

/* 6 · Context -------------------------------------------------------- */

const TICKS = 48;

function ContextArt() {
  const ids = useIds();
  const { ref, t } = useLoopClock(7600, 5600);
  const grow = ease(Math.min(1, Math.max(0, (t - 300) / 5000)));
  const fading = t > 6800 ? (t - 6800) / 800 : 0;
  const pct = Math.round(6 + 66 * grow);
  const R = 50;
  const start = 135;
  const sweep = 270;
  const [sx, sy] = polar(CX, 84, R, start);
  const [ex, ey] = polar(CX, 84, R, start + sweep * (pct / 100));
  const [tx, ty] = polar(CX, 84, R, start + sweep);
  const large = sweep * (pct / 100) > 180 ? 1 : 0;
  const parts = [0.18, 0.46, 0.36];
  return (
    <Art clockRef={ref} ids={ids} rings={[]}>
      <g opacity={1 - fading}>
        {Array.from({ length: TICKS + 1 }, (_, i) => {
          const at = i / TICKS;
          const deg = start + sweep * at;
          const major = i % 6 === 0;
          const [x1, y1] = polar(CX, 84, 58, deg);
          const [x2, y2] = polar(CX, 84, major ? 66 : 62, deg);
          const lit = at <= pct / 100;
          return (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed dial ticks
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={lit && at > 0.8 ? ACCENT : "currentColor"}
              strokeOpacity={lit ? 0.75 : 0.14}
            />
          );
        })}
        <path
          data-ink
          d={`M${sx} ${sy}A${R} ${R} 0 1 1 ${tx} ${ty}`}
          strokeOpacity={0.12}
        />
        <path
          d={`M${sx} ${sy}A${R} ${R} 0 ${large} 1 ${ex} ${ey}`}
          stroke={`url(#${ids("heat")})`}
          strokeWidth={2}
        />
        <circle
          cx={ex}
          cy={ey}
          r={6}
          fill={`url(#${ids("glow")})`}
          stroke="none"
        />
        <circle cx={ex} cy={ey} r={2.6} fill={ACCENT} stroke="none" />
        <text
          x={CX}
          y={90}
          textAnchor="middle"
          stroke="none"
          fill="currentColor"
          className="font-mono"
          style={{ fontSize: 17 }}
        >
          {pct}%
        </text>
        <Text x={CX} y={102} tone={0.4} size={5.8}>
          of 200K
        </Text>
        {/* what the context is made of */}
        <g transform="translate(70 150)">
          {parts.map((w, i) => {
            const x =
              parts.slice(0, i).reduce((a, b) => a + b, 0) * 100 * (pct / 100);
            return (
              <rect
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments
                key={i}
                x={f1(x)}
                y={0}
                width={f1(Math.max(0, w * 100 * (pct / 100) - 1))}
                height={4}
                rx={2}
                fill={i === 2 ? ACCENT : "currentColor"}
                fillOpacity={i === 2 ? 0.85 : 0.25 + i * 0.2}
                stroke="none"
              />
            );
          })}
          <rect
            x={0}
            y={0}
            width={100}
            height={4}
            rx={2}
            strokeOpacity={0.12}
            fill="none"
          />
          {["system", "files", "chat"].map((label, i) => (
            <Text
              key={label}
              x={i * 38}
              y={16}
              anchor="start"
              size={5.4}
              tone={0.4}
            >
              {label}
            </Text>
          ))}
        </g>
      </g>
    </Art>
  );
}
