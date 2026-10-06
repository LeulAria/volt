import { type ReactNode, type RefObject, useRef } from "react";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";
import { SectionHeading, useLoopClock } from "./primitives";

const ITEMS: { title: string; body: string; art: ReactNode }[] = [
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

/** Pastel washes (each colour at 20% alpha) (sky, butter, blush) behind each drawing, one per cell. */
const WASH = [
  "radial-gradient(70% 80% at 8% 0%, rgba(181,220,238,0.2) 0%, transparent 62%), radial-gradient(55% 60% at 38% 35%, rgba(246,227,161,0.2) 0%, transparent 70%), radial-gradient(80% 90% at 100% 20%, rgba(244,195,211,0.2) 0%, transparent 65%)",
  "radial-gradient(70% 80% at 100% 0%, rgba(201,217,242,0.2) 0%, transparent 62%), radial-gradient(60% 65% at 20% 40%, rgba(247,214,196,0.2) 0%, transparent 68%), radial-gradient(80% 90% at 90% 100%, rgba(233,196,227,0.2) 0%, transparent 65%)",
  "radial-gradient(70% 80% at 0% 10%, rgba(191,227,218,0.2) 0%, transparent 62%), radial-gradient(55% 60% at 55% 30%, rgba(245,230,168,0.2) 0%, transparent 70%), radial-gradient(80% 90% at 100% 60%, rgba(245,198,207,0.2) 0%, transparent 65%)",
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
        title={"Everything an agent needs."}
        body="Mentions, a follow-up queue, and a live context meter are built into the composer, so every chat stays on track."
      />
      <ul className="mt-14 grid grid-cols-1 gap-px border-y border-white/[0.08] border-x border-x-transparent bg-clip-padding max-md:border-x-white/[0.08] bg-white/[0.08] md:mt-20 md:grid-cols-3">
        {ITEMS.map((item, i) => (
          <li
            key={item.title}
            data-cap
            className="group flex flex-col bg-[#0a0d0c] px-7 pt-10 pb-9 md:px-6 lg:px-9"
          >
            <div
              className="relative flex h-[210px] items-center justify-center overflow-hidden rounded-xl px-4 py-5 text-white/80 sm:h-[220px]"
              style={{ backgroundColor: "#0d1011" }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{ backgroundImage: WASH[i % WASH.length] }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 backdrop-blur-2xl"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-[#0a0d0c]/70 to-transparent"
              />
              <div className="relative h-full w-full">{item.art}</div>
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
/* Each one is 240×180, flat, with no backdrop: 1px hairlines in       */
/* currentColor and one orange accent. Strokes don't scale with the    */
/* drawing (see .cap-art), so every line stays exactly 1px. Motion     */
/* runs off a loop clock while the cell is on screen.                  */
/* ------------------------------------------------------------------ */

const ACCENT = "#ff8a5a";
const BG = "#0d1011";
const GOOD = "#3ecf8e";
const CX = 120;

const ease = (x: number) => x * x * (3 - 2 * x);
const f1 = (n: number) => Math.round(n * 10) / 10;
const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return [f1(cx + Math.cos(a) * r), f1(cy + Math.sin(a) * r)] as const;
};

function Art({
  clockRef,
  children,
}: {
  clockRef: RefObject<HTMLDivElement | null>;
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
        className="cap-art mx-auto h-full w-auto max-w-full overflow-visible"
      >
        {children}
      </svg>
    </div>
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

/* 12×12 file glyph */
const DOC_GLYPH = (
  <path d="M2.4.8h4.8L9.8 3.4v7.8H2.4zM7 .8v2.8h2.8M4.2 6.4h3.8M4.2 8.6h2.6" />
);

/* 1 · @-mention ------------------------------------------------------ */

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
  const { ref, t } = useLoopClock(7200, 4600);
  const typed = t >= 500;
  const open = t >= 900 && t < 3500;
  const row = t < 1900 ? 0 : 1;
  const picked = t >= 3100;
  const chip = t >= 3500;
  const popY = open ? 0 : 6;
  return (
    <Art clockRef={ref}>
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
          fill={BG}
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
            <g transform="translate(40 38)" strokeOpacity={0.8}>
              {DOC_GLYPH}
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
          fill={BG}
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
          fill={BG}
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
        <circle cx={201} cy={141} r={9} strokeOpacity={0.9} />
        <path d="M201 145v-8M197.6 140.4 201 137l3.4 3.4" />
      </g>
    </Art>
  );
}

/* 2 · Queue ---------------------------------------------------------- */

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
  const { ref, t } = useLoopClock(CYCLE * FOLLOW_UPS.length, 0);
  const k = Math.floor(t / CYCLE);
  const p = (t % CYCLE) / CYCLE;
  const shift = ease(Math.min(1, Math.max(0, (p - 0.55) / 0.3)));
  const done = p > 0.38 && p < 0.62;
  return (
    <Art clockRef={ref}>
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
              fill={BG}
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
        <circle cx={CX} cy={148} r={16} fill={BG} strokeOpacity={0.35} />
        {done ? (
          <path d={`m${CX - 5} 148 3.4 3.4 6.8-7`} stroke={GOOD} />
        ) : (
          <>
            <circle cx={CX} cy={148} r={7} strokeOpacity={0.15} />
            <path
              d={`M${CX} 141a7 7 0 0 1 7 7`}
              stroke={ACCENT}
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

/* 3 · Context -------------------------------------------------------- */

const TICKS = 48;

function ContextArt() {
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
    <Art clockRef={ref}>
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
          stroke={ACCENT}
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
