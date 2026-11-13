// ADEMark method, unofficial (own macOS account). A runner that reuses ADEMark's instruments (replay server, the
// native helper's keys/sample/idle/procs, the TASKS.md prompts, the A1-A11 procedures of TESTS.md) to measure Volt
// and the installed competitors the same way, in a normal user account, without the `ademark` user.
//
// What differs from an official run (say it next to every number):
//   - no `sudo purge` before A1 (cold = every attributed process killed, launch agents booted out, no purge);
//   - the quiet gate cannot reach 0.1 core on a shared laptop: each run records the cores busy and `uptime`;
//   - without the Screen Recording grant, Ready is read from the DOM over CDP for Electron apps ("DOM echo":
//     the probe text is in the focused composer), and only "first window on screen" for native apps;
//     the probe keys are still real CGEventPost keystrokes from ademark-native;
//   - Electron apps launch with --remote-debugging-port and --use-mock-keychain (the method forbids CDP on a timed
//     launch; we have no pixel reader, so every Electron app pays it alike);
//   - every app runs with an isolated HOME and profile (never the user's), pointed at the replay server through
//     ANTHROPIC_BASE_URL, with a dummy API key.
//
// Usage: bun run.ts --app <id> --tests A1,A2,A3,A4,A5,A6,A8,A11 --reps 5 --out <dir>
//        bun run.ts --app <id> --launch | --quit | --kill      (setup helpers)
import { spawn, spawnSync } from "bun";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowNs } from "/tmp/ademark/bench/core/clock.ts";

const NATIVE = process.env.ADEMARK_NATIVE ?? "/tmp/ademark/bench/native/bin/ademark-native";
const WINWAIT = process.env.ADE_WINWAIT ?? "/tmp/v3-ade-h/winwait";
const REPLAY_LOG = process.env.ADE_REPLAY_LOG ?? "/tmp/v3-ade-replay/requests.jsonl";
const REPLAY_URL = process.env.ADE_REPLAY_URL ?? "http://127.0.0.1:18951";
const CDP_PORT = Number(process.env.ADE_CDP_PORT ?? 9951);
const PROBE = "ademarkqz";
const WORKTREE = "/Users/leularia/Desktop/VOLT/volt-e3-ade";

// ---------------------------------------------------------------- apps

interface App {
  id: string;
  label: string;
  bundle: string;              // attribution prefix (the copy we launch)
  home: string;                // isolated HOME
  electron: boolean;           // CDP readiness
  launch(): string[];          // argv of the launch (open -n -a ... or a direct exec)
  newThread?: string;          // shortcut combo
  launchdLabels?(): string[];  // launch agents to boot out for a cold start
  // JS run in the page: the text of the focused composer, or null when no composer is focused.
  composerText: string;
  // JS: true when the thread on screen is a fresh one (A3).
  isNewThread?: string;
  // JS: the text of the answer area of the current thread (A4).
  answerText?: string;
  pagePick?: (targets: Array<{ type: string; url: string; title: string }>) => number;
}

const COMPOSER_GENERIC = `(()=>{const a=document.activeElement; if(!a||a===document.body) return null;
  const ed=a.closest('.monaco-editor'); if(ed) return ed.querySelector('.view-lines')?.textContent ?? '';
  if(a.isContentEditable) return a.textContent; if('value' in a && (a.tagName==='TEXTAREA'||a.tagName==='INPUT')) return a.value; return null})()`;

const env = (home: string, extra: Record<string, string> = {}) => {
  const vars: Record<string, string> = {
    HOME: home,
    // The same `claude` (2.1.322) first on PATH for every app (ADEMark equal conditions, item 8).
    PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    ANTHROPIC_BASE_URL: REPLAY_URL,
    // Track B (ADE_REAL_API=1, REPLAY_URL = the capture proxy): the account's own Claude login, no dummy key.
    ...(process.env.ADE_REAL_API ? {} : { ANTHROPIC_API_KEY: "sk-ant-replay-0000" }),
    DISABLE_AUTOUPDATER: "1",
    ...extra,
  };
  return Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
};

