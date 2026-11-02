import {
  ArrowLeftRight,
  Check,
  Clock,
  GitPullRequest,
  Globe,
  Laptop,
  type LucideIcon,
  Smartphone,
} from "lucide-react";
import { useInView, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { BrandIcon, type BrandId } from "./brandIcons";
import { COLUMN } from "./geometry";
import { Reveal } from "./primitives";

/*
 * How Volt runs: you start work from the desktop app, the web or your phone (paired with the agent
 * server) or an automation does; the agent server queues it and routes each task to any agent on your
 * own subscriptions, switching Claude accounts near a limit; the result comes back for review and
 * ships as a pull request.
 *
 * Mostly monochrome: orange is work moving, green is work shipped. A small simulation drives it on
 * its own clock, which only runs while the drawing is on screen.
 */

type Box = { x: number; y: number; w: number; h: number };
type At = { x: number; y: number; s?: number };
type LineKey = "desktop" | "pair" | "auto" | "run" | "done" | "ship";
type Source = "desktop" | "web" | "phone" | "auto";
type HitKey = "desktop" | "pair" | "auto" | "hub" | "review" | "pr" | "phone";

type Layout = {
  viewBox: string;
  /** Column captions; the phone layout reads top to bottom without them. */
  headers: { x: number; y: number; index: string; label: string }[];
  laptop: At;
  web: At;
  phone: At;
  devicesCaption?: { x: number; y: number };
  pairChip: { x: number; y: number };
  auto: Box;
  hub: Box;
  /** One card, a row per running agent. */
  agents: Box;
  accounts: Box;
  review: Box;
  pr: Box;
  activity?: Box;
  lines: Record<LineKey, string>;
};

const WIDE: Layout = {
  viewBox: "0 0 1200 510",
  headers: [
    { x: 20, y: 22, index: "01", label: "Start anywhere" },
    { x: 330, y: 22, index: "02", label: "Orchestrate" },
    { x: 680, y: 22, index: "03", label: "Your agents" },
    { x: 960, y: 22, index: "04", label: "Review and ship" },
  ],
  laptop: { x: 20, y: 52 },
  web: { x: 20, y: 256 },
  phone: { x: 184, y: 248 },
  devicesCaption: { x: 20, y: 208 },
  pairChip: { x: 285, y: 277 },
  auto: { x: 20, y: 430, w: 220, h: 64 },
  hub: { x: 330, y: 52, w: 280, h: 442 },
  agents: { x: 680, y: 52, w: 220, h: 209 },
  accounts: { x: 680, y: 285, w: 220, h: 209 },
  review: { x: 960, y: 52, w: 220, h: 168 },
  pr: { x: 960, y: 244, w: 220, h: 76 },
  activity: { x: 960, y: 344, w: 220, h: 150 },
  lines: {
    desktop: "M226 112 C278 112 278 150 330 150",
    pair: "M240 304 C285 304 285 250 330 250",
    auto: "M240 462 C285 462 285 350 330 350",
    // out of the server's row of agents
    run: "M610 252 C645 252 645 156 680 156",
    done: "M900 156 C930 156 930 136 960 136",
    ship: "M1070 220 V244",
  },
};

/** Phones: everything stacked, with rails down the sides. The activity log is left out. */
const TALL: Layout = {
  viewBox: "0 0 400 1556",
  headers: [],
  laptop: { x: 16, y: 36, s: 0.72 },
  web: { x: 190, y: 44, s: 0.72 },
  phone: { x: 316, y: 34, s: 0.72 },
  pairChip: { x: 362, y: 168 },
  auto: { x: 32, y: 184, w: 336, h: 60 },
  hub: { x: 60, y: 300, w: 280, h: 442 },
  agents: { x: 90, y: 790, w: 220, h: 209 },
  accounts: { x: 90, y: 1023, w: 220, h: 209 },
  review: { x: 90, y: 1270, w: 220, h: 168 },
  pr: { x: 90, y: 1462, w: 220, h: 76 },
  lines: {
    desktop:
      "M95 131 V160 Q95 168 87 168 H20 Q12 168 12 176 V256 Q12 264 20 264 H192 Q200 264 200 272 V300",
    pair: "M336 115 V160 Q336 168 344 168 H380 Q388 168 388 176 V256 Q388 264 380 264 H208 Q200 264 200 272 V300",
    auto: "M200 244 V300",
    run: "M200 742 V790",
    done: "M310 894 H322 Q330 894 330 902 V1246 Q330 1254 322 1254 H208 Q200 1254 200 1262 V1270",
    ship: "M200 1438 V1462",
  },
};

const AGENTS: readonly { id: BrandId; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
  { id: "grok", name: "Grok" },
  { id: "kimi", name: "Kimi Code" },
];

const TASKS: Record<Source, readonly string[]> = {
  desktop: [
    "Fix flaky login test",
    "Refactor auth hooks",
    "Speed up the build",
  ],
  web: ["Write API docs", "Add a settings page"],
  phone: ["Add dark mode", "Fix the iOS crash"],
  auto: ["Bump dependencies", "Triage new issues", "Nightly test sweep"],
};

const FILES = [
  "src/auth/login.ts",
  "src/auth/session.ts",
  "app/settings/page.tsx",
  "package.json",
  "docs/api.md",
  "src/theme/tokens.ts",
  "tests/login.spec.ts",
];

const SOURCE_ICON: Record<Source, LucideIcon> = {
  desktop: Laptop,
  web: Globe,
  phone: Smartphone,
  auto: Clock,
};

const ACCOUNTS = ["Work", "Personal"] as const;
/** Volt moves to the other Claude login when the one in use passes this. */
const SWITCH_AT = 90;
const QUEUE_ROWS = 3;
/** An agent row's progress bar starts under its text and stops 16px short of the card edge. */
const ROW_BAR_INSET = 68;
const PACKETS = 10;

type Task = { id: number; source: Source; text: string };
type Run = {
  agent: number;
  task: Task;
  account?: number;
  start: number;
  end: number;
};
type Flight = {
  line: LineKey;
  start: number;
  dur: number;
  packet: number;
  land: () => void;
};
type LogIcon = "pr" | "phone" | "auto" | "switch" | "web";
type LogItem = { id: number; icon: LogIcon; text: string; at: number };

const LOG_ICON: Record<LogIcon, LucideIcon> = {
  pr: GitPullRequest,
  phone: Smartphone,
  auto: Clock,
  switch: ArrowLeftRight,
  web: Globe,
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(list: readonly T[]) =>
  list[Math.floor(Math.random() * list.length)];
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const lineSource: Record<Source, LineKey> = {
  desktop: "desktop",
  web: "pair",
  phone: "pair",
  auto: "auto",
};

class FlowSim {
  now = 0;
  dirty = false;
  // A deterministic opening state, so server and client render the same first frame.
  queue: Task[] = [
    { id: 1, source: "phone", text: "Add dark mode" },
    { id: 2, source: "auto", text: "Bump dependencies" },
    { id: 3, source: "web", text: "Write API docs" },
  ];
  slots: (Run | null)[] = [
    {
      agent: 0,
      task: { id: 4, source: "desktop", text: "Fix flaky login test" },
      account: 0,
      start: -3,
      end: 1.6,
    },
    {
      agent: 1,
      task: { id: 5, source: "auto", text: "Triage new issues" },
      start: -1,
      end: 4.8,
    },
  ];
  reserved = [false, false];
  /** A slot's next task while it travels to its agent, and the run the slot last finished. */
  pending: ({ agent: number; task: Task } | null)[] = [null, null];
  last: (Run | null)[] = [null, null];
  flights: Flight[] = [];
  timers: { at: number; run: () => void }[] = [];
  hits: Partial<Record<HitKey, number>> = {};
  usage = [78, 31];
  account = 0;
  switchedAt = -1000;
  review = {
    agent: "Cursor",
    files: [
      { path: "src/auth/session.ts", add: 42, del: 6 },
      { path: "tests/login.spec.ts", add: 18, del: 8 },
    ],
    pressed: false,
  };
  pr = 213;
  log: LogItem[] = [
    { id: 3, icon: "pr", text: "PR #213 opened", at: -6 },
    { id: 2, icon: "phone", text: "Approved from phone", at: -21 },
    { id: 1, icon: "auto", text: "Nightly test sweep ran", at: -48 },
  ];
  nextId = 10;
  nextDesktop = 2.2;
  nextRemote = 4.5;
  nextAuto = 7;
  countdown = 7;
  clock = 0;

  step(dt: number) {
    this.now += dt;
    const t = this.now;

    for (const timer of this.timers.filter((x) => t >= x.at)) {
      this.timers.splice(this.timers.indexOf(timer), 1);
      timer.run();
    }

    // an idle slot pulls the next task in, so no agent sits waiting on an empty queue
    const inbound = this.flights.some(
      (f) => f.line === "desktop" || f.line === "pair" || f.line === "auto",
    );
    if (
      !inbound &&
      !this.queue.length &&
      this.slots.some((run, i) => !run && !this.reserved[i])
    ) {
      this.arrive(pick<Source>(["desktop", "web", "phone"]));
    }

    if (t >= this.nextDesktop) {
      this.nextDesktop = t + rand(5, 8);
      this.arrive("desktop");
    }
    if (t >= this.nextRemote) {
      this.nextRemote = t + rand(6, 9);
      this.arrive(Math.random() < 0.5 ? "phone" : "web");
    }
    if (t >= this.nextAuto) {
      this.nextAuto = t + rand(10, 14);
      this.arrive("auto");
    }
    // the countdown and the activity ages tick once a second
    const countdown = Math.max(0, Math.ceil(this.nextAuto - t));
    if (countdown !== this.countdown || Math.floor(t) !== this.clock) {
      this.countdown = countdown;
      this.clock = Math.floor(t);
      this.dirty = true;
    }

    this.meterAccounts(dt);

    this.slots.forEach((run, i) => {
      if (!run || t < run.end) return;
      this.slots[i] = null;
      this.last[i] = run;
      this.reserved[i] = true;
      this.after(0.6, () => {
        this.reserved[i] = false;
      });
      this.fly("done", 0.8, () => this.toReview(run));
    });

    this.slots.forEach((run, i) => {
      if (run || this.reserved[i] || !this.queue.length) return;
      const task = this.queue.shift() as Task;
      this.reserved[i] = true;
      const agent = this.pickAgent();
      this.pending[i] = { agent, task };
      this.fly("run", 0.65, () => {
        this.reserved[i] = false;
        this.pending[i] = null;
        this.slots[i] = {
          agent,
          task,
          account: AGENTS[agent].id === "claude" ? this.account : undefined,
          start: this.now,
          // two agents at a time, so runs are short enough to keep up with what comes in
          end: this.now + rand(4, 7),
        };
        // a phone or web user approving the agent's first command
        if (task.source === "phone" || task.source === "web") {
          this.hit("phone");
          this.addLog(
            task.source === "phone" ? "phone" : "web",
            `Approved from ${task.source}`,
          );
        }
      });
    });

    for (const flight of this.flights.filter((f) => t - f.start >= f.dur)) {
      this.flights.splice(this.flights.indexOf(flight), 1);
      this.dirty = true;
      flight.land();
    }

    for (const key of Object.keys(this.hits) as HitKey[]) {
      if (t >= (this.hits[key] ?? 0)) {
        delete this.hits[key];
        this.dirty = true;
      }
    }
  }

  /** Claude runs spend the login in use; near the limit Volt moves to the other one. */
  meterAccounts(dt: number) {
    const claude = this.slots.filter(
      (run) => run && AGENTS[run.agent].id === "claude",
    ).length;
    const before = this.usage.map(Math.floor);
    this.usage[this.account] = Math.min(
      100,
      this.usage[this.account] + dt * (0.5 + claude * 1.6),
    );
    const other = 1 - this.account;
    // the resting login's window rolls over
    this.usage[other] = Math.max(12, this.usage[other] - dt * 0.9);
    if (this.usage[this.account] >= SWITCH_AT && this.usage[other] < 70) {
      this.account = other;
      this.switchedAt = this.now;
      this.addLog("switch", `Switched to ${ACCOUNTS[other]}`);
      for (const run of this.slots) {
        if (run && run.account !== undefined) run.account = other;
      }
    }
    if (this.usage.some((u, i) => Math.floor(u) !== before[i]))
      this.dirty = true;
  }

  after(delay: number, run: () => void) {
    this.timers.push({ at: this.now + delay, run });
  }

  hit(key: HitKey, length = 0.5) {
    this.hits[key] = this.now + length;
    this.dirty = true;
  }

  fly(line: LineKey, dur: number, land: () => void) {
    this.dirty = true;
    const used = new Set(this.flights.map((f) => f.packet));
    const packet = Array.from({ length: PACKETS }, (_, i) => i).find(
      (i) => !used.has(i),
    );
    if (packet === undefined) {
      land();
      return;
    }
    this.flights.push({ line, start: this.now, dur, packet, land });
  }

  arrive(source: Source) {
    const text = pick(TASKS[source]);
    this.hit(source === "web" || source === "phone" ? "pair" : source);
    if (source === "phone") this.hit("phone");
    if (source === "auto") this.addLog("auto", text);
    this.fly(lineSource[source], 0.85, () => {
      if (this.queue.length < QUEUE_ROWS) {
        this.queue.push({ id: this.nextId++, source, text });
      }
      this.hit("hub");
    });
  }

  toReview(run: Run) {
    const files = [...FILES].sort(() => Math.random() - 0.5).slice(0, 2);
    this.review = {
      agent: AGENTS[run.agent].name,
      files: files.map((path) => ({
        path,
        add: Math.round(rand(6, 64)),
        del: Math.round(rand(0, 18)),
      })),
      pressed: false,
    };
    this.hit("review", 0.7);
    this.after(1.1, () => {
      this.review.pressed = true;
      this.dirty = true;
      this.fly("ship", 0.55, () => {
        this.review.pressed = false;
        this.pr += 1;
        this.hit("pr", 0.7);
        this.addLog("pr", `PR #${this.pr} opened`);
      });
    });
  }

  addLog(icon: LogIcon, text: string) {
    this.log = [
      { id: this.nextId++, icon, text, at: this.now },
      ...this.log,
    ].slice(0, 4);
    this.dirty = true;
  }

  /** A random agent that isn't running or about to; Claude comes up often so the accounts move. */
  pickAgent() {
    const busy = new Set([
      ...this.slots.map((run) => run?.agent),
      ...this.pending.map((next) => next?.agent),
    ]);
    if (!busy.has(0) && Math.random() < 0.45) return 0;
    const idle = AGENTS.map((_, i) => i).filter((i) => !busy.has(i));
    return pick(idle) ?? 0;
  }

  progress(run: Run) {
    return Math.min(
      1,
      Math.max(0, (this.now - run.start) / (run.end - run.start)),
    );
  }
}

const age = (seconds: number) =>
  seconds < 5
    ? "now"
    : seconds < 60
      ? `${Math.floor(seconds)}s`
      : `${Math.floor(seconds / 60)}m`;

function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

export function AgentFlow() {
  return (
    <section
      id="how-it-works"
      aria-label="How Volt runs your agents"
      // opaque so the column guides stop at this section; the showcase below brings its own top padding
      className={cn(COLUMN, "relative bg-[#0a0d0c] pt-24 md:pt-32")}
    >
      <Reveal>
        <FlowDrawing />
      </Reveal>
    </section>
  );
}

function FlowDrawing() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.15 });
  const reduce = useReducedMotion();
  const wide = useWide();
  const layout = wide ? WIDE : TALL;

  const sim = useRef<FlowSim | null>(null);
  sim.current ??= new FlowSim();
  const [, render] = useState(0);
  const lines = useRef<Partial<Record<LineKey, SVGPathElement | null>>>({});
  const packets = useRef<(SVGGElement | null)[]>([]);
  const bars = useRef<(SVGRectElement | null)[]>([]);

  useEffect(() => {
    const s = sim.current;
    if (!inView || reduce || !s) return;
    let frame = 0;
    let last = performance.now();
    const tick = (time: number) => {
      // a long gap (tab in the background) resumes where it left off instead of jumping ahead
      s.step(Math.min(0.1, (time - last) / 1000));
      last = time;

      packets.current.forEach((el, i) => {
        if (!el) return;
        const flight = s.flights.find((f) => f.packet === i);
        const path = flight && lines.current[flight.line];
        if (!flight || !path) {
          el.style.opacity = "0";
          return;
        }
        const p = ease(Math.min(1, (s.now - flight.start) / flight.dur));
        const point = path.getPointAtLength(p * path.getTotalLength());
        el.setAttribute("transform", `translate(${point.x} ${point.y})`);
        el.dataset.kind = flight.line === "ship" ? "ship" : "work";
        el.style.opacity = "1";
      });
      s.slots.forEach((run, i) => {
        const bar = bars.current[i];
        if (bar && run)
          bar.setAttribute(
            "width",
            String((layout.agents.w - ROW_BAR_INSET) * s.progress(run)),
          );
      });

      if (s.dirty) {
        s.dirty = false;
        render((n) => n + 1);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, reduce, layout]);

  const s = sim.current;
  const live = new Set(s.flights.map((f) => f.line));
  const running = s.slots.flatMap((run) => (run ? [run.agent] : []));
  const routing = s.pending.flatMap((next) => (next ? [next.agent] : []));
  const ends = [
    ...new Set(Object.values(layout.lines).flatMap((d) => endpoints(d))),
  ].map((key) => key.split(",").map(Number));

  return (
    <div
      ref={root}
      role="img"
      aria-label="Start work from the Volt desktop app, the web or your phone, which pair with your agent server, or let automations start it. The agent server queues each task and routes it to any agent, such as Claude Code, Codex, Cursor or OpenCode, on your own subscriptions, switching Claude accounts near a usage limit. Finished work comes back for review with proof that checks passed, and ships as a pull request on GitHub."
      className={cn("mx-auto", wide ? "max-w-[1200px]" : "max-w-[440px]")}
    >
      <svg
        viewBox={layout.viewBox}
        aria-hidden
        className="fl-svg block h-auto w-full overflow-visible"
      >
        {layout.headers.map((h) => (
          <g key={h.label}>
            <text className="fl-index" x={h.x} y={h.y}>
              {h.index}
            </text>
            <line
              className="fl-index-rule"
              x1={h.x + 22}
              x2={h.x + 38}
              y1={h.y - 4}
              y2={h.y - 4}
            />
            <text className="fl-header" x={h.x + 46} y={h.y}>
              {h.label}
            </text>
          </g>
        ))}

        {(Object.keys(layout.lines) as LineKey[]).map((key) => (
          <path
            key={key}
            ref={(el) => {
              lines.current[key] = el;
            }}
            className={cn(
              "fl-line",
              live.has(key) && (key === "ship" ? "is-ship" : "is-live"),
            )}
            d={layout.lines[key]}
          />
        ))}

        {/* 01: where work starts */}
        <g
          className={cn("fl-device", s.hits.desktop && "is-hit")}
          transform={`translate(${layout.laptop.x} ${layout.laptop.y}) scale(${layout.laptop.s ?? 1})`}
        >
          <LaptopArt />
        </g>
        <g
          className={cn("fl-device", s.hits.pair && "is-hit")}
          transform={`translate(${layout.web.x} ${layout.web.y}) scale(${layout.web.s ?? 1})`}
        >
          <BrowserArt />
        </g>
        <g
          className={cn("fl-device", s.hits.phone && "is-hit")}
          transform={`translate(${layout.phone.x} ${layout.phone.y}) scale(${layout.phone.s ?? 1})`}
        >
          <PhoneArt />
        </g>
        {layout.devicesCaption ? (
          <>
            <text
              className="fl-title"
              x={layout.devicesCaption.x}
              y={layout.devicesCaption.y}
            >
              Desktop app
            </text>
            <text
              className="fl-sub"
              x={layout.devicesCaption.x}
              y={layout.devicesCaption.y + 17}
            >
              Mac, Windows and Linux
            </text>
            <text
              className="fl-title"
              x={layout.devicesCaption.x}
              y={layout.devicesCaption.y + 178}
            >
              Web and mobile
            </text>
            <text
              className="fl-sub"
              x={layout.devicesCaption.x}
              y={layout.devicesCaption.y + 195}
            >
              Paired with a one-time code
            </text>
          </>
        ) : null}
        <g
          transform={`translate(${layout.pairChip.x - 30} ${layout.pairChip.y - 10})`}
        >
          <rect className="fl-chip" width={60} height={20} rx={10} />
          <path
            className="fl-chip-icon"
            d="M10.5 9.5v-2a3 3 0 0 1 6 0v2M9.5 9.5h8v6h-8z"
          />
          <text className="fl-chip-text" x={21} y={14}>
            Paired
          </text>
        </g>

        <Card box={layout.auto} hit={!!s.hits.auto}>
          <IconTile
            x={layout.auto.x + 12}
            y={layout.auto.y + layout.auto.h / 2 - 18}
            icon={Clock}
          />
          <text
            className="fl-title"
            x={layout.auto.x + 60}
            y={layout.auto.y + layout.auto.h / 2 - 3}
          >
            Automations
          </text>
          <text
            className="fl-sub"
            x={layout.auto.x + 60}
            y={layout.auto.y + layout.auto.h / 2 + 15}
          >
            Schedules, webhooks, Jira
          </text>
          <text
            className="fl-meta"
            x={layout.auto.x + layout.auto.w - 14}
            y={layout.auto.y + layout.auto.h / 2 - 3}
            textAnchor="end"
          >
            {`in 0:${String(s.countdown).padStart(2, "0")}`}
          </text>
        </Card>

        {/* 02: the agent server */}
        <Hub
          box={layout.hub}
          hit={!!s.hits.hub}
          queue={s.queue}
          running={running}
          routing={routing}
        />

        {/* 03: agents on your own subscriptions, one row each */}
        <g className="fl-node">
          <rect
            className="fl-card"
            x={layout.agents.x}
            y={layout.agents.y}
            width={layout.agents.w}
            height={layout.agents.h}
            rx={14}
          />
          <text
            className="fl-label"
            x={layout.agents.x + 16}
            y={layout.agents.y + 26}
          >
            Running now
          </text>
          {s.slots.map((run, i) => {
            const next = s.pending[i];
            const shown = run ?? next ?? s.last[i];
            if (!shown) return null;
            const { x, w } = layout.agents;
            const ry = layout.agents.y + 44 + i * 64;
            const agent = AGENTS[shown.agent];
            const track = w - ROW_BAR_INSET;
            return (
              <g
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are the fixed agent slots
                key={i}
                className={cn(
                  "fl-agent",
                  run ? "is-running" : next ? "is-starting" : "is-done",
                )}
              >
                <rect
                  className="fl-tile"
                  x={x + 14}
                  y={ry + 4}
                  width={28}
                  height={28}
                  rx={8}
                />
                <g
                  className="fl-brand"
                  transform={`translate(${x + 20} ${ry + 10})`}
                >
                  <BrandIcon id={agent.id} size={16} />
                </g>
                <text className="fl-title" x={x + 52} y={ry + 15}>
                  {agent.name}
                </text>
                {run ? null : (
                  <text
                    className="fl-agent-state"
                    x={x + w - 16}
                    y={ry + 15}
                    textAnchor="end"
                  >
                    {next ? "Starting" : "Done"}
                  </text>
                )}
                <text className="fl-sub" x={x + 52} y={ry + 31}>
                  {run?.account !== undefined
                    ? `${short(run.task.text, 19 - ACCOUNTS[run.account].length)} · ${ACCOUNTS[run.account]}`
                    : shown.task.text}
                </text>
                <rect
                  className="fl-track"
                  x={x + 52}
                  y={ry + 40}
                  width={track}
                  height={2}
                  rx={1}
                />
                <rect
                  ref={(el) => {
                    bars.current[i] = el;
                  }}
                  className="fl-bar"
                  x={x + 52}
                  y={ry + 40}
                  width={track * (run ? s.progress(run) : next ? 0 : 1)}
                  height={2}
                  rx={1}
                />
              </g>
            );
          })}
          <text
            className="fl-foot"
            x={layout.agents.x + 16}
            y={layout.agents.y + layout.agents.h - 18}
          >
            On your own subscriptions
          </text>
        </g>

        <Accounts
          box={layout.accounts}
          usage={s.usage}
          active={s.account}
          justSwitched={s.now - s.switchedAt < 4}
        />

        {/* 04: review, then ship */}
        <Review box={layout.review} hit={!!s.hits.review} review={s.review} />

        <Card box={layout.pr} hit={!!s.hits.pr}>
          <rect
            className="fl-tile"
            x={layout.pr.x + 12}
            y={layout.pr.y + layout.pr.h / 2 - 18}
            width={36}
            height={36}
            rx={10}
          />
          <GithubMark
            x={layout.pr.x + 21}
            y={layout.pr.y + layout.pr.h / 2 - 9}
          />
          <text
            className="fl-title"
            x={layout.pr.x + 60}
            y={layout.pr.y + layout.pr.h / 2 - 4}
          >
            {`PR #${s.pr}`}
          </text>
          <text
            className="fl-sub"
            x={layout.pr.x + 60}
            y={layout.pr.y + layout.pr.h / 2 + 14}
          >
            Ready for your review
          </text>
          <g
            transform={`translate(${layout.pr.x + layout.pr.w - 56} ${layout.pr.y + 12})`}
          >
            <rect className="fl-open-chip" width={44} height={18} rx={9} />
            <text className="fl-open-text" x={22} y={12.5} textAnchor="middle">
              Open
            </text>
          </g>
        </Card>

        {layout.activity ? (
          <Activity box={layout.activity} log={s.log} now={s.now} />
        ) : null}

        {/* line ends sit on the card outlines like ports */}
        {ends.map(([x, y]) => (
          <circle
            key={`${x}-${y}`}
            className="fl-joint"
            cx={x}
            cy={y}
            r={2.5}
          />
        ))}

        {Array.from({ length: PACKETS }, (_, i) => (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool the simulation hands out by index
            key={i}
            ref={(el) => {
              packets.current[i] = el;
            }}
            className="fl-packet"
          >
            <circle r={8} opacity={0.18} />
            <circle r={3.2} />
          </g>
        ))}
      </svg>
    </div>
  );
}

/** First and last point of a path made of absolute M, L, H, V, C and Q commands, as "x,y". */
function endpoints(d: string) {
  const tokens = d.match(/[MLHVCQ]|-?\d+(?:\.\d+)?/g) ?? [];
  let x = 0;
  let y = 0;
  let first = "";
  let command = "";
  for (let i = 0; i < tokens.length; ) {
    if (/[A-Z]/.test(tokens[i])) command = tokens[i++];
    const n = (k: number) => Number(tokens[i + k]);
    if (command === "H") {
      x = n(0);
      i += 1;
    } else if (command === "V") {
      y = n(0);
      i += 1;
    } else {
      const size = command === "C" ? 6 : command === "Q" ? 4 : 2;
      x = n(size - 2);
      y = n(size - 1);
      i += size;
    }
    first ||= `${x},${y}`;
  }
  return [first, `${x},${y}`];
}

/** Trims a label to `max` characters so it keeps to one line in its card. */
const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

function Card({
  box,
  hit,
  children,
}: {
  box: Box;
  hit: boolean;
  children: ReactNode;
}) {
  return (
    <g className={cn("fl-node", hit && "is-hit")}>
      <rect
        className="fl-card"
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={14}
      />
      {children}
    </g>
  );
}

function IconTile({
  x,
  y,
  icon: Icon,
}: {
  x: number;
  y: number;
  icon: LucideIcon;
}) {
  return (
    <>
      <rect className="fl-tile" x={x} y={y} width={36} height={36} rx={10} />
      <Icon
        x={x + 9}
        y={y + 9}
        width={18}
        height={18}
        strokeWidth={1.7}
        className="fl-tile-icon"
      />
    </>
  );
}

function Hub({
  box,
  hit,
  queue,
  running,
  routing,
}: {
  box: Box;
  hit: boolean;
  queue: Task[];
  /** Agents running in a slot, and the ones a task is on its way to. */
  running: number[];
  routing: number[];
}) {
  const { x, y, w, h } = box;
  const tile = 32;
  const gap = (w - 40 - AGENTS.length * tile) / (AGENTS.length - 1);
  return (
    <g className={cn("fl-hub", hit && "is-hit")}>
      <rect className="fl-hub-card" x={x} y={y} width={w} height={h} rx={22} />
      {/* Volt's app icon; the PNG's squircle fills 84% of its canvas, so this lands it at 54px */}
      <image
        href="/volt-icon-256.png"
        x={x + 20}
        y={y + 20}
        width={64}
        height={64}
      />
      <text className="fl-hub-title" x={x + 96} y={y + 48}>
        Agent server
      </text>
      <text className="fl-sub" x={x + 96} y={y + 67}>
        On your Mac or a VPS
      </text>
      <g transform={`translate(${x + 20} ${y + 98})`}>
        <rect className="fl-status" width={w - 40} height={28} rx={14} />
        <circle className="fl-live-pulse" cx={16} cy={14} r={3} />
        <circle className="fl-live-dot" cx={16} cy={14} r={3} />
        <text className="fl-status-text" x={28} y={18}>
          Keeps running when windows close
        </text>
      </g>
      <line
        className="fl-divider"
        x1={x}
        x2={x + w}
        y1={y + 146}
        y2={y + 146}
      />
      <text className="fl-label" x={x + 20} y={y + 172}>
        Routes to any agent
      </text>
      <text className="fl-meta" x={x + w - 20} y={y + 172} textAnchor="end">
        {`${running.length} running`}
      </text>
      {AGENTS.map((agent, i) => {
        const tx = x + 20 + i * (tile + gap);
        return (
          <g
            key={agent.id}
            className={cn(
              "fl-pool",
              running.includes(i) && "is-on",
              routing.includes(i) && "is-routing",
            )}
          >
            <rect
              className="fl-tile"
              x={tx}
              y={y + 184}
              width={tile}
              height={tile}
              rx={9}
            />
            <g
              className="fl-brand"
              transform={`translate(${tx + 8} ${y + 192})`}
            >
              <BrandIcon id={agent.id} size={16} />
            </g>
          </g>
        );
      })}
      <line
        className="fl-divider"
        x1={x}
        x2={x + w}
        y1={y + 236}
        y2={y + 236}
      />
      <text className="fl-label" x={x + 20} y={y + 262}>
        Queue
      </text>
      <text className="fl-meta" x={x + w - 20} y={y + 262} textAnchor="end">
        {queue.length ? `${queue.length} waiting` : "empty"}
      </text>
      {Array.from({ length: QUEUE_ROWS }, (_, i) => {
        const task = queue[i];
        const ry = y + 274 + i * 34;
        const Icon = task ? SOURCE_ICON[task.source] : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: queue rows are fixed positions
          <g key={i} className={cn("fl-qrow", task ? "is-on" : "is-empty")}>
            <rect
              className="fl-qrow-bg"
              x={x + 14}
              y={ry}
              width={w - 28}
              height={28}
              rx={8}
            />
            {task && Icon ? (
              <>
                <Icon
                  x={x + 24}
                  y={ry + 8}
                  width={12}
                  height={12}
                  strokeWidth={1.8}
                  className="fl-qrow-icon"
                />
                <text className="fl-qrow-text" x={x + 44} y={ry + 18}>
                  {task.text}
                </text>
                <text
                  className="fl-meta"
                  x={x + w - 24}
                  y={ry + 18}
                  textAnchor="end"
                >
                  {task.source === "auto" ? "automation" : task.source}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
      <line
        className="fl-divider"
        x1={x}
        x2={x + w}
        y1={y + 386}
        y2={y + 386}
      />
      <text className="fl-foot" x={x + 20} y={y + h - 24}>
        Each chat in its own worktree
      </text>
    </g>
  );
}

/** Claude usage per login; the one in use is the brighter row. */
function Accounts({
  box,
  usage,
  active,
  justSwitched,
}: {
  box: Box;
  usage: number[];
  active: number;
  justSwitched: boolean;
}) {
  const { x, y, w, h } = box;
  return (
    <g className="fl-node">
      <rect className="fl-card" x={x} y={y} width={w} height={h} rx={14} />
      <g transform={`translate(${x + 16} ${y + 15})`}>
        <BrandIcon id="claude" size={15} />
      </g>
      <text className="fl-title" x={x + 38} y={y + 27}>
        Usage
      </text>
      <g transform={`translate(${x + w - 42} ${y + 15})`}>
        <rect className="fl-toggle" width={26} height={15} rx={7.5} />
        <circle className="fl-toggle-knob" cx={18.5} cy={7.5} r={5.5} />
      </g>
      {ACCOUNTS.map((name, i) => {
        const ry = y + 48 + i * 56;
        const pct = Math.floor(usage[i]);
        return (
          <g
            key={name}
            className={cn("fl-account", i === active && "is-active")}
          >
            <circle className="fl-avatar" cx={x + 27} cy={ry + 18} r={11} />
            <text
              className="fl-avatar-text"
              x={x + 27}
              y={ry + 22}
              textAnchor="middle"
            >
              {name[0]}
            </text>
            <text className="fl-account-name" x={x + 46} y={ry + 22}>
              {name}
            </text>
            <text
              className={cn("fl-meta", pct >= SWITCH_AT - 5 && "is-hot")}
              x={x + w - 16}
              y={ry + 22}
              textAnchor="end"
            >
              {`${pct}%`}
            </text>
            <rect
              className="fl-track"
              x={x + 16}
              y={ry + 34}
              width={w - 32}
              height={4}
              rx={2}
            />
            <rect
              className={cn("fl-usage", pct >= SWITCH_AT - 5 && "is-hot")}
              x={x + 16}
              y={ry + 34}
              width={((w - 32) * Math.min(100, usage[i])) / 100}
              height={4}
              rx={2}
            />
          </g>
        );
      })}
      <text
        className={cn("fl-foot", justSwitched && "is-news")}
        x={x + 16}
        y={y + h - 18}
      >
        {justSwitched
          ? `Switched to ${ACCOUNTS[active]} near the limit`
          : `Auto-switch at ${SWITCH_AT}%`}
      </text>
    </g>
  );
}

function Review({
  box,
  hit,
  review,
}: {
  box: Box;
  hit: boolean;
  review: FlowSim["review"];
}) {
  const { x, y, w } = box;
  const add = review.files.reduce((n, f) => n + f.add, 0);
  const del = review.files.reduce((n, f) => n + f.del, 0);
  return (
    <g className={cn("fl-node", hit && "is-hit")}>
      <rect className="fl-card" x={x} y={y} width={w} height={box.h} rx={14} />
      <text className="fl-title" x={x + 16} y={y + 27}>
        Review
      </text>
      <text className="fl-meta" x={x + 68} y={y + 27}>
        {review.agent}
      </text>
      <text x={x + w - 16} y={y + 27} textAnchor="end" className="fl-diff">
        <tspan className="is-add">{`+${add}`}</tspan>
        <tspan className="is-del" dx={6}>{`−${del}`}</tspan>
      </text>
      <g transform={`translate(${x + 12} ${y + 40})`}>
        <rect className="fl-proof" width={w - 24} height={28} rx={8} />
        <Check
          x={9}
          y={7}
          width={14}
          height={14}
          strokeWidth={2.4}
          className="fl-proof-icon"
        />
        <text className="fl-proof-text" x={29} y={18}>
          Proof of done: checks passed
        </text>
      </g>
      {review.files.map((file, i) => (
        <g key={file.path}>
          <text className="fl-file" x={x + 16} y={y + 94 + i * 19}>
            {file.path}
          </text>
          <text
            x={x + w - 16}
            y={y + 94 + i * 19}
            textAnchor="end"
            className="fl-diff is-small"
          >
            <tspan className="is-add">{`+${file.add}`}</tspan>
            <tspan className="is-del" dx={4}>{`−${file.del}`}</tspan>
          </text>
        </g>
      ))}
      <g transform={`translate(${x + 12} ${y + 132})`}>
        <rect className="fl-btn" width={62} height={24} rx={12} />
        <text className="fl-btn-text" x={31} y={16} textAnchor="middle">
          Keep all
        </text>
        <rect
          className={cn("fl-btn-primary", review.pressed && "is-pressed")}
          x={70}
          width={w - 24 - 70}
          height={24}
          rx={12}
        />
        <text
          className="fl-btn-primary-text"
          x={70 + (w - 24 - 70) / 2}
          y={16}
          textAnchor="middle"
        >
          Commit, push &amp; PR
        </text>
      </g>
    </g>
  );
}

function Activity({
  box,
  log,
  now,
}: {
  box: Box;
  log: LogItem[];
  now: number;
}) {
  const { x, y, w, h } = box;
  return (
    <g className="fl-node">
      <rect className="fl-card" x={x} y={y} width={w} height={h} rx={14} />
      <text className="fl-label" x={x + 16} y={y + 26}>
        Activity
      </text>
      {log.map((item, i) => {
        const ry = y + 52 + i * 26;
        const Icon = LOG_ICON[item.icon];
        return (
          <g key={item.id} className={cn("fl-log", i === 0 && "is-new")}>
            <Icon
              x={x + 16}
              y={ry - 10}
              width={13}
              height={13}
              strokeWidth={1.8}
              className="fl-log-icon"
            />
            <text className="fl-log-text" x={x + 38} y={ry}>
              {short(item.text, 22)}
            </text>
            <text className="fl-meta" x={x + w - 16} y={ry} textAnchor="end">
              {age(now - item.at)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** A small chat window: sidebar, a question, an answer, a tool row with a live dot, the composer. */
function MiniChat({
  w,
  h,
  sidebar,
}: {
  w: number;
  h: number;
  sidebar?: boolean;
}) {
  const cx = sidebar ? 52 : 10;
  const cw = w - cx - 10;
  return (
    <g>
      {sidebar ? (
        <>
          <rect className="fl-ui-pane" width={44} height={h} />
          {[30, 22, 26, 18].map((lw, i) => (
            <rect
              key={lw}
              className={cn("fl-ui-line", i === 0 && "is-accent")}
              x={7}
              y={12 + i * 10}
              width={lw}
              height={3}
              rx={1.5}
            />
          ))}
        </>
      ) : null}
      <rect
        className="fl-ui-bubble"
        x={cx + cw * 0.5}
        y={10}
        width={cw * 0.5}
        height={9}
        rx={4.5}
      />
      {[0.92, 0.74, 0.84].map((lw, i) => (
        <rect
          key={lw}
          className="fl-ui-line"
          x={cx}
          y={28 + i * 7}
          width={cw * lw}
          height={3}
          rx={1.5}
        />
      ))}
      <rect
        className="fl-ui-tool"
        x={cx}
        y={52}
        width={cw * 0.62}
        height={11}
        rx={3}
      />
      <circle className="fl-ui-live" cx={cx + 6} cy={57.5} r={2} />
      <rect
        className="fl-ui-composer"
        x={cx - 2}
        y={h - 22}
        width={cw + 4}
        height={15}
        rx={7.5}
      />
      <circle className="fl-ui-send" cx={cx + cw - 6} cy={h - 14.5} r={3.5} />
    </g>
  );
}

function LaptopArt() {
  return (
    <g>
      <rect
        className="fl-bezel"
        x={14}
        y={0}
        width={192}
        height={122}
        rx={10}
      />
      <rect
        className="fl-screen"
        x={20}
        y={6}
        width={180}
        height={110}
        rx={5}
      />
      <g transform="translate(20 6)">
        <MiniChat w={180} h={110} sidebar />
      </g>
      <path
        className="fl-base"
        d="M0 122 H220 L214 130 Q213 132 210 132 H10 Q7 132 6 130 Z"
      />
      <rect
        className="fl-notch"
        x={92}
        y={122}
        width={36}
        height={3}
        rx={1.5}
      />
    </g>
  );
}

function BrowserArt() {
  return (
    <g>
      <rect className="fl-bezel" width={150} height={100} rx={10} />
      <line className="fl-divider" x1={0} x2={150} y1={20} y2={20} />
      {[12, 21, 30].map((cx) => (
        <circle key={cx} className="fl-ui-dot" cx={cx} cy={10} r={2.5} />
      ))}
      <rect
        className="fl-ui-url"
        x={42}
        y={5.5}
        width={94}
        height={9}
        rx={4.5}
      />
      <g transform="translate(0 20)">
        <MiniChat w={150} h={80} />
      </g>
    </g>
  );
}

/** A phone showing the approval card agents send when they need a yes. */
function PhoneArt() {
  return (
    <g>
      <rect className="fl-bezel" width={56} height={112} rx={14} />
      <rect className="fl-screen" x={4} y={4} width={48} height={104} rx={10} />
      <rect
        className="fl-island"
        x={21}
        y={8}
        width={14}
        height={4.5}
        rx={2.25}
      />
      <rect
        className="fl-ui-line is-strong"
        x={10}
        y={20}
        width={22}
        height={3}
        rx={1.5}
      />
      <rect
        className="fl-ui-line"
        x={10}
        y={30}
        width={36}
        height={3}
        rx={1.5}
      />
      <rect
        className="fl-ui-line"
        x={10}
        y={37}
        width={28}
        height={3}
        rx={1.5}
      />
      <rect className="fl-ui-card" x={8} y={50} width={40} height={34} rx={6} />
      <rect
        className="fl-ui-line is-strong"
        x={12}
        y={56}
        width={26}
        height={3}
        rx={1.5}
      />
      <rect
        className="fl-ui-line"
        x={12}
        y={62}
        width={20}
        height={3}
        rx={1.5}
      />
      <rect
        className="fl-ui-btn"
        x={12}
        y={72}
        width={14}
        height={7}
        rx={3.5}
      />
      <rect
        className="fl-ui-btn is-approve"
        x={30}
        y={72}
        width={14}
        height={7}
        rx={3.5}
      />
      <rect
        className="fl-ui-home"
        x={20}
        y={101}
        width={16}
        height={2}
        rx={1}
      />
    </g>
  );
}

/** GitHub's mark (Octicons mark-github, 16px grid). */
function GithubMark({ x, y }: { x: number; y: number }) {
  return (
    <path
      className="fl-mark"
      transform={`translate(${x} ${y}) scale(1.125)`}
      d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
    />
  );
}
