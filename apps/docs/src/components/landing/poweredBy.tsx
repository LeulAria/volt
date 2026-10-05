import {
  Blocks,
  Bot,
  Bug,
  GitBranch,
  Globe,
  Keyboard,
  type LucideIcon,
  MessageSquare,
  Palette,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { BOLT_H, BOLT_PATH, BOLT_W } from "@/lib/boltGeometry";
import { cn } from "@/lib/cn";
import { gsap, REDUCED, useGSAP } from "@/lib/gsap";
import { COLUMN } from "./geometry";
import { SectionHeading } from "./primitives";

const ACCENT = "#ff8a5a";

const CARRIED: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Blocks,
    title: "Extensions",
    body: "Install from Open VSX, or side-load any .vsix.",
  },
  {
    icon: Palette,
    title: "Themes & icons",
    body: "Every color theme and icon pack you already use.",
  },
  {
    icon: Keyboard,
    title: "Keybindings",
    body: "Your shortcuts, settings, and snippets carry over.",
  },
  {
    icon: Bug,
    title: "Language tooling",
    body: "Language servers, debuggers, and tasks just work.",
  },
];

/** Bottom to top. `k` is the plane's height in the stack, in multiples of the gap. */
const LAYERS: {
  k: number;
  name: string;
  caption: string;
  accent?: boolean;
}[] = [
  { k: -1, name: "VS Code", caption: "Open-source core" },
  { k: 0, name: "Your setup", caption: "Carried over" },
  { k: 1, name: "Volt", caption: "Agent layer — new", accent: true },
];

/** Plane edge in px, and half its diagonal (how far a corner reaches from the centre). */
const PLANE = 260;
const REACH = 184;
/** sin of the stage's X tilt: how much one px of lift moves a plane up the screen. */
const LIFT_Y = Math.sin((58 * Math.PI) / 180);