const H = "/tmp/v3-ade-h";
// ADE_KEEP_RENDERING=1: Chromium keeps painting a covered or background window. The user works at this Mac, so a test
// window can be covered at any moment, and a covered Electron window stops its animation frames (A4, A8 and A11 read
// the DOM after frames). Used only for A3, A4, A8 and A11, never for the launch, weight and idle tests, and the same
// for every Electron app.
const KEEP = process.env.ADE_KEEP_RENDERING ? ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] : [];
// Isolated HOMEs live outside /tmp: Volt's sandbox refuses to start an agent when a folder it must make writable
// (/tmp, the temp folders) is the HOME or one of its parents.
const HOMES = "/Users/leularia/.volt-r3/ade/h";
const APPS: Record<string, App> = {
  "volt-rel": {
    id: "volt-rel",
    label: "Volt 0.0.6 (installed build, copy)",
    bundle: "/tmp/v3-apps/Volt.app",
    home: `${HOMES}/volt`,
    electron: true,
    launch: () => ["open", "-n", "-a", "/tmp/v3-apps/Volt.app", ...env(`${HOMES}/volt`), "--args", "--use-mock-keychain",
      "--user-data-dir", "/tmp/v3-ade-ud", "--extensions-dir", `${HOMES}/volt/.volt/extensions`, `--remote-debugging-port=${CDP_PORT}`, ...KEEP,
      ...(process.env.ADE_OPEN ? [process.env.ADE_OPEN] : [])],
    newThread: "cmd+n",
    launchdLabels: () => [voltLabel("/tmp/v3-ade-ud")],
    composerText: `(()=>{const a=document.activeElement; const ed=a?.closest('.volt-agent-composer .monaco-editor'); return ed? (ed.querySelector('.view-lines')?.textContent ?? '') : null})()`,
    isNewThread: `(()=>{const m=document.querySelector('.volt-agent-editor'); return !!m && !m.querySelector('.volt-agent-reply')})()`,
    answerText: `(()=>[...document.querySelectorAll('.volt-agent-editor .volt-agent-reply')].map(e=>e.textContent).join('\\n'))()`,
    pagePick: (t) => t.findIndex((x) => x.type === "page" && /workbench\.html/.test(x.url)),
  },
  "volt-dev": {
    id: "volt-dev",
    label: "Volt dev build (worktree e3/ade, unbundled out/)",
    // A private copy of the dev Electron: the worktree's .build/electron is a symlink to the main checkout's, which
    // the user's own dev Volt runs, so attribution by executable path would count (and kill) the user's processes.
    bundle: `${H}/electron/VOLT.app`,
    home: `${HOMES}/volt-dev`,
    electron: true,
    // Opened by LaunchServices like every other app (an exec'd process is never made frontmost, so the probe keys,
    // which go only to the frontmost app, would never land), with scripts/code.sh's environment and the worktree
    // as the app folder.
    launch: () => ["open", "-n", "-a", `${H}/electron/VOLT.app`, ...env(`${HOMES}/volt-dev`, {
      NODE_ENV: "development", VSCODE_DEV: "1", VSCODE_CLI: "1", VSCODE_SKIP_PRELAUNCH: "1",
      // A dev checkout on the Desktop starts its agent server detached (TCC); with HOME moved off the real home Volt
      // would pick launchd instead, so the dev arm keeps what a real dev run does.
      VOLT_AGENT_SERVER_LAUNCHD: "0",
    }), "--args", WORKTREE,
      "--disable-extension=vscode.vscode-api-tests", "--use-mock-keychain", "--user-data-dir", "/tmp/v3-ade-ud-dev",
      "--extensions-dir", `${HOMES}/volt-dev/.volt/extensions`, `--remote-debugging-port=${CDP_PORT}`, ...KEEP, ...(process.env.ADE_OPEN ? [process.env.ADE_OPEN] : [])],
    newThread: "cmd+n",
    launchdLabels: () => [voltLabel("/tmp/v3-ade-ud-dev")],
    composerText: "",
    pagePick: (t) => t.findIndex((x) => x.type === "page" && /workbench(-dev)?\.html/.test(x.url)),
  },
  t3: {
    id: "t3",
    label: "T3 Code (Nightly) 0.1.6-nightly.20261029",
    bundle: "/tmp/v3-apps/T3 Code (Nightly).app",
    home: `${HOMES}/t3`,
    electron: true,
    launch: () => ["open", "-n", "-a", "/tmp/v3-apps/T3 Code (Nightly).app",
      ...env(`${HOMES}/t3`, { T3CODE_PORT: "18953", T3CODE_HOME: `${HOMES}/t3/.t3`, T3CODE_DISABLE_AUTO_UPDATE: "1", T3CODE_TELEMETRY_ENABLED: "false" }),
      "--args", "--use-mock-keychain", `--user-data-dir=${HOMES}/t3/ud`, `--remote-debugging-port=${CDP_PORT}`, ...KEEP],
    newThread: "cmd+n",
    composerText: COMPOSER_GENERIC,
  },
  paseo: {
    id: "paseo",
    label: "Paseo 0.9.2",
    bundle: "/tmp/v3-apps/Paseo.app",
    home: `${HOMES}/paseo`,
    electron: true,
    // Paseo's CLI parser refuses unknown argv options; its own env knobs set the profile and the Chromium switches.
    launch: () => ["open", "-n", "-a", "/tmp/v3-apps/Paseo.app", ...env(`${HOMES}/paseo`, { PASEO_ELECTRON_USER_DATA_DIR: `${HOMES}/paseo/ud`,
      PASEO_ELECTRON_FLAGS: [`--remote-debugging-port=${CDP_PORT}`, "--use-mock-keychain", ...KEEP].join(" ") })],
    newThread: "cmd+n", // 0.9.2: Cmd+N opens a new chat in the project (checked); the 0.15 profile uses Cmd+Shift+A
    composerText: COMPOSER_GENERIC,
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude.app 3.1623.3 (signed out: own sign-in, not seeded)",
    bundle: "/tmp/v3-apps/Claude.app",
    home: `${HOMES}/claude-desktop`,
    electron: true,
    launch: () => ["open", "-n", "-a", "/tmp/v3-apps/Claude.app", ...env(`${HOMES}/claude-desktop`),
      "--args", "--use-mock-keychain", `--user-data-dir=${HOMES}/claude-desktop/ud`],
    // Signed out (its own sign-in, not seeded) and launched without CDP: first window only.
    composerText: "",
  },
  zeron: {
    id: "zeron",
    label: "Zeron 0.2.79",
    bundle: "/tmp/v3-apps/Zeron.app",
    home: `${HOMES}/zeron`,
    electron: false,
    launch: () => ["open", "-n", "-a", "/tmp/v3-apps/Zeron.app", ...env(`${HOMES}/zeron`)],
    composerText: "",
  },
  monocode: {
    id: "monocode",
    label: "MonoCode 0.7.0",
    bundle: "/tmp/v3-apps/MonoCode.app",
    home: `${HOMES}/monocode`,
    electron: false,
    launch: () => ["open", "-n", "-a", "/tmp/v3-apps/MonoCode.app", ...env(`${HOMES}/monocode`)],
    composerText: "",
  },
  super: {
    id: "super",
    label: "super.engineering nightly 1e2bdc15",
    bundle: "/tmp/v3-apps/se/super.engineering.app",
    home: `${HOMES}/super`,
    electron: false,
    launch: () => ["open", "-n", "-a", "/tmp/v3-apps/se/super.engineering.app", ...env(`${HOMES}/super`)],
    composerText: "",
  },
};
APPS["volt-dev"]!.composerText = APPS["volt-rel"]!.composerText;
APPS["volt-dev"]!.isNewThread = APPS["volt-rel"]!.isNewThread;
APPS["volt-dev"]!.answerText = APPS["volt-rel"]!.answerText;

