import { type ReactNode, useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";
import { SectionHeading } from "./primitives";

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
            <div className="flex h-[170px] items-center justify-center text-white/70 transition-colors duration-500 group-hover:text-white/90">
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
/* Drawings: 200×170, 1px strokes in currentColor, one orange accent  */
/* ------------------------------------------------------------------ */

const ACCENT = "#ff8a5a";
const BG = "#0a0d0c";

function Art({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 200 170"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-full w-auto overflow-visible"
    >
      {children}
    </svg>
  );
}

/** Subtle solid orbit that turns slowly around its own centre. */
function Orbit({ r, speed = 60 }: { r: number; speed?: number }) {
  return (
    <circle
      data-fade
      cx={100}
      cy={85}
      r={r}
      strokeOpacity={0.32}
      className="cap-orbit"
      style={{ animationDuration: `${speed}s` }}
    />
  );
}

/** Registration tick where an axis crosses a ring: short bar plus a small dot. */
function Tick({
  x,
  y,
  vertical,
}: {
  x: number;
  y: number;
  vertical?: boolean;
}) {
  return (
    <g data-pop>
      {vertical ? (
        <line x1={x} y1={y - 6} x2={x} y2={y + 6} />
      ) : (
        <line x1={x - 6} y1={y} x2={x + 6} y2={y} />
      )}
      <circle cx={x} cy={y} r={2.2} fill={BG} />
    </g>
  );
}

function Node({
  x,
  y,
  r = 11,
  accent,
  children,
}: {
  x: number;
  y: number;
  r?: number;
  accent?: boolean;
  children?: ReactNode;
}) {
  return (
    <g data-pop>
      <circle
        cx={x}
        cy={y}
        r={r}
        fill={BG}
        stroke={accent ? ACCENT : undefined}
      />
      {children}
    </g>
  );
}

function Label({
  x,
  y,
  children,
  accent,
}: {
  x: number;
  y: number;
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <text
      x={x}
      y={y + 3}
      textAnchor="middle"
      stroke="none"
      fill={accent ? ACCENT : "currentColor"}
      className="font-mono text-[8.5px]"
    >
      {children}
    </text>
  );
}

function ModesArt() {
  const modes = ["A", "P", "?", "D", "M"];
  const R = 56;
  return (
    <Art>
      <Orbit r={R} />
      <circle data-ink cx={100} cy={85} r={30} strokeOpacity={0.35} />
      {modes.map((m, i) => {
        const a = (-90 + i * 72) * (Math.PI / 180);
        const x = 100 + Math.cos(a) * R;
        const y = 85 + Math.sin(a) * R;
        return (
          <g key={m}>
            <line
              data-fade
              x1={100 + Math.cos(a) * 20}
              y1={85 + Math.sin(a) * 20}
              x2={x - Math.cos(a) * 11}
              y2={y - Math.sin(a) * 11}
              strokeOpacity={i === 0 ? 0.9 : 0.4}
              stroke={i === 0 ? ACCENT : undefined}
            />
            <Node x={x} y={y} accent={i === 0}>
              <Label x={x} y={y} accent={i === 0}>
                {m}
              </Label>
            </Node>
          </g>
        );
      })}
      <Node x={100} y={85} r={18}>
        {/* composer: a rounded field with a send arrow */}
        <rect x={89} y={80} width={22} height={10} rx={5} />
        <path d="M100 76v-6M97.5 72.5 100 70l2.5 2.5" />
      </Node>
    </Art>
  );
}

function AccessArt() {
  return (
    <Art>
      <Orbit r={58} speed={80} />
      <circle data-ink cx={100} cy={85} r={38} strokeOpacity={0.5} />
      {/* current level: an arc from supervised to auto */}
      <path
        data-ink
        d="M100 47 A38 38 0 0 1 138 85"
        stroke={ACCENT}
      />
      <Tick x={100} y={27} vertical />
      <Tick x={100} y={143} vertical />
      <Tick x={42} y={85} />
      <Tick x={158} y={85} />
      <circle data-pop cx={138} cy={85} r={3} fill={ACCENT} stroke="none" />
      <path
        data-ink
        d="M100 66 115 72v11c0 9.5-6.4 16-15 19-8.6-3-15-9.5-15-19V72z"
      />
      <path data-ink d="m93.5 85 4.5 4.5 8.5-9" stroke={ACCENT} />
    </Art>
  );
}

function McpArt() {
  const sats: [number, number][] = [
    [40, 38],
    [160, 38],
    [40, 132],
    [160, 132],
  ];
  return (
    <Art>
      <rect
        data-fade
        x={22}
        y={20}
        width={156}
        height={130}
        rx={10}
        strokeOpacity={0.32}
      />
      {sats.map(([x, y]) => (
        <path
          key={`${x}-${y}`}
          data-fade
          d={`M${x < 100 ? x + 11 : x - 11} ${y} H${x < 100 ? 80 : 120} V${y < 85 ? 71 : 99}`}
          strokeOpacity={0.4}
        />
      ))}
      {sats.map(([x, y], i) => (
        <g key={`n-${x}-${y}`} data-pop>
          <rect x={x - 11} y={y - 11} width={22} height={22} rx={6} fill={BG} />
          {/* tiny tool glyphs: db, globe, terminal, doc */}
          {i === 0 ? (
            <path
              d={`M${x - 5} ${y - 4}c0-2 10-2 10 0v8c0 2-10 2-10 0zM${x - 5} ${y}c0 2 10 2 10 0`}
            />
          ) : i === 1 ? (
            <>
              <circle cx={x} cy={y} r={5} />
              <path
                d={`M${x - 5} ${y}h10M${x} ${y - 5}c-3 3-3 7 0 10M${x} ${y - 5}c3 3 3 7 0 10`}
              />
            </>
          ) : i === 2 ? (
            <path d={`m${x - 5} ${y - 3} 3 3-3 3M${x} ${y + 3}h5`} />
          ) : (
            <path d={`M${x - 4} ${y - 5}h5l3 3v7h-8zM${x - 2} ${y + 1}h4`} />
          )}
        </g>
      ))}
      <g data-pop>
        <rect
          x={80}
          y={65}
          width={40}
          height={40}
          rx={10}
          fill={BG}
          stroke={ACCENT}
        />
        <path
          d="M95 76v6M105 76v6M92 82h16v4a8 8 0 0 1-16 0zM100 94v4"
          stroke={ACCENT}
        />
      </g>
    </Art>
  );
}

function MentionArt() {
  return (
    <Art>
      <Orbit r={60} speed={90} />
      <line
        data-fade
        x1={18}
        y1={85}
        x2={182}
        y2={85}
        strokeOpacity={0.32}
      />
      <Tick x={40} y={85} vertical />
      <Tick x={160} y={85} vertical />
      <g data-pop>
        <rect x={78} y={54} width={44} height={62} rx={5} fill={BG} />
        <path
          d="M86 66h20M86 74h28M86 82h14M86 90h24M86 98h18M86 106h22"
          strokeOpacity={0.6}
        />
        <path d="M86 82h14" stroke={ACCENT} />
      </g>
      <Node x={40} y={85} r={14} accent>
        <Label x={40} y={85} accent>
          @
        </Label>
      </Node>
      <Node x={160} y={85} r={14}>
        <path d="M155 79h7l3 3v9h-10z" />
      </Node>
    </Art>
  );
}

function QueueArt() {
  return (
    <Art>
      <line
        data-fade
        x1={100}
        y1={8}
        x2={100}
        y2={162}
        strokeOpacity={0.32}
      />
      <Tick x={100} y={20} />
      {[0, 1, 2].map((i) => (
        <g key={i} data-pop>
          <rect
            x={58 + i * 4}
            y={34 + i * 22}
            width={84 - i * 8}
            height={18}
            rx={9}
            fill={BG}
            strokeOpacity={i === 2 ? 1 : 0.45}
            stroke={i === 2 ? ACCENT : undefined}
          />
          <path
            d={`M${70 + i * 4} ${43 + i * 22}h${30 - i * 4}`}
            strokeOpacity={i === 2 ? 0.9 : 0.4}
          />
        </g>
      ))}
      <path
        data-ink
        d="M100 102v14M95.5 111.5 100 116l4.5-4.5"
        stroke={ACCENT}
      />
      <Node x={100} y={134} r={14}>
        <path d="m96 128.5 9 5.5-9 5.5z" />
      </Node>
    </Art>
  );
}

function ContextArt() {
  const ticks = Array.from({ length: 36 }, (_, i) => i);
  // 62% of a 270° sweep starting at 135°
  const R = 44;
  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return [100 + Math.cos(a) * r, 85 + Math.sin(a) * r];
  };
  const [sx, sy] = pt(135, R);
  const [ex, ey] = pt(135 + 270 * 0.62, R);
  const [tx, ty] = pt(135 + 270, R);
  return (
    <Art>
      <g data-pop>
        {ticks.map((i) => {
          const deg = i * 10;
          const [x1, y1] = pt(deg, 58);
          const [x2, y2] = pt(deg, i % 3 === 0 ? 64 : 61);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              strokeOpacity={i % 3 === 0 ? 0.6 : 0.3}
            />
          );
        })}
      </g>
      <path
        data-fade
        d={`M${sx} ${sy} A${R} ${R} 0 1 1 ${tx} ${ty}`}
        strokeOpacity={0.32}
      />
      <path
        data-ink
        d={`M${sx} ${sy} A${R} ${R} 0 1 1 ${ex} ${ey}`}
      />
      <circle data-pop cx={ex} cy={ey} r={3} fill={ACCENT} stroke="none" />
      <circle data-ink cx={100} cy={85} r={28} strokeOpacity={0.35} />
      <text
        x={100}
        y={89}
        textAnchor="middle"
        stroke="none"
        fill="currentColor"
        className="font-mono text-[12px]"
      >
        62%
      </text>
      <text
        x={100}
        y={132}
        textAnchor="middle"
        stroke="none"
        fill="currentColor"
        fillOpacity={0.5}
        className="font-mono text-[7.5px] tracking-[0.12em]"
      >
        CONTEXT
      </text>
    </Art>
  );
}