export function PoweredBy() {
  const ref = useRef<HTMLElement>(null);

  // the stack starts pressed flat and pulls apart as it scrolls up the screen
  useGSAP(
    () => {
      gsap.matchMedia().add(`not ${REDUCED}`, () => {
        const diagram = ref.current?.querySelector("[data-stack]");
        if (!diagram) return;
        gsap.fromTo(
          diagram,
          { "--gap": "8px" },
          {
            "--gap": "138px",
            ease: "none",
            scrollTrigger: {
              trigger: diagram,
              start: "top 90%",
              end: "center 45%",
              scrub: 0.8,
            },
          },
        );
      });
    },
    { scope: ref },
  );

  return (
    <section
      ref={ref}
      className={cn(COLUMN, "stack-section relative pt-24 md:pt-32")}
    >
      <div className="grid gap-12 lg:grid-cols-12 lg:items-center lg:gap-8">
        <div className="lg:col-span-5">
          <SectionHeading
            title="Powered by VS Code."
            body="Volt is built on the open-source VS Code core. The editor, extensions, and muscle memory you rely on come along; the agent layer is what's new."
          />
          <ul className="mt-10 border-b border-white/[0.08] pl-4 sm:pl-6 md:pl-8">
            {CARRIED.map(({ icon: Icon, title, body }) => (
              <li
                key={title}
                data-carried
                className="group flex gap-4 border-t border-white/[0.08] py-4"
              >
                <Icon
                  aria-hidden
                  strokeWidth={1.25}
                  className="mt-0.5 size-[18px] shrink-0 text-white/45 transition-colors duration-300 group-hover:text-white"
                />
                <div>
                  <div className="text-[14.5px] font-medium text-white">
                    {title}
                  </div>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-white/45">
                    {body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div
          data-stack
          aria-hidden
          className="relative hidden h-[620px] [--gap:138px] md:block lg:col-span-7"
        >
          {/* the planes, in one tilted 3D stage */}
          <div className="absolute top-1/2 left-[38%] [perspective:1800px]">
            <div
              className="relative [transform-style:preserve-3d]"
              style={{ transform: "rotateX(58deg) rotateZ(-42deg)" }}
            >
              {LAYERS.map((layer, i) => (
                <Plane key={layer.name} index={i} k={layer.k}>
                  <PlaneBody index={i} />
                </Plane>
              ))}
            </div>
          </div>

          {/* flat labels that ride along with their planes */}
          {LAYERS.map((layer, i) => (
            <div
              key={layer.name}
              data-label={i}
              className="absolute top-1/2 flex items-center gap-4"
              style={{
                left: `calc(38% + ${REACH + 14}px)`,
                transform: `translateY(calc(-50% - var(--gap) * ${layer.k * LIFT_Y}))`,
              }}
            >
              <span className="label-line h-px w-10 bg-white/20 transition-colors duration-300" />
              <span className="whitespace-nowrap">
                <span className="block text-[14px] font-medium text-white">
                  {layer.name}
                </span>
                <span
                  className="mt-0.5 block font-mono text-[10px] tracking-[0.14em] uppercase"
                  style={{
                    color: layer.accent ? ACCENT : "rgba(255,255,255,0.35)",
                  }}
                >
                  {layer.caption}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Dashed posts at a plane's corners, reaching down to the plane beneath it. */
const POSTS: CSSProperties[] = [
  { left: 18, top: 18 },
  { left: PLANE - 18, top: 18 },
  { left: 18, top: PLANE - 18 },
  { left: PLANE - 18, top: PLANE - 18 },
];

/** One plane of the stack. Hover lifts are CSS (see `.stack-section` in app.css). */
function Plane({
  index,
  k,
  children,
}: {
  index: number;
  k: number;
  children: ReactNode;
}) {
  return (
    <div
      data-plane={index}
      className="absolute [transform-style:preserve-3d]"
      style={{
        width: PLANE,
        height: PLANE,
        left: -PLANE / 2,
        top: -PLANE / 2,
        transform: `translateZ(calc(var(--gap) * ${k}))`,
      }}
    >
      <div className="plane-lift absolute inset-0 [transform-style:preserve-3d]">
        {k > -1
          ? POSTS.map((pos) => (
              <span
                key={`${pos.left}-${pos.top}`}
                className="absolute w-px origin-top bg-[repeating-linear-gradient(180deg,rgba(255,255,255,0.35)_0_3px,transparent_3px_7px)]"
                style={{
                  ...pos,
                  height: "var(--gap)",
                  // hang the post below the plane: rotate it out of the plane, pointing down the stack
                  transform: "rotateX(-90deg)",
                }}
              />
            ))
          : null}
        {children}
      </div>
    </div>
  );
}

const TILES: { icon: LucideIcon; label: string }[][] = [
  [],
  [
    { icon: Blocks, label: "Extensions" },
    { icon: Palette, label: "Themes" },
    { icon: Keyboard, label: "Keys" },
    { icon: Bug, label: "Debug" },
  ],
  [
    { icon: MessageSquare, label: "Chats" },
    { icon: Bot, label: "Agents" },
    { icon: GitBranch, label: "Git" },
    { icon: Globe, label: "Browser" },
  ],
];

const SERIAL = ["VLT-00 / CORE", "VLT-01 / USER", "VLT-02 / AGENT"];

/** A ring of hairline ticks, drawn around a point (hub, mark) like a bezel. */
function Bezel({
  size,
  n,
  color,
  className,
}: {
  size: number;
  n: number;
  color: string;
  className?: string;
}) {
  const c = size / 2;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth={1}
      aria-hidden
      className={className}
    >
      <circle cx={c} cy={c} r={c - 0.5} strokeOpacity={0.7} />
      <circle cx={c} cy={c} r={c - 8} strokeOpacity={0.35} />
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        const long = i % 6 === 0;
        const r1 = c - 0.5;
        const r2 = c - (long ? 6.5 : 3.5);
        return (
          <line
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed bezel ticks
            key={i}
            x1={c + Math.cos(a) * r1}
            y1={c + Math.sin(a) * r1}
            x2={c + Math.cos(a) * r2}
            y2={c + Math.sin(a) * r2}
            strokeOpacity={long ? 0.9 : 0.5}
          />
        );
      })}
    </svg>
  );
}

/** A panel screw: ring plus a slot, one pixel throughout. */
function Screw({ className, color }: { className?: string; color: string }) {
  return (
    <svg
      viewBox="0 0 8 8"
      width={8}
      height={8}
      fill="none"
      stroke={color}
      strokeWidth={1}
      aria-hidden
      className={cn("absolute", className)}
    >
      <circle cx={4} cy={4} r={3.5} />
      <path d="M2.2 5.8 5.8 2.2" strokeLinecap="round" />
    </svg>
  );
}

/** What's drawn on each plane: the core's mark, the carried-over setup, and the agent layer. */
function PlaneBody({ index }: { index: number }) {
  const top = index === 2;
  const ink = top ? "rgba(255,138,90,0.55)" : "rgba(255,255,255,0.3)";
  const hair = top ? "border-[#ff8a5a]/20" : "border-white/[0.09]";
  return (
    <div
      className={cn(
        "plane-face absolute inset-0 rounded-[26px] border bg-[#0b0e0d]",
        top ? "border-[#ff8a5a]/60" : "border-white/15",
      )}
    >
      <div className="absolute inset-0 rounded-[26px] bg-[radial-gradient(circle,rgba(255,255,255,0.12)_0.7px,transparent_1px)] [background-size:13px_13px]" />

      {/* hull: a second inner seam, scale ticks along two edges, screws at the corners */}
      <div className={cn("absolute inset-[6px] rounded-[21px] border", hair)} />
      <div
        className="absolute top-[11px] right-9 left-9 h-[3px]"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${ink} 0 1px, transparent 1px 8px)`,
        }}
      />
      <div
        className="absolute top-9 bottom-9 left-[11px] w-[3px]"
        style={{
          backgroundImage: `repeating-linear-gradient(180deg, ${ink} 0 1px, transparent 1px 8px)`,
        }}
      />
      <div
        className="absolute right-9 bottom-[11px] left-9 h-[3px]"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${ink} 0 1px, transparent 1px 16px)`,
        }}
      />
      <Screw color={ink} className="top-[9px] left-[9px]" />
      <Screw color={ink} className="top-[9px] right-[9px]" />
      <Screw color={ink} className="right-[9px] bottom-[9px]" />
      <Screw color={ink} className="bottom-[9px] left-[9px]" />
      <span
        className="absolute bottom-[17px] left-9 font-mono text-[6px] tracking-[0.2em]"
        style={{ color: ink }}
      >
        {SERIAL[index]}
      </span>

      {index === 0 ? (
        // the core's mark sits dead centre on its plane
        <>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <Bezel size={96} n={36} color="rgba(255,255,255,0.4)" />
          </div>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <VsCodeMark className="size-12 opacity-70" />
          </div>
        </>
      ) : (
        <div className="absolute inset-7 grid grid-cols-2 gap-3">
          {TILES[index].map(({ icon: Icon, label }, n) => (
            <div
              key={label}
              className={cn(
                "relative flex flex-col justify-between rounded-[14px] border bg-[#0b0e0d] p-3",
                top ? "border-[#ff8a5a]/30" : "border-white/12",
              )}
            >
              {/* inner seam, a rivet pair, and a bay number */}
              <div
                className={cn(
                  "absolute inset-[3px] rounded-[11px] border",
                  hair,
                )}
              />
              <span
                className="absolute top-[7px] right-[8px] size-[3px] rounded-full"
                style={{ backgroundColor: ink }}
              />
              <span
                className="absolute top-[7px] right-[15px] size-[3px] rounded-full"
                style={{ backgroundColor: ink }}
              />
              <span
                className="absolute right-[9px] bottom-[7px] font-mono text-[5.5px] tracking-[0.12em]"
                style={{ color: ink }}
              >
                {String(n + 1).padStart(2, "0")}
              </span>
              <Icon
                strokeWidth={1}
                absoluteStrokeWidth
                className="relative size-5"
                style={{ color: top ? ACCENT : "rgba(255,255,255,0.7)" }}
              />
              <span className="relative text-[11px] font-medium text-white/70">
                {label}
              </span>
            </div>
          ))}
          {top ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              {/* the hub reads as an engine: bezel ring, spokes out to the bays, bolt at the core */}
              <svg
                viewBox="-60 -60 120 120"
                className="absolute size-[120px]"
                fill="none"
                stroke="rgba(255,138,90,0.28)"
                strokeWidth={1}
                aria-hidden
              >
                <path d="M-60 0H-34M34 0H60M0-60V-34M0 34V60" />
                <circle r={44} strokeDasharray="1 4" />
              </svg>
              <Bezel
                size={64}
                n={48}
                color="rgba(255,138,90,0.7)"
                className="absolute"
              />
              <span className="grid size-11 place-items-center rounded-full border border-[#ff8a5a]/60 bg-[#0b0e0d]">
                <svg
                  viewBox={`0 0 ${BOLT_W} ${BOLT_H}`}
                  className="h-5 w-auto"
                  aria-hidden
                >
                  <path d={BOLT_PATH} fill={ACCENT} fillRule="evenodd" />
                </svg>
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function VsCodeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="#fff"
      aria-hidden
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M0.228341 8.36915C0.228341 8.36915 -0.356212 7.94324 0.345251 7.37453L1.97956 5.89736C1.97956 5.89736 2.44721 5.40004 2.94164 5.83334L18.0231 17.375V22.9094C18.0231 22.9094 18.0158 23.7785 16.9124 23.6825L0.228341 8.36915Z" />
      <path d="M4.11555 11.9367L0.228273 15.5089C0.228273 15.5089 -0.171172 15.8093 0.228273 16.346L2.03308 18.0053C2.03308 18.0053 2.46175 18.4706 3.09502 17.9413L7.21611 14.7827L4.11555 11.9367Z" />
      <path d="M10.94 11.9661L18.0691 6.46362L18.0228 0.95865C18.0228 0.95865 17.7183 -0.242793 16.7027 0.382548L7.21589 9.11025L10.94 11.9661Z" />
      <path d="M16.9121 23.69C17.3261 24.1183 17.8279 23.978 17.8279 23.978L23.3838 21.2108C24.0951 20.7208 23.9952 20.1127 23.9952 20.1127V3.58803C23.9952 2.86175 23.2596 2.61063 23.2596 2.61063L18.4441 0.264377C17.3919 -0.392968 16.7027 0.382548 16.7027 0.382548C16.7027 0.382548 17.5892 -0.262484 18.0228 0.95865L18.0228 22.8086C18.0228 22.9588 17.9911 23.1065 17.9278 23.2394C17.8011 23.4979 17.5259 23.7392 16.8658 23.6383L16.9121 23.69Z" />
    </svg>
  );
}