function voltLabel(ud: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(ud).digest("hex").slice(0, 12);
  return `com.volt.agent-server.${hash}`;
}

// ---------------------------------------------------------------- small helpers

/** `open` returns once LaunchServices took the request; a direct exec (the dev build) runs detached with its log. */
function launchApp(app: App): void {
  const argv = app.launch();
  if (argv[0] === "open") { spawnSync(argv); return; }
  mkdirSync(`${H}/logs`, { recursive: true });
  const log = openSync(`${H}/logs/${app.id}.log`, "a");
  const p = spawn(argv, { stdout: log, stderr: log, stdin: "ignore" });
  p.unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;

function native(args: string[]): any {
  const r = spawnSync([NATIVE, ...args]);
  const out = r.stdout.toString().trim();
  try { return JSON.parse(out); } catch { return { error: "parse", out, err: r.stderr.toString() }; }
}
async function nativeAsync(args: string[]): Promise<any> {
  const p = spawn([NATIVE, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  try { return JSON.parse(out.trim()); } catch { return { error: "parse", out }; }
}
function uptime(): string { return spawnSync(["uptime"]).stdout.toString().trim(); }

interface Proc { pid: number; ppid: number; path: string; name: string; responsible_pid: number | null }
function procs(): Proc[] { return native(["procs"]) as Proc[]; }

/** Every process the app is responsible for: bundle path, isolated HOME, responsible pid, parent chain. */
function attributed(app: App, list = procs()): Proc[] {
  const strip = (p: string) => (p.startsWith("/private/") ? p.slice(8) : p);
  const roots = new Set<number>();
  const byPid = new Map(list.map((p) => [p.pid, p]));
  for (const p of list) {
    const path = strip(p.path ?? "");
    if (path.startsWith(strip(app.bundle)) || path.startsWith(strip(app.home))) roots.add(p.pid);
  }
  const ok = (p: Proc, depth = 0): boolean => {
    if (roots.has(p.pid)) return true;
    if (p.responsible_pid && p.responsible_pid !== p.pid && roots.has(p.responsible_pid)) return true;
    const parent = byPid.get(p.ppid);
    return !!parent && parent.pid > 1 && depth < 30 && ok(parent, depth + 1);
  };
  return list.filter((p) => p.pid > 1 && ok(p));
}

function mainPid(app: App): number | null {
  const exe = readFileSync(join(app.bundle, "Contents/Info.plist"), "utf8").match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)</)?.[1];
  const want = join(app.bundle, "Contents/MacOS", exe ?? "");
  const strip = (p: string) => (p.startsWith("/private/") ? p.slice(8) : p);
  const list = procs().filter((p) => strip(p.path ?? "") === strip(want));
  // The app is the one whose parent is launchd (Volt's agent server runs the same Electron binary as Node).
  const top = list.filter((p) => p.ppid === 1);
  const cands = (top.length ? top : list).filter((p) => !isAgentServer(p.pid));
  return cands.length ? Math.min(...cands.map((p) => p.pid)) : null;
}
function isAgentServer(pid: number): boolean {
  const cmd = spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
  return /volt-agent-server-main|bootstrap-fork|ELECTRON_RUN_AS_NODE/.test(cmd);
}

async function killAll(app: App): Promise<void> {
  const bootout = () => {
    for (const label of app.launchdLabels?.() ?? []) {
      spawnSync(["launchctl", "bootout", `gui/${process.getuid!()}/${label}`]);
      // The app writes its plist under the HOME it runs with (the isolated one).
      for (const home of [app.home, process.env.HOME]) {
        const plist = `${home}/Library/LaunchAgents/${label}.plist`;
        if (existsSync(plist)) spawnSync(["rm", "-f", plist]);
      }
    }
  };
  // Twice: a running app can install its launch agent again between the bootout and the kill.
  bootout();
  for (let round = 0; round < 3; round++) {
    if (round === 1) bootout();
    const pids = attributed(app).map((p) => p.pid).filter((p) => p !== process.pid);
    if (!pids.length) break;
    spawnSync(["kill", round < 2 ? "-TERM" : "-KILL", ...pids.map(String)]);
    await sleep(round < 2 ? 1500 : 500);
  }
  bootout();
}

// ---------------------------------------------------------------- CDP

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  static async connect(app: App, deadlineMs = 60_000): Promise<Cdp> {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(500) })).json() as any[];
        let idx = app.pagePick ? app.pagePick(targets) : -1;
        if (idx < 0) idx = targets.findIndex((t) => t.type === "page" && t.url && !t.url.startsWith("devtools:"));
        if (idx >= 0) {
          const c = new Cdp();
          c.ws = new WebSocket(targets[idx].webSocketDebuggerUrl);
          await new Promise((r, j) => { c.ws.addEventListener("open", r, { once: true }); c.ws.addEventListener("error", j, { once: true }); setTimeout(() => j(new Error("CDP open timeout")), 5000); });
          c.ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id) { c.pending.get(m.id)?.(m); c.pending.delete(m.id); } });
          return c;
        }
      } catch { /* not up yet */ }
      await sleep(15);
    }
    throw new Error("CDP target not found");
  }
  // A send never waits forever: a page that goes away (Cmd+Q, a crash) never answers, and the run hung on that once.
  send(method: string, params: any = {}, timeoutMs = 30_000): Promise<any> {
    return new Promise((r) => {
      const i = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(i); r({ error: "timeout" }); }, timeoutMs);
      this.pending.set(i, (m) => { clearTimeout(timer); r(m); });
      try { this.ws.send(JSON.stringify({ id: i, method, params })); } catch { clearTimeout(timer); this.pending.delete(i); r({ error: "closed" }); }
    });
  }
  async eval<T = any>(expr: string): Promise<T | undefined> {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result?.result?.value as T | undefined;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

function hasProbePair(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase().replace(/[^a-z]/g, "");
  const ring = PROBE + PROBE;
  for (let i = 0; i < PROBE.length; i++) if (t.includes(ring.slice(i, i + 2))) return true;
  return false;
}

/**
 * How probe keys reach the app. `native`: ademark-native's CGEventPost, the official way, which posts only while the
 * app is frontmost. `cdp` (default here): Input.dispatchKeyEvent into the page. The user works at this Mac while the
 * rig runs, so a probe that needs the app frontmost would either be refused or steal the user's keyboard; CDP keys
 * reach the focused element of a background window. They skip the OS-to-renderer hop (well under a frame), so every
 * Electron app is measured the same way and the numbers are labelled "cdp keys".
 */
const KEYS = process.env.ADE_KEYS ?? "cdp";
const MODS: Record<string, number> = { alt: 1, ctrl: 2, cmd: 4, shift: 8 };
async function cdpCombo(cdp: Cdp, combo: string): Promise<bigint> {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const modifiers = parts.reduce((m, p) => m | (MODS[p] ?? 0), 0);
  const named: Record<string, [string, string, number, string?]> = {
    enter: ["Enter", "Enter", 13, "\r"], delete: ["Backspace", "Backspace", 8], escape: ["Escape", "Escape", 27],
  };
  const [k, code, vk, text] = named[key] ?? [key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
  const t = nowNs();
  await cdp.send("Input.dispatchKeyEvent", { type: text && !modifiers ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text && !modifiers ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  return t;
}
async function cdpChar(cdp: Cdp, ch: string): Promise<bigint> {
  const t = nowNs();
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), text: ch });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
  return t;
}
/** One probe character; the host time it was sent, or null when it could not be. */
async function typeChar(pid: number | null, cdp: Cdp | null, ch: string): Promise<bigint | null> {
  if (KEYS === "cdp") return cdp ? cdpChar(cdp, ch).catch(() => null) : null;
  if (!pid) return null;
  const r = await nativeAsync(["keys", "--pid", String(pid), "--text", ch]);
  return r?.t_ns ? BigInt(r.t_ns) : null;
}
async function pressCombo(pid: number, cdp: Cdp | null, combo: string): Promise<bigint | null> {
  if (KEYS === "cdp" && cdp) return cdpCombo(cdp, combo);
  const r = native(["keys", "--pid", String(pid), ...(combo === "enter" ? ["--enter"] : ["--combo", combo])]);
  return r?.t_ns ? BigInt(r.t_ns) : null;
}
async function typeText(pid: number, cdp: Cdp | null, text: string): Promise<void> {
  if (KEYS === "cdp" && cdp) { await cdp.send("Input.insertText", { text }); return; }
  native(["keys", "--pid", String(pid), "--text", text]);
}

/**
 * The echo timer, DOM edition: sends one probe character every 50 ms +-20 % (see KEYS) and polls the focused
 * composer's text over CDP. Ready is the host time of the first poll (midpoint of its round trip) whose composer
 * text holds a probe pair.
 */
async function domEcho(app: App, cdp: Cdp | null, pid: () => number | null, t0: bigint, timeoutMs: number, extraCheck?: string,
  getCdp?: () => Promise<Cdp>): Promise<{ readyMs: number | null; typed: number; skipped: number; cdp: Cdp | null }> {
  let done = false; let typed = 0; let skipped = 0; let i = 0;
  const typer = (async () => {
    while (!done) {
      const t = await typeChar(pid(), cdp, PROBE[i % PROBE.length]!);
      if (t !== null) { typed++; i++; } else skipped++;
      await sleep(50 * (0.8 + Math.random() * 0.4));
    }
  })();
  let readyMs: number | null = null;
  const end = Date.now() + timeoutMs;
  const expr = extraCheck ? `(()=>{const t=${app.composerText}; return t===null?null:(${extraCheck}?t:'__old__')})()` : app.composerText;
  while (Date.now() < end) {
    if (!cdp && getCdp) { try { cdp = await getCdp(); } catch { /* */ } }
    if (cdp) {
      const a = nowNs();
      let text: string | null | undefined;
      try { text = await cdp.eval<string | null>(expr); } catch { text = null; }
      const b = nowNs();
      if (text && text !== "__old__" && hasProbePair(text)) { readyMs = ms(t0, (a + b) / 2n); break; }
    }
    await sleep(4);
  }
  done = true;
  await typer;
  return { readyMs, typed, skipped, cdp };
}

async function clearComposer(pid: number, cdp: Cdp | null = null) {
  await pressCombo(pid, cdp, "cmd+a");
  await pressCombo(pid, cdp, "delete");
}

// ---------------------------------------------------------------- tests

let OUT = "";
let GATE: { load1: number; waited_s: number; ok: boolean } | undefined;
function row(r: Record<string, unknown>) {
  // Every row carries the load gate of its test (see loadGate).
  const line = JSON.stringify({ at: new Date().toISOString(), uptime: uptime(), ...r, load_gate: GATE });
  console.log(line);
  appendFileSync(join(OUT, "rows.jsonl"), line + "\n");
}

async function quiet() { return native(["idle", "--cpu-cores", process.env.ADE_QUIET_CORES ?? "3", "--quiet-ms", "1000", "--cap-s", "20"]); }

async function quitApp(app: App): Promise<string> {
  const pid = mainPid(app);
  if (!pid) return "not running";
  // Quit like a user: Cmd+Q when the app is frontmost. ADEMark uses `osascript quit app "<name>"`; by name or bundle id
  // that would also reach the user's own running copy, so it is never used here. Volt's Cmd+Q is a renderer
  // keybinding, so CDP delivers it; other Electron apps quit on SIGTERM (checked: T3 exits with its server).
  let how = "cmd+q";
  const k = native(["keys", "--pid", String(pid), "--combo", "cmd+q"]);
  if (!k?.t_ns) {
    if (app.id.startsWith("volt")) {
      how = "cdp cmd+q";
      try {
        const c = await Cdp.connect(app, 3000);
        await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 4 }, 2000);
        await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 4 }, 2000);
        c.close();
      } catch { /* */ }
    } else {
      how = "SIGTERM";
      spawnSync(["kill", "-TERM", String(pid)]);
    }
  }
  for (let i = 0; i < 90; i++) { if (!mainPid(app)) return how; await sleep(500); }
  spawnSync(["kill", "-TERM", String(pid)]);
  for (let i = 0; i < 20; i++) { if (!mainPid(app)) return how + " (then SIGTERM after 45 s)"; await sleep(500); }
  return "still running";
}

/** A1 (cold) and A2 (relaunch): launch -> first window, and launch -> typing accepted (DOM echo, Electron only). */
async function launchTest(app: App, test: "A1" | "A2", rep: number) {
  // A1: quit normally, then kill what is left (daemons, launch agents); A2: quit normally and leave the rest alive.
  let quitHow = mainPid(app) ? await quitApp(app) : "";
  if (test === "A1") await killAll(app);
  const gate = await quiet();
  const win = spawn([WINWAIT, "--prefix", app.bundle, "--timeout-s", "60"], { stdout: "pipe" });
  await sleep(50);
  const t0 = nowNs();
  launchApp(app);
  let readyMs: number | null = null; let typed = 0; let skipped = 0;
  let pid: number | null = null;
  const pidOf = () => (pid ??= mainPid(app));
  if (app.electron && app.composerText) {
    const r = await domEcho(app, null, pidOf, t0, 60_000, undefined, () => Cdp.connect(app, 200));
    readyMs = r.readyMs; typed = r.typed; skipped = r.skipped; r.cdp?.close();
  }
  const w = JSON.parse((await new Response(win.stdout).text()).trim() || "{}");
  const windowMs = w.t_ns ? ms(t0, BigInt(w.t_ns)) : null;
  if (readyMs !== null && pidOf()) {
    const c = await Cdp.connect(app, 3000).catch(() => null);
    await clearComposer(pidOf()!, c);
    c?.close();
  }
  row({ app: app.id, test, rep, pid: pid, window_ms: windowMs, ready_ms: readyMs, method: app.electron && app.composerText ? `dom-echo, ${KEYS} keys` : "window-only", typed, skipped, quit: quitHow, gate_quiet: gate.quiet, gate_cores: gate.cores_last });
}

/** A3: new-thread shortcut -> typing accepted in a fresh thread. */
async function newThreadTest(app: App, rep: number) {
  const pid = mainPid(app)!;
  const cdp = await Cdp.connect(app);
  await clearComposer(pid, cdp);
  await sleep(500);
  const t0 = (await pressCombo(pid, cdp, app.newThread!))!;
  const r = await domEcho(app, cdp, () => pid, t0, 30_000, app.isNewThread ?? "true");
  await clearComposer(pid, cdp);
  // Leave a seeded thread on screen for the next repetition (TESTS.md A3 step 5), untimed.
  await typeText(pid, cdp, "replay:seed");
  await sleep(200);
  await pressCombo(pid, cdp, "enter");
  await sleep(4000);
  cdp.close();
  row({ app: app.id, test: "A3", rep, ready_ms: r.readyMs, method: `dom-echo, ${KEYS} keys`, typed: r.typed });
}

function replayRequestsAfter(t0: bigint): Array<{ t_ns: number; session: string | null; bytes: number; user_agent: string }> {
  if (!existsSync(REPLAY_LOG)) return [];
  return readFileSync(REPLAY_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => BigInt(x.t_ns) >= t0);
}

/** A4: Enter -> first word of the answer on screen; split at the replay server's receive time. */
async function firstWordTest(app: App, rep: number) {
  const pid = mainPid(app)!;
  const cdp = await Cdp.connect(app);
  await pressCombo(pid, cdp, app.newThread!);
  await sleep(1500);
  await typeText(pid, cdp, "replay:hi");
  await sleep(400);
  const t0 = (await pressCombo(pid, cdp, "enter"))!;
  let seenMs: number | null = null; let seenText = "";
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const a = nowNs();
    const text = (await cdp.eval<string>(app.answerText!)) ?? "";
    const b = nowNs();
    // LEDGERMARK when the replay matched the prompt; otherwise the replay's fixed "ok" for unknown requests.
    if (/LEDGERMARK/.test(text) || /\bok\b/i.test(text)) { seenMs = ms(t0, (a + b) / 2n); seenText = text.slice(0, 40); break; }
    await sleep(4);
  }
  await sleep(1500);
  const reqs = replayRequestsAfter(t0);
  const main = reqs.find((x) => x.session === "hi") ?? reqs.sort((x, y) => y.bytes - x.bytes)[0];
  const tReq = main ? ms(t0, BigInt(main.t_ns)) : null;
  cdp.close();
  row({ app: app.id, test: "A4", rep, total_ms: seenMs, before_request_ms: tReq, on_screen_ms: seenMs !== null && tReq !== null ? seenMs - tReq : null,
    matched_session: main?.session ?? null, seen: seenText, requests: reqs.length, side_calls: reqs.filter((x) => x !== main).length, method: "dom" });
}

/** A5 + A6: settle, then 60 s at 4 Hz with ademark-native sample; app vs agents vs total; CPU from the CSV. */
async function weighIn(app: App, rep: number) {
  const pid = mainPid(app)!;
  const rules = {
    rootPids: [pid],
    bundlePaths: [app.bundle, app.bundle.replace(/^\/tmp\//, "/private/tmp/")],
    vendorDirs: [app.home],
    agentExecutables: ["claude", "codex", "claude-agent-acp", "/opt/homebrew/Cellar/node", "/opt/homebrew/bin/node", "/.local/share/claude/versions/", "claude-agent-sdk-darwin-arm64"],
    excludeNames: [] as string[],
  };
  const rulesPath = join(OUT, `rules-${app.id}.json`);
  writeFileSync(rulesPath, JSON.stringify(rules));
  // Settle: ADEMark waits for a slope under 1 MB/min over 60 s (cap 10 min). We wait a fixed 90 s after ready.
  await sleep(Number(process.env.ADE_SETTLE_MS ?? 90_000));
  const csv = join(OUT, `samples-${app.id}-A5-${rep}.csv`);
  const s = native(["sample", "--rules", rulesPath, "--hz", "4", "--duration-s", "60", "--csv", csv]);
  const cpu = cpuFromCsv(csv);
  row({ app: app.id, test: "A5", rep, app_mb: s.app_median_b / 1048576, agents_mb: s.agents_median_b / 1048576, total_mb: s.total_median_b / 1048576, pids: s.pids, ...cpu.mem });
  row({ app: app.id, test: "A6", rep, cpu_pct_front: cpu.appPct, cpu_pct_total: cpu.totalPct, wakeups_per_s: cpu.wakeups });
}

function cpuFromCsv(csv: string) {
  const lines = readFileSync(csv, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const byPid = new Map<string, { first: string[]; last: string[] }>();
  const ticks = [...new Set(lines.map((l) => l[0]))].sort();
  for (const l of lines) { const e = byPid.get(l[1]!); if (!e) byPid.set(l[1]!, { first: l, last: l }); else e.last = l; }
  const wall = (Number(ticks.at(-1)) - Number(ticks[0])) / 1e9;
  let app = 0, all = 0, wake = 0;
  const lastTick = ticks.at(-1);
  const roles = new Map<string, number>();
  for (const [, e] of byPid) {
    const d = (Number(e.last[7]) + Number(e.last[8]) - Number(e.first[7]) - Number(e.first[8])) / 1e9;
    all += d; if (e.first[3] === "app") app += d;
    wake += Number(e.last[9]) + Number(e.last[10]) - Number(e.first[9]) - Number(e.first[10]);
    if (e.last[0] === lastTick) {
      const exe = e.last[4]!.split("/").pop()!;
      roles.set(exe, (roles.get(exe) ?? 0) + Number(e.last[5]) / 1048576);
    }
  }
  return { appPct: (app / wall) * 100, totalPct: (all / wall) * 100, wakeups: wake / wall,
    mem: { by_exe_mb: Object.fromEntries([...roles].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)])) } };
}

/** A8: 5 streams (replay:stream-1..5 in 5 new threads), then 60 keystrokes at 250 ms +-20 % in thread 1's composer. */
async function typingLag(app: App, rep: number) {
  const pid = mainPid(app)!;
  let cdp = await Cdp.connect(app);
  for (let s = 1; s <= 5; s++) {
    await pressCombo(pid, cdp, app.newThread!);
    await sleep(1500);
    await typeText(pid, cdp, `replay:stream-${s}`);
    await sleep(300);
    await pressCombo(pid, cdp, "enter");
    await sleep(2000);
  }
  // Back to the first stream's thread is app specific; we type in the composer of the thread on screen (stream 5),
  // which streams while the other four stream in the background (ADEMark keeps thread 1 in front).
  await sleep(5000);
  // Page side: keydown event time -> the first animation frame after the focused composer's own DOM changed (only the
  // composer is observed: the five streams mutate the page all the time).
  const armed = await cdp.eval<boolean>(`(()=>{window.__lag=[]; const pend=[]; const a=document.activeElement;
    const root=a&&(a.closest('.monaco-editor')||a.closest('[contenteditable]')||a.parentElement); if(!root) return false;
    addEventListener('keydown', e=>{ if(e.key.length===1) pend.push(e.timeStamp) }, true);
    const mo=new MutationObserver(()=>{ if(!pend.length) return; const t=pend.shift(); requestAnimationFrame(ts=>{ window.__lag.push(ts - t) }) });
    mo.observe(root,{subtree:true,childList:true,characterData:true});
    window.__lagStop=()=>mo.disconnect(); return true})()`);
  let lost = 0;
  for (let k = 0; k < 60; k++) {
    if ((await typeChar(pid, cdp, PROBE[k % PROBE.length]!)) === null) lost++;
    await sleep(250 * (0.8 + Math.random() * 0.4));
  }
  await sleep(500);
  const lags = ((await cdp.eval<number[]>(`(()=>{window.__lagStop(); return window.__lag})()`)) ?? []).sort((a, b) => a - b);
  await clearComposer(pid, cdp);
  const reqs = replayRequestsAfter(0n).filter((x) => x.session?.startsWith("stream-")).length;
  const q = (p: number) => lags.length ? lags[Math.min(lags.length - 1, Math.floor(p * lags.length))] : null;
  cdp.close();
  row({ app: app.id, test: "A8", rep, p50: q(0.5), p95: q(0.95), max: lags.at(-1) ?? null, samples: lags.length, lost, armed, stream_requests_total: reqs, method: `dom: keydown.timeStamp -> rAF after composer mutation, ${KEYS} keys` });
}

/** A11: switch from a short thread to the long thread; time to LONGTHREAD-END in the viewport, and to DOM quiet (1 s). */
async function clickRow(cdp: Cdp, text: string): Promise<bigint> {
  const at = await cdp.eval<{ x: number; y: number } | null>(`(()=>{const r=[...document.querySelectorAll('.monaco-list-row')].find(e=>e.innerText.includes(${JSON.stringify(text)})); if(!r) return null; const b=r.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  if (!at) throw new Error(`row not found: ${text}`);
  const t = nowNs();
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
  return t;
}

async function longThread(app: App, rep: number, clickLong: (cdp: Cdp, arm: () => Promise<unknown>) => Promise<bigint>) {
  const cdp = await Cdp.connect(app);
  await cdp.eval(`(()=>{window.__lt={seen:null,last:performance.now()}; const mo=new MutationObserver(()=>{window.__lt.last=performance.now()}); mo.observe(document.querySelector(${JSON.stringify(process.env.ADE_THREAD_SEL ?? '.volt-agent-editor')})??document.body,{subtree:true,childList:true,characterData:true});
    const tick=()=>{ if(window.__lt.seen===null){ const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ if(n.data.includes('LONGTHREAD-END')){ const r=n.parentElement.getBoundingClientRect(); if(r.bottom>0&&r.top<innerHeight&&r.height>0){ window.__lt.seen=performance.now(); break } } } } if(window.__lt.seen===null||performance.now()-window.__lt.last<1000) requestAnimationFrame(tick); else window.__lt.done=true };
    window.__lt.arm=()=>{window.__lt.seen=null; window.__lt.t0=performance.now(); requestAnimationFrame(tick)}; return 1})()`);
  // Clock bridge: page performance.now() <-> host ns, from the round trip with the smallest delay.
  let best = { rtt: Infinity, off: 0 };
  for (let i = 0; i < 7; i++) {
    const a = nowNs(); const p = await cdp.eval<number>("performance.now()"); const b = nowNs();
    const rtt = ms(a, b); if (rtt < best.rtt) best = { rtt, off: Number((a + b) / 2n) / 1e6 - p! };
  }
  const visibility = await cdp.eval<string>("document.visibilityState");
  let r: any; let t0: bigint;
  // Closed on every path: an open socket left by a thrown clickRow kept bun alive after the last row (it hung once).
  try {
    t0 = await clickLong(cdp, () => cdp.eval("window.__lt.arm()"));
    for (let i = 0; i < 400; i++) { r = await cdp.eval(`(()=>({seen:window.__lt.seen,last:window.__lt.last,done:!!window.__lt.done}))()`); if (r?.done) break; await sleep(50); }
  } finally { cdp.close(); }
  const t0ms = Number(t0) / 1e6;
  row({ app: app.id, test: "A11", rep, open_visible_ms: r?.seen != null ? r.seen + best.off - t0ms : null, settled_ms: r?.last != null ? r.last + best.off - t0ms : null, clock_rtt_ms: best.rtt, visibility, method: "dom: marker in viewport; settled = no text or node change in the thread area for 1 s; document.visibilityState recorded" });
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const app = APPS[arg("--app")];
if (!app) { console.error(`--app one of ${Object.keys(APPS).join(", ")}`); process.exit(2); }
OUT = arg("--out", `/tmp/v3-ade-out/${app.id}`);
mkdirSync(OUT, { recursive: true });

if (argv.includes("--kill")) { await killAll(app); console.log("killed"); process.exit(0); }
if (argv.includes("--quit")) { console.log(await quitApp(app)); process.exit(0); }
if (argv.includes("--launch")) { launchApp(app); console.log("launched"); process.exit(0); }
if (argv.includes("--main-pid")) { console.log(mainPid(app)); process.exit(0); }
if (argv.includes("--attributed")) { console.log(attributed(app).map((p) => `${p.pid} ${p.ppid} ${p.name}`).join("\n")); process.exit(0); }

const tests = arg("--tests", "A1,A2").split(",");
const reps = Number(arg("--reps", "5"));
const start = Number(arg("--start", "1"));
/**
 * The round-3 load rule: no timing while the 1-minute load is above 14 (five agents share this 14-core Mac). Waits up
 * to ADE_LOAD_WAIT_S (default 1800 s), checking every 10 s; when the wait runs out the test is skipped with a
 * `skipped: load` row (ADE_LOAD_SKIP=0 runs it anyway, `load_gate.ok` false in its row, so a number taken under load
 * is never mistaken for a clean one).
 */
async function loadGate(): Promise<{ load1: number; waited_s: number; ok: boolean }> {
  const limit = Number(process.env.ADE_LOAD_MAX ?? 14);
  const maxWait = Number(process.env.ADE_LOAD_WAIT_S ?? 1800);
  const t = Date.now();
  for (;;) {
    const load1 = Number(/load averages?: ([\d.]+)/.exec(uptime())?.[1] ?? 99);
    const waited = Math.round((Date.now() - t) / 1000);
    if (load1 <= limit) return { load1, waited_s: waited, ok: true };
    if (waited >= maxWait) return { load1, waited_s: waited, ok: false };
    await sleep(10_000);
  }
}

for (let rep = start; rep < start + reps; rep++) {
  for (const t of tests) {
    GATE = await loadGate();
    if (!GATE.ok && process.env.ADE_LOAD_SKIP !== "0") { row({ app: app.id, test: t, rep, skipped: "load" }); continue; }
    try {
      if (t === "A1" || t === "A2") await launchTest(app, t, rep);
      else if (t === "A3") await newThreadTest(app, rep);
      else if (t === "A4") await firstWordTest(app, rep);
      else if (t === "A5") await weighIn(app, rep);
      else if (t === "A8") await typingLag(app, rep);
      else if (t === "A11") {
        // Rows are found by their text (--long-row, --short-row: a substring of the sidebar row) and clicked with CDP
        // mouse events at their centre.
        const longRow = arg("--long-row"); const shortRow = arg("--short-row");
        await longThread(app, rep, async (cdp, armIt) => {
          await clickRow(cdp, shortRow); await sleep(2500);
          await armIt();
          return clickRow(cdp, longRow);
        });
      }
    } catch (e) {
      row({ app: app.id, test: t, rep, error: String(e) });
    }
  }
}
